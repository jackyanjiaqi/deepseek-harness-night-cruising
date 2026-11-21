import {
  closeSync, fchmodSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync,
  renameSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { root, submodulePath } from '../patches/tools/series.mjs'

const project = resolve(root)
const gitignore = join(project, '.gitignore')
const lock = gitignore + '.sync-agents.lock'
const begin = '# BEGIN sync-agents'
const end = '# END sync-agents'
const sourcePrefix = '# source '
const reserved = new Set(['.gitignore', '.linkignore', '.gitignore.sync-agents.lock'])

function portable(path) {
  return path.split(sep).join('/')
}

function ignorePattern(path) {
  // A trailing slash matches real directories only; Git tracks a symlink as a file.
  return '/' + path.replace(/[\\*?\[\] ]/g, char => '\\' + char)
}

function validatePath(path) {
  if (isAbsolute(path) || /[\r\n]/.test(path) || path.split('/').some(p => !p || p === '..' || p === '.' || p.toLowerCase() === '.git') ||
      portable(relative(project, resolve(project, path))) !== path || reserved.has(path))
    throw Error('无效的托管链接路径：' + path)
}

function readBlock(text) {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const content = line => line.replace(/\r?\n$/, '')
  const starts = lines.flatMap((line, i) => content(line) === begin ? [i] : [])
  const ends = lines.flatMap((line, i) => content(line) === end ? [i] : [])
  const links = new Map()
  if (!starts.length && !ends.length) return { before: text, after: '', links }
  if (starts.length !== 1 || ends.length !== 1 || starts[0] >= ends[0]) throw Error('.gitignore 的 sync-agents 标记不完整')
  let source
  for (const raw of lines.slice(starts[0] + 1, ends[0])) {
    const line = content(raw)
    if (line.startsWith(sourcePrefix)) {
      source = JSON.parse(line.slice(sourcePrefix.length))
      if (typeof source !== 'string' || !source) throw Error('无效的 sync-agents 来源')
    } else {
      const path = line.slice(1).replace(/\\(.)/g, '$1')
      validatePath(path)
      if (!source || line !== ignorePattern(path) || links.has(path)) throw Error('无效的 sync-agents 忽略规则：' + line)
      links.set(path, source)
    }
  }
  return { before: lines.slice(0, starts[0]).join(''), after: lines.slice(ends[0] + 1).join(''), links }
}

function formatBlock({ before, after, links }, eol) {
  if (!links.size) return before + after
  const lines = [begin]
  let previous
  for (const [path, source] of [...links].sort(([a], [b]) => a < b ? -1 : 1)) {
    if (source !== previous) lines.push(sourcePrefix + JSON.stringify(source))
    lines.push(ignorePattern(path))
    previous = source
  }
  lines.push(end, '')
  return before + (before && !before.endsWith('\n') ? eol : '') + lines.join(eol) + after
}

function sameLink(path, source) {
  let parent = project
  for (const part of path.split('/').slice(0, -1)) {
    parent = join(parent, part)
    if (!lstatSync(parent, { throwIfNoEntry: false })?.isDirectory()) return false
  }
  const target = join(project, path)
  return lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink() &&
    resolve(parent, readlinkSync(target)) === resolve(project, source, path)
}

function readExclusions() {
  const file = join(project, '.linkignore')
  const excluded = new Set()
  const mergeDirs = new Set()
  let rules = ''
  try { rules = readFileSync(file, 'utf8') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  for (const line of rules.split(/\r?\n/)) {
    const rule = line.trim()
    if (!rule || rule.startsWith('#')) continue
    const target = resolve(project, './' + rule)
    const path = relative(project, target)
    if (!path || path === '..' || path.startsWith('..' + sep) || isAbsolute(path))
      throw Error('无效的 .linkignore 项目相对路径：' + rule)
    excluded.add(target)
    for (let dir = dirname(target); dir !== project; dir = dirname(dir)) mergeDirs.add(dir)
  }
  return { excluded, mergeDirs }
}

function sync(links) {
  const source = submodulePath('shared-agent-config')
  const sourceRoot = portable(relative(project, source))
  const { excluded, mergeDirs } = readExclusions()
  let created = 0
  function visit(from, to) {
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const target = join(to, entry.name)
      const path = portable(relative(project, target))
      if (entry.name.toLowerCase() === '.git' || reserved.has(path) || excluded.has(target) ||
          (entry.isSymbolicLink() && mergeDirs.has(target))) continue
      validatePath(path)
      const input = join(from, entry.name)
      try {
        if (entry.isDirectory() && mergeDirs.has(target)) {
          mkdirSync(target)
        } else {
          symlinkSync(relative(to, input), target)
          links.set(path, sourceRoot)
          created++
          continue
        }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        if (sameLink(path, sourceRoot)) links.set(path, sourceRoot)
        if (!entry.isDirectory() || !lstatSync(target).isDirectory()) continue
      }
      visit(input, target)
    }
  }
  visit(source, project)
  console.log('新建 ' + created + ' 个软链接，共登记 ' + links.size + ' 个。')
}

function main(action = 'sync') {
  if (!['sync', 'clean'].includes(action)) throw Error('未知命令：' + action)
  let fd = openSync(lock, 'wx')
  let replaced = false
  try {
    const stat = lstatSync(gitignore, { throwIfNoEntry: false })
    if (stat && !stat.isFile()) throw Error('.gitignore 必须是普通文件')
    if (stat) fchmodSync(fd, stat.mode)
    const original = stat ? readFileSync(gitignore, 'utf8') : ''
    const block = readBlock(original)
    try {
      let removed = 0
      for (const [path, source] of block.links) {
        if (!sameLink(path, source)) block.links.delete(path)
        else if (action === 'clean') {
          unlinkSync(join(project, path))
          block.links.delete(path)
          removed++
        }
      }
      if (action === 'sync') sync(block.links)
      else console.log('已清理 ' + removed + ' 个软链接。')
    } finally {
      const updated = formatBlock(block, original.includes('\r\n') ? '\r\n' : '\n')
      if (updated !== original) {
        writeFileSync(fd, updated)
        closeSync(fd)
        fd = undefined
        renameSync(lock, gitignore)
        replaced = true
      }
    }
  } finally {
    if (!replaced) {
      if (fd !== undefined) closeSync(fd)
      unlinkSync(lock)
    }
  }
}
main(process.argv[2])
