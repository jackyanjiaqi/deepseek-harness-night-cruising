// Directory patches use the same meta.json and files/ layout as patches/tools/v6.
import { execFileSync } from 'node:child_process'
import { chmodSync, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

function git(repo, args, options = {}) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', ...options }).trimEnd()
}

function checkPath(path) {
  if (typeof path !== 'string' || /[\\:\0]/.test(path) ||
      path.split('/').some(p => !p || p === '.' || p === '..' || /^\.git$/i.test(p)))
    throw Error('无效的目录补丁路径：' + path)
}

export function readDirPatch(dir, hash) {
  const meta = join(dir, 'meta.json')
  if (!lstatSync(meta).isFile()) throw Error('缺少普通文件 ' + meta)
  const bytes = readFileSync(meta)
  const { type, added, deleted, modes = {}, before = {} } = JSON.parse(bytes)
  if (type !== 'dir-patch') throw Error('无效的目录补丁：' + dir)
  for (const paths of [added, deleted]) {
    if (!Array.isArray(paths) || paths.length !== new Set(paths).size) throw Error('无效的目录补丁清单：' + dir)
    paths.forEach(checkPath)
  }
  hash?.update(bytes)
  const files = added.map(path => {
    const file = join(dir, 'files', path)
    if (!lstatSync(file).isFile() || realpathSync(file) !== file) throw Error('缺少普通文件：' + file)
    const mode = Object.hasOwn(modes, path) ? modes[path] : '100644'
    if (!['100644', '100755', '120000', '160000'].includes(mode)) throw Error('无效的文件模式：' + path)
    const oid = mode === '160000' ? readFileSync(file, 'utf8').trim() : git(dir, ['hash-object', '--no-filters', '--', file])
    if (!/^[0-9a-f]{40}$/.test(oid)) throw Error('无效的 Git 对象：' + path)
    hash?.update(oid)
    return { path, file, mode, oid }
  })
  return { files, deleted, before }
}

export function readDiff(file, hash) {
  const fd = openSync(file, 'r')
  try {
    const stat = fstatSync(fd, { bigint: true })
    if (hash) hash.update(readFileSync(fd))
    return { diff: file, stat }
  } finally { closeSync(fd) }
}

export function applyPatch(repo, patch, index = {}) {
  if (patch.diff) {
    const fd = openSync(patch.diff, 'r')
    try {
      const stat = fstatSync(fd, { bigint: true })
      if (stat.ino !== patch.stat.ino || stat.ctimeNs !== patch.stat.ctimeNs || stat.size !== patch.stat.size)
        throw Error('读取期间补丁已变化：' + patch.diff)
      execFileSync('git', ['-C', repo, 'apply', '--cached', '--whitespace=nowarn', '-'], {
        ...index, stdio: [fd, 'pipe', 'pipe'],
      })
    } finally { closeSync(fd) }
    return
  }
  const { files, deleted, before } = patch
  const paths = [...new Set([...deleted, ...files.map(entry => entry.path)])]
  const changes = []
  for (const path of paths) {
    const entries = execFileSync('git', ['-C', repo, '--literal-pathspecs', 'ls-files', '--stage', '-z', '--', path], index)
    const record = entries.toString().split('\0').find(line => line.slice(line.indexOf('\t') + 1) === path)
    if (deleted.includes(path)) {
      if (!record || (Object.hasOwn(before, path) && !record.startsWith(before[path] + ' 0\t')))
        throw Error('删除或替换的文件与基线不符：' + path)
      changes.push('0 ' + '0'.repeat(40) + '\t' + path)
    } else if (record) throw Error('新增文件已存在：' + path)
  }
  for (const { path, file, mode, oid } of files) {
    if (mode !== '160000' && git(repo, ['hash-object', '-w', '--no-filters', '--', file]) !== oid)
      throw Error('读取期间文件已变化：' + path)
    changes.push(mode + ' ' + oid + '\t' + path)
  }
  if (changes.length) execFileSync('git', ['-C', repo, 'update-index', '-z', '--index-info'], {
    ...index, input: changes.join('\0') + '\0',
  })
}

export function writeDirPatch(repo, dir, changes) {
  mkdirSync(dir)
  const added = []
  const deleted = []
  const modes = Object.create(null)
  const before = Object.create(null)
  for (const { path, oldMode, oldOid, mode, oid } of changes) {
    checkPath(path)
    if (oldMode !== '000000') {
      deleted.push(path)
      before[path] = oldMode + ' ' + oldOid
    }
    if (mode === '000000') continue
    added.push(path)
    if (mode !== '100644') modes[path] = mode
    const file = join(dir, 'files', path)
    mkdirSync(dirname(file), { recursive: true })
    if (mode === '160000') {
      writeFileSync(file, oid + '\n')
      continue
    }
    const fd = openSync(file, 'wx')
    try {
      execFileSync('git', ['-C', repo, 'cat-file', 'blob', oid], { stdio: ['ignore', fd, 'pipe'] })
    } finally { closeSync(fd) }
    if (mode === '100755') chmodSync(file, 0o755)
  }
  const meta = { type: 'dir-patch', added, deleted, modes, before }
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n')
  return readDirPatch(dir)
}
