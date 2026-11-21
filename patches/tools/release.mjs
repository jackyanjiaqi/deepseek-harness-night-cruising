import { createReadStream, copyFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export function nativeTarget(platform, arch) {
  if (platform === 'linux' && arch === 'x64') return { flag: '--linux', format: 'tar.gz' }
  if (platform === 'darwin' && ['arm64', 'x64'].includes(arch)) return { flag: '--mac', format: 'dmg' }
  if (platform === 'win32' && arch === 'x64') return { flag: '--win', format: 'nsis' }
  throw Error('Unsupported native desktop target ' + platform + '-' + arch)
}

export async function checksum(file) {
  const hash = createHash('sha256')
  for await (const block of createReadStream(file)) hash.update(block)
  return hash.digest('hex')
}

export async function packageDesktop({ work, desktop, dist, releaseVersion, pnpm }) {
  const { platform, arch } = process
  const { flag, format } = nativeTarget(platform, arch)
  const env = {
    DSH_DESKTOP_TARGET_PLATFORM: platform,
    DSH_DESKTOP_TARGET_ARCH: arch,
    DSH_DESKTOP_UNSIGNED: '1',
    DSH_DESKTOP_APP_ID: 'org.nightcruising.harness',
  }
  const { resolveDesktopTargetBuildPaths } = await import(pathToFileURL(join(desktop, 'scripts/desktop-build-paths.mjs')))
  const paths = resolveDesktopTargetBuildPaths({ ...process.env, ...env })
  const run = (...args) => pnpm(work, args, env)
  const prepare = (stage) => pnpm(desktop, ['run', stage], env)
  run('exec', 'tsx', 'apps/desktop/scripts/pack-local-packages.ts', '--out', paths.packedDsh, '--concurrency', '2')
  run('--dir', 'apps/desktop-host', 'pack', '--pack-destination', paths.packedDsh)
  run('run', 'release:pack', '--family', 'vendor', '--out', paths.packedVendor, '--concurrency', '2')
  mkdirSync(paths.packedLandlock, { recursive: true })
  run('--dir', 'native/system', 'run', 'build:ts')
  run('--dir', 'native/system/packages/entry', 'pack', '--pack-destination', paths.packedLandlock)
  if (platform !== 'win32') run('--dir', 'native/system/packages/' + platform + '-' + arch, 'pack', '--pack-destination', paths.packedLandlock)
  for (const stage of ['prepare:runtime', 'prepare:packages', 'prepare:dsh']) prepare(stage)
  pnpm(desktop, ['exec', 'electron-builder', flag, format, '--' + arch, '--config', 'electron-builder.config.mjs', '--publish', 'never'], env)
  pnpm(desktop, ['exec', 'tsx', 'scripts/smoke-packaged-runtime.ts', '--unsigned'], env)
  const ext = platform === 'win32' ? 'exe' : format
  const files = readdirSync(paths.unsignedArtifacts).filter(file => file.endsWith('.' + ext))
  if (files.length !== 1) throw Error('Expected one installer in ' + paths.unsignedArtifacts)
  mkdirSync(dist, { recursive: true })
  const filename = 'night-cruising-' + releaseVersion + '-' + platform + '-' + arch + '.' + ext
  const destination = join(dist, filename)
  copyFileSync(join(paths.unsignedArtifacts, files[0]), destination)
  writeFileSync(destination + '.sha256', (await checksum(destination)) + '  ' + filename + '\n')
  console.log(destination)
}
