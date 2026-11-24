/**
 * Same-origin HTTP routes backing the settings panel.
 *
 * The routes only expose mesh status and local trust management (trust,
 * revoke, reconnect). They never proxy remote session or file content; the
 * panel shows peers, not data.
 */
const BASE = '/account-mesh'
const MAX_BODY = 64 * 1024

export function registerRoutes(ctx, mesh, log) {
  const webServer = ctx.get('webServer')
  if (!webServer) {
    log.warn('webServer is not mounted; the settings panel has no data source')
    return () => {}
  }
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
          })
        }
        if (route === '/api/tree' && req.method === 'GET') {
          return json(res, 200, await buildTree(mesh, log))
        }
        if (route === '/api/transcript' && req.method === 'GET') {
          const peer = String(url.searchParams.get('peer') ?? '')
          const sessionId = String(url.searchParams.get('sessionId') ?? '')
          if (!peer || !sessionId) return json(res, 400, { error: 'peer and sessionId are required' })
          const fromSeq = Number(url.searchParams.get('fromSeq') ?? 0) || 0
          const limit = Number(url.searchParams.get('limit') ?? 200) || 200
          try {
            if (peer === 'local-test' && mesh.config.localSessionTest && !hasRealVerifiedPeer(mesh)) {
              return json(res, 200, await mesh.data.sessionEvents({ sessionId, fromSeq, limit }))
            }
            if (peer === 'local-test') return json(res, 404, { error: 'local test peer is hidden while a real peer is connected' })
            return json(res, 200, await mesh.call(peer, 'sessions/events', { sessionId, fromSeq, limit }))
          } catch (error) {
            return json(res, 502, { error: error.message, code: error.code ?? 'remote-failed' })
          }
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
          return json(res, 200, { ok: mesh.forget(deviceId) })
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
