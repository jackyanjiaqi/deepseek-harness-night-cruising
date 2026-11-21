// All mutations target the disposable checkout, never the submodule.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { checksum } from './release.mjs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const upstream = join(root, 'deepseek-harness')
const build = join(root, '.build')
const version = '0.2.2-rc.5'
const base = '9c2670d3bce5275e0d1610272958121af87787bb'
const series = join(root, 'patches/deepseek-harness', version)
const dist = join(root, 'dist')
const releaseVersion = JSON.parse(readFileSync(join(root, 'package.json'))).version
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
function prepare() {
  if (lstatSync(upstream).isSymbolicLink() || git(upstream, 'rev-parse', 'HEAD') !== base)
    throw Error('Initialize the pinned submodule with git submodule update --init')
  const names = readFileSync(join(series, 'series'), 'utf8').trim().split(/\r?\n/)
  const hash = createHash('sha256').update(base)
  for (const name of names) {
    if (!/^\d{3}-[\w-]+\.patch$/.test(name)) throw Error('Invalid patch entry ' + name)
    hash.update(name).update(readFileSync(join(series, name)))
  }
  mkdirSync(build, { recursive: true })
  if (lstatSync(build).isSymbolicLink()) throw Error('Build directory must be local')
  const work = join(build, 'harness-' + hash.digest('hex').slice(0, 16))
  if (existsSync(work)) {
    if (realpathSync(work) !== work || resolve(git(work, 'rev-parse', '--show-toplevel')) !== work ||
        git(work, 'rev-parse', 'HEAD') !== base || !existsSync(join(work, '.git/night-tree')))
      throw Error('Unexpected build checkout ' + work)
    return work
  }
  const temp = mkdtempSync(join(build, 'prepare-'))
  try {
    run(root, 'git', ['clone', '-q', '--local', '--no-checkout', upstream, temp])
    git(temp, 'checkout', '-q', '--detach', base)
    for (const name of names) git(temp, 'apply', '--index', '--whitespace=nowarn', join(series, name))
    writeFileSync(join(temp, '.git/night-tree'), git(temp, 'write-tree'))
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
    pnpm(desktop, ['run','start'])
  }
  if (action === 'release') {
    if (git(work, 'ls-files', '--others', '--exclude-standard') || git(work, 'diff', '--name-only') || git(work, 'write-tree') !== readFileSync(join(work, '.git/night-tree'),'utf8'))
      throw Error('Release requires the reviewed source tree')
    await (await import('./release.mjs')).packageDesktop({ work, desktop, dist, releaseVersion, pnpm })
  }
}
