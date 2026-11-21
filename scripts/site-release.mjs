import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, copyFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import semver from 'semver'

export const root = fileURLToPath(new URL('../', import.meta.url))
export const site = join(root, 'site')
export const catalogKey = 'data/releases.json'
export const domainName = 'deepseek-harness-night-cruising.partyplay.top'
const hero =
  'patches/deepseek-harness/0.2.2-rc.5/000-night-cruising-media.dir.patch/files/apps/web/src/night-ride.jpg'
const dist = join(root, 'dist')

export async function config() {
  let local = {}
  try {
    local = parseEnv(await readFile(join(root, '.env.local'), 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return { ...local, ...process.env }
}
export const day = (date) =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)

// Kodo combines SHA-1 digests of 4 MiB blocks. Also compute the public SHA-256
// in the same stream so installer-sized files never have to fit in memory.
export async function kodoHash(stream) {
  const blockSize = 4 * 1024 * 1024
  const digest = createHash('sha256')
  const blocks = []
  let block = createHash('sha1')
  let used = 0
  let size = 0
  for await (const chunk of stream) {
    digest.update(chunk)
    size += chunk.length
    for (let offset = 0; offset < chunk.length; ) {
      const length = Math.min(chunk.length - offset, blockSize - used)
      block.update(chunk.subarray(offset, offset + length))
      offset += length
      used += length
      if (used === blockSize) {
        blocks.push(block.digest())
        block = createHash('sha1')
        used = 0
      }
    }
  }
  if (used || !blocks.length) blocks.push(block.digest())
  const multi = blocks.length > 1
  const hash = multi ? createHash('sha1').update(Buffer.concat(blocks)).digest() : blocks[0]
  const etag = Buffer.concat([Buffer.from([multi ? 0x96 : 0x16]), hash]).toString('base64url')
  return { size, sha256: digest.digest('hex'), etag }
}
export async function scanArtifacts(directory = dist) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const artifacts = []
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.endsWith('.sha256') || !entry.name.startsWith('night-cruising-'))
      continue
    const match = /^night-cruising-(.+?)-(src|(?:darwin|linux|win32)-(?:arm64|x64))\.(dmg|exe|tar\.gz)$/.exec(
      entry.name,
    )
    if (!match || !semver.valid(match[1])) throw Error('无法识别发行文件 ' + entry.name)
    const [, version, target, format] = match
    const [platform, arch = ''] = target.split('-')
    if (format !== { src: 'tar.gz', linux: 'tar.gz', darwin: 'dmg', win32: 'exe' }[platform])
      throw Error('平台和扩展名不匹配 ' + entry.name)
    const path = join(directory, entry.name)
    const { sha256, size, etag } = await kodoHash(createReadStream(path))
    const sidecar = (await readFile(path + '.sha256', 'utf8')).trim()
    if (!size || sidecar !== sha256 + '  ' + entry.name) throw Error('校验失败 ' + entry.name)
    artifacts.push({ version, path, etag, file: { name: entry.name, platform, arch, format, size, sha256 } })
  }
  return artifacts
}
export function downloadKey(version, file) {
  return 'downloads/' + version + '/' + file.sha256 + '/' + file.name
}
export function catalog(previous, artifacts, packageVersion, icp, date = new Date()) {
  if (!semver.valid(packageVersion) || !icp?.trim())
    throw Error('请检查 package.json version 和 .env.local 的 ICP')
  if (previous && (previous.schema !== 1 || !Array.isArray(previous.releases)))
    throw Error('线上清单格式未知')
  const today = day(date)
  const stamp = today.replaceAll('-', '')
  const serial = previous?.siteVersion.match(/-(\d{8})-v(\d+)$/)
  if (previous && !serial) throw Error('线上网站版本格式未知')
  if (serial && serial[1] > stamp) throw Error('本地日期早于已发布的网站版本')
  const releases = new Map((previous?.releases ?? []).map((item) => [item.version, structuredClone(item)]))
  for (const { version, file } of artifacts) {
    const release = releases.get(version) ?? { version, date: today, files: [] }
    const at = release.files.findIndex((f) => f.platform === file.platform && f.arch === file.arch)
    const url = '/' + downloadKey(version, file)
    const item = { ...file, url, checksumUrl: url + '.sha256' }
    if (at === -1) release.files.push(item)
    else release.files[at] = item
    releases.set(version, release)
  }
  const order = ['darwin', 'win32', 'linux', 'src']
  for (const release of releases.values()) {
    release.files.sort(
      (a, b) => order.indexOf(a.platform) - order.indexOf(b.platform) || a.arch.localeCompare(b.arch),
    )
  }
  const sorted = [...releases.values()].sort((a, b) => semver.rcompare(a.version, b.version))
  return {
    schema: 1,
    latestVersion: sorted[0]?.version ?? null,
    siteVersion: packageVersion + '-' + stamp + '-v' + (serial?.[1] === stamp ? Number(serial[2]) + 1 : 1),
    icp: icp.trim(),
    releases: sorted,
  }
}
export async function prepareSite() {
  await mkdir(join(site, 'assets'), { recursive: true })
  await copyFile(join(root, hero), join(site, 'assets/night-ride.jpg'))
  return JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
}
export async function writeCatalog(data) {
  await mkdir(join(site, 'data'), { recursive: true })
  const file = join(site, catalogKey)
  const tmp = file + '.' + randomUUID() + '.tmp'
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n')
  await rename(tmp, file)
}
