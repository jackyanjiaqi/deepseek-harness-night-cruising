/** Desktop resource locations and signing-aware verification for the shared runtime builder. */

import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { preparePrimaryRuntime as preparePayload, smokePrimaryRuntime as smokePayload } from '../../../scripts/primary-runtime/prepare.ts'
import { parsePrimaryRuntime, workspaceDependencyPaths } from '../../../packages/skill/tool-workspace-dependencies/src/index.ts'
import { resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { scrubWindowsSigningEnvironment } from './windows-sign.mjs'

/** Installed application runtimes this host can seed a package from. */
function installedRuntimes(): string[] {
  const home = homedir()
  if (process.platform === 'darwin') return [
    '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime',
    join(home, 'Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime'),
  ]
  if (process.platform === 'win32') return [
    join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'primary-runtime'),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'DeepSeek Harness', 'resources', 'runtime', 'primary-runtime'),
  ]
  return [
    '/opt/DeepSeek Harness/resources/runtime/primary-runtime',
    '/usr/lib/deepseek-harness/resources/runtime/primary-runtime',
  ]
}

/**
 * A runtime directory is complete only when its final manifest exists and
 * matches this host. Preparation writes `runtime.json` last.
 * @param root - Candidate payload directory.
 * @param version - Desktop release version the payload must belong to.
 * @returns Whether the payload can be reused without downloading.
 */
function completeRuntime(root: string, version: string): boolean {
  try {
    const manifest = parsePrimaryRuntime(JSON.parse(readFileSync(join(root, 'runtime.json'), 'utf8')))
    return manifest.desktopVersion === version
      && manifest.platform === process.platform
      && manifest.arch === process.arch
      && Object.keys(manifest.pythonPackages).length > 0
      && existsSync(join(root, 'dependencies'))
  } catch {
    return false
  }
}

/**
 * Prepare Desktop resources for its selected packaging target.
 * @param options - Signed Windows packaging defers execution until its supervised signing stage.
 * @returns Resolves after preparation and, unless deferred, native-target execution checks.
 */
export async function preparePrimaryRuntime(options: { deferSmoke?: boolean } = {}): Promise<void> {
  const paths = resolveDesktopTargetBuildPaths()
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
  const target = join(paths.runtime, 'primary-runtime')
  if (!completeRuntime(target, version)) {
    const configured = process.env.DSH_DESKTOP_PRIMARY_RUNTIME_DIR
    const seed = configured !== undefined && completeRuntime(configured, version)
      ? configured
      : installedRuntimes().find(path => completeRuntime(path, version))
    if (seed !== undefined) {
      console.log('desktop packaging: seeding primary runtime from ' + seed)
      rmSync(target, { recursive: true, force: true })
      cpSync(seed, target, { recursive: true, verbatimSymlinks: true })
    } else {
      await preparePayload({ target: resolveDesktopBuildTarget(), output: paths.runtime, cache: paths.downloads, version })
    }
  }
  if (!options.deferSmoke) smokePrimaryRuntime(target)
}

/**
 * Verify Desktop's complete payload after preparation or platform signing.
 * @param root - Final payload directory, including any platform signatures.
 */
export function smokePrimaryRuntime(root: string): void {
  const manifest = parsePrimaryRuntime(JSON.parse(readFileSync(join(root, 'runtime.json'), 'utf8')))
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) return
  if (Object.keys(manifest.pythonPackages).length === 0) throw new Error('primary runtime: missing Python distribution versions; prepare the payload before running its smoke checks.')
  const entries = workspaceDependencyPaths(root, manifest)
  if (entries.node === undefined || entries.pnpm === undefined) throw new Error('primary runtime: the Desktop payload must declare node and pnpm components.')
  smokePayload(root, scrubWindowsSigningEnvironment(process.env))
}

if (import.meta.main) await preparePrimaryRuntime()
