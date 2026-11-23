/** Request/response frames and the pending-call table for one peer link. */
import { frameId, now } from './util.js'

/** One wire-level error the other instance can branch on. */
export function wireError(code, message) {
  return { code, message }
}

/** Normalises any thrown value into a wire error. */
export function toWireError(error) {
  if (error && typeof error.code === 'string') return wireError(error.code, error.message ?? String(error))
  return wireError('internal', error instanceof Error ? error.message : String(error))
}

/**
 * Pending outbound calls for one peer. Calls settle only through a response,
 * a link teardown, or the caller's own abort — never through a timer.
 */
export class PendingCalls {
  constructor() {
    this.calls = new Map()
  }

  open(signal) {
    const id = frameId()
    let settle
    const promise = new Promise((resolve, reject) => {
      settle = { resolve, reject }
    })
    const entry = {
      resolve: value => {
        this.calls.delete(id)
        settle.resolve(value)
      },
      reject: error => {
        this.calls.delete(id)
        settle.reject(error)
      },
      cleanup: () => {},
    }
    if (signal) {
      if (signal.aborted) {
        entry.reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
        return { id, promise }
      }
      const onAbort = () => entry.reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      signal.addEventListener('abort', onAbort, { once: true })
      entry.cleanup = () => signal.removeEventListener('abort', onAbort)
    }
    this.calls.set(id, entry)
    promise.catch(() => {}).finally(() => entry.cleanup())
    return { id, promise }
  }

  settle(frame) {
    const entry = this.calls.get(frame.id)
    if (!entry) return false
    if (frame.ok) entry.resolve(frame.result)
    else entry.reject(Object.assign(new Error(frame.err?.message ?? 'peer error'), { code: frame.err?.code ?? 'internal' }))
    return true
  }

  rejectAll(reason) {
    for (const entry of this.calls.values()) entry.reject(reason)
    this.calls.clear()
  }

  get size() {
    return this.calls.size
  }
}

/** Encode one outbound request. */
export function requestFrame(op, params) {
  return { id: frameId(), op, params, at: now() }
}
