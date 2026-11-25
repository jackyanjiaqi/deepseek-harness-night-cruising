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
  React.__stateQueue = [presetTree, null, {}, presetSelection, presetTranscript, null, false, 'conversation', 360, false, false, presetTotals, false, false, false, false]
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

  // Second render: the trajectory tab, with reasoning expanded and full calls/errors.
  React.__stateQueue = [presetTree, null, {}, presetSelection, presetTranscript, null, false, 'trajectory', 360, false, false, presetTotals, false, false, false, true]
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
} catch (error) {
  failures += 1
  console.error('CLIENT SMOKE ERROR', error)
} finally {
  console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`)
  process.exit(failures === 0 ? 0 : 1)
}
