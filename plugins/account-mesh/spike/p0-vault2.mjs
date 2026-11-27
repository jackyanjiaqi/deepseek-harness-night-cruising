/**
 * Hosted-vault NCV2 integration: first pull deposits, restart reopens with a
 * one-RTT key, wrong key is rejected, correct key opens, revoke falls back.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Mesh } from '../src/mesh.js'
import { CodecController } from '../src/codec.js'

const root = path.join(import.meta.dirname, '..', '.tmp', 'vault2')
fs.rmSync(root, { recursive: true, force: true })
fs.mkdirSync(root, { recursive: true })
const sessionFile = path.join(root, 'session.v4.jsonl')
const events = [
  { type: 'session', version: 4, id: 'session-vault', createdAt: 1000, cwd: '/remote/workspace/project', isSeeded: false, delegationDepth: 0 },
  { type: 'user/message', seq: 1, time: 1000, data: { content: [{ type: 'text', text: 'secret remote question' }] } },
  { type: 'assistant/message', seq: 2, time: 2000, data: { message: { content: [{ type: 'reasoning', text: 'private reasoning' }, { type: 'text', text: 'secret remote answer' }, { type: 'tool-call', name: 'read', arguments: '{"path":"secret.txt"}' }] } } },
  { type: 'tool/call', seq: 3, time: 3000, data: { name: 'read', arguments: '{"path":"secret.txt"}' } },
  { type: 'tool/result', seq: 4, time: 4000, data: { message: { content: [{ type: 'text', text: 'secret tool result' }] } } },
]
fs.writeFileSync(sessionFile, events.map(event => JSON.stringify(event)).join('\n') + '\n')
const nativePath = path.join(import.meta.dirname, '..', 'native', 'jlc.node')
const log = { info: () => {}, warn: (...args) => console.log('[warn]', ...args), debug: () => {}, error: (...args) => console.log('[error]', ...args) }
const vaultRoot = path.join(root, 'local-vault-root')
process.env.DSH_HOME = path.join(root, 'dsh-home')
fs.mkdirSync(path.join(process.env.DSH_HOME, 'night-cruising'), { recursive: true })
fs.writeFileSync(path.join(process.env.DSH_HOME, 'night-cruising', 'timeouts.json'), JSON.stringify({ version: 1, values: { 'vault.keyTtl': 1200, 'vault.approvalTimeout': 500 } }))

function makeCtx({ deviceId }) {
  const services = new Map()
  services.set('deepseekAccount', {
    async getPlatformSession() { return { origin: 'https://example.invalid', token: 'never-used', userId: 'account-1' } },
    async getDeviceIdentity() { return { deviceId, osVersion: os.release() } },
  })
  services.set('sessionQuery', {
    async listSessions() { return [] },
    async readTitleSnapshots(ids) { return ids.map(sessionId => ({ sessionId, status: 'fulfilled', value: { title: { title: 'Vault session' } } })) },
  })
  services.set('sessionPersistence', {
    async stat() {
      const stat = fs.statSync(sessionFile)
      return { sizeBytes: stat.size, location: { kind: 'jsonl', path: sessionFile }, header: { cwd: '/remote/workspace/project' } }
    },
  })
  services.set('sessions', { get() { return undefined }, async flush() {} })
  services.set('workspaceRegistry', { list() { return [{ id: 'ws', title: 'Workspace', path: root }] } })
  return { get: name => services.get(name) }
}

async function makePair(suffix) {
  const codecA = new CodecController({
    config: { codec: 'auto', nativeModulePath: nativePath, siteBaseUrl: 'https://invalid.example' },
    edition: { edition: 'night-cruising', source: 'config' },
    dataDir: path.join(root, `home-a-${suffix}`), here: path.join(import.meta.dirname, '..'), log,
  })
  const codecB = new CodecController({
    config: { codec: 'auto', nativeModulePath: nativePath, siteBaseUrl: 'https://invalid.example' },
    edition: { edition: 'night-cruising', source: 'config' },
    dataDir: path.join(root, `home-b-${suffix}`), here: path.join(import.meta.dirname, '..'), log,
  })
  await codecA.start(); await codecB.start()
  const meshA = new Mesh({
    ctx: makeCtx({ deviceId: 'device-alpha' }),
    config: { discoveryPort: 48801 + suffix, staticPeers: [`127.0.0.1:${48802 + suffix}`], dataDir: path.join(root, `mesh-a-${suffix}`), vaultMode: 'hosted', vaultRoot, vaultEnabled: true, vaultApprovalTimeoutMs: suffix === 2 ? 200 : 60000 },
    log, version: '0.1.0-test', codec: codecA,
  })
  const meshB = new Mesh({
    ctx: makeCtx({ deviceId: 'device-beta' }),
    config: { discoveryPort: 48802 + suffix, staticPeers: [`127.0.0.1:${48801 + suffix}`], dataDir: path.join(root, `mesh-b-${suffix}`), vaultMode: 'hosted', vaultEnabled: true, vaultRelease: 'auto' },
    log, version: '0.1.0-test', codec: codecB,
  })
  return { codecA, codecB, meshA, meshB }
}

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
function containerFiles() {
  const found = []
  const walk = dir => {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name)
      if (fs.statSync(file).isDirectory()) walk(file)
      else if (name.endsWith('.hdr') || name.endsWith('.dat')) found.push(file)
    }
  }
  if (fs.existsSync(vaultRoot)) walk(vaultRoot)
  return found
}

let first
try {
  first = await makePair(1)
  const { meshA, meshB, codecA, codecB } = first
  meshA.start(); meshB.start()
  await waitFor('discovered', () => meshA.peerViews().length > 0)
  meshA.pair('device-beta'); meshB.pair('device-alpha')
  await waitFor('verified', () => meshA.peerViews().some(peer => peer.verified))
  const result = await meshA.fetchSession('device-beta', 'session-vault')
  check('first fetch deposits a hosted container', result.vaultStored === true && result.vaultHit === false, JSON.stringify({ vaultStored: result.vaultStored, vaultHit: result.vaultHit }))
  const files = containerFiles()
  check('first fetch writes NCV2 hdr + dat', files.some(file => file.endsWith('.hdr')) && files.some(file => file.endsWith('.dat')), files.join(','))
  const raw = files.find(file => file.endsWith('.dat'))
  check('vault data has no plaintext', raw && !fs.readFileSync(raw).includes(Buffer.from('secret remote')))
  const state = await meshA.hostedVaultState()
  check('host state reports a peer root', state?.roots?.some(entry => entry.peerId === 'device-beta'), JSON.stringify(state))
  const local = await meshA.hostedVault.openLocal('device-beta', 'session-vault', 'dialog')
  const wrong = await meshA.hostedVault.decrypt(local, crypto.randomBytes(32)).then(() => false, () => true)
  check('wrong key cannot decrypt the container', wrong)
  const ack = await meshB.hostedVault.hostOpen({ peerId: 'device-alpha', depositId: local.header.depositId, gen: local.header.gen, challenge: 'test', archiveSha: local.header.archiveSha, priority: 'dialog' })
  const opened = await meshA.hostedVault.decrypt(local, Buffer.from(ack.key, 'base64url')).then(() => true, () => false)
  check('released key opens the container', opened)
  check('key TTL comes from the bottom-bar timeout store', Number(ack.expiresAt) - Date.now() <= 2000, String(Number(ack.expiresAt) - Date.now()))
  await meshA.stop(); await meshB.stop(); codecA.stop(); codecB.stop()
  await sleep(300)

  // Restart both sides with the same data dirs and vault root.
  first = await makePair(1)
  const secondA = first.meshA
  const secondB = first.meshB
  secondA.start(); secondB.start()
  await waitFor('discovered after restart', () => secondA.peerViews().some(peer => peer.online))
  if (!secondA.peerViews().some(peer => peer.trusted)) secondA.pair('device-beta')
  if (!secondB.peerViews().some(peer => peer.trusted)) secondB.pair('device-alpha')
  await waitFor('verified after restart', () => secondA.peerViews().some(peer => peer.verified))
  const second = await secondA.fetchSession('device-beta', 'session-vault')
  check('restart opens from NCV2 with a vault hit', second.vaultHit === true && second.blocks === 0, JSON.stringify({ vaultHit: second.vaultHit, blocks: second.blocks }))
  check('sidecar projection survives restart', second.items?.length === 4 && second.dialogItems?.length >= 2, JSON.stringify({ items: second.items?.length, dialog: second.dialogItems?.length }))
  const guarded = await meshA.setVaultRoot('device-beta', path.join(root, 'different-root')).then(() => null, error => error.code)
  check('root cannot change while content exists', guarded === 'vault-not-empty', String(guarded))
  const removed = await meshA.deletePeerVault('device-beta')
  check('host can delete remote content', removed.removed >= 1, JSON.stringify(removed))
  const rootAfterDelete = await meshA.setVaultRoot('device-beta', path.join(root, 'different-root'))
  check('root can change after content was deleted', Boolean(rootAfterDelete?.root), JSON.stringify(rootAfterDelete))

  await secondB.revokeVaultPeer('device-alpha')
  const afterRevoke = await secondA.fetchSession('device-beta', 'session-vault')
  check('revoked container falls back to full JLC fetch', afterRevoke.vaultHit === false && afterRevoke.blocks > 0, JSON.stringify({ vaultHit: afterRevoke.vaultHit, blocks: afterRevoke.blocks }))
  await secondA.stop(); await secondB.stop(); first.codecA.stop(); first.codecB.stop()
  await sleep(300)

  // A missing/unwritable default root becomes a timed pending request; after
  // the local user chooses a writable root the next fetch deposits.
  const pendingPair = await makePair(2)
  pendingPair.meshA.config.vaultRoot = '/dev/null/nc-vault'
  pendingPair.meshA.start(); pendingPair.meshB.start()
  await waitFor('pending discovered', () => pendingPair.meshA.peerViews().length > 0)
  pendingPair.meshA.pair('device-beta'); pendingPair.meshB.pair('device-alpha')
  await waitFor('pending peer verified', () => pendingPair.meshA.peerViews().some(peer => peer.verified))
  const pendingFetch = await pendingPair.meshA.fetchSession('device-beta', 'session-vault')
  check('unwritable default root does not fail the read', pendingFetch.items?.length === 4 && pendingFetch.vaultStored === false, JSON.stringify({ items: pendingFetch.items?.length, stored: pendingFetch.vaultStored }))
  const pendingState = await pendingPair.meshA.hostedVaultState()
  check('unwritable root creates a timed directory request', pendingState?.pending?.length >= 1 && pendingState.pending[0].expiresAt > Date.now(), JSON.stringify(pendingState?.pending))
  await sleep(700)
  const expiredState = await pendingPair.meshA.hostedVaultState()
  check('directory request auto-denies after its countdown', expiredState?.pending?.length === 0, JSON.stringify(expiredState?.pending))
  await pendingPair.meshA.setVaultRoot('device-beta', path.join(root, 'manual-root'))
  const pendingRetry = await pendingPair.meshA.fetchSession('device-beta', 'session-vault')
  check('manual root allows the next deposit', pendingRetry.vaultStored === true, JSON.stringify({ stored: pendingRetry.vaultStored }))
  await pendingPair.meshA.stop(); await pendingPair.meshB.stop(); pendingPair.codecA.stop(); pendingPair.codecB.stop()
} catch (error) {
  failures += 1
  console.error('HARNESS ERROR', error)
} finally {
  try { await first?.meshA?.stop(); await first?.meshB?.stop(); first?.codecA?.stop(); first?.codecB?.stop() } catch {}
  console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`)
  process.exit(failures === 0 ? 0 : 1)
}
