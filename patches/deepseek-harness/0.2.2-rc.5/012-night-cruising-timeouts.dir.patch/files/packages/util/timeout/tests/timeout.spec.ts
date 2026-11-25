import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clampTimeout,
  configureTimeouts,
  deadline,
  idleWatchdog,
  MAX_TIMER_DELAY_MS,
  timeoutOf,
  TimeoutReason,
  waitDeadline,
} from '@deepseek-ai/dsh-timeout'

describe('TimeoutReason', () => {
  it('is an Error carrying the code and elapsed ms', () => {
    const reason = new TimeoutReason('BASH_TIMEOUT', 100)
    expect(reason).toBeInstanceOf(Error)
    expect(reason.name).toBe('TimeoutReason')
    expect(reason.code).toBe('BASH_TIMEOUT')
    expect(reason.timeoutMs).toBe(100)
    expect(reason.message).toBe('BASH_TIMEOUT after 100ms')
  })
})

describe('clampTimeout', () => {
  it('fills the default when the hint is absent', () => {
    expect(clampTimeout(undefined, 120_000, 600_000)).toBe(120_000)
  })

  it('caps the hint at max', () => {
    expect(clampTimeout(999_999, 120_000, 600_000)).toBe(600_000)
  })

  it('keeps a valid hint under the cap', () => {
    expect(clampTimeout(5_000, 120_000, 600_000)).toBe(5_000)
  })

  it('caps the default itself when the default exceeds max', () => {
    // min(def, max) applies even with no hint — a misconfigured backend never
    // exceeds its own cap.
    expect(clampTimeout(undefined, 900_000, 600_000)).toBe(600_000)
  })

  it('rejects a non-finite hint with the caller-provided name', () => {
    expect(() => clampTimeout(Number.NaN, 100, 200, 'bash-local: request.timeoutMs'))
      .toThrow(/bash-local: request\.timeoutMs must be a positive finite number/)
    expect(() => clampTimeout(Number.POSITIVE_INFINITY, 100, 200))
      .toThrow(/timeoutMs must be a positive finite number/)
  })

  it('rejects a non-positive hint', () => {
    expect(() => clampTimeout(0, 100, 200)).toThrow(/must be a positive finite number/)
    expect(() => clampTimeout(-1, 100, 200)).toThrow(/must be a positive finite number/)
  })
})

describe('deadline — timeout arm', () => {
  // The settings bar owns these values; a deadline arms only for a mapped code
  // whose entry enables it and caps the caller's own hint.
  beforeEach(() => { configureTimeouts({ 'tool.bash': 100_000, 'web.fetch': 100_000 }) })
  afterEach(() => {
    configureTimeouts({})
    vi.useRealTimers()
  })

  it('aborts on timeout with a TimeoutReason after the elapsed ms', () => {
    vi.useFakeTimers()
    using d = deadline(undefined, 100, 'BASH_TIMEOUT')
    expect(d.signal.aborted).toBe(false)
    vi.advanceTimersByTime(100)
    expect(d.signal.aborted).toBe(true)
    const reason = timeoutOf(d.signal)
    expect(reason).toBeInstanceOf(TimeoutReason)
    expect(reason?.code).toBe('BASH_TIMEOUT')
    expect(reason?.timeoutMs).toBe(100)
  })

  it('[Symbol.dispose] clears the timer so no abort fires afterward', () => {
    vi.useFakeTimers()
    const d = deadline(undefined, 100, 'BASH_TIMEOUT')
    d[Symbol.dispose]()
    vi.advanceTimersByTime(1_000)
    expect(d.signal.aborted).toBe(false)
    expect(timeoutOf(d.signal)).toBeUndefined()
  })

  it('leaves a code without a settings entry untimed', () => {
    vi.useFakeTimers()
    using d = deadline(undefined, 100, 'FORGE_FETCH_TIMEOUT')
    vi.advanceTimersByTime(1_000)
    expect(d.signal.aborted).toBe(false)
  })

  it('forwards only cancellation when the settings entry is zero', () => {
    configureTimeouts({ 'tool.bash': 0 })
    vi.useFakeTimers()
    using d = deadline(undefined, 100, 'BASH_TIMEOUT')
    vi.advanceTimersByTime(1_000)
    expect(d.signal.aborted).toBe(false)
  })
})

describe('deadline — fuse with upstream', () => {
  beforeEach(() => { configureTimeouts({ 'tool.bash': 100_000, 'web.fetch': 100_000 }) })
  afterEach(() => { configureTimeouts({}) })

  it('aborts on upstream cancellation, classified as NOT a timeout', () => {
    const upstream = new AbortController()
    using d = deadline(upstream.signal, 60_000, 'BASH_TIMEOUT')
    upstream.abort('user cancelled')
    expect(d.signal.aborted).toBe(true)
    expect(timeoutOf(d.signal)).toBeUndefined()
  })

  it('cancel wins when it fires before the timeout', () => {
    vi.useFakeTimers()
    try {
      const upstream = new AbortController()
      using d = deadline(upstream.signal, 100, 'BASH_TIMEOUT')
      upstream.abort('user cancelled') // fires first, before the 100ms timer
      vi.advanceTimersByTime(200)
      expect(d.signal.aborted).toBe(true)
      // AbortSignal.any adopts the FIRST source's reason: cancel won, so no
      // TimeoutReason even though the timer later elapsed.
      expect(timeoutOf(d.signal)).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('timeout wins when it fires before upstream cancellation', () => {
    vi.useFakeTimers()
    try {
      const upstream = new AbortController()
      using d = deadline(upstream.signal, 100, 'WEB_FETCH_TIMEOUT')
      vi.advanceTimersByTime(150) // past the 100ms deadline: the timer fires first
      expect(d.signal.aborted).toBe(true)
      expect(timeoutOf(d.signal)?.code).toBe('WEB_FETCH_TIMEOUT')
      // A later upstream abort is a no-op on the already-aborted fused signal:
      // AbortSignal.any keeps the FIRST cause, so the timeout classification stands.
      upstream.abort('too late')
      expect(timeoutOf(d.signal)?.code).toBe('WEB_FETCH_TIMEOUT')
    } finally {
      vi.useRealTimers()
    }
  })

  it('forwards a pre-aborted upstream signal immediately', () => {
    const upstream = new AbortController()
    upstream.abort('already gone')
    using d = deadline(upstream.signal, 60_000, 'BASH_TIMEOUT')
    expect(d.signal.aborted).toBe(true)
    expect(timeoutOf(d.signal)).toBeUndefined()
  })
})

describe('deadline — timeoutMs <= 0 (no-timeout sentinel)', () => {
  beforeEach(() => { configureTimeouts({ 'tool.bash': 100_000 }) })
  afterEach(() => {
    configureTimeouts({})
    vi.useRealTimers()
  })

  it('arms no timer and forwards only the upstream signal', () => {
    vi.useFakeTimers()
    const upstream = new AbortController()
    using d = deadline(upstream.signal, 0, 'BASH_TIMEOUT')
    vi.advanceTimersByTime(1_000_000)
    expect(d.signal.aborted).toBe(false) // no timer ever armed
    upstream.abort('kill')
    expect(d.signal.aborted).toBe(true)
    expect(timeoutOf(d.signal)).toBeUndefined() // never a timeout
  })

  it('returns a never-aborting signal with a no-op disposer when there is no upstream', () => {
    vi.useFakeTimers()
    const d = deadline(undefined, 0, 'BASH_TIMEOUT')
    expect(() => { d[Symbol.dispose]() }).not.toThrow()
    vi.advanceTimersByTime(1_000_000)
    expect(d.signal.aborted).toBe(false)
    expect(timeoutOf(d.signal)).toBeUndefined()
  })

  it('treats a negative timeout the same as zero', () => {
    const d = deadline(undefined, -5, 'BASH_TIMEOUT')
    expect(d.signal.aborted).toBe(false)
    d[Symbol.dispose]()
  })
})

describe('timeoutOf', () => {
  it('classifies a bare reason carrier that holds a TimeoutReason', () => {
    const reason = new TimeoutReason('WEB_FETCH_TIMEOUT', 50)
    expect(timeoutOf({ reason })).toBe(reason)
  })

  it('returns undefined for a non-timeout reason', () => {
    expect(timeoutOf({ reason: new Error('other') })).toBeUndefined()
    expect(timeoutOf({ reason: 'user cancelled' })).toBeUndefined()
    expect(timeoutOf({})).toBeUndefined()
  })

  it('matches only the requested code when one is given', () => {
    const reason = new TimeoutReason('BASH_TIMEOUT', 100)
    expect(timeoutOf({ reason }, 'BASH_TIMEOUT')).toBe(reason)
    expect(timeoutOf({ reason }, 'WEB_FETCH_TIMEOUT')).toBeUndefined()
  })
})

describe('deadline — nested deadlines', () => {
  it("does not misclassify an outer deadline's timeout as the inner code", () => {
    // The upstream handed to the inner deadline is ITSELF a deadline that has already timed out
    // (outer). `AbortSignal.any` preserves that reason, but scoping `timeoutOf` to the inner code
    // must classify it as upstream cancellation rather than the inner capability's timeout.
    const outer = new AbortController()
    outer.abort(new TimeoutReason('OUTER_TIMEOUT', 30))
    using inner = deadline(outer.signal, 60_000, 'BASH_TIMEOUT')
    expect(inner.signal.aborted).toBe(true)
    expect(timeoutOf(inner.signal, 'BASH_TIMEOUT')).toBeUndefined() // not ours → upstream-cancel path
    expect(timeoutOf(inner.signal)?.code).toBe('OUTER_TIMEOUT') // but IS a timeout, unscoped
  })
})

describe('waitDeadline', () => {
  afterEach(() => { vi.useRealTimers() })

  it('ends the wait with a TimeoutReason without aborting anything else', () => {
    vi.useFakeTimers()
    using d = waitDeadline(undefined, 100, 'TASK_WAIT_TIMEOUT')
    vi.advanceTimersByTime(100)
    expect(timeoutOf(d.signal, 'TASK_WAIT_TIMEOUT')?.timeoutMs).toBe(100)
  })

  it('clears the timer on disposal and forwards upstream cancellation', () => {
    vi.useFakeTimers()
    const upstream = new AbortController()
    const d = waitDeadline(upstream.signal, 100, 'TASK_WAIT_TIMEOUT')
    d[Symbol.dispose]()
    vi.advanceTimersByTime(1_000)
    expect(d.signal.aborted).toBe(false)
    upstream.abort('user steered')
    expect(d.signal.reason).toBe('user steered')
  })

  it('rejects delays Node would clamp to one millisecond', () => {
    expect(() => waitDeadline(undefined, MAX_TIMER_DELAY_MS + 1, 'TASK_WAIT_TIMEOUT'))
      .toThrow(`no greater than ${MAX_TIMER_DELAY_MS}`)
    expect(() => waitDeadline(undefined, 0, 'TASK_WAIT_TIMEOUT')).toThrow(/positive finite/)
  })
})

describe('idleWatchdog — model streams stay untimed', () => {
  it('forwards the iterator without arming a local deadline', async () => {
    vi.useFakeTimers()
    try {
      const upstream = new AbortController()
      using watchdog = idleWatchdog(upstream.signal, 100, 'LLM_STREAM_IDLE_TIMEOUT')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(watchdog.signal.aborted).toBe(false)
      const pending = Promise.withResolvers<IteratorResult<number>>()
      const next = watchdog.next({ next: () => pending.promise })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(watchdog.signal.aborted).toBe(false)
      pending.resolve({ done: true, value: undefined })
      await expect(next).resolves.toEqual({ done: true, value: undefined })
      upstream.abort('user cancelled')
      expect(watchdog.signal.reason).toBe('user cancelled')
      expect(timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT')).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps disposal and single-demand guards', async () => {
    const pending = Promise.withResolvers<IteratorResult<number>>()
    const watchdog = idleWatchdog(undefined, 100, 'IDLE')
    const iterator = { next: () => pending.promise }
    void watchdog.next(iterator)
    await expect(watchdog.next(iterator)).rejects.toThrow(/already outstanding/)
    pending.resolve({ done: true, value: undefined })
    watchdog[Symbol.dispose]()
    await expect(watchdog.next(iterator)).rejects.toThrow(/disposed/)
  })
})
