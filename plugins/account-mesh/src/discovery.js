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

/** Tailscale CLI candidates, most likely first. */
function tailscaleBins() {
  return [
    process.env.TAILSCALE_BIN,
    'tailscale',
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
    try {
      this.socket.send(message, this.port, MULTICAST_GROUP)
    } catch {
      // ignore
    }
    try {
      this.socket.send(message, this.port, '255.255.255.255')
    } catch {
      // ignore
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
    for (const peer of this.tailnet.peers) this.query(peer.address)
  }

  probeStatic() {
    for (const target of this.options.staticPeers ?? []) {
      const [host, port] = String(target).split(':')
      if (!host) continue
      this.query(host, Number(port) || this.port)
    }
  }

  /** Send one already-encoded discovery/signaling payload to a peer address. */
  sendRaw(buffer, address, port) {
    if (!this.socket) return
    try {
      this.socket.send(buffer, port, address)
    } catch {
      // ignore
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
    const peer = {
      deviceId: frame.dev,
      name: typeof frame.name === 'string' && frame.name ? frame.name : frame.dev,
      publicKey: Buffer.from(frame.pk, 'base64url').toString('utf8'),
      port: Number(frame.port) || remote.port,
      address: remote.address,
      addrs: Array.isArray(frame.addrs) ? frame.addrs.filter(entry => typeof entry === 'string') : [],
      version: frame.ver,
      lastSeen: now(),
      source: TAILNET_V4.test(remote.address) ? 'tailnet' : 'lan',
    }
    this.peers.set(peer.deviceId, peer)
    if (frame.t === 'query') this.replyTo(remote)
    this.options.onPeer?.(peer, isNew)
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
    const cutoff = now() - 20000
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
