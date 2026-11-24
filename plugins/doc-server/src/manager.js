/**
 * Per-Session document server manager.
 *
 * The copied `server/` tree is the original cmd_tools/doc-server
 * implementation. Each Session gets its own HTTP server, root directory,
 * port, and document cache; the plugin never shares one root between
 * Sessions. Servers are started lazily from the "文档服务" view, the
 * workspace-file context menu, or the `doc_server` agent tool.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { createDocServer } = require('../server/lib/server.js')
const { createConfig } = require('../server/lib/config.js')
const { toViewUrl } = require('../server/lib/preview.js')
const { clearDocumentCacheForRoot } = require('../server/lib/doc-cache.js')

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.resolve(HERE, '..', 'server', 'public')

/** A user-facing failure with an HTTP status and a stable code. */
export class DocServerError extends Error {
  /**
   * @param {string} message - actionable message for the UI/model.
   * @param {number} [status] - HTTP status used by the control route.
   * @param {string} [code] - stable machine-readable code.
   */
  constructor(message, status = 400, code = 'doc-server/invalid') {
    super(message)
    this.name = 'DocServerError'
    this.status = status
    this.code = code
  }
}

function isInside(root, absolute) {
  const relative = path.relative(root, absolute)
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
}

function toPosix(value) {
  return value.split(path.sep).join('/')
}

function statOf(absolute) {
  try {
    return fs.statSync(absolute)
  } catch (error) {
    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      throw new DocServerError(`没有权限访问: ${absolute}`, 403, 'doc-server/permission-denied')
    }
    return undefined
  }
}

/** Resolve one absolute or Session-relative directory. */
function directoryOf(sessionCwd, directory) {
  const raw = String(directory ?? '').trim()
  const candidate = raw === ''
    ? sessionCwd
    : path.isAbsolute(raw) ? raw : path.resolve(sessionCwd, raw)
  const stat = statOf(candidate)
  if (stat === undefined) {
    throw new DocServerError(`目录不存在: ${candidate}`, 404, 'doc-server/unknown-directory')
  }
  if (!stat.isDirectory()) {
    throw new DocServerError(`不是目录: ${candidate}`, 400, 'doc-server/not-directory')
  }
  // Switching outside the previous root is allowed: the caller explicitly chose it.
  return path.resolve(candidate)
}

/** Parse a document URL returned by the agent or a previous tool call. */
function fileFromUrl(value) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return undefined
  }
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1' || parsed.hostname === '[::1]'
  if (!loopback) return undefined
  if (parsed.pathname !== '/view' && parsed.pathname !== '/graph' && parsed.pathname !== '/') return undefined
  return parsed.searchParams.get('file') ?? ''
}

export class DocServerManager {
  /**
   * @param {object} options - plugin dependencies and user config.
   * @param {import('@deepseek-ai/cordis').Context} options.ctx - Host plugin context.
   * @param {object} [options.config] - plugin row config.
   */
  constructor({ ctx, config = {} }) {
    this.ctx = ctx
    this.config = config
    this.bindHost = String(config.bindHost || '127.0.0.1')
    this.displayHost = this.bindHost === '0.0.0.0' || this.bindHost === '::' ? '127.0.0.1' : this.bindHost
    this.graphFileNames = Array.isArray(config.graphFileNames) ? config.graphFileNames : undefined
    this.ignoreDirs = Array.isArray(config.ignoreDirs) ? config.ignoreDirs : undefined
    /** @type {Map<string, any>} */
    this.instances = new Map()
    /** @type {Map<string, Promise<any>>} */
    this.starting = new Map()
    this.stopped = false
  }

  /** @returns {any} the Host session service when mounted. */
  sessions() {
    return this.ctx.get('sessions')
  }

  /** @param {string} sessionId - session identity. @returns {any} live Session or undefined. */
  sessionOf(sessionId) {
    return this.sessions()?.get?.(sessionId)
  }

  /** @param {any} session - live Session. @returns {string} effective working directory. */
  cwdOf(session) {
    if (session === undefined) return process.cwd()
    const workingDirectory = this.ctx.get('workingDirectory')
    try {
      const resolved = workingDirectory?.get?.(session)
      if (typeof resolved === 'string' && resolved !== '') return resolved
    } catch {
      // Fall back to the durable header below.
    }
    return typeof session.header?.cwd === 'string' && session.header.cwd !== ''
      ? session.header.cwd
      : process.cwd()
  }

  /**
   * Resolve the Session's workspace root: the durable Workspace path when the
   * Session is attached to one, else its creation cwd, else the effective
   * working directory. Document servers default here, matching the sidebar
   * workspace-files tree; the runtime working directory can move away.
   * @param {any} session - live Session.
   * @returns {string} absolute workspace root.
   */
  workspaceRootOf(session) {
    if (session === undefined) return process.cwd()
    try {
      const workspaces = this.ctx.get('workspaceRegistry')?.list?.() ?? []
      const workspace = workspaces.find((item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(session.id))
      if (typeof workspace?.path === 'string' && workspace.path !== '') return workspace.path
    } catch {
      // The registry is optional in trimmed compositions.
    }
    if (typeof session.header?.cwd === 'string' && session.header.cwd !== '') return session.header.cwd
    return this.cwdOf(session)
  }

  /** @param {any} session - live Session. @returns {string} display title. */
  titleOf(session, sessionId) {
    if (session === undefined) return String(sessionId || '')
    try {
      const title = this.ctx.get('sessionTitle')?.get?.(session)?.title
      if (typeof title === 'string' && title.trim() !== '') return title
    } catch {
      // The title service is optional in trimmed compositions.
    }
    return String(session.id || sessionId || '')
  }

  /** @param {string} sessionId - session identity. @returns {any} live Session or throws. */
  requireSession(sessionId) {
    const session = this.sessionOf(sessionId)
    if (session === undefined) {
      throw new DocServerError(`会话不存在或已关闭: ${sessionId}`, 404, 'doc-server/unknown-session')
    }
    return session
  }

  /** Resolve either an id or a live Session into a Session. */
  resolveSession(sessionOrId) {
    if (sessionOrId !== null && typeof sessionOrId === 'object' && sessionOrId.id !== undefined) {
      return sessionOrId
    }
    return this.requireSession(String(sessionOrId))
  }

  /**
   * Start a server for one Session, or switch an existing server's root.
   * @param {string|any} sessionOrId - Session identity or live Session.
   * @param {string} [directory] - absolute or Workspace-root-relative directory; defaults to the Session workspace root.
   * @returns {Promise<object>} serialized server state.
   */
  async start(sessionOrId, directory) {
    if (this.stopped) throw new DocServerError('文档服务插件已停止', 503, 'doc-server/stopped')
    const session = this.resolveSession(sessionOrId)
    const sessionId = String(session.id)
    const pending = this.starting.get(sessionId)
    if (pending !== undefined) {
      // One Session owns one server: concurrent starts must not each bind a
      // port and leave the loser listening outside the instance map.
      await pending
      return this.start(session, directory)
    }
    const task = this.startUnlocked(session, directory)
    this.starting.set(sessionId, task)
    try {
      return await task
    } finally {
      if (this.starting.get(sessionId) === task) this.starting.delete(sessionId)
    }
  }

  /** Start or switch without the per-Session start lock. */
  async startUnlocked(session, directory) {
    if (this.stopped) throw new DocServerError('文档服务插件已停止', 503, 'doc-server/stopped')
    const sessionId = String(session.id)
    const cwd = this.workspaceRootOf(session)
    const existing = this.instances.get(sessionId)
    const root = directoryOf(cwd, directory)
    if (existing !== undefined) {
      await this.switchRoot(existing, root)
      return this.stateOf(existing)
    }
    const docConfig = createConfig({
      root,
      port: 0,
      publicDir: PUBLIC_DIR,
      graphFileNames: this.graphFileNames,
      ignoreDirs: this.ignoreDirs,
    })
    const server = createDocServer(docConfig)
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.off('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(0, this.bindHost)
      })
    } catch (error) {
      try {
        server.close()
      } catch {
        // The failed listener owns nothing to release.
      }
      throw error
    }
    if (this.stopped) {
      await new Promise((resolve) => {
        try {
          server.close(resolve)
          server.closeAllConnections?.()
        } catch {
          resolve()
        }
      })
      throw new DocServerError('文档服务插件已停止', 503, 'doc-server/stopped')
    }
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const instance = {
      sessionId,
      instanceId: `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`,
      server,
      config: docConfig,
      port,
      baseUrl: `http://${this.displayHost}:${port}`,
      currentFile: '',
      currentAbsolute: '',
      currentUrl: `http://${this.displayHost}:${port}/`,
      token: 1,
      startedAt: Date.now(),
    }
    server.on('error', (error) => {
      this.ctx.logger?.warn?.('doc-server: HTTP server error for session %s: %s', sessionId, error.message)
    })
    this.instances.set(sessionId, instance)
    this.ctx.logger?.info?.('doc-server: started %s on port %d for session %s', docConfig.root, port, sessionId)
    return this.stateOf(instance)
  }

  /** Switch one running instance's root without changing its port or URL. */
  async switchRoot(instance, root) {
    if (instance.config.root === root) return
    const previousRoot = instance.config.root
    instance.config.root = root
    // Cache identity is absolute, so this only frees the old root's entries;
    // other Session servers keep their caches.
    clearDocumentCacheForRoot(previousRoot)
    instance.currentFile = ''
    instance.currentAbsolute = ''
    instance.currentUrl = `${instance.baseUrl}/`
    instance.token += 1
    this.ctx.logger?.info?.('doc-server: switched session %s root to %s', instance.sessionId, root)
  }

  /**
   * Point one Session's document URL at a file inside its current root.
   * Starts a server at the Session workspace root when none is running.
   * @param {string|any} sessionOrId - Session identity or live Session.
   * @param {string} file - absolute path, workspace-root-relative path, or a doc-server URL.
   * @returns {Promise<object>} serialized server state.
   */
  async locate(sessionOrId, file) {
    const session = this.resolveSession(sessionOrId)
    const sessionId = String(session.id)
    let input = String(file ?? '').trim()
    if (input === '') {
      throw new DocServerError('缺少要定位的文件路径', 400, 'doc-server/missing-file')
    }
    const fromUrl = fileFromUrl(input)
    if (fromUrl !== undefined) input = fromUrl
    let instance = this.instances.get(sessionId)
    if (instance === undefined) {
      await this.start(session, undefined)
      instance = this.instances.get(sessionId)
    }
    if (instance === undefined) {
      throw new DocServerError('文档服务启动失败', 500, 'doc-server/start-failed')
    }
    const root = instance.config.root
    const cwd = this.workspaceRootOf(session)
    const candidates = path.isAbsolute(input)
      ? [path.resolve(input)]
      : [path.resolve(cwd, input), path.resolve(root, input)]
    let existingOutside = undefined
    let absolute = undefined
    for (const candidate of candidates) {
      const stat = statOf(candidate)
      if (stat === undefined) continue
      if (!isInside(root, candidate)) {
        existingOutside = candidate
        continue
      }
      if (!stat.isFile()) {
        throw new DocServerError(`不是文件: ${candidate}`, 400, 'doc-server/not-file')
      }
      absolute = candidate
      break
    }
    if (absolute === undefined) {
      if (existingOutside !== undefined) {
        throw new DocServerError(
          `文件不在当前文档服务根目录内：${existingOutside}（根目录 ${root}）。请先通过右键菜单切换目录。`,
          409,
          'doc-server/outside-root',
        )
      }
      throw new DocServerError(`文件不存在：${input}`, 404, 'doc-server/unknown-file')
    }
    const extension = path.extname(absolute).toLowerCase()
    if (!instance.config.documentExtensions.has(extension)) {
      throw new DocServerError(
        `文档服务不支持此文件类型：${extension || '(无扩展名)'}`,
        415,
        'doc-server/unsupported-file',
      )
    }
    const relative = toPosix(path.relative(root, absolute))
    instance.currentAbsolute = absolute
    instance.currentFile = relative
    instance.currentUrl = instance.baseUrl + toViewUrl(relative, {}, instance.config)
    instance.token += 1
    return this.stateOf(instance)
  }

  /**
   * Remember an in-iframe navigation without changing the iframe source.
   * Used by the client after a postMessage from the document page.
   */
  track(sessionId, href) {
    const instance = this.instances.get(String(sessionId))
    if (instance === undefined) return undefined
    try {
      const url = new URL(String(href))
      if (url.origin !== instance.baseUrl) return this.stateOf(instance)
      const file = url.searchParams.get('file') ?? ''
      if (file !== '') {
        const absolute = path.resolve(instance.config.root, file)
        if (isInside(instance.config.root, absolute) && statOf(absolute)?.isFile()) {
          instance.currentFile = toPosix(path.relative(instance.config.root, absolute))
          instance.currentAbsolute = absolute
        }
      } else {
        instance.currentFile = ''
        instance.currentAbsolute = ''
      }
      instance.currentUrl = url.href
    } catch {
      // Ignore malformed bridge messages.
    }
    return this.stateOf(instance)
  }

  /** @param {string} sessionId - session identity. @returns {object|undefined} serialized state. */
  state(sessionId) {
    const instance = this.instances.get(String(sessionId))
    return instance === undefined ? undefined : this.stateOf(instance)
  }

  /** @returns {object[]} every running server. */
  list() {
    return [...this.instances.values()]
      .map((instance) => this.stateOf(instance))
      .sort((left, right) => left.startedAt - right.startedAt)
  }

  /** Serialize one running instance with its live Session facts. */
  stateOf(instance) {
    const session = this.sessionOf(instance.sessionId)
    return {
      sessionId: instance.sessionId,
      instanceId: instance.instanceId,
      title: this.titleOf(session, instance.sessionId),
      cwd: this.workspaceRootOf(session),
      root: instance.config.root,
      port: instance.port,
      url: instance.baseUrl,
      currentFile: instance.currentFile,
      currentUrl: instance.currentUrl,
      startedAt: instance.startedAt,
      token: instance.token,
    }
  }

  /**
   * Stop one Session's server and release its port.
   * @param {string} sessionId - session identity.
   * @returns {Promise<boolean>} whether a server was running.
   */
  async stop(sessionId) {
    const key = String(sessionId)
    const pending = this.starting.get(key)
    if (pending !== undefined) {
      try {
        await pending
      } catch {
        // A failed start owns no instance to stop.
      }
    }
    const instance = this.instances.get(key)
    if (instance === undefined) return false
    this.instances.delete(key)
    await new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolve()
      }
      try {
        instance.server.close(finish)
        instance.server.closeAllConnections?.()
      } catch {
        finish()
      }
      const timer = setTimeout(finish, 1500)
      timer.unref?.()
    })
    return true
  }

  /** Stop every server; called from the plugin effect teardown. */
  async stopAll() {
    this.stopped = true
    await Promise.all([...this.starting.values()].map((task) => task.catch(() => {})))
    await Promise.all([...this.instances.keys()].map((sessionId) => this.stop(sessionId)))
  }
}
