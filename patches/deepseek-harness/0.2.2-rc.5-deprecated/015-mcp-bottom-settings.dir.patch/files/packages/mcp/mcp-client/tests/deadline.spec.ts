import { afterEach, describe, expect, it } from 'vitest'
import { configureTimeouts } from '@deepseek-ai/dsh-timeout'
import { mcpTimeoutMs, withDeadline } from '../src/deadline.ts'

afterEach(() => { configureTimeouts({}) })

describe('MCP bottom-bar deadlines', () => {
  it('leaves MCP uncapped when the bar value is zero', () => {
    const pending = Promise.resolve('ok')
    expect(mcpTimeoutMs()).toBe(2_147_483_647)
    expect(withDeadline(pending, 1_000, 'never')).toBe(pending)
  })

  it('uses the configured tool-call cap', () => {
    configureTimeouts({ 'mcp.tool': 1_234 })
    expect(mcpTimeoutMs()).toBe(1_234)
  })

  it('rejects a startup/probe operation at the configured budget', async () => {
    configureTimeouts({ 'mcp.operation': 50 })
    await expect(withDeadline(new Promise<never>(() => {}), 10_000, 'MCP operation timed out'))
      .rejects.toThrow('MCP operation timed out')
  })

  it('keeps the caller budget when it is shorter than the bar value', async () => {
    configureTimeouts({ 'mcp.operation': 10_000 })
    const started = Date.now()
    await expect(withDeadline(new Promise<never>(() => {}), 50, 'caller budget'))
      .rejects.toThrow('caller budget')
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})
