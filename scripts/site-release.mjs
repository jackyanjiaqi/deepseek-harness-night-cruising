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
const githubRepository = 'jackyanjiaqi/deepseek-harness-night-cruising'
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
const unlistedVersion = '0.1.0'
const publishedFormats = { linux: ['tar.gz', 'deb', 'AppImage'], darwin: ['dmg'], win32: ['exe'] }

export async function scanArtifacts(packageVersion, directory = dist) {
  if (!semver.valid(packageVersion)) throw Error('package.json version 必须是有效的语义版本号')
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
    const match = /^night-cruising-(.+?)-(src|(?:darwin|linux|win32)-(?:arm64|x64))\.(dmg|exe|tar\.gz|deb|AppImage)$/.exec(
      entry.name,
    )
    if (!match || !semver.valid(match[1])) throw Error('无法识别发行文件 ' + entry.name)
    const [, version, target, format] = match
    if (version !== packageVersion || version === unlistedVersion || target === 'src') continue
    const [platform, arch = ''] = target.split('-')
    if (!publishedFormats[platform]?.includes(format))
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
  const releases = new Map(
    (previous?.releases ?? [])
      .filter((item) => item.version !== unlistedVersion)
      .map((item) => [item.version, structuredClone(item)]),
  )
  for (const { version, file } of artifacts) {
    if (file.platform === 'src') continue
    const release = releases.get(version) ?? { version, date: today, files: [] }
    const at = release.files.findIndex(
      (f) => f.platform === file.platform && f.arch === file.arch && f.format === file.format,
    )
    const backupUrl = '/' + downloadKey(version, file)
    const item = { ...file, backupUrl, checksumUrl: backupUrl + '.sha256' }
    if (at === -1) release.files.push(item)
    else release.files[at] = item
    releases.set(version, release)
  }
  const order = ['darwin', 'win32', 'linux']
  for (const release of releases.values()) {
    release.files = release.files.filter((file) => file.platform !== 'src')
    if (!release.files.length) {
      releases.delete(release.version)
      continue
    }
    for (const file of release.files) {
      file.backupUrl ??= file.url ?? '/' + downloadKey(release.version, file)
      file.url = `https://github.com/${githubRepository}/releases/download/${encodeURIComponent(release.version)}/${encodeURIComponent(file.name)}`
    }
    release.files.sort(
      (a, b) => order.indexOf(a.platform) - order.indexOf(b.platform) || a.arch.localeCompare(b.arch)
        || publishedFormats[a.platform].indexOf(a.format) - publishedFormats[b.platform].indexOf(b.format),
    )
  }
  const sorted = [...releases.values()].sort((a, b) => semver.rcompare(a.version, b.version))
  return {
    schema: 1,
    latestVersion: releases.has(packageVersion) ? packageVersion : null,
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

// Check every retained platform, including history, before publishing new links.
export async function verifyGithubDownloads(data, request = fetch) {
  for (const release of data.releases) {
    const response = await request(
      `https://api.github.com/repos/${githubRepository}/releases/tags/${encodeURIComponent(release.version)}`,
      { headers: { Accept: 'application/vnd.github+json' } },
    )
    if (!response.ok) throw Error(`读取 GitHub Release ${release.version} 失败 HTTP ${response.status}`)
    const assets = (await response.json()).assets
    for (const file of release.files) {
      const asset = assets.find((item) => item.name === file.name && item.browser_download_url === file.url)
      if (!asset || asset.state !== 'uploaded' || asset.size !== file.size)
        throw Error('GitHub Release 缺少匹配产物，请先上传：' + file.name)
      if (asset.digest && asset.digest !== 'sha256:' + file.sha256)
        throw Error('GitHub Release 产物校验不符：' + file.name)
    }
  }
}
