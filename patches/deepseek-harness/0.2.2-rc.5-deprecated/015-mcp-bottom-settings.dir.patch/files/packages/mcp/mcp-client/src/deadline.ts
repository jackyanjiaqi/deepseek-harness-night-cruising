/** MCP operation deadlines, configured by the Night Cruising bottom bar. */
import { settingNumber } from '@deepseek-ai/dsh-timeout'
import { McpLocalError } from './diagnostic.ts'

/** Largest delay Node's timer accepts; MCP uses it as the "no local timeout" value. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * Resolve the MCP tool-call timeout. `0` (the default) means "leave the SDK
 * uncapped"; a positive bottom-bar value caps every MCP request.
 * @returns milliseconds to pass to the SDK.
 */
export function mcpTimeoutMs(): number {
  const configured = Math.floor(settingNumber('mcp.tool', 0))
  return configured > 0 ? configured : MAX_TIMER_DELAY_MS
}

/**
 * Settle with `promise`, or reject with `timeoutMessage` once the configured
 * MCP operation budget elapses first. `0` keeps the original pass-through.
 * @param promise - operation the deadline bounds.
 * @param remainingMs - caller's own remaining budget.
 * @param timeoutMessage - diagnostic carried by the deadline rejection.
 * @returns the operation's value; rejects with the deadline or the operation's failure.
 */
export function withDeadline<T>(promise: Promise<T>, remainingMs: number, timeoutMessage: string): Promise<T> {
  const configured = Math.floor(settingNumber('mcp.operation', 0))
  if (configured <= 0) return promise
  const budget = Math.max(1, Math.min(remainingMs, configured))
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new McpLocalError(timeoutMessage)) }, budget)
    timer.unref()
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))) },
    )
  })
}
