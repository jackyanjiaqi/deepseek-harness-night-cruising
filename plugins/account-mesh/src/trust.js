/**
 * Durable trust list of peer devices.
 *
 * Same-account peers are trusted automatically by default, but every trust
 * decision is recorded with the peer's public key and fingerprint, so the
 * panel can show exactly which device was trusted and when, and the user can
 * revoke it at any time.
 *
 * Revocation is a durable state, not a deletion: `revoke()` keeps the entry
 * with `revoked: true` so the account rule cannot silently re-trust the device
 * on the next announce or heartbeat. Only an explicit `pair()` clears it.
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
          this.entries.set(entry.deviceId, { ...entry, revoked: entry.revoked === true })
        }
      }
    } catch {
      // A missing or unreadable store starts empty; trust is re-established by the account rule.
    }
  }

  /** Trusted entries, newest first; revoked entries are reported separately. */
  list() {
    return [...this.entries.values()]
      .filter(entry => entry.revoked !== true)
      .sort((a, b) => (b.trustedAt ?? 0) - (a.trustedAt ?? 0))
  }

  /** Revoked entries, newest revocation first. */
  revokedList() {
    return [...this.entries.values()]
      .filter(entry => entry.revoked === true)
      .sort((a, b) => (b.revokedAt ?? 0) - (a.revokedAt ?? 0))
  }

  get(deviceId) {
    return this.entries.get(deviceId)
  }

  has(deviceId) {
    return this.entries.has(deviceId)
  }

  /** Whether a peer is currently trusted; a revoked entry never counts. */
  isTrusted(deviceId) {
    const entry = this.entries.get(deviceId)
    return entry !== undefined && entry.revoked !== true
  }

  /**
   * Trust one device. A changed public key replaces the previous binding for
   * that device id and is reported to the caller as `rebound`. An explicit
   * upsert clears a previous revocation.
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
      address: entry.address ?? previous?.address ?? null,
      port: entry.port ?? previous?.port ?? null,
      revoked: false,
      revokedAt: null,
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

  /** Record where the peer was last heard; only a changed endpoint is written. */
  rememberEndpoint(deviceId, address, port) {
    const entry = this.entries.get(deviceId)
    if (!entry || entry.revoked === true || !address) return
    if (entry.address === address && entry.port === port) return
    entry.address = address
    entry.port = port
    this.save()
  }

  /**
   * Keep the binding but mark it revoked. The account rule must not re-trust a
   * revoked device; `pair()` is the only way back.
   */
  revoke(deviceId) {
    const entry = this.entries.get(deviceId)
    if (!entry) return undefined
    entry.revoked = true
    entry.revokedAt = Date.now()
    this.save()
    return entry
  }

  remove(deviceId) {
    const removed = this.entries.delete(deviceId)
    if (removed) this.save()
    return removed
  }

  save() {
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    // Revoked entries are persisted too: dropping them would let the account
    // rule re-trust the device on the next announce after a restart.
    const peers = [...this.list(), ...this.revokedList()]
    fs.writeFileSync(tmp, JSON.stringify({ version: 2, peers }, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }
}
