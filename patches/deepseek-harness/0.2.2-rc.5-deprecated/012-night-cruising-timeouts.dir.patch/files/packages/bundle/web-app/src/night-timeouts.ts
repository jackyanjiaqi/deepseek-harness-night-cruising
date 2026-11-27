/**
 * Night Cruising timeout settings: the browser footer's one editable store for
 * every operation timeout the host exposes. The store persists to
 * `$DSH_HOME/night-cruising/timeouts.json`, publishes values to
 * `@deepseek-ai/dsh-timeout` for capability code lookups, and serves the
 * catalog plus current values over an authenticated same-origin route.
 *
 * Model request timeouts are intentionally absent: the desktop policy keeps
 * model requests uncancellable except by the caller. Adding a plugin timeout
 * means adding one catalog entry and mapping its capability code in
 * `@deepseek-ai/dsh-timeout`; the footer renders any number of entries.
 *
 * @module @deepseek-ai/dsh-web-app/night-timeouts
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { configureTimeouts } from '@deepseek-ai/dsh-timeout'

/** Exact same-origin route the footer reads and writes. */
export const NIGHT_TIMEOUT_ROUTE = '/night-cruising/timeouts'

/** Largest accepted request body; the catalog is a few kilobytes at most. */
const MAX_BODY_BYTES = 64 * 1024

/** Milliseconds in one day; every editable value stays a whole millisecond. */
const DAY_MS = 86_400_000

/** One editable timeout row. */
export interface TimeoutEntry {
  /** Settings key consumed by `timeoutSetting()` and the code map. */
  key: string
  /** Chinese footer label. */
  label: string
  /** Optional one-line explanation. */
  hint?: string
  /** Default milliseconds; the footer offers "恢复默认". */
  defaultMs: number
  /** Lowest accepted value. */
  minMs: number
  /** Highest accepted value, at or below Node's timer ceiling. */
  maxMs: number
  /** `true` renders the row read-only (policy-owned values). */
  locked?: boolean
}

/** One visual section of the footer panel. */
export interface TimeoutGroup {
  /** Stable group id. */
  id: string
  /** Chinese section heading. */
  label: string
  /** Optional section explanation. */
  hint?: string
  /** Rows in display order. */
  entries: readonly TimeoutEntry[]
}

/**
 * Catalog shown in the footer. Only capability codes that actually consult the
 * store are listed; a future plugin adds its row here and its code mapping in
 * `@deepseek-ai/dsh-timeout`.
 */
export const NIGHT_TIMEOUT_GROUPS: readonly TimeoutGroup[] = [
  {
    id: 'waits',
    label: '等待与轮询',
    hint: '到期只返回当前状态，不终止在途任务。',
    entries: [
      { key: 'wait.job.default', label: '作业等待', hint: 'job_output 未指定 timeout_ms 时的等待时长。', defaultMs: 30_000, minMs: 1_000, maxMs: 600_000 },
      { key: 'wait.job.max', label: '作业等待上限', hint: '单次 job_output 等待的硬上限。', defaultMs: 600_000, minMs: 1_000, maxMs: DAY_MS },
      { key: 'wait.agent.default', label: '子智能体等待', hint: 'wait_agent 未指定 timeout_ms 时的等待时长。', defaultMs: 30_000, minMs: 10_000, maxMs: 3_600_000 },
      { key: 'wait.agent.max', label: '子智能体等待上限', hint: 'wait_agent 允许指定的最大等待时长。', defaultMs: 3_600_000, minMs: 10_000, maxMs: DAY_MS },
      { key: 'wait.session.default', label: '会话等待', hint: '远端会话状态等待的默认时长。', defaultMs: 30_000, minMs: 1_000, maxMs: 600_000 },
    ],
  },
  {
    id: 'tools',
    label: '工具执行',
    hint: '0 表示不限制，只保留用户主动取消。',
    entries: [
      { key: 'tool.call', label: '工具调用', hint: '工具声明的执行预算上限。', defaultMs: 0, minMs: 0, maxMs: DAY_MS },
      { key: 'tool.bash', label: '命令执行', hint: '单条 Shell 命令的运行上限。', defaultMs: 0, minMs: 0, maxMs: DAY_MS },
      { key: 'tool.persistentBash', label: '持久终端命令', hint: '持久 Bash/Pwsh 会话的单条命令上限。', defaultMs: 0, minMs: 0, maxMs: DAY_MS },
      { key: 'tool.worktree', label: '工作树操作', hint: '创建、清理工作树的上限。', defaultMs: 0, minMs: 0, maxMs: DAY_MS },
      { key: 'web.fetch', label: '网页抓取', hint: '网页抓取请求的上限。', defaultMs: 0, minMs: 0, maxMs: DAY_MS },
    ],
  },
  {
    id: 'services',
    label: '服务维护',
    hint: '关闭与取消的收尾预算，避免退出时无限等待。',
    entries: [
      { key: 'lsp.shutdown', label: 'LSP 关闭', defaultMs: 10_000, minMs: 1_000, maxMs: 600_000 },
      { key: 'lsp.grace', label: 'LSP 取消宽限', defaultMs: 5_000, minMs: 1_000, maxMs: 600_000 },
    ],
  },
  {
    id: 'policy',
    label: '模型请求',
    hint: '仓库政策：模型请求不设应用层超时，只保留用户主动取消。',
    entries: [
      { key: 'llm.request', label: '请求超时', hint: '固定为不限制，不可编辑。', defaultMs: 0, minMs: 0, maxMs: 0, locked: true },
    ],
  },
]

/** Every catalog entry in display order. */
const ENTRIES: readonly TimeoutEntry[] = NIGHT_TIMEOUT_GROUPS.flatMap(group => group.entries)

/** Default values keyed by settings key. */
export const NIGHT_TIMEOUT_DEFAULTS: Readonly<Record<string, number>> = Object.fromEntries(
  ENTRIES.map(entry => [entry.key, entry.defaultMs]),
)

/**
 * Directory holding the persisted bar settings.
 *
 * @returns Absolute `night-cruising` directory under the active DSH home.
 */
function settingsDirectory(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'night-cruising')
}

/** Absolute path of the persisted values file. */
export function nightTimeoutSettingsPath(): string {
  return join(settingsDirectory(), 'timeouts.json')
}

/**
 * Keep only whole, non-negative milliseconds inside Node's timer ceiling.
 *
 * @param value - Candidate from JSON or the footer request.
 * @returns The sanitized value, or `undefined` when it is unusable.
 */
function sanitize(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * Merge persisted values over the catalog defaults.
 *
 * @param stored - Parsed `values` object, already known to be a record.
 * @returns Catalog-shaped values with every default filled in.
 */
function mergeDefaults(stored: Readonly<Record<string, unknown>>): Record<string, number> {
  const values: Record<string, number> = { ...NIGHT_TIMEOUT_DEFAULTS }
  for (const [key, raw] of Object.entries(stored)) {
    const value = sanitize(raw)
    if (value !== undefined) values[key] = value
  }
  return values
}

/**
 * Read the persisted bar values; a missing or malformed file reads as empty.
 *
 * @returns Catalog-shaped values, never throwing for storage problems.
 */
export async function readNightTimeouts(): Promise<Record<string, number>> {
  try {
    const text = await readFile(nightTimeoutSettingsPath(), 'utf8')
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return mergeDefaults({})
    const values = (parsed as { values?: unknown }).values
    if (typeof values !== 'object' || values === null || Array.isArray(values)) return mergeDefaults({})
    return mergeDefaults(values as Record<string, unknown>)
  } catch {
    return mergeDefaults({})
  }
}

/**
 * Validate one submitted value against its catalog row.
 *
 * @param entry - Catalog row that owns the key.
 * @param value - Submitted milliseconds.
 * @returns An error message, or `undefined` when accepted.
 */
function validateValue(entry: TimeoutEntry, value: number): string | undefined {
  if (entry.locked) return `${entry.label} 由仓库政策固定，不可修改`
  if (!Number.isSafeInteger(value)) return `${entry.label} 必须是整数毫秒`
  if (value < entry.minMs) return `${entry.label} 不能小于 ${entry.minMs} 毫秒`
  if (value > entry.maxMs) return `${entry.label} 不能大于 ${entry.maxMs} 毫秒`
  if (entry.key === 'wait.agent.max' && value < (NIGHT_TIMEOUT_DEFAULTS['wait.agent.default'] ?? 0)) {
    return '子智能体等待上限不能小于默认等待'
  }
  return undefined
}

/**
 * Persist the complete values map atomically.
 *
 * @param values - Sanitized catalog values.
 * @returns Resolves after the replacement file is in place.
 */
async function writeNightTimeouts(values: Readonly<Record<string, number>>): Promise<void> {
  const target = nightTimeoutSettingsPath()
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.${String(process.pid)}.tmp`
  await writeFile(temporary, `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), values }, null, 2)}\n`, 'utf8')
  await rename(temporary, target)
}

/** Read a request body with the catalog's small size ceiling. */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Write one JSON response with the footer's no-store policy. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/**
 * Answer the footer route: GET returns the catalog and values, PUT validates
 * and persists one complete values map.
 */
export async function handleNightTimeoutsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  admit: (req: IncomingMessage) => { readonly rejection: 401 | 403 } | { readonly peer: unknown },
): Promise<void> {
  const admission = admit(req)
  if ('rejection' in admission) {
    res.writeHead(admission.rejection)
    res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
    return
  }
  if (req.method === 'GET') {
    sendJson(res, 200, {
      route: NIGHT_TIMEOUT_ROUTE,
      groups: NIGHT_TIMEOUT_GROUPS,
      values: await readNightTimeouts(),
    })
    return
  }
  if (req.method !== 'PUT') {
    res.writeHead(405, { allow: 'GET, PUT' })
    res.end()
    return
  }
  let submitted: unknown
  try {
    submitted = JSON.parse(await readBody(req))
  } catch (error: unknown) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : '请求体不是 JSON' })
    return
  }
  if (typeof submitted !== 'object' || submitted === null || Array.isArray(submitted)) {
    sendJson(res, 400, { error: '请求体必须是对象' })
    return
  }
  const raw = (submitted as { values?: unknown }).values
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    sendJson(res, 400, { error: '缺少 values 对象' })
    return
  }
  const values = await readNightTimeouts()
  for (const entry of ENTRIES) {
    const candidate = (raw as Record<string, unknown>)[entry.key]
    if (candidate === undefined) continue
    const value = sanitize(candidate)
    if (value === undefined) {
      sendJson(res, 400, { error: `${entry.label} 必须是整数毫秒` })
      return
    }
    const problem = validateValue(entry, value)
    if (problem !== undefined) {
      sendJson(res, 400, { error: problem })
      return
    }
    values[entry.key] = value
  }
  await writeNightTimeouts(values)
  configureTimeouts(values)
  sendJson(res, 200, { ok: true, groups: NIGHT_TIMEOUT_GROUPS, values })
}

/**
 * Load persisted values, publish them to the timeout library, and claim the
 * footer route. The route requires the same browser admission as `/api`.
 *
 * @param ctx - Web-app context with `webServer` and `connection` available.
 */
export function installNightTimeouts(ctx: Context): void {
  // Publish before any job/subagent plugin resolves its defaults. A save from
  // the footer republishes synchronously in `handle`.
  void readNightTimeouts().then(values => { configureTimeouts(values) }, () => { configureTimeouts({}) })
  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.effect(() => connectionCtx.webServer.register({
      kind: 'exact',
      path: NIGHT_TIMEOUT_ROUTE,
      handler: (req, res) => handleNightTimeoutsRequest(req, res, request => connectionCtx.connection.admit(request)),
    }), 'web-app: Night Cruising timeout settings')
  })
}
