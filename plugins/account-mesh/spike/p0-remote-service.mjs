/**
 * Standalone simulated remote peer for dsh-account-mesh.
 *
 * Runs a real `Mesh` instance in its own Node process with fake Host services
 * (`deepseekAccount`, `sessionQuery`, `workspaceRegistry`) backed by **real
 * sessions from this DSH home**. It announces under the live DSH instance's
 * account tag, so the live plugin discovers it and queues a first-contact trust
 * request. The live user answers that request once (the blocking dialog, or
 * `mesh_peer_pair`); after that the Ed25519 hello completes over a WebRTC data
 * channel and the simulated peer serves the read-only data plane to the live
 * agent's `mesh_*` tools and the remote-workspace panel.
 *
 * Sessions are read from `$DSH_HOME/sessions/<workspace>/<session>/session.v4.jsonl.zstd`
 * and decompressed with Node's zstd support. `readSession` re-reads the file on
 * every call, so the live conversation's newest events are served.
 *
 * Usage:
 *   node spike/p0-remote-service.mjs
 *   SIM_SESSION_ID=74b8bfdc SIM_ACCOUNT_TAG=tjbZ-... node spike/p0-remote-service.mjs
 *
 * Account tag: defaults to the first peer's `accountTag` in
 * `$DSH_HOME/account-mesh/peers.json`, which the live plugin writes when it
 * trusts a peer. Set `SIM_ACCOUNT_TAG` when that file is empty.
 *
 * Env:
 *   SIM_ACCOUNT_TAG     account tag the live plugin announces (required unless peers.json has one)
 *   SIM_SESSION_ID      session id fragment to serve (default: sessions whose cwd is the current directory)
 *   SIM_SESSION_CWD     workspace path used to pick sessions when SIM_SESSION_ID is unset (default: cwd)
 *   SIM_DISCOVERY_PORT  this simulated peer's UDP discovery port (default 47832)
 *   SIM_PEER_PORT       live DSH discovery port to query (default 47831)
 *   SIM_HTTP_PORT       status HTTP port (default 47833; 0 picks a free port)
 *   SIM_DEVICE_ID       simulated device id (default sim-remote-workspace-0001)
 *   SIM_NAME            simulated device display name (default sim-remote-workspace)
 *   SIM_DATA_DIR        identity/trust/log dir (default .tmp/sim-remote/home)
 *   SIM_DEBUG           "0" hides debug lines on stdout (file log still records them)
 *
 * HTTP endpoints:
 *   GET /health    liveness
 *   GET /status    mesh state + peer views
 *   GET /workspace real workspace directory listing
 *   GET /sessions  real session summaries
 *
 * Stop with Ctrl-C / SIGTERM; the process tears down the mesh and the HTTP
 * server. After stopping it, forget the simulated peer on the live instance
 * (`mesh_peer_forget`) so the real trust table is not left with a dead entry.
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { Mesh } from '../src/mesh.js'
import { createLog } from '../src/log.js'

const here = import.meta.dirname
const root = path.join(here, '..', '.tmp', 'sim-remote')
const outside = path.join(root, 'outside')
const dataDir = process.env.SIM_DATA_DIR ? path.resolve(process.env.SIM_DATA_DIR) : path.join(root, 'home')
const discoveryPort = Number(process.env.SIM_DISCOVERY_PORT ?? 47832)
const peerPort = Number(process.env.SIM_PEER_PORT ?? 47831)
const httpPort = Number(process.env.SIM_HTTP_PORT ?? 47833)
const deviceId = process.env.SIM_DEVICE_ID ?? 'sim-remote-workspace-0001'
const peerName = process.env.SIM_NAME ?? 'sim-remote-workspace'
const version = '0.1.0-sim'
const debugConsole = process.env.SIM_DEBUG !== '0'

if (process.argv.includes('--help')) {
  console.log('Simulated remote peer for dsh-account-mesh. See the header of spike/p0-remote-service.mjs for env vars.')
  process.exit(0)
}

/** Account tag the live plugin uses, from its trust table or the environment. */
function accountTagFromState() {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  try {
    const file = path.join(dshHome, 'account-mesh', 'peers.json')
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    // Revoked entries keep their account tag too, so a revoked peer still
    // resolves the tag the live instance announces.
    return data?.peers?.find(peer => typeof peer?.accountTag === 'string')?.accountTag
  } catch {
    return undefined
  }
}

const accountTag = process.env.SIM_ACCOUNT_TAG || accountTagFromState()
if (!accountTag) {
  console.error('No account tag found. Set SIM_ACCOUNT_TAG to the live instance\'s account tag')
  console.error('(the full value is in $DSH_HOME/account-mesh/peers.json under peers[].accountTag).')
  process.exit(2)
}

// ---------------------------------------------------------------------------
// Real sessions from this DSH home
// ---------------------------------------------------------------------------

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const sessionsRoot = path.join(dshHome, 'sessions')
const sessionFilter = process.env.SIM_SESSION_ID
const sessionCwd = process.env.SIM_SESSION_CWD ? path.resolve(process.env.SIM_SESSION_CWD) : process.cwd()

/** Decompress one session.v4.jsonl.zstd file into its header, title and events. */
function parseSessionFile(file) {
  const lines = zstdDecompressSync(fs.readFileSync(file)).toString('utf8').split('\n').filter(Boolean)
  const header = JSON.parse(lines[0])
  if (header?.type !== 'session' || typeof header.id !== 'string') throw new Error(`not a session file: ${file}`)
  const events = []
  for (const line of lines.slice(1)) {
    try {
      const event = JSON.parse(line)
      if (typeof event.seq === 'number') events.push(event)
    } catch {
      // ignore malformed lines
    }
  }
  const titleEvent = events.find(event => event.type === 'session/title')
  return {
    header: { id: header.id, createdAt: header.createdAt ?? 0, cwd: header.cwd ?? sessionCwd },
    title: titleEvent?.data?.title ?? header.id,
    events,
  }
}

/** Find real sessions for this workspace, or one explicit session id fragment. */
function loadRealSessions() {
  const found = []
  let workspaceDirs = []
  try {
    workspaceDirs = fs.readdirSync(sessionsRoot)
  } catch {
    workspaceDirs = []
  }
  for (const workspaceDir of workspaceDirs) {
    const dir = path.join(sessionsRoot, workspaceDir)
    let entries = []
    try {
      entries = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const sessionDir of entries) {
      if (sessionFilter && !sessionDir.includes(sessionFilter)) continue
      const file = path.join(dir, sessionDir, 'session.v4.jsonl.zstd')
      if (!fs.existsSync(file)) continue
      let parsed
      try {
        parsed = parseSessionFile(file)
      } catch {
        continue
      }
      if (!sessionFilter && sessionCwd && parsed.header.cwd !== sessionCwd) continue
      found.push({ ...parsed, file, live: false, persisted: true })
    }
  }
  found.sort((a, b) => (b.header.createdAt ?? 0) - (a.header.createdAt ?? 0))
  if (found.length > 0) found[0].live = true
  return found
}

const sessions = loadRealSessions()
if (sessions.length === 0) {
  console.error(`[sim] no real session found under ${sessionsRoot} for cwd ${sessionCwd}`)
  console.error('[sim] set SIM_SESSION_ID=<session id fragment> or SIM_SESSION_CWD=<workspace path>')
  process.exit(3)
}

const workspacePaths = [...new Set(sessions.map(session => session.header.cwd).filter(Boolean))]
const workspace = workspacePaths[0] ?? sessionCwd

fs.rmSync(root, { recursive: true, force: true })
fs.mkdirSync(outside, { recursive: true })
fs.writeFileSync(path.join(outside, 'secret.txt'), 'this file is outside the workspace and must not be readable\n')

/** Fake Host services with the exact shapes the real DataPlane reads. */
function makeCtx() {
  const services = new Map()
  services.set('deepseekAccount', {
    async getPlatformSession() {
      return { origin: 'https://sim.invalid', token: 'simulated-token', userId: 'simulated-account' }
    },
    async getDeviceIdentity() {
      return { deviceId, osVersion: os.release() }
    },
  })
  services.set('sessionQuery', {
    async listSessions() {
      return sessions.map(session => ({ header: session.header, live: session.live, persisted: session.persisted }))
    },
    async readTitleSnapshots(ids) {
      return ids.map(id => {
        const session = sessions.find(entry => entry.header.id === id)
        return { sessionId: id, status: 'fulfilled', value: { title: { title: session?.title ?? 'Untitled' } } }
      })
    },
    async readSession(id) {
      const session = sessions.find(entry => entry.header.id === id)
      if (!session) throw new Error(`unknown session: ${id}`)
      // Re-read the file so the live conversation's newest events are served.
      const fresh = parseSessionFile(session.file)
      return { session: fresh.header, inheritedEventCount: 0, events: fresh.events }
    },
  })
  services.set('workspaceRegistry', {
    list() {
      return workspacePaths.map((entry, index) => ({ id: `real-ws-${index}`, title: path.basename(entry) || entry, path: entry }))
    },
  })
  return { get: name => services.get(name) }
}

// ---------------------------------------------------------------------------
// Mesh instance
// ---------------------------------------------------------------------------

fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
const consoleLogger = {
  info: (...args) => console.log('[sim]', ...args),
  warn: (...args) => console.warn('[sim:warn]', ...args),
  debug: (...args) => console.log('[sim:debug]', ...args),
  error: (...args) => console.error('[sim:error]', ...args),
}
const log = createLog({ dir: dataDir, debug: debugConsole, logger: consoleLogger })

const mesh = new Mesh({
  ctx: makeCtx(),
  config: {
    discoveryPort,
    staticPeers: [`127.0.0.1:${peerPort}`],
    autoTrustSameAccount: true,
    dataDir,
    peerName,
    allowRoots: [],
  },
  log,
  version,
})

/**
 * The live instance's account tag cannot be derived from its userId here (the
 * tag is a one-way hash and the live userId is not available to this process),
 * so force the tag the discovery layer compares against. This is the only
 * deviation from a real Host; everything below it is the real Mesh code.
 */
mesh.refreshAccount = async () => {
  mesh.account = { status: 'ready', userId: 'simulated-account', deviceId, accountTag }
  mesh.deviceId = deviceId
  mesh.accountTag = accountTag
  if (!mesh.discovery) await mesh.restartDiscovery()
}

mesh.start()

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(`timeout waiting for ${label}`)
}

try {
  await waitFor(() => mesh.discovery !== undefined, 5000, 'discovery start')
} catch (error) {
  console.error(`[sim] ${error.message}`)
  await mesh.stop()
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Status HTTP service
// ---------------------------------------------------------------------------

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const send = (status, body) => {
    response.statusCode = status
    response.setHeader('content-type', 'application/json; charset=utf-8')
    response.end(`${JSON.stringify(body, null, 2)}\n`)
  }
  try {
    if (url.pathname === '/health') {
      return send(200, { ok: true, deviceId, accountTagPrefix: accountTag.slice(0, 6), discoveryPort })
    }
    if (url.pathname === '/status') {
      return send(200, { state: mesh.state(), peers: mesh.peerViews() })
    }
    if (url.pathname === '/workspace') {
      const entries = fs.readdirSync(workspace, { withFileTypes: true }).map(entry => ({
        name: entry.name,
        type: entry.isDirectory() ? 'dir' : 'file',
      }))
      return send(200, { path: workspace, entries })
    }
    if (url.pathname === '/sessions') {
      return send(200, {
        sessions: sessions.map(session => ({
          id: session.header.id,
          title: session.title,
          cwd: session.header.cwd,
          createdAt: session.header.createdAt,
          live: session.live,
          persisted: session.persisted,
          events: session.events.length,
        })),
      })
    }
    return send(404, { error: 'not-found' })
  } catch (error) {
    return send(500, { error: error?.message ?? String(error) })
  }
})

server.listen(httpPort, '127.0.0.1', () => {
  const actualPort = server.address().port
  console.log(`[sim] status service on http://127.0.0.1:${actualPort}`)
  console.log(`[sim] device ${deviceId} (${peerName}) accountTag ${accountTag.slice(0, 6)}…`)
  console.log(`[sim] discovery ${discoveryPort}, querying live instance at 127.0.0.1:${peerPort}`)
})

// ---------------------------------------------------------------------------
// Status tick: report discovery/link changes until the link is verified
// ---------------------------------------------------------------------------

let lastLine = ''
let readyLogged = false
const tick = setInterval(() => {
  const peers = mesh.peerViews()
  const verified = peers.filter(peer => peer.verified)
  if (verified.length > 0 && !readyLogged) {
    readyLogged = true
    console.log(`READY verified link with ${verified.map(peer => `${peer.name} (${peer.deviceId})`).join(', ')}`)
  }
  const line = peers.length === 0
    ? 'no peers discovered yet'
    : peers.map(peer => `${peer.shortId} ${peer.name} ${peer.link}${peer.verified ? ' verified' : ''}`).join('; ')
  if (line !== lastLine) {
    lastLine = line
    console.log(`[sim] ${line}`)
  }
}, 3000)

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

let stopping = false
async function shutdown(signal) {
  if (stopping) return
  stopping = true
  console.log(`[sim] shutting down (${signal})`)
  clearInterval(tick)
  server.close()
  await mesh.stop()
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
