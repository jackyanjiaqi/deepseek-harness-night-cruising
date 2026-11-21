import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { nativeTarget } from './release.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const run = (program, args, cwd = root) => execFileSync(program, args, { cwd, encoding: 'utf8' }).trim()
const prepare = () => run(process.execPath, ['patches/tools/cruise.mjs', 'prepare'])
const work = prepare()

test('patches reproduce in a separate checkout of the pinned gitlink', () => {
  assert.equal(prepare(), work)
  const submodule = join(root, 'deepseek-harness')
  assert.match(run('git', ['ls-files', '-s', 'deepseek-harness']), /^160000 9c2670d3/)
  assert.equal(run('git', ['status', '--porcelain'], submodule), '')
  assert.equal(run('git', ['write-tree'], work), readFileSync(join(work, '.git/night-tree'), 'utf8'))
})

test('the Linux release has a native executable, target and primary runtime', async () => {
  const paths = await import(pathToFileURL(join(work, 'apps/desktop/scripts/desktop-build-paths.mjs')))
  const target = paths.resolveDesktopBuildTarget({}, 'linux', 'x64')
  assert.deepEqual(paths.desktopTargetPlatform(target), { platform: 'linux', arch: 'x64' })
  assert.equal(nativeTarget('linux', 'x64').format, 'tar.gz')
  assert.ok(JSON.parse(readFileSync(join(work, 'scripts/primary-runtime/lock.json'))).targets[target].pythonSha256)
  assert.match(readFileSync(join(work, 'apps/desktop/cli/dsh-linux'), 'utf8'), /resources\/\.\.\/night-cruising/)
})

test('the renderer ships an original, playable PCM loop and a bridge panorama', async () => {
  const assetDir = join(work, 'apps/web/src')
  const { serveWebDocument } = await import(pathToFileURL(join(work, 'apps/desktop/src/web-document.ts')))
  const audio = await serveWebDocument(new Request('https://local/night-cruising.wav'), assetDir)
  assert.equal(audio.headers.get('content-type'), 'audio/wav')
  const wav = Buffer.from(await audio.arrayBuffer())
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
  assert.equal(wav.readUInt16LE(20), 1)
  assert.equal(wav.readUInt32LE(40) / wav.readUInt32LE(28), 20)
  assert.ok(statSync(join(assetDir, 'night-ride.jpg')).size > 10000)
})

test('the shared deadline and idle watchdog wait for the caller even after the requested duration', () => {
  run(process.execPath, ['--disable-warning=ExperimentalWarning', '--experimental-transform-types', '--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    import { setTimeout as wait } from 'node:timers/promises'
    import { deadline, idleWatchdog } from './packages/util/timeout/src/index.ts'
    const controller = new AbortController()
    const call = deadline(controller.signal, 1, 'test')
    const idle = idleWatchdog(controller.signal, 1, 'idle')
    const next = await idle.next((async function* () { await wait(15); yield 42 })())
    assert.equal(next.value, 42)
    assert.equal(call.signal.aborted, false)
    controller.abort('manual')
    assert.equal(call.signal.reason, 'manual')
    assert.equal(idle.signal.reason, 'manual')
    idle[Symbol.dispose]()
    call[Symbol.dispose]()
  `], work)
})
