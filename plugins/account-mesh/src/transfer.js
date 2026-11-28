/**
 * Memory-only JLC session transfer.
 *
 * A sender reads one persisted session artifact, encodes it with the loaded
 * JLC native module and keeps the archive in memory. A receiver pulls the
 * manifest plus binary blocks over the `mesh-bin` data channel, assembles the
 * archive in memory and projects it for the panel/tool. No session byte is
 * written to disk; the only persisted plugin state remains settings.json.
 *
 * The transfer is deliberately not deadline-driven: a call/block ends on a
 * real error, a closed link, or caller cancellation. A lost binary frame
 * leaves the receiver waiting until the caller cancels or the link closes.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'

import { projectEvent } from './data.js'

const MAGIC = 'JLCB'
const VERSION = 1
const MAX_BINARY_FRAME = 240 * 1024
const MAX_BINARY_PAYLOAD = 200 * 1024
const MAX_SENDS = 4
const DEFAULT_CACHE_BYTES = 256 * 1024 * 1024

/** One parsed block from `/sessions/export/prepare`. */
function blockById(manifest, id) {
  return (manifest?.blocks ?? []).find(block => block.id === id)
}

/** Header length of an archive is the first block's offset. */
function headerLength(manifest, archive) {
  return manifest?.blocks?.[0]?.offset ?? archive.length
}

/** Binary frame: magic/version/header length/JSON header + payload. */
function encodeFrame(header, payload) {
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8')
  if (headerBytes.length > 0xffff) throw new Error('JLCB header is too large')
  const out = Buffer.allocUnsafe(4 + 1 + 2 + headerBytes.length + payload.length)
  out.write(MAGIC, 0, 'ascii')
  out.writeUInt8(VERSION, 4)
  out.writeUInt16BE(headerBytes.length, 5)
  headerBytes.copy(out, 7)
  payload.copy(out, 7 + headerBytes.length)
  return out
}

/** Decode one binary frame; returns undefined for unrelated frames. */
function decodeFrame(buffer) {
  if (buffer.length < 7 || buffer.subarray(0, 4).toString('ascii') !== MAGIC) return undefined
  if (buffer.readUInt8(4) !== VERSION) return undefined
  const headerLength = buffer.readUInt16BE(5)
  if (buffer.length < 7 + headerLength) return undefined
  let header
  try {
    header = JSON.parse(buffer.subarray(7, 7 + headerLength).toString('utf8'))
  } catch {
    return undefined
  }
  return { header, payload: buffer.subarray(7 + headerLength) }
}

/** Parse canonical session JSONL into events; the first line is the header. */
function eventsOf(jsonl) {
  const events = []
  for (const line of jsonl.toString('utf8').split('\n')) {
    if (!line) continue
    try {
      const value = JSON.parse(line)
      if (value?.type !== 'session' && typeof value?.seq === 'number') events.push(value)
    } catch {
      // A malformed line cannot be projected; the native decoder already
      // validated the archive, so this is only defensive.
    }
  }
  return events
}

/** Fallback canonical JSONL when the persistence backend has no materialized file. */
function serializeSnapshot(snapshot) {
  const header = snapshot?.session ?? {}
  const line = JSON.stringify({
    type: 'session',
    version: header.version ?? 4,
    id: header.id,
    createdAt: header.createdAt,
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    ...(header.parentSession === undefined ? {} : { parentSession: header.parentSession }),
    isSeeded: header.isSeeded === true,
    ...(header.origin === undefined ? {} : { origin: header.origin }),
    delegationDepth: header.delegationDepth ?? 0,
    ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
  })
  return `${[line, ...(snapshot?.events ?? []).map(event => JSON.stringify(event))].join('\n')}\n`
}

export class TransferManager {
  /**
   * @param {object} options
   * @param {object} options.ctx Cordis context
   * @param {object} [options.config] plugin config (`cacheMaxBytes`, `transferTimeout` absent)
   * @param {object} [options.log] plugin logger
   * @param {object} options.codec CodecController
   */
  constructor({ ctx, config = {}, log, codec, vault = null, hostedVault = null }) {
    this.ctx = ctx
    this.config = config
    this.log = log
    this.codec = codec
    this.vault = vault
    this.hostedVault = hostedVault
    this.sends = new Map()
    this.recvs = new Map()
    this.jsonlJobs = new Map()
    this.cache = new Map()
    this.cacheBytes = 0
    this.maxCacheBytes = Number.isFinite(Number(config.cacheMaxBytes))
      ? Math.max(0, Number(config.cacheMaxBytes))
      : DEFAULT_CACHE_BYTES
    this.lastError = null
  }

  native() {
    const native = this.codec?.getNative?.()
    if (!native || typeof native.encode !== 'function' || typeof native.decode !== 'function') {
      const error = new Error('JLC native codec is not loaded')
      error.code = 'jlc-unavailable'
      throw error
    }
    return native
  }

  /** Logical vault key; it names a peer/session/priority, never a local path. */
  cacheKey(peerId, sessionId, priority) {
    return `jlc\u0000${peerId}\u0000${sessionId}\u0000${priority}`
  }

  /** Decode one complete archive and project both full and staged dialogs. */
  decodeArchive(archive) {
    const native = this.native()
    const plain = native.decode(archive)
    let dialog = Buffer.alloc(0)
    try {
      dialog = native.decodePartial(archive, 0)
    } catch {
      // A full decode succeeded; a dialog projection failure only omits the
      // staged view.
    }
    const events = eventsOf(plain)
    return {
      rawBytes: plain.length,
      archiveBytes: archive.length,
      items: events.map(event => projectEvent(event)).filter(Boolean),
      dialogItems: eventsOf(dialog).map(event => projectEvent(event)).filter(Boolean),
    }
  }

  /** Session cwd for the hosted-vault workspace-relative path. */
  async sessionCwd(sessionId) {
    try {
      const persistence = this.ctx.get('sessionPersistence')
      const snapshot = await persistence?.stat?.(sessionId, {})
      return snapshot?.header?.cwd ?? null
    } catch {
      return null
    }
  }

  /** Sender: read the session artifact and hold its archive in memory. */
  async prepare(params, entry) {
    const native = this.native()
    const sessionId = String(params?.sessionId ?? '')
    if (!sessionId) throw Object.assign(new Error('sessionId is required'), { code: 'bad-request' })
    const raw = await this.readSessionBytes(sessionId)
    const archive = Buffer.from(await native.encodeAsync(raw, String(params?.priority ?? 'dialog')))
    const manifest = JSON.parse(native.manifest(archive))
    const transferId = crypto.randomUUID()
    let vault
    if (this.hostedVault) {
      try {
        vault = await this.hostedVault.hostPrepare({
          peerId: entry?.peer?.deviceId ?? '',
          sessionId,
          priority: String(params?.priority ?? 'dialog'),
          kind: 'session',
          objectId: sessionId,
          variant: String(params?.priority ?? 'dialog'),
          archiveSha: crypto.createHash('sha256').update(archive).digest('hex'),
          archiveBytes: archive.length,
          sessionCwd: await this.sessionCwd(sessionId),
        })
      } catch (error) {
        this.log?.warn?.(`hosted vault prepare failed: ${error.message}`)
      }
    }
    this.sends.set(transferId, {
      peerId: entry?.peer?.deviceId ?? null,
      sessionId,
      archive,
      manifest,
      createdAt: Date.now(),
    })
    while (this.sends.size > MAX_SENDS) this.sends.delete(this.sends.keys().next().value)
    const header = archive.subarray(0, headerLength(manifest, archive))
    return {
      transferId,
      manifest,
      headerBase64: header.toString('base64'),
      headerBytes: header.length,
      archiveBytes: archive.length,
      vault,
    }
  }

  /** Sender: send one block on `mesh-bin` and acknowledge the control call. */
  async block(params, entry) {
    const transferId = String(params?.transferId ?? '')
    const blockId = Number(params?.blockId)
    const send = this.sends.get(transferId)
    if (!send) throw Object.assign(new Error('transfer is not prepared'), { code: 'transfer-unknown' })
    if (entry?.peer?.deviceId !== send.peerId) throw Object.assign(new Error('transfer belongs to another peer'), { code: 'transfer-peer-mismatch' })
    const block = blockById(send.manifest, blockId)
    if (!block) throw Object.assign(new Error('block is out of range'), { code: 'block-unknown' })
    const start = block.offset
    const end = start + 60 + block.compressed
    if (end > send.archive.length) throw Object.assign(new Error('block range exceeds archive'), { code: 'block-corrupt' })
    const payload = send.archive.subarray(start, end)
    const parts = Math.max(1, Math.ceil(payload.length / MAX_BINARY_PAYLOAD))
    for (let part = 0; part < parts; part += 1) {
      const slice = payload.subarray(part * MAX_BINARY_PAYLOAD, (part + 1) * MAX_BINARY_PAYLOAD)
      const frame = encodeFrame({ transferId, blockId, part, parts }, slice)
      if (entry?.link?.sendBinary?.(frame) !== true) {
        throw Object.assign(new Error('binary data channel is not open'), { code: 'binary-unavailable' })
      }
    }
    return { ok: true, blockId, bytes: payload.length, parts }
  }

  /** Sender: release an archive. */
  cancel(params) {
    const transferId = String(params?.transferId ?? '')
    this.sends.delete(transferId)
    return { ok: true }
  }

  /** Receiver: pull every block, assemble in memory and project it. */
  async fetch({ peerId, sessionId, priority = 'dialog', call, onProgress, verifyVault, unsealVault, selfDeviceId }) {
    const native = this.native()
    const vaultKey = this.cacheKey(peerId, sessionId, priority)
    // Hosted NCV2: try a local container and ask the owner for the generation
    // key. Only a signed, peer-bound, generation-valid ticket is accepted.
    if (this.hostedVault) {
      const local = await this.hostedVault.openLocal(peerId, sessionId, priority)
      if (local) {
        try {
          const challenge = crypto.randomBytes(16).toString('base64url')
          const ack = await call(peerId, 'vault/open', {
            depositId: local.header.depositId,
            gen: local.header.gen,
            challenge,
            archiveSha: local.header.archiveSha,
            priority,
            kind: 'session',
            objectId: sessionId,
            variant: priority,
          })
          const hasRaw = typeof ack.key === 'string' && typeof ack.nextKey === 'string'
          const hasBox = typeof ack.keyBox === 'string' && typeof ack.nextKeyBox === 'string'
          if (ack?.ok !== true || (!hasRaw && !hasBox)) {
            throw Object.assign(new Error(`vault open rejected: ${JSON.stringify(ack)}`), { code: `vault-${String(ack?.error ?? 'rejected')}` })
          }
          if (typeof verifyVault === 'function' && !verifyVault(ack)) {
            throw Object.assign(new Error('vault ticket signature is invalid'), { code: 'vault-bad-signature' })
          }
          if (Number(ack.expiresAt) <= Date.now()) {
            throw Object.assign(new Error('vault ticket has expired'), { code: 'vault-expired' })
          }
          let currentKey
          let nextKey
          if (typeof ack.keyBox === 'string' && typeof ack.nextKeyBox === 'string') {
            const aad = `dsh-mesh/vault/v2/wrap|${local.header.depositId}|${local.header.gen}|${local.header.archiveSha}|${String(selfDeviceId ?? '')}`
            currentKey = unsealVault?.(ack.keyBox, aad)
            nextKey = unsealVault?.(ack.nextKeyBox, aad)
            if (!currentKey || !nextKey) throw Object.assign(new Error('vault ticket box is invalid'), { code: 'vault-bad-box' })
          } else {
            currentKey = Buffer.from(ack.key, 'base64url')
            nextKey = Buffer.from(ack.nextKey, 'base64url')
          }
          const opened = await this.hostedVault.decrypt(local, currentKey)
          await this.hostedVault.rewrap(local, currentKey, nextKey, Number(ack.nextGen))
          call(peerId, 'vault/commit', { depositId: local.header.depositId, gen: Number(ack.nextGen) }).catch(error => {
            this.log?.warn?.(`vault commit failed: ${error.message}`)
          })
          const projection = opened.projection
          const decoded = projection?.archiveSha === local.header.archiveSha && Array.isArray(projection.items)
            ? { rawBytes: opened.archive.length, archiveBytes: opened.archive.length, items: projection.items, dialogItems: Array.isArray(projection.dialogItems) ? projection.dialogItems : [] }
            : this.decodeArchive(opened.archive)
          return {
            peerId,
            sessionId,
            transferId: null,
            mode: 'jlc',
            session: { id: sessionId },
            ...decoded,
            headerBytes: 0,
            blocks: 0,
            dialogReadyIncoming: true,
            elapsedMs: 0,
            vaultHit: true,
            vaultFresh: ack.fresh,
          }
        } catch (error) {
          this.log?.warn?.(`hosted vault open failed: ${error.message}`)
          if (/^(vault-(revoked|unknown|peer-mismatch|archive-mismatch|kind-mismatch|gen-mismatch|bad-signature|bad-box|denied))$/.test(String(error.code ?? ''))) {
            await this.hostedVault.deleteLocal(peerId, sessionId, priority)
          }
        }
      }
    }
    try {
      const cached = await this.vault?.get(vaultKey)
      if (cached) {
        const decoded = this.decodeArchive(cached)
        return {
          peerId,
          sessionId,
          transferId: null,
          mode: 'jlc',
          ...decoded,
          headerBytes: 0,
          blocks: 0,
          dialogReadyIncoming: true,
          elapsedMs: 0,
          vaultHit: true,
        }
      }
    } catch (error) {
      this.log?.warn?.(`vault read failed: ${error.message}`)
    }
    const prepare = await call(peerId, 'sessions/export/prepare', { sessionId, priority })
    const transferId = String(prepare?.transferId ?? '')
    if (!transferId || !prepare?.manifest) throw new Error('peer returned an invalid transfer manifest')
    const manifest = prepare.manifest
    const header = Buffer.from(String(prepare.headerBase64 ?? ''), 'base64')
    const totalBytes = (manifest.blocks ?? []).reduce((sum, block) => sum + 60 + block.compressed, header.length)
    const incoming = {
      transferId,
      peerId,
      sessionId,
      manifest,
      header,
      blocks: new Map(),
      partials: new Map(),
      pending: new Map(),
      totalBlocks: manifest.blocks?.length ?? 0,
      receivedBlocks: 0,
      totalBytes,
      receivedBytes: header.length,
      dialogReady: false,
      startedAt: Date.now(),
      phase: 'pulling',
      error: null,
    }
    this.recvs.set(transferId, incoming)
    let hostedStored = false
    const progress = () => {
      onProgress?.(this.progressOf(incoming))
    }
    progress()
    try {
      for (const block of manifest.blocks ?? []) {
        await this.requestBlock(call, incoming, block.id)
        progress()
        if (!incoming.dialogReady && block.prio === 0) {
          const dialogBlocks = (manifest.blocks ?? []).filter(item => item.prio === 0)
          if (dialogBlocks.every(item => incoming.blocks.has(item.id))) {
            incoming.dialogReady = true
            try {
              const partial = this.assemble(incoming, 0)
              const dialog = native.decodePartial(partial, 0)
              incoming.dialogItems = eventsOf(dialog).map(event => projectEvent(event)).filter(Boolean)
            } catch (error) {
              this.log?.warn?.(`dialog projection failed: ${error.message}`)
            }
            progress()
          }
        }
      }
      incoming.phase = 'decoding'
      progress()
      const archive = this.assemble(incoming)
      const decoded = this.decodeArchive(archive)
      // Hosted NCV2: persist archive + projection sidecar in the viewer-chosen
      // root, with DEK wrapped by B's newly issued generation key.
      if (this.hostedVault && prepare?.vault) {
        try {
          await this.hostedVault.store({
            peerId,
            sessionId,
            priority,
            kind: 'session',
            objectId: sessionId,
            variant: priority,
            archive,
            items: decoded.items,
            dialogItems: decoded.dialogItems,
            vault: prepare.vault,
            sessionCwd: prepare.vault.sessionCwd ?? null,
          })
          hostedStored = true
        } catch (error) {
          this.log?.warn?.(`hosted vault store failed: ${error.message}`)
        }
      }
      try {
        await this.vault?.put(vaultKey, archive)
      } catch (error) {
        this.log?.warn?.(`vault write failed: ${error.message}`)
      }
      const result = {
        peerId,
        sessionId,
        transferId,
        mode: 'jlc',
        ...decoded,
        headerBytes: header.length,
        blocks: incoming.receivedBlocks,
        dialogReadyIncoming: incoming.dialogReady,
        elapsedMs: Date.now() - incoming.startedAt,
        vaultHit: false,
        vaultStored: hostedStored,
      }
      incoming.phase = 'done'
      incoming.result = result
      this.putCache(`${peerId}\u0000${sessionId}`, result)
      progress()
      return result
    } catch (error) {
      incoming.phase = 'error'
      incoming.error = error.message
      this.lastError = error
      progress()
      throw error
    } finally {
      // Keep the terminal state for the panel, but release block buffers.
      incoming.blocks.clear()
      incoming.partials.clear()
      incoming.pending.clear()
      this.recvs.delete(transferId)
      // Release the sender's in-memory archive. A failure here only leaves one
      // of the sender's bounded slots occupied until the next prepare evicts it.
      call(peerId, 'sessions/export/cancel', { transferId }).catch(() => {})
    }
  }

  /** Wait for one binary block while its control call is outstanding. */
  requestBlock(call, incoming, blockId) {
    const promise = new Promise((resolve, reject) => {
      incoming.pending.set(blockId, { resolve, reject })
    })
    call(incoming.peerId, 'sessions/export/block', { transferId: incoming.transferId, blockId })
      .catch(error => {
        const pending = incoming.pending.get(blockId)
        incoming.pending.delete(blockId)
        pending?.reject(error)
      })
    return promise
  }

  /** Route one `mesh-bin` frame into the matching receiver. */
  onBinary(buffer) {
    const frame = decodeFrame(buffer)
    if (!frame) return false
    const incoming = this.recvs.get(String(frame.header?.transferId ?? ''))
    if (!incoming) return false
    const blockId = Number(frame.header.blockId)
    const pending = incoming.pending.get(blockId)
    if (!pending) return false
    const part = Number(frame.header.part ?? 0)
    const parts = Number(frame.header.parts ?? 1)
    if (!Number.isSafeInteger(part) || !Number.isSafeInteger(parts) || parts < 1 || part < 0 || part >= parts) return false
    let payload
    if (parts === 1) {
      payload = Buffer.from(frame.payload)
    } else {
      const partial = incoming.partials.get(blockId) ?? { parts: new Array(parts), received: 0 }
      if (partial.parts[part] !== undefined) return false
      partial.parts[part] = Buffer.from(frame.payload)
      partial.received += 1
      incoming.partials.set(blockId, partial)
      if (partial.received < parts) return true
      incoming.partials.delete(blockId)
      payload = Buffer.concat(partial.parts)
    }
    incoming.pending.delete(blockId)
    incoming.blocks.set(blockId, payload)
    incoming.receivedBlocks += 1
    incoming.receivedBytes += 60 + payload.length
    pending.resolve()
    return true
  }

  /**
   * Assemble the archive from header + received blocks. With `onlyPrio`, only
   * blocks at that priority are required and copied; the rest remain holes so
   * `decodePartial` can render the dialog stage before the full pull finishes.
   */
  assemble(incoming, onlyPrio = undefined) {
    let end = incoming.header.length
    const selected = (incoming.manifest.blocks ?? []).filter(block => onlyPrio === undefined || block.prio === onlyPrio)
    for (const block of selected) {
      end = Math.max(end, block.offset + 60 + block.compressed)
    }
    const archive = Buffer.alloc(end)
    incoming.header.copy(archive, 0)
    for (const block of selected) {
      const payload = incoming.blocks.get(block.id)
      if (!payload) throw new Error(`block ${block.id} is missing`)
      payload.copy(archive, block.offset)
    }
    return archive
  }

  /**
   * Native-DSH fallback: page the remote projection serially. Each page is a
   * separate RPC task; the next page starts only after the previous one
   * settles, so a long session shows slow but visible progress instead of one
   * oversized response that fails at the transport edge.
   */
  async fetchJsonl({ peerId, sessionId, call, onProgress }) {
    const transferId = crypto.randomUUID()
    const job = {
      transferId,
      peerId,
      sessionId,
      mode: 'jsonl',
      phase: 'pulling',
      totalItems: 0,
      receivedItems: 0,
      totalBlocks: 1,
      receivedBlocks: 0,
      totalBytes: 0,
      receivedBytes: 0,
      dialogReady: false,
      startedAt: Date.now(),
    }
    this.jsonlJobs.set(transferId, job)
    const progress = () => onProgress?.(this.jsonlProgress(job))
    progress()
    try {
      try {
        const index = await call(peerId, 'sessions/index', { sessionId })
        job.totalItems = Number(index?.totalItems ?? 0)
      } catch {
        // The index is only a progress denominator; continue with pages.
      }
      const items = []
      let fromSeq = 0
      let pages = 0
      const session = { id: sessionId }
      for (;;) {
        const page = await call(peerId, 'sessions/events', { sessionId, fromSeq, limit: 500 })
        if (page?.session) Object.assign(session, page.session)
        items.push(...(page?.items ?? []))
        pages += 1
        job.receivedItems = items.length
        job.receivedBlocks = pages
        job.totalBlocks = Math.max(job.totalBlocks, pages + (page?.hasMore ? 1 : 0))
        job.receivedBytes = items.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item), 'utf8'), 0)
        job.totalBytes = Math.max(job.receivedBytes, job.totalBytes)
        progress()
        if (!page?.hasMore || !Number.isFinite(page?.nextSeq) || page.nextSeq <= fromSeq) break
        fromSeq = page.nextSeq
      }
      const result = {
        peerId,
        sessionId,
        transferId,
        mode: 'jsonl',
        session,
        items,
        dialogItems: items,
        rawBytes: job.receivedBytes,
        archiveBytes: 0,
        headerBytes: 0,
        blocks: pages,
        totalItems: job.totalItems || items.length,
        dialogReadyIncoming: true,
        elapsedMs: Date.now() - job.startedAt,
        vaultHit: false,
      }
      job.phase = 'done'
      this.putCache(`${peerId}\u0000${sessionId}`, result)
      progress()
      return result
    } catch (error) {
      job.phase = 'error'
      job.error = error.message
      progress()
      throw error
    } finally {
      this.jsonlJobs.delete(transferId)
    }
  }

  /** Progress snapshot for one JSONL fallback job. */
  jsonlProgress(job) {
    return {
      transferId: job.transferId,
      peerId: job.peerId,
      sessionId: job.sessionId,
      mode: 'jsonl',
      phase: job.phase,
      totalItems: job.totalItems,
      receivedItems: job.receivedItems,
      totalBlocks: job.totalBlocks,
      receivedBlocks: job.receivedBlocks,
      totalBytes: job.totalBytes,
      receivedBytes: job.receivedBytes,
      dialogReady: false,
      error: job.error,
    }
  }

  /** Progress snapshot for the panel; never exposes session bytes. */  /** Progress snapshot for the panel; never exposes session bytes. */
  progressOf(incoming) {
    return {
      transferId: incoming.transferId,
      mode: 'jlc',
      peerId: incoming.peerId,
      sessionId: incoming.sessionId,
      phase: incoming.phase,
      totalBlocks: incoming.totalBlocks,
      receivedBlocks: incoming.receivedBlocks,
      totalBytes: incoming.totalBytes,
      receivedBytes: incoming.receivedBytes,
      dialogReady: incoming.dialogReady,
      error: incoming.error,
    }
  }

  /** Staged dialog view for one active transfer. */
  dialog(transferId) {
    const incoming = this.recvs.get(String(transferId ?? ''))
    if (!incoming) return { ready: false, items: [] }
    return { ready: incoming.dialogReady === true, items: incoming.dialogItems ?? [] }
  }

  /** Current transfer states (active only; terminal states are dropped). */
  state() {
    return [
      ...this.recvs.values(),
      ...this.jsonlJobs.values(),
    ].map(entry => entry.mode === 'jsonl' ? this.jsonlProgress(entry) : this.progressOf(entry))
  }

  /** Read the current cache stats for `/api/state`. */
  cacheState() {
    return { maxBytes: this.maxCacheBytes, bytes: this.cacheBytes, entries: this.cache.size }
  }

  putCache(key, result) {
    const bytes = result.rawBytes + result.archiveBytes
    const previous = this.cache.get(key)
    if (previous) this.cacheBytes -= previous.bytes
    this.cache.set(key, { result, bytes, at: Date.now() })
    this.cacheBytes += bytes
    while (this.cacheBytes > this.maxCacheBytes && this.cache.size > 1) {
      const oldest = this.cache.keys().next().value
      const entry = this.cache.get(oldest)
      this.cache.delete(oldest)
      this.cacheBytes -= entry.bytes
    }
  }

  /** Metadata/rows from the most recent complete transfer for this peer/session. */
  cached(peerId, sessionId) {
    return this.cache.get(`${peerId}\u0000${sessionId}`)?.result
  }

  /** Read the exact persisted session artifact, or a canonical fallback. */
  async readSessionBytes(sessionId) {
    const sessions = this.ctx.get('sessions')
    const live = sessions?.get?.(sessionId)
    if (live && typeof sessions.flush === 'function') {
      await sessions.flush(live)
    }
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence?.stat) {
      const snapshot = await persistence.stat(sessionId, {})
      const file = snapshot?.location?.path
      if (file) return fs.readFile(file)
    }
    const query = this.ctx.get('sessionQuery')
    if (!query) throw Object.assign(new Error('session persistence is unavailable'), { code: 'service-missing' })
    const snapshot = await query.readSession(sessionId)
    return Buffer.from(serializeSnapshot(snapshot), 'utf8')
  }
}
