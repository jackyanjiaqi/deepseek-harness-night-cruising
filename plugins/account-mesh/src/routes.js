/**
 * Same-origin HTTP routes backing the settings panel.
 *
 * The routes expose mesh status, local trust management (trust, revoke,
 * reconnect) and the read-only remote workspace/session views the panel
 * renders. Nothing here writes to a peer.
 *
 * Every response that carries remote data reports its own transfer size
 * (`bytes`) so the browser can add it to the per-session fetched total. A
 * small in-memory cache keeps the session index and recent transcript pages,
 * so a non-forced refresh does not pull the same data from the peer again.
 */
const BASE = '/account-mesh'
const MAX_BODY = 64 * 1024
/** Session indexes kept per peer; the newest ones win. */
const INDEX_CACHE_MAX = 64
/** Transcript pages kept in the cache, across all sessions. */
const TRANSCRIPT_CACHE_MAX = 512

export function registerRoutes(ctx, mesh, log, codec = null) {
  const webServer = ctx.get('webServer')
  if (!webServer) {
    log.warn('webServer is not mounted; the settings panel has no data source')
    return () => {}
  }
  const cache = new TransferCache()
  return webServer.register({
    kind: 'prefix',
    path: BASE,
    handler: async (req, res) => {
      try {
        const rejection = ctx.get('connection')?.requestRejection?.({ headers: req.headers })
        if (rejection) return json(res, rejection, { error: 'unauthorized' })
        const url = new URL(req.url ?? '/', 'http://mesh.local')
        const route = url.pathname.slice(BASE.length) || '/'
        if (route === '/api/state' && req.method === 'GET') {
          return json(res, 200, {
            ...mesh.state(),
            tailscale: await mesh.tailscaleStatus(),
            channels: mesh.channels(),
            localTest: localTestStatus(mesh),
            transfer: codec ? codec.state() : null,
          })
        }
        if (route === '/api/site-links' && req.method === 'GET') {
          if (!codec) {
            return json(res, 503, {
              links: { download: null, featured: null },
              linksStatus: 'error',
              linksFetchedAt: null,
            })
          }
          if (isTruthy(url.searchParams.get('force'))) await codec.refreshLinks({ force: true })
          const transfer = codec.state()
          return json(res, 200, {
            links: transfer.links,
            linksStatus: transfer.linksStatus,
            linksFetchedAt: transfer.linksFetchedAt,
          })
        }
        if (route === '/api/codec' && req.method === 'POST') {
          if (!codec) return json(res, 503, { error: 'codec controller is unavailable', code: 'codec-unavailable' })
          const body = await readBody(req)
          if (typeof body.enabled !== 'boolean') return json(res, 400, { error: 'enabled must be a boolean' })
          const result = codec.setEnabled(body.enabled)
          if (result?.ok === false) {
            const status = result.code === 'edition-requires-night-cruising' ? 409 : 500
            return json(res, status, {
              error: result.error ?? result.code ?? 'codec update failed',
              code: result.code ?? 'codec-failed',
            })
          }
          return json(res, 200, { ok: true, transfer: result })
        }
        if (route === '/api/tree' && req.method === 'GET') {
          return json(res, 200, await buildTree(mesh, log))
        }
        if (route === '/api/sessions/index' && req.method === 'GET') {
          const peer = String(url.searchParams.get('peer') ?? '')
          const sessionId = String(url.searchParams.get('sessionId') ?? '')
          if (!peer || !sessionId) return json(res, 400, { error: 'peer and sessionId are required' })
          const force = isTruthy(url.searchParams.get('force'))
          const key = `${peer}\u0000${sessionId}`
          if (!force) {
            const hit = cache.getIndex(key)
            if (hit) return json(res, 200, { ...hit.value, cached: true, bytes: 0 })
          }
          try {
            const index = await readRemote(mesh, peer, 'sessions/index', { sessionId })
            const bytes = Buffer.byteLength(JSON.stringify(index), 'utf8')
            cache.putIndex(key, index, bytes)
            return json(res, 200, { ...index, cached: false, bytes })
          } catch (error) {
            return json(res, 502, { error: error.message, code: error.code ?? 'remote-failed' })
          }
        }
        if (route === '/api/transcript' && req.method === 'GET') {
          const peer = String(url.searchParams.get('peer') ?? '')
          const sessionId = String(url.searchParams.get('sessionId') ?? '')
          if (!peer || !sessionId) return json(res, 400, { error: 'peer and sessionId are required' })
          const fromSeq = Number(url.searchParams.get('fromSeq') ?? 0) || 0
          const limit = Number(url.searchParams.get('limit') ?? 200) || 200
          const force = isTruthy(url.searchParams.get('force'))
          const key = `${peer}\u0000${sessionId}\u0000${fromSeq}\u0000${limit}`
          if (!force) {
            const hit = cache.getPage(key)
            if (hit) return json(res, 200, { ...hit.value, cached: true, bytes: 0 })
          }
          try {
            const page = await readRemote(mesh, peer, 'sessions/events', { sessionId, fromSeq, limit })
            const bytes = Buffer.byteLength(JSON.stringify(page), 'utf8')
            cache.putPage(key, page, bytes)
            return json(res, 200, { ...page, cached: false, bytes })
          } catch (error) {
            return json(res, 502, { error: error.message, code: error.code ?? 'remote-failed' })
          }
        }
        if (route === '/api/fetch' && req.method === 'POST') {
          const body = await readBody(req)
          const peer = String(body.peer ?? '')
          const sessionId = String(body.sessionId ?? '')
          if (!peer || !sessionId) return json(res, 400, { error: 'peer and sessionId are required' })
          try {
            const result = await mesh.fetchSession(peer, sessionId, {
              priority: body.priority === 'none' ? 'none' : 'dialog',
            })
            return json(res, 200, { ok: true, ...result })
          } catch (error) {
            return json(res, 502, { error: error.message, code: error.code ?? 'fetch-failed' })
          }
        }
        if (route === '/api/transfer/dialog' && req.method === 'GET') {
          const transferId = String(url.searchParams.get('transferId') ?? '')
          if (!transferId) return json(res, 400, { error: 'transferId is required' })
          return json(res, 200, mesh.transfer.dialog(transferId))
        }
        if (route === '/api/vault/clear' && req.method === 'POST') {
          const vault = await mesh.clearVault()
          return json(res, 200, { ok: true, vault })
        }
        if (route === '/api/cache/clear' && req.method === 'POST') {
          cache.clear()
          return json(res, 200, { ok: true })
        }
        if (route === '/api/channels' && req.method === 'GET') {
          return json(res, 200, { channels: mesh.channels() })
        }
        if (route === '/api/probe' && req.method === 'POST') {
          const body = await readBody(req)
          const target = String(body.target ?? '')
          const channel = String(body.channel ?? 'lan')
          if (!target) return json(res, 400, { error: 'target is required' })
          try {
            return json(res, 200, await mesh.probe(target, channel))
          } catch (error) {
            return json(res, 502, { error: error.message, code: error.code ?? 'probe-failed' })
          }
        }
        if (route === '/api/refresh-network' && req.method === 'POST') {
          try {
            return json(res, 200, { ok: true, channels: await mesh.refreshNetwork() })
          } catch (error) {
            return json(res, 502, { error: error.message, code: error.code ?? 'refresh-failed' })
          }
        }
        if (route === '/api/local-test' && req.method === 'GET') {
          return json(res, 200, localTestStatus(mesh))
        }
        if (route === '/api/local-test' && req.method === 'POST') {
          const body = await readBody(req)
          if (typeof body.enabled !== 'boolean') return json(res, 400, { error: 'enabled must be a boolean' })
          mesh.config.localSessionTest = body.enabled
          log.info(`account-mesh: local test peer ${body.enabled ? 'enabled' : 'disabled'} from the panel`)
          return json(res, 200, localTestStatus(mesh))
        }
        // Answer one pending first-contact trust request: trust it, or refuse it
        // (a durable revocation, so the account rule cannot re-trust it later).
        if (route === '/api/trust-request' && req.method === 'POST') {
          const body = await readBody(req)
          const deviceId = String(body.deviceId ?? '')
          if (!deviceId) return json(res, 400, { error: 'deviceId is required' })
          if (body.decision === 'trust') {
            const result = mesh.pair(deviceId)
            mesh.reconnect(deviceId)
            return json(res, 200, { ok: true, decision: 'trust', deviceId, trustedAt: result.entry.trustedAt, rebound: result.rebound })
          }
          if (body.decision === 'refuse') {
            const revoked = mesh.forget(deviceId)
            return json(res, 200, { ok: true, decision: 'refuse', deviceId, revoked, revokedAt: mesh.trust.get(deviceId)?.revokedAt ?? null })
          }
          return json(res, 400, { error: 'decision must be trust or refuse' })
        }
        if (route === '/api/pair' && req.method === 'POST') {
          const body = await readBody(req)
          const deviceId = String(body.deviceId ?? '')
          if (!deviceId) return json(res, 400, { error: 'deviceId is required' })
          const result = mesh.pair(deviceId)
          mesh.reconnect(deviceId)
          return json(res, 200, { ok: true, deviceId, trustedAt: result.entry.trustedAt, rebound: result.rebound })
        }
        if (route === '/api/forget' && req.method === 'POST') {
          const body = await readBody(req)
          const deviceId = String(body.deviceId ?? '')
          if (!deviceId) return json(res, 400, { error: 'deviceId is required' })
          const revoked = mesh.forget(deviceId)
          return json(res, 200, { ok: revoked, deviceId, revokedAt: mesh.trust.get(deviceId)?.revokedAt ?? null })
        }
        if (route === '/api/reconnect' && req.method === 'POST') {
          const body = await readBody(req)
          const deviceId = String(body.deviceId ?? '')
          if (!deviceId) return json(res, 400, { error: 'deviceId is required' })
          mesh.reconnect(deviceId)
          return json(res, 200, { ok: true })
        }
        return json(res, 404, { error: 'not found' })
      } catch (error) {
        log.warn(`panel route failed: ${error.message}`)
        if (res.headersSent) {
          try {
            res.end()
          } catch {
            // ignore
          }
          return
        }
        return json(res, error.status ?? 500, { error: error.message })
      }
    },
  })
}

/**
 * Remote workspaces with their sessions, grouped as a tree. Only verified
 * peers are queried; every remote failure stays attached to that peer instead
 * of failing the whole panel.
 */
async function buildTree(mesh, log) {
  const peers = mesh.peerViews()
  const nodes = []
  for (const peer of peers) {
    const node = {
      online: peer.online === true,
      deviceId: peer.deviceId,
      shortId: peer.shortId,
      name: peer.name,
      source: peer.source,
      address: peer.address,
      rttMs: peer.rttMs,
      version: peer.version ?? null,
      transfer: peer.transfer ?? null,
      workspaces: [],
      error: null,
      lastSeenAt: peer.lastSeenAt ?? null,
    }
    if (!(peer.online && peer.verified)) {
      nodes.push(node)
      continue
    }
    try {
      const [workspaces, sessions] = await Promise.all([
        mesh.call(peer.deviceId, 'workspaces/list', {}),
        mesh.call(peer.deviceId, 'sessions/list', { limit: 500 }),
      ])
      node.workspaces = groupSessions(workspaces?.workspaces ?? [], sessions?.sessions ?? [])
    } catch (error) {
      node.error = error.message
      log.warn(`tree for ${peer.shortId} failed: ${error.message}`)
    }
    nodes.push(node)
  }
  // Test-only local peer: serve this Host's own sessions through the same tree
  // shape, so the panel UI can be rendered against real session data without
  // a WebRTC peer. Hidden as soon as a real peer is verified, so test rows never
  // mix with live remote data.
  if (mesh.config.localSessionTest && !hasRealVerifiedPeer(mesh)) {
    try {
      const [workspaces, sessions] = await Promise.all([
        mesh.data.listWorkspaces(),
        mesh.data.listSessions({ limit: 500 }),
      ])
      nodes.push({
        online: true,
        verified: true,
        deviceId: 'local-test',
        shortId: 'local-test',
        name: 'local-test',
        source: 'local',
        address: null,
        rttMs: 0,
        workspaces: groupSessions(workspaces?.workspaces ?? [], sessions?.sessions ?? []),
        error: null,
        lastSeenAt: Date.now(),
      })
    } catch (error) {
      log.warn(`local test tree failed: ${error.message}`)
    }
  }
  return { peers: nodes, generatedAt: Date.now() }
}

/**
 * One read-only remote operation, or the same operation served from this Host
 * for the test-only local peer. The local path goes through the DataPlane, so
 * it produces exactly the shape a remote peer would.
 */
async function readRemote(mesh, peer, op, params) {
  if (peer === 'local-test') {
    if (!(mesh.config.localSessionTest && !hasRealVerifiedPeer(mesh))) {
      throw Object.assign(new Error('local test peer is hidden while a real peer is connected'), { code: 'local-test-hidden' })
    }
    return mesh.data.runOp(op, params)
  }
  return mesh.call(peer, op, params)
}

/** `force=1` / `force=true` bypasses the transfer cache; anything else reads it. */
function isTruthy(value) {
  return value === '1' || value === 'true' || value === 'yes'
}

/**
 * Bounded LRU-ish cache for the data the panel pulls from peers. Values are
 * stored with the byte size they were transferred at, so a cache hit can be
 * reported honestly as "served locally, 0 bytes fetched from the peer".
 */
class TransferCache {
  constructor() {
    this.indexes = new Map()
    this.pages = new Map()
  }

  getIndex(key) {
    return this.indexes.get(key) ?? null
  }

  putIndex(key, value, bytes) {
    this.indexes.delete(key)
    this.indexes.set(key, { value, bytes })
    while (this.indexes.size > INDEX_CACHE_MAX) this.indexes.delete(this.indexes.keys().next().value)
  }

  getPage(key) {
    return this.pages.get(key) ?? null
  }

  putPage(key, value, bytes) {
    this.pages.delete(key)
    this.pages.set(key, { value, bytes })
    while (this.pages.size > TRANSCRIPT_CACHE_MAX) this.pages.delete(this.pages.keys().next().value)
  }

  clear() {
    this.indexes.clear()
    this.pages.clear()
  }
}

/** A real peer is online and authenticated; while one exists the local test peer stays hidden. */
function hasRealVerifiedPeer(mesh) {
  return mesh.peerViews().some(peer => peer.deviceId !== 'local-test' && peer.online === true && peer.verified === true)
}

/** Local test peer status for the settings toggle. */
function localTestStatus(mesh) {
  const hiddenByRealPeer = hasRealVerifiedPeer(mesh)
  return {
    enabled: mesh.config.localSessionTest === true,
    visible: mesh.config.localSessionTest === true && !hiddenByRealPeer,
    hiddenByRealPeer,
  }
}

/** Group sessions under their workspace (or their cwd when no workspace matches). */
/** Last path segment for display; the full path stays available for hover details. */
function lastSegment(pathText) {
  const text = String(pathText ?? '').replace(/[\\/]+$/, '')
  const parts = text.split(/[\\/]/)
  return parts[parts.length - 1] || text
}

function groupSessions(workspaces, sessions) {
  const groups = new Map()
  for (const workspace of workspaces) {
    const key = String(workspace.path ?? workspace.id ?? workspace.title ?? '').toLowerCase()
    groups.set(key, {
      id: workspace.id ?? key,
      title: workspace.title ?? workspace.path ?? key,
      // Display name: the last path segment; the full path stays in `path` for the hover tooltip.
      name: lastSegment(workspace.path ?? workspace.title ?? key),
      path: workspace.path ?? null,
      sessions: [],
    })
  }
  for (const session of sessions) {
    const key = String(session.cwd ?? '').toLowerCase()
    let group = groups.get(key)
    if (!group) {
      group = { id: `cwd:${key}`, title: session.cwd ?? '', name: lastSegment(session.cwd ?? ''), path: session.cwd ?? null, sessions: [] }
      groups.set(key, group)
    }
    group.sessions.push(session)
  }
  const result = [...groups.values()]
  for (const workspace of result) {
    workspace.sessions.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  }
  result.sort((a, b) => String(a.title).localeCompare(String(b.title)))
  return result
}

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(payload)
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw Object.assign(new Error('request body is too large'), { status: 413 })
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw Object.assign(new Error('request body must be JSON'), { status: 400 })
  }
}
