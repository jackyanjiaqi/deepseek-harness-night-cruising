import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDiff, readDirPatch } from './dir-patch.mjs'

export const root = fileURLToPath(new URL('../../', import.meta.url))
export const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
export const settings = manifest['patches-tools']
if (!/^[\w-][\w.-]*$/.test(settings.library)) throw Error('patches-tools.library 必须是本工程内的目录名')
export const build = join(root, '.build')

export function submodulePath(name, base, { optional = false } = {}) {
  const local = join(root, name)
  const alternatives = manifest['submodule-paths']?.[name] ?? []
  if (!Array.isArray(alternatives) || alternatives.some(path => typeof path !== 'string' || !path.trim()))
    throw Error('submodule-paths.' + name + ' 必须是路径数组')
  const candidates = [local, ...alternatives.map(path => resolve(root, path))]
  const missingBase = []
  for (const path of candidates) {
    if (!existsSync(join(path, '.git')) || !lstatSync(path).isDirectory()) continue
    const top = spawnSync('git', ['-C', path, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' })
    if (top.error) throw top.error
    if (top.status !== 0 || realpathSync(top.stdout.trimEnd()) !== realpathSync(path))
      throw Error('无效的 Git 工作区：' + path)
    if (base) {
      const commit = spawnSync('git', ['-C', path, 'cat-file', '-e', base + '^{commit}'], {
        env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
      })
      if (commit.error) throw commit.error
      if (commit.status !== 0) {
        missingBase.push(path)
        continue
      }
    }
    return path
  }
  if (missingBase.length) throw Error('找不到基线提交 ' + base + '：' + missingBase.join(', '))
  if (optional) return undefined
  throw Error('请初始化 ' + name + ' 子模块或在 submodule-paths 中配置本地 Git 工作区。已检查：' + candidates.join(', '))
}

export function seriesLocation(version = settings.version) {
  if (!Object.hasOwn(settings.versions, version)) throw Error('未知补丁版本：' + version)
  const base = settings.versions[version]
  if (!/^[\w.-]+$/.test(version) || ['.', '..'].includes(version) || !/^[a-f0-9]{40}$/.test(base))
    throw Error('补丁版本或基线提交无效')
  let directory = root
  for (const part of ['patches', settings.library, version]) {
    directory = join(directory, part)
    if (existsSync(directory) && !lstatSync(directory).isDirectory()) throw Error('补丁目录必须位于本工程内：' + directory)
  }
  const seriesFile = join(directory, 'series')
  return { version, base, directory, seriesFile }
}

export function patchSet(version = settings.version, { initialize = false } = {}) {
  const location = seriesLocation(version)
  const { base, directory, seriesFile } = location
  if (initialize && !existsSync(seriesFile)) {
    mkdirSync(directory, { recursive: true })
    writeFileSync(seriesFile, '', { flag: 'wx' })
  }
  if (!lstatSync(seriesFile).isFile()) throw Error('series 必须是普通文件：' + seriesFile)
  const contents = readFileSync(seriesFile, 'utf8')
  const names = contents.split(/\r?\n/).map(line => line.split('#')[0].trim()).filter(Boolean)
  const hash = createHash('sha256').update(base)
  const patches = new Map()
  for (const name of names) {
    if (!/^\d{3}-[\w.-]+\.patch$/.test(name) || patches.has(name)) throw Error('无效或重复的 series 条目：' + name)
    const file = join(directory, name)
    hash.update(name)
    if (name.endsWith('.dir.patch') && lstatSync(file).isDirectory()) {
      patches.set(name, readDirPatch(file, hash))
      continue
    }
    if (!lstatSync(file).isFile()) throw Error('补丁必须是普通文件：' + file)
    patches.set(name, readDiff(file, hash))
  }
  return { ...location, contents, patches, digest: hash.digest('hex').slice(0, 16) }
}
