#!/usr/bin/env node
/**
 * Report the progress of the Night Cruising release build.
 *
 * The build runs as `pnpm release` (cruise.mjs → pnpm install → artifacts →
 * electron-builder). This script samples the process table and the build tree,
 * so it works while the build is running and needs no cooperation from it.
 *
 * Usage:
 *   node scripts/build-progress.mjs                 # one status line
 *   node scripts/build-progress.mjs --json          # machine-readable
 *   node scripts/build-progress.mjs --watch         # repeat until it finishes
 *   node scripts/build-progress.mjs --watch --interval 30 --log .build/build-progress.log
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const BUILD = join(ROOT, '.build')
const DIST = join(ROOT, 'dist')

/** Read `--name value` / `--flag` from argv. */
function args() {
  const out = { watch: false, json: false, interval: 60, log: undefined }
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--watch') out.watch = true
    else if (argv[i] === '--json') out.json = true
    else if (argv[i] === '--interval') out.interval = Number(argv[++i])
    else if (argv[i] === '--log') out.log = argv[++i]
  }
  return out
}

/** Run a command, returning stdout or ''. */
function run(cmd, argv) {
  try { return execFileSync(cmd, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return '' }
}

/** Processes whose command line matches one of the build stages. */
function processes() {
  const lines = run('pgrep', ['-fl', 'cruise.mjs|prepare-dsh|prepare-runtime|prepare-package-set|electron-builder|smoke-packaged-runtime|build:artifacts']).split('\n').filter(Boolean)
  return lines.map(line => {
    const [pid, ...rest] = line.split(' ')
    return { pid, command: rest.join(' ') }
  })
}

/** The newest build tree the running build writes into. */
function buildRoot() {
  if (!existsSync(BUILD)) return undefined
  const candidates = readdirSync(BUILD).filter(name => name.startsWith('harness-'))
  let best
  let bestTime = 0
  for (const name of candidates) {
    try {
      const time = statSync(join(BUILD, name)).mtimeMs
      if (time > bestTime) { bestTime = time; best = join(BUILD, name) }
    } catch { /* raced with a cleanup */ }
  }
  return best
}

/** Milliseconds since the newest file under the target tree was written. */
function lastWrite(root) {
  if (root === undefined) return undefined
  let newest = 0
  const scan = (dir, depth) => {
    if (depth > 4) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      try {
        const stat = statSync(path)
        if (stat.mtimeMs > newest) newest = stat.mtimeMs
        if (entry.isDirectory() && !entry.name.startsWith('.pnpm')) scan(path, depth + 1)
      } catch { /* raced */ }
    }
  }
  scan(join(root, 'apps/desktop/.desktop-build/targets'), 0)
  return newest === 0 ? undefined : Date.now() - newest
}

/** Human-readable elapsed time of the release process. */
function elapsed() {
  const cruise = processes().find(entry => entry.command.includes('cruise.mjs release'))
  if (cruise === undefined) return undefined
  const raw = run('ps', ['-o', 'etime=', '-p', cruise.pid])
  return raw || undefined
}

/** Packaging artifacts for the current release version. */
function artifacts() {
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  const result = { version, ready: [], unsigned: [] }
  if (existsSync(DIST)) {
    for (const name of readdirSync(DIST)) {
      if (!name.startsWith('night-cruising-' + version)) continue
      if (name.endsWith('.dmg') || name.endsWith('.zip') || name.endsWith('.exe') || name.endsWith('.tar.gz')) result.ready.push(name)
    }
  }
  const root = buildRoot()
  if (root !== undefined) {
    const dir = join(root, 'apps/desktop/.desktop-build/targets/mac-arm64/unsigned-artifacts')
    if (existsSync(dir)) result.unsigned = readdirSync(dir).filter(name => /\.(dmg|zip|exe|AppImage|deb|tar\.gz)$/.test(name))
  }
  return result
}

/** Count of prepared package tarballs, a signal of the package-set stage. */
function packageSet(root) {
  if (root === undefined) return undefined
  const dir = join(root, 'apps/desktop/.desktop-build/targets/mac-arm64/package-set/desktop-packages')
  try { return readdirSync(dir).filter(name => name.endsWith('.tgz')).length } catch { return undefined }
}

/** pnpm store size, a coarse signal of dependency download progress. */
function storeSize(root) {
  if (root === undefined) return undefined
  const dir = join(root, 'apps/desktop/.desktop-build/pnpm-store')
  if (!existsSync(dir)) return undefined
  const bytes = Number(run('du', ['-sk', dir]).split('\t')[0] ?? 0) * 1024
  return bytes > 0 ? bytes : undefined
}

/** Derive the current stage from the live process table. */
function stage(procs) {
  const match = (...needles) => procs.some(entry => needles.some(needle => entry.command.includes(needle)))
  if (match('smoke-packaged-runtime')) return { key: 'smoke', label: '冒烟测试（安装包自检）' }
  if (match('electron-builder')) return { key: 'package', label: 'electron-builder 打包' }
  if (match('prepare-dsh')) return { key: 'dsh', label: '准备内置 DSH 运行时（pnpm install）' }
  if (match('prepare-package-set')) return { key: 'packages', label: '装配打包集' }
  if (match('prepare-runtime')) return { key: 'runtime', label: '准备 Desktop 运行时' }
  if (match('build:artifacts', 'cruise.mjs release')) return { key: 'build', label: '构建 dist / desktop' }
  return { key: 'idle', label: '无构建进程' }
}

function formatBytes(bytes) {
  if (bytes === undefined) return '—'
  if (bytes > 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + 'G'
  return Math.round(bytes / 1024 ** 2) + 'M'
}

function formatDuration(ms) {
  if (ms === undefined) return '—'
  if (ms < 1000) return '刚刚'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return seconds + 's 前'
  return Math.round(seconds / 60) + 'm 前'
}

/** Sample one status snapshot. */
function probe() {
  const procs = processes()
  const root = buildRoot()
  const current = stage(procs)
  const files = artifacts()
  const done = files.ready.length > 0 && current.key === 'idle'
  return {
    time: new Date().toISOString(),
    stage: current.key,
    stageLabel: current.label,
    elapsed: elapsed(),
    running: procs.length > 0,
    lastWrite: lastWrite(root),
    packages: packageSet(root),
    store: storeSize(root),
    artifacts: files,
    done,
    root,
  }
}

function format(status) {
  const parts = [
    '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + ']',
    status.stageLabel,
    status.elapsed === undefined ? undefined : '用时 ' + status.elapsed,
    '最近写入 ' + formatDuration(status.lastWrite),
    status.packages === undefined ? undefined : '打包集 ' + status.packages,
    'pnpm 缓存 ' + formatBytes(status.store),
  ].filter(Boolean)
  if (status.artifacts.ready.length > 0) parts.push('产物 ' + status.artifacts.ready.join(', '))
  else if (status.artifacts.unsigned.length > 0) parts.push('待签名产物 ' + status.artifacts.unsigned.join(', '))
  else parts.push('产物 无')
  if (status.done) parts.push('完成')
  return parts.join(' · ')
}

const options = args()
const log = line => {
  console.log(line)
  if (options.log !== undefined) { try { appendFileSync(join(ROOT, options.log), line + '\n') } catch { /* ignore */ } }
}

if (!options.watch) {
  const status = probe()
  log(options.json ? JSON.stringify(status, null, 2) : format(status))
  process.exit(status.done ? 0 : 3)
}

let last
for (;;) {
  const status = probe()
  const line = format(status)
  if (line !== last) { log(line); last = line }
  if (status.done || (!status.running && status.artifacts.ready.length === 0 && status.lastWrite !== undefined && status.lastWrite > 120_000)) {
    log(status.done ? '构建完成。' : '构建进程已退出，但没有找到今天的产物，请检查日志。')
    process.exit(status.done ? 0 : 2)
  }
  await new Promise(resolve => setTimeout(resolve, Math.max(5, options.interval) * 1000))
}
