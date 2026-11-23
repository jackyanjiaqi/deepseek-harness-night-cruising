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
          return json(res, 200, { ...mesh.state(), tailscale: await mesh.tailscaleStatus() })
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
            return json(res, 200, await mesh.call(peer, 'sessions/events', { sessionId, fromSeq, limit }))
          } catch (error) {
            return json(res, 502, { error: error.message, code: error.code ?? 'remote-failed' })
          }
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
      const groups = new Map()
      for (const workspace of workspaces?.workspaces ?? []) {
        const key = String(workspace.path ?? workspace.id ?? workspace.title ?? '').toLowerCase()
        groups.set(key, {
          id: workspace.id ?? key,
          title: workspace.title ?? workspace.path ?? key,
          path: workspace.path ?? null,
          sessions: [],
        })
      }
      for (const session of sessions?.sessions ?? []) {
        const key = String(session.cwd ?? '').toLowerCase()
        let group = groups.get(key)
        if (!group) {
          group = { id: `cwd:${key}`, title: session.cwd ?? '', path: session.cwd ?? null, sessions: [] }
          groups.set(key, group)
        }
        group.sessions.push(session)
      }
      node.workspaces = [...groups.values()]
      for (const workspace of node.workspaces) {
        workspace.sessions.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      }
      node.workspaces.sort((a, b) => String(a.title).localeCompare(String(b.title)))
    } catch (error) {
      node.error = error.message
      log.warn(`tree for ${peer.shortId} failed: ${error.message}`)
    }
    nodes.push(node)
  }
  return { peers: nodes, generatedAt: Date.now() }
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
