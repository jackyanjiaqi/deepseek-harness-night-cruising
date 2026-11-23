/**
 * Durable trust list of peer devices.
 *
 * Same-account peers are trusted automatically by default, but every trust
 * decision is recorded with the peer's public key and fingerprint, so the
 * panel can show exactly which device was trusted and when, and the user can
 * revoke it at any time.
 */
import fs from 'node:fs'
import path from 'node:path'

export class TrustStore {
  constructor(file) {
    this.file = file
    this.entries = new Map()
    this.load()
  }

  load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      for (const entry of saved?.peers ?? []) {
        if (entry && typeof entry.deviceId === 'string' && typeof entry.publicKey === 'string') {
          this.entries.set(entry.deviceId, entry)
        }
      }
    } catch {
      // A missing or unreadable store starts empty; trust is re-established by the account rule.
    }
  }

  list() {
    return [...this.entries.values()].sort((a, b) => (b.trustedAt ?? 0) - (a.trustedAt ?? 0))
  }

  get(deviceId) {
    return this.entries.get(deviceId)
  }

  has(deviceId) {
    return this.entries.has(deviceId)
  }

  /**
   * Trust one device. A changed public key replaces the previous binding for
   * that device id and is reported to the caller as `rebound`.
   */
  upsert(entry) {
    const previous = this.entries.get(entry.deviceId)
    const rebound = previous !== undefined && previous.publicKey !== entry.publicKey
    const next = {
      deviceId: entry.deviceId,
      name: entry.name,
      publicKey: entry.publicKey,
      fingerprint: entry.fingerprint,
      accountTag: entry.accountTag,
      trustedAt: rebound || previous === undefined ? Date.now() : previous.trustedAt,
      lastSeen: Date.now(),
    }
    this.entries.set(entry.deviceId, next)
    this.save()
    return { entry: next, rebound }
  }

  touch(deviceId) {
    const entry = this.entries.get(deviceId)
    if (!entry) return
    entry.lastSeen = Date.now()
    this.save()
  }

  remove(deviceId) {
    const removed = this.entries.delete(deviceId)
    if (removed) this.save()
    return removed
  }

  save() {
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, peers: this.list() }, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }
}
