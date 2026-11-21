import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { catalog, catalogKey, kodoHash, scanArtifacts } from './site-release.mjs'
import { publish } from './site.mjs'

test('release history, partial platform uploads and atomic catalog publication', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'night-site-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const objects = new Map()
  let fail = ''
  const store = {
    async checkDomain() {},
    async current() {
      return objects.has(catalogKey) ? JSON.parse(objects.get(catalogKey).bytes) : null
    },
    async stat(key) {
      return objects.get(key)
    },
    async put(key, blob, insertOnly) {
      if (key === fail || (insertOnly && objects.has(key))) throw Error('upload conflict')
      const bytes = Buffer.from(await blob.arrayBuffer())
      const { etag } = await kodoHash([bytes])
      objects.set(key, { bytes, hash: etag })
      return etag
    },
    async remove(key) {
      objects.delete(key)
    },
  }
  let date = new Date('2026-11-21T10:00:00Z')
  let packageVersion = '1.0.0'
  const deploy = async () => {
    const files = await scanArtifacts(packageVersion, dir)
    return publish(
      store,
      files,
      ['index.html'],
      (prev) => catalog(prev, files, packageVersion, '测试备案号', date),
      dir,
    )
  }
  const artifact = async (name, body) => {
    const { sha256 } = await kodoHash([Buffer.from(body)])
    await writeFile(join(dir, name), body)
    await writeFile(join(dir, name + '.sha256'), sha256 + '  ' + name + '\n')
  }
  await writeFile(join(dir, 'index.html'), 'site')
  const mac = 'night-cruising-1.0.0-darwin-arm64.dmg'
  await artifact(mac, 'mac')
  await writeFile(join(dir, 'night-cruising-0.1.0-darwin-arm64.dmg'), 'excluded')
  objects.set(catalogKey, {
    bytes: Buffer.from(JSON.stringify({
      schema: 1, siteVersion: '0.1.0-20261120-v1', releases: [{ version: '0.1.0', files: [] }],
    })),
  })
  const first = await deploy()
  assert.deepEqual(first.releases.map((item) => item.version), [packageVersion])
  assert.equal(first.latestVersion, packageVersion)
  assert.equal(first.siteVersion, '1.0.0-20261121-v1')
  assert.deepEqual(
    first.releases[0].files.map((f) => f.platform),
    ['darwin'],
  )
  await rm(join(dir, mac))
  await artifact('night-cruising-1.0.0-win32-x64.exe', 'win')
  await artifact('night-cruising-1.0.1-rc.2-linux-x64.tar.gz', 'linux')
  await artifact('night-cruising-1.0.1-rc.10-linux-x64.tar.gz', 'newlinux')
  fail = 'index.html'
  await assert.rejects(deploy(), /conflict/)
  assert.deepEqual(await store.current(), first)
  fail = ''
  await deploy()
  packageVersion = '1.0.1-rc.2'
  await deploy()
  packageVersion = '1.0.1-rc.10'
  const second = await deploy()
  assert.equal(second.latestVersion, packageVersion)
  assert.equal(second.siteVersion, '1.0.1-rc.10-20261121-v4')
  assert.equal(second.releases[0].version, '1.0.1-rc.10')
  assert.deepEqual(
    second.releases.at(-1).files.map((f) => f.platform),
    ['darwin', 'win32'],
  )
  date = new Date('2026-11-21T16:01:00Z')
  assert.equal((await deploy()).siteVersion, '1.0.1-rc.10-20261122-v1')
  objects.set('data/site-publish.lock', { bytes: Buffer.from('held') })
  await assert.rejects(deploy(), /conflict/)
  assert(objects.has('data/site-publish.lock'))
  packageVersion = '1.0.0'
  await writeFile(join(dir, 'night-cruising-1.0.0-win32-x64.exe'), 'bad data')
  await assert.rejects(scanArtifacts(packageVersion, dir), /校验失败/)
})
