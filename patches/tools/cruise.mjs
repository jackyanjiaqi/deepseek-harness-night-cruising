// All mutations target the disposable checkout, never the submodule.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { applyPatch } from './dir-patch.mjs'
import { checksum } from './release.mjs'
import { root, submodulePath, settings, build, manifest, patchSet } from './series.mjs'

const stack = patchSet()
const base = stack.base
const upstream = submodulePath(settings.library, base)
const dist = join(root, 'dist')
const releaseVersion = manifest.version
function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}
function run(cwd, cmd, args, extra = {}) {
  const result = spawnSync(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, ...extra } })
  if (result.error) throw result.error
  if (result.status !== 0) throw Error(cmd + ' failed: ' + (result.status ?? result.signal))
}
function pnpm(cwd, args, env) {
  // The installed pnpm CLI provides a native shim on Windows.
  if (process.platform === 'win32') run(cwd, 'cmd.exe', ['/d', '/c', 'pnpm', ...args], env)
  else run(cwd, 'pnpm', args, env)
}

/**
 * Runtime payloads shipped by an installed DeepSeek Harness app, nearest first.
 * A development launch can reuse one instead of downloading Node, Python and
 * every wheel again.
 * @returns Candidate `primary-runtime` directories for this platform.
 */
function installedRuntimeCandidates() {
  const home = homedir()
  if (process.platform === 'darwin') return [
    '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime',
    join(home, 'Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime'),
  ]
  if (process.platform === 'win32') return [
    join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'primary-runtime'),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'DeepSeek Harness', 'resources', 'runtime', 'primary-runtime'),
  ]
  return [
    '/opt/DeepSeek Harness/resources/runtime/primary-runtime',
    '/usr/lib/deepseek-harness/resources/runtime/primary-runtime',
  ]
}

/**
 * Environment defaults for an unpackaged launch: reuse the installed app's
 * runtime when the caller did not select one, and keep the development
 * instance on its own Electron userData so it does not fight the installed
 * app's single-instance lock or browser cookies.
 * @returns Overrides merged over the current process environment.
 */
function developmentEnvironment() {
  const env = {}
  if (!process.env.DSH_DESKTOP_PRIMARY_RUNTIME_DIR) {
    const runtime = installedRuntimeCandidates().find(path => existsSync(join(path, 'runtime.json')))
    if (runtime !== undefined) {
      env.DSH_DESKTOP_PRIMARY_RUNTIME_DIR = runtime
      console.log('start: reusing installed primary runtime ' + runtime)
    }
  }
  if (!process.env.DSH_DESKTOP_USER_DATA_DIR) {
    env.DSH_DESKTOP_USER_DATA_DIR = join(homedir(), '.dsh', 'dev-desktop-user-data')
  }
  return env
}
function prepare() {
  if (upstream === join(root, settings.library) && git(upstream, 'rev-parse', 'HEAD') !== base)
    throw Error('请将工程内子模块检出到固定基线 ' + base)
  mkdirSync(build, { recursive: true })
  if (lstatSync(build).isSymbolicLink()) throw Error('Build directory must be local')
  const work = join(build, 'harness-' + stack.digest)
  if (existsSync(work)) {
    if (realpathSync(work) !== work || resolve(git(work, 'rev-parse', '--show-toplevel')) !== work ||
        git(work, 'rev-parse', 'HEAD') !== base || !existsSync(join(work, '.git/night-tree')))
      throw Error('Unexpected build checkout ' + work)
    return work
  }
  const temp = mkdtempSync(join(build, 'prepare-'))
  try {
    run(root, 'git', ['clone', '-q', '--local', '--no-checkout', upstream, temp])
    git(temp, 'update-ref', '--no-deref', 'HEAD', base)
    git(temp, 'read-tree', base)
    for (const patch of stack.patches.values()) applyPatch(temp, patch)
    const tree = git(temp, 'write-tree')
    git(temp, 'checkout-index', '--all')
    writeFileSync(join(temp, '.git/night-tree'), tree)
    try {
      renameSync(temp, work)
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code) || !existsSync(work)) throw error
      return prepare()
    }
  } finally { rmSync(temp, { recursive: true, force: true }) }
  return work
}

const action = process.argv[2]
if (!['prepare','source','build','start','dev','release'].includes(action)) throw Error('Expected prepare, source, build, start, dev or release')
const work = prepare()
console.log(work)
if (action === 'source') {
  mkdirSync(dist, { recursive: true })
  const tree = readFileSync(join(work, '.git/night-tree'), 'utf8')
  const name = 'night-cruising-' + releaseVersion
  const archive = join(dist, name + '-src.tar.gz')
  git(work, 'archive', '--format=tar.gz', '--mtime=' + git(work, 'show', '-s', '--format=%cI', base), '--prefix=' + name + '/', '-o', archive, tree)
  writeFileSync(archive + '.sha256', (await checksum(archive)) + '  ' + name + '-src.tar.gz\n')
} else if (action !== 'prepare') {
  const desktop = join(work, 'apps/desktop')
  pnpm(work, ['install', '--frozen-lockfile'], { CI: 'true', npm_config_manage_package_manager_versions: 'false' })
  if (action !== 'start' || !existsSync(join(desktop, 'lib/main.js')) || !existsSync(join(work, 'apps/web/dist/index.html'))) {
    pnpm(work, ['run','build:artifacts', '--profile', 'local'])
    pnpm(desktop, ['run','build'])
  }
  if (['dev','start'].includes(action)) {
    delete process.env.ELECTRON_RUN_AS_NODE
    pnpm(desktop, ['run','start'], developmentEnvironment())
  }
  if (action === 'release') {
    if (git(work, 'ls-files', '--others', '--exclude-standard') || git(work, 'diff', '--name-only') || git(work, 'write-tree') !== readFileSync(join(work, '.git/night-tree'),'utf8'))
      throw Error('Release requires the reviewed source tree')
    await (await import('./release.mjs')).packageDesktop({ work, desktop, dist, releaseVersion, pnpm })
  }
}
