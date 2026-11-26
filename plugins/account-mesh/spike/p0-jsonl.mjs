/** Native-DSH fallback: long session paged serially with visible progress. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Mesh } from '../src/mesh.js'

const root = path.join(import.meta.dirname, '..', '.tmp', 'jsonl')
fs.rmSync(root, { recursive: true, force: true })
fs.mkdirSync(root, { recursive: true })

const events = []
for (let i = 1; i <= 1200; i += 1) {
  events.push(i % 2 === 1
    ? { type: 'user/message', seq: i, time: 1000 + i, data: { content: [{ type: 'text', text: `question ${i}` }] } }
    : { type: 'assistant/message', seq: i, time: 1000 + i, data: { message: { content: [{ type: 'text', text: `answer ${i}` }] } } })
}

const log = { info: () => {}, warn: (...args) => console.log('[warn]', ...args), debug: () => {}, error: (...args) => console.log('[error]', ...args) }
function makeCtx({ deviceId }) {
  const services = new Map()
  services.set('deepseekAccount', {
    async getPlatformSession() { return { origin: 'https://example.invalid', token: 'never-used', userId: 'account-1' } },
    async getDeviceIdentity() { return { deviceId, osVersion: os.release() } },
  })
  services.set('sessionQuery', {
    async listSessions() { return [{ header: { id: 'session-remote', createdAt: 1000, cwd: root }, live: false, persisted: true }] },
    async readTitleSnapshots(ids) { return ids.map(sessionId => ({ sessionId, status: 'fulfilled', value: { title: { title: 'Long session' } } })) },
    async readSession() { return { session: { id: 'session-remote', cwd: root, createdAt: 1000 }, inheritedEventCount: 0, events } },
  })
  services.set('workspaceRegistry', { list() { return [{ id: 'ws', title: 'Workspace', path: root }] } })
  return { get: name => services.get(name) }
}

const meshA = new Mesh({
  ctx: makeCtx({ deviceId: 'device-alpha' }),
  config: { discoveryPort: 48501, staticPeers: ['127.0.0.1:48502'], dataDir: path.join(root, 'home-a'), vaultEnabled: false },
  log, version: '0.1.0-test',
})
const meshB = new Mesh({
  ctx: makeCtx({ deviceId: 'device-beta' }),
  config: { discoveryPort: 48502, staticPeers: ['127.0.0.1:48501'], dataDir: path.join(root, 'home-b'), vaultEnabled: false },
  log, version: '0.1.0-test',
})
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(label, predicate, timeout = 20000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (predicate()) return
    await sleep(100)
  }
  throw new Error(`timeout waiting for ${label}`)
}
let failures = 0
const check = (label, condition, detail) => {
  if (condition) console.log(`PASS ${label}`)
  else { failures += 1; console.log(`FAIL ${label}`, detail ?? '') }
}
try {
  meshA.start(); meshB.start()
  await waitFor('verified', () => meshA.peerViews().some(peer => peer.verified))
  const progress = []
  const started = Date.now()
  const result = await meshA.fetchSession('device-beta', 'session-remote', { onProgress: state => progress.push(state) })
  const elapsed = Date.now() - started
  check('native fallback returns every item', result.items.length === 1200, String(result.items.length))
  check('native fallback is paged serially', result.blocks === 3, `${result.blocks} pages`)
  check('native fallback reports total items', result.totalItems === 1200, String(result.totalItems))
  check('native fallback reports increasing progress', progress.some((state, index) => index > 0 && state.receivedItems > progress[index - 1].receivedItems), JSON.stringify(progress.slice(0, 4)))
  check('native fallback is not a JLC/vault hit', result.mode === 'jsonl' && result.vaultHit === false, JSON.stringify({ mode: result.mode, vaultHit: result.vaultHit }))
  check('native fallback finishes in a reasonable time', elapsed < 30000, `${elapsed}ms`)
} catch (error) {
  failures += 1
  console.error('HARNESS ERROR', error)
} finally {
  await meshA.stop(); await meshB.stop()
  console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`)
  process.exit(failures === 0 ? 0 : 1)
}
