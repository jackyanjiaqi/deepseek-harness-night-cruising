/** Small shared helpers: hashing, timing, safe JSON, and host names. */
import { createHash, randomBytes } from 'node:crypto'
import os from 'node:os'

export const PROTOCOL_VERSION = 1
export const PRODUCT = 'dsh-account-mesh'

/** base64url of a buffer or string. */
export function b64u(value) {
  return Buffer.from(value).toString('base64url')
}

/** SHA-256 digest. */
export function sha256(value) {
  return createHash('sha256').update(value).digest()
}

/** Short stable digest for display. */
export function digest(value, length = 22) {
  return sha256(value).toString('base64url').slice(0, length)
}

/** Short display form of a device id. */
export function shortId(value) {
  const text = String(value ?? '')
  return text.length > 12 ? `${text.slice(0, 8)}…${text.slice(-3)}` : text
}

/** Local display name, without exposing the machine's full identity. */
export function defaultPeerName() {
  const host = os.hostname() || 'dsh'
  return host.replace(/\.local$/i, '')
}

/** Parsed JSON, or undefined for anything malformed. */
export function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Random frame id. */
export function frameId() {
  return randomBytes(9).toString('base64url')
}

/** Milliseconds since epoch. */
export function now() {
  return Date.now()
}

/**
 * Line-slice text without materialising every line twice: `offset` is 0-based.
 * Returns the requested window, the total line count, and whether a later line exists.
 */
export function sliceLines(text, offset = 0, limit = 200) {
  const lines = text.split(/\r?\n/)
  const total = lines.length
  const start = Math.max(0, Math.min(offset, total))
  const end = Math.min(total, start + Math.max(1, limit))
  return { lines: lines.slice(start, end), total, hasMore: end < total }
}
