/**
 * Read-only data plane served to the other instance.
 *
 * Sessions come from `ctx.sessionQuery` (live or persisted, never activated);
 * files come from the Host's own filesystem, confined to workspaces, session
 * working directories and explicitly allowed roots. There is no write path,
 * no prompt path and no shell path in this module.
 */
import fs from 'node:fs'
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

/** One projected transcript item, or undefined for non-conversation events. */
function projectEvent(event) {
  if (!SESSION_EVENT_KINDS.has(event.type)) return undefined
  const data = event.data ?? {}
  if (event.type === 'user/message') {
    const text = textOfContent(data.content)
    return text ? { seq: event.seq, time: event.time, role: 'user', text } : undefined
  }
  if (event.type === 'assistant/message') {
    const content = data.message?.content
    const text = textOfContent(content, { toolCalls: false })
    const reasoning = reasoningOfContent(content)
    const calls = Array.isArray(content)
      ? content.filter(block => block?.type === 'tool-call').map(block => ({ name: block.name, arguments: block.arguments }))
      : []
    return text || reasoning || calls.length > 0
      ? {
          seq: event.seq,
          time: event.time,
          role: 'assistant',
          text,
          reasoning,
          toolCalls: calls.map(call => call.name),
          toolCallDetails: calls,
        }
      : undefined
  }
  if (event.type === 'tool/call') {
    return {
      seq: event.seq,
      time: event.time,
      role: 'tool-call',
      name: data.name,
      text: typeof data.arguments === 'string' ? data.arguments : '',
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
  }

  sessionQuery() {
    const service = this.ctx.get('sessionQuery')
    if (!service) throw rpcError('service-missing', 'sessionQuery is not mounted in this Host')
    return service
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
    return {
      session: {
        id: snapshot.session.id,
        cwd: snapshot.session.cwd ?? null,
        createdAt: snapshot.session.createdAt ?? null,
      },
      fromSeq,
      nextSeq,
      hasMore: page.length < items.length,
      items: page,
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
      const root = roots.find(entry => isInside(entry, resolved))
      if (!root) throw rpcError('path-outside', `path is outside the allowed roots: ${input}`)
      return { path: resolved, root }
    }
    throw rpcError('not-found', `no readable path matches: ${input}`)
  }

  async listFiles({ path: input } = {}) {
    const resolved = input ? await this.resolveReadable(input) : await this.resolveRootPath()
    const entries = fs.readdirSync(resolved.path, { withFileTypes: true }).map(entry => {
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
