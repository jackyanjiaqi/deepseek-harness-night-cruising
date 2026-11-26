import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DocServerManager } from '../src/manager.js'
import { registerRoutes } from '../src/routes.js'
import { registerTools } from '../src/tools.js'
import { version as pluginVersion } from '../index.js'

const packageVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

test('plugin version is read from package.json', () => {
  assert.equal(pluginVersion, packageVersion)
})

function makeCtx(sessions, rejection) {
  const routes = []
  return {
    routes,
    get(name) {
      if (name === 'sessions') return { get: (id) => sessions.find((session) => session.id === id) }
      if (name === 'workingDirectory') return { get: (session) => session.header.cwd }
      if (name === 'sessionTitle') return { get: (session) => ({ title: `title:${session.id}` }) }
      if (name === 'connection' && rejection !== undefined) return { requestRejection: () => rejection }
      return undefined
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index !== -1) routes.splice(index, 1)
        }
      },
    },
    tools: {
      register(definition) {
        this.definitions = [...(this.definitions ?? []), definition]
        return () => {}
      },
    },
    logger: { info() {}, warn() {} },
  }
}

function invoke(route, { method = 'GET', url, body } = {}) {
  return new Promise((resolve, reject) => {
    const listeners = new Map()
    const res = {
      statusCode: 0,
      headers: {},
      body: '',
      headersSent: false,
      writeHead(status, headers) {
        this.statusCode = status
        this.headers = headers
      },
      end(chunk) {
        this.body += chunk === undefined ? '' : String(chunk)
        this.headersSent = true
        resolve({ status: this.statusCode, headers: this.headers, body: this.body, json: () => JSON.parse(this.body) })
      },
    }
    const req = {
      method,
      url,
      headers: {},
      setEncoding() {},
      destroy() {},
      on(event, callback) {
        if (!listeners.has(event)) listeners.set(event, [])
        listeners.get(event).push(callback)
        return req
      },
    }
    const pending = route.handler(req, res)
    queueMicrotask(() => {
      if (body !== undefined) {
        for (const callback of listeners.get('data') ?? []) callback(JSON.stringify(body))
      }
      for (const callback of listeners.get('end') ?? []) callback()
    })
    Promise.resolve(pending).catch(reject)
  })
}

test('control routes and doc_server tool share the manager', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doc-routes-'))
  fs.writeFileSync(path.join(root, 'README.md'), '# Root\n')
  fs.mkdirSync(path.join(root, 'docs'))
  fs.writeFileSync(path.join(root, 'docs', 'a.md'), '# A\n')
  const session = { id: 'session-routes', header: { cwd: root } }
  const ctx = makeCtx([session])
  const manager = new DocServerManager({ ctx, config: {} })
  t.after(async () => {
    await manager.stopAll()
    fs.rmSync(root, { recursive: true, force: true })
  })
  registerRoutes(ctx, manager, ctx.logger, packageVersion)
  assert.equal(ctx.routes.length, 1)
  const route = ctx.routes[0]

  const started = await invoke(route, {
    method: 'POST',
    url: '/doc-server/api/start',
    body: { sessionId: 'session-routes' },
  })
  assert.equal(started.status, 200)
  assert.equal(started.json().ok, true)
  assert.equal(started.json().server.root, root)

  const listed = await invoke(route, { url: '/doc-server/api/list' })
  assert.equal(listed.json().servers.length, 1)
  // The settings page badge reads this value, so it must be the manifest version.
  assert.equal(listed.json().version, packageVersion)

  const located = await invoke(route, {
    method: 'POST',
    url: '/doc-server/api/locate',
    body: { sessionId: 'session-routes', file: 'README.md' },
  })
  assert.equal(located.json().server.currentFile, 'README.md')
  assert.match(located.json().server.currentUrl, /\/view\?file=README\.md$/)

  const switched = await invoke(route, {
    method: 'POST',
    url: '/doc-server/api/switch-root',
    body: { sessionId: 'session-routes', directory: 'docs' },
  })
  assert.equal(switched.json().server.root, path.join(root, 'docs'))
  assert.equal(switched.json().server.currentFile, '')

  // The same manager backs the agent tool.
  registerTools(ctx, manager)
  const tool = ctx.tools.definitions.find((definition) => definition.name === 'doc_server')
  assert.ok(tool)
  const result = await tool.execute(
    { action: 'open', file: 'a.md' },
    { agent: { session }, signal: AbortSignal.timeout(5000) },
  )
  assert.equal(result.ok, true)
  assert.equal(result.file, 'a.md')
  assert.match(result.url, /\/view\?file=a\.md$/)
  assert.match(result.markdown, /在文档服务中打开 a\.md/)

  const stopped = await invoke(route, {
    method: 'POST',
    url: '/doc-server/api/stop',
    body: { sessionId: 'session-routes' },
  })
  assert.equal(stopped.json().stopped, true)
  assert.equal(manager.list().length, 0)

  const rejectedCtx = makeCtx([session], 'forbidden')
  const rejectedManager = new DocServerManager({ ctx: rejectedCtx, config: {} })
  registerRoutes(rejectedCtx, rejectedManager, rejectedCtx.logger)
  const denied = await invoke(rejectedCtx.routes[0], { url: '/doc-server/api/list' })
  assert.equal(denied.status, 403)
  assert.equal(denied.json().ok, false)
})
