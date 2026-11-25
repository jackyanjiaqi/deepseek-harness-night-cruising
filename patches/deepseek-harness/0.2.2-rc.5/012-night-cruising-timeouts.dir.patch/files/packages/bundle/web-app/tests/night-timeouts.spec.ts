/**
 * The Night Cruising footer route: authenticated JSON read/write over the
 * real node:http request and response types, with the persisted file as the
 * observable side effect and the published timeout value as the runtime one.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureTimeouts, timeoutSetting } from '@deepseek-ai/dsh-timeout'
import {
  handleNightTimeoutsRequest,
  NIGHT_TIMEOUT_DEFAULTS,
  nightTimeoutSettingsPath,
  readNightTimeouts,
} from '../src/night-timeouts.ts'

let root: string | undefined
let server: Server | undefined
let port: number | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-night-timeouts-'))
  vi.stubEnv('DSH_HOME', root)
  server = createServer((req, res) => {
    void handleNightTimeoutsRequest(req, res, () => ({ peer: {} }))
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  port = typeof address === 'object' && address !== null ? address.port : undefined
})

afterEach(async () => {
  configureTimeouts({})
  vi.unstubAllEnvs()
  if (server !== undefined) await new Promise<void>(resolve => { server!.close(() => { resolve() }) })
  server = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Send one request to the test listener. */
async function request(method: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  if (port === undefined) throw new Error('test listener did not bind')
  const response = await fetch(`http://127.0.0.1:${String(port)}/night-cruising/timeouts`, {
    method,
    ...body === undefined ? {} : {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  })
  const text = await response.text()
  let json: unknown = text
  try { json = JSON.parse(text) } catch { /* plain-text refusals keep their text */ }
  return { status: response.status, json }
}

/** Read one value from a JSON result without an unsafe cast at the assertion. */
function valueOf(json: unknown, key: string): unknown {
  if (typeof json !== 'object' || json === null || !('values' in json)) return undefined
  const values = (json as { values?: Record<string, unknown> }).values
  return values?.[key]
}

describe('night timeout settings route', () => {
  it('serves the catalog with defaults before any save', async () => {
    const { status, json } = await request('GET')
    expect(status).toBe(200)
    expect(valueOf(json, 'wait.job.default')).toBe(30_000)
    expect(valueOf(json, 'tool.bash')).toBe(0)
    expect(Array.isArray((json as { groups?: unknown }).groups)).toBe(true)
  })

  it('persists a value and publishes it to the timeout library', async () => {
    const { status, json } = await request('PUT', { values: { 'wait.job.default': 45_000, 'tool.bash': 120_000 } })
    expect(status).toBe(200)
    expect(valueOf(json, 'wait.job.default')).toBe(45_000)
    expect(timeoutSetting('wait.job.default', 30_000)).toBe(45_000)
    expect(timeoutSetting('tool.bash', 0)).toBe(120_000)
    const stored = JSON.parse(await readFile(nightTimeoutSettingsPath(), 'utf8')) as { values?: Record<string, number> }
    expect(stored.values?.['wait.job.default']).toBe(45_000)
    expect(await readNightTimeouts()).toMatchObject({ 'wait.job.default': 45_000 })
  })

  it('rejects an out-of-range value and leaves the file at its defaults', async () => {
    const before = await request('PUT', { values: { 'wait.job.default': 10 } })
    expect(before.status).toBe(400)
    expect(await readNightTimeouts()).toMatchObject({ 'wait.job.default': NIGHT_TIMEOUT_DEFAULTS['wait.job.default'] })
  })

  it('rejects a write to a policy-owned row', async () => {
    const { status } = await request('PUT', { values: { 'llm.request': 1_000 } })
    expect(status).toBe(400)
  })

  it('reports unauthorized before reading or writing', async () => {
    server?.close()
    server = createServer((req, res) => {
      void handleNightTimeoutsRequest(req, res, () => ({ rejection: 401 }))
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    port = typeof address === 'object' && address !== null ? address.port : undefined
    const { status } = await request('GET')
    expect(status).toBe(401)
  })
})
