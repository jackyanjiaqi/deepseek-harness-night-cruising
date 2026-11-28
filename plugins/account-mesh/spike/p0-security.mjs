/**
 * P0 security invariants for a plugin installed on someone else's machine:
 * safe defaults, protected DSH home, fail-closed MCP, permission self-heal,
 * log redaction/rotation.
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { DataPlane } from '../src/data.js'
import { DEFAULT_CONFIG } from '../src/mesh.js'
import { registerMcp } from '../src/mcp.js'
import { createLog } from '../src/log.js'
import { hardenPermissions } from '../src/permissions.js'

let failures = 0
const check = (label, condition, detail) => {
  if (condition) console.log(`PASS ${label}`)
  else {
    failures += 1
    console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const root = path.join(import.meta.dirname, '..', '.tmp', 'security')
fs.rmSync(root, { recursive: true, force: true })
const workspace = path.join(root, 'workspace')
fs.mkdirSync(workspace, { recursive: true })
fs.writeFileSync(path.join(workspace, 'hello.txt'), 'hello from the workspace\n')
const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

const quiet = { info() {}, warn() {}, error() {}, debug() {} }
const config = { ...DEFAULT_CONFIG, allowRoots: [workspace, home], dataDir: path.join(root, 'data') }
const ctx = {
  get(name) {
    if (name === 'workspaceRegistry') return { list: () => [{ path: workspace }] }
    if (name === 'sessionQuery') return { listSessions: async () => [] }
    return undefined
  },
}
const plane = new DataPlane(ctx, config, quiet)

// 1. Safe defaults.
check('autoTrustSameAccount defaults to false', DEFAULT_CONFIG.autoTrustSameAccount === false, String(DEFAULT_CONFIG.autoTrustSameAccount))

// 2. Normal workspace reads still work.
const hello = await plane.readFile({ path: path.join(workspace, 'hello.txt') })
check('workspace file is readable', hello.lines.join('\n').includes('hello from the workspace'), JSON.stringify(hello.lines))

// 3. $DSH_HOME is denied even when it is inside an allowed root.
let denied = false
try {
  await plane.readFile({ path: path.join(home, 'account-mesh', 'identity.json') })
} catch (error) {
  denied = error?.code === 'path-denied'
}
check('identity.json under $DSH_HOME is denied', denied)

let homeListing = false
try {
  await plane.listFiles({ path: home })
} catch (error) {
  homeListing = error?.code === 'path-denied'
}
check('listing $DSH_HOME is denied', homeListing)

// 4. A symlink inside the workspace cannot escape into $DSH_HOME.
let symlinkOk = true
try {
  fs.symlinkSync(path.join(home, 'account-mesh'), path.join(workspace, 'escape'))
} catch (error) {
  symlinkOk = false
  console.log(`SKIP symlink escape — ${error.message}`)
}
if (symlinkOk) {
  let escaped = false
  try {
    await plane.listFiles({ path: path.join(workspace, 'escape') })
  } catch (error) {
    escaped = error?.code === 'path-denied'
  }
  check('symlink into $DSH_HOME is denied', escaped)
  const listing = await plane.listFiles({ path: workspace })
  check('denied symlink is filtered from listings', !listing.entries.some(entry => entry.name === 'escape'))
}

// 5. MCP refuses to start without a token (fail closed).
const mcpLogs = []
const dispose = registerMcp({}, {}, { ...quiet, error: message => mcpLogs.push(message) }, { mcpPort: 47991 })
check('MCP without mcpToken is refused', mcpLogs.some(message => message.includes('mcpToken is empty')), JSON.stringify(mcpLogs))
check('MCP refusal returns a disposer', typeof dispose === 'function')
dispose()
const portFree = await new Promise(resolve => {
  const server = net.createServer()
  server.once('error', () => resolve(false))
  server.listen(47991, '127.0.0.1', () => server.close(() => resolve(true)))
})
check('refused MCP leaves the port closed', portFree)

// 6. Permission self-heal: 0644/0755 leftovers become 0600/0700.
const dataDir = config.dataDir
fs.mkdirSync(path.join(dataDir, 'hosted-vault'), { recursive: true })
fs.writeFileSync(path.join(dataDir, 'identity.json'), '{}\n')
fs.writeFileSync(path.join(dataDir, 'settings.json'), '{}\n')
fs.writeFileSync(path.join(dataDir, 'mesh.log'), '')
fs.writeFileSync(path.join(dataDir, 'hosted-vault', 'root.key'), 'k')
for (const file of ['identity.json', 'settings.json', 'mesh.log', 'hosted-vault/root.key']) {
  fs.chmodSync(path.join(dataDir, file), 0o644)
}
const hardened = hardenPermissions(dataDir, quiet)
const modes = ['identity.json', 'settings.json', 'mesh.log', 'hosted-vault/root.key'].map(file => fs.statSync(path.join(dataDir, file)).mode & 0o777)
check('data directory is 0700', (fs.statSync(dataDir).mode & 0o777) === 0o700, (fs.statSync(dataDir).mode & 0o777).toString(8))
check('sensitive files are 0600', modes.every(mode => mode === 0o600), modes.map(mode => mode.toString(8)).join(','))
check('self-heal reports what it fixed', hardened.fixed.length >= 4, JSON.stringify(hardened.fixed))

// 7. Log redaction and rotation.
const logDir = path.join(root, 'log')
fs.mkdirSync(logDir, { recursive: true })
const log = createLog({ dir: logDir, debug: false, maxBytes: 400 })
log.warn('peer', '192.168.5.3:47831', 'path', path.join(home, 'secret.txt'), 'token=abcdef')
const first = fs.readFileSync(path.join(logDir, 'mesh.log'), 'utf8')
check('home path is redacted', first.includes('~') && !first.includes(home), first.slice(0, 120))
check('LAN address is redacted', first.includes('x.x.x.x') && !first.includes('192.168.5.3'), first.slice(0, 120))
check('named secret is redacted', first.includes('token=<redacted>') && !first.includes('abcdef'), first.slice(0, 160))
for (let index = 0; index < 260; index += 1) log.info(`rotation probe ${index} `.repeat(4))
check('oversized log rotates', fs.existsSync(path.join(logDir, 'mesh.log.1')))

fs.rmSync(root, { recursive: true, force: true })
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
