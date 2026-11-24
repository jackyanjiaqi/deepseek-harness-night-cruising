import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DocServerManager, DocServerError } from '../src/manager.js'

function makeCtx(sessions) {
  return {
    get(name) {
      if (name === 'sessions') {
        return {
          get(id) { return sessions.find((session) => session.id === id) },
        }
      }
      if (name === 'workingDirectory') {
        return { get(session) { return session.header.cwd } }
      }
      if (name === 'sessionTitle') {
        return { get(session) { return { title: `title:${session.id}` } } }
      }
      return undefined
    },
    logger: { info() {}, warn() {} },
  }
}

function makeSession(id, cwd) {
  return { id, header: { cwd } }
}

test('doc-server manager starts, locates, switches roots, and stops', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doc-server-test-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doc-server-outside-'))
  fs.writeFileSync(path.join(root, 'README.md'), '# Hello\n\nSee [a](docs/a.md).\n')
  fs.mkdirSync(path.join(root, 'docs'))
  fs.writeFileSync(path.join(root, 'docs', 'a.md'), '# A\n')
  fs.writeFileSync(path.join(root, 'script.js'), 'console.log(1)\n')
  fs.writeFileSync(path.join(outside, 'other.md'), '# Other\n')

  const session = makeSession('session-1', root)
  const manager = new DocServerManager({ ctx: makeCtx([session]), config: {} })
  t.after(async () => {
    await manager.stopAll()
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })

  const started = await manager.start(session, undefined)
  assert.equal(started.sessionId, 'session-1')
  assert.equal(started.title, 'title:session-1')
  assert.equal(started.root, root)
  assert.ok(started.port > 0)
  assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+$/)

  const index = await fetch(`${started.url}/view?file=README.md`)
  assert.equal(index.status, 200)
  assert.match(await index.text(), /<title>Hello<\/title>/)

  const located = await manager.locate(session, 'README.md')
  assert.equal(located.currentFile, 'README.md')
  assert.match(located.currentUrl, /\/view\?file=README\.md$/)
  const locatedResponse = await fetch(located.currentUrl)
  assert.equal(locatedResponse.status, 200)

  const nested = await manager.locate(session, 'docs/a.md')
  assert.equal(nested.currentFile, 'docs/a.md')
  assert.equal((await fetch(nested.currentUrl)).status, 200)

  await assert.rejects(
    () => manager.locate(session, path.join(outside, 'other.md')),
    (error) => error instanceof DocServerError && error.code === 'doc-server/outside-root' && error.status === 409,
  )
  await assert.rejects(
    () => manager.locate(session, 'script.js'),
    (error) => error instanceof DocServerError && error.code === 'doc-server/unsupported-file' && error.status === 415,
  )

  const switched = await manager.start(session, 'docs')
  assert.equal(switched.root, path.join(root, 'docs'))
  assert.equal(switched.port, started.port)
  assert.equal(switched.currentFile, '')
  assert.equal((await fetch(switched.currentUrl)).status, 200)

  const rootFile = await manager.locate(session, 'a.md')
  assert.equal(rootFile.currentFile, 'a.md')

  const list = manager.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].sessionId, 'session-1')

  assert.equal(await manager.stop('session-1'), true)
  assert.equal(manager.list().length, 0)
  await assert.rejects(() => fetch(started.url, { signal: AbortSignal.timeout(1000) }))
  assert.equal(await manager.stop('session-1'), false)
})

test('concurrent starts share one server and separate roots do not share documents', async (t) => {
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doc-cache-a-'))
  const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doc-cache-b-'))
  fs.writeFileSync(path.join(rootA, 'README.md'), '# A\n')
  fs.writeFileSync(path.join(rootB, 'README.md'), '# B\n')
  const fixed = new Date('2024-01-01T00:00:00.000Z')
  fs.utimesSync(path.join(rootA, 'README.md'), fixed, fixed)
  fs.utimesSync(path.join(rootB, 'README.md'), fixed, fixed)
  const sessionA = makeSession('session-a', rootA)
  const sessionB = makeSession('session-b', rootB)
  const manager = new DocServerManager({ ctx: makeCtx([sessionA, sessionB]), config: {} })
  t.after(async () => {
    await manager.stopAll()
    fs.rmSync(rootA, { recursive: true, force: true })
    fs.rmSync(rootB, { recursive: true, force: true })
  })

  const [first, second] = await Promise.all([manager.start(sessionA), manager.start(sessionA)])
  assert.equal(first.port, second.port)
  assert.equal(manager.list().length, 1)
  assert.ok(typeof first.instanceId === 'string' && first.instanceId.length > 0)

  const locatedA = await manager.locate(sessionA, 'README.md')
  const locatedB = await manager.locate(sessionB, 'README.md')
  const htmlA = await (await fetch(locatedA.currentUrl)).text()
  const htmlB = await (await fetch(locatedB.currentUrl)).text()
  assert.match(htmlA, /<title>A<\/title>/)
  assert.match(htmlB, /<title>B<\/title>/)
})

test('the default root is the workspace registry path, not a moved working directory', async (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doc-workspace-'))
  const sessionCwd = path.join(workspaceRoot, 'sub')
  fs.mkdirSync(sessionCwd)
  fs.writeFileSync(path.join(workspaceRoot, 'README.md'), '# Workspace\n')
  const session = makeSession('session-workspace', sessionCwd)
  const ctx = makeCtx([session])
  const baseGet = ctx.get.bind(ctx)
  ctx.get = (name) => name === 'workspaceRegistry'
    ? { list: () => [{ id: 'workspace-1', path: workspaceRoot, sessionIds: [session.id], title: 'Workspace' }] }
    : baseGet(name)
  const manager = new DocServerManager({ ctx, config: {} })
  t.after(async () => {
    await manager.stopAll()
    fs.rmSync(workspaceRoot, { recursive: true, force: true })
  })
  const state = await manager.start(session, undefined)
  assert.equal(state.root, workspaceRoot)
  const located = await manager.locate(session, 'README.md')
  assert.equal(located.currentFile, 'README.md')
})
