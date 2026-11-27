/**
 * Two-instance integration harness: fake DSH services, real discovery,
 * signing, WebRTC transport, Ed25519 hello, and read-only RPC.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Mesh } from '../src/mesh.js'
import { registerRoutes } from '../src/routes.js'

const root = path.join(import.meta.dirname, '..', '.tmp')
fs.rmSync(root, { recursive: true, force: true })
const workspaceA = path.join(root, 'ws-a')
const workspaceB = path.join(root, 'ws-b')
fs.mkdirSync(workspaceA, { recursive: true })
fs.mkdirSync(workspaceB, { recursive: true })
fs.writeFileSync(path.join(workspaceB, 'notes.txt'), ['line one', 'line two', 'line three', 'line four'].join('\n'))
fs.writeFileSync(path.join(workspaceB, 'secret-in-root.txt'), 'not reachable from outside')
fs.writeFileSync(path.join(workspaceA, 'notes-a.txt'), 'belongs to the other workspace')

const events = [
  { type: 'user/message', seq: 1, time: 1000, data: { content: [{ type: 'text', text: 'remote question' }] } },
  {
    type: 'assistant/message',
    seq: 2,
    time: 2000,
    data: { message: { content: [{ type: 'text', text: 'remote answer' }, { type: 'tool-call', name: 'read', arguments: '{"path":"notes.txt"}' }] } },
  },
  { type: 'tool/call', seq: 3, time: 3000, data: { name: 'read', arguments: '{"path":"notes.txt"}' } },
  { type: 'tool/result', seq: 4, time: 4000, data: { message: { content: [{ type: 'text', text: 'line one\nline two' }] } } },
]

function makeCtx({ workspace, deviceId }) {
  const services = new Map()
  services.set('deepseekAccount', {
    async getPlatformSession() {
      return { origin: 'https://example.invalid', token: 'never-used-token', userId: 'account-1' }
    },
    async getDeviceIdentity() {
      return { deviceId, osVersion: os.release() }
    },
  })
  services.set('sessionQuery', {
    async listSessions() {
      return [{ header: { id: 'session-remote', createdAt: 1000, cwd: workspace }, live: true, persisted: true }]
    },
    async readTitleSnapshots(ids) {
      return ids.map(sessionId => ({ sessionId, status: 'fulfilled', value: { title: { title: 'Remote session' } } }))
    },
    async readSession() {
      return { session: { id: 'session-remote', cwd: workspace, createdAt: 1000 }, inheritedEventCount: 0, events }
    },
  })
  services.set('workspaceRegistry', {
    list() {
      return [{ id: 'ws', title: 'Workspace', path: workspace }]
    },
  })
  return { get: name => services.get(name) }
}

const log = {
  info: (...args) => console.log('[mesh]', ...args),
  warn: (...args) => console.log('[mesh:warn]', ...args),
  debug: () => {},
  error: (...args) => console.log('[mesh:error]', ...args),
}

const meshA = new Mesh({
  ctx: makeCtx({ workspace: workspaceA, deviceId: 'device-alpha' }),
  config: { discoveryPort: 48101, staticPeers: ['127.0.0.1:48102'], dataDir: path.join(root, 'home-a') },
  log,
  version: '0.1.0-test',
})
const meshB = new Mesh({
  ctx: makeCtx({ workspace: workspaceB, deviceId: 'device-beta' }),
  config: { discoveryPort: 48102, staticPeers: ['127.0.0.1:48101'], dataDir: path.join(root, 'home-b') },
  log,
  version: '0.1.0-test',
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
function check(label, condition, detail) {
  if (condition) console.log(`PASS ${label}`)
  else {
    failures += 1
    console.log(`FAIL ${label}`, detail ?? '')
  }
}

try {
  meshA.start()
  meshB.start()
  await waitFor('discovery', () => meshA.peerViews().some(peer => peer.deviceId === 'device-beta'))
  check('discovery finds the same-account peer', meshA.peerViews().some(peer => peer.deviceId === 'device-beta'))
  // A first contact waits for the user's explicit answer instead of being trusted
  // silently by the account rule.
  check('first contact queues a pending trust request',
    meshA.state().pendingTrust.some(request => request.deviceId === 'device-beta'),
    JSON.stringify(meshA.state().pendingTrust))
  check('pending peer is not trusted yet', meshA.peerViews().every(peer => !peer.trusted))
  meshA.pair('device-beta')
  meshB.pair('device-alpha')
  check('explicit trust clears the pending request', meshA.state().pendingTrust.length === 0)
  check('peer is trusted after the explicit answer', meshA.peerViews().every(peer => peer.trusted))

  await waitFor('verified link', () => meshA.peerViews().some(peer => peer.verified))
  check('Ed25519 hello verifies both sides', meshA.peerViews().some(peer => peer.verified))

  const list = await meshA.call('device-beta', 'sessions/list', {})
  check('sessions/list returns the remote session', list?.sessions?.[0]?.id === 'session-remote', JSON.stringify(list))

  const transcript = await meshA.call('device-beta', 'sessions/events', { sessionId: 'session-remote', limit: 10 })
  check('sessions/events projects four items', transcript?.items?.length === 4, JSON.stringify(transcript))
  check('assistant text and tool call survive projection', transcript.items[1].text === 'remote answer' && transcript.items[1].toolCalls?.[0] === 'read')

  check('sessions/events reports the session total bytes', transcript.totalBytes === transcript.items.reduce((sum, item) => sum + Buffer.byteLength(item.text ?? '', 'utf8') + Buffer.byteLength(item.reasoning ?? '', 'utf8'), 0) && transcript.itemCount === 4, JSON.stringify({ totalBytes: transcript.totalBytes, itemCount: transcript.itemCount }))

  const paged = await meshA.call('device-beta', 'sessions/events', { sessionId: 'session-remote', fromSeq: 3, limit: 10 })
  check('sessions/events pages by seq', paged.items.length === 2 && paged.nextSeq === 5, JSON.stringify(paged))

  const index = await meshA.call('device-beta', 'sessions/index', { sessionId: 'session-remote' })
  check('sessions/index sizes every item and totals the session',
    index?.items?.length === 4 && index.totalItems === 4 && index.items.filter(item => item.role !== 'tool-call').every(item => item.bytes > 0),
    JSON.stringify(index))
  check('sessions/index carries no reasoning or tool arguments', !JSON.stringify(index.items).includes('notes.txt'))

  const transfer = meshA.transferTotals()
  check('transfer counters follow completed calls', transfer.calls >= 4 && transfer.receivedBytes > 0 && transfer.sentBytes > 0, JSON.stringify(transfer))
  check('peer views expose per-peer transfer counters', meshA.peerViews().find(peer => peer.deviceId === 'device-beta')?.transfer?.calls >= 4, JSON.stringify(meshA.peerViews()))
  check('hello exchange reveals the peer plugin version', meshA.peerViews().find(peer => peer.deviceId === 'device-beta')?.version === '0.1.0-test'
    && meshB.peerViews().find(peer => peer.deviceId === 'device-alpha')?.version === '0.1.0-test', JSON.stringify(meshA.peerViews()))

  const file = await meshA.call('device-beta', 'files/read', { path: 'notes.txt', offset: 1, limit: 2 })
  check('files/read reads a line window in the allowed root', file?.lines?.join('|') === 'line two|line three', JSON.stringify(file))
  check('files/read reports hasMore', file?.hasMore === true)

  const outside = await meshA.call('device-beta', 'files/read', { path: '/etc/hosts' }).then(() => null, error => error)
  check('absolute path outside the roots is refused', outside?.code === 'path-outside', outside?.code)
  const escape = await meshA.call('device-beta', 'files/read', { path: '../ws-a/notes-a.txt' }).then(() => null, error => error)
  check('relative escape out of the root is refused', escape?.code === 'path-outside', escape?.code)

  const unknown = await meshA.call('device-beta', 'sessions/delete', {}).then(() => null, error => error)
  check('unknown write op is refused', unknown?.code === 'bad-request', unknown?.code)

  const workspaces = await meshA.call('device-beta', 'workspaces/list', {})
  check('workspaces/list returns the remote workspace', workspaces?.workspaces?.[0]?.path === fs.realpathSync(workspaceB))

  const idle = Number(process.env.IDLE_MS ?? 0)
  if (idle > 0) {
    console.log(`idling ${idle} ms across every periodic timer boundary`)
    await sleep(idle)
    const live = await meshA.call('device-beta', 'files/stat', { path: 'notes.txt' })
    check('link still healthy after the timer windows', live?.type === 'file', JSON.stringify(live))
    check('discovery still announces', meshA.peerViews().some(peer => peer.verified))
  }

  // Panel HTTP layer: same routes the browser calls, driven against the real mesh.
  const routes = []
  const routeCtx = {
    get(name) {
      if (name === 'webServer') return { register(route) { routes.push(route); return () => {} } }
      if (name === 'connection') return { requestRejection: () => undefined }
      return undefined
    },
  }
  registerRoutes(routeCtx, meshA, log)
  const call = async url => {
    const bodies = []
    const res = { headersSent: false, setHeader() {}, end(body) { bodies.push(body) } }
    await routes[0].handler({ method: 'GET', url, headers: {} }, res)
    return JSON.parse(bodies[0])
  }
  const tree = await call('/account-mesh/api/tree')
  const node = tree.peers?.[0]
  check('tree lists the verified peer', tree.peers?.length === 1, JSON.stringify(tree))
  check('tree groups the remote workspace', node?.workspaces?.[0]?.path === fs.realpathSync(workspaceB), JSON.stringify(node?.workspaces))
  check('tree nests the session under its workspace', node?.workspaces?.[0]?.sessions?.[0]?.id === 'session-remote', JSON.stringify(node?.workspaces?.[0]?.sessions))
  const remoteTranscript = await call('/account-mesh/api/transcript?peer=device-beta&sessionId=session-remote&limit=10')
  check('transcript route returns the remote events', remoteTranscript?.items?.length === 4, JSON.stringify(remoteTranscript))
  check('transcript route redacts nothing it should not have', remoteTranscript?.session?.id === 'session-remote')

  const state = meshA.state()
  check('state hides the account id', !JSON.stringify(state).includes('account-1'))
  check('state lists the peer as verified', state.peers.some(peer => peer.verified && peer.online))

  // Revocation is durable: no announce, heartbeat, or reconnect may re-trust it.
  meshA.forget('device-beta')
  check('revoked peer is not trusted', meshA.peerViews().every(peer => !peer.trusted))
  check('revoked peer is reported as revoked', meshA.peerViews().some(peer => peer.revoked === true))
  check('revoked entry stays in the store', meshA.trust.get('device-beta')?.revoked === true)
  await sleep(7000)
  check('heartbeats do not re-trust a revoked peer', meshA.peerViews().every(peer => !peer.trusted))
  check('revoked peer queues no trust request', meshA.state().pendingTrust.length === 0)
  const refused = await meshA.call('device-beta', 'sessions/list', {}).then(() => null, error => error)
  check('reads stay refused after revocation', refused?.code === 'not-paired', refused?.code)
  const reloaded = new Mesh({
    ctx: makeCtx({ workspace: workspaceA, deviceId: 'device-alpha' }),
    config: { discoveryPort: 48101, staticPeers: ['127.0.0.1:48102'], dataDir: path.join(root, 'home-a') },
    log,
    version: '0.1.0-test',
  })
  check('revocation survives a restart', reloaded.trust.get('device-beta')?.revoked === true)
  meshA.pair('device-beta')
  check('explicit trust clears the revocation', meshA.trust.isTrusted('device-beta'))

  // The peer keeps its own trust entry until it learns about the revocation;
  // the signed revoke notice makes both sides converge without touching the
  // remote instance's settings.
  meshA.pair('device-beta')
  meshB.pair('device-alpha')
  await waitFor('link after re-trust', () => meshA.peerViews().some(peer => peer.verified))
  meshA.forget('device-beta')
  await waitFor('peer revoked us', () => meshB.trust.get('device-alpha')?.revoked === true)
  check('revoke notice revokes the peer side too', meshB.trust.get('device-alpha')?.revoked === true)
  check('peer side reports the revocation in its views', meshB.peerViews().some(peer => peer.deviceId === 'device-alpha' && peer.revoked === true))
  const refusedByPeer = await meshB.call('device-alpha', 'sessions/list', {}).then(() => null, error => error)
  check('peer side refuses reads after the notice', refusedByPeer?.code === 'not-paired', refusedByPeer?.code)
} catch (error) {
  failures += 1
  console.error('HARNESS ERROR', error)
} finally {
  await meshA.stop()
  await meshB.stop()
  await sleep(300)
  console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`)
  process.exit(failures === 0 ? 0 : 1)
}
