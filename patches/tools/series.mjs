import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = fileURLToPath(new URL('../../', import.meta.url))
export const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
export const settings = manifest['patches-tools']
if (!/^[\w-][\w.-]*$/.test(settings.library)) throw Error('patches-tools.library 必须是本工程内的目录名')
export const upstream = join(root, settings.library)
export const build = join(root, '.build')

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
    if (!lstatSync(file).isFile()) throw Error('补丁必须是普通文件：' + file)
    const bytes = readFileSync(file)
    hash.update(name).update(bytes)
    patches.set(name, bytes)
  }
  return { ...location, contents, patches, digest: hash.digest('hex').slice(0, 16) }
}
