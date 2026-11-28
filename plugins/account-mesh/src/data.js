/**
 * Read-only data plane served to the other instance.
 *
 * Sessions come from `ctx.sessionQuery` (live or persisted, never activated);
 * files come from the Host's own filesystem, confined to workspaces, session
 * working directories and explicitly allowed roots. There is no write path,
 * no prompt path and no shell path in this module.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sliceLines } from './util.js'

const SESSION_EVENT_KINDS = new Set(['user/message', 'assistant/message', 'tool/call', 'tool/result'])

/** Text projection of one message's content blocks. */
function textOfContent(content, { toolCalls = true } = {}) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block) continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'reasoning') continue
    else if (block.type === 'tool-call' && toolCalls) parts.push(`[tool ${block.name}] ${block.arguments ?? ''}`)
    else if (block.type === 'image') parts.push(`[图片: ${block.attachment?.mediaType ?? 'image'}]`)
    else if (block.type === 'file') parts.push(`[文件: ${block.attachment?.name ?? 'file'}]`)
  }
  return parts.join('\n').trim()
}

/** Reasoning text kept separate so the UI can collapse it in the conversation tab. */
function reasoningOfContent(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'reasoning' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}

/**
 * UTF-8 byte length of a projected item's text fields. This is the payload the
 * peer actually ships, so it is the unit the panel reports as "data volume".
 */
export function bytesOfItem(item) {
  const text = typeof item.text === 'string' ? item.text : ''
  const reasoning = typeof item.reasoning === 'string' ? item.reasoning : ''
  return Buffer.byteLength(text, 'utf8') + Buffer.byteLength(reasoning, 'utf8')
}

/**
 * One projected transcript item, or undefined for non-conversation events.
 * `compact` drops the reasoning body and tool-call arguments, keeping only the
 * call names: that is the index payload the tree uses to size a session
 * without shipping its whole transcript.
 */
export function projectEvent(event, { compact = false } = {}) {
  if (!SESSION_EVENT_KINDS.has(event.type)) return undefined
  const data = event.data ?? {}
  if (event.type === 'user/message') {
    const text = textOfContent(data.content)
    return text ? { seq: event.seq, time: event.time, role: 'user', text } : undefined
  }
  if (event.type === 'assistant/message') {
    const content = data.message?.content
    const text = textOfContent(content, { toolCalls: false })
    const reasoning = compact ? '' : reasoningOfContent(content)
    const calls = Array.isArray(content)
      ? content.filter(block => block?.type === 'tool-call').map(block => ({ name: block.name, arguments: block.arguments }))
      : []
    if (!text && !reasoning && calls.length === 0) return undefined
    return compact
      ? { seq: event.seq, time: event.time, role: 'assistant', text, toolCalls: calls.map(call => call.name) }
      : {
          seq: event.seq,
          time: event.time,
          role: 'assistant',
          text,
          reasoning,
          toolCalls: calls.map(call => call.name),
          toolCallDetails: calls,
        }
  }
  if (event.type === 'tool/call') {
    return {
      seq: event.seq,
      time: event.time,
      role: 'tool-call',
      name: data.name,
      text: compact ? '' : typeof data.arguments === 'string' ? data.arguments : '',
    }
  }
  if (event.type === 'tool/result') {
    const text = textOfContent(data.message?.content)
    return {
      seq: event.seq,
      time: event.time,
      role: 'tool-result',
      isError: Boolean(data.error) || data.message?.isError === true,
      text,
      errorName: data.error?.name ?? undefined,
      errorCode: data.error?.code ?? undefined,
    }
  }
  return undefined
}

export class DataPlane {
  constructor(ctx, config, log) {
    this.ctx = ctx
    this.config = config
    this.log = log
    this.rootsCache = { at: 0, roots: [] }
    this.deniedCache = { at: 0, roots: [] }
  }

  sessionQuery() {
    const service = this.ctx.get('sessionQuery')
    if (!service) throw rpcError('service-missing', 'sessionQuery is not mounted in this Host')
    return service
  }

  /**
   * Directories this plane must never serve, even when a workspace or an
   * explicit root covers them: the plugin's own keys live under $DSH_HOME and
   * a covered home directory must not turn a trusted peer into a key reader.
   */
  deniedRoots() {
    if (Date.now() - this.deniedCache.at < 60000) return this.deniedCache.roots
    const roots = new Set()
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    for (const entry of [home, this.config?.dataDir]) {
      if (!entry) continue
      roots.add(realpathOf(entry) ?? path.resolve(String(entry)))
    }
    this.deniedCache = { at: Date.now(), roots: [...roots] }
    return this.deniedCache.roots
  }

  isDenied(resolved) {
    if (typeof resolved !== 'string') return false
    return this.deniedRoots().some(root => isInside(root, resolved))
  }

  /** Allowed file roots, resolved to real paths and refreshed periodically. */
  async allowedRoots() {
    if (Date.now() - this.rootsCache.at < 60000) return this.rootsCache.roots
    const roots = new Set()
    for (const entry of this.config.allowRoots ?? []) {
      const resolved = realpathOf(entry)
      if (resolved) roots.add(resolved)
    }
    const registry = this.ctx.get('workspaceRegistry')
    if (registry?.list) {
      for (const workspace of registry.list()) {
        const resolved = realpathOf(workspace?.path)
        if (resolved) roots.add(resolved)
      }
    }
    try {
      const records = await this.sessionQuery().listSessions()
      for (const record of records) {
        const resolved = realpathOf(record?.header?.cwd)
        if (resolved) roots.add(resolved)
      }
    } catch {
      // Session cwds only widen the allowed set; a failure here keeps the other roots.
    }
    this.rootsCache = { at: Date.now(), roots: [...roots] }
    return this.rootsCache.roots
  }

  async listSessions({ limit = 50, offset = 0, signal } = {}) {
    const service = this.sessionQuery()
    const records = await service.listSessions(signal)
    const sorted = [...records].sort((a, b) => (b.header?.createdAt ?? 0) - (a.header?.createdAt ?? 0))
    const page = sorted.slice(offset, offset + limit)
    let titles = new Map()
    try {
      const result = await service.readTitleSnapshots(page.map(record => record.header.id), signal)
      for (const entry of result ?? []) {
        if (entry?.status === 'fulfilled' && entry.value?.title) titles.set(entry.sessionId, entry.value.title.title)
      }
    } catch {
      // Titles are optional metadata; the list still serves without them.
    }
    return {
      total: sorted.length,
      offset,
      limit,
      hasMore: offset + page.length < sorted.length,
      sessions: page.map(record => ({
        id: record.header.id,
        title: titles.get(record.header.id) ?? null,
        cwd: record.header.cwd ?? null,
        createdAt: record.header.createdAt ?? null,
        live: record.live === true,
        persisted: record.persisted === true,
        parentSessionId: record.header.parentSession ?? null,
      })),
    }
  }

  async sessionEvents({ sessionId, fromSeq = 0, limit = 100 } = {}) {
    if (typeof sessionId !== 'string' || !sessionId) throw rpcError('bad-request', 'sessionId is required')
    const service = this.sessionQuery()
    const snapshot = await service.readSession(sessionId)
    const items = []
    for (const event of snapshot.events) {
      if ((event.seq ?? 0) < fromSeq) continue
      const projected = projectEvent(event)
      if (projected) items.push(projected)
    }
    const page = items.slice(0, limit)
    const nextSeq = page.length > 0 ? page[page.length - 1].seq + 1 : fromSeq
    // Totals describe the whole session, not just this window, so the reader
    // can show how much of it has been fetched (and how much is left).
    return {
      session: {
        id: snapshot.session.id,
        cwd: snapshot.session.cwd ?? null,
        createdAt: snapshot.session.createdAt ?? null,
      },
      fromSeq,
      nextSeq,
      hasMore: page.length < items.length,
      itemCount: items.length,
      totalBytes: items.reduce((sum, item) => sum + bytesOfItem(item), 0),
      pageBytes: page.reduce((sum, item) => sum + bytesOfItem(item), 0),
      items: page,
    }
  }

  /**
   * Compact index of one session: every projected item's seq, time, role and
   * byte size, without reasoning bodies or tool-call arguments. It lets the
   * tree size a session and the reader plan a fetch without pulling the whole
   * transcript.
   */
  async sessionIndex({ sessionId } = {}) {
    if (typeof sessionId !== 'string' || !sessionId) throw rpcError('bad-request', 'sessionId is required')
    const snapshot = await this.sessionQuery().readSession(sessionId)
    const items = []
    let totalBytes = 0
    let totalItems = 0
    for (const event of snapshot.events) {
      const projected = projectEvent(event, { compact: true })
      if (!projected) continue
      const bytes = bytesOfItem(projected)
      totalItems += 1
      totalBytes += bytes
      items.push({
        seq: projected.seq,
        time: projected.time,
        role: projected.role,
        bytes,
        ...(projected.name ? { name: projected.name } : {}),
      })
    }
    return {
      session: {
        id: snapshot.session.id,
        cwd: snapshot.session.cwd ?? null,
        createdAt: snapshot.session.createdAt ?? null,
      },
      totalItems,
      totalBytes,
      items,
    }
  }

  /** Dispatch one whitelisted read-only operation (shared by RPC and the panel routes). */
  async runOp(op, params = {}) {
    switch (op) {
      case 'sessions/list':
        return this.listSessions({
          limit: clampInt(params.limit, 1, 500, 50),
          offset: clampInt(params.offset, 0, 1_000_000, 0),
          workspace: params.workspace,
        })
      case 'sessions/events':
        return this.sessionEvents({
          sessionId: params.sessionId,
          fromSeq: clampInt(params.fromSeq, 0, Number.MAX_SAFE_INTEGER, 0),
          limit: clampInt(params.limit, 1, 500, 100),
        })
      case 'sessions/index':
        return this.sessionIndex({ sessionId: params.sessionId })
      case 'workspaces/list':
        return this.listWorkspaces()
      case 'files/list':
        return this.listFiles({ path: params.path })
      case 'files/stat':
        return this.statFile({ path: params.path })
      case 'files/read':
        return this.readFile({
          path: params.path,
          offset: clampInt(params.offset, 0, Number.MAX_SAFE_INTEGER, 0),
          limit: clampInt(params.limit, 1, 2000, 200),
        })
      default:
        throw rpcError('bad-request', `unknown or unsupported operation: ${op}`)
    }
  }

  listWorkspaces() {
    const registry = this.ctx.get('workspaceRegistry')
    const spaces = registry?.list?.() ?? []
    return {
      workspaces: spaces.map(workspace => ({
        id: workspace?.id ?? null,
        title: workspace?.title ?? null,
        path: workspace?.path ?? null,
      })),
    }
  }

  async resolveReadable(input) {
    if (typeof input !== 'string' || !input.trim()) throw rpcError('bad-request', 'path is required')
    const roots = await this.allowedRoots()
    const candidates = path.isAbsolute(input)
      ? [input]
      : roots.map(root => path.join(root, input))
    for (const candidate of candidates) {
      const resolved = realpathOf(candidate)
      if (!resolved) continue
      if (this.isDenied(resolved)) throw rpcError('path-denied', `path is in a protected directory: ${input}`)
      const root = roots.find(entry => isInside(entry, resolved))
      if (!root) throw rpcError('path-outside', `path is outside the allowed roots: ${input}`)
      return { path: resolved, root }
    }
    throw rpcError('not-found', `no readable path matches: ${input}`)
  }

  async listFiles({ path: input } = {}) {
    const resolved = input ? await this.resolveReadable(input) : await this.resolveRootPath()
    if (this.isDenied(resolved.path)) throw rpcError('path-denied', `path is in a protected directory: ${resolved.path}`)
    const entries = fs.readdirSync(resolved.path, { withFileTypes: true }).filter(entry => {
      const real = realpathOf(path.join(resolved.path, entry.name))
      return real === undefined || !this.isDenied(real)
    }).map(entry => {
      const full = path.join(resolved.path, entry.name)
      let size
      let mtime
      try {
        const info = fs.statSync(full)
        size = info.size
        mtime = info.mtimeMs
      } catch {
        // A broken symlink still lists; its stat is simply absent.
      }
      return {
        name: entry.name,
        type: entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other',
        size: size ?? null,
        mtime: mtime ?? null,
      }
    })
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
    return { path: resolved.path, entries }
  }

  async resolveRootPath() {
    const registry = this.ctx.get('workspaceRegistry')
    const first = registry?.list?.()[0]
    const resolved = realpathOf(first?.path)
    if (!resolved) throw rpcError('not-found', 'no workspace is available on this host')
    if (this.isDenied(resolved)) throw rpcError('path-denied', 'the workspace is inside a protected directory')
    return { path: resolved, root: resolved }
  }

  async statFile({ path: input } = {}) {
    const resolved = await this.resolveReadable(input)
    const info = fs.statSync(resolved.path)
    return {
      path: resolved.path,
      type: info.isDirectory() ? 'dir' : info.isFile() ? 'file' : 'other',
      size: info.size,
      mtime: info.mtimeMs,
    }
  }

  async readFile({ path: input, offset = 0, limit = 200 } = {}) {
    const resolved = await this.resolveReadable(input)
    const info = fs.statSync(resolved.path)
    if (info.isDirectory()) throw rpcError('bad-request', 'path is a directory')
    const maxLines = Math.max(1, Math.min(Number(limit) || 200, 2000))
    const startLine = Math.max(0, Number(offset) || 0)
    if (info.size <= 4 * 1024 * 1024) {
      const text = fs.readFileSync(resolved.path, 'utf8')
      const sliced = sliceLines(text, startLine, maxLines)
      return {
        path: resolved.path,
        offset: startLine,
        lines: sliced.lines,
        lineCount: sliced.lines.length,
        totalLines: sliced.total,
        hasMore: sliced.hasMore,
        truncatedFile: false,
      }
    }
    const window = await readLineWindow(resolved.path, startLine, maxLines)
    return {
      path: resolved.path,
      offset: startLine,
      lines: window.lines,
      lineCount: window.lines.length,
      totalLines: window.totalLines,
      hasMore: window.hasMore,
      truncatedFile: window.totalLines === null,
    }
  }
}

/** Read a line window from a large file without loading it whole. */
async function readLineWindow(file, offset, limit) {
  const { createReadStream } = await import('node:fs')
  const { createInterface } = await import('node:readline')
  const stream = createReadStream(file, { encoding: 'utf8' })
  const reader = createInterface({ input: stream, crlfDelay: Infinity })
  const lines = []
  let index = 0
  let hasMore = false
  try {
    for await (const line of reader) {
      if (index < offset) {
        index += 1
        continue
      }
      if (lines.length >= limit) {
        hasMore = true
        break
      }
      lines.push(line)
      index += 1
    }
  } finally {
    reader.close()
    stream.destroy()
  }
  return { lines, totalLines: null, hasMore }
}

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

function realpathOf(value) {
  if (typeof value !== 'string' || !value) return undefined
  try {
    return fs.realpathSync(value)
  } catch {
    return undefined
  }
}

function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`)
}

/** Error carrying a wire error code. */
export function rpcError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}
