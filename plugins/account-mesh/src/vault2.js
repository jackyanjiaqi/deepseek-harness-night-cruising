/**
 * Hosted vault (NCV2) — cross-restart encrypted containers whose opening key
 * is derived and released by the remote data owner.
 *
 * Roles:
 *  - viewer (A): stores one `.hdr` + `.dat` pair under a local root it chooses;
 *    `.dat` is encrypted with a random DEK; `.hdr` carries DEK wrapped by the
 *    current generation key K_g derived by the owner. A has no usable key at
 *    rest.
 *  - owner (B): keeps `root.key` + `ledger.json`; only releases K_g for a
 *    container it created for the authenticated peer. It never receives
 *    ciphertext and never decrypts for a peer.
 *
 * This is a functional P1: link transport is the existing DTLS + Ed25519
 * authenticated WebRTC channel; the extra X25519 ticket wrapping from the
 * design is intentionally left for a later hardening pass (the ticket is
 * still sent only over the authenticated RPC channel, never written to disk).
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'

import { signBytes, verifyBytes } from './identity.js'

const MAGIC_HDR = 'NCV2'
const MAGIC_DAT = 'NCV2D'
const MAGIC_SINGLE = 'NCV2S'
const VERSION = 3
const SINGLE_HEADER_BYTES = 2048
const NONCE = 12
const TAG = 16
const DEFAULT_KEY_TTL = 10 * 60 * 1000
const DEFAULT_APPROVAL_TIMEOUT = 60 * 1000
const DEFAULT_RETENTION_DAYS = 30

const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest()
const hashHex = value => sha256(Buffer.from(String(value))).toString('hex')
const b64u = buffer => Buffer.from(buffer).toString('base64url')
const fromB64u = value => Buffer.from(String(value), 'base64url')

function hkdf(ikm, salt, info) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from(info), 32))
}

function encryptBox(key, plaintext, aad) {
  const nonce = crypto.randomBytes(NONCE)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(aad))
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([nonce, cipher.getAuthTag(), body])
}

function decryptBox(key, box, aad) {
  if (box.length < NONCE + TAG) throw new Error('vault box is truncated')
  const nonce = box.subarray(0, NONCE)
  const tag = box.subarray(NONCE, NONCE + TAG)
  const body = box.subarray(NONCE + TAG)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAAD(Buffer.from(aad))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()])
}

function memberAad(type, version, aadBase) {
  return `data|${type}|${aadBase}${type === 'projection' ? `|proj${version}` : ''}`
}

/** Pack typed encrypted members into the NCV2D member table. */
function packMembers(members) {
  const chunks = [Buffer.from(MAGIC_DAT, 'ascii'), Buffer.from([VERSION])]
  const count = Buffer.alloc(2)
  count.writeUInt16BE(members.length)
  chunks.push(count)
  for (const member of members) {
    const type = Buffer.from(String(member.type), 'utf8')
    const typeLength = Buffer.from([type.length])
    const boxLength = Buffer.alloc(4)
    boxLength.writeUInt32BE(member.box.length)
    chunks.push(typeLength, type, boxLength, member.box)
  }
  return Buffer.concat(chunks)
}

/** Read the typed member table; unknown member types are retained for future callers. */
function parseMembers(data, offset = 0) {
  if (data.length < offset + 7 || data.subarray(offset, offset + 5).toString('ascii') !== MAGIC_DAT) {
    throw new Error('bad NCV2 data')
  }
  let cursor = offset + 5
  const version = data.readUInt8(cursor++)
  if (version !== 2 && version !== VERSION) throw new Error('bad NCV2 data version')
  if (version === 2) return { version, members: [{ type: 'archive', box: readV2Box(data, cursor, 0) }, { type: 'projection', box: readV2Box(data, cursor, 1) }], end: data.length }
  const count = data.readUInt16BE(cursor); cursor += 2
  const members = []
  for (let index = 0; index < count; index += 1) {
    const typeLength = data.readUInt8(cursor++); const type = data.subarray(cursor, cursor + typeLength).toString('utf8'); cursor += typeLength
    const boxLength = data.readUInt32BE(cursor); cursor += 4
    if (cursor + boxLength > data.length) throw new Error('bad NCV2 member')
    members.push({ type, box: data.subarray(cursor, cursor + boxLength) })
    cursor += boxLength
  }
  return { version, members, end: cursor }
}

function readV2Box(data, offset, index) {
  const archiveLength = data.readUInt32BE(offset)
  if (index === 0) return data.subarray(offset + 4, offset + 4 + archiveLength)
  const second = offset + 4 + archiveLength
  const length = data.readUInt32BE(second)
  return data.subarray(second + 4, second + 4 + length)
}

function defaultRoot(peer, base = process.cwd()) {
  return path.join(base, '.night-cruising', 'vault', safeSegment(peer).slice(0, 24))
}

function safeSegment(value) {
  const text = String(value ?? '').replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '')
  return text || 'item'
}

function workspaceRelative(cwd) {
  const parts = String(cwd ?? '').split(/[\\/]+/).filter(Boolean).filter(part => part !== '..' && part !== '.')
  const safe = parts.map(safeSegment).slice(-3)
  return safe.length > 0 ? path.join(...safe) : 'workspace'
}

function sameKey(a, b) { return a === b }

export class HostedVault {
  constructor({ dataDir, config = {}, log, identity, statSession }) {
    this.dataDir = dataDir
    this.config = config
    this.format = config.vaultFormat === 'split' ? 'split' : 'single'
    this.log = log
    this.identity = identity
    this.statSession = statSession
    this.baseDir = path.join(dataDir, 'hosted-vault')
    this.ledgerPath = path.join(this.baseDir, 'ledger.json')
    this.rootKeyPath = path.join(this.baseDir, 'root.key')
    this.settingsPath = path.join(this.baseDir, 'host-settings.json')
    this.indexPath = path.join(this.baseDir, 'index.json')
    this.ledger = { version: 1, entries: {} }
    this.settings = { version: 1, roots: {}, pending: {}, owner: {}, releasePending: {}, releaseApprovals: {} }
    this.index = { version: 1, containers: {} }
    this.rootKey = undefined
    this.ready = this.#init()
  }

  async #init() {
    await fsp.mkdir(this.baseDir, { recursive: true, mode: 0o700 })
    this.rootKey = await this.#loadRootKey()
    this.ledger = await this.#readJson(this.ledgerPath, this.ledger)
    this.settings = await this.#readJson(this.settingsPath, this.settings)
    this.settings.owner ??= {}
    this.settings.releasePending ??= {}
    this.settings.releaseApprovals ??= {}
    this.index = await this.#readJson(this.indexPath, this.index)
    await this.#prune()
  }

  async #readJson(file, fallback) {
    try {
      const parsed = JSON.parse(await fsp.readFile(file, 'utf8'))
      return parsed && typeof parsed === 'object' ? parsed : fallback
    } catch {
      return fallback
    }
  }

  async #writeJson(file, value) {
    const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
    await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await fsp.rename(temporary, file)
  }

  async #loadRootKey() {
    try {
      const key = await fsp.readFile(this.rootKeyPath)
      if (key.length === 32) return key
    } catch {
      // create below
    }
    const key = crypto.randomBytes(32)
    await fsp.writeFile(this.rootKeyPath, key, { mode: 0o600 })
    return key
  }

  async #prune() {
    const now = Date.now()
    for (const [id, pending] of Object.entries(this.settings.pending ?? {})) {
      if (pending.expiresAt <= now) {
        pending.denied = true
        pending.deniedReason = 'timeout'
        pending.expiresAt = now
      }
    }
    const retention = Math.max(1, Number(this.config.vaultRetentionDays ?? DEFAULT_RETENTION_DAYS)) * 86_400_000
    for (const [id, entry] of Object.entries(this.ledger.entries ?? {})) {
      if (entry.superseded || entry.revoked) continue
      if (now - (entry.lastUsedAt ?? entry.createdAt ?? 0) > retention) entry.revoked = true
    }
    await this.#writeJson(this.settingsPath, this.settings)
    await this.#writeJson(this.ledgerPath, this.ledger)
  }

  /** Read a timeout row from the Night Cruising footer store, if present. */
  async footerTimeout(key, fallback) {
    try {
      const home = process.env.DSH_HOME ?? path.join(process.env.HOME ?? '', '.dsh')
      const parsed = JSON.parse(await fsp.readFile(path.join(home, 'night-cruising', 'timeouts.json'), 'utf8'))
      const value = parsed?.values?.[key]
      return Number.isSafeInteger(value) && value > 0 ? value : fallback
    } catch {
      return fallback
    }
  }

  async #saveSettings() { await this.#writeJson(this.settingsPath, this.settings) }
  async #saveLedger() { await this.#writeJson(this.ledgerPath, this.ledger) }
  async #saveIndex() { await this.#writeJson(this.indexPath, this.index) }

  async #writable(dir) {
    try {
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
      const probe = path.join(dir, `.nc-write-${process.pid}-${crypto.randomBytes(3).toString('hex')}`)
      await fsp.writeFile(probe, 'ok', { mode: 0o600 })
      await fsp.unlink(probe)
      return true
    } catch {
      return false
    }
  }

  /** Host/viewer root for one peer, creating default or a timed pending request. */
  async ensureRoot(peerId) {
    await this.ready
    const existing = this.settings.roots?.[peerId]
    if (existing?.root && await this.#writable(existing.root)) return existing.root
    if (existing?.root) {
      await this.#requestRoot(peerId, 'not-writable')
      throw this.#rootError(peerId, '目录不可写，需要本机用户重新选择')
    }
    const root = defaultRoot(peerId, this.config.vaultRoot || process.cwd())
    if (await this.#writable(root)) {
      this.settings.roots[peerId] = { root, approvedAt: Date.now() }
      await this.#saveSettings()
      return root
    }
    await this.#requestRoot(peerId, 'default-unwritable')
    throw this.#rootError(peerId, '无法自动创建保险柜目录，需要本机用户选择')
  }

  #rootError(peerId, message) {
    const pending = Object.values(this.settings.pending ?? {}).find(item => item.peerId === peerId && !item.denied)
    const error = new Error(message)
    error.code = 'vault-directory-required'
    error.peerId = peerId
    error.pending = pending ?? null
    return error
  }

  async #requestRoot(peerId, reason) {
    const now = Date.now()
    const timeout = await this.footerTimeout('vault.approvalTimeout', Number(this.config.vaultApprovalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT))
    const id = b64u(crypto.randomBytes(12))
    const previous = Object.values(this.settings.pending ?? {}).find(item => item.peerId === peerId && !item.denied)
    const pending = {
      id,
      peerId,
      reason,
      suggestedRoot: previous?.suggestedRoot ?? this.settings.roots?.[peerId]?.root ?? defaultRoot(peerId, this.config.vaultRoot || process.cwd()),
      createdAt: previous?.createdAt ?? now,
      expiresAt: now + timeout,
      attempts: (previous?.attempts ?? 0) + 1,
    }
    this.settings.pending[id] = pending
    await this.#saveSettings()
    return pending
  }

  /** Local user chose a directory; validate writability and approve the peer. */
  async setRoot(peerId, root) {
    await this.ready
    const resolved = path.resolve(String(root ?? ''))
    if (!resolved) throw Object.assign(new Error('目录不能为空'), { code: 'vault-bad-directory' })
    const existing = this.settings.roots?.[peerId]?.root
    const containers = this.#entriesForPeer(peerId)
    if (containers.length > 0 && existing !== resolved) {
      throw Object.assign(new Error('该设备的保险柜仍有内容；请先删除内容，再更换目录'), { code: 'vault-not-empty' })
    }
    if (!(await this.#writable(resolved))) {
      throw Object.assign(new Error('目录不可写'), { code: 'vault-bad-directory' })
    }
    this.settings.roots[peerId] = { root: resolved, approvedAt: Date.now(), clearedAt: containers.length === 0 ? Date.now() : undefined }
    for (const [id, pending] of Object.entries(this.settings.pending ?? {})) {
      if (pending.peerId === peerId && !pending.denied) delete this.settings.pending[id]
    }
    await this.#saveSettings()
    return this.settings.roots[peerId]
  }

  #entriesForPeer(peerId) {
    return Object.entries(this.index.containers ?? {}).filter(([, entry]) => entry.peerId === peerId)
  }

  /**
   * Host-side deletion of every encrypted artifact for one peer. The peer's
   * root entry remains so the local user can inspect it; only after this
   * succeeds may the root be changed.
   */
  async deletePeerVault(peerId) {
    await this.ready
    const entries = this.#entriesForPeer(peerId)
    for (const [hash, entry] of entries) {
      delete this.index.containers[hash]
      await Promise.all([entry.singlePath ? fsp.unlink(entry.singlePath).catch(() => {}) : Promise.resolve(), entry.hdrPath ? fsp.unlink(entry.hdrPath).catch(() => {}) : Promise.resolve(), entry.datPath ? fsp.unlink(entry.datPath).catch(() => {}) : Promise.resolve()])
    }
    if (this.settings.roots?.[peerId]) this.settings.roots[peerId].clearedAt = Date.now()
    await this.#saveIndex()
    await this.#saveSettings()
    return { ok: true, removed: entries.length }
  }

  async denyPending(id) {
    await this.ready
    const pending = this.settings.pending?.[id]
    if (!pending) return false
    pending.denied = true
    pending.deniedReason = 'local-user'
    await this.#saveSettings()
    return true
  }

  async pending() {
    await this.ready
    const now = Date.now()
    for (const pending of Object.values(this.settings.pending ?? {})) {
      if (!pending.denied && pending.expiresAt <= now) {
        pending.denied = true
        pending.deniedReason = 'timeout'
      }
    }
    await this.#saveSettings()
    return Object.values(this.settings.pending ?? {}).filter(item => !item.denied)
  }

  async openDir(peerId) {
    await this.ready
    const root = this.settings.roots?.[peerId]?.root
    if (!root) throw Object.assign(new Error('该设备还没有保险柜目录'), { code: 'vault-no-root' })
    if (!(await this.#writable(root))) throw Object.assign(new Error('目录不可写'), { code: 'vault-bad-directory' })
    const { spawn } = await import('node:child_process')
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
    const child = spawn(command, [root], { detached: true, stdio: 'ignore' })
    child.unref()
    return root
  }

  /** Read a local container header and paths, if indexed. */
  async openLocal(peerId, sessionId, priority, kind = 'session', objectId = sessionId, variant = priority) {
    await this.ready
    const logical = `${peerId}\u0000${kind}\u0000${objectId}\u0000${variant}`
    const entry = this.index.containers?.[hashHex(logical)]
    if (!entry) return null
    try {
      let header
      if (entry.singlePath) {
        const single = await fsp.readFile(entry.singlePath)
        const headerLength = single.readUInt32BE(0)
        if (headerLength < 2 || 4 + headerLength > SINGLE_HEADER_BYTES || SINGLE_HEADER_BYTES > single.length) throw new Error('bad NCV2S header')
        header = JSON.parse(single.subarray(4, 4 + headerLength).toString('utf8'))
        if (header.magic !== MAGIC_HDR || header.version !== VERSION) throw new Error('bad NCV2S container')
        entry.lastUsedAt = Date.now()
        await this.#saveIndex()
        return { entry, header, single }
      }
      header = JSON.parse(await fsp.readFile(entry.hdrPath, 'utf8'))
      if (header.magic !== MAGIC_HDR || ![2, VERSION].includes(header.version)) throw new Error('bad NCV2 header')
      if (!(await fsp.stat(entry.datPath)).isFile()) throw new Error('missing NCV2 data')
      entry.lastUsedAt = Date.now()
      await this.#saveIndex()
      return { entry, header }
    } catch (error) {
      this.log?.warn?.(`hosted vault local entry unusable: ${error.message}`)
      await this.deleteLocal(peerId, sessionId, priority, kind, objectId, variant)
      return null
    }
  }

  /** Decrypt one local container with a released generation key. */
  async decrypt(local, key) {
    const header = local.header
    const dat = local.single ? local.single.subarray(SINGLE_HEADER_BYTES) : await fsp.readFile(local.entry.datPath)
    const aadBase = `${header.depositId}|${header.archiveSha}`
    const dek = decryptBox(key, fromB64u(header.wrap), `hdr|${header.depositId}|${header.gen}|${header.archiveSha}`)
    const archiveBox = this.#readDatBox(dat, 0)
    const projectionBox = this.#readDatBox(dat, 1)
    const archive = decryptBox(dek, archiveBox, `data|archive|${aadBase}`)
    let projection
    try {
      projection = JSON.parse(zlib.gunzipSync(decryptBox(dek, projectionBox, `data|projection|${aadBase}|proj1`)).toString('utf8'))
    } catch {
      projection = undefined
    }
    return { archive, projection }
  }

  /** Encrypt and atomically install one container after a full JLC pull. */
  async store({ peerId, sessionId, priority, kind = 'session', objectId = sessionId, variant = priority, archive, items, dialogItems, vault, sessionCwd }) {
    await this.ready
    if (!vault?.depositId || !vault?.key) return null
    const root = await this.ensureRoot(peerId)
    const workspaceDir = path.join(root, kind, workspaceRelative(sessionCwd))
    await fsp.mkdir(workspaceDir, { recursive: true, mode: 0o700 })
    const logical = `${peerId}\u0000${kind}\u0000${objectId}\u0000${variant}`
    const base = hashHex(logical).slice(0, 40)
    const hdrPath = path.join(workspaceDir, `${base}.hdr`)
    const datPath = path.join(workspaceDir, `${base}.dat`)
    const singlePath = path.join(workspaceDir, `${base}.ncv2`)
    const dek = crypto.randomBytes(32)
    const depositId = String(vault.depositId)
    const archiveSha = vault.archiveSha ?? sha256(archive).toString('hex')
    const gen = Number(vault.gen ?? 0)
    const aad = `${depositId}|${archiveSha}`
    const archiveBox = encryptBox(dek, archive, `data|archive|${aad}`)
    const projection = zlib.gzipSync(Buffer.from(JSON.stringify({ version: 1, archiveSha, items, dialogItems })))
    const projectionBox = encryptBox(dek, projection, `data|projection|${aad}|proj1`)
    const dat = Buffer.alloc(5 + 1 + 4 + archiveBox.length + 4 + projectionBox.length)
    dat.write(MAGIC_DAT, 0, 'ascii'); dat.writeUInt8(VERSION, 5)
    dat.writeUInt32BE(archiveBox.length, 6); archiveBox.copy(dat, 10)
    dat.writeUInt32BE(projectionBox.length, 10 + archiveBox.length); projectionBox.copy(dat, 14 + archiveBox.length)
    const key = fromB64u(vault.key)
    const wrapped = encryptBox(key, dek, `hdr|${depositId}|${gen}|${archiveSha}`)
    const header = { magic: MAGIC_HDR, version: VERSION, gen, kind, variant, priority, objectIdHash: hashHex(objectId), depositId, archiveSha, wrap: b64u(wrapped), createdAt: Date.now() }
    if (this.format === 'single') {
      const headerBytes = Buffer.from(JSON.stringify(header), 'utf8')
      if (headerBytes.length > SINGLE_HEADER_BYTES - 4) throw new Error('NCV2S header is too large')
      const single = Buffer.alloc(SINGLE_HEADER_BYTES + dat.length)
      single.writeUInt32BE(headerBytes.length, 0); headerBytes.copy(single, 4)
      dat.copy(single, SINGLE_HEADER_BYTES)
      const tmp = `${singlePath}.${process.pid}.tmp`
      await fsp.writeFile(tmp, single, { mode: 0o600 }); await fsp.rename(tmp, singlePath)
      await Promise.all([fsp.unlink(hdrPath).catch(() => {}), fsp.unlink(datPath).catch(() => {})])
      this.index.containers[hashHex(logical)] = { peerId, sessionIdHash: hashHex(sessionId), objectIdHash: hashHex(objectId), kind, variant, priority, depositId, archiveSha, singlePath, bytes: single.length, lastUsedAt: Date.now() }
      await this.#saveIndex()
      return { singlePath, bytes: single.length }
    }
    const datTmp = `${datPath}.${process.pid}.tmp`
    await fsp.writeFile(datTmp, dat, { mode: 0o600 }); await fsp.rename(datTmp, datPath)
    const hdrTmp = `${hdrPath}.${process.pid}.tmp`
    await fsp.writeFile(hdrTmp, `${JSON.stringify(header, null, 2)}\n`, { mode: 0o600 }); await fsp.rename(hdrTmp, hdrPath)
    this.index.containers[hashHex(logical)] = { peerId, sessionIdHash: hashHex(sessionId), objectIdHash: hashHex(objectId), kind, variant, priority, depositId, archiveSha, hdrPath, datPath, bytes: dat.length, lastUsedAt: Date.now() }
    await this.#saveIndex()
    return { hdrPath, datPath, bytes: dat.length }
  }

  /**
   * Generic object write for future radio/game payloads. `data` is the primary
   * binary member; `metadata` is the encrypted projection/sidecar member.
   */
  async storeObject({ peerId, kind, objectId, variant = 'default', data, metadata = null, vault, sessionCwd }) {
    return this.store({
      peerId,
      sessionId: objectId,
      priority: variant,
      kind,
      objectId,
      variant,
      archive: Buffer.from(data),
      items: metadata ?? {},
      dialogItems: [],
      vault,
      sessionCwd,
    })
  }

  /** Re-wrap DEK into the next generation and replace only the header. */  /** Re-wrap DEK into the next generation and replace only the header. */
  async rewrap(local, currentKey, nextKey, nextGen) {
    const header = local.header
    const dek = decryptBox(currentKey, fromB64u(header.wrap), `hdr|${header.depositId}|${header.gen}|${header.archiveSha}`)
    const wrapped = encryptBox(nextKey, dek, `hdr|${header.depositId}|${nextGen}|${header.archiveSha}`)
    const next = { ...header, gen: nextGen, wrap: b64u(wrapped) }
    if (local.single) {
      const headerBytes = Buffer.from(JSON.stringify(next), 'utf8')
      if (headerBytes.length > SINGLE_HEADER_BYTES - 4) throw new Error('NCV2S header is too large')
      const handle = await fsp.open(local.entry.singlePath, 'r+')
      try {
        const region = Buffer.alloc(SINGLE_HEADER_BYTES)
        region.writeUInt32BE(headerBytes.length, 0); headerBytes.copy(region, 4)
        await handle.write(region, 0, SINGLE_HEADER_BYTES, 0)
        await handle.sync()
      } finally { await handle.close() }
    } else {
      const tmp = `${local.entry.hdrPath}.${process.pid}.tmp`
      await fsp.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
      await fsp.rename(tmp, local.entry.hdrPath)
    }
    local.header = next
    local.entry.depositId = next.depositId
    local.entry.archiveSha = next.archiveSha
    await this.#saveIndex()
    return next
  }

  async deleteLocal(peerId, sessionId, priority, kind = 'session', objectId = sessionId, variant = priority) {
    await this.ready
    const logicalHash = hashHex(`${peerId}\u0000${kind}\u0000${objectId}\u0000${variant}`)
    const entry = this.index.containers?.[logicalHash]
    if (!entry) return false
    delete this.index.containers[logicalHash]
    await Promise.all([entry.singlePath ? fsp.unlink(entry.singlePath).catch(() => {}) : Promise.resolve(), entry.hdrPath ? fsp.unlink(entry.hdrPath).catch(() => {}) : Promise.resolve(), entry.datPath ? fsp.unlink(entry.datPath).catch(() => {}) : Promise.resolve()])
    await this.#saveIndex()
    return true
  }

  #readDatBox(dat, index) {
    if (dat.length < 10 || dat.subarray(0, 5).toString('ascii') !== MAGIC_DAT) {
      throw new Error('bad NCV2 data')
    }
    if (index === 0) {
      const length = dat.readUInt32BE(6)
      if (10 + length + 4 > dat.length) throw new Error('bad NCV2 archive box')
      return dat.subarray(10, 10 + length)
    }
    const archiveLength = dat.readUInt32BE(6)
    const offset = 10 + archiveLength
    const length = dat.readUInt32BE(offset)
    if (offset + 4 + length > dat.length) throw new Error('bad NCV2 projection box')
    return dat.subarray(offset + 4, offset + 4 + length)
  }

  async #fingerprint(sessionId) {
    if (typeof this.statSession !== 'function') return null
    try {
      return await this.statSession(sessionId)
    } catch {
      return null
    }
  }

  derive(depositId, peerId, archiveSha, gen) {
    return hkdf(this.rootKey, Buffer.from(depositId), `dsh-mesh/vault/v2/K|${peerId}|${archiveSha}|${gen}`)
  }

  /** Owner B: create a deposit and return the K0 wrapped only for this peer. */
  async hostPrepare({ peerId, sessionId, priority, kind = 'session', objectId = sessionId, variant = priority, archiveSha, archiveBytes, sessionCwd }) {
    await this.ready
    const now = Date.now()
    for (const entry of Object.values(this.ledger.entries)) {
      if (entry.peer === peerId && (entry.kind ?? 'session') === kind && (entry.objectId ?? entry.sessionId) === objectId && (entry.variant ?? entry.priority) === variant && !entry.superseded) entry.superseded = true
    }
    const depositId = b64u(crypto.randomBytes(16))
    const fingerprint = await this.#fingerprint(sessionId)
    const keyTtl = await this.#ownerKeyTtl()
    const entry = {
      depositId,
      peer: peerId,
      sessionId,
      kind,
      objectId,
      variant,
      priority,
      archiveSha,
      archiveBytes: Number(archiveBytes ?? 0),
      fingerprint,
      confirmedGen: 0,
      issuedGen: 0,
      keyTtlMs: keyTtl,
      createdAt: now,
      lastUsedAt: now,
      revoked: false,
      superseded: false,
    }
    this.ledger.entries[depositId] = entry
    await this.#saveLedger()
    const k0 = this.derive(depositId, peerId, archiveSha, 0)
    return {
      depositId,
      gen: 0,
      key: b64u(k0),
      archiveSha,
      expiresAt: now + keyTtl,
      sessionCwd: sessionCwd ?? null,
    }
  }

  /** Owner B: release K_gen and K_{gen+1} for one authenticated peer. */
  async hostOpen({ peerId, depositId, gen, challenge, archiveSha, priority, kind = 'session', objectId, variant = priority }) {
    await this.ready
    const entry = this.ledger.entries?.[depositId]
    if (!entry || entry.superseded) return { error: 'unknown' }
    if (entry.peer !== peerId) return { error: 'peer-mismatch' }
    if (entry.revoked) return { error: 'revoked' }
    if (!sameKey(entry.archiveSha, archiveSha) || (entry.variant ?? entry.priority) !== variant) return { error: 'archive-mismatch' }
    if ((entry.kind ?? 'session') !== kind) return { error: 'kind-mismatch' }
    const g = Number(gen)
    if (!Number.isSafeInteger(g) || g < entry.confirmedGen || g > entry.issuedGen) return { error: 'gen-mismatch' }
    const policy = await this.ownerPolicy()
    if (policy.release === 'deny') return { error: 'denied' }
    const now = Date.now()
    if (policy.release === 'confirm') {
      const approvalKey = `${depositId}:${g}`
      const approval = this.settings.releaseApprovals?.[approvalKey]
      if (!approval || approval.expiresAt <= now || approval.revoked) {
        const existing = Object.values(this.settings.releasePending ?? {}).find(item => item.depositId === depositId && item.gen === g && !item.denied)
        const id = existing?.id ?? b64u(crypto.randomBytes(12))
        const expiresAt = existing?.expiresAt ?? now + await this.footerTimeout('vault.approvalTimeout', Number(this.config.vaultApprovalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT))
        this.settings.releasePending[id] = { id, peerId, depositId, gen: g, archiveSha: entry.archiveSha, challenge: String(challenge ?? ''), createdAt: existing?.createdAt ?? now, expiresAt }
        await this.#saveSettings()
        return { error: 'confirmation-required', requestId: id, expiresAt }
      }
    }
    const keyTtl = policy.keyTtlMs
    const nextGen = g + 1
    const k = this.derive(depositId, peerId, entry.archiveSha, g)
    const kNext = this.derive(depositId, peerId, entry.archiveSha, nextGen)
    entry.issuedGen = Math.max(entry.issuedGen, nextGen)
    entry.lastUsedAt = now
    await this.#saveLedger()
    const current = await this.#fingerprint(entry.sessionId)
    const fresh = current === null || entry.fingerprint === null
      ? null
      : JSON.stringify(current) === JSON.stringify(entry.fingerprint)
    const ack = {
      ok: true,
      gen: g,
      nextGen,
      key: b64u(k),
      nextKey: b64u(kNext),
      expiresAt: now + keyTtl,
      challenge: String(challenge ?? ''),
      fresh,
      fingerprint: current,
    }
    // Signature binds the response to this deposit, generation, archive hash
    // and challenge. The viewer verifies it with B's hello public key.
    const payload = JSON.stringify({ depositId, gen: g, nextGen, archiveSha: entry.archiveSha, kind, variant, challenge: ack.challenge, expiresAt: ack.expiresAt, fresh })
    ack.sig = signBytes(this.identity.privateKey, payload)
    ack.payload = payload
    return ack
  }

  async hostCommit({ peerId, depositId, gen }) {
    await this.ready
    const entry = this.ledger.entries?.[depositId]
    if (!entry || entry.peer !== peerId) return { error: 'unknown' }
    if (entry.revoked) return { error: 'revoked' }
    const g = Number(gen)
    if (!Number.isSafeInteger(g) || g < entry.confirmedGen || g > entry.issuedGen) return { error: 'gen-mismatch' }
    entry.confirmedGen = g
    entry.lastUsedAt = Date.now()
    await this.#saveLedger()
    return { ok: true, gen: g }
  }

  /** Owner approves one remote release request; the next vault/open succeeds. */
  async approveRelease(id) {
    await this.ready
    const request = this.settings.releasePending?.[id]
    if (!request || request.denied) return false
    const policy = await this.ownerPolicy()
    this.settings.releaseApprovals[`${request.depositId}:${request.gen}`] = { expiresAt: Date.now() + policy.keyTtlMs }
    delete this.settings.releasePending[id]
    await this.#saveSettings()
    return true
  }

  async denyRelease(id) {
    await this.ready
    const request = this.settings.releasePending?.[id]
    if (!request) return false
    request.denied = true
    request.deniedReason = 'local-user'
    await this.#saveSettings()
    return true
  }

  async revokePeer(peerId) {
    await this.ready
    let count = 0
    for (const entry of Object.values(this.ledger.entries)) {
      if (entry.peer === peerId && !entry.revoked) { entry.revoked = true; count += 1 }
    }
    await this.#saveLedger()
    return { ok: true, revoked: count }
  }

  async revokeDeposit(depositId) {
    await this.ready
    const entry = this.ledger.entries?.[depositId]
    if (!entry) return false
    entry.revoked = true
    await this.#saveLedger()
    return true
  }

  async #ownerKeyTtl() {
    return (await this.ownerPolicy()).keyTtlMs
  }

  async ownerPolicy() {
    const footerKeyTtl = await this.footerTimeout('vault.keyTtl', 0)
    const stored = this.settings.owner ?? {}
    return {
      release: stored.release ?? this.config.vaultRelease ?? 'auto',
      keyTtlMs: footerKeyTtl || Number(stored.keyTtlMs ?? this.config.vaultKeyTtlMs ?? DEFAULT_KEY_TTL),
      retentionDays: Number(stored.retentionDays ?? this.config.vaultRetentionDays ?? DEFAULT_RETENTION_DAYS),
    }
  }

  /** Owner-side settings: release policy, key lifetime and retention. */
  async updateOwnerPolicy({ release, keyTtlMs, retentionDays }) {
    await this.ready
    const allowed = new Set(['auto', 'confirm', 'deny'])
    if (release !== undefined && !allowed.has(release)) throw Object.assign(new Error('release must be auto, confirm or deny'), { code: 'vault-bad-policy' })
    if (keyTtlMs !== undefined && (!Number.isSafeInteger(Number(keyTtlMs)) || Number(keyTtlMs) < 1000)) throw Object.assign(new Error('keyTtlMs must be an integer >= 1000'), { code: 'vault-bad-policy' })
    if (retentionDays !== undefined && (!Number.isSafeInteger(Number(retentionDays)) || Number(retentionDays) < 1)) throw Object.assign(new Error('retentionDays must be an integer >= 1'), { code: 'vault-bad-policy' })
    this.settings.owner = {
      ...(this.settings.owner ?? {}),
      ...(release === undefined ? {} : { release }),
      ...(keyTtlMs === undefined ? {} : { keyTtlMs: Number(keyTtlMs) }),
      ...(retentionDays === undefined ? {} : { retentionDays: Number(retentionDays) }),
    }
    await this.#saveSettings()
    return this.ownerPolicy()
  }

  async hostState() {
    await this.ready
    const roots = Object.entries(this.settings.roots ?? {}).map(([peerId, value]) => {
      const entries = this.#entriesForPeer(peerId)
      return { peerId, root: value.root, approvedAt: value.approvedAt, clearedAt: value.clearedAt, containers: entries.length, bytes: entries.reduce((sum, [, entry]) => sum + (entry.bytes ?? 0), 0), kinds: [...new Set(entries.map(([, entry]) => entry.kind ?? 'session'))] }
    })
    const pending = await this.pending()
    const ownerPeersMap = new Map()
    for (const entry of Object.values(this.ledger.entries ?? {})) {
      if (entry.revoked || entry.superseded) continue
      const current = ownerPeersMap.get(entry.peer) ?? { peerId: entry.peer, entries: 0, bytes: 0, kinds: new Set(), lastUsedAt: 0 }
      current.entries += 1
      current.bytes += Number(entry.archiveBytes ?? 0)
      current.kinds.add(entry.kind ?? 'session')
      current.lastUsedAt = Math.max(current.lastUsedAt, Number(entry.lastUsedAt ?? 0))
      ownerPeersMap.set(entry.peer, current)
    }
    return {
      roots,
      pending: pending.map(({ id, peerId, reason, suggestedRoot, expiresAt, createdAt, attempts }) => ({ id, peerId, reason, suggestedRoot, expiresAt, createdAt, attempts })),
      ownerPeers: [...ownerPeersMap.values()].map(item => ({ ...item, kinds: [...item.kinds] })),
      releasePending: Object.values(this.settings.releasePending ?? {}).filter(item => !item.denied && item.expiresAt > Date.now()).map(({ id, peerId, depositId, gen, createdAt, expiresAt }) => ({ id, peerId, depositId, gen, createdAt, expiresAt })),
      policy: await this.ownerPolicy(),
    }
  }

  /** Synchronous aggregate snapshot for the existing sync Mesh.state() shape. */
  snapshot() {
    const containers = Object.values(this.index.containers ?? {})
    return {
      mode: 'hosted',
      containers: containers.length,
      bytes: containers.reduce((sum, item) => sum + (item.bytes ?? 0), 0),
      peers: Object.keys(this.settings.roots ?? {}).length,
      pending: Object.values(this.settings.pending ?? {}).filter(item => !item.denied).length,
    }
  }

  async state() {
    await this.ready
    return {
      ...this.snapshot(),
      pending: (await this.pending()).length,
      owner: await this.ownerPolicy(),
    }
  }

  async clearLocal() {
    await this.ready
    this.index.containers = {}
    await this.#saveIndex()
    return true
  }
}
