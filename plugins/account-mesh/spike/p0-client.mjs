/**
 * Client-half smoke test: fake module loader, fake React, fake slots/locale,
 * then render the settings page element tree once.
 */
import fs from 'node:fs'
import path from 'node:path'

let captured
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      captured = spec
    },
  },
}

await import('../client.js')

let failures = 0
const check = (label, condition, detail) => {
  if (condition) console.log(`PASS ${label}`)
  else {
    failures += 1
    console.log(`FAIL ${label}`, detail ?? '')
  }
}

const React = {
  Fragment: 'Fragment',
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: initial => {
    if (React.__stateQueue && React.__stateQueue.length > 0) return [React.__stateQueue.shift(), () => {}]
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect: () => {},
  useMemo: fn => fn(),
  useCallback: fn => fn,
  useRef: value => ({ current: value }),
  useSyncExternalStore: () => ({ revision: 1 }),
}

const dicts = []
const registrations = []
const injected = []
const ctx = {
  effect(fn) {
    fn()
    return () => {}
  },
  locale: {
    register(ns, locale, dict) {
      dicts.push({ ns, locale, dict })
      return () => {}
    },
    bind(ns) {
      return key => {
        const entry = dicts.find(item => item.ns === ns && item.locale === 'zh') ?? dicts.find(item => item.ns === ns)
        return entry?.dict?.[key] ?? key
      }
    },
    subscribe: () => () => {},
    getSnapshot: () => ({ active: 'zh', revision: 1, locales: [] }),
  },
  slots: {
    inject(slot, callback) {
      injected.push(slot)
      callback()
      return () => {}
    },
    register(options, Component) {
      registrations.push({ options, Component })
      return () => {}
    },
  },
}

try {
  check('module loader id matches the package name', captured?.id === 'dsh-account-mesh', captured?.id)
  const module = captured.factory(name => (name === 'react' ? React : undefined))
  module.apply(ctx)
  check('registers zh and en dictionaries', dicts.length === 2 && dicts.some(d => d.locale === 'zh') && dicts.some(d => d.locale === 'en'))
  check('injects into settings.section', injected.includes('settings.section'), injected.join(','))
  check('injects into sidebar.panellist', injected.includes('sidebar.panellist'), injected.join(','))
  check('injects into main', injected.includes('main'), injected.join(','))
  check('registers three slots', registrations.length === 3, registrations.map(r => r.options.name).join(','))
  const registration = registrations.find(r => r.options.name === 'settings.section')
  const panelEntry = registrations.find(r => r.options.name === 'main')
  const iconEntry = registrations.find(r => r.options.name === 'sidebar.panellist')
  check('section id is account-mesh', registration.options.id === 'account-mesh')
  check('section label is localized', registration.options.label() === '同账号互联', registration.options.label())
  check('panel key is account-mesh', panelEntry.options.key === 'account-mesh')
  check('panel icon label is localized', iconEntry.options.label() === '远端工作区', iconEntry.options.label())
  const iconTree = iconEntry.Component({ size: 16 })
  check('panel icon renders an svg', iconTree?.type === 'svg')
  const panelOuter = panelEntry.Component({})
  const panel = typeof panelOuter.type === 'function' ? panelOuter.type(panelOuter.props) : panelOuter
  check('panel renders a section', panel?.type === 'section')
  check('panel shows the remote tree title', JSON.stringify(panel).includes('远端工作区'))
  check('panel marks itself read-only', JSON.stringify(panel).includes('只读'))
  const panelText = JSON.stringify(panel)
  check('panel labels the session pane', panelText.includes('会话'))
  check('panel labels the trajectory pane', panelText.includes('轨迹'))
  check('dictionaries expose session/trajectory copy strings', dicts.every(entry =>
    typeof entry.dict.sessionsPane === 'string' &&
    typeof entry.dict.conversationTab === 'string' &&
    typeof entry.dict.trajectoryTab === 'string' &&
    typeof entry.dict.copySessionId === 'string' &&
    typeof entry.dict.copied === 'string'))
  const clientSource = fs.readFileSync(path.join(import.meta.dirname, '..', 'client.js'), 'utf8')
  check('client offers clipboard copy for session ids', clientSource.includes('copySessionId') && clientSource.includes('navigator.clipboard'))
  check('client offers the JLC full-session fetch action', clientSource.includes('fetchFull') && clientSource.includes("post('fetch'") && clientSource.includes('fetchProgress'))

  // Render the panel with a populated tree and a selected session so the
  // session rows, copy buttons, and trajectory item labels are exercised.
  const presetTree = {
    peers: [{
      online: true,
      verified: true,
      deviceId: 'sim-remote-workspace-0001',
      shortId: 'sim-remo…001',
      name: 'sim-remote-workspace',
      source: 'lan',
      address: '127.0.0.1',
      rttMs: 1,
      fingerprint: 'F3h7HlLkYZTIlF7VZ0k1K6',
      pairCode: '475320',
      trustedAt: 1763000000000,
      workspaces: [{
        id: 'sim-ws',
        title: 'Simulated remote workspace',
        name: 'workspace',
        path: '/tmp/sim/workspace',
        sessions: [
          { id: 'sim-session-alpha', title: 'Simulated remote session: workspace tour', createdAt: 1763000000000, live: false, persisted: true },
          { id: 'sim-session-beta', title: 'Simulated remote session: projection rules', createdAt: 1763000100000, live: true, persisted: true },
        ],
      }],
      error: null,
      lastSeenAt: null,
    }],
    generatedAt: 1763000000000,
  }
  const presetSelection = { peer: 'sim-remote-workspace-0001', sessionId: 'sim-session-alpha', title: 'Simulated remote session: workspace tour' }
  const presetTranscript = {
    session: { id: 'sim-session-alpha', cwd: '/tmp/sim/workspace', createdAt: 1763000000000 },
    fromSeq: 0,
    nextSeq: 7,
    hasMore: false,
    itemCount: 4,
    totalBytes: 4096,
    bytes: 2048,
    cached: false,
    items: [
      { seq: 1, time: 1763000001000, role: 'user', text: 'Please inspect the remote workspace.' },
      {
        seq: 2,
        time: 1763000002000,
        role: 'assistant',
        text: '## Plan\n\nI will **list** the workspace and read `notes.txt`.',
        reasoning: 'The user wants a workspace tour.',
        toolCalls: ['mesh_workspace_list'],
      },
      { seq: 3, time: 1763000003000, role: 'tool-call', name: 'mesh_workspace_list', text: '{"peer":"sim-remote-workspace"}' },
      { seq: 4, time: 1763000004000, role: 'tool-result', isError: true, text: 'Error: wait aborted', errorName: 'AbortError', errorCode: 'ABORTED' },
    ],
  }
  const renderElement = node => {
    if (!node || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map(renderElement)
    if (typeof node.type === 'function') {
      const props = { ...(node.props ?? {}) }
      if (Array.isArray(node.children) && node.children.length > 0) props.children = node.children.map(renderElement)
      return renderElement(node.type(props))
    }
    return { ...node, children: Array.isArray(node.children) ? node.children.map(renderElement) : node.children }
  }
  // MeshPanel consumes eight states (tree, error, expanded, selection,
  // transcript, transcriptError, loadingMore, view), then the two tree copy
  // buttons, the toolbar copy button, and one reasoning block.
  const presetTotals = new Map([['sim-session-alpha', { totalBytes: 4096, totalItems: 4 }]])
  React.__stateQueue = [{ data: null, error: null }, presetTree, null, {}, presetSelection, presetTranscript, null, false, 'conversation', 360, false, false, false, null, false, presetTotals, false, false, false, false]
  const richPanel = renderElement(panelEntry.Component({}))
  const richText = JSON.stringify(richPanel)
  check('rich panel renders both session rows', richText.includes('Simulated remote session: workspace tour') && richText.includes('Simulated remote session: projection rules'))
  check('rich panel exposes copy buttons carrying full session ids', richText.includes('sim-session-alpha') && richText.includes('sim-session-beta') && richText.includes('复制会话 ID'))
  check('rich panel renders compact copy icons and the toolbar copy', richText.includes('⧉') && richText.includes('会话 ID'))
  check('rich panel renders the conversation and trajectory tabs', richText.includes('对话') && richText.includes('轨迹'))
  check('rich panel renders a right-aligned user bubble', richText.includes('justifyContent') && richText.includes('Please inspect the remote workspace.'))
  check('rich panel renders assistant markdown', richText.includes('"type":"h2"') && richText.includes('"type":"strong"') && richText.includes('"type":"code"') && richText.includes('notes.txt'))
  check('rich panel collapses thinking and points to the trajectory', richText.includes('思考过程') && richText.includes('可在轨迹中查看'))
  check('rich panel renders the resizable splitter', richText.includes('am-splitter') && richText.includes('am-splitter-line') && richText.includes('separator'))
  check('rich panel carries tree hover styles', richText.includes('am-tree-row:hover') && richText.includes('am-button:hover'))
  check('hint line does not grow vertically', richText.includes('"flex":"none"'))
  check('workspace label uses the last path segment', richText.includes('"children":["workspace"]') && !richText.includes('"children":["/tmp/sim/workspace"]'))
  check('workspace hover carries the full path', richText.includes('/tmp/sim/workspace'))
  check('peer hover carries device details', richText.includes('设备 ID: sim-remote-workspace-0001') && richText.includes('指纹:'))
  check('session hover carries id and full date', richText.includes('会话 ID: sim-session-alpha') && richText.includes('创建时间:'))
  check('session meta uses relative time, not a full date', richText.includes('天') || richText.includes('小时') || richText.includes('分钟'))
  check('labels render an inner marquee text span', richText.includes('am-tree-name') && richText.includes('am-tree-text'))

  // Data totals: known session size in the tree meta, hover, and toolbar chip.
  check('session tree appends the data total', richText.includes('· 4.0 KB'))
  check('session hover carries the data volume', richText.includes('数据量: 4.0 KB'))
  check('toolbar shows the data total chip', richText.includes('数据量 4.0 KB'))
  check('toolbar marks the first read as remote', richText.includes('远端'))
  check('toolbar offers a force refresh that bypasses the cache', richText.includes('强制刷新') && clientSource.includes("'force', '1'"))
  check('client falls back to the session index when pages lack totals', clientSource.includes('sessions/index') && clientSource.includes('body.totalBytes == null'))
  check('formatBytes scales above 1024 bytes', clientSource.includes('function formatBytes') && clientSource.includes("'TB'"))
  check('panel keeps no progress-percentage UI', !clientSource.includes('ProgressBar') && !clientSource.includes('percentOf') && !richText.includes('拉取进度'))
  check('marquee only applies to overflowing labels', richText.includes('data-overflow') && !richText.includes('data-marquee'))
  check('marquee animation is declared', richText.includes('am-marquee-text'))

  // Detail pass: no chevron glyphs, right-aligned meta, and a copy affordance
  // that floats over the row instead of reserving flow space beside the title.
  check('tree rows carry no chevron glyph', !richText.includes('▾') && !richText.includes('▸'))
  check('tree meta hugs the right edge', richText.includes('"marginLeft":"auto"'))
  check('tree copy button is absolutely positioned', richText.includes('am-tree-actions') && richText.includes('"position":"absolute"'))
  check('tree copy button stays hidden until hover or focus', richText.includes('.am-tree-actions') && richText.includes('pointer-events: none') && richText.includes('focus-within .am-tree-actions'))
  check('tree copy button keeps its accessible label', richText.includes('"aria-label":"复制会话 ID: sim-session-alpha"'))
  check('panel head marks itself for the darwin clearance rule', richText.includes('am-panel-head') && richText.includes('html[data-platform=\\"darwin\\"] .am-panel-head') && richText.includes('--dsh-frame-top-clearance') && richText.includes('--dsh-frame-leading-clearance'))

  // Filtering and ordering: empty untitled zero-byte sessions, workspaces whose
  // every session was filtered, offline peers last, and peers with nothing to
  // show keeping their empty state.
  const filteredTree = {
    peers: [
      {
        online: true,
        verified: true,
        deviceId: 'sim-keep-peer',
        shortId: 'sim-kee…001',
        name: 'sim-keep-peer',
        source: 'lan',
        address: '127.0.0.1',
        rttMs: 1,
        workspaces: [
          {
            id: 'sim-ws-empty',
            title: 'Empty workspace',
            name: 'empty-workspace',
            path: '/tmp/sim/empty',
            sessions: [{ id: 'sim-session-empty', title: '', createdAt: 1763000200000, live: false, totalBytes: 0 }],
          },
          {
            id: 'sim-ws-mixed',
            title: 'Mixed workspace',
            name: 'mixed-workspace',
            path: '/tmp/sim/mixed',
            sessions: [
              { id: 'sim-session-untitled-bytes', title: '', createdAt: 1763000300000, live: false, totalBytes: 2048 },
              { id: 'sim-session-titled', title: 'Kept session', createdAt: 1763000400000, live: false },
            ],
          },
        ],
        error: null,
        lastSeenAt: null,
      },
      {
        online: true,
        verified: true,
        deviceId: 'sim-blank-peer',
        shortId: 'sim-bla…002',
        name: 'sim-blank-peer',
        source: 'lan',
        address: '127.0.0.1',
        rttMs: 2,
        workspaces: [{
          id: 'sim-ws-blank',
          title: 'Blank workspace',
          name: 'blank-workspace',
          path: '/tmp/sim/blank',
          sessions: [{ id: 'sim-session-blank', title: '(无标题)', createdAt: 1763000100000, live: false }],
        }],
        error: null,
        lastSeenAt: null,
      },
      {
        online: true,
        verified: true,
        deviceId: 'sim-no-workspace-peer',
        shortId: 'sim-no-…003',
        name: 'sim-no-workspace-peer',
        source: 'lan',
        address: '127.0.0.1',
        rttMs: 3,
        workspaces: [],
        error: null,
        lastSeenAt: null,
      },
      {
        online: false,
        verified: false,
        deviceId: 'sim-offline-peer',
        shortId: 'sim-off…004',
        name: 'sim-offline-peer',
        source: 'lan',
        address: null,
        rttMs: null,
        workspaces: [],
        error: null,
        lastSeenAt: 1763000000000,
      },
    ],
    generatedAt: 1763000000000,
  }
  React.__stateQueue = [{ data: null, error: null }, filteredTree, null, {}, null, null, null, false, 'conversation', 360, false, false, false, null, false, new Map(), false, false, false, false]
  const filteredPanel = renderElement(panelEntry.Component({}))
  const filteredText = JSON.stringify(filteredPanel)
  check('empty untitled zero-byte sessions are filtered out', !filteredText.includes('sim-session-empty'))
  check('a workspace whose sessions were all filtered is dropped', !filteredText.includes('empty-workspace') && !filteredText.includes('Empty workspace'))
  check('an untitled session with content survives the filter', filteredText.includes('sim-session-untitled-bytes'))
  check('a titled session survives the filter', filteredText.includes('Kept session'))
  check('a peer with only filtered sessions keeps its empty state', filteredText.includes('sim-blank-peer') && filteredText.includes('这个对端没有可展示的会话。'))
  check('a peer with no workspace keeps its empty state', filteredText.includes('sim-no-workspace-peer') && filteredText.includes('这个对端没有工作区。'))
  check('offline peers sort after online peers', filteredText.indexOf('sim-keep-peer') < filteredText.indexOf('sim-offline-peer'))

  // Second render: the trajectory tab, with reasoning expanded and full calls/errors.
  React.__stateQueue = [{ data: null, error: null }, presetTree, null, {}, presetSelection, presetTranscript, null, false, 'trajectory', 360, false, false, false, null, false, presetTotals, false, false, false, true]
  const trajectoryPanel = renderElement(panelEntry.Component({}))
  const trajectoryText = JSON.stringify(trajectoryPanel)
  check('trajectory tab shows tool calls and arguments', trajectoryText.includes('工具调用 · mesh_workspace_list') && trajectoryText.includes('参数:') && trajectoryText.includes('sim-remote-workspace'))
  check('trajectory tab shows tool errors and error codes', trajectoryText.includes('工具结果 · 报错') && trajectoryText.includes('AbortError') && trajectoryText.includes('ABORTED'))
  check('trajectory tab expands reasoning', trajectoryText.includes('The user wants a workspace tour.') && trajectoryText.includes('收起思考'))

  // Settings page with a loaded state: the version sits beside the section
  // title, and the peer card shows the remote plugin version.
  React.__stateQueue = [{
    data: {
      version: '0.1.0-rc.10',
      status: 'ready',
      peers: [{ deviceId: 'peer-1', shortId: 'peer…1', name: 'remote-mac', online: true, trusted: true, verified: true, version: '0.1.0-rc.9', rttMs: 12, transfer: { calls: 3, sentBytes: 120, receivedBytes: 4096, lastAt: 1 } }],
    },
    error: null,
  }]
  const outer = registration.Component({ close() {} })
  const tree = typeof outer.type === 'function' ? outer.type(outer.props) : outer
  check('settings wrapper renders the page element', outer && typeof outer.type === 'function')
  check('page renders a section tree', tree && tree.type === 'section' && tree.children.length > 0, tree?.type)
  const text = JSON.stringify(renderElement(tree))
  check('settings title carries the plugin version badge', text.includes('同账号互联') && text.includes('v0.1.0-rc.10'))
  check('peer card shows the remote plugin version', text.includes('v0.1.0-rc.9'))
  check('peer card shows transfer counters', text.includes('已收 4.0 KB · 已发 120 B · 3 次调用'))
  React.__stateQueue = []
  check('page includes the localized title', text.includes('同账号互联'))
  check('page includes the tool hint', text.includes('mesh_session_read'))
  check('page mentions the read-only guarantee', text.includes('只读'))
  check('page never contains a token field', !/token/i.test(text))
  check('client bundle has no syntax leftovers', typeof fs.statSync(path.join(import.meta.dirname, '..', 'client.js')).size === 'number')

  // Transfer card: edition-specific codec state plus site-provided links. The
  // Host state is the only source of link labels/urls; the client never
  // hardcodes them. A Host without `transfer` must render no card.
  check('settings page without transfer renders no transfer card', !text.includes('传输方式'))
  check('dictionaries expose the transfer copy strings', dicts.every(entry =>
    typeof entry.dict.transferTitle === 'string' &&
    typeof entry.dict.transferJsonl === 'string' &&
    typeof entry.dict.transferJlc === 'string' &&
    typeof entry.dict.transferCruising === 'string' &&
    typeof entry.dict.transferRestart === 'string' &&
    typeof entry.dict.transferJsonlHint === 'string' &&
    typeof entry.dict.transferRestartHint === 'string' &&
    typeof entry.dict.transferEnable === 'string' &&
    typeof entry.dict.transferDisable === 'string' &&
    typeof entry.dict.transferUnavailable === 'string' &&
    typeof entry.dict.transferDisabled === 'string' &&
    typeof entry.dict.transferLinksUnavailable === 'string' &&
    typeof entry.dict.transferEditionDsh === 'string' &&
    typeof entry.dict.transferEditionNight === 'string'))
  check('client posts the codec toggle through the existing helper', clientSource.includes("post('codec'") && clientSource.includes('enabled'))
  check('client does not hardcode the download/featured link copy', !clientSource.includes('下载夜间巡航版') && !clientSource.includes('插件精选'))
  check('client exposes vault copy and clear action', clientSource.includes('vaultTitle') && clientSource.includes("post('vault/clear'") && !clientSource.includes('vault/read'))

  const renderSettings = transfer => {
    React.__stateQueue = [{ data: { version: '0.1.0-rc.13', status: 'ready', peers: [], transfer, vault: { bytes: 1315069, entries: 1, maxBytes: 268435456 } }, error: null }]
    const outer = registration.Component({ close() {} })
    const tree = typeof outer.type === 'function' ? outer.type(outer.props) : outer
    return JSON.stringify(renderElement(tree))
  }
  const downloadLink = { label: 'TEST-DOWNLOAD', url: 'https://example.test/d', hint: 'TEST-DOWNLOAD-HINT' }
  const featuredLink = { label: 'TEST-FEATURED', url: 'https://example.test/f', hint: 'TEST-FEATURED-HINT' }

  // Native DSH: JSONL chip, hint, download link from state, no JLC toggle.
  const nativeText = renderSettings({
    edition: 'dsh',
    editionSource: 'env',
    mode: 'jsonl',
    desired: 'off',
    active: false,
    available: false,
    pendingRestart: false,
    reason: 'edition-requires-night-cruising',
    nativeVersion: null,
    links: { download: downloadLink, featured: null },
    linksStatus: 'ok',
    linksFetchedAt: 1763000000000,
  })
  check('native transfer card renders the JSONL chip', nativeText.includes('传输方式') && nativeText.includes('"children":[["JSONL"]]'))
  check('native transfer card shows the JSONL hint', nativeText.includes('当前为 JSONL 传输方式'))
  check('native transfer card marks the edition', nativeText.includes('原生 DSH'))
  check('native transfer card hides the JLC toggle', !nativeText.includes('"children":["启用 JLC 巡航加速"]') && !nativeText.includes('"children":["改用 JSONL"]'))
  check('native download link label and url come from state', nativeText.includes('TEST-DOWNLOAD') && nativeText.includes('"href":"https://example.test/d"') && nativeText.includes('"target":"_blank"') && nativeText.includes('"rel":"noreferrer"'))
  check('native download hint comes from state', nativeText.includes('TEST-DOWNLOAD-HINT'))
  check('native transfer card shows no featured link', !nativeText.includes('TEST-FEATURED'))
  check('settings page renders the encrypted vault card', nativeText.includes('保险柜') && nativeText.includes('已加密'), 'missing vault card')

  const nativeBrokenText = renderSettings({
    edition: 'dsh',
    editionSource: 'env',
    mode: 'jsonl',
    desired: 'off',
    active: false,
    available: false,
    pendingRestart: false,
    reason: 'edition-requires-night-cruising',
    nativeVersion: null,
    links: { download: null, featured: null },
    linksStatus: 'error',
    linksFetchedAt: null,
  })
  check('native transfer card falls back when the site links fail', nativeBrokenText.includes('精选配置暂不可用') && !nativeBrokenText.includes('TEST-DOWNLOAD'))

  // Night Cruising, active: green JLC chip, cruising status, featured link only.
  const nightActiveText = renderSettings({
    edition: 'night-cruising',
    editionSource: 'env',
    mode: 'jlc',
    desired: 'on',
    active: true,
    available: true,
    pendingRestart: false,
    reason: 'native-module-loaded',
    nativeVersion: '0.1.0',
    links: { download: downloadLink, featured: featuredLink },
    linksStatus: 'ok',
    linksFetchedAt: 1763000000000,
  })
  check('night cruising active shows the cruising status', nightActiveText.includes('本地到远端 巡航加速中'))
  check('night cruising active renders a green JLC chip', nightActiveText.includes('state-success-primary') && nightActiveText.includes('"children":[["JLC"]]'))
  check('night cruising active renders the featured link from state', nightActiveText.includes('TEST-FEATURED') && nightActiveText.includes('"href":"https://example.test/f"') && nightActiveText.includes('TEST-FEATURED-HINT'))
  check('night cruising active hides the download link', !nightActiveText.includes('TEST-DOWNLOAD'))
  check('night cruising active offers the JSONL switch', nightActiveText.includes('"children":["改用 JSONL"]'))
  check('night cruising active marks the edition', nightActiveText.includes('夜间巡航版'))

  // Night Cruising, saved but not loaded: warning chip + restart copy.
  const nightPendingText = renderSettings({
    edition: 'night-cruising',
    editionSource: 'env',
    mode: 'jsonl',
    desired: 'on',
    active: false,
    available: true,
    pendingRestart: true,
    reason: 'pending-restart',
    nativeVersion: '0.1.0',
    links: { download: null, featured: null },
    linksStatus: 'loading',
    linksFetchedAt: null,
  })
  check('night cruising pending shows the restart status', nightPendingText.includes('本地到远端 重启即出发'))
  check('night cruising pending explains the restart', nightPendingText.includes('设置已保存，重启 DSH 后生效。'))
  check('night cruising pending renders a warning JLC chip', nightPendingText.includes('state-warning-primary') && nightPendingText.includes('"children":[["JLC"]]'))
  check('night cruising pending offers the JSONL switch', nightPendingText.includes('"children":["改用 JSONL"]'))

  // Night Cruising with a missing native module and failed site links.
  const nightBrokenText = renderSettings({
    edition: 'night-cruising',
    editionSource: 'env',
    mode: 'jsonl',
    desired: 'off',
    active: false,
    available: false,
    pendingRestart: false,
    reason: 'native-module-missing',
    nativeVersion: null,
    links: { download: null, featured: null },
    linksStatus: 'error',
    linksFetchedAt: null,
  })
  check('night cruising unavailable reports the missing component', nightBrokenText.includes('JLC 加速组件不可用'))
  check('night cruising unavailable shows the links fallback', nightBrokenText.includes('精选配置暂不可用'))
  check('night cruising unavailable offers the enable button', nightBrokenText.includes('"children":["启用 JLC 巡航加速"]'))
  React.__stateQueue = []

} catch (error) {
  failures += 1
  console.error('CLIENT SMOKE ERROR', error)
} finally {
  console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`)
  process.exit(failures === 0 ? 0 : 1)
}
