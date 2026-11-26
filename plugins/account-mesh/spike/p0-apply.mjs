/**
 * Host-half smoke test without a live DSH Host: a fake Cordis context, the
 * real plugin entry, real tool definitions, and the real panel routes.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'
import { registerRoutes } from '../src/routes.js'
import { detectDistribution } from '../src/distribution.js'

const root = path.join(import.meta.dirname, '..', '.tmp', 'apply')
fs.rmSync(root, { recursive: true, force: true })
const workspace = path.join(root, 'workspace')
fs.mkdirSync(workspace, { recursive: true })
fs.writeFileSync(path.join(workspace, 'hello.txt'), 'hello from the workspace\n')

// The Host fetches the site configuration through the same-origin route, so the
// smoke test mocks fetch instead of touching the network. `fail` mode exercises
// the stale-links fallback.
const realFetch = globalThis.fetch
let fetchMode = 'ok'
globalThis.fetch = async () => {
  if (fetchMode === 'fail') throw Object.assign(new Error('offline'), { code: 'ENETUNREACH' })
  return {
    ok: true,
    status: 200,
    headers: { get: name => String(name).toLowerCase() === 'etag' ? '"smoke-etag"' : null },
    async text() {
      return JSON.stringify({
        format: 1,
        updatedAt: '2026-11-26T00:00:00Z',
        dsh: { download: { label: ' 下载夜间巡航版 ', url: '/downloads.html', hint: ' 夜间巡航版可在本地到远端启用 JLC 巡航加速。 ' } },
        nightCruising: { featured: { label: '插件精选', url: '/plugins.html', hint: '发现更多为夜间巡航优化的插件。' } },
      })
    },
  }
}

const tools = []
const routes = []
const effects = []
const services = new Map([
  ['deepseekAccount', {
    async getPlatformSession() {
      return { origin: 'https://example.invalid', token: 'never-used-token', userId: 'account-1' }
    },
    async getDeviceIdentity() {
      return { deviceId: 'device-smoke', osVersion: os.release() }
    },
  }],
  ['sessionQuery', {
    async listSessions() {
      return [{ header: { id: 'session-1', createdAt: 1, cwd: workspace }, live: false, persisted: true }]
    },
    async readTitleSnapshots(ids) {
      return ids.map(sessionId => ({ sessionId, status: 'fulfilled', value: { title: { title: 'Smoke title' } } }))
    },
    async readSession() {
      return {
        session: { id: 'session-1', cwd: workspace },
        inheritedEventCount: 0,
        events: [
          { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: 'hello' }] } },
          { type: 'assistant/message', seq: 2, time: 2, data: { message: { content: [{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'answer' }] } } },
          { type: 'tool/result', seq: 3, time: 3, data: { error: { name: 'AbortError', code: 'ABORTED' }, message: { content: [{ type: 'text', text: 'failed' }] } } },
        ],
      }
    },
  }],
  ['workspaceRegistry', { list: () => [{ id: 'w', title: 'W', path: workspace }] }],
])

const ctx = {
  logger: { info() {}, warn() {}, debug() {}, error() {} },
  effect(fn) {
    const disposer = fn()
    effects.push(disposer)
    return () => {
      if (typeof disposer === 'function') disposer()
    }
  },
  inject(deps, callback) {
    if (deps.every(dep => ctx.get(dep) !== undefined)) callback(ctx)
  },
  get(name) {
    if (services.has(name)) return services.get(name)
    if (name === 'tools') {
      return {
        register(definition) {
          tools.push(definition)
          return () => {}
        },
      }
    }
    if (name === 'webServer') {
      return {
        register(route) {
          routes.push(route)
          return () => {}
        },
      }
    }
    if (name === 'connection') return { requestRejection: () => undefined }
    return undefined
  },
}

let failures = 0
const check = (label, condition, detail) => {
  if (condition) console.log(`PASS ${label}`)
  else {
    failures += 1
    console.log(`FAIL ${label}`, detail ?? '')
  }
}

try {
  apply(ctx, { dataDir: path.join(root, 'home'), discoveryPort: 48201, debug: false, localSessionTest: true, distribution: 'dsh' })
  await new Promise(resolve => setTimeout(resolve, 800))

  check('edition detection honours config override', detectDistribution({ config: { distribution: 'night-cruising' }, env: {} }).edition === 'night-cruising')
  check('edition detection honours DSH_DISTRIBUTION', detectDistribution({ config: {}, env: { DSH_DISTRIBUTION: 'night-cruising' }, execPath: '/x', resourcesPath: '/y' }).edition === 'night-cruising')
  check('edition detection recognises the executable path', detectDistribution({ config: {}, env: {}, execPath: '/opt/night-cruising', resourcesPath: '/y' }).edition === 'night-cruising')
  check('edition detection defaults to standard DSH', detectDistribution({ config: {}, env: {}, execPath: '/opt/dsh', resourcesPath: '/y' }).edition === 'dsh')
  check('eleven agent tools registered', tools.length === 11, tools.map(tool => tool.name).join(','))
  const expected = ['mesh_status', 'mesh_peers', 'mesh_session_list', 'mesh_session_read', 'mesh_session_index', 'mesh_session_fetch', 'mesh_session_summary', 'mesh_workspace_list', 'mesh_file_read', 'mesh_peer_pair', 'mesh_peer_forget']
  check('tool names are the documented ones', expected.every(name => tools.some(tool => tool.name === name)))
  check('every tool declares object parameters', tools.every(tool => tool.parameters?.type === 'object' && typeof tool.parameters.properties === 'object'))
  check('every tool declares an output schema and render', tools.every(tool => tool.output?.schema?.type === 'object' && typeof tool.output.render === 'function'))

  const status = tools.find(tool => tool.name === 'mesh_status')
  const value = await status.execute({}, { signal: new AbortController().signal })
  check('mesh_status reports the signed-in account', value.status === 'ready', JSON.stringify(value))
  check('mesh_status includes the device fingerprint', typeof value.device.fingerprint === 'string' && value.device.fingerprint.length > 8)
  check('mesh_status lists no peers while alone', value.peers.length === 0)

  const peers = await tools.find(tool => tool.name === 'mesh_peers').execute({}, {})
  check('mesh_peers returns the peer array', Array.isArray(peers.peers))
  check('mesh_peers reports transfer totals', peers.transfer?.calls === 0 && peers.transfer?.receivedBytes === 0, JSON.stringify(peers.transfer))

  const lossless = value => {
    if (value === undefined) return false
    if (value === null || typeof value !== 'object') return typeof value !== 'function'
    return Array.isArray(value) ? value.every(lossless) : Object.values(value).every(lossless)
  }
  check('mesh_status output is lossless JSON', lossless(value), JSON.stringify(value))
  check('mesh_peers output is lossless JSON', lossless(peers), JSON.stringify(peers))

  const list = await tools.find(tool => tool.name === 'mesh_session_list').execute({ peer: 'nobody' }, {}).then(() => null, error => error)
  check('unknown peer is refused by the tool', /no peer|offline|unknown/i.test(list?.message ?? ''), list?.message)

  check('panel routes registered', routes.length === 1 && routes[0].path === '/account-mesh')
  const responses = []
  const res = {
    headersSent: false,
    statusCode: 0,
    setHeader() {},
    end(body) {
      responses.push(body)
    },
  }
  /** A JSON POST body for the routes that read one. */
  const postJson = payload => ({
    method: 'POST',
    url: '/account-mesh/api/codec',
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(payload))
    },
  })
  await routes[0].handler({ method: 'GET', url: '/account-mesh/api/state', headers: {} }, res)
  const state = JSON.parse(responses[0])
  const transfer = state.transfer
  check('state reports the transfer edition', transfer?.edition === 'dsh' && transfer.editionSource === 'config', JSON.stringify(transfer))
  check('native DSH stays on JSONL', transfer?.mode === 'jsonl' && transfer.active === false && transfer.available === false, JSON.stringify(transfer))
  check('native DSH refuses the JLC codec', transfer?.desired === 'off' && transfer.pendingRestart === false && transfer.reason === 'edition-requires-night-cruising', JSON.stringify(transfer))
  check('native DSH exposes the download link from the site config',
    transfer?.links?.download?.url === 'https://deepseek-harness.partyplay.top/downloads.html' &&
      transfer.links.download.label === '下载夜间巡航版' &&
      transfer.links.download.hint === '夜间巡航版可在本地到远端启用 JLC 巡航加速。' &&
      transfer.links.featured === null,
    JSON.stringify(transfer?.links))
  check('site links are cached as ok', transfer?.linksStatus === 'ok' && typeof transfer.linksFetchedAt === 'number', JSON.stringify({ status: transfer?.linksStatus, at: transfer?.linksFetchedAt }))
  await routes[0].handler(postJson({ enabled: true }), res)
  const codecRejected = JSON.parse(responses[responses.length - 1])
  check('native DSH rejects enabling JLC with 409', res.statusCode === 409 && codecRejected.code === 'edition-requires-night-cruising', `${res.statusCode} ${JSON.stringify(codecRejected)}`)
  await routes[0].handler({ method: 'GET', url: '/account-mesh/api/site-links', headers: {} }, res)
  const linksBody = JSON.parse(responses[responses.length - 1])
  check('site-links route serves the cached download link', linksBody.links?.download?.url === 'https://deepseek-harness.partyplay.top/downloads.html' && linksBody.linksStatus === 'ok', JSON.stringify(linksBody))
  fetchMode = 'fail'
  await routes[0].handler({ method: 'GET', url: '/account-mesh/api/site-links?force=1', headers: {} }, res)
  const staleLinks = JSON.parse(responses[responses.length - 1])
  check('site-links keeps the last good links when the refresh fails', staleLinks.linksStatus === 'stale' && staleLinks.links?.download?.url === 'https://deepseek-harness.partyplay.top/downloads.html', JSON.stringify(staleLinks))
  fetchMode = 'ok'
  await routes[0].handler({ method: 'GET', url: '/account-mesh/api/tree', headers: {} }, res)
  const tree = JSON.parse(responses[responses.length - 1])
  check('tree route includes the local-test peer', tree.peers.some(peer => peer.deviceId === 'local-test'), JSON.stringify(tree))
  await routes[0].handler({ method: 'GET', url: '/account-mesh/api/transcript?peer=x&sessionId=y', headers: {} }, res)
  const transcriptFailure = JSON.parse(responses[responses.length - 1])
  check('transcript route refuses an unknown peer', typeof transcriptFailure.error === 'string', JSON.stringify(transcriptFailure))
  await routes[0].handler({ method: 'GET', url: '/account-mesh/api/transcript?peer=local-test&sessionId=session-1', headers: {} }, res)
  const localTranscript = JSON.parse(responses[responses.length - 1])
  check('local transcript route serves reasoning and errors',
    localTranscript.items?.length === 3 && localTranscript.items[1].reasoning === 'think' && localTranscript.items[2].isError === true,
    JSON.stringify(localTranscript))
  check('state route answers JSON', state.status === 'ready' && state.device.id)
  check('state reports the local test peer as enabled and visible', state.localTest?.enabled === true && state.localTest?.visible === true && state.localTest?.hiddenByRealPeer === false, JSON.stringify(state.localTest))
  check('state route never leaks the account id or token', !responses[0].includes('account-1') && !responses[0].includes('never-used-token'))

  // Session index: compact per-item sizes plus the session total, cached unless forced.
  await routes[0].handler({ method: 'GET', url: '/account-mesh/api/sessions/index?peer=local-test&sessionId=session-1', headers: {} }, res)
  const index = JSON.parse(responses[responses.length - 1])
  check('session index lists every projected item with a byte size',
    index.items?.length === 3 && index.items.filter(item => item.role !== 'tool-call').every(item => item.bytes > 0) && index.totalBytes === index.items.reduce((sum, item) => sum + item.bytes, 0),
    JSON.stringify(index))
  check('session index drops reasoning bodies and tool arguments', !JSON.stringify(index.items).includes('think'))
  check('session index reports its transfer size', typeof index.bytes === 'number' && index.bytes > 0 && index.cached === false)
  await routes[0].handler({ method: 'GET', url: '/account-mesh/api/sessions/index?peer=local-test&sessionId=session-1', headers: {} }, res)
  const indexHit = JSON.parse(responses[responses.length - 1])
  check('session index is served from the cache on a non-forced read', indexHit.cached === true && indexHit.totalBytes === index.totalBytes)
  await routes[0].handler({ method: 'GET', url: '/account-mesh/api/sessions/index?peer=local-test&sessionId=session-1&force=1', headers: {} }, res)
  const indexForced = JSON.parse(responses[responses.length - 1])
  check('force=1 bypasses the session index cache', indexForced.cached === false)

  // Transcript pages carry the session total and are cached unless forced.
  await routes[0].handler({ method: 'POST', url: '/account-mesh/api/cache/clear', headers: {} }, res)
  await routes[0].handler({ method: 'GET', url: '/account-mesh/api/transcript?peer=local-test&sessionId=session-1&limit=200', headers: {} }, res)
  const firstPage = JSON.parse(responses[responses.length - 1])
  check('transcript reports the session total bytes and item count', firstPage.totalBytes > 0 && firstPage.itemCount === 3, JSON.stringify({ totalBytes: firstPage.totalBytes, itemCount: firstPage.itemCount }))
  check('transcript reports its own transfer size', typeof firstPage.bytes === 'number' && firstPage.bytes > 0 && firstPage.cached === false)
  await routes[0].handler({ method: 'GET', url: '/account-mesh/api/transcript?peer=local-test&sessionId=session-1&limit=200', headers: {} }, res)
  const cachedPage = JSON.parse(responses[responses.length - 1])
  check('transcript page is served from the cache on a non-forced read', cachedPage.cached === true && cachedPage.items?.length === 3)
  await routes[0].handler({ method: 'GET', url: '/account-mesh/api/transcript?peer=local-test&sessionId=session-1&limit=200&force=1', headers: {} }, res)
  const forcedPage = JSON.parse(responses[responses.length - 1])
  check('force=1 bypasses the transcript cache', forcedPage.cached === false)
  console.log('payload keys:', Object.keys(state).join(','))

  // A real verified peer hides the local test peer from the tree and transcript.
  const fakeMesh = {
    config: { localSessionTest: true },
    peerViews: () => [{ deviceId: 'real-peer-0001', name: 'real-peer', online: true, verified: true, trusted: true }],
    data: { listWorkspaces: () => ({ workspaces: [] }), listSessions: () => ({ sessions: [] }), sessionEvents: () => ({ items: [] }), runOp: () => ({ items: [] }) },
    call: async () => ({ workspaces: [], sessions: [] }),
  }
  const fakeRoutes = []
  registerRoutes({ get: name => name === 'webServer' ? { register(route) { fakeRoutes.push(route); return () => {} } } : name === 'connection' ? { requestRejection: () => undefined } : undefined }, fakeMesh, ctx.logger)
  const fakeResponses = []
  const fakeRes = { headersSent: false, setHeader() {}, end(body) { fakeResponses.push(body) } }
  await fakeRoutes[0].handler({ method: 'GET', url: '/account-mesh/api/tree', headers: {} }, fakeRes)
  const hiddenTree = JSON.parse(fakeResponses[fakeResponses.length - 1])
  check('real peer hides the local-test node', !hiddenTree.peers.some(peer => peer.deviceId === 'local-test'), JSON.stringify(hiddenTree))
  await fakeRoutes[0].handler({ method: 'GET', url: '/account-mesh/api/transcript?peer=local-test&sessionId=session-1', headers: {} }, fakeRes)
  const hiddenTranscript = JSON.parse(fakeResponses[fakeResponses.length - 1])
  check('real peer hides the local-test transcript', hiddenTranscript.error?.includes('hidden'), JSON.stringify(hiddenTranscript))

  // Night Cruising: the same plugin entry, a different edition. No native module
  // is reachable in this checkout, so start reports native-module-missing; enabling
  // JLC only persists the intent and asks for a restart, never a hot load.
  const nightHome = path.join(root, 'night-home')
  const nightRoutesBefore = routes.length
  apply(ctx, {
    dataDir: nightHome,
    discoveryPort: 48202,
    debug: false,
    localSessionTest: false,
    distribution: 'night-cruising',
    nativeModulePath: path.join(root, 'missing-jlc.node'),
  })
  await new Promise(resolve => setTimeout(resolve, 800))
  const nightRoute = routes[nightRoutesBefore]
  await nightRoute.handler({ method: 'GET', url: '/account-mesh/api/state', headers: {} }, res)
  const nightState = JSON.parse(responses[responses.length - 1])
  const nightTransfer = nightState.transfer
  check('night cruising edition comes from config', nightTransfer?.edition === 'night-cruising' && nightTransfer.editionSource === 'config', JSON.stringify(nightTransfer))
  check('night cruising without a native module reports it',
    nightTransfer?.available === false && nightTransfer?.active === false && nightTransfer?.mode === 'jsonl' && nightTransfer?.reason === 'native-module-missing',
    JSON.stringify(nightTransfer))
  check('night cruising defaults to the enabled intent', nightTransfer?.desired === 'on' && nightTransfer?.pendingRestart === false, JSON.stringify(nightTransfer))
  check('night cruising exposes the featured link and hides the download link',
    nightTransfer?.links?.featured?.url === 'https://deepseek-harness.partyplay.top/plugins.html' && nightTransfer.links.download === null,
    JSON.stringify(nightTransfer?.links))
  await nightRoute.handler(postJson({ enabled: true }), res)
  const nightEnabled = JSON.parse(responses[responses.length - 1])
  check('night cruising accepts enabling JLC without a 409', res.statusCode === 200 && nightEnabled.ok === true, `${res.statusCode} ${JSON.stringify(nightEnabled)}`)
  check('enabling JLC asks for a restart instead of hot-loading',
    nightEnabled.transfer?.pendingRestart === true && nightEnabled.transfer?.reason === 'restart-required' && nightEnabled.transfer?.active === false && nightEnabled.transfer?.mode === 'jsonl',
    JSON.stringify(nightEnabled.transfer))
  check('enabling JLC persists the intent', JSON.parse(fs.readFileSync(path.join(nightHome, 'settings.json'), 'utf8')).codec === 'auto')
  await nightRoute.handler(postJson({ enabled: false }), res)
  const nightDisabled = JSON.parse(responses[responses.length - 1])
  check('disabling JLC clears the restart flag',
    res.statusCode === 200 && nightDisabled.transfer?.desired === 'off' && nightDisabled.transfer?.pendingRestart === false && nightDisabled.transfer?.active === false && nightDisabled.transfer?.reason === 'disabled',
    JSON.stringify(nightDisabled.transfer))
} catch (error) {
  failures += 1
  console.error('SMOKE ERROR', error)
} finally {
  globalThis.fetch = realFetch
  for (const disposer of effects) {
    if (typeof disposer === 'function') {
      try {
        disposer()
      } catch {
        // ignore
      }
    }
  }
  await new Promise(resolve => setTimeout(resolve, 200))
  console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`)
  process.exit(failures === 0 ? 0 : 1)
}
