/**
 * Edition detection for the dual-build plugin.
 *
 * The same `dsh-account-mesh` ships in the standard DSH and in Night Cruising.
 * The authoritative marker is `DSH_DISTRIBUTION=night-cruising`, injected by the
 * Night Cruising Host at startup; standard DSH leaves it unset. Older builds may
 * only expose the edition through the executable path, so detection falls back
 * through a fixed order and never throws. A shared `$DSH_HOME` directory is not
 * used as a marker because standard DSH and Night Cruising can run on the same
 * machine with the same home.
 *
 * Order (first match wins):
 *   1. plugin config `distribution` (`dsh` / `night-cruising`; `auto` skips)
 *   2. `DSH_DISTRIBUTION`
 *   3. `DSH_EDITION` / `DSH_NIGHT_CRUISING=1`
 *   4. `execPath` / `resourcesPath` containing `night-cruising` or `Night Cruising`
 *   5. default `dsh`
 */
export const EDITION_DSH = 'dsh'
export const EDITION_NIGHT_CRUISING = 'night-cruising'

/** Normalize a distribution value; `auto` and unknown values mean "not explicit". */
export function normalizeEdition(value) {
  if (typeof value !== 'string') return null
  const text = value.trim().toLowerCase().replace(/[\s_]+/g, '-')
  if (text === 'night-cruising' || text === 'nightcruising') return EDITION_NIGHT_CRUISING
  if (text === 'dsh') return EDITION_DSH
  return null
}

/** `DSH_NIGHT_CRUISING` truthy spellings; anything else is not a marker. */
function isTruthy(value) {
  if (typeof value !== 'string') return false
  const text = value.trim().toLowerCase()
  return text === '1' || text === 'true' || text === 'yes' || text === 'on'
}

/** True when a path mentions the Night Cruising build in any common spelling. */
function mentionsNightCruising(value) {
  return typeof value === 'string' && /night[-_ ]?cruising/i.test(value)
}

/**
 * Detect which edition is running.
 *
 * @param {object} [options]
 * @param {object} [options.config] plugin config; `distribution` forces an edition
 * @param {object} [options.env] environment to read (defaults to `process.env`)
 * @param {string} [options.execPath] Node executable path (defaults to `process.execPath`)
 * @param {string} [options.resourcesPath] Electron resources path (defaults to `process.resourcesPath`)
 * @returns {{edition: 'dsh'|'night-cruising', source: 'config'|'env'|'path'|'default'}}
 */
export function detectDistribution({
  config = {},
  env = process.env,
  execPath = process.execPath,
  resourcesPath = process.resourcesPath,
} = {}) {
  try {
    const configured = normalizeEdition(config?.distribution)
    if (configured) return { edition: configured, source: 'config' }

    const fromDistribution = normalizeEdition(env?.DSH_DISTRIBUTION)
    if (fromDistribution) return { edition: fromDistribution, source: 'env' }

    const fromEdition = normalizeEdition(env?.DSH_EDITION)
    if (fromEdition) return { edition: fromEdition, source: 'env' }

    if (isTruthy(env?.DSH_NIGHT_CRUISING)) return { edition: EDITION_NIGHT_CRUISING, source: 'env' }

    if (mentionsNightCruising(execPath) || mentionsNightCruising(resourcesPath)) {
      return { edition: EDITION_NIGHT_CRUISING, source: 'path' }
    }

    return { edition: EDITION_DSH, source: 'default' }
  } catch {
    return { edition: EDITION_DSH, source: 'default' }
  }
}
