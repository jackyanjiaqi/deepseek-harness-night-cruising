/**
 * Encrypted, process-lifetime cache for remote session bytes.
 *
 * The vault is deliberately not a user file store: there is no listing or
 * read route, no plaintext names, and no plaintext payload on disk. Each
 * process generates a random 256-bit key that exists only in memory, so a
 * leftover file from a crash is ciphertext without its key. A normal Mesh
 * stop clears the directory; the next start purges stale artifacts.
 *
 * Threat model: this protects against casual disk inspection and keeps remote
 * bytes out of the workspace/UI. It cannot protect against a process with the
 * same OS user reading this process's memory or debugging it.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

const MAGIC = Buffer.from('NCV1', 'ascii')
const VERSION = 1
const NONCE_BYTES = 12
const TAG_BYTES = 16
const HEADER_BYTES = MAGIC.length + 1 + NONCE_BYTES
const EXTENSION = '.ncv'
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024

function safeKey(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

export class EncryptedVault {
  /**
   * @param {object} options
   * @param {string} options.dir private directory under the plugin data dir
   * @param {number} [options.maxBytes] LRU byte cap
   * @param {object} [options.log]
   */
  constructor({ dir, maxBytes = DEFAULT_MAX_BYTES, log }) {
    this.dir = dir
    this.maxBytes = Math.max(0, Number(maxBytes) || DEFAULT_MAX_BYTES)
    this.log = log
    this.key = crypto.randomBytes(32)
    this.entries = new Map()
    this.bytes = 0
    this.ready = this.#initialize()
    this.exitHandler = () => this.clearSync()
  }

  async #initialize() {
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 })
    await this.#purgeStale()
  }

  /** Remove every stale vault artifact at startup; keys are process-local. */
  async #purgeStale() {
    let names = []
    try {
      names = await fsp.readdir(this.dir)
    } catch {
      return
    }
    await Promise.all(names.filter(name => name.endsWith(EXTENSION)).map(async (name) => {
      try {
        await fsp.unlink(path.join(this.dir, name))
      } catch {
        // Best effort: an unreadable orphan is still ciphertext.
      }
    }))
  }

  /** Register process-exit cleanup after the directory is ready. */
  async open() {
    await this.ready
    process.once('exit', this.exitHandler)
    return this
  }

  /** Current aggregate size/entry count; no key or payload is exposed. */
  state() {
    return { bytes: this.bytes, entries: this.entries.size, maxBytes: this.maxBytes }
  }

  /** Read and decrypt one cached archive, or undefined on a miss. */
  async get(logicalKey) {
    await this.ready
    const entry = this.entries.get(String(logicalKey))
    if (!entry) return undefined
    try {
      const encrypted = await fsp.readFile(entry.file)
      const plain = this.#decrypt(encrypted)
      entry.at = Date.now()
      return plain
    } catch (error) {
      this.log?.warn?.(`vault entry unreadable: ${error.message}`)
      await this.delete(logicalKey)
      return undefined
    }
  }

  /** Encrypt and persist one archive; logical keys stay in memory only. */
  async put(logicalKey, payload) {
    await this.ready
    if (this.maxBytes === 0) return
    const key = String(logicalKey)
    if (Buffer.byteLength(payload) > this.maxBytes) return
    const file = path.join(this.dir, `${safeKey(key)}${EXTENSION}`)
    const encrypted = this.#encrypt(Buffer.from(payload))
    const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
    await fsp.writeFile(temporary, encrypted, { mode: 0o600 })
    await fsp.rename(temporary, file)
    const previous = this.entries.get(key)
    if (previous) this.bytes -= previous.bytes
    const entry = { file, bytes: encrypted.length, at: Date.now() }
    this.entries.set(key, entry)
    this.bytes += entry.bytes
    await this.#evict()
  }

  async delete(logicalKey) {
    const key = String(logicalKey)
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    this.bytes -= entry.bytes
    try {
      await fsp.unlink(entry.file)
    } catch {
      // Already gone.
    }
  }

  /** Delete every artifact and clear the in-memory index. */
  async clear() {
    await this.ready
    this.entries.clear()
    this.bytes = 0
    let names = []
    try {
      names = await fsp.readdir(this.dir)
    } catch {
      return
    }
    await Promise.all(names.filter(name => name.endsWith(EXTENSION)).map(name =>
      fsp.unlink(path.join(this.dir, name)).catch(() => {})))
  }

  /** Synchronous best-effort cleanup for `process.exit`/normal shutdown. */
  clearSync() {
    this.entries.clear()
    this.bytes = 0
    try {
      for (const name of fs.readdirSync(this.dir)) {
        if (name.endsWith(EXTENSION) || name.endsWith('.tmp')) {
          try { fs.unlinkSync(path.join(this.dir, name)) } catch { /* best effort */ }
        }
      }
    } catch {
      // Directory already gone.
    }
    process.removeListener('exit', this.exitHandler)
  }

  async #evict() {
    while (this.bytes > this.maxBytes && this.entries.size > 0) {
      let oldestKey
      let oldestAt = Infinity
      for (const [key, entry] of this.entries) {
        if (entry.at < oldestAt) {
          oldestAt = entry.at
          oldestKey = key
        }
      }
      if (oldestKey === undefined) break
      await this.delete(oldestKey)
    }
  }

  #encrypt(payload) {
    const nonce = crypto.randomBytes(NONCE_BYTES)
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, nonce)
    cipher.setAAD(Buffer.concat([MAGIC, Buffer.from([VERSION])]))
    const body = Buffer.concat([cipher.update(payload), cipher.final()])
    const tag = cipher.getAuthTag()
    return Buffer.concat([MAGIC, Buffer.from([VERSION]), nonce, tag, body])
  }

  #decrypt(encrypted) {
    if (encrypted.length < HEADER_BYTES + TAG_BYTES) throw new Error('vault artifact is truncated')
    if (!encrypted.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('vault magic mismatch')
    if (encrypted[MAGIC.length] !== VERSION) throw new Error('vault version mismatch')
    const nonce = encrypted.subarray(MAGIC.length + 1, HEADER_BYTES)
    const tag = encrypted.subarray(HEADER_BYTES, HEADER_BYTES + TAG_BYTES)
    const body = encrypted.subarray(HEADER_BYTES + TAG_BYTES)
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, nonce)
    decipher.setAAD(Buffer.concat([MAGIC, Buffer.from([VERSION])]))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()])
  }
}
