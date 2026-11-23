/**
 * Host-half smoke test without a live DSH Host: a fake Cordis context, the
 * real plugin entry, real tool definitions, and the real panel routes.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

const root = path.join(import.meta.dirname, '..', '.tmp', 'apply')
fs.rmSync(root, { recursive: true, force: true })
const workspace = path.join(root, 'workspace')
fs.mkdirSync(workspace, { recursive: true })
fs.writeFileSync(path.join(workspace, 'hello.txt'), 'hello from the workspace\n')

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
      return { session: { id: 'session-1', cwd: workspace }, inheritedEventCount: 0, events: [] }
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
  apply(ctx, { dataDir: path.join(root, 'home'), discoveryPort: 48201, debug: false })
  await new Promise(resolve => setTimeout(resolve, 800))

  check('eight agent tools registered', tools.length === 8, tools.map(tool => tool.name).join(','))
  const expected = ['mesh_status', 'mesh_peers', 'mesh_session_list', 'mesh_session_read', 'mesh_workspace_list', 'mesh_file_read', 'mesh_peer_pair', 'mesh_peer_forget']
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
    setHeader() {},
    end(body) {
      responses.push(body)
    },
  }
  await routes[0].handler({ method: 'GET', url: '/account-mesh/api/state', headers: {} }, res)
  const state = JSON.parse(responses[0])
  await routes[0].handler({ method: 'GET', url: '/account-mesh/api/tree', headers: {} }, res)
  const tree = JSON.parse(responses[responses.length - 1])
  check('tree route answers an empty peer list', Array.isArray(tree.peers) && tree.peers.length === 0, JSON.stringify(tree))
  await routes[0].handler({ method: 'GET', url: '/account-mesh/api/transcript?peer=x&sessionId=y', headers: {} }, res)
  const transcriptFailure = JSON.parse(responses[responses.length - 1])
  check('transcript route refuses an unknown peer', typeof transcriptFailure.error === 'string', JSON.stringify(transcriptFailure))
  check('state route answers JSON', state.status === 'ready' && state.device.id)
  check('state route never leaks the account id or token', !responses[0].includes('account-1') && !responses[0].includes('never-used-token'))
  console.log('payload keys:', Object.keys(state).join(','))
} catch (error) {
  failures += 1
  console.error('SMOKE ERROR', error)
} finally {
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
