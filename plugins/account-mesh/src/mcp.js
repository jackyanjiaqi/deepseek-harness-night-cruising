/**
 * Optional MCP endpoint: exposes the mesh's read-only operations to external
 * MCP clients over the MCP streamable-HTTP transport.
 *
 * The endpoint runs on its own HTTP listener (`mcpPort`) rather than the Host's
 * webServer route, so an external client does not need the Host's browser
 * session cookie. It is off unless `mcpPort` is configured. Every tool is
 * read-only: it maps 1:1 onto the same operation whitelist the agent tools use,
 * and there is no write, prompt, shell or arbitrary-command path.
 *
 * Authentication: when `mcpToken` is set, requests must carry
 * `Authorization: Bearer <mcpToken>`. Without it the endpoint binds to
 * `127.0.0.1` only.
 */
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { rpcError } from './data.js'

const PROTOCOL_VERSION = '2025-06-18'
const SERVER_NAME = 'dsh-account-mesh'
const SERVER_VERSION = '0.1.0'

const PEER_SCHEMA = {
  type: 'string',
  description: 'Peer device: full device id, short id shown by mesh_peers, or the peer display name.',
}

/** MCP tool catalogue; each maps onto one read-only mesh operation. */
function toolCatalogue(mesh) {
  return [
    {
      name: 'mesh_status',
      description: 'This instance\'s account-mesh status: account, device fingerprint, discovery addresses, channels, trust table.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => mesh.state(),
    },
    {
      name: 'mesh_peers',
      description: 'Peer devices of the same account: online state, link state, latency, trust.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => ({ status: mesh.statusText(), peers: mesh.peerViews() }),
    },
    {
      name: 'mesh_session_list',
      description: 'List sessions on a peer device, newest first. Paged with limit/offset.',
      inputSchema: {
        type: 'object',
        properties: {
          peer: PEER_SCHEMA,
          limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Page size. Default 50.' },
          offset: { type: 'integer', minimum: 0, description: 'Skip this many sessions. Default 0.' },
        },
        required: ['peer'],
        additionalProperties: false,
      },
      run: async args => mesh.call(args.peer, 'sessions/list', {
        limit: clampInt(args.limit, 1, 500, 50),
        offset: clampInt(args.offset, 0, 1_000_000, 0),
      }),
    },
    {
      name: 'mesh_session_read',
      description: 'Read one remote session\'s transcript window in seq order; continue with nextSeq while hasMore.',
      inputSchema: {
        type: 'object',
        properties: {
          peer: PEER_SCHEMA,
          sessionId: { type: 'string', description: 'Session id from mesh_session_list.' },
          fromSeq: { type: 'integer', minimum: 0, description: 'First seq to include. Default 0.' },
          limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Maximum items. Default 100.' },
        },
        required: ['peer', 'sessionId'],
        additionalProperties: false,
      },
      run: async args => mesh.call(args.peer, 'sessions/events', {
        sessionId: args.sessionId,
        fromSeq: clampInt(args.fromSeq, 0, Number.MAX_SAFE_INTEGER, 0),
        limit: clampInt(args.limit, 1, 500, 100),
      }),
    },
    {
      name: 'mesh_session_index',
      description: 'Compact index of one remote session: seq, time, role and byte size of every projected item, plus total items and total bytes, without reasoning bodies or tool-call arguments.',
      inputSchema: {
        type: 'object',
        properties: {
          peer: PEER_SCHEMA,
          sessionId: { type: 'string', description: 'Session id from mesh_session_list.' },
        },
        required: ['peer', 'sessionId'],
        additionalProperties: false,
      },
      run: async args => mesh.call(args.peer, 'sessions/index', { sessionId: args.sessionId }),
    },
    {
      name: 'mesh_session_summary',
      description: 'Read one remote session end to end and return its full transcript as plain text, ready to summarise.',
      inputSchema: {
        type: 'object',
        properties: {
          peer: PEER_SCHEMA,
          sessionId: { type: 'string', description: 'Session id from mesh_session_list.' },
          includeToolResults: { type: 'boolean', description: 'Include tool calls and results. Default true.' },
        },
        required: ['peer', 'sessionId'],
        additionalProperties: false,
      },
      run: async args => readWholeSession(mesh, args.peer, args.sessionId, args.includeToolResults !== false),
    },
    {
      name: 'mesh_workspace_list',
      description: 'List workspaces on a peer, or one directory inside a readable root when a path is supplied.',
      inputSchema: {
        type: 'object',
        properties: {
          peer: PEER_SCHEMA,
          path: { type: 'string', description: 'Optional directory: absolute, or relative to an allowed root.' },
        },
        required: ['peer'],
        additionalProperties: false,
      },
      run: async args => args.path === undefined
        ? mesh.call(args.peer, 'workspaces/list', {})
        : mesh.call(args.peer, 'files/list', { path: String(args.path) }),
    },
    {
      name: 'mesh_file_read',
      description: 'Read a text file on a peer by line window, confined to that host\'s readable roots.',
      inputSchema: {
        type: 'object',
        properties: {
          peer: PEER_SCHEMA,
          path: { type: 'string', description: 'Absolute path, or relative to an allowed root on the peer.' },
          offset: { type: 'integer', minimum: 0, description: 'Zero-based first line. Default 0.' },
          limit: { type: 'integer', minimum: 1, maximum: 2000, description: 'Line count. Default 200.' },
        },
        required: ['peer', 'path'],
        additionalProperties: false,
      },
      run: async args => mesh.call(args.peer, 'files/read', {
        path: args.path,
        offset: clampInt(args.offset, 0, Number.MAX_SAFE_INTEGER, 0),
        limit: clampInt(args.limit, 1, 2000, 200),
      }),
    },
  ]
}

/** Page through every event of one session and flatten it into plain text. */
async function readWholeSession(mesh, peer, sessionId, includeTools) {
  const items = []
  let fromSeq = 0
  let session = null
  for (;;) {
    const page = await mesh.call(peer, 'sessions/events', { sessionId, fromSeq, limit: 500 })
    session ??= page.session ?? null
    items.push(...(page.items ?? []))
    if (!page.hasMore || page.nextSeq <= fromSeq) break
    fromSeq = page.nextSeq
  }
  const lines = []
  for (const item of items) {
    if (item.role === 'tool-call' || item.role === 'tool-result') {
      if (!includeTools) continue
      const label = item.role === 'tool-call'
        ? `tool-call ${item.name ?? ''}`
        : item.isError ? 'tool-result error' : 'tool-result'
      lines.push(`[${label}] ${item.text ?? ''}`)
      continue
    }
    lines.push(`[${item.role}] ${item.text ?? ''}`)
    if (item.reasoning) lines.push(`[reasoning] ${item.reasoning}`)
  }
  return { session: session ?? { id: sessionId }, itemCount: items.length, transcript: lines.join('\n\n') }
}

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/** JSON-RPC error carrying an MCP-visible code. */
function rpcFailure(code, message) {
  return { code, message }
}

/** One JSON-RPC request → response payload, or null for notifications. */
async function handleRpc(mesh, tools, message) {
  const { id, method, params } = message ?? {}
  if (typeof method !== 'string') return { jsonrpc: '2.0', id, error: rpcFailure(-32600, 'invalid request') }
  const respond = result => ({ jsonrpc: '2.0', id, result })
  const fail = (code, text) => ({ jsonrpc: '2.0', id, error: rpcFailure(code, text) })
  try {
    if (method === 'initialize') {
      return respond({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      })
    }
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null
    if (method === 'ping') return respond({})
    if (method === 'tools/list') {
      return respond({ tools: tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) })
    }
    if (method === 'tools/call') {
      const name = params?.name
      const tool = tools.find(entry => entry.name === name)
      if (!tool) return fail(-32602, `unknown tool: ${name}`)
      const args = params?.arguments ?? {}
      if (!tool.inputSchema.required.every(key => args[key] !== undefined)) {
        return fail(-32602, `missing required arguments for ${name}`)
      }
      try {
        const result = await tool.run(args)
        return respond({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false })
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : 'internal'
        return respond({ content: [{ type: 'text', text: `${code}: ${error?.message ?? String(error)}` }], isError: true })
      }
    }
    return fail(-32601, `unknown method: ${method}`)
  } catch (error) {
    return fail(-32603, error?.message ?? String(error))
  }
}

/** Read the whole request body, bounded so a client cannot exhaust memory. */
function readBody(request, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('request body is too large'), { status: 413 }))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function authorized(request, token) {
  if (!token) return true
  const header = String(request.headers.authorization ?? '')
  return header === `Bearer ${token}`
}

/**
 * Start the MCP endpoint. Returns a disposer that closes the listener.
 * The endpoint is bound to 127.0.0.1 unless an explicit bind address is set.
 */
export function registerMcp(ctx, mesh, log, config = {}) {
  const port = Number(config.mcpPort)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    log.warn(`account-mesh: mcpPort ${config.mcpPort} is not a valid port; the MCP endpoint stays off`)
    return () => {}
  }
  const path = String(config.mcpPath ?? '/mcp')
  const token = typeof config.mcpToken === 'string' ? config.mcpToken : ''
  const host = String(config.mcpHost ?? (token ? '127.0.0.1' : '127.0.0.1'))
  const tools = toolCatalogue(mesh)
  const sessions = new Map()

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://mesh.local')
    if (url.pathname !== path) {
      response.statusCode = 404
      response.end('not found')
      return
    }
    if (!authorized(request, token)) {
      response.statusCode = 401
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    if (request.method === 'DELETE') {
      sessions.delete(String(request.headers['mcp-session-id'] ?? ''))
      response.statusCode = 204
      response.end()
      return
    }
    if (request.method !== 'POST') {
      response.statusCode = 405
      response.setHeader('allow', 'POST, DELETE')
      response.end('method not allowed')
      return
    }
    let body
    try {
      body = JSON.parse(await readBody(request))
    } catch (error) {
      response.statusCode = error.status ?? 400
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: rpcFailure(-32700, error.message) }))
      return
    }
    const sessionId = String(request.headers['mcp-session-id'] ?? '') || randomBytes(12).toString('base64url')
    sessions.set(sessionId, { at: Date.now() })
    const batch = Array.isArray(body) ? body : [body]
    const replies = []
    for (const message of batch) {
      const reply = await handleRpc(mesh, tools, message)
      if (reply) replies.push(reply)
    }
    response.setHeader('content-type', 'application/json')
    response.setHeader('mcp-session-id', sessionId)
    response.setHeader('cache-control', 'no-store')
    if (replies.length === 0) {
      response.statusCode = 202
      response.end()
      return
    }
    response.statusCode = 200
    response.end(JSON.stringify(Array.isArray(body) ? replies : replies[0]))
  })

  server.on('error', error => log.warn(`account-mesh: mcp endpoint failed: ${error.message}`))
  server.listen(port, host, () => {
    log.info(`account-mesh: mcp endpoint on http://${host}:${port}${path}${token ? ' (bearer token required)' : ''}`)
  })

  return () => {
    try {
      server.close()
    } catch {
      // already closed
    }
  }
}

export { handleRpc, toolCatalogue, readWholeSession, rpcError }
