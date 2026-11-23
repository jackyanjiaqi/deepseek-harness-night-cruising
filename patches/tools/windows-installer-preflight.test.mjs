import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { root } from './series.mjs'

function nsisCompiler() {
  if (process.env.MAKENSIS) return process.env.MAKENSIS
  const cached = join(process.env.LOCALAPPDATA, 'electron-builder/Cache/nsis/nsis-3.0.4.1/Bin/makensis.exe')
  if (existsSync(cached)) return cached
  return process.env.PATH.split(';').map(dir => join(dir, 'makensis.exe')).find(existsSync)
}

test('Windows installer checks directory staging with the caller’s permissions', {
  skip: process.platform !== 'win32',
}, t => {
  const compiler = nsisCompiler()
  if (!compiler) return t.skip('Set MAKENSIS to the Windows NSIS compiler path')
  const work = execFileSync(process.execPath, ['patches/tools/cruise.mjs', 'prepare'], { cwd: root, encoding: 'utf8' }).trim()
  const scratch = mkdtempSync(join(tmpdir(), 'nc-path-test-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  for (const dir of ['dirs-only', 'empty', 'occupied', 'denied']) mkdirSync(join(scratch, dir))
  writeFileSync(join(scratch, 'occupied', 'keep.txt'), 'keep')
  const sid = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).match(/S-1-[\d-]+/u)[0]
  // These ACEs apply only to the parent. Its children inherit the ordinary scratch ACL.
  for (const [dir, right] of [['dirs-only', 'WD'], ['denied', 'AD']]) {
    execFileSync('icacls', [join(scratch, dir), '/deny', '*' + sid + ':(' + right + ')'])
  }
  const runner = join(scratch, 'check.exe')
  execFileSync(compiler, ['/V2', '/INPUTCHARSET', 'UTF8', '/DOUT_EXE=' + runner, '/DFIXTURE_ID=' + randomUUID(),
    '/DPATH_NSH=' + join(work, 'apps/desktop/installer/path.nsh'),
    join(root, 'patches/tools/fixtures/windows-installer-preflight.nsi')])
  execFileSync(runner, [], { cwd: scratch, windowsHide: true })
  const report = readFileSync(join(scratch, 'results.txt'), 'utf16le').replaceAll('\r\n', '\n')
  for (const label of ['direct', 'nested', 'empty']) assert.ok(report.includes('[' + label + ']\n'), report)
  assert.match(report, /\[occupied\]occupied\n/u)
  assert.match(report, /\[denied\][\s\S]*?CreateDirectoryW: [^\n]*denied[^\n]*\n[^[]*\(Win32 5\)/u)
  assert.match(report, /\[system\]invalid\n/u)
  assert.deepEqual(readdirSync(join(scratch, 'dirs-only')), [])
  assert.deepEqual(readdirSync(join(scratch, 'empty')), [])
  assert.deepEqual(readdirSync(join(scratch, 'occupied')), ['keep.txt'])
})
