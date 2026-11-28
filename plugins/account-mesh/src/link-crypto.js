/** Per-link X25519 derivation and AES-GCM ticket wrapping for hosted-vault opens. */
import crypto from 'node:crypto'

export function createLinkKeys() {
  return crypto.generateKeyPairSync('x25519')
}

export function exportLinkPublic(pair) {
  return pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
}

export function importLinkPublic(value) {
  return crypto.createPublicKey({ key: Buffer.from(String(value), 'base64url'), format: 'der', type: 'spki' })
}

/** Derive the per-link ticket key from ephemeral X25519 + hello nonce/device ids. */
export function deriveLinkKey(privateKey, peerPublic, nonce, deviceA, deviceB) {
  const secret = crypto.diffieHellman({ privateKey, publicKey: peerPublic })
  const ids = [deviceA, deviceB].sort().join('|')
  return Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.from(String(nonce)), Buffer.from(`dsh-mesh/vault/v2/link|${ids}`), 32))
}

/** Seal one vault key into a base64url box bound to the open request. */
export function sealLinkBox(linkKey, plaintext, aad) {
  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', linkKey, nonce)
  cipher.setAAD(Buffer.from(aad))
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64url')
}

/** Open a sealed vault key; returns undefined on a malformed/foreign box. */
export function openLinkBox(linkKey, box, aad) {
  try {
    const data = Buffer.from(String(box), 'base64url')
    if (data.length < 28) return undefined
    const nonce = data.subarray(0, 12)
    const tag = data.subarray(12, 28)
    const body = data.subarray(28)
    const decipher = crypto.createDecipheriv('aes-256-gcm', linkKey, nonce)
    decipher.setAAD(Buffer.from(aad))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()])
  } catch {
    return undefined
  }
}
