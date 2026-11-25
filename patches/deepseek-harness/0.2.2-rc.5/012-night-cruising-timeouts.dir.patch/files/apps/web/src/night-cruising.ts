import './night-cruising.css'

/** One editable timeout row served by `/night-cruising/timeouts`. */
interface TimeoutEntry {
  key: string
  label: string
  hint?: string
  defaultMs: number
  minMs: number
  maxMs: number
  locked?: boolean
}

/** One visual section of the timeout panel. */
interface TimeoutGroup {
  id: string
  label: string
  hint?: string
  entries: readonly TimeoutEntry[]
}

const ROUTE = '/night-cruising/timeouts'

/* ------------------------------------------------------------------ music -- */

const player = document.querySelector<HTMLAudioElement>('#night-track')
const toggle = document.querySelector<HTMLButtonElement>('#night-play')
if (player && toggle) {
  const track = new URL('./night-cruising.wav', import.meta.url)
  player.volume = 0.35
  const refresh = (): void => {
    toggle.textContent = player.paused ? '播放音乐' : '暂停音乐'
    toggle.setAttribute('aria-pressed', String(!player.paused))
  }
  toggle.addEventListener('click', async () => {
    if (!player.paused) { player.pause(); return }
    toggle.disabled = true
    try {
      // A blob has a known length even when Electron's custom protocol streams the asset.
      if (!player.src) {
        const response = await fetch(track)
        if (!response.ok) throw new Error('夜间巡航音频读取失败')
        player.src = URL.createObjectURL(await response.blob())
      }
      await player.play()
    } catch {
      toggle.textContent = '播放失败 · 重试'
    } finally { toggle.disabled = false }
  })
  player.addEventListener('play', refresh)
  player.addEventListener('pause', refresh)
}

/* --------------------------------------------------------------- timeouts -- */

const panel = document.querySelector<HTMLElement>('#night-timeouts')
const openButton = document.querySelector<HTMLButtonElement>('#night-timeouts-toggle')
const closeButton = document.querySelector<HTMLButtonElement>('#night-timeouts-close')
const summary = document.querySelector<HTMLElement>('#night-timeouts-summary')
const groupsHost = document.querySelector<HTMLElement>('#night-timeouts-groups')
const filterInput = document.querySelector<HTMLInputElement>('#night-timeouts-filter')
const saveButton = document.querySelector<HTMLButtonElement>('#night-timeouts-save')
const resetButton = document.querySelector<HTMLButtonElement>('#night-timeouts-reset')
const status = document.querySelector<HTMLElement>('#night-timeouts-status')
const footer = document.querySelector<HTMLElement>('.night-cruise')

/** Rows currently rendered, keyed by settings key. */
const inputs = new Map<string, HTMLInputElement>()
/** Catalog returned by the Host; empty until the first successful load. */
let groups: readonly TimeoutGroup[] = []
/** Last persisted milliseconds, keyed by settings key. */
let values: Readonly<Record<string, number>> = {}

/**
 * Render one duration as compact Chinese text.
 * @param ms - Duration in milliseconds; `0` means unlimited.
 * @returns `不限`, `30 秒`, `10 分`, or `1 小时`.
 */
function formatDuration(ms: number | undefined): string {
  if (ms === undefined || ms === 0) return '不限'
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} 分`
  return `${Math.round(ms / 3_600_000)} 小时`
}

/**
 * Project the primary wait value into the collapsed bar's one-line summary.
 * The line stays minimal: the first value users tune, plus its cap when it
 * differs.
 */
function refreshSummary(): void {
  if (summary === null || groups.length === 0) return
  const primary = formatDuration(values['wait.job.default'])
  const cap = values['wait.job.max']
  summary.textContent = cap === undefined || cap === 0
    ? `超时 ${primary}`
    : `超时 ${primary} · 上限 ${formatDuration(cap)}`
}

/**
 * Set the panel's inline status line.
 * @param text - Message to show; empty clears it.
 * @param tone - `ok` for the saved state, `error` for a refused save.
 */
function setStatus(text: string, tone: 'ok' | 'error' = 'ok'): void {
  if (status === null) return
  status.textContent = text
  status.dataset.tone = tone
}

/** Mark the save button actionable while any input differs from the store. */
function markDirty(): void {
  if (saveButton === null) return
  let dirty = false
  for (const [key, input] of inputs) {
    if (input.disabled) continue
    if (Math.round(Number(input.value) * 1000) !== (values[key] ?? 0)) { dirty = true; break }
  }
  saveButton.dataset.dirty = dirty ? 'true' : 'false'
  saveButton.disabled = !dirty
}

/**
 * Render the catalog exactly as the Host served it. Entries are created as
 * DOM nodes (never HTML strings), so labels from future plugins stay text.
 */
function renderGroups(): void {
  if (groupsHost === null) return
  groupsHost.replaceChildren()
  inputs.clear()
  for (const group of groups) {
    const section = document.createElement('section')
    section.className = 'night-timeouts-group'
    const heading = document.createElement('h3')
    heading.textContent = group.label
    section.append(heading)
    if (group.hint !== undefined) {
      const hint = document.createElement('p')
      hint.textContent = group.hint
      section.append(hint)
    }
    const grid = document.createElement('div')
    grid.className = 'night-timeouts-grid'
    for (const entry of group.entries) {
      const row = document.createElement('label')
      row.className = 'night-timeout-row'
      row.dataset.key = entry.key
      if (entry.locked) row.dataset.locked = ''
      const copy = document.createElement('span')
      copy.className = 'night-timeout-copy'
      const name = document.createElement('strong')
      name.textContent = entry.label
      copy.append(name)
      if (entry.hint !== undefined) {
        const hint = document.createElement('small')
        hint.textContent = entry.hint
        copy.append(hint)
      }
      const field = document.createElement('span')
      field.className = 'night-timeout-input'
      const input = document.createElement('input')
      input.type = 'number'
      input.inputMode = 'numeric'
      input.step = '1'
      input.min = String(Math.round(entry.minMs / 1000))
      input.max = String(Math.round(entry.maxMs / 1000))
      input.value = String(Math.round((values[entry.key] ?? entry.defaultMs) / 1000))
      input.setAttribute('aria-label', `${entry.label}（秒）`)
      if (entry.locked) {
        input.disabled = true
        input.value = '0'
      }
      input.addEventListener('input', markDirty)
      const unit = document.createElement('span')
      unit.textContent = entry.locked ? '不限' : '秒'
      field.append(input, unit)
      row.append(copy, field)
      grid.append(row)
      inputs.set(entry.key, input)
    }
    section.append(grid)
    groupsHost.append(section)
  }
  markDirty()
  applyFilter()
}

/**
 * Hide rows and sections that do not match the filter box.
 */
function applyFilter(): void {
  if (filterInput === null || groupsHost === null) return
  const needle = filterInput.value.trim().toLocaleLowerCase()
  for (const section of groupsHost.querySelectorAll<HTMLElement>('.night-timeouts-group')) {
    let visible = 0
    for (const row of section.querySelectorAll<HTMLElement>('.night-timeout-row')) {
      const match = needle === '' || (row.textContent ?? '').toLocaleLowerCase().includes(needle)
      row.hidden = !match
      if (match) visible += 1
    }
    section.hidden = visible === 0
    const hint = section.querySelector<HTMLElement>('p')
    if (hint !== null) hint.hidden = needle !== ''
  }
}

/**
 * Open or close the panel. Expanded state lives on the footer so the body grid
 * gives the extra height to the footer, never over the application.
 * @param open - Desired expanded state.
 * @param focus - Whether to move focus into the filter box.
 */
function setExpanded(open: boolean, focus: boolean): void {
  if (panel === null || openButton === null || footer === null) return
  panel.hidden = !open
  footer.dataset.expanded = open ? 'true' : 'false'
  openButton.setAttribute('aria-expanded', String(open))
  if (open && focus) filterInput?.focus()
  if (!open) openButton.focus()
}

/** Flash the collapsed summary after a completed save or turn. */
function flashSummary(): void {
  if (summary === null) return
  summary.classList.remove('night-timeouts-flash')
  // Reading offsetWidth restarts the CSS animation on repeated completions.
  void summary.offsetWidth
  summary.classList.add('night-timeouts-flash')
}

/**
 * Send every editable row to the Host. The route validates, persists atomically
 * and republishes the values to the timeout library, so a save applies without
 * restarting the Host.
 */
async function save(): Promise<void> {
  if (groups.length === 0) return
  const next: Record<string, number> = { ...values }
  for (const [key, input] of inputs) {
    const entry = groups.flatMap(group => group.entries).find(candidate => candidate.key === key)
    if (entry === undefined || entry.locked) continue
    const seconds = Number(input.value)
    if (!Number.isFinite(seconds) || seconds < 0) {
      setStatus(`${entry.label} 需要一个不小于 0 的秒数`, 'error')
      input.focus()
      return
    }
    next[key] = Math.round(seconds * 1000)
  }
  if (saveButton !== null) saveButton.disabled = true
  try {
    const response = await fetch(ROUTE, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: next }),
    })
    const payload: unknown = await response.json().catch(() => undefined)
    if (!response.ok) {
      const message = typeof payload === 'object' && payload !== null && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : `保存失败（HTTP ${String(response.status)}）`
      setStatus(message, 'error')
      markDirty()
      return
    }
    const saved = typeof payload === 'object' && payload !== null && 'values' in payload
      ? (payload as { values?: unknown }).values
      : undefined
    if (typeof saved === 'object' && saved !== null && !Array.isArray(saved)) {
      values = saved as Record<string, number>
    } else {
      values = next
    }
    setStatus('已保存，立即生效')
    refreshSummary()
    markDirty()
  } catch {
    setStatus('无法连接夜间巡航设置服务', 'error')
    markDirty()
  }
}

/** Restore every row to its catalog default in the form (a save still confirms). */
function resetToDefaults(): void {
  for (const group of groups) {
    for (const entry of group.entries) {
      const input = inputs.get(entry.key)
      if (input === undefined || entry.locked) continue
      input.value = String(Math.round(entry.defaultMs / 1000))
    }
  }
  setStatus('已填入默认值，点击保存生效')
  markDirty()
}

/**
 * Load the catalog and persisted values, then reveal the timeout seat.
 * A failed load (standalone page without the Host route, or no admission)
 * leaves the bar in its music-only form.
 */
async function load(): Promise<void> {
  try {
    const response = await fetch(ROUTE, { headers: { accept: 'application/json' } })
    if (!response.ok) return
    const payload: unknown = await response.json()
    if (typeof payload !== 'object' || payload === null || !('groups' in payload) || !('values' in payload)) return
    const candidate = payload as { groups?: unknown; values?: unknown }
    if (!Array.isArray(candidate.groups) || typeof candidate.values !== 'object' || candidate.values === null) return
    groups = candidate.groups as TimeoutGroup[]
    values = candidate.values as Record<string, number>
    if (groups.length === 0) return
    renderGroups()
    refreshSummary()
    if (openButton !== null) openButton.hidden = false
    document.documentElement.dataset.ncTimeouts = 'ready'
  } catch {
    // The footer stays a music player when the settings route is unavailable.
  }
}

openButton?.addEventListener('click', () => {
  setExpanded(panel?.hidden !== false, true)
})
closeButton?.addEventListener('click', () => { setExpanded(false, false) })
filterInput?.addEventListener('input', applyFilter)
saveButton?.addEventListener('click', () => { void save() })
resetButton?.addEventListener('click', resetToDefaults)
document.addEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key === 'Escape' && panel?.hidden === false) {
    event.preventDefault()
    setExpanded(false, false)
  }
})

/* The chat's running indicator disappearing is the one DOM signal every
 * conversation view shares (the stop button's localized label is a fallback).
 * Re-state the timeout as the same minimal white line when output completes;
 * a rAF gate keeps the observer cheap on streaming updates. */
const root = document.querySelector<HTMLElement>('#root')
if (root !== null) {
  let running = false
  let scheduled = false
  const observe = (): void => {
    scheduled = false
    const nowRunning = root.querySelector('[data-chat-running]:not([data-holding]), button[aria-label="停止"], button[aria-label="Stop"]') !== null
    if (running && !nowRunning) flashSummary()
    running = nowRunning
  }
  new MutationObserver(() => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(observe)
  }).observe(root, { childList: true, subtree: true })
}

void load()
