/**
 * Pre-release preflight: the packed artifact, not the checkout, must contain
 * everything the manifest exports. Run `npm pack --dry-run --json` first and
 * pipe the JSON here, or run without input to check the checkout.
 */
import fs from 'node:fs'
import path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname)
const root = path.resolve(here, '..')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

const required = [
  manifest.dsh?.bundle?.patch,
  manifest.exports?.['.'],
  manifest.exports?.['./client'],
  manifest.exports?.['./icon'],
  'docs/DETAIL.md',
  'locale/en.json',
  'locale/zh.json',
].filter(Boolean)

const missing = required.filter(rel => !fs.existsSync(path.join(root, rel)))
const meta = JSON.parse(fs.readFileSync(path.join(root, 'locale/en.json'), 'utf8'))
const problems = [...missing.map(rel => `missing ${rel}`)]

if (manifest.private) problems.push('package.json still declares private: true')
if (!manifest.license) problems.push('package.json has no license')
if (!manifest.engines?.dsh) problems.push('package.json has no engines.dsh gate')
if (meta.meta?.detail && !fs.existsSync(path.join(root, meta.meta.detail))) {
  problems.push(`locale meta.detail points at missing ${meta.meta.detail}`)
}
if (!manifest.publishConfig?.tag) problems.push('package.json has no publishConfig.tag (prerelease must not land on latest)')

if (problems.length > 0) {
  console.error(`preflight failed for ${manifest.name}@${manifest.version}:`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`preflight ok: ${manifest.name}@${manifest.version} -> dist-tag ${manifest.publishConfig.tag}`)
