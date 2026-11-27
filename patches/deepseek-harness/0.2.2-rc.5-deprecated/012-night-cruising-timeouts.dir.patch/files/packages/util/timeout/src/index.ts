/**
 * Shared timeout arithmetic, signal fusion, and classification. The library
 * only notifies through abort signals; each capability still owns the mechanism
 * that stops its work and translates timeout reasons into public outcomes.
 * @module @deepseek-ai/dsh-timeout
 */

/**
 * Internal abort reason carrying a capability-owned code and elapsed deadline.
 * Providers translate it through {@link timeoutOf} before returning to callers.
 */
export class TimeoutReason extends Error {
  override name = 'TimeoutReason'

  /**
   * @param code Capability-owned timeout code (e.g. `BASH_TIMEOUT`).
   * @param timeoutMs The deadline that elapsed, in milliseconds.
   */
  constructor(readonly code: string, readonly timeoutMs: number) {
    super(`${code} after ${timeoutMs}ms`)
  }
}

/** Largest delay Node schedules without clamping it to one millisecond. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * Operation timeout values published by the Night Cruising settings bar.
 * `deadline` consults this map by capability code; an absent key or `0`
 * disables the local timer and forwards caller cancellation only. Keys and
 * their validation live in the settings surface, not here.
 */
let timeoutValues: Readonly<Record<string, number>> = Object.freeze({})

/** Whether a settings surface has published a complete map yet. Before that,
 * mapped capability codes keep their caller-supplied budget (the pre-settings
 * behavior); once published, only configured keys arm timers. */
let timeoutValuesPublished = false

/**
 * Replace the operation timeout values consulted by {@link deadline} and the
 * wait helpers. Values are validated at the settings boundary; this function
 * only takes a defensive copy.
 *
 * @param values - Settings key to milliseconds; `0` disables that timer.
 */
export function configureTimeouts(values: Readonly<Record<string, number>>): void {
  const next: Record<string, number> = {}
  for (const [key, value] of Object.entries(values)) {
    if (Number.isFinite(value) && value >= 0) next[key] = value
  }
  timeoutValues = Object.freeze(next)
  timeoutValuesPublished = true
}

/**
 * Read one configured operation timeout.
 *
 * @param key - Settings key (for example `wait.job.default`).
 * @param fallback - Value used when the key is absent or invalid.
 * @returns The configured milliseconds, or `fallback`.
 */
export function timeoutSetting(key: string, fallback: number): number {
  const value = timeoutValues[key]
  return value === undefined ? fallback : value
}

/**
 * Capability codes whose local deadline follows a settings entry. Model
 * request codes are deliberately absent: the desktop policy keeps model
 * requests uncancellable except by the caller.
 */
const DEADLINE_SETTINGS: Readonly<Record<string, string>> = {
  TASK_WAIT_TIMEOUT: 'wait.job.default',
  'session/wait-timeout': 'wait.session.default',
  TOOL_TIMEOUT: 'tool.call',
  BASH_TIMEOUT: 'tool.bash',
  PERSISTENT_BASH_TIMEOUT: 'tool.persistentBash',
  PERSISTENT_PWSH_TIMEOUT: 'tool.persistentBash',
  WORKTREE_TIMEOUT: 'tool.worktree',
  WEB_FETCH_TIMEOUT: 'web.fetch',
  LSP_SHUTDOWN: 'lsp.shutdown',
  LSP_CANCEL_GRACE: 'lsp.grace',
}

/**
 * Resolve the effective local deadline for one capability.
 *
 * @param code - Capability-owned timeout code.
 * @param requested - The caller's own budget; non-positive means no hint.
 * @returns Milliseconds to arm, or `0` when the timer is disabled.
 */
function deadlineFor(code: string, requested: number): number {
  if (requested <= 0) return 0
  const key = DEADLINE_SETTINGS[code]
  if (key === undefined) return 0
  if (!timeoutValuesPublished) return requested
  const configured = timeoutValues[key] ?? 0
  if (!Number.isFinite(configured) || configured <= 0) return 0
  return Math.min(requested, configured)
}

/** Reject a delay that would overflow Node's timer or arm nothing. */
function assertTimerDelay(timeoutMs: number, name: string): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${name} must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

/**
 * Validate a caller's optional timeout hint, use the backend default, then cap
 * it. Supplied values must be positive and finite; zero is not a public
 * disable-timeout sentinel.
 *
 * @param requested The caller's optional hint; validated when present.
 * @param def The backend default applied when `requested` is absent.
 * @param max The backend upper bound the result is capped to.
 * @param name Field name used in the thrown message (so the caller sees which input was
 *   bad).
 * @returns The effective timeout in milliseconds: `min(requested ?? def, max)`.
 */
export function clampTimeout(
  requested: number | undefined,
  def: number,
  max: number,
  name = 'timeoutMs',
): number {
  if (requested !== undefined && (!Number.isFinite(requested) || requested <= 0)) {
    throw new Error(`${name} must be a positive finite number`)
  }
  return Math.min(requested ?? def, max)
}

/** A deadline signal plus the cleanup that clears its timer (dispose-once). */
export interface Deadline {
  /** Aborts on upstream cancellation OR on timeout (the timeout carries a {@link TimeoutReason}). */
  readonly signal: AbortSignal
  /** Clear the timer. Safe to call once; `using` calls it at scope exit. */
  [Symbol.dispose](): void
}

/** Rearmable timeout around one outstanding async-iterator demand. */
export interface IdleWatchdog {
  /** Stable signal aborted by upstream cancellation or this watchdog's timeout. */
  readonly signal: AbortSignal
  /**
   * Await one iterator demand while the idle timer is armed. The deadline
   * settles the demand even when the awaited work ignores its abort signal.
   * @param iterator - iterator whose next value represents provider progress.
   * @returns the iterator's next result.
   * @throws The {@link TimeoutReason} of this watchdog when the idle interval
   *   elapses first. Only that deadline settles the demand: an upstream
   *   cancellation reaches the iterator through {@link IdleWatchdog.signal} and
   *   never shortens the wait. The abandoned demand stays the caller's to release
   *   through that signal; an async generator queues its own return behind it, so
   *   callers must not await it. Disposal clears the timer without settling an
   *   outstanding demand.
   */
  next<T>(iterator: AsyncIterator<T>): Promise<IteratorResult<T>>
  /** Rearm an outstanding demand after transport activity that yields no iterator value; otherwise a no-op. */
  pulse(): void
  /** Clear an armed timer; safe to call once at the owning stream's exit. */
  [Symbol.dispose](): void
}

/**
 * Fuse upstream cancellation with an identifiable timeout when the operation's
 * settings entry enables one. A disabled entry (`0` or absent) forwards caller
 * cancellation only. The signal only notifies, so callers must stop their own
 * work.
 *
 * @param upstream The caller's cancellation signal, if any, fused into the result.
 * @param timeoutMs Deadline hint in milliseconds; the operation's configured
 *   value caps it, and a non-positive hint disables the timer.
 * @param code Capability-owned code stamped onto the timeout's {@link TimeoutReason}.
 * @returns The fused {@link Deadline} (signal + timer cleanup).
 */
export function deadline(
  upstream: AbortSignal | undefined,
  timeoutMs: number,
  code: string,
): Deadline {
  const effective = deadlineFor(code, timeoutMs)
  if (effective <= 0) {
    // Operation timeouts are off by default; only the caller can cancel work.
    return { signal: upstream ?? new AbortController().signal, [Symbol.dispose]() {} }
  }
  assertTimerDelay(effective, 'deadline timeoutMs')
  const timer = new AbortController()
  const id = setTimeout(() => { timer.abort(new TimeoutReason(code, effective)) }, effective)
  return {
    signal: upstream === undefined ? timer.signal : AbortSignal.any([upstream, timer.signal]),
    [Symbol.dispose]() {
      clearTimeout(id)
    },
  }
}

/**
 * Arm a real timer for a caller-facing blocking wait. Unlike {@link deadline},
 * expiry only ends this wait and returns the current state; it never aborts
 * the awaited work. Callers pass a value already resolved from the Night
 * Cruising settings.
 *
 * @param upstream The caller's cancellation, forwarded unchanged.
 * @param timeoutMs The wait expiry in milliseconds.
 * @param code Capability-owned code carried by the abort reason.
 * @returns The fused {@link Deadline}; disposal clears the timer.
 */
export function waitDeadline(
  upstream: AbortSignal | undefined,
  timeoutMs: number,
  code: string,
): Deadline {
  assertTimerDelay(timeoutMs, 'waitDeadline timeoutMs')
  const controller = new AbortController()
  const id = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort(new TimeoutReason(code, timeoutMs))
  }, timeoutMs)
  let disposed = false
  return {
    signal: upstream === undefined ? controller.signal : AbortSignal.any([upstream, controller.signal]),
    [Symbol.dispose]() {
      if (disposed) return
      disposed = true
      clearTimeout(id)
    },
  }
}

/** Preserve iterator lifecycle and caller cancellation without an idle timer. */
export function idleWatchdog(
  upstream: AbortSignal | undefined,
  timeoutMs: number,
  code: string,
): IdleWatchdog {
  void timeoutMs
  void code
  const signal = upstream ?? new AbortController().signal
  let outstanding = false
  let disposed = false
  return {
    signal,
    async next<T>(iterator: AsyncIterator<T>): Promise<IteratorResult<T>> {
      if (disposed) throw new Error('idleWatchdog is disposed')
      if (outstanding) throw new Error('idleWatchdog next is already outstanding')
      outstanding = true
      try { return await iterator.next() }
      finally { outstanding = false }
    },
    pulse(): void {},
    [Symbol.dispose](): void { disposed = true },
  }
}

/**
 * Recover a timeout reason from a reason-bearing object. Supplying `code`
 * distinguishes this deadline from a nested upstream deadline; a foreign code
 * follows the ordinary cancellation path.
 *
 * @param x An {@link AbortSignal} or any `{ reason }` carrier (e.g. a caught abort error).
 * @param code When provided, only a {@link TimeoutReason} with this exact `code` matches.
 * @returns The matching {@link TimeoutReason}, else `undefined`.
 */
export function timeoutOf(x: AbortSignal | { reason?: unknown }, code?: string): TimeoutReason | undefined {
  // AbortSignal.reason is typed `any`; pin it to `unknown` so no `any` leaks and
  // the instanceof narrows cleanly for both a signal and a bare reason carrier.
  const reason: unknown = x.reason
  if (!(reason instanceof TimeoutReason)) return undefined
  return code === undefined || reason.code === code ? reason : undefined
}
