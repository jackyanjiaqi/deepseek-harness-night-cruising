/**
 * Device identity for the mesh: one Ed25519 key pair per DSH home.
 *
 * The account identifies *which* peers are candidates; this key pair is what
 * a peer actually proves possession of on every connection. It is stored under
 * the plugin's own directory in DSH_HOME (0600) and is never sent anywhere.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const IDENTITY_FILE = 'identity.json'

/** Account candidate tag: stable per account, does not reveal the account id. */
export function accountTagOf(userId) {
  if (!userId) return undefined
  return createHash('sha256').update(`dsh-mesh/v1:${userId}`).digest('base64url').slice(0, 22)
}

/** Fingerprint of a PEM public key: stable across peers. */
export function fingerprintOf(publicKeyPem) {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' })
  return createHash('sha256').update(der).digest('base64url').slice(0, 22)
}

/** Six digits derived from two public keys, order independent. */
export function pairCode(publicKeyA, publicKeyB) {
  const a = fingerprintOf(publicKeyA)
  const b = fingerprintOf(publicKeyB)
  const sorted = a < b ? `${a}:${b}` : `${b}:${a}`
  const n = Number.parseInt(createHash('sha256').update(sorted).digest('hex').slice(0, 12), 16)
  return String(n % 1000000).padStart(6, '0')
}

/** Sign bytes with the stored private key. */
export function signBytes(privateKeyPem, data) {
  return sign(null, Buffer.from(data), createPrivateKey(privateKeyPem)).toString('base64url')
}

/** Verify bytes against a peer public key; never throws. */
export function verifyBytes(publicKeyPem, data, signature) {
  try {
    return verify(null, Buffer.from(data), createPublicKey(publicKeyPem), Buffer.from(signature, 'base64url'))
  } catch {
    return false
  }
}

/** Load this home's key pair, creating it on first use. */
export function loadOrCreateIdentity(dir) {
  const file = path.join(dir, IDENTITY_FILE)
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (typeof saved.privateKey === 'string' && typeof saved.publicKey === 'string') return normalise(saved)
  } catch {
    // fall through to create
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const saved = {
    version: 1,
    createdAt: Date.now(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  writePrivate(file, saved)
  return normalise(saved)
}

function normalise(saved) {
  return {
    createdAt: saved.createdAt,
    privateKey: saved.privateKey,
    publicKey: saved.publicKey,
    fingerprint: fingerprintOf(saved.publicKey),
  }
}

function writePrivate(file, value) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
}
