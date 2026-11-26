/**
 * The mesh runtime: account identity, discovery, signed signaling, WebRTC
 * links, mutual device authentication, and read-only RPC.
 *
 * Each instance is both server and client. A peer link is usable only after
 * both sides prove possession of their Ed25519 device key; the server side
 * then answers a fixed read-only operation whitelist and nothing else.
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Discovery, localAddresses, tailscalePeers } from './discovery.js'
import { SignalInbox, encodeSignal, parseSignalPayload, roomOf } from './signaling.js'
import { PeerLink, RPC } from './transport.js'
import { TransferManager } from './transfer.js'
import { EncryptedVault } from './vault.js'
import { DataPlane, rpcError } from './data.js'
import { PendingCalls, requestFrame, toWireError } from './rpc.js'
import { fingerprintOf, loadOrCreateIdentity, pairCode, signBytes, verifyBytes } from './identity.js'
import { readAccount } from './account.js'
import { TrustStore } from './trust.js'
import { b64u, digest, now, shortId } from './util.js'

const HELLO_CONTEXT = 'dsh-account-mesh/v1/hello'
/**
 * This build (deepseek-harness-night-cruising) removes application-level
 * operation timeouts: work ends on user cancellation, a real error, or a
 * transport state change. The constants below are periodic cadence and retry
 * pacing only — there is no request deadline, no idle timeout that aborts a
 * call, and no maximum attempt count. A link is torn down by WebRTC state, by
 * an authentication failure, or by the user revoking trust — never by a timer.
 */
const MAX_BACKOFF = 30000
/** A stalled handshake is retried at this cadence (connection establishment, not a request deadline). */
const HANDSHAKE_RETRY_MS = 10000

/** Runtime defaults; every field is optional in the patch config. */
export const DEFAULT_CONFIG = {
  enabled: true,
  peerName: '',
  discoveryPort: 47831,
  staticPeers: [],
  tailscaleProbe: true,
  autoTrustSameAccount: true,
  allowRoots: [],
  iceServers: [],
  // Opt-in fixed ICE range for hosts whose firewall cannot allow the app
  // itself; leave unset to let libdatachannel pick ephemeral ports.
  icePortBegin: null,
  icePortEnd: null,
  iceUdpMux: false,
  // Last-resort transport for networks that block UDP: ICE-TCP candidates.
  iceTcp: false,
  dataDir: '',
  // Test-only: expose this Host's own sessions as a synthetic "local-test"
  // peer in the panel tree, so the remote-workspace UI can be rendered against
  // real session data without a WebRTC peer. Off by default.
  localSessionTest: false,
  // Optional MCP endpoint (streamable HTTP) that exposes the read-only mesh
  // operations to external MCP clients. Unset disables it.
  mcpPort: null,
  mcpPath: '/mcp',
  mcpToken: '',
  // Test-only: force a device id so two Hosts on one machine can act as two
  // distinct peers. Leave empty in production; the account device identity wins.
  deviceId: '',
  // Encrypted process-lifetime cache for remote JLC archives.
  vaultEnabled: true,
  vaultMaxBytes: 268435456,
}

export class Mesh {
  constructor({ ctx, config, log, version, codec }) {
    this.ctx = ctx
    this.config = { ...DEFAULT_CONFIG, ...(config ?? {}) }
    this.log = log
    this.version = version
    this.dataDir = this.config.dataDir || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'account-mesh')
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 })
    this.identity = loadOrCreateIdentity(this.dataDir)
    this.trust = new TrustStore(path.join(this.dataDir, 'peers.json'))
    this.data = new DataPlane(ctx, this.config, log)
    this.codec = codec
    this.vault = this.config.vaultEnabled === false
      ? null
      : new EncryptedVault({ dir: path.join(this.dataDir, 'vault'), maxBytes: this.config.vaultMaxBytes, log })
    this.transfer = new TransferManager({ ctx, config: this.config, log, codec, vault: this.vault })
    this.account = { status: 'unknown' }
    this.accountTag = undefined
    this.deviceId = undefined
    this.peerName = this.config.peerName || os.hostname().replace(/\.local$/i, '')
    this.discovery = undefined
    this.inbox = new SignalInbox(log)
    this.peers = new Map()
    this.links = new Map()
    this.pending = new Map()
    this.timers = []
    this.lastError = undefined
    this.started = false
    this.startedAt = now()
    this.lastTouch = new Map()
  }

  /** Begin refresh + housekeeping timers; discovery starts once the account is readable. */
  start() {
    if (this.started) return
    this.started = true
    this.vault?.open().catch(error => this.noteError(error))
    this.timers.push(setInterval(() => this.guard(() => this.refreshAccount()), 15000))
    this.timers.push(setInterval(() => this.guard(() => this.housekeeping()), 3000))
    this.refreshAccount().catch(error => this.noteError(error))
  }

  async stop() {
    this.started = false
    for (const timer of this.timers) clearInterval(timer)
    this.timers = []
    for (const entry of this.links.values()) entry.link?.teardown('plugin stopped')
    this.links.clear()
    this.discovery?.stop()
    this.discovery = undefined
    for (const pending of this.pending.values()) pending.rejectAll(new Error('mesh stopped'))
    this.pending.clear()
    await this.vault?.clear()
    this.vault?.clearSync()
  }

  /** Run one periodic task; a failure is recorded instead of becoming a fatal Host exception. */
  guard(task) {
    try {
      const result = task()
      if (result && typeof result.then === 'function') result.then(undefined, error => this.noteError(error))
    } catch (error) {
      this.noteError(error)
    }
  }

  noteError(error) {
    this.lastError = { message: error?.message ?? String(error), at: now() }
    this.log?.warn?.(`account-mesh: ${this.lastError.message}`)
  }

  /** Re-read the signed-in account; start, restart or stop discovery as it changes. */
  async refreshAccount() {
    if (!this.config.enabled) return
    const account = await readAccount(this.ctx, { version: this.version })
    const tag = account.accountTag
    const changed = tag !== this.accountTag || account.status !== this.account.status
    this.account = account
    if (account.status === 'ready' && tag) {
      this.deviceId = this.config.deviceId || account.deviceId || `local-${digest(this.identity.publicKey, 12)}`
      this.accountTag = tag
      if (!this.discovery || changed) await this.restartDiscovery()
    } else if (this.discovery && (account.status !== 'ready' || !tag)) {
      this.discovery.stop()
      this.discovery = undefined
      for (const entry of this.links.values()) entry.link?.teardown('account unavailable')
      this.links.clear()
    }
    if (changed) this.log?.info?.(`account-mesh: account ${account.status}`)
  }

  async restartDiscovery() {
    this.discovery?.stop()
    const discovery = new Discovery({
      port: this.config.discoveryPort,
      accountTag: this.accountTag,
      deviceId: this.deviceId,
      name: this.peerName,
      publicKey: this.identity.publicKey,
      staticPeers: this.config.staticPeers,
      presenceTtlMs: this.config.presenceTtlMs,
      knownPeers: () => this.trust.list().filter(peer => typeof peer.address === 'string' && peer.address.length > 0),
      version: this.version,
      log: this.log,
      onPeer: (peer, isNew) => this.onPeer(peer, isNew),
      onPeerLost: peer => this.onPeerLost(peer),
      onSignal: (frame, remote) => this.onSignal(frame, remote),
    })
    try {
      await discovery.start()
      this.discovery = discovery
      this.log?.info?.(`account-mesh: discovery on ${discovery.port} (${localAddresses().length} addrs)`)
    } catch (error) {
      this.noteError(new Error(`discovery failed on port ${this.config.discoveryPort}: ${error.message}`))
    }
  }

  onPeer(peer, isNew) {
    this.peers.set(peer.deviceId, peer)
    const touched = this.lastTouch.get(peer.deviceId) ?? 0
    if (now() - touched > 60000) {
      this.lastTouch.set(peer.deviceId, now())
      this.trust.touch(peer.deviceId)
    }
    this.trust.rememberEndpoint(peer.deviceId, peer.address, peer.port)
    const trusted = this.trust.get(peer.deviceId)
    const keyChanged = trusted !== undefined && trusted.publicKey !== peer.publicKey
    if (this.config.autoTrustSameAccount && (!trusted || keyChanged)) {
      const result = this.trust.upsert({
        deviceId: peer.deviceId,
        name: peer.name,
        publicKey: peer.publicKey,
        fingerprint: fingerprintOf(peer.publicKey),
        accountTag: this.accountTag,
      })
      if (result.rebound) this.log?.warn?.(`account-mesh: peer ${shortId(peer.deviceId)} presented a new device key and was rebound`)
    }
    if (isNew) {
      this.log?.info?.(`account-mesh: found peer ${peer.name} (${shortId(peer.deviceId)}) via ${peer.source}`)
      if (this.discovery) this.discovery.query(peer.address, peer.port)
    }
  }

  onPeerLost(peer) {
    // Presence expiry removes the announcement entry only. A data channel that
    // is still open stays open, so recovering peers resume without a new
    // handshake and no in-flight call is aborted by discovery.
    this.peers.delete(peer.deviceId)
  }

  isInitiator(peer) {
    return this.deviceId < peer.deviceId
  }

  /** Create and wire one link; exactly one side (smaller device id) initiates. */
  async connect(peer) {
    if (!this.discovery || !this.deviceId) return
    if (!this.trust.has(peer.deviceId)) return
    // Both sides may initiate; the smaller device id's offer wins (see acceptOffer).
    const existing = this.links.get(peer.deviceId)
    if (existing && (existing.link?.isOpen() || existing.link?.state === 'connecting')) return
    const initiator = true
    const link = new PeerLink({
      peer,
      initiator,
      log: this.log,
      iceServers: this.config.iceServers,
      icePortRange: this.icePortRange(),
      iceUdpMux: this.config.iceUdpMux === true,
      iceTcp: this.config.iceTcp === true,
    })
    let resolveReady
    let rejectReady
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    ready.catch(() => {})
    const entry = {
      peer,
      link,
      initiator,
      verified: false,
      ready,
      resolveReady,
      rejectReady,
      openedAt: undefined,
      lastActivity: now(),
      attempts: (existing?.attempts ?? 0) + 1,
      nextAt: 0,
    }
    this.links.set(peer.deviceId, entry)
    link.on('local-description', ({ sdp, type }) => {
      entry.offeredAt = now()
      this.sendSignal(peer, type, { sdp })
      this.log?.info?.(`account-mesh: sent ${type} to ${shortId(peer.deviceId)}`)
    })
    link.on('local-candidate', ({ candidate, mid }) => {
      this.sendSignal(peer, 'ice', { candidate, mid })
    })
    link.on('message', ({ text }) => this.onLinkText(peer, entry, text))
    link.on('binary', ({ buffer }) => this.transfer.onBinary(buffer))
    link.on('state', state => {
      if (state === 'open') {
        entry.openedAt = now()
        entry.lastActivity = now()
        this.sendHello(entry)
      }
      if (state === 'closed') this.onLinkClosed(entry)
    })
    link.on('closed', () => this.onLinkClosed(entry))
    try {
      await link.open()
    } catch (error) {
      this.noteError(new Error(`transport open failed: ${error.message}`))
      this.onLinkClosed(entry)
    }
  }

  onLinkClosed(entry) {
    if (entry.closed) return
    entry.closed = true
    const current = this.links.get(entry.peer.deviceId) === entry
    entry.verified = false
    const reject = entry.rejectReady
    entry.rejectReady = undefined
    entry.resolveReady = undefined
    reject?.(new Error('peer link closed'))
    const pending = this.pending.get(entry.peer.deviceId)
    if (current) pending?.rejectAll(new Error('peer link closed'))
    const backoff = Math.min(MAX_BACKOFF, 1000 * 2 ** Math.max(0, entry.attempts - 1))
    entry.nextAt = now() + backoff
  }

  sendHello(entry) {
    const nonce = b64u(Buffer.from(cryptoRandom(24)))
    entry.helloNonce = nonce
    const signature = signBytes(this.identity.privateKey, `${HELLO_CONTEXT}|${nonce}|${this.deviceId}`)
    // Both directions carry the plugin version, so each side can show which
    // build the other one runs; the panel flags mixed-version pairs.
    entry.link.rpc({
      op: 'hello',
      params: {
        nonce,
        dev: this.deviceId,
        name: this.peerName,
        v: this.version,
        pk: b64u(this.identity.publicKey),
        sig: signature,
      },
    })
  }

  onSignal(frame, remote) {
    const peer = this.peers.get(frame.from)
    if (!peer) return
    if (!this.trust.has(peer.deviceId)) {
      if (!this.config.autoTrustSameAccount) return
      this.trust.upsert({
        deviceId: peer.deviceId,
        name: peer.name,
        publicKey: peer.publicKey,
        fingerprint: fingerprintOf(peer.publicKey),
        accountTag: this.accountTag,
      })
    }
    peer.address = remote.address
    peer.lastSeen = now()
    this.log?.info?.(`account-mesh: received ${frame.kind} from ${shortId(peer.deviceId)}`)
    const payload = this.inbox.push(frame, peer)
    if (!payload) return
    const parsed = parseSignalPayload(frame.kind, payload)
    if (!parsed) return
    if (frame.kind === 'offer') this.acceptOffer(peer, parsed).catch(error => this.noteError(error))
    else if (frame.kind === 'answer') this.acceptAnswer(peer, parsed)
    else if (frame.kind === 'ice') this.acceptCandidate(peer, parsed)
  }

  async acceptOffer(peer, payload) {
    if (typeof payload.sdp !== 'string') return
    const existing = this.links.get(peer.deviceId)
    // Glare: the smaller device id is the designated initiator. Ignore its
    // competing offer while our own handshake is in flight, so both sides do
    // not abandon their peer connections at the same time.
    if (this.isInitiator(peer) && existing && (existing.link?.state === 'connecting' || existing.link?.isOpen())) return
    if (existing?.link) existing.link.teardown('replaced by inbound offer')
    const link = new PeerLink({ peer, initiator: false, log: this.log, iceServers: this.config.iceServers, icePortRange: this.icePortRange() })
    let resolveReady
    let rejectReady
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    ready.catch(() => {})
    const entry = {
      peer,
      link,
      initiator: false,
      verified: false,
      ready,
      resolveReady,
      rejectReady,
      lastActivity: now(),
      attempts: (existing?.attempts ?? 0) + 1,
      nextAt: 0,
    }
    this.links.set(peer.deviceId, entry)
    link.on('local-description', ({ sdp, type }) => {
      this.sendSignal(peer, type, { sdp })
      this.log?.info?.(`account-mesh: sent ${type} to ${shortId(peer.deviceId)}`)
    })
    link.on('local-candidate', ({ candidate, mid }) => this.sendSignal(peer, 'ice', { candidate, mid }))
    link.on('message', ({ text }) => this.onLinkText(peer, entry, text))
    link.on('binary', ({ buffer }) => this.transfer.onBinary(buffer))
    link.on('state', state => {
      if (state === 'open') {
        entry.openedAt = now()
        this.sendHello(entry)
      }
      if (state === 'closed') this.onLinkClosed(entry)
    })
    link.on('closed', () => this.onLinkClosed(entry))
    try {
      await link.open()
      link.setRemoteDescription(payload.sdp, 'offer')
    } catch (error) {
      this.noteError(new Error(`accept offer failed: ${error.message}`))
      this.onLinkClosed(entry)
    }
  }

  acceptAnswer(peer, payload) {
    const entry = this.links.get(peer.deviceId)
    if (!entry || !entry.initiator || typeof payload.sdp !== 'string') return
    entry.link.setRemoteDescription(payload.sdp, 'answer')
  }

  acceptCandidate(peer, payload) {
    const entry = this.links.get(peer.deviceId)
    if (!entry) return
    entry.link.addRemoteCandidate(payload.candidate, payload.mid)
  }

  sendSignal(peer, kind, payload) {
    if (!this.discovery) return
    const room = roomOf(this.accountTag, this.deviceId, peer.deviceId)
    const frames = encodeSignal({
      room,
      from: this.deviceId,
      kind,
      data: JSON.stringify({ kind, ...payload }),
      privateKey: this.identity.privateKey,
    })
    for (const frame of frames) this.discovery.sendRaw(frame, peer.address, peer.port)
  }

  onLinkText(peer, entry, text) {
    entry.lastActivity = now()
    const frame = safeParse(text)
    if (!frame) return
    if (frame.t === 'ping') {
      entry.link.rpc({ op: 'pong', at: frame.at })
      return
    }
    if (frame.op === 'pong') {
      if (frame.at) entry.rtt = Math.max(0, now() - frame.at)
      return
    }
    if (frame.op === 'hello') {
      this.onHello(entry, frame.params ?? {})
      return
    }
    if (frame.op === 'hello-ack') {
      this.onHelloAck(entry, frame.params ?? {})
      return
    }
    if (typeof frame.op === 'string' && frame.id !== undefined) {
      this.serve(peer, entry, frame)
      return
    }
    if (frame.id !== undefined && (frame.ok === true || frame.ok === false)) {
      this.pendingFor(peer.deviceId).settle(frame)
    }
  }

  onHello(entry, params) {
    const peer = entry.peer
    const nonce = params.nonce
    if (typeof nonce !== 'string' || typeof params.sig !== 'string') return
    if (!verifyBytes(peer.publicKey, `${HELLO_CONTEXT}|${nonce}|${peer.deviceId}`, params.sig)) {
      this.log?.warn?.(`account-mesh: rejected unauthenticated hello from ${shortId(peer.deviceId)}`)
      entry.link.teardown('hello signature failed')
      return
    }
    // The hello is signed, so the announced plugin version is trustworthy.
    entry.peerVersion = typeof params.v === 'string' && params.v ? params.v : null
    const signature = signBytes(this.identity.privateKey, `${HELLO_CONTEXT}|${nonce}|${this.deviceId}`)
    entry.link.rpc({ op: 'hello-ack', params: { nonce, v: this.version, sig: signature } })
    this.markVerified(entry)
  }

  onHelloAck(entry, params) {
    const nonce = entry.helloNonce
    if (!nonce || typeof params.sig !== 'string') return
    if (params.nonce !== nonce) return
    if (!verifyBytes(entry.peer.publicKey, `${HELLO_CONTEXT}|${nonce}|${entry.peer.deviceId}`, params.sig)) {
      this.log?.warn?.(`account-mesh: rejected unauthenticated hello-ack from ${shortId(entry.peer.deviceId)}`)
      entry.link.teardown('hello-ack signature failed')
      return
    }
    if (!entry.peerVersion && typeof params.v === 'string' && params.v) entry.peerVersion = params.v
    this.markVerified(entry)
  }

  markVerified(entry) {
    if (entry.verified) return
    entry.verified = true
    const trusted = this.trust.get(entry.peer.deviceId)
    if (trusted && trusted.publicKey !== entry.peer.publicKey) {
      entry.link.teardown('device key changed')
      return
    }
    const resolve = entry.resolveReady
    entry.resolveReady = undefined
    entry.rejectReady = undefined
    resolve?.(entry)
    this.log?.info?.(`account-mesh: link verified with ${entry.peer.name} (${shortId(entry.peer.deviceId)})`)
  }

  /** Server side: answer one read-only request. */
  async serve(peer, entry, frame) {
    const respond = body => entry.link.rpc({ id: frame.id, ...body })
    if (frame.op === 'pong') return
    if (!entry.verified) {
      respond({ ok: false, err: { code: 'not-verified', message: 'link is not authenticated yet' } })
      return
    }
    if (!this.trust.has(peer.deviceId)) {
      respond({ ok: false, err: { code: 'not-paired', message: 'this device is not trusted' } })
      return
    }
    try {
      let result
      if (frame.op === 'sessions/export/prepare') result = await this.transfer.prepare(frame.params ?? {}, entry)
      else if (frame.op === 'sessions/export/block') result = await this.transfer.block(frame.params ?? {}, entry)
      else if (frame.op === 'sessions/export/cancel') result = await this.transfer.cancel(frame.params ?? {})
      else result = await this.runOp(frame.op, frame.params ?? {})
      respond({ ok: true, result })
    } catch (error) {
      respond({ ok: false, err: toWireError(error) })
    }
  }

  /** Fixed read-only operation whitelist. No write, prompt or shell path exists. */
  async runOp(op, params) {
    if (op === 'summary') return this.describeForPeer()
    return this.data.runOp(op, params)
  }

  /** Fixed ICE UDP range so a host firewall needs one rule instead of many random ports. */
  icePortRange() {
    if (this.config.icePortBegin == null || this.config.icePortEnd == null) return undefined
    const begin = Number(this.config.icePortBegin)
    const end = Number(this.config.icePortEnd)
    if (!Number.isInteger(begin) || !Number.isInteger(end) || begin <= 0 || end < begin || end > 65535) return undefined
    if (end - begin > 200) return undefined
    return { begin, end }
  }

  describeForPeer() {
    return {
      device: shortId(this.deviceId),
      name: this.peerName,
      version: this.version,
      protocol: 1,
      workspaces: this.data.listWorkspaces().workspaces.length,
    }
  }

  pendingFor(deviceId) {
    let pending = this.pending.get(deviceId)
    if (!pending) {
      pending = new PendingCalls()
      this.pending.set(deviceId, pending)
    }
    return pending
  }

  /** Client side: send one request and await the peer's response. */
  async call(peerId, op, params = {}, signal) {
    const entry = this.resolvePeer(peerId)
    if (!entry) throw rpcError('peer-unknown', `no peer matches ${peerId}`)
    const trusted = this.trust.get(entry.peer.deviceId)
    if (!trusted) throw rpcError('not-paired', `peer ${shortId(entry.peer.deviceId)} is not trusted`)
    if (!this.links.get(entry.peer.deviceId)?.link?.isOpen()) {
      await this.connect(entry.peer)
      const linkEntry = this.links.get(entry.peer.deviceId)
      if (!linkEntry) throw rpcError('peer-offline', `peer ${shortId(entry.peer.deviceId)} is offline`)
      await linkEntry.ready
    }
    const linkEntry = this.links.get(entry.peer.deviceId)
    if (!linkEntry?.link?.isOpen()) throw rpcError('peer-offline', `peer ${shortId(entry.peer.deviceId)} is offline`)
    await linkEntry.ready
    const pending = this.pendingFor(entry.peer.deviceId)
    const { id, promise } = pending.open(signal)
    if (!linkEntry.link.rpc({ id, op, params })) throw rpcError('peer-offline', 'link is not writable')
    // Transfer accounting for the panel: what this call asked for and what the
    // peer actually answered with. Counters only; nothing here gates a call.
    const sentBytes = Buffer.byteLength(JSON.stringify(params ?? {}), 'utf8')
    promise.then(
      result => this.recordTransfer(entry.peer.deviceId, sentBytes, Buffer.byteLength(JSON.stringify(result ?? null), 'utf8')),
      () => {},
    )
    return promise
  }

  /** Pull one remote session with JLC into memory and project it. */
  fetchSession(peerId, sessionId, options = {}) {
    const call = (target, op, params) => this.call(target, op, params, options.signal)
    if (this.codec?.state?.().active === true) {
      return this.transfer.fetch({
        peerId,
        sessionId,
        priority: options.priority ?? 'dialog',
        call,
        onProgress: options.onProgress,
      })
    }
    // Standard DSH has no JLC native module. Page the projection serially so a
    // long chat still completes, with one page per task and visible progress.
    return this.transfer.fetchJsonl({ peerId, sessionId, call, onProgress: options.onProgress })
  }

  /** Active JLC transfer progress for the panel. */
  transferState() {
    return this.transfer.state()
  }

  /** Memory-only JLC cache stats. */
  cacheState() {
    return this.transfer.cacheState()
  }

  /** Aggregate encrypted-vault status; never lists entries or keys. */
  vaultState() {
    return this.vault?.state() ?? null
  }

  /** Clear the encrypted vault; only aggregate state is ever reported. */
  async clearVault() {
    await this.vault?.clear()
    return this.vaultState()
  }

  /** Summed transfer counters over every link (panel and agent view). */
  transferTotals() {
    const totals = { calls: 0, sentBytes: 0, receivedBytes: 0, peers: 0 }
    for (const entry of this.links.values()) {
      if (!entry.transfer) continue
      totals.peers += 1
      totals.calls += entry.transfer.calls
      totals.sentBytes += entry.transfer.sentBytes
      totals.receivedBytes += entry.transfer.receivedBytes
    }
    return totals
  }

  /** Fold one completed call into the peer's transfer counters. */
  recordTransfer(deviceId, sentBytes, receivedBytes) {
    const entry = this.links.get(deviceId)
    if (!entry) return
    const stats = entry.transfer ?? (entry.transfer = { calls: 0, sentBytes: 0, receivedBytes: 0, lastAt: null })
    stats.calls += 1
    stats.sentBytes += sentBytes
    stats.receivedBytes += receivedBytes
    stats.lastAt = now()
  }

  resolvePeer(input) {
    if (typeof input !== 'string' || !input) return undefined
    for (const entry of this.links.values()) {
      if (entry.peer.deviceId === input || shortId(entry.peer.deviceId) === input) return entry
    }
    const found = this.peers.get(input)
    if (found) return { peer: found }
    for (const peer of this.peers.values()) {
      if (shortId(peer.deviceId) === input || peer.name === input) return { peer }
    }
    for (const trusted of this.trust.list()) {
      if (trusted.deviceId === input || shortId(trusted.deviceId) === input || trusted.name === input) {
        return { peer: this.peers.get(trusted.deviceId) ?? { deviceId: trusted.deviceId, name: trusted.name, publicKey: trusted.publicKey, port: 0, address: undefined } }
      }
    }
    return undefined
  }

  housekeeping() {
    if (!this.discovery) return
    this.inbox.prune()
    const at = now()
    for (const entry of this.links.values()) {
      if (entry.link?.state === 'connecting' && entry.offeredAt && now() - entry.offeredAt > HANDSHAKE_RETRY_MS) {
        this.log?.info?.(`account-mesh: handshake with ${shortId(entry.peer.deviceId)} stalled, retrying`)
        entry.link.teardown('handshake retry')
        continue
      }
      if (!entry.link?.isOpen()) continue
      // Ping measures latency only. An idle link is not expired by this
      // process; WebRTC state and the peer's own actions close it.
      entry.link.ping()
    }
    for (const peer of this.peers.values()) {
      if (!this.trust.has(peer.deviceId)) continue
      const entry = this.links.get(peer.deviceId)
      if (entry && (entry.link?.isOpen() || entry.link?.state === 'connecting')) continue
      if (entry?.nextAt && at < entry.nextAt) continue
      this.connect(peer)
    }
  }

  /** Panel/tool snapshot; contains no token, account id or file contents. */
  state() {
    return {
      enabled: this.config.enabled,
      status: this.statusText(),
      version: this.version,
      protocol: 1,
      account: {
        status: this.account.status,
        tag: this.accountTag ? `${this.accountTag.slice(0, 6)}…` : null,
      },
      device: {
        id: this.deviceId ? shortId(this.deviceId) : null,
        name: this.peerName,
        fingerprint: this.identity.fingerprint,
        directory: this.dataDir,
      },
      discovery: this.discovery
        ? {
            port: this.discovery.port,
            addresses: localAddresses().map(info => ({ address: info.address, tailnet: info.tailnet })),
            tailscale: { available: this.discovery.tailnet.available, peers: this.discovery.tailnet.peers.length },
            otherAccounts: this.discovery.otherAccounts,
          }
        : null,
      lastError: this.lastError ?? null,
      transfers: this.transferState(),
      cache: this.cacheState(),
      vault: this.vault?.state() ?? null,
      peers: this.peerViews(),
    }
  }

  statusText() {
    if (!this.config.enabled) return 'disabled'
    if (this.account.status === 'signed-out') return 'signed-out'
    if (this.account.status === 'pending') return 'account-pending'
    if (this.account.status === 'unavailable') return 'account-service-missing'
    if (this.account.status !== 'ready') return 'starting'
    if (!this.discovery) return 'discovering'
    return 'ready'
  }

  peerViews() {
    const seen = new Set()
    const views = []
    for (const peer of this.peers.values()) {
      seen.add(peer.deviceId)
      const entry = this.links.get(peer.deviceId)
      const trusted = this.trust.get(peer.deviceId)
      views.push({
        deviceId: peer.deviceId,
        shortId: shortId(peer.deviceId),
        name: peer.name,
        source: peer.source,
        address: peer.address,
        online: true,
        trusted: trusted !== undefined,
        verified: entry?.verified === true,
        link: entry?.link?.state ?? 'idle',
        rttMs: entry?.rtt ?? null,
        fingerprint: fingerprintOf(peer.publicKey),
        pairCode: trusted ? pairCode(this.identity.publicKey, peer.publicKey) : null,
        trustedAt: trusted?.trustedAt ?? null,
        lastSeenAt: trusted?.lastSeen ?? null,
        // Plugin build the peer announced during its signed hello (null until then).
        version: entry?.peerVersion ?? null,
        transfer: entry?.transfer ? { ...entry.transfer } : null,
      })
    }
    for (const trusted of this.trust.list()) {
      if (seen.has(trusted.deviceId)) continue
      views.push({
        deviceId: trusted.deviceId,
        shortId: shortId(trusted.deviceId),
        name: trusted.name,
        source: 'trusted',
        address: null,
        online: false,
        trusted: true,
        verified: false,
        link: 'offline',
        rttMs: null,
        fingerprint: trusted.fingerprint,
        pairCode: pairCode(this.identity.publicKey, trusted.publicKey),
        trustedAt: trusted.trustedAt ?? null,
        lastSeenAt: trusted.lastSeen ?? null,
        version: null,
        transfer: null,
      })
    }
    return views.sort((a, b) => Number(b.online) - Number(a.online) || String(a.name).localeCompare(String(b.name)))
  }

  /** Trust one discovered peer explicitly (manual mode or re-bind confirmation). */
  pair(deviceId) {
    const peer = this.peers.get(deviceId)
    if (!peer) throw rpcError('peer-unknown', 'peer is not currently discovered')
    const result = this.trust.upsert({
      deviceId: peer.deviceId,
      name: peer.name,
      publicKey: peer.publicKey,
      fingerprint: fingerprintOf(peer.publicKey),
      accountTag: this.accountTag,
    })
    return result
  }

  forget(deviceId) {
    const removed = this.trust.remove(deviceId)
    const entry = this.links.get(deviceId)
    entry?.link?.teardown('forgotten')
    this.links.delete(deviceId)
    return removed
  }

  reconnect(deviceId) {
    const entry = this.links.get(deviceId)
    if (entry) {
      entry.nextAt = 0
      entry.attempts = 0
      entry.link?.teardown('manual reconnect')
    }
    const peer = this.peers.get(deviceId)
    if (peer) this.connect(peer).catch(error => this.noteError(error))
  }

  /** Tailscale diagnostics for the panel. */
  async tailscaleStatus() {
    const status = await tailscalePeers()
    return { available: status.available, bin: status.bin ?? null, peers: status.peers.length }
  }

  /** Per-channel discovery counters (LAN multicast/broadcast vs tailnet unicast). */
  channels() {
    if (!this.discovery) return null
    return this.discovery.channelState()
  }

  /** Manual probe of one target on one channel, from the panel buttons. */
  async probe(target, channel = 'lan') {
    if (!this.discovery) throw rpcError('discovery-off', 'discovery is not running')
    if (channel !== 'lan' && channel !== 'tailnet') throw rpcError('bad-request', `unknown channel: ${channel}`)
    return this.discovery.probe(target, channel)
  }

  /** Rebuild discovery from the current OS network state (routes, interfaces, tailnet). */
  async refreshNetwork() {
    this.log?.info?.('account-mesh: refreshing network state')
    await this.restartDiscovery()
    return this.channels()
  }
}

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

function safeParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function cryptoRandom(length) {
  return randomBytes(length)
}
