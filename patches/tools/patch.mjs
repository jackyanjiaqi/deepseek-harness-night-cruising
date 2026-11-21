#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { applyPatch, readDiff, writeDirPatch } from './dir-patch.mjs'
import { parseArgs } from 'node:util'
import { build, patchSet, root, seriesLocation, settings, submodulePath } from './series.mjs'

const help = `npm run patch -- <命令> [参数] [--version <版本>]
  init                      准备独立编辑副本并显示路径
  list / list-versions      查看 series 或配置的版本
  status / config           查看编辑状态或路径、基线配置
  restore [编号或名称]      将编辑副本切到指定补丁，省略时应用全部（apply 同义）
  clean                     将编辑副本切回官方基线（revert 同义）
  create <名称> [路径...]   将工作文件的改动保存为新的末尾补丁
  update <编号或名称> [路径...]  将工作文件的改动合入已有补丁并校验后续补丁
  verify                    从基线完整重放，检查每个补丁
  build                     用保存的 series 构建桌面程序
路径相对于编辑副本；可导出新增文件、删除及二进制改动。`

function git(repo, args, options = {}) {
  return execFileSync('git', ['-C', repo, ...args], {
    maxBuffer: 128 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...options,
  })
}
function value(repo, args, options) {
  return git(repo, args, options).toString('utf8').trim()
}
function temporary(parent, prefix, action) {
  const dir = mkdtempSync(join(parent, prefix))
  try { return action(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}
function atomicWrite(path, bytes) {
  temporary(dirname(path), '.patch-write-', dir => {
    const staged = join(dir, basename(path))
    writeFileSync(staged, bytes)
    renameSync(staged, path)
  })
}
function clone(directory, base, bare = false) {
  const upstream = submodulePath(settings.library, base)
  git(root, ['clone', '--quiet', '--local', bare ? '--bare' : '--no-checkout', upstream, directory])
}

function gitIndex(dir) {
  return { env: { ...process.env, GIT_INDEX_FILE: join(dir, 'index') } }
}

// Synthetic commits give each patch a reproducible parent and preserve the distinction
// between the upstream series and edits made after checking out a particular patch.
function replay(repo, stack, index) {
  const commits = [stack.base]
  const date = value(repo, ['show', '-s', '--format=%cI', stack.base])
  const identity = { ...index.env }
  for (const role of ['AUTHOR', 'COMMITTER']) {
    identity['GIT_' + role + '_NAME'] = 'Night Cruising Patch Tool'
    identity['GIT_' + role + '_EMAIL'] = 'patch@localhost'
    identity['GIT_' + role + '_DATE'] = date
  }
  git(repo, ['read-tree', stack.base], index)
  for (const [name, patch] of stack.patches) {
    try { applyPatch(repo, patch, index) }
    catch (error) { throw Error(name + ' 无法应用：' + error.message) }
    const tree = value(repo, ['write-tree'], index)
    commits.push(value(repo, ['-c', 'commit.gpgSign=false', 'commit-tree', tree, '-p', commits.at(-1), '-m', name], { env: identity }))
  }
  return commits
}

function select(names, spec) {
  const matches = names.filter(name => name === spec || name === spec + '.patch' ||
    name.slice(4).replace(/(?:\.dir)?\.patch$/, '') === spec || (/^\d{1,3}$/.test(spec) && name.startsWith(spec.padStart(3, '0') + '-')))
  if (matches.length !== 1) throw Error('请指定唯一的补丁编号或名称：' + spec)
  return names.indexOf(matches[0]) + 1
}
function difference(repo, before, after) {
  return git(repo, ['diff', '--no-ext-diff', '--no-textconv', '--binary', '--full-index', '--no-renames',
    '--src-prefix=a/', '--dst-prefix=b/', before, after, '--'])
}
function changedFiles(repo, before, after) {
  const fields = git(repo, ['diff', '--raw', '-z', '--no-abbrev', '--no-renames', before, after, '--'])
    .toString().split('\0')
  const changes = []
  for (let i = 0; i < fields.length - 1; i += 2) {
    const [oldMode, mode, oldOid, oid, status] = fields[i].slice(1).split(' ')
    changes.push({ path: fields[i + 1], oldMode, mode, oldOid, oid, status })
  }
  return changes
}

function needsDirectory(repo, before, after, changes) {
  if (changes.some(change => change.status === 'A' || change.status === 'D')) return true
  return git(repo, ['diff', '--numstat', '-z', '--no-renames', before, after])
    .toString().split('\0').some(line => line.startsWith('-\t-\t'))
}

function editorHead(editor) {
  if (realpathSync(editor) !== editor || !lstatSync(join(editor, '.git')).isDirectory() ||
      resolve(value(editor, ['rev-parse', '--show-toplevel'])) !== editor)
    throw Error('编辑路径不是独立 Git 副本：' + editor)
  const head = value(editor, ['rev-parse', 'HEAD'])
  if (head !== value(editor, ['rev-parse', 'refs/night-cruising/editor']) ||
      value(editor, ['branch', '--show-current'])) throw Error('编辑副本的 HEAD 已手动切换，请先回到工具创建的提交')
  return head
}
function checkout(editor, commit) {
  git(editor, ['-c', 'advice.detachedHead=false', 'checkout', '--detach', '--no-overwrite-ignore', commit])
  git(editor, ['update-ref', 'refs/night-cruising/editor', commit])
}

function save(editor, stack, commits, args, update, index) {
  const [spec, ...paths] = args
  const names = [...stack.patches.keys()]
  const current = commits.indexOf(editorHead(editor))
  if (current < 0) throw Error('series 已变化，请先保存本地改动并执行 restore')
  const position = update ? select(names, spec) : names.length + 1
  if (update ? current < position : current !== names.length)
    throw Error('请先 restore 到目标补丁或 series 末尾，再编辑文件')
  let name = names[position - 1]
  if (!update) {
    if (!/^[\w-][\w.-]*$/.test(spec)) throw Error('补丁名称只支持字母、数字、点、下划线和短横线')
    const number = Math.max(0, ...names.map(entry => Number(entry.slice(0, 3)))) + 1
    if (number > 999) throw Error('三位数补丁编号已用尽')
    name = String(number).padStart(3, '0') + '-' + spec + '.patch'
    if (existsSync(join(stack.directory, name))) throw Error('文件已存在：' + name)
  }
  const selected = paths.length ? paths : ['.']
  git(editor, ['read-tree', commits[current]], index)
  git(editor, ['--literal-pathspecs', 'add', '-A', '--', ...selected], index)
  const snapshot = value(editor, ['write-tree'], index)
  // Preserve an intermediate staged version if the same file was subsequently edited or recreated.
  const indexChanges = tree => git(editor, ['--literal-pathspecs', 'diff', '--cached', '--no-renames',
    '--name-only', '-z', tree, '--', ...selected]).toString().split('\0').filter(Boolean)
  const staged = new Set(indexChanges(commits[current]))
  if (indexChanges(snapshot).some(path => staged.has(path))) throw Error('选中的文件含有部分暂存的改动，请先统一暂存区和工作文件')
  if (snapshot === value(editor, ['rev-parse', commits[current] + '^{tree}'])) throw Error('指定路径没有可导出的改动')
  const parent = commits[position - 1]
  let result = snapshot
  if (update && current !== position) {
    // Transplant just the editor changes onto an earlier patch. Git works with
    // blob IDs here, including for large files that are absent from that patch.
    const tip = value(editor, ['-c', 'user.name=Patch Tool', '-c', 'user.email=patch@localhost',
      '-c', 'commit.gpgSign=false', 'commit-tree', snapshot, '-p', commits[current], '-m', 'editor changes'])
    try {
      result = value(editor, ['merge-tree', '--write-tree', '--merge-base=' + commits[current], commits[position], tip])
    } catch { throw Error('改动依赖后续补丁，无法直接合入 ' + name) }
  }
  const changes = changedFiles(editor, parent, result)
  if (!changes.length) throw Error('更新后补丁将为空')
  const original = stack.patches.get(name)
  const directory = (update && !original.diff) || needsDirectory(editor, parent, result, changes)
  const oldName = name
  if (directory && !name.endsWith('.dir.patch')) name = name.slice(0, -6) + '.dir.patch'
  const file = join(stack.directory, name)
  if ((!update || oldName !== name) && existsSync(file)) throw Error('文件已存在：' + name)
  const newHead = temporary(stack.directory, '.patch-save-', dir => {
    const stagedFile = join(dir, name)
    let patch
    if (directory) {
      patch = writeDirPatch(editor, stagedFile, changes)
    } else {
      let bytes = difference(editor, parent, result)
      if (original) {
        const previous = readFileSync(original.diff)
        const start = previous.toString('latin1').search(/^(?:diff --git |--- |Index: )/m)
        if (start > 0) bytes = Buffer.concat([previous.subarray(0, start), bytes])
      }
      writeFileSync(stagedFile, bytes)
      patch = readDiff(stagedFile)
    }
    const candidate = new Map()
    for (const [key, entry] of stack.patches) {
      if (key === oldName && update) candidate.set(name, patch)
      else candidate.set(key, entry)
    }
    if (!update) candidate.set(name, patch)
    const checked = replay(editor, { ...stack, patches: candidate }, index)
    const head = checked[update ? current : position]
    if (value(editor, ['rev-parse', head + '^{tree}']) !== snapshot)
      throw Error('后续补丁改变了导出结果，已停止写入')

    let contents = stack.contents
    if (!update) contents += (contents && !contents.endsWith('\n') ? '\n' : '') + name + '\n'
    else if (oldName !== name) contents = contents.split('\n').map(line => {
      return line.split('#')[0].trim() === oldName ? line.replace(oldName, name) : line
    }).join('\n')
    const previous = join(stack.directory, oldName)
    const backup = join(dir, 'previous')
    if (update) renameSync(previous, backup)
    let installed = false
    try {
      renameSync(stagedFile, file)
      installed = true
      if (contents !== stack.contents) atomicWrite(stack.seriesFile, contents)
    } catch (error) {
      if (installed) renameSync(file, stagedFile)
      if (update) renameSync(backup, previous)
      throw error
    }
    return head
  })
  git(editor, ['reset', '--soft', newHead])
  git(editor, ['--literal-pathspecs', 'reset', '-q', newHead, '--', ...selected])
  git(editor, ['update-ref', 'refs/night-cruising/editor', newHead])
  console.log(file)
}

function manage(command, args, version) {
  const editor = join(build, 'patch-work-' + version)
  if (command === 'config') {
    const location = seriesLocation(version)
    const upstream = submodulePath(settings.library, location.base, { optional: true }) ?? join(root, settings.library)
    console.log(JSON.stringify({ library: settings.library, version, base: location.base, upstream, series: location.seriesFile, editor }, null, 2))
    return
  }
  if (command === 'build') {
    if (version !== settings.version) throw Error('桌面构建使用当前配置的默认版本：' + settings.version)
    const result = spawnSync(process.execPath, [join(root, 'patches/tools/cruise.mjs'), 'build'], { stdio: 'inherit' })
    if (result.error) throw result.error
    process.exitCode = result.status ?? 1
    return
  }
  if (command === 'init' && !submodulePath(settings.library, settings.versions[version], { optional: true })) {
    git(root, ['submodule', 'update', '--init', '--', settings.library])
  }
  const stack = patchSet(version, { initialize: command === 'init' })
  const names = [...stack.patches.keys()]
  if (command === 'list') { console.log(names.join('\n')); return }
  if (command === 'status' && !existsSync(editor)) {
    console.log(version, stack.base, '\n编辑副本尚未初始化：', editor, '\n' + names.join('\n'))
    return
  }
  mkdirSync(build, { recursive: true })
  if (realpathSync(build) !== build) throw Error('构建目录必须位于本工程内')
  temporary(build, 'patch-index-', dir => {
    const index = gitIndex(dir)
    if (command === 'verify') {
      const repo = join(dir, 'verify.git')
      clone(repo, stack.base, true)
      replay(repo, stack, index)
      console.log('重放通过：' + names.length + ' 个补丁，基线 ' + stack.base)
      return
    }
    if (!existsSync(editor)) {
      if (!['init', 'restore', 'clean'].includes(command)) throw Error('请先运行 npm run patch:init')
      const repo = join(dir, 'work')
      clone(repo, stack.base)
      const commits = replay(repo, stack, index)
      const target = command === 'clean' ? 0 : args.length ? select(names, args[0]) : names.length
      checkout(repo, commits[target])
      renameSync(repo, editor)
      console.log(editor)
      return
    }
    const head = editorHead(editor)
    const commits = replay(editor, stack, index)
    const current = commits.indexOf(head)
    if (command === 'create' || command === 'update') { save(editor, stack, commits, args, command === 'update', index); return }
    if (command === 'status') {
      console.log(editor, '\n基线：' + stack.base)
      names.forEach((name, i) => console.log(current < 0 ? '[series 已变化]' : i < current ? '[已应用]' : '[未应用]', name))
      console.log(value(editor, ['status', '--short']) || '工作区干净')
    } else if (command === 'init') console.log(editor)
    else {
      const target = command === 'clean' ? 0 : args.length ? select(names, args[0]) : names.length
      if (current !== target) {
        if (value(editor, ['status', '--porcelain'])) throw Error('编辑副本有未保存的改动，请先导出或暂存到 git stash')
        checkout(editor, commits[target])
      }
      console.log(editor)
    }
  })
}

function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, version: { type: 'string' },
  } })
  const [action, ...args] = positionals
  if (!action || values.help || action === 'help') { console.log(help); return }
  const command = action === 'apply' ? 'restore' : action === 'revert' ? 'clean' : action
  if (!['init','list','list-versions','status','config','restore','clean','create','update','verify','build'].includes(command))
    throw Error('未知命令：' + action + '\n' + help)
  if (['create', 'update'].includes(command) ? !args.length : args.length > (command === 'restore' ? 1 : 0)) throw Error(help)
  if (command === 'list-versions') { console.log(Object.keys(settings.versions).join('\n')); return }
  const version = values.version ?? settings.version
  if (!Object.hasOwn(settings.versions, version)) throw Error('未知补丁版本：' + version)
  if (['list','config','build','verify'].includes(command)) { manage(command, args, version); return }
  mkdirSync(build, { recursive: true })
  if (realpathSync(build) !== build) throw Error('构建目录必须位于本工程内')
  const lock = join(build, '.patch-editor.lock')
  try { mkdirSync(lock) } catch (error) {
    if (error.code === 'EEXIST') throw Error('补丁编辑操作正在运行，锁目录：' + lock)
    throw error
  }
  try { manage(command, args, version) } finally { rmSync(lock, { recursive: true }) }
}

try { main() } catch (error) { console.error(error.message); process.exitCode = 1 }
