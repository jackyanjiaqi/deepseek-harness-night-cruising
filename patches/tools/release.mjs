import { createReadStream, copyFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Electron-builder target names and the file extensions they leave in unsigned-artifacts.
const outputExtension = { nsis: 'exe' }

export function nativeTarget(platform, arch) {
  if (platform === 'linux' && arch === 'x64') return { flag: '--linux', formats: ['tar.gz', 'deb', 'AppImage'] }
  if (platform === 'darwin' && ['arm64', 'x64'].includes(arch)) return { flag: '--mac', formats: ['dmg'] }
  if (platform === 'win32' && arch === 'x64') return { flag: '--win', formats: ['nsis'] }
  throw Error('Unsupported native desktop target ' + platform + '-' + arch)
}

export async function checksum(file) {
  const hash = createHash('sha256')
  for await (const block of createReadStream(file)) hash.update(block)
  return hash.digest('hex')
}

/**
 * Derive the installed application version from the date-sequenced release
 * version, so a rebuild whose filename changes also changes
 * `CFBundleShortVersionString` and macOS replaces the previous app instead of
 * treating the two packages as the same version.
 * @param releaseVersion - Root package version, e.g. `0.2.2-rc.5-20261126v2`.
 * @returns A semver build version extending the product version, or undefined.
 */
export function desktopBuildVersion(releaseVersion) {
  const match = /^(.+)-(\d{8})v(\d+)$/.exec(releaseVersion)
  if (match === null) return undefined
  return `${match[1]}.${match[2]}.${match[3]}`
}

export async function packageDesktop({ work, desktop, dist, releaseVersion, pnpm }) {
  const { platform, arch } = process
  const { flag, formats } = nativeTarget(platform, arch)
  const buildVersion = process.env.DSH_DESKTOP_BUILD_VERSION ?? desktopBuildVersion(releaseVersion)
  if (buildVersion !== undefined) console.log('desktop packaging: app version ' + buildVersion)
  const env = {
    DSH_DESKTOP_TARGET_PLATFORM: platform,
    DSH_DESKTOP_TARGET_ARCH: arch,
    DSH_DESKTOP_UNSIGNED: '1',
    DSH_DESKTOP_APP_ID: 'org.nightcruising.harness',
    ...(buildVersion === undefined ? {} : { DSH_DESKTOP_BUILD_VERSION: buildVersion }),
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
  pnpm(desktop, ['exec', 'electron-builder', flag, ...formats, '--' + arch, '--config', 'electron-builder.config.mjs', '--publish', 'never'], env)
  pnpm(desktop, ['exec', 'tsx', 'scripts/smoke-packaged-runtime.ts', '--unsigned'], env)
  mkdirSync(dist, { recursive: true })
  for (const format of formats) {
    const ext = outputExtension[format] ?? format
    const files = readdirSync(paths.unsignedArtifacts).filter(file => file.endsWith('.' + ext))
    if (files.length !== 1) throw Error('Expected one ' + ext + ' installer in ' + paths.unsignedArtifacts)
    const filename = 'night-cruising-' + releaseVersion + '-' + platform + '-' + arch + '.' + ext
    const destination = join(dist, filename)
    copyFileSync(join(paths.unsignedArtifacts, files[0]), destination)
    writeFileSync(destination + '.sha256', (await checksum(destination)) + '  ' + filename + '\n')
    console.log(destination)
  }
}
