/**
 * Peer discovery on the LAN and inside a Tailscale tailnet.
 *
 * Two channels share one UDP socket bound to `0.0.0.0:<port>`:
 *  - multicast/broadcast announce + query for the physical LAN;
 *  - unicast query/probe for Tailscale peers, because multicast never crosses
 *    a tailnet. Tailnet addresses come from `tailscale status --json`, plus
 *    any statically configured peers.
 *
 * Only announcements carrying this instance's account tag enter the peer
 * table; everything else is counted as "another account" and ignored.
 */
import dgram from 'node:dgram'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PROTOCOL_VERSION, PRODUCT, b64u, now, parseJson } from './util.js'

const run = promisify(execFile)
const MULTICAST_GROUP = '239.255.42.99'
const TAILNET_V4 = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./
/** How long a manual probe waits for a reply before reporting "no reply". */
const PROBE_WAIT_MS = 3000

/** IPv4 addresses of this host, tailnet addresses included. */
export function localAddresses() {
  const out = []
  const ifaces = os.networkInterfaces()
  for (const [name, list] of Object.entries(ifaces)) {
    for (const entry of list ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      out.push({ address: entry.address, iface: name, tailnet: TAILNET_V4.test(entry.address) })
    }
  }
  return out
}

/** Tailscale CLI candidates, most likely first; Windows installs it outside PATH. */
function tailscaleBins() {
  const windows = process.platform === 'win32'
    ? [
        `${process.env.ProgramFiles ?? 'C:\\Program Files'}\\Tailscale\\tailscale.exe`,
        'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
        `${process.env.LOCALAPPDATA ?? ''}\\Tailscale\\tailscale.exe`,
      ].filter(entry => !entry.startsWith('\\'))
    : []
  return [
    process.env.TAILSCALE_BIN,
    'tailscale',
    ...windows,
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/usr/local/bin/tailscale',
    '/opt/homebrew/bin/tailscale',
    '/usr/bin/tailscale',
  ].filter(Boolean)
}

/** One probe at a time: a slow CLI must not stack processes, and this build sets no command timeout. */
let tailscaleInFlight

/** Online tailnet peers from `tailscale status --json`; empty when unavailable. */
export async function tailscalePeers() {
  if (tailscaleInFlight) return tailscaleInFlight
  tailscaleInFlight = probeTailscaleCommand().finally(() => {
    tailscaleInFlight = undefined
  })
  return tailscaleInFlight
}

async function probeTailscaleCommand() {
  for (const bin of tailscaleBins()) {
    try {
      const { stdout } = await run(bin, ['status', '--json'], { maxBuffer: 8 * 1024 * 1024 })
      const status = parseJson(stdout)
      if (!status) continue
      const peers = []
      for (const peer of Object.values(status.Peer ?? {})) {
        if (!peer || peer.Online === false) continue
        for (const ip of peer.TailscaleIPs ?? []) {
          if (typeof ip === 'string' && TAILNET_V4.test(ip)) {
            peers.push({ address: ip, hostName: peer.HostName ?? peer.DNSName ?? ip })
            break
          }
        }
      }
      return { available: true, bin, peers }
    } catch {
      // try the next candidate
    }
  }
  return { available: false, peers: [] }
}

export class Discovery {
  constructor(options) {
    this.options = options
    this.port = options.port
    this.accountTag = options.accountTag
    this.deviceId = options.deviceId
    this.name = options.name
    this.publicKey = options.publicKey
    this.log = options.log
    this.peers = new Map()
    this.otherAccounts = 0
    this.tailnet = { available: false, peers: [] }
    this.socket = undefined
    this.timers = []
    this.started = false
    // Per-channel state: LAN uses multicast/broadcast, tailnet uses unicast
    // probes because multicast never crosses a tailnet. Both run at once so a
    // device reachable on only one path is still discovered.
    this.channels = {
      lan: { announces: 0, replies: 0, lastAnnounceAt: 0, lastReplyAt: 0, peers: 0 },
      tailnet: { probes: 0, replies: 0, lastProbeAt: 0, lastReplyAt: 0, peers: 0 },
    }
    this.probeResults = new Map()
    // Per-destination throttle for failed sends: a powered-off peer used to
    // produce one warn line every few seconds and grow mesh.log forever.
    this.sendFailureAt = new Map()
  }

  start() {
    if (this.started) return Promise.resolve()
    this.started = true
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.socket.on('message', (message, remote) => this.onMessage(message, remote))
    this.socket.on('error', error => this.log?.warn?.(`discovery socket error: ${error.message}`))
    return new Promise((resolve, reject) => {
      const onError = error => {
        this.socket?.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        this.socket.off('error', onError)
        try {
          this.socket.setBroadcast(true)
        } catch {
          // Some platforms refuse broadcast on a shared socket; multicast still runs.
        }
        for (const info of localAddresses()) {
          try {
            this.socket.addMembership(MULTICAST_GROUP, info.address)
          } catch {
            // Interfaces that refuse multicast simply keep the unicast channel.
          }
        }
        this.port = this.socket.address().port
        this.every(5000, () => this.announce())
        this.every(5000, () => this.heartbeat())
        this.every(5000, () => this.prune())
        this.every(30000, () => this.probeTailnet())
        this.every(20000, () => this.probeStatic())
        this.announce()
        this.guard(() => this.probeTailnet())
        this.probeStatic()
        resolve()
      }
      this.socket.once('error', onError)
      this.socket.once('listening', onListening)
      this.socket.bind(this.port)
    })
  }

  /** One periodic callback whose failure is logged instead of escalating to a fatal exception. */
  every(interval, task) {
    const timer = setInterval(() => this.guard(task), interval)
    this.timers.push(timer)
  }

  /** Run one synchronous or asynchronous task and swallow/log its failure. */
  guard(task) {
    try {
      const result = task()
      if (result && typeof result.then === 'function') {
        result.then(undefined, error => this.log?.warn?.(`discovery background task failed: ${error?.message ?? error}`))
      }
    } catch (error) {
      this.log?.warn?.(`discovery background task failed: ${error?.message ?? error}`)
    }
  }

  stop() {
    for (const timer of this.timers) clearInterval(timer)
    this.timers = []
    this.started = false
    try {
      this.socket?.close()
    } catch {
      // already closed
    }
    this.socket = undefined
    this.peers.clear()
  }

  announceMessage() {
    return {
      v: PROTOCOL_VERSION,
      t: 'announce',
      product: PRODUCT,
      tag: this.accountTag,
      dev: this.deviceId,
      name: this.name,
      port: this.port,
      addrs: localAddresses().map(info => info.address),
      pk: b64u(this.publicKey),
      ver: this.options.version,
    }
  }

  announce() {
    if (!this.socket) return
    const message = Buffer.from(JSON.stringify(this.announceMessage()))
    let sent = false
    try {
      this.socket.send(message, this.port, MULTICAST_GROUP)
      sent = true
    } catch {
      // ignore
    }
    try {
      this.socket.send(message, this.port, '255.255.255.255')
      sent = true
    } catch {
      // ignore
    }
    if (sent) {
      this.channels.lan.announces += 1
      this.channels.lan.lastAnnounceAt = now()
    }
  }

  /** Known peers from the trust table, so a restart re-probes them directly. */
  knownPeers() {
    try {
      return this.options.knownPeers?.() ?? []
    } catch {
      return []
    }
  }

  /** Unicast announce to every known endpoint: keeps presence fresh on both sides. */
  heartbeat() {
    const message = Buffer.from(JSON.stringify(this.announceMessage()))
    for (const peer of this.knownPeers()) {
      if (!peer?.address || !peer?.port) continue
      this.sendRaw(message, peer.address, peer.port)
    }
  }

  query(address, port = this.port) {
    if (!this.socket) return
    const message = Buffer.from(JSON.stringify({ ...this.announceMessage(), t: 'query' }))
    try {
      this.socket.send(message, port, address)
    } catch {
      // ignore
    }
  }

  async probeTailnet() {
    const local = localAddresses()
    this.tailnet = await tailscalePeers()
    if (!this.tailnet.available && !local.some(info => info.tailnet)) return
    for (const peer of this.tailnet.peers) {
      this.channels.tailnet.probes += 1
      this.channels.tailnet.lastProbeAt = now()
      this.query(peer.address)
    }
  }

  probeStatic() {
    for (const target of this.options.staticPeers ?? []) {
      const [host, port] = String(target).split(':')
      if (!host) continue
      this.query(host, Number(port) || this.port)
    }
    // Trusted endpoints remembered from a previous run, plus the default port
    // in case the peer rebound its discovery socket.
    for (const peer of this.knownPeers()) {
      if (!peer?.address) continue
      this.query(peer.address, Number(peer.port) || this.port)
    }
  }

  /** Probe one target on one channel; returns a diagnostic result (no timeouts abort work). */
  async probe(target, channel = 'lan') {
    const host = String(target ?? '').trim()
    if (!host) throw new Error('target is required')
    const [address, portText] = host.split(':')
    const port = Number(portText) || this.port
    const started = now()
    const before = this.channels[channel].replies
    this.query(address, port)
    if (channel === 'tailnet') {
      this.channels.tailnet.probes += 1
      this.channels.tailnet.lastProbeAt = started
    }
    let repliedAt = 0
    while (now() - started < PROBE_WAIT_MS) {
      if (this.channels[channel].replies > before) {
        repliedAt = now()
        break
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const replied = repliedAt > 0
    const result = {
      channel,
      target: `${address}:${port}`,
      replied,
      elapsedMs: replied ? repliedAt - started : now() - started,
      peer: this.peers.get(this.deviceIdFromAddress(address))?.name ?? null,
    }
    this.probeResults.set(`${channel}:${result.target}`, { ...result, at: now() })
    this.log?.info?.(`account-mesh: ${channel} probe ${result.target} ${replied ? 'replied' : 'no reply'} in ${result.elapsedMs}ms`)
    return result
  }

  /** Channel counters for the panel: which discovery path is actually working. */
  channelState() {
    const tailnetAddresses = this.tailnet.peers.map(peer => peer.address)
    const lanPeers = [...this.peers.values()].filter(peer => peer.source === 'lan').length
    const tailnetPeers = [...this.peers.values()].filter(peer => peer.source === 'tailnet').length
    return {
      lan: {
        ...this.channels.lan,
        peers: lanPeers,
        multicastGroup: MULTICAST_GROUP,
        broadcast: '255.255.255.255',
        localAddresses: localAddresses().filter(info => !info.tailnet).map(info => info.address),
      },
      tailnet: {
        ...this.channels.tailnet,
        peers: tailnetPeers,
        available: this.tailnet.available,
        peersKnown: tailnetAddresses.length,
        addresses: tailnetAddresses,
      },
      probes: [...this.probeResults.values()],
    }
  }

  /**
   * Send one raw datagram to a peer's discovery endpoint. A refused or failed
   * send is logged instead of swallowed: a signaling frame that never left the
   * socket otherwise looks like a peer that stopped answering.
   * @param buffer - datagram bytes.
   * @param address - destination address.
   * @param port - destination port.
   */
  /** At most one warn per destination per minute, with a suppressed count. */
  warnSendFailure(address, port, error) {
    const key = `${address}:${port}`
    const at = Date.now()
    const previous = this.sendFailureAt.get(key)
    if (previous && at - previous.at < 60000) {
      previous.count += 1
      return
    }
    const suppressed = previous?.count ?? 0
    this.sendFailureAt.set(key, { at, count: 0 })
    if (this.sendFailureAt.size > 64) {
      for (const [entryKey, entry] of this.sendFailureAt) {
        if (at - entry.at > 300000) this.sendFailureAt.delete(entryKey)
      }
    }
    const suffix = suppressed > 0 ? ` (${suppressed} similar failure(s) suppressed)` : ''
    this.log?.warn?.(`discovery send to ${address}:${port} failed: ${error?.message ?? error}${suffix}`)
  }

  sendRaw(buffer, address, port) {
    if (!this.socket) return
    try {
      this.socket.send(buffer, port, address, error => {
        if (error) this.warnSendFailure(address, port, error)
      })
    } catch (error) {
      this.warnSendFailure(address, port, error)
    }
  }

  onMessage(message, remote) {
    try {
      this.handleMessage(message, remote)
    } catch (error) {
      this.log?.warn?.(`discovery datagram dropped: ${error?.message ?? error}`)
    }
  }

  handleMessage(message, remote) {
    const frame = parseJson(message.toString('utf8'))
    if (!frame || frame.v !== PROTOCOL_VERSION || frame.product !== PRODUCT) return
    if (typeof frame.dev === 'string' && frame.dev === this.deviceId) return
    if (typeof frame.tag === 'string' && frame.tag !== this.accountTag) {
      this.otherAccounts += 1
      return
    }
    if (frame.t === 'sig') {
      this.options.onSignal?.(frame, remote)
      return
    }
    if (frame.t !== 'announce' && frame.t !== 'query') return
    if (!frame.dev || !frame.pk) return
    const isNew = !this.peers.has(frame.dev)
    const tailnet = TAILNET_V4.test(remote.address)
    const peer = {
      deviceId: frame.dev,
      name: typeof frame.name === 'string' && frame.name ? frame.name : frame.dev,
      publicKey: Buffer.from(frame.pk, 'base64url').toString('utf8'),
      port: Number(frame.port) || remote.port,
      address: remote.address,
      addrs: Array.isArray(frame.addrs) ? frame.addrs.filter(entry => typeof entry === 'string') : [],
      version: frame.ver,
      lastSeen: now(),
      source: tailnet ? 'tailnet' : 'lan',
    }
    this.peers.set(peer.deviceId, peer)
    if (tailnet) {
      this.channels.tailnet.replies += 1
      this.channels.tailnet.lastReplyAt = now()
    } else {
      this.channels.lan.replies += 1
      this.channels.lan.lastReplyAt = now()
    }
    if (frame.t === 'query') this.replyTo(remote)
    this.options.onPeer?.(peer, isNew)
  }

  /** Resolve the device id that last announced from an address, for probe results. */
  deviceIdFromAddress(address) {
    for (const peer of this.peers.values()) {
      if (peer.address === address) return peer.deviceId
    }
    return undefined
  }

  replyTo(remote) {
    if (!this.socket) return
    const message = Buffer.from(JSON.stringify(this.announceMessage()))
    try {
      this.socket.send(message, remote.port, remote.address)
    } catch {
      // ignore
    }
  }

  prune() {
    const cutoff = now() - (this.options.presenceTtlMs ?? 75000)
    for (const [deviceId, peer] of this.peers) {
      if (peer.lastSeen < cutoff) {
        this.peers.delete(deviceId)
        this.options.onPeerLost?.(peer)
      }
    }
  }

  list() {
    return [...this.peers.values()]
  }
}
