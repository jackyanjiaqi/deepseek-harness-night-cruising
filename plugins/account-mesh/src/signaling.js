/**
 * WebRTC signaling over the shared UDP discovery socket.
 *
 * The envelope follows p2play-js: one room per device pair, a deterministic
 * initiator (the lexicographically smaller device id), and targeted
 * offer/answer/ice frames. Unlike p2play-js there is no signaling server: a
 * peer's address already came from discovery, so frames are sent directly.
 *
 * Frames are signed with the sender's Ed25519 device key, so a peer's address
 * being spoofable on the LAN does not let it speak for another device.
 */
import { PROTOCOL_VERSION, PRODUCT, b64u, sha256, now, parseJson } from './util.js'
import { signBytes, verifyBytes } from './identity.js'

const MAX_FRAGMENTS = 96
const CHUNK_BYTES = 700

/** Stable room identifier for one device pair on one account. */
export function roomOf(accountTag, deviceA, deviceB) {
  const [a, b] = [deviceA, deviceB].sort()
  return sha256(`dsh-mesh/v1:room:${accountTag}:${a}:${b}`).toString('base64url').slice(0, 24)
}

/** Canonical bytes a signal frame's signature covers. */
function signedBytes(frame) {
  return `${frame.room}|${frame.kind}|${frame.from}|${frame.id}|${frame.frag}|${sha256(frame.data).toString('base64url')}`
}

/** Encode one logical signal as signed, fragmented UDP payloads. */
export function encodeSignal({ room, from, kind, data, privateKey }) {
  const id = b64u(sha256(`${from}:${kind}:${now()}:${Math.random()}`)).slice(0, 12)
  const bytes = Buffer.from(data, 'utf8')
  const total = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES))
  const frames = []
  for (let frag = 0; frag < total; frag += 1) {
    const chunk = bytes.subarray(frag * CHUNK_BYTES, (frag + 1) * CHUNK_BYTES).toString('base64url')
    const frame = {
      v: PROTOCOL_VERSION,
      t: 'sig',
      product: PRODUCT,
      room,
      from,
      kind,
      id,
      frag,
      total,
      data: chunk,
    }
    frame.sig = signBytes(privateKey, signedBytes(frame))
    frames.push(Buffer.from(JSON.stringify(frame)))
  }
  return frames
}

/** Reassembles signed fragments; incomplete sets expire. */
export class SignalInbox {
  constructor(log) {
    this.log = log
    this.pending = new Map()
  }

  /**
   * Accept one wire frame. Returns the complete payload string when the frame
   * finishes its set, otherwise undefined. Invalid signatures and malformed
   * sets are dropped rather than thrown, so one bad datagram cannot break the
   * socket.
   */
  push(frame, peer) {
    if (!frame || frame.t !== 'sig' || typeof frame.from !== 'string') return undefined
    if (frame.from !== peer.deviceId) return undefined
    if (typeof frame.room !== 'string' || typeof frame.kind !== 'string') return undefined
    if (!Number.isInteger(frame.total) || frame.total < 1 || frame.total > MAX_FRAGMENTS) return undefined
    if (!Number.isInteger(frame.frag) || frame.frag < 0 || frame.frag >= frame.total) return undefined
    if (typeof frame.data !== 'string' || typeof frame.sig !== 'string') return undefined
    if (!verifyBytes(peer.publicKey, signedBytes(frame), frame.sig)) return undefined

    const key = `${frame.from}:${frame.kind}:${frame.id}`
    const entry = this.pending.get(key) ?? { total: frame.total, parts: new Array(frame.total), at: now() }
    if (entry.total !== frame.total) return undefined
    entry.parts[frame.frag] = Buffer.from(frame.data, 'base64url')
    this.pending.set(key, entry)
    if (entry.parts.every(part => part !== undefined)) {
      this.pending.delete(key)
      return Buffer.concat(entry.parts).toString('utf8')
    }
    return undefined
  }

  prune() {
    const cutoff = now() - 20000
    for (const [key, entry] of this.pending) {
      if (entry.at < cutoff) this.pending.delete(key)
    }
  }
}

/** Parse raw signal payloads of the three supported kinds. */
export function parseSignalPayload(kind, data) {
  const payload = parseJson(data)
  if (!payload || payload.kind !== kind) return undefined
  return payload
}
