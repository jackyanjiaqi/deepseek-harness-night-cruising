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
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
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

  const outer = registration.Component({ close() {} })
  const tree = typeof outer.type === 'function' ? outer.type(outer.props) : outer
  check('settings wrapper renders the page element', outer && typeof outer.type === 'function')
  check('page renders a section tree', tree && tree.type === 'section' && tree.children.length > 0, tree?.type)
  const text = JSON.stringify(tree)
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
