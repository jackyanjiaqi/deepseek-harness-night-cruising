/**
 * Same-origin control routes for the DSH "文档服务" plugin.
 *
 * The document pages themselves are served by each Session's own HTTP
 * server; these routes only manage instances and expose their state to the
 * Client half and to the agent tool's UI card.
 */
const BASE = '/doc-server'
const MAX_BODY = 1024 * 1024

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > MAX_BODY) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (body.trim() === '') return resolve({})
      try {
        resolve(JSON.parse(body))
      } catch (_error) {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Install the control routes.
 * @param {any} ctx - Host context with `webServer`.
 * @param {import('./manager.js').DocServerManager} manager - instance owner.
 * @param {any} log - plugin logger.
 * @param {string|null} [version] - plugin version read from package.json.
 * @returns {() => void} unregister.
 */
export function registerRoutes(ctx, manager, log, version = null) {
  return ctx.webServer.register({
    kind: 'prefix',
    path: BASE,
    handler: async (req, res) => {
      try {
        const rejection = ctx.get('connection')?.requestRejection?.({ headers: req.headers })
        if (rejection) return json(res, 403, { ok: false, error: 'unauthorized', code: 'doc-server/unauthorized' })
        const url = new URL(req.url ?? '/', 'http://doc-server.local')
        const route = url.pathname.slice(BASE.length) || '/'

        if (route === '/api/list' && req.method === 'GET') {
          return json(res, 200, { ok: true, version, servers: manager.list() })
        }
        if (route === '/api/state' && req.method === 'GET') {
          const sessionId = String(url.searchParams.get('sessionId') ?? '')
          if (sessionId === '') return json(res, 400, { ok: false, error: 'sessionId 不能为空', code: 'doc-server/missing-session' })
          return json(res, 200, { ok: true, server: manager.state(sessionId) ?? null })
        }
        if (route === '/api/start' && req.method === 'POST') {
          const body = await readBody(req)
          const sessionId = String(body.sessionId ?? '')
          if (sessionId === '') return json(res, 400, { ok: false, error: 'sessionId 不能为空', code: 'doc-server/missing-session' })
          const server = await manager.start(sessionId, body.directory === undefined ? undefined : String(body.directory))
          return json(res, 200, { ok: true, server })
        }
        if (route === '/api/switch-root' && req.method === 'POST') {
          const body = await readBody(req)
          const sessionId = String(body.sessionId ?? '')
          if (sessionId === '' || body.directory === undefined) {
            return json(res, 400, { ok: false, error: 'sessionId 和 directory 不能为空', code: 'doc-server/missing-argument' })
          }
          const server = await manager.start(sessionId, String(body.directory))
          return json(res, 200, { ok: true, server })
        }
        if (route === '/api/locate' && req.method === 'POST') {
          const body = await readBody(req)
          const sessionId = String(body.sessionId ?? '')
          const file = String(body.file ?? body.url ?? '')
          if (sessionId === '' || file === '') {
            return json(res, 400, { ok: false, error: 'sessionId 和 file 不能为空', code: 'doc-server/missing-argument' })
          }
          const server = await manager.locate(sessionId, file)
          return json(res, 200, { ok: true, server })
        }
        if (route === '/api/track' && req.method === 'POST') {
          const body = await readBody(req)
          const sessionId = String(body.sessionId ?? '')
          if (sessionId === '') return json(res, 400, { ok: false, error: 'sessionId 不能为空', code: 'doc-server/missing-session' })
          return json(res, 200, { ok: true, server: manager.track(sessionId, String(body.href ?? '')) ?? null })
        }
        if (route === '/api/stop' && req.method === 'POST') {
          const body = await readBody(req)
          const sessionId = String(body.sessionId ?? '')
          if (sessionId === '') return json(res, 400, { ok: false, error: 'sessionId 不能为空', code: 'doc-server/missing-session' })
          const stopped = await manager.stop(sessionId)
          return json(res, 200, { ok: true, stopped })
        }
        return json(res, 404, { ok: false, error: 'not found', code: 'doc-server/not-found' })
      } catch (error) {
        log?.warn?.('doc-server: control route failed: %s', error?.message ?? String(error))
        if (res.headersSent) {
          try {
            res.end()
          } catch {
            // The response was already closed.
          }
          return undefined
        }
        return json(res, error?.status ?? 500, {
          ok: false,
          error: error?.message ?? String(error),
          code: error?.code ?? 'doc-server/failed',
        })
      }
    },
  })
}
