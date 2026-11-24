/**
 * Model-facing tools. Every tool is read-only across the mesh and delegates
 * to the local Mesh runtime; a tool never writes to the remote instance.
 */
const PEER_PARAM = {
  type: 'string',
  description: 'Peer device: full device id, short id shown by mesh_peers, or the peer display name.',
}

function textRender(_args, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

/** Canonical values must be lossless JSON: drop undefined and non-JSON leaves. */
function jsonSafe(value) {
  if (value === undefined || value === null) return null
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return null
  }
}

function define({ name, description, properties = {}, required = [], execute }) {
  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: textRender,
    },
    execute: async (args, exec) => jsonSafe(await execute(args, exec)),
  }
}

export function registerTools(ctx, mesh, log) {
  const tools = ctx.get('tools')
  if (!tools) {
    log.warn('tools service is not mounted; agent tools stay unavailable')
    return
  }
  const register = definition => tools.register(definition)
  const disposers = []

  disposers.push(
    register(
      define({
        name: 'mesh_status',
        description:
          'Show this instance\'s account-mesh status: signed-in account, device fingerprint, LAN/Tailscale discovery addresses, and the trust table of peer devices. Read-only; no remote data is fetched.',
        execute: async () => mesh.state(),
      }),
    ),
  )

  disposers.push(
    register(
      define({
        name: 'mesh_peers',
        description:
          'List peer devices of the same DeepSeek account: online state, link state, latency, and whether the device is trusted. Use the returned id or name with the other mesh_* tools.',
        execute: async () => ({ status: mesh.statusText(), peers: mesh.peerViews() }),
      }),
    ),
  )

  disposers.push(
    register(
      define({
        name: 'mesh_session_list',
        description:
          'List sessions on a peer device, newest first, with title, workspace directory, creation time, and live/persisted availability. Paged with limit/offset.',
        properties: {
          peer: PEER_PARAM,
          limit: { type: 'integer', description: 'Page size, 1-500. Default 50.' },
          offset: { type: 'integer', description: 'Skip this many sessions. Default 0.' },
        },
        required: ['peer'],
        execute: async (args, exec) => {
          const peer = requireString(args, 'peer')
          return mesh.call(
            peer,
            'sessions/list',
            {
              limit: clampInt(args.limit, 1, 500, 50),
              offset: clampInt(args.offset, 0, 1_000_000, 0),
            },
            exec?.signal,
          )
        },
      }),
    ),
  )

  disposers.push(
    register(
      define({
        name: 'mesh_session_summary',
        description:
          'Read one remote session end to end and return its full projected transcript as plain text (user/assistant messages, tool calls, tool results, errors) so the caller can summarise it. Pages internally through sessions/events; returns every item, not a truncated window.',
        properties: {
          peer: PEER_PARAM,
          sessionId: { type: 'string', description: 'Session id from mesh_session_list.' },
          includeToolResults: { type: 'boolean', description: 'Include tool results and tool calls. Default true.' },
        },
        required: ['peer', 'sessionId'],
        execute: async (args, exec) => {
          const peer = requireString(args, 'peer')
          const sessionId = requireString(args, 'sessionId')
          const includeTools = args.includeToolResults !== false
          const items = []
          let fromSeq = 0
          let session = null
          for (;;) {
            const page = await mesh.call(peer, 'sessions/events', { sessionId, fromSeq, limit: 500 }, exec?.signal)
            session ??= page.session ?? null
            items.push(...(page.items ?? []))
            if (!page.hasMore || page.nextSeq <= fromSeq) break
            fromSeq = page.nextSeq
          }
          const lines = []
          for (const item of items) {
            if (item.role === 'tool-call' || item.role === 'tool-result') {
              if (!includeTools) continue
              lines.push(`[${item.role === 'tool-call' ? `tool-call ${item.name ?? ''}` : item.isError ? 'tool-result error' : 'tool-result'}] ${item.text ?? ''}`)
              continue
            }
            lines.push(`[${item.role}] ${item.text ?? ''}`)
            if (item.reasoning) lines.push(`[reasoning] ${item.reasoning}`)
          }
          return {
            session: session ?? { id: sessionId },
            itemCount: items.length,
            transcript: lines.join('\n\n'),
          }
        },
      }),
    ),
  )

  disposers.push(
    register(
      define({
        name: 'mesh_session_read',
        description:
          'Read one remote session\'s transcript window: user and assistant text, tool calls, and tool results, in seq order. Start at fromSeq 0 and continue with the returned nextSeq while hasMore is true.',
        properties: {
          peer: PEER_PARAM,
          sessionId: { type: 'string', description: 'Session id from mesh_session_list.' },
          fromSeq: { type: 'integer', description: 'First seq to include. Default 0.' },
          limit: { type: 'integer', description: 'Maximum projected items, 1-500. Default 100.' },
        },
        required: ['peer', 'sessionId'],
        execute: async (args, exec) => {
          const peer = requireString(args, 'peer')
          const sessionId = requireString(args, 'sessionId')
          return mesh.call(
            peer,
            'sessions/events',
            {
              sessionId,
              fromSeq: clampInt(args.fromSeq, 0, Number.MAX_SAFE_INTEGER, 0),
              limit: clampInt(args.limit, 1, 500, 100),
            },
            exec?.signal,
          )
        },
      }),
    ),
  )

  disposers.push(
    register(
      define({
        name: 'mesh_workspace_list',
        description:
          'List workspaces registered on a peer, or one directory inside a readable root when a path is supplied. Read-only.',
        properties: {
          peer: PEER_PARAM,
          path: { type: 'string', description: 'Optional directory: absolute, or relative to an allowed root.' },
        },
        required: ['peer'],
        execute: async (args, exec) => {
          const peer = requireString(args, 'peer')
          if (args.path === undefined) return mesh.call(peer, 'workspaces/list', {}, exec?.signal)
          return mesh.call(peer, 'files/list', { path: String(args.path) }, exec?.signal)
        },
      }),
    ),
  )

  disposers.push(
    register(
      define({
        name: 'mesh_file_read',
        description:
          'Read a text file on a peer by line window. Paths are confined to that host\'s workspaces, session working directories, and explicitly allowed roots. Returns lines plus hasMore, never a silently truncated file.',
        properties: {
          peer: PEER_PARAM,
          path: { type: 'string', description: 'Absolute path, or relative to an allowed root on the peer.' },
          offset: { type: 'integer', description: 'Zero-based first line. Default 0.' },
          limit: { type: 'integer', description: 'Line count, 1-2000. Default 200.' },
        },
        required: ['peer', 'path'],
        execute: async (args, exec) => {
          const peer = requireString(args, 'peer')
          const filePath = requireString(args, 'path')
          return mesh.call(
            peer,
            'files/read',
            {
              path: filePath,
              offset: clampInt(args.offset, 0, Number.MAX_SAFE_INTEGER, 0),
              limit: clampInt(args.limit, 1, 2000, 200),
            },
            exec?.signal,
          )
        },
      }),
    ),
  )

  disposers.push(
    register(
      define({
        name: 'mesh_peer_pair',
        description:
          'Explicitly trust a currently discovered peer device. Same-account peers are trusted automatically by default; use this after disabling auto trust or to re-bind a device whose key changed.',
        properties: {
          peer: PEER_PARAM,
        },
        required: ['peer'],
        execute: async args => {
          const peer = requireString(args, 'peer')
          const resolved = mesh.resolvePeer(peer)
          if (!resolved) throw new Error(`no peer matches ${peer}`)
          const result = mesh.pair(resolved.peer.deviceId)
          mesh.reconnect(resolved.peer.deviceId)
          return {
            deviceId: resolved.peer.deviceId,
            trustedAt: result.entry.trustedAt,
            fingerprint: result.entry.fingerprint,
            rebound: result.rebound,
          }
        },
      }),
    ),
  )

  disposers.push(
    register(
      define({
        name: 'mesh_peer_forget',
        description: 'Revoke trust for a peer device and close its link. Further reads are refused until the device is trusted again.',
        properties: {
          peer: PEER_PARAM,
        },
        required: ['peer'],
        execute: async args => {
          const peer = requireString(args, 'peer')
          const resolved = mesh.resolvePeer(peer)
          if (!resolved) throw new Error(`no peer matches ${peer}`)
          return { removed: mesh.forget(resolved.peer.deviceId), deviceId: resolved.peer.deviceId }
        },
      }),
    ),
  )

  log.info(`agent tools registered (${disposers.length})`)
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // ignore
      }
    }
  }
}

function requireString(args, name) {
  const value = args?.[name]
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} must be a non-empty string`)
  return value
}

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}
