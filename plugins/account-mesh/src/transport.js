/**
 * One WebRTC peer link over node-datachannel.
 *
 * Two data channels are created, mirroring p2play-js: a reliable ordered
 * `mesh-rpc` channel for requests and a small unordered `mesh-ping` channel
 * for liveness. Strings larger than a data-channel message budget are split
 * into chunked envelopes and reassembled on the other side, so a long session
 * page is never silently truncated.
 */
import { EventEmitter } from 'node:events'
import { frameId, parseJson } from './util.js'

const CHUNK_SIZE = 48 * 1024
const RPC = 'mesh-rpc'
const PING = 'mesh-ping'
const BIN = 'mesh-bin'

export class PeerLink extends EventEmitter {
  constructor(options) {
    super()
    this.options = options
    this.peer = options.peer
    this.initiator = options.initiator
    this.log = options.log
    this.pc = undefined
    this.channels = new Map()
    this.pendingChunks = new Map()
    this.state = 'idle'
    this.closed = false
  }

  async open() {
    if (this.pc || this.closed) return
    const module = await import('node-datachannel')
    const ndc = module.default ?? module
    this.ndc = ndc
    const range = this.options.icePortRange
    const pc = new ndc.PeerConnection(`mesh-${this.peer.deviceId.slice(0, 8)}`, {
      iceServers: this.options.iceServers ?? [],
      maxMessageSize: 262144,
      // Multiplex every ICE transport over one socket and keep it inside a
      // documented UDP range, so an inbound firewall rule is one port window.
      ...(this.options.iceUdpMux ? { enableIceUdpMux: true } : {}),
      ...(range ? { portRangeBegin: range.begin, portRangeEnd: range.end } : {}),
      ...(this.options.iceTcp ? { enableIceTcp: true } : {}),
    })
    this.pc = pc
    this.setState('connecting')
    pc.onLocalDescription((sdp, type) => {
      this.emit('local-description', { sdp, type })
    })
    pc.onLocalCandidate((candidate, mid) => {
      this.log?.debug?.(`local candidate ${candidate}`)
      this.emit('local-candidate', { candidate, mid })
    })
    pc.onStateChange(state => {
      this.log?.debug?.(`peer ${this.peer.deviceId.slice(0, 8)} state ${state}`)
      if (state === 'connected') this.setState('connected')
      if (state === 'failed' || state === 'closed' || state === 'disconnected') {
        this.teardown(`transport ${state}`)
      }
    })
    pc.onDataChannel(channel => this.attach(channel))
    if (this.initiator) {
      this.attach(pc.createDataChannel(RPC, { ordered: true }))
      this.attach(pc.createDataChannel(PING, { ordered: false, maxRetransmits: 0 }))
      this.attach(pc.createDataChannel(BIN, { ordered: true, maxMessageSize: 262144 }))
    }
  }

  attach(channel) {
    const label = channel.getLabel?.() ?? channel.label ?? RPC
    this.channels.set(label, channel)
    channel.onOpen(() => {
      if (label === RPC) this.setState('open')
    })
    channel.onClosed(() => {
      if (label === RPC) this.teardown('channel closed')
    })
    channel.onError?.(error => {
      this.log?.warn?.(`peer channel error: ${error}`)
    })
    channel.onMessage(message => this.onMessage(label, message))
  }

  onMessage(label, message) {
    if (typeof message !== 'string') {
      const buffer = Buffer.isBuffer(message) ? message : Buffer.from(message)
      // JLC binary frames are handled by the transfer manager, never parsed as
      // UTF-8 JSON envelopes.
      if (buffer.subarray(0, 4).toString('ascii') === 'JLCB') {
        this.emit('binary', { label, buffer })
        return
      }
      message = buffer.toString('utf8')
    }
    const text = message
    const envelope = parseJson(text)
    if (envelope && envelope.__chunkId) {
      const key = `${label}:${envelope.__chunkId}`
      const entry = this.pendingChunks.get(key) ?? { total: envelope.__total, parts: new Array(envelope.__total), at: Date.now() }
      entry.parts[envelope.__index] = Buffer.from(envelope.__data, 'base64url')
      this.pendingChunks.set(key, entry)
      if (entry.parts.every(part => part !== undefined)) {
        this.pendingChunks.delete(key)
        this.emit('message', { label, text: Buffer.concat(entry.parts).toString('utf8') })
      }
      return
    }
    this.emit('message', { label, text })
  }

  /** Send a raw text payload on one logical channel. */
  send(label, text) {
    const channel = this.channels.get(label)
    if (!channel || !channel.isOpen()) return false
    if (text.length <= CHUNK_SIZE) {
      channel.sendMessage(text)
      return true
    }
    const chunkId = frameId()
    const bytes = Buffer.from(text, 'utf8')
    const total = Math.ceil(bytes.length / CHUNK_SIZE)
    for (let index = 0; index < total; index += 1) {
      const part = bytes.subarray(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE).toString('base64url')
      channel.sendMessage(JSON.stringify({ __chunkId: chunkId, __index: index, __total: total, __data: part }))
    }
    return true
  }

  rpc(frame) {
    return this.send(RPC, JSON.stringify(frame))
  }

  /** Send one binary JLC frame on the reliable binary channel. */
  sendBinary(buffer) {
    const channel = this.channels.get(BIN)
    if (!channel || !channel.isOpen()) return false
    try {
      if (typeof channel.sendMessageBinary === 'function') channel.sendMessageBinary(buffer)
      else channel.sendMessage(buffer)
      return true
    } catch (error) {
      this.log?.warn?.(`binary send failed: ${error.message}`)
      return false
    }
  }

  ping() {
    return this.send(PING, JSON.stringify({ t: 'ping', at: Date.now() }))
  }

  isOpen() {
    return this.state === 'open' && !this.closed
  }

  setState(state) {
    if (this.state === state) return
    this.state = state
    this.emit('state', state)
  }

  /** Apply one remote description from signaling. */
  setRemoteDescription(sdp, type) {
    if (!this.pc) return
    this.pc.setRemoteDescription(sdp, type === 'offer' ? 'offer' : 'answer')
  }

  addRemoteCandidate(candidate, mid) {
    if (!this.pc) return
    try {
      this.pc.addRemoteCandidate(candidate, mid)
    } catch (error) {
      this.log?.debug?.(`candidate rejected: ${error}`)
    }
  }

  teardown(reason) {
    if (this.closed) return
    this.closed = true
    this.setState('closed')
    try {
      this.pc?.close()
    } catch {
      // already closed
    }
    this.pc = undefined
    this.emit('closed', reason)
  }
}

export { RPC, PING, BIN }
