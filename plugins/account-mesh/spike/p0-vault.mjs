/** Encrypted ephemeral vault: at-rest format, no plaintext, purge-on-start/stop. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EncryptedVault } from '../src/vault.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-vault-'))
const log = { warn: (...args) => console.log('[warn]', ...args) }
let failures = 0
const check = (label, condition, detail) => {
  if (condition) console.log(`PASS ${label}`)
  else { failures += 1; console.log(`FAIL ${label}`, detail ?? '') }
}

try {
  const vault = new EncryptedVault({ dir: path.join(root, 'vault'), maxBytes: 1024, log })
  await vault.open()
  const secret = Buffer.from('REMOTE-SESSION-PLAINTEXT-' + 'x'.repeat(200))
  await vault.put('device-b/session-1/dialog', secret)
  const files = fs.readdirSync(path.join(root, 'vault'))
  check('vault creates one encrypted artifact', files.length === 1 && files[0].endsWith('.ncv'), files.join(','))
  const raw = fs.readFileSync(path.join(root, 'vault', files[0]))
  check('artifact has NCV1 header', raw.subarray(0, 4).toString('ascii') === 'NCV1')
  check('artifact does not contain plaintext', !raw.includes(Buffer.from('REMOTE-SESSION-PLAINTEXT')))
  check('artifact mode is owner-only', (fs.statSync(path.join(root, 'vault', files[0])).mode & 0o777) === 0o600)
  const back = await vault.get('device-b/session-1/dialog')
  check('vault round-trips the archive', back?.equals(secret) === true)
  check('vault state is aggregate only', vault.state().entries === 1 && vault.state().bytes > 0 && !('keys' in vault.state()))
  const tampered = Buffer.from(raw)
  tampered[tampered.length - 1] ^= 1
  fs.writeFileSync(path.join(root, 'vault', files[0]), tampered)
  check('tampered artifact is rejected and dropped', (await vault.get('device-b/session-1/dialog')) === undefined && vault.state().entries === 0)

  const crashLeft = new EncryptedVault({ dir: path.join(root, 'crash'), maxBytes: 1024, log })
  await crashLeft.open()
  await crashLeft.put('device-b/session-2/dialog', Buffer.from('leftover'))
  const crashFile = fs.readdirSync(path.join(root, 'crash'))[0]
  // A new process loses the key and must purge the stale artifact at startup.
  const restarted = new EncryptedVault({ dir: path.join(root, 'crash'), maxBytes: 1024, log })
  await restarted.open()
  check('startup purges stale ciphertext', !fs.existsSync(path.join(root, 'crash', crashFile)))
  restarted.clearSync()
  check('stop cleanup removes artifacts', fs.readdirSync(path.join(root, 'crash')).every(name => !name.endsWith('.ncv')))

  await vault.clear()
  check('clear removes the vault artifact', fs.readdirSync(path.join(root, 'vault')).every(name => !name.endsWith('.ncv')))
  vault.clearSync()
} catch (error) {
  failures += 1
  console.error('VAULT ERROR', error)
} finally {
  fs.rmSync(root, { recursive: true, force: true })
  console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`)
  process.exit(failures === 0 ? 0 : 1)
}
