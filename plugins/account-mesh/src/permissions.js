/**
 * Startup permission hardening for a plugin installed on someone else's
 * machine: fix files left at 0644 by older builds and make every sensitive
 * path 0600/0700 on every boot, without asking the user to chmod anything.
 */
import fs from 'node:fs'
import path from 'node:path'

const DIR_MODE = 0o700
const FILE_MODE = 0o600

const DIRS = ['.', 'hosted-vault', 'vault']
const FILES = [
  'identity.json',
  'peers.json',
  'settings.json',
  'mesh.log',
  'hosted-vault/root.key',
  'hosted-vault/ledger.json',
  'hosted-vault/host-settings.json',
  'hosted-vault/index.json',
  'vault/index.json',
]

function lstat(file) {
  try {
    return fs.lstatSync(file)
  } catch {
    return undefined
  }
}

/**
 * Enforce 0700 on the data directories and 0600 on every file that carries a
 * key, a trust record, a path or a log line. Returns what was fixed/failed so
 * the caller can log a single line and tests can assert the result.
 */
export function hardenPermissions(dataDir, log) {
  const fixed = []
  const failed = []
  const note = (target, error) => {
    if (error?.code === 'ENOENT') return
    failed.push(target)
    log?.warn?.(`permissions: could not harden ${target}: ${error?.message ?? error}`)
  }

  for (const rel of DIRS) {
    const dir = path.join(dataDir, rel)
    try {
      fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE })
    } catch (error) {
      note(`dir:${rel}`, error)
      continue
    }
    const info = lstat(dir)
    if (!info?.isDirectory()) continue
    if ((info.mode & 0o777) === DIR_MODE) continue
    try {
      fs.chmodSync(dir, DIR_MODE)
      fixed.push(`dir:${rel}`)
    } catch (error) {
      note(`dir:${rel}`, error)
    }
  }

  for (const rel of FILES) {
    const file = path.join(dataDir, rel)
    const info = lstat(file)
    if (!info?.isFile()) continue
    if ((info.mode & 0o777) === FILE_MODE) continue
    try {
      fs.chmodSync(file, FILE_MODE)
      fixed.push(`file:${rel}`)
    } catch (error) {
      note(`file:${rel}`, error)
    }
  }

  // The transfer path writes one .ncv per cached archive.
  try {
    for (const name of fs.readdirSync(path.join(dataDir, 'vault'))) {
      if (!name.endsWith('.ncv')) continue
      const rel = `vault/${name}`
      const file = path.join(dataDir, 'vault', name)
      const info = lstat(file)
      if (!info?.isFile() || (info.mode & 0o777) === FILE_MODE) continue
      try {
        fs.chmodSync(file, FILE_MODE)
        fixed.push(`file:${rel}`)
      } catch (error) {
        note(`file:${rel}`, error)
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') note('dir:vault', error)
  }

  return { fixed, failed }
}
