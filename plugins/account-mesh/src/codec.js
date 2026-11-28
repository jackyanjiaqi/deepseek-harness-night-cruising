/**
 * Transfer codec controller: edition gate, persisted intent, optional JLC native
 * module and the site-supplied download / featured links.
 *
 * The plugin never hot-loads the native module. Enabling JLC only persists the
 * intent (`settings.json`) and reports `pendingRestart`; the next Host start
 * loads the module when the edition is Night Cruising and the intent is `auto`.
 * Standard DSH never loads the native module and refuses the switch.
 *
 * Nothing here throws into the caller: a missing module, a corrupt settings
 * file or an unreachable site configuration all degrade to JSONL plus a reason
 * string. The only bounded wait is the site-configuration fetch (10s); it never
 * blocks plugin startup because `start()` schedules it without awaiting.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { EDITION_DSH, EDITION_NIGHT_CRUISING, normalizeEdition } from './distribution.js'

const SITE_BASE_URL = 'https://deepseek-harness.partyplay.top'
const SITE_CONFIG_PATH = '/data/account-mesh.json'
/** Site configuration is a non-model blocking fetch; a finite wait is allowed. */
const LINKS_TIMEOUT_MS = 10000
const SETTINGS_VERSION = 1
const CODEC_MODES = new Set(['auto', 'off'])

export class CodecController {
  /**
   * @param {object} options
   * @param {object} [options.ctx] Cordis context (unused beyond ownership)
   * @param {object} [options.config] plugin config (`codec`, `nativeModulePath`, `siteBaseUrl`, `siteConfigPath`)
   * @param {object} [options.log] plugin logger
   * @param {{edition: string, source: string}|string} [options.edition] detection result
   * @param {string} [options.dataDir] plugin data directory
   * @param {string} [options.here] plugin root directory
   */
  constructor({ ctx, config = {}, log, edition, dataDir, here } = {}) {
    this.ctx = ctx ?? null
    this.config = config ?? {}
    this.log = log ?? null
    const detected = normalizeEditionInput(edition)
    this.edition = detected.edition
    this.editionSource = detected.source
    this.here = here ? path.resolve(here) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    this.dataDir = dataDir ? path.resolve(dataDir) : defaultDataDir()
    this.settingsPath = path.join(this.dataDir, 'settings.json')

    this.desired = 'off'
    this.active = false
    this.available = false
    this.pendingRestart = false
    this.native = null
    this.nativeVersion = null
    /** `missing` when every candidate path was absent, `failed` for a real load error. */
    this.loadFailure = null

    this.links = { download: null, featured: null }
    this.linksStatus = 'loading'
    this.linksFetchedAt = null
    this.linksSource = null
    this.etag = null
    this.linksPromise = null
    this.abortController = null
    this.timer = null
    this.stopped = false

    this.readSettings()
  }

  /** Read the persisted intent and derive `desired` for this edition. */
  readSettings() {
    const settings = readSettingsFile(this.settingsPath)
    const configured = CODEC_MODES.has(this.config.codec) ? this.config.codec : 'auto'
    const codec = settings?.codec ?? configured
    this.desired = this.edition === EDITION_NIGHT_CRUISING && codec !== 'off' ? 'on' : 'off'
    return { codec, settings }
  }

  /** Current transfer state exposed through `/api/state` and `/api/site-links`. */
  state() {
    const night = this.edition === EDITION_NIGHT_CRUISING
    return {
      edition: this.edition,
      editionSource: this.editionSource,
      mode: this.active === true ? 'jlc' : 'jsonl',
      desired: this.desired,
      active: this.active === true,
      available: this.available === true,
      pendingRestart: this.pendingRestart === true,
      reason: this.reason(),
      nativeVersion: this.nativeVersion ?? null,
      links: {
        download: night ? null : this.links.download,
        featured: night ? this.links.featured : null,
      },
      linksStatus: this.linksStatus,
      linksFetchedAt: this.linksFetchedAt ?? null,
    }
  }

  /** Why the current mode is what it is; the panel maps these to copy. */
  reason() {
    if (this.edition !== EDITION_NIGHT_CRUISING) return 'edition-requires-night-cruising'
    if (this.desired === 'off') return 'disabled'
    if (this.active === true) return 'active'
    if (this.pendingRestart === true) return 'restart-required'
    if (this.available !== true) return this.loadFailure === 'failed' ? 'native-load-failed' : 'native-module-missing'
    return 'restart-required'
  }

  /**
   * Read settings, load the native module when this edition and intent allow it,
   * and kick off the site-configuration fetch without awaiting it.
   */
  async start() {
    this.stopped = false
    this.readSettings()
    this.pendingRestart = false
    this.active = false
    if (this.edition === EDITION_NIGHT_CRUISING) {
      if (this.desired === 'on') this.loadNative()
      // With the intent off we never load the module, but the panel still needs
      // to distinguish "disabled" from "component missing"; resolving the
      // candidate specifiers is a presence probe, not a load.
      else this.available = this.probeNativeAvailability()
    }
    // Use the build-time OSS snapshot immediately, then refresh in the
    // background. The snapshot keeps the download/featured link available on a
    // first launch without network; the live document stays authoritative.
    this.loadFallbackLinks()
    // Fire-and-forget: startup must not wait on the network.
    this.refreshLinks().catch(error => this.warn(`site links refresh failed: ${error.message}`))
    return this.state()
  }

  /** Clear the fetch abort and any timer; the native module stays loaded. */
  stop() {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.abortController) {
      try {
        this.abortController.abort()
      } catch {
        // ignore
      }
      this.abortController = null
    }
    this.linksPromise = null
    this.active = false
  }

  /** The loaded native module, or null. */
  getNative() {
    return this.native ?? null
  }

  /**
   * Persist the JLC intent. Standard DSH refuses with
   * `{ok:false, code:'edition-requires-night-cruising'}`; Night Cruising writes
   * `settings.json` and never hot-loads the module.
   *
   * @param {boolean} enabled
   * @returns {object} the new transfer state, or `{ok:false, code, error}`
   */
  setEnabled(enabled) {
    if (typeof enabled !== 'boolean') {
      return { ok: false, code: 'invalid-enabled', error: 'enabled must be a boolean' }
    }
    if (this.edition !== EDITION_NIGHT_CRUISING) {
      return {
        ok: false,
        code: 'edition-requires-night-cruising',
        error: 'JLC cruising requires the Night Cruising edition',
      }
    }
    try {
      writeSettingsFile(this.settingsPath, {
        version: SETTINGS_VERSION,
        codec: enabled ? 'auto' : 'off',
        updatedAt: Date.now(),
      })
    } catch (error) {
      this.warn(`settings write failed: ${error.message}`)
      return { ok: false, code: 'settings-write-failed', error: error.message }
    }
    this.desired = enabled ? 'on' : 'off'
    if (enabled) {
      // No hot load: a process that is not already active needs a restart.
      this.pendingRestart = this.active !== true
    } else {
      this.active = false
      this.pendingRestart = false
    }
    this.info(`JLC codec intent saved: ${enabled ? 'auto' : 'off'}`)
    return this.state()
  }

  /**
   * Fetch the same-origin site configuration from the OSS-backed site and cache
   * the links. Failures keep the previous links and mark them `stale` (or
   * `error` when nothing was cached yet).
   *
   * @param {{force?: boolean}} [options]
   * @returns {Promise<object>} the current transfer state
   */
  refreshLinks({ force = false } = {}) {
    if (this.linksPromise && !force) return this.linksPromise
    const promise = this.fetchLinks()
      .catch(error => {
        this.linksStatus = hasLinks(this.links) ? 'stale' : 'error'
        this.warn(`site links unavailable: ${error.message}`)
        return this.state()
      })
      .finally(() => {
        if (this.linksPromise === promise) this.linksPromise = null
      })
    this.linksPromise = promise
    return promise
  }

  /** One fetch attempt; throws so `refreshLinks` can classify the failure. */
  async fetchLinks() {
    const base = stringOption(this.config.siteBaseUrl) || SITE_BASE_URL
    const configPath = stringOption(this.config.siteConfigPath) || SITE_CONFIG_PATH
    let baseUrl
    try {
      baseUrl = new URL(base)
    } catch {
      throw Object.assign(new Error('siteBaseUrl is not a valid URL'), { code: 'invalid-site-base-url' })
    }
    if (baseUrl.protocol !== 'https:') {
      throw Object.assign(new Error('siteBaseUrl must be https'), { code: 'site-base-url-must-be-https' })
    }
    let target
    try {
      target = new URL(configPath, baseUrl)
    } catch {
      throw Object.assign(new Error('siteConfigPath is not a valid URL'), { code: 'invalid-site-config-path' })
    }
    if (target.protocol !== 'https:') {
      throw Object.assign(new Error('siteConfigPath must be https'), { code: 'site-config-path-must-be-https' })
    }

    this.linksStatus = 'loading'
    const controller = new AbortController()
    this.abortController = controller
    try {
      const timeout = AbortSignal.timeout(LINKS_TIMEOUT_MS)
      const signal = typeof AbortSignal.any === 'function' ? AbortSignal.any([timeout, controller.signal]) : timeout
      const headers = { accept: 'application/json' }
      if (this.etag) headers['if-none-match'] = this.etag
      const response = await fetch(target.href, { headers, signal })
      if (response.status === 304 && this.linksFetchedAt !== null) {
        this.linksStatus = 'ok'
        return this.state()
      }
      if (!response.ok) {
        throw Object.assign(new Error(`site config returned HTTP ${response.status}`), { code: 'site-config-http' })
      }
      const text = await response.text()
      let document
      try {
        document = JSON.parse(text)
      } catch {
        throw Object.assign(new Error('site config is not valid JSON'), { code: 'site-config-invalid-json' })
      }
      const parsed = parseSiteLinks(document, baseUrl)
      if (!hasLinks(parsed)) {
        throw Object.assign(new Error('site config has no usable links'), { code: 'site-config-no-links' })
      }
      this.links = parsed
      this.linksFetchedAt = Date.now()
      const etag = typeof response.headers?.get === 'function' ? response.headers.get('etag') : null
      this.etag = typeof etag === 'string' && etag ? etag : null
      this.linksStatus = 'ok'
      this.info('site links refreshed from the site configuration')
      return this.state()
    } catch (error) {
      this.linksStatus = hasLinks(this.links) ? 'stale' : 'error'
      throw error
    } finally {
      if (this.abortController === controller) this.abortController = null
    }
  }

  /** Candidate module specifiers in documented order. */
  nativeCandidates() {
    const candidates = []
    const explicit = stringOption(this.config.nativeModulePath) || stringOption(process.env.DSH_JLC_NATIVE)
    // An explicit path is authoritative: it lets a deployment pin one
    // platform package and lets tests prove the missing-module path without
    // picking up the bundled development binary.
    if (explicit) return [resolveModulePath(explicit, this.here)]
    candidates.push('@dsh/jlc')
    candidates.push(path.join(this.here, 'native', `jlc-${process.platform}-${process.arch}.node`))
    candidates.push(path.join(this.here, 'native', 'jlc.node'))
    // Local sibling checkout for development. Packaged builds use native/ or
    // the platform package above; this path is absent from an installed plugin.
    candidates.push(path.join(this.here, '..', '..', '..', 'jsonl-native-compress', 'test', 'bindings', 'napi', 'jlc.node'))
    return [...new Set(candidates)]
  }

  /**
   * Presence probe for the disabled intent: resolve candidate specifiers without
   * executing them, so `available` can still tell "disabled" from "missing".
   */
  probeNativeAvailability() {
    const require = createRequire(import.meta.url)
    for (const candidate of this.nativeCandidates()) {
      try {
        require.resolve(candidate)
        return true
      } catch {
        // try the next candidate
      }
    }
    return false
  }

  /**
   * Try the native module candidates. Only reached for Night Cruising with an
   * enabled intent; standard DSH never calls this.
   */
  loadNative() {
    if (this.edition !== EDITION_NIGHT_CRUISING || this.desired !== 'on') return false
    const require = createRequire(import.meta.url)
    const candidates = this.nativeCandidates()
    const errors = []
    for (const candidate of candidates) {
      try {
        const module = require(candidate)
        if (!module || (typeof module !== 'object' && typeof module !== 'function')) {
          throw Object.assign(new Error(`native module ${candidate} exports nothing usable`), { code: 'ERR_JLC_EXPORT' })
        }
        if (typeof module.encode !== 'function' || typeof module.decode !== 'function') {
          throw Object.assign(new Error(`native module ${candidate} lacks encode/decode`), { code: 'ERR_JLC_EXPORT' })
        }
        this.native = module
        this.available = true
        this.active = true
        this.nativeVersion = readNativeVersion(module)
        this.loadFailure = null
        this.info(`JLC native module loaded from ${candidate}`)
        return true
      } catch (error) {
        errors.push(error)
      }
    }
    this.native = null
    this.available = false
    this.active = false
    this.nativeVersion = null
    this.loadFailure = errors.length > 0 && errors.every(isMissingModule) ? 'missing' : 'failed'
    this.warn(`JLC native module unavailable: ${errors.map(error => error.message).join('; ') || 'no candidates'}`)
    return false
  }

  /** Load the packaged mirror of the site document before the live fetch. */
  loadFallbackLinks() {
    try {
      const file = path.join(this.here, 'site-links.json')
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      const base = new URL(stringOption(this.config.siteBaseUrl) || SITE_BASE_URL)
      const links = parseSiteLinks(parsed, base)
      if (hasLinks(links)) {
        this.links = links
        this.linksStatus = 'fallback'
        this.linksSource = 'snapshot'
      }
    } catch {
      // A missing or corrupt mirror only leaves the live fetch as the source.
    }
  }

  info(message) {
    try {
      this.log?.info?.(message)
    } catch {
      // logging must never break the controller
    }
  }

  warn(message) {
    try {
      this.log?.warn?.(message)
    } catch {
      // logging must never break the controller
    }
  }
}

/** Accept either the detection object or a bare edition string. */
function normalizeEditionInput(edition) {
  if (edition && typeof edition === 'object') {
    const value = normalizeEdition(edition.edition) ?? EDITION_DSH
    return { edition: value, source: typeof edition.source === 'string' ? edition.source : 'default' }
  }
  const value = normalizeEdition(edition) ?? EDITION_DSH
  return { edition: value, source: 'config' }
}

function defaultDataDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'account-mesh')
}

/** Absolute paths stay as-is; relative paths resolve against the plugin root. */
function resolveModulePath(value, here) {
  return path.isAbsolute(value) ? value : path.resolve(here, value)
}

function stringOption(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function readSettingsFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    if (!CODEC_MODES.has(parsed.codec)) return null
    return { codec: parsed.codec, updatedAt: Number(parsed.updatedAt) || null }
  } catch {
    // Missing, unreadable or corrupt settings fall back to the configured default.
    return null
  }
}

function writeSettingsFile(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.tmp`
  // Remove a stale temp file first: writeFileSync's mode only applies on
  // create, and a leftover 0644 temp file must not carry over via rename.
  fs.rmSync(temporary, { force: true })
  fs.writeFileSync(temporary, `${JSON.stringify(settings)}\n`, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(temporary, file)
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    // Best effort: startup hardening retries every sensitive file.
  }
}

function hasLinks(links) {
  return Boolean(links?.download || links?.featured)
}

function isMissingModule(error) {
  const code = error?.code
  if (code === 'MODULE_NOT_FOUND' || code === 'ENOENT') return true
  return typeof error?.message === 'string' && /cannot find module|no such file/i.test(error.message)
}

function readNativeVersion(module) {
  for (const key of ['version', 'nativeVersion', 'packageVersion']) {
    const value = module?.[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

/**
 * Validate the site document and normalize both link entries. The document is
 * third-party text: only strings are copied, URLs must resolve to https, and
 * nothing here is executed or treated as an instruction.
 */
function parseSiteLinks(document, baseUrl) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw Object.assign(new Error('site config is not a JSON object'), { code: 'site-config-invalid' })
  }
  const hasDsh = document.dsh && typeof document.dsh === 'object' && !Array.isArray(document.dsh)
  const hasNight = document.nightCruising && typeof document.nightCruising === 'object' && !Array.isArray(document.nightCruising)
  if (!hasDsh && !hasNight) {
    throw Object.assign(new Error('site config has no dsh or nightCruising section'), { code: 'site-config-invalid' })
  }
  return {
    download: parseSiteLink(document.dsh?.download, baseUrl),
    featured: parseSiteLink(document.nightCruising?.featured, baseUrl),
  }
}

function parseSiteLink(entry, baseUrl) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  const label = typeof entry.label === 'string' ? entry.label.trim() : ''
  const hint = typeof entry.hint === 'string' ? entry.hint.trim() : ''
  const rawUrl = typeof entry.url === 'string' ? entry.url.trim() : ''
  if (!label || !rawUrl) return null
  let resolved
  try {
    resolved = new URL(rawUrl, baseUrl)
  } catch {
    return null
  }
  if (resolved.protocol !== 'https:') return null
  return { label, url: resolved.href, hint }
}
