/**
 * Two-instance JLC transfer harness: real discovery/WebRTC, real native codec,
 * a fake sessionPersistence pointing at one JSONL fixture, and memory-only
 * fetch. Run `node spike/p0-jlc.mjs`.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Mesh } from '../src/mesh.js'
import { CodecController } from '../src/codec.js'

const root = path.join(import.meta.dirname, '..', '.tmp', 'jlc')
fs.rmSync(root, { recursive: true, force: true })
fs.mkdirSync(root, { recursive: true })
const sessionFile = path.join(root, 'session.v4.jsonl')
const events = [
  { type: 'session', version: 4, id: 'session-remote', createdAt: 1000, cwd: root, isSeeded: false, delegationDepth: 0 },
  { type: 'user/message', seq: 1, time: 1000, data: { content: [{ type: 'text', text: 'remote question' }] } },
  { type: 'assistant/message', seq: 2, time: 2000, data: { message: { content: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'remote answer' }, { type: 'tool-call', name: 'read', arguments: '{"path":"notes.txt"}' }] } } },
  { type: 'tool/call', seq: 3, time: 3000, data: { name: 'read', arguments: '{"path":"notes.txt"}' } },
  { type: 'tool/result', seq: 4, time: 4000, data: { message: { content: [{ type: 'text', text: 'line one\nline two' }] } } },
]
if (process.env.JLC_SESSION) {
  fs.copyFileSync(process.env.JLC_SESSION, sessionFile)
} else {
  fs.writeFileSync(sessionFile, events.map(event => JSON.stringify(event)).join('\n') + '\n')
}

const nativePath = path.join(import.meta.dirname, '..', 'native', 'jlc.node')
const log = { info: () => {}, warn: (...args) => console.log('[warn]', ...args), debug: () => {}, error: (...args) => console.log('[error]', ...args) }

function makeCtx({ workspace, deviceId }) {
  const services = new Map()
  services.set('deepseekAccount', {
    async getPlatformSession() { return { origin: 'https://example.invalid', token: 'never-used', userId: 'account-1' } },
    async getDeviceIdentity() { return { deviceId, osVersion: os.release() } },
  })
  services.set('sessionQuery', {
    async listSessions() { return [] },
    async readTitleSnapshots(ids) { return ids.map(sessionId => ({ sessionId, status: 'fulfilled', value: { title: { title: 'Remote' } } })) },
  })
  services.set('sessionPersistence', {
    async stat() { return { location: { kind: 'jsonl', path: sessionFile } } },
  })
  services.set('sessions', { get() { return undefined }, async flush() {} })
  services.set('workspaceRegistry', { list() { return [{ id: 'ws', title: 'Workspace', path: workspace }] } })
  return { get: name => services.get(name) }
}

const codecA = new CodecController({
  config: { codec: 'auto', nativeModulePath: nativePath, siteBaseUrl: 'https://invalid.example' },
  edition: { edition: 'night-cruising', source: 'config' },
  dataDir: path.join(root, 'home-a'), here: path.join(import.meta.dirname, '..'), log,
})
const codecB = new CodecController({
  config: { codec: 'auto', nativeModulePath: nativePath, siteBaseUrl: 'https://invalid.example' },
  edition: { edition: 'night-cruising', source: 'config' },
  dataDir: path.join(root, 'home-b'), here: path.join(import.meta.dirname, '..'), log,
})
await codecA.start()
await codecB.start()
console.log('codecA', codecA.state().mode, codecA.state().active, 'codecB', codecB.state().mode, codecB.state().active)

const meshA = new Mesh({
  ctx: makeCtx({ workspace: root, deviceId: 'device-alpha' }),
  config: { discoveryPort: 48301, staticPeers: ['127.0.0.1:48302'], dataDir: path.join(root, 'mesh-a'), vaultMode: 'hosted', vaultRoot: path.join(root, 'local-vault') },
  log, version: '0.1.0-test', codec: codecA,
})
const meshB = new Mesh({
  ctx: makeCtx({ workspace: root, deviceId: 'device-beta' }),
  config: { discoveryPort: 48302, staticPeers: ['127.0.0.1:48301'], dataDir: path.join(root, 'mesh-b') },
  log, version: '0.1.0-test', codec: codecB,
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
  await waitFor('discovered', () => meshA.peerViews().length > 0)
  meshA.pair('device-beta'); meshB.pair('device-alpha')
  // A first contact waits for the user's explicit answer; this harness answers
  // both sides directly, exactly as the blocking dialog would.
  await waitFor('discovery', () => meshA.peerViews().some(peer => peer.deviceId === 'device-beta'))
  meshA.pair('device-beta')
  meshB.pair('device-alpha')
  await waitFor('verified', () => meshA.peerViews().some(peer => peer.verified))
  const progress = []
  const started = Date.now()
  const result = await meshA.fetchSession('device-beta', 'session-remote', {
    onProgress: state => progress.push(state),
  })
  const elapsed = Date.now() - started
  console.log(`JLC metrics raw=${result.rawBytes} archive=${result.archiveBytes} blocks=${result.blocks} items=${result.items.length} elapsed=${elapsed}ms`)
  check('fetch returns projected items', process.env.JLC_SESSION ? result.items.length > 0 : result.items.length === 4, String(result.items.length))
  check('reasoning and tool call survive projection', process.env.JLC_SESSION ? true : result.items[1].text === 'remote answer' && result.items[1].toolCalls?.[0] === 'read')
  check('dialog projection is available', result.dialogItems.length >= 2, String(result.dialogItems.length))
  check('progress reports blocks and bytes', progress.some(state => state.totalBlocks > 0 && state.receivedBlocks === state.totalBlocks) && progress.some(state => state.dialogReady === true), JSON.stringify(progress))
  check('no legacy .part/.jlc files are created', !fs.existsSync(path.join(root, 'mesh-a', 'incoming')) && !fs.existsSync(path.join(root, 'mesh-a', 'session.jlc')))
  check('transfer completed', result.archiveBytes > 0 && result.rawBytes > 0 && elapsed < 20000, `${elapsed}ms ${result.archiveBytes}/${result.rawBytes}`)
  const state = meshA.state()
  check('state exposes cache stats', state.cache?.entries >= 1 && state.cache.bytes > 0, JSON.stringify(state.cache))
  check('hosted vault reports encrypted containers', state.vault?.mode === 'hosted' && state.vault.containers >= 1 && state.vault.bytes > 0, JSON.stringify(state.vault))
  const cached = await meshA.fetchSession('device-beta', 'session-remote')
  check('second fetch is a vault hit with the same projection', cached.vaultHit === true && cached.items.length === result.items.length, JSON.stringify({ vaultHit: cached.vaultHit, items: cached.items.length }))
  check('state no longer lists an active transfer', state.transfers.length === 0, JSON.stringify(state.transfers))
} catch (error) {
  failures += 1
  console.error('HARNESS ERROR', error)
} finally {
  await meshA.stop(); await meshB.stop(); codecA.stop(); codecB.stop()
  const vaultFiles = []
  const walk = dir => { if (!fs.existsSync(dir)) return; for (const name of fs.readdirSync(dir)) { const file = path.join(dir, name); if (fs.statSync(file).isDirectory()) walk(file); else if (name.endsWith('.hdr') || name.endsWith('.dat')) vaultFiles.push(file) } }
  walk(path.join(root, 'local-vault'))
  check('stop preserves hosted ciphertext for the next process', vaultFiles.length >= 2)
  console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`)
  process.exit(failures === 0 ? 0 : 1)
}
