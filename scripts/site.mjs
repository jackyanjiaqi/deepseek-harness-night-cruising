import { Blob } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { openAsBlob } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { extname, join } from 'node:path'
import qiniu from 'qiniu'
import {
  catalog,
  catalogKey,
  config,
  downloadKey,
  kodoHash,
  prepareSite,
  scanArtifacts,
  site,
  writeCatalog,
} from './site-release.mjs'

export const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.sha256': 'text/plain; charset=utf-8',
  '.gz': 'application/gzip',
}
async function siteFiles(dir, prefix = '') {
  const files = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name.endsWith('.tmp')) continue
    const key = prefix + entry.name
    if (entry.isDirectory()) files.push(...(await siteFiles(join(dir, entry.name), key + '/')))
    else if (entry.isFile() && key !== catalogKey) files.push(key)
    else if (entry.isSymbolicLink()) throw Error('站点包含软链接 ' + key)
  }
  return files.sort()
}

function qiniuStore(env) {
  for (const key of ['ACCESS_KEY', 'SECRET_KEY', 'BUCKET', 'DOMAIN', 'UPLOAD_HOST']) {
    if (!env[key]?.trim()) throw Error('缺少 .env.local 字段 ' + key)
  }
  const domain = new URL(env.DOMAIN)
  if (domain.protocol !== 'https:' || domain.href !== domain.origin + '/')
    throw Error('DOMAIN 应为巡航站点的 HTTPS 根地址')
  const upload = new URL(env.UPLOAD_HOST.includes('://') ? env.UPLOAD_HOST : 'https://' + env.UPLOAD_HOST)
  if (upload.protocol !== 'https:' || upload.href !== upload.origin + '/')
    throw Error('UPLOAD_HOST 应为 HTTPS 上传域名')
  const mac = new qiniu.auth.digest.Mac(env.ACCESS_KEY, env.SECRET_KEY)
  const manager = new qiniu.rs.BucketManager(mac, new qiniu.conf.Config({ useHttpsDomain: true }))
  const bucket = env.BUCKET
  async function stat(key) {
    const result = await manager.stat(bucket, key)
    if (result.resp.statusCode === 612) return null
    if (!result.ok()) throw Error('查询对象失败 ' + key + ' HTTP ' + result.resp.statusCode)
    return result.data
  }
  return {
    async checkDomain() {
      const result = await manager.listBucketDomains(bucket)
      if (!result.ok() || !result.data.some((entry) => entry.domain === domain.hostname))
        throw Error('七牛未确认巡航域名绑定到此 BUCKET，请检查空间和自定义源站域名')
    },
    async current() {
      const obj = await stat(catalogKey)
      if (!obj) return null
      const url = new URL(catalogKey, domain)
      url.searchParams.set('etag', obj.hash)
      const response = await fetch(url, { cache: 'no-store', redirect: 'error' })
      if (!response.ok) throw Error('读取线上发行清单失败 HTTP ' + response.status)
      const bytes = Buffer.from(await response.arrayBuffer())
      if ((await kodoHash([bytes])).etag !== obj.hash)
        throw Error('CDN 清单与存储空间不一致，请刷新清单缓存并重试')
      return JSON.parse(bytes)
    },
    async put(key, blob, insertOnly = false) {
      const policy = new qiniu.rs.PutPolicy({ scope: bucket + ':' + key, insertOnly: Number(insertOnly) })
      const form = new FormData()
      form.set('token', policy.uploadToken(mac))
      form.set('key', key)
      form.set('file', blob, key.split('/').at(-1))
      const response = await fetch(upload, { method: 'POST', body: form, redirect: 'error' })
      if (!response.ok) throw Error('上传失败 ' + key + ' HTTP ' + response.status)
      const result = await response.json()
      if (result.key !== key || !result.hash) throw Error('七牛返回的对象与上传目标不一致 ' + key)
      return result.hash
    },
    async remove(key) {
      const result = await manager.delete(bucket, key)
      if (!result.ok()) throw Error('清理发布锁失败 HTTP ' + result.resp.statusCode)
    },
    stat,
  }
}
export async function publish(store, artifacts, files, buildCatalog, directory = site) {
  await store.checkDomain()
  const lock = 'data/site-publish.lock'
  // A unique body makes an insert-only lock conflict even on idempotent storage.
  await store.put(lock, new Blob([randomUUID()]), true)
  try {
    const next = buildCatalog(await store.current())
    for (const { version, path, file, etag } of artifacts) {
      const base = downloadKey(version, file)
      for (const suffix of ['', '.sha256']) {
        const key = base + suffix
        const checksum = Buffer.from(file.sha256 + '  ' + file.name + '\n')
        const expected = suffix ? (await kodoHash([checksum])).etag : etag
        const body = suffix
          ? new Blob([checksum], { type: mime[suffix] })
          : await openAsBlob(path, { type: mime[extname(key)] ?? 'application/octet-stream' })
        const existing = await store.stat(key)
        const storedHash = existing ? existing.hash : await store.put(key, body, true)
        if (storedHash !== expected) throw Error('七牛文件内容与本地清单不符 ' + key)
      }
    }
    for (const key of files)
      await store.put(
        key,
        await openAsBlob(join(directory, key), { type: mime[extname(key)] ?? 'application/octet-stream' }),
      )
    await store.put(catalogKey, new Blob([JSON.stringify(next) + '\n'], { type: mime['.json'] }))
    return next
  } finally {
    await store.remove(lock)
  }
}

async function main() {
  const action = process.argv[2]
  if (!['build', 'plan', 'preview', 'deploy'].includes(action))
    throw Error('请选择 build、plan、preview 或 deploy')
  const env = await config()
  const version = await prepareSite()
  const artifacts = await scanArtifacts(version)
  const files = await siteFiles(site)
  const buildCatalog = (previous) => catalog(previous, artifacts, version, env.ICP)
  if (action === 'deploy') {
    const next = await publish(qiniuStore(env), artifacts, files, buildCatalog)
    console.log('已发布网站', next.siteVersion, '最新软件版本', next.latestVersion ?? '暂无')
    return
  }
  const next = buildCatalog(null)
  await writeCatalog(next)
  console.log('本地预览版本', next.siteVersion, '最新软件版本', next.latestVersion ?? '暂无')
  if (action === 'plan') {
    for (const { version, file } of artifacts) console.log(downloadKey(version, file), '+ .sha256')
    console.log([...files, catalogKey].join('\n'))
    console.log('正式版序号和历史版本将在部署时从线上清单合并。')
  }
  if (action === 'preview') await (await import('./site-preview.mjs')).serve(artifacts, mime)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
