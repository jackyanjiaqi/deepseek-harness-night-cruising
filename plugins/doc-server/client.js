/**
 * Browser half of the DSH "文档服务" (document service) plugin.
 *
 * Registers:
 *  - a Conversation View tab named "文档服务" that embeds the Session's own
 *    document server;
 *  - workspace-file context menus (directory start/switch, file locate);
 *  - a settings page listing every running server with a jump action;
 *  - a card for the `doc_server` agent tool that renders a jump button.
 *
 * Every read/write goes through the Host's `/doc-server/api/*` control
 * routes. The document pages themselves are served by the per-Session
 * document server on its own port, exactly like cmd_tools/doc-server.
 */
window.__ModuleLoader__.load({
  id: 'dsh-doc-server',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'docServer'
    const VIEW_ID = 'doc-server'
    const TOOL_NAME = 'doc_server'
    const POLL_MS = 2000

    const SUPPORTED_EXTENSIONS = new Set([
      '.md', '.html', '.pdf', '.pptx', '.doc', '.docx', '.txt',
      '.png', '.apng', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif', '.ico',
    ])

    const TEXT = {
      zh: {
        'view.title': '文档服务',
        'view.start': '启动文档服务',
        'view.startDefault': '以工作空间根目录启动',
        'view.chooseDirectory': '选择目录…',
        'view.switchDirectory': '切换目录…',
        'view.stop': '停止',
        'view.refresh': '刷新',
        'view.openExternal': '新窗口打开',
        'view.root': '根目录',
        'view.port': '端口',
        'view.noServerTitle': '尚未启动文档服务',
        'view.noServerHint': '该会话还没有启动文档服务。可以从侧边栏工作区文件右键选择目录，或直接使用工作空间根目录启动。',
        'view.starting': '正在启动…',
        'view.stopping': '正在停止…',
        'view.loading': '加载中…',
        'view.retry': '重试',
        'view.startFailed': '启动失败',
        'view.crashTitle': '文档服务渲染失败',
        'view.crashHint': '把下面的错误信息发给开发者，或在修复后点击重试。',
        'view.crashRetry': '重试',
        'settings.title': '文档服务',
        'settings.description': '查看所有已启动的文档服务；点击“跳转”会打开对应会话并切换到它的“文档服务”标签。',
        'settings.empty': '还没有已启动的文档服务。从侧边栏工作区文件的右键菜单选择目录，或在会话的“文档服务”标签中启动。',
        'settings.session': '会话',
        'settings.address': '地址',
        'settings.root': '根目录',
        'settings.lastFile': '最后定位',
        'settings.startedAt': '启动时间',
        'settings.jump': '跳转',
        'settings.open': '打开',
        'settings.stop': '停止',
        'settings.refresh': '刷新',
        'settings.stopAll': '全部停止',
        'settings.noFile': '未定位文件',
        'settings.count': '共 {n} 个服务',
        'menu.startDirectory': '启动目录',
        'menu.switchDirectory': '切换目录',
        'menu.locateFile': '定位文件',
        'menu.started': '文档服务已启动',
        'menu.switched': '文档服务目录已切换',
        'menu.located': '已在文档服务中定位',
        'menu.failed': '文档服务操作失败',
        'menu.noSwitch': '操作已完成；当前构建缺少会话视图切换补丁，请手动点击“文档服务”标签。',
        'tool.title': '文档服务',
        'tool.preparing': '正在准备文档服务…',
        'tool.starting': '正在定位文档…',
        'tool.open': '在文档服务中打开',
        'tool.copy': '复制链接',
        'tool.copied': '链接已复制',
        'tool.copyFailed': '复制失败',
        'tool.openFailed': '打开失败',
        'tool.noSwitch': '已定位；当前构建缺少会话视图切换补丁，请手动点击“文档服务”标签。',
        'tool.listSummary': '共 {n} 个文档服务',
        'tool.notRunning': '文档服务未启动',
        'tool.stopped': '文档服务已停止',
        'tool.openService': '打开文档服务',
        'tool.failed': '文档服务调用失败',
        'notice.patchRequired': '当前构建缺少会话视图切换补丁；请手动点击顶部“文档服务”标签。',
        'notice.noWorkspace': '当前会话没有可用的工作目录。',
        'notice.unknownSession': '会话不可用。',
      },
      en: {
        'view.title': 'Document service',
        'view.start': 'Start document service',
        'view.startDefault': 'Start at workspace root',
        'view.chooseDirectory': 'Choose directory…',
        'view.switchDirectory': 'Switch directory…',
        'view.stop': 'Stop',
        'view.refresh': 'Refresh',
        'view.openExternal': 'Open in new window',
        'view.root': 'Root',
        'view.port': 'Port',
        'view.noServerTitle': 'Document service is not running',
        'view.noServerHint': 'This session has no document service yet. Start it from a workspace-folder context menu, or use the workspace root.',
        'view.starting': 'Starting…',
        'view.stopping': 'Stopping…',
        'view.loading': 'Loading…',
        'view.retry': 'Retry',
        'view.startFailed': 'Could not start',
        'view.crashTitle': 'Document service failed to render',
        'view.crashHint': 'Send the error below to the developer, then retry after a fix.',
        'view.crashRetry': 'Retry',
        'settings.title': 'Document service',
        'settings.description': 'All running document services. Jump opens the owning session and selects its Document service tab.',
        'settings.empty': 'No document service is running. Start one from a workspace-folder context menu, or from a session’s Document service tab.',
        'settings.session': 'Session',
        'settings.address': 'Address',
        'settings.root': 'Root',
        'settings.lastFile': 'Last located',
        'settings.startedAt': 'Started',
        'settings.jump': 'Jump',
        'settings.open': 'Open',
        'settings.stop': 'Stop',
        'settings.refresh': 'Refresh',
        'settings.stopAll': 'Stop all',
        'settings.noFile': 'No file located',
        'settings.count': '{n} services',
        'menu.startDirectory': 'Start directory',
        'menu.switchDirectory': 'Switch directory',
        'menu.locateFile': 'Locate file',
        'menu.started': 'Document service started',
        'menu.switched': 'Document service directory switched',
        'menu.located': 'Located in the document service',
        'menu.failed': 'Document service action failed',
        'menu.noSwitch': 'Done. This build lacks the Conversation View patch; click the “Document service” tab manually.',
        'tool.title': 'Document service',
        'tool.preparing': 'Preparing the document service…',
        'tool.starting': 'Locating the document…',
        'tool.open': 'Open in document service',
        'tool.copy': 'Copy link',
        'tool.copied': 'Link copied',
        'tool.copyFailed': 'Copy failed',
        'tool.openFailed': 'Open failed',
        'tool.noSwitch': 'Located. This build lacks the Conversation View patch; click the “Document service” tab manually.',
        'tool.listSummary': '{n} document services',
        'tool.notRunning': 'Document service is not running',
        'tool.stopped': 'Document service stopped',
        'tool.openService': 'Open document service',
        'tool.failed': 'Document service call failed',
        'notice.patchRequired': 'This build lacks the Conversation View selection patch; click the “Document service” tab in the header.',
        'notice.noWorkspace': 'This session has no working directory.',
        'notice.unknownSession': 'Session unavailable.',
      },
    }
    TEXT.ja = TEXT.en
    TEXT.es = TEXT.en
    TEXT.fr = TEXT.en
    TEXT.de = TEXT.en
    TEXT.ru = TEXT.en
    TEXT.pt = TEXT.en

    function fill(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (_match, key) =>
        values[key] === undefined ? `{${key}}` : String(values[key]))
    }

    function sameOrigin(href, base) {
      try {
        return new URL(href).origin === new URL(base).origin
      } catch {
        return false
      }
    }

    /** Identity of one server instance plus its locate counter. */
    function hostVersion(server) {
      return `${server?.instanceId || 'legacy'}:${server?.token ?? 0}`
    }

    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        set(next) {
          value = next
          for (const listener of [...listeners]) {
            try {
              listener()
            } catch (error) {
              console.error('[doc-server] store listener failed:', error)
            }
          }
        },
      }
    }

    function useDocStore() {
      return React.useSyncExternalStore(docStore.subscribe, docStore.getSnapshot, docStore.getSnapshot)
    }

    // ---------------------------------------------------------------------
    // Control API
    // ---------------------------------------------------------------------

    async function request(path, { method = 'GET', body, signal } = {}) {
      const response = await fetch(`/doc-server/api/${path}`, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal === undefined ? {} : { signal }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload.ok === false) {
        const error = new Error(payload.error || `HTTP ${response.status}`)
        error.code = payload.code
        error.status = response.status
        throw error
      }
      return payload
    }

    const api = {
      list: (signal) => request('list', { signal }),
      state: (sessionId, signal) => request(`state?sessionId=${encodeURIComponent(sessionId)}`, { signal }),
      start: (sessionId, directory) => request('start', { method: 'POST', body: { sessionId, directory } }),
      switchRoot: (sessionId, directory) => request('switch-root', { method: 'POST', body: { sessionId, directory } }),
      locate: (sessionId, file) => request('locate', { method: 'POST', body: { sessionId, file } }),
      stop: (sessionId) => request('stop', { method: 'POST', body: { sessionId } }),
      track: (sessionId, href) => request('track', { method: 'POST', body: { sessionId, href } }),
    }

    // ---------------------------------------------------------------------
    // Shared state, retained by mounted views
    // ---------------------------------------------------------------------

    const docStore = createStore({
      servers: [],
      byId: {},
      localUrls: {},
      version: null,
      loading: false,
      error: null,
    })

    let retainCount = 0
    let pollTimer = null
    let inFlight = null

    function byIdOf(servers) {
      const map = {}
      for (const server of servers) map[server.sessionId] = server
      return map
    }

    async function refresh() {
      if (inFlight !== null) return inFlight
      const before = docStore.getSnapshot()
      if (before.servers.length === 0 && before.loading !== true) {
        docStore.set({ ...before, loading: true })
      }
      inFlight = (async () => {
        try {
          const result = await api.list()
          const servers = Array.isArray(result.servers) ? result.servers : []
          const current = docStore.getSnapshot()
          const nextById = byIdOf(servers)
          const localUrls = {}
          for (const [sessionId, local] of Object.entries(current.localUrls)) {
            if (nextById[sessionId] !== undefined) localUrls[sessionId] = local
          }
          docStore.set({
            ...current,
            servers,
            byId: nextById,
            localUrls,
            version: typeof result.version === 'string' ? result.version : null,
            loading: false,
            error: null,
          })
        } catch (error) {
          const current = docStore.getSnapshot()
          docStore.set({ ...current, loading: false, error: error.message })
        } finally {
          inFlight = null
        }
      })()
      return inFlight
    }

    function retain() {
      retainCount += 1
      if (retainCount === 1) {
        void refresh()
        pollTimer = setInterval(() => { void refresh() }, POLL_MS)
      }
      let released = false
      return () => {
        if (released) return
        released = true
        retainCount -= 1
        if (retainCount === 0 && pollTimer !== null) {
          clearInterval(pollTimer)
          pollTimer = null
        }
      }
    }

    function applyServer(server) {
      if (server === undefined || server === null) return
      const current = docStore.getSnapshot()
      const servers = current.servers.filter((item) => item.sessionId !== server.sessionId)
      servers.push(server)
      servers.sort((left, right) => left.startedAt - right.startedAt)
      const localUrls = { ...current.localUrls }
      delete localUrls[server.sessionId]
      docStore.set({ ...current, servers, byId: byIdOf(servers), localUrls })
    }

    function removeServer(sessionId) {
      const current = docStore.getSnapshot()
      const servers = current.servers.filter((item) => item.sessionId !== sessionId)
      const localUrls = { ...current.localUrls }
      delete localUrls[sessionId]
      docStore.set({ ...current, servers, byId: byIdOf(servers), localUrls })
    }

    function setLocalUrl(sessionId, href, file, hostToken) {
      const current = docStore.getSnapshot()
      docStore.set({
        ...current,
        localUrls: {
          ...current.localUrls,
          [sessionId]: { href, file: file || '', hostToken },
        },
      })
    }

    // ---------------------------------------------------------------------
    // Navigation helpers
    // ---------------------------------------------------------------------

    const ctxRef = { current: null }

    function notify(message, success = true) {
      const menus = ctxRef.current?.get?.('contextMenus')
      if (menus !== undefined && typeof menus.notify === 'function') {
        menus.notify(message, success)
      } else if (success === false) {
        console.warn('[doc-server]', message)
      }
    }

    function persistViewPreference(sessionId, viewId) {
      try {
        const key = `dsh.conversation.${sessionId}`
        const raw = localStorage.getItem(key)
        const parsed = raw === null ? {} : JSON.parse(raw)
        // The Conversation store replaces its whole state on rehydration, so
        // keep every field; a bare { view } would erase the saved draft.
        const next = {
          draft: '',
          view: null,
          viewRequest: null,
          ...(typeof parsed === 'object' && parsed !== null ? parsed : {}),
        }
        next.view = viewId
        localStorage.setItem(key, JSON.stringify(next))
      } catch {
        // Storage can be unavailable; the patched selection path still works.
      }
    }

    /** Select the Conversation View tab, using the patch when present. */
    function selectDocView(sessionId) {
      const conversation = ctxRef.current?.get?.('uiConversation')
      if (conversation !== undefined && typeof conversation.selectView === 'function') {
        conversation.selectView(sessionId, VIEW_ID)
        return true
      }
      persistViewPreference(sessionId, VIEW_ID)
      return false
    }

    /** Open the owning Session and switch to its document-service tab. */
    function openDocSession(sessionId) {
      const workspace = ctxRef.current?.get?.('uiWorkspace')
      try {
        workspace?.openSession?.(sessionId)
      } catch (error) {
        console.warn('[doc-server] openSession failed:', error)
      }
      return selectDocView(sessionId)
    }

    async function locateAndJump(sessionId, file) {
      const result = await api.locate(sessionId, file)
      if (result.server) applyServer(result.server)
      const switched = openDocSession(sessionId)
      return { server: result.server, switched }
    }

    async function startOrSwitch(sessionId, directory) {
      const current = docStore.getSnapshot().byId[sessionId]
      const result = current === undefined
        ? await api.start(sessionId, directory)
        : await api.switchRoot(sessionId, directory)
      if (result.server) applyServer(result.server)
      const switched = openDocSession(sessionId)
      return { server: result.server, switched }
    }

    async function startDefault(sessionId) {
      const result = await api.start(sessionId)
      if (result.server) applyServer(result.server)
      const switched = openDocSession(sessionId)
      return { server: result.server, switched }
    }

    async function stopServer(sessionId) {
      await api.stop(sessionId)
      removeServer(sessionId)
    }

    function runMenuAction(message, failureLabel, action, noSwitchMessage) {
      return (async () => {
        try {
          const result = await action()
          if (result !== undefined && result.switched === false && noSwitchMessage !== undefined) {
            notify(noSwitchMessage, false)
          } else {
            notify(message, true)
          }
        } catch (error) {
          notify(error?.message || failureLabel, false)
        }
      })()
    }

    // ---------------------------------------------------------------------
    // Styles
    // ---------------------------------------------------------------------

    const CSS = `
      .dsd-root { display: flex; flex-direction: column; min-height: 360px; overflow: hidden; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); border-top: 1px solid var(--dsw-alias-border-l2); }
      .dsd-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 14px; border-bottom: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }
      .dsd-toolbar-title { font-weight: 600; font-size: 13px; }
      .dsd-meta { color: var(--dsw-alias-label-secondary); font-size: 11.5px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 360px; }
      .dsd-mono { font-family: var(--dsh-code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11.5px; }
      .dsd-spacer { flex: 1; }
      .dsd-button { font: inherit; font-size: 12px; line-height: 20px; cursor: pointer; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px; padding: 2px 10px; white-space: nowrap; }
      .dsd-button:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .dsd-button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
      .dsd-button:disabled { opacity: .55; cursor: not-allowed; }
      .dsd-button-primary { color: var(--dsw-alias-label-primary-foreground, #fff); background: var(--dsw-alias-brand-primary); border-color: transparent; }
      .dsd-button-primary:hover { filter: brightness(1.08); background: var(--dsw-alias-brand-primary); }
      .dsd-frame { flex: 1; width: 100%; min-height: 0; border: 0; display: block; background: #f5f6f8; }
      .dsd-frame-wrap { flex: 1; min-height: 0; display: flex; }
      .dsd-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 36px 24px; text-align: center; }
      .dsd-empty h2 { margin: 0; font-size: 15px; font-weight: 600; }
      .dsd-empty p { margin: 0; max-width: 520px; color: var(--dsw-alias-label-secondary); font-size: 12.5px; line-height: 1.6; }
      .dsd-empty-code { max-width: 640px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 4px 10px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); }
      .dsd-error { color: var(--dsw-alias-state-error-primary, #d64545); font-size: 12px; padding: 6px 14px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
      .dsd-page { padding: 4px 2px 28px; max-width: 900px; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.55; }
      .dsd-page h2 { margin: 0 0 4px; font-size: 16px; font-weight: 600; }
      .dsd-title-version { margin-left: 10px; font-size: 11px; font-weight: 400; vertical-align: 2px; font-family: var(--dsh-code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace); color: var(--dsw-alias-label-secondary); border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px; padding: 1px 8px; background: var(--dsw-alias-bg-layer-2); }
      .dsd-page-desc { margin: 0 0 14px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
      .dsd-page-tools { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
      .dsd-card { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); border-radius: 10px; padding: 12px 14px; margin-bottom: 10px; }
      .dsd-card-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
      .dsd-card-title { font-weight: 600; font-size: 13px; }
      .dsd-card-purpose { color: var(--dsw-alias-label-secondary); font-size: 11.5px; }
      .dsd-field { display: flex; align-items: baseline; gap: 8px; margin-top: 4px; min-width: 0; }
      .dsd-field-label { color: var(--dsw-alias-label-secondary); font-size: 11.5px; min-width: 68px; flex: none; }
      .dsd-field-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dsd-card-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
      .dsd-empty-list { color: var(--dsw-alias-label-secondary); font-size: 12.5px; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 10px; padding: 22px; text-align: center; }
      .dsd-chip { display: inline-flex; align-items: center; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); font-size: 11px; }
      .dsd-tool-card { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); border-radius: 10px; padding: 10px 12px; margin: 4px 0; max-width: 720px; }
      .dsd-tool-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
      .dsd-tool-name { font-weight: 600; font-size: 12.5px; flex: none; }
      .dsd-tool-file { color: var(--dsw-alias-label-secondary); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dsd-tool-meta { color: var(--dsw-alias-label-secondary); font-size: 11px; margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dsd-tool-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
      .dsd-tool-error { color: var(--dsw-alias-state-error-primary, #d64545); font-size: 12px; margin-top: 6px; }
      .dsd-fade { opacity: .75; }
    `

    function StyleTag() {
      return h('style', { 'data-dsh-doc-server': 'true' }, CSS)
    }

    function DocIcon({ size = 16, active = false }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true,
        style: { color: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor' },
      },
      h('path', { d: 'M6 3.75h7.2L18 8.55V20.25H6z', stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round' }),
      h('path', { d: 'M13 3.9v4.8h4.8', stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round' }),
      h('path', { d: 'M9 12h6M9 15h4', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
      h('circle', { cx: 18.4, cy: 18.4, r: 3.1, fill: 'var(--dsw-alias-bg-layer-1)', stroke: 'currentColor', strokeWidth: 1.4 }),
      h('path', { d: 'M17 18.4h2.8M18.4 17v2.8', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }))
    }

    // ---------------------------------------------------------------------
    // Conversation View tab
    // ---------------------------------------------------------------------

    /**
     * Keep one View crash from blanking the whole tab. The slot renderer would
     * otherwise abdicate the entry and leave an empty view area with no clue;
     * this boundary shows the error and offers a retry.
     */
    class DocErrorBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error, info) {
        console.error('[doc-server] view render failed:', error, info)
      }

      render() {
        if (this.state.error === null) return this.props.children
        let title = '文档服务渲染失败'
        let hint = '把下面的错误信息发给开发者，或在修复后点击重试。'
        let retry = '重试'
        try {
          if (typeof this.props.t === 'function') {
            title = this.props.t('view.crashTitle')
            hint = this.props.t('view.crashHint')
            retry = this.props.t('view.crashRetry')
          }
        } catch {
          // The locale function itself may be the failure; keep the fallback copy.
        }
        const detail = String(this.state.error?.stack || this.state.error?.message || this.state.error).slice(0, 1600)
        return h('div', {
          style: {
            display: 'flex', flexDirection: 'column', gap: '10px', padding: '28px 24px',
            color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-1)',
            minHeight: '240px', overflow: 'auto',
          },
          'data-dsh-doc-server-error': 'render',
        },
          h('h2', { style: { margin: 0, fontSize: '15px', fontWeight: 600 } }, title),
          h('p', { style: { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: '12.5px' } }, hint),
          h('pre', {
            style: {
              margin: 0, padding: '10px 12px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              fontFamily: 'var(--dsh-code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace)',
              fontSize: '11.5px', lineHeight: 1.5, background: 'var(--dsw-alias-bg-layer-2)',
              border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '8px',
              color: 'var(--dsw-alias-state-error-primary, #d64545)', maxHeight: '360px', overflow: 'auto',
            },
          }, detail),
          h('div', null,
            h('button', {
              type: 'button', className: 'dsd-button',
              onClick: () => this.setState({ error: null }),
            }, retry)))
      }
    }

    function DocServerView(props) {
      return h(DocErrorBoundary, { t: props.t }, h(DocViewBody, props))
    }

    function DocViewBody(props) {
      const { sessionId, t, useSessions } = props
      const snapshot = useDocStore()
      const server = snapshot.byId[sessionId]
      const local = snapshot.localUrls[sessionId]
      const [src, setSrc] = React.useState('')
      const [reload, setReload] = React.useState(0)
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [probing, setProbing] = React.useState(true)
      const mountedKey = React.useRef('')
      React.useEffect(() => retain(), [])
      const cwd = useSessions((sessions) => sessions.byId[sessionId]?.cwd)

      // The global list can be one poll behind a server started in another
      // window. Probe this Session directly before offering "start", so the
      // empty-state action never switches a running root by accident.
      React.useEffect(() => {
        if (server !== undefined) {
          setProbing(false)
          return undefined
        }
        let alive = true
        setProbing(true)
        api.state(sessionId).then((result) => {
          if (!alive) return
          if (result.server !== null && result.server !== undefined) applyServer(result.server)
          setProbing(false)
        }).catch(() => {
          if (alive) setProbing(false)
        })
        return () => { alive = false }
      }, [sessionId, server === undefined])

      const effectiveUrl = React.useMemo(() => {
        if (server === undefined) return ''
        if (local !== undefined && local.hostToken === hostVersion(server) && typeof local.href === 'string' && local.href !== '' && sameOrigin(local.href, server.url)) {
          return local.href
        }
        return server.currentUrl || server.url
      }, [server?.instanceId, server?.token, server?.currentUrl, server?.url, local?.hostToken, local?.href])

      const displayFile = server === undefined
        ? ''
        : local !== undefined && local.hostToken === hostVersion(server) && typeof local.file === 'string' && local.file !== ''
          ? local.file
          : server.currentFile

      React.useEffect(() => {
        if (server === undefined) {
          mountedKey.current = ''
          setSrc('')
          return
        }
        const key = `${sessionId}:${hostVersion(server)}`
        if (mountedKey.current === key) return
        mountedKey.current = key
        setSrc(effectiveUrl)
      }, [sessionId, server?.instanceId, server?.token, effectiveUrl])

      const startDefaultHere = async () => {
        setBusy('start')
        setError('')
        try {
          const current = await api.state(sessionId)
          if (current.server !== null && current.server !== undefined) {
            applyServer(current.server)
            return
          }
          await startDefault(sessionId)
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy('')
        }
      }

      const chooseDirectory = async () => {
        setError('')
        try {
          const directory = await ctxRef.current?.get?.('uiWorkspace')?.pickDirectory?.()
          if (directory === null || directory === undefined) return
          setBusy('switch')
          await startOrSwitch(sessionId, directory)
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy('')
        }
      }

      const stopHere = async () => {
        setBusy('stop')
        setError('')
        try {
          await stopServer(sessionId)
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy('')
        }
      }

      const refreshFrame = () => {
        setError('')
        setSrc(effectiveUrl)
        setReload((value) => value + 1)
      }

      const openExternal = () => {
        if (effectiveUrl === '') return
        window.open(effectiveUrl, '_blank', 'noopener,noreferrer')
      }

      const toolbar = h('div', { className: 'dsd-toolbar' },
        h('span', { className: 'dsd-toolbar-title' }, t('view.title')),
        server === undefined ? null : h('span', { className: 'dsd-meta', title: `${t('view.root')}: ${server.root}` },
          h('span', { className: 'dsd-mono' }, server.root)),
        server === undefined ? null : h('span', { className: 'dsd-chip' }, `${t('view.port')} ${server.port}`),
        displayFile === '' ? null : h('span', { className: 'dsd-meta', title: displayFile }, displayFile),
        h('span', { className: 'dsd-spacer' }),
        server === undefined ? null : h('button', {
          type: 'button', className: 'dsd-button', onClick: refreshFrame, disabled: busy !== '',
        }, t('view.refresh')),
        server === undefined ? null : h('button', {
          type: 'button', className: 'dsd-button', onClick: openExternal, disabled: busy !== '',
        }, t('view.openExternal')),
        h('button', {
          type: 'button', className: 'dsd-button', onClick: chooseDirectory, disabled: busy !== '',
        }, busy === 'switch' ? t('view.starting') : server === undefined ? t('view.chooseDirectory') : t('view.switchDirectory')),
        server === undefined ? null : h('button', {
          type: 'button', className: 'dsd-button', onClick: stopHere, disabled: busy !== '',
        }, busy === 'stop' ? t('view.stopping') : t('view.stop')))

      let body
      if (server === undefined && (snapshot.loading || probing)) {
        body = h('div', { className: 'dsd-empty' },
          h(DocIcon, { size: 34 }),
          h('p', null, t('view.loading')))
      } else if (server === undefined) {
        body = h('div', { className: 'dsd-empty' },
          h(DocIcon, { size: 34 }),
          h('h2', null, t('view.noServerTitle')),
          h('p', null, t('view.noServerHint')),
          cwd === undefined ? null : h('p', { className: 'dsd-mono dsd-empty-code', title: cwd }, cwd),
          h('div', { className: 'dsd-tool-actions' },
            h('button', {
              type: 'button', className: 'dsd-button dsd-button-primary', disabled: busy !== '', onClick: startDefaultHere,
            }, busy === 'start' ? t('view.starting') : t('view.startDefault')),
            h('button', {
              type: 'button', className: 'dsd-button', disabled: busy !== '', onClick: chooseDirectory,
            }, t('view.chooseDirectory'))))
      } else {
        // Prefer the fresh Host URL for the render that observes a new locate
        // token; the state copy is one effect behind and would load the old
        // file first. In-iframe navigation keeps the stable state URL.
        const mountedForHost = mountedKey.current === `${sessionId}:${hostVersion(server)}`
        const frameSrc = mountedForHost && src !== '' ? src : effectiveUrl
        body = h('div', { className: 'dsd-frame-wrap' },
          h('iframe', {
            key: `${sessionId}:${hostVersion(server)}:${reload}`,
            className: 'dsd-frame',
            src: frameSrc,
            title: `${t('view.title')} · ${server.title || sessionId}`,
            allow: 'clipboard-read; clipboard-write',
            'data-dsh-doc-server-frame': sessionId,
          }))
      }

      return h(React.Fragment, null,
        h(StyleTag, null),
        h('div', {
          className: 'dsd-root',
          style: {
            height: 'calc(var(--dsh-conversation-viewport-height, 100vh) - var(--dsh-composer-height, 120px))',
          },
          'data-dsh-doc-server-view': sessionId,
        },
        toolbar,
        error === '' ? null : h('div', { className: 'dsd-error' }, error),
        body))
    }

    // ---------------------------------------------------------------------
    // Settings page
    // ---------------------------------------------------------------------

    function formatTime(value) {
      try {
        return new Date(value).toLocaleString()
      } catch {
        return String(value)
      }
    }

    function copyText(text, t) {
      try {
        if (navigator.clipboard?.writeText !== undefined) {
          void navigator.clipboard.writeText(text).then(
            () => notify(t('tool.copied'), true),
            () => notify(t('tool.copyFailed'), false))
          return
        }
      } catch {
        // Fall through to the failure notice.
      }
      notify(t('tool.copyFailed'), false)
    }

    function SettingsRow({ server, local, t, close }) {
      const localMatches = local !== undefined && local.hostToken === hostVersion(server)
        && typeof local.href === 'string' && sameOrigin(local.href, server.url)
      const lastUrl = localMatches ? local.href : (server.currentUrl || server.url)
      const lastFile = localMatches && local.file !== '' ? local.file : server.currentFile
      return h('div', { className: 'dsd-card', 'data-dsh-doc-server-row': server.sessionId },
        h('div', { className: 'dsd-card-head' },
          h(DocIcon, { size: 16 }),
          h('span', { className: 'dsd-card-title', title: server.title }, server.title || server.sessionId),
          h('span', { className: 'dsd-chip' }, `${t('view.port')} ${server.port}`),
          h('span', { className: 'dsd-card-purpose' }, formatTime(server.startedAt))),
        h('div', { className: 'dsd-field' },
          h('span', { className: 'dsd-field-label' }, t('settings.address')),
          h('a', {
            className: 'dsd-field-value dsd-mono', href: server.url,
            target: '_blank', rel: 'noreferrer', title: server.url,
          }, server.url)),
        h('div', { className: 'dsd-field' },
          h('span', { className: 'dsd-field-label' }, t('settings.root')),
          h('span', { className: 'dsd-field-value dsd-mono', title: server.root }, server.root)),
        h('div', { className: 'dsd-field' },
          h('span', { className: 'dsd-field-label' }, t('settings.lastFile')),
          h('span', {
            className: 'dsd-field-value dsd-mono',
            title: lastFile || t('settings.noFile'),
          }, lastFile || t('settings.noFile'))),
        h('div', { className: 'dsd-card-actions' },
          h('button', {
            type: 'button', className: 'dsd-button dsd-button-primary',
            onClick: () => {
              close?.()
              if (!openDocSession(server.sessionId)) notify(t('notice.patchRequired'), false)
            },
          }, t('settings.jump')),
          h('button', {
            type: 'button', className: 'dsd-button',
            onClick: () => { window.open(lastUrl, '_blank', 'noopener,noreferrer') },
          }, t('settings.open')),
          h('button', {
            type: 'button', className: 'dsd-button',
            onClick: () => { copyText(lastUrl, t) },
          }, t('tool.copy')),
          h('button', {
            type: 'button', className: 'dsd-button',
            onClick: () => { stopServer(server.sessionId).catch((error) => { notify(error.message, false) }) },
          }, t('settings.stop'))))
    }

    function SettingsPage(props) {
      const { t, close } = props
      const snapshot = useDocStore()
      React.useEffect(() => retain(), [])
      const servers = snapshot.servers

      const stopAll = async () => {
        await Promise.all(servers.map(async (server) => {
          try {
            await stopServer(server.sessionId)
          } catch (error) {
            notify(error.message, false)
          }
        }))
      }

      return h(React.Fragment, null,
        h(StyleTag, null),
        h('div', { className: 'dsd-page', 'data-dsh-doc-server-settings': '' },
          h('h2', null, t('settings.title'),
            snapshot.version ? h('span', { className: 'dsd-title-version' }, `v${snapshot.version}`) : null),
          h('p', { className: 'dsd-page-desc' }, t('settings.description')),
          h('div', { className: 'dsd-page-tools' },
            h('button', { type: 'button', className: 'dsd-button', onClick: () => { void refresh() } }, t('settings.refresh')),
            servers.length === 0 ? null : h('button', { type: 'button', className: 'dsd-button', onClick: () => { void stopAll() } }, t('settings.stopAll')),
            h('span', { className: 'dsd-card-purpose' }, fill(t('settings.count'), { n: servers.length })),
            snapshot.error === null ? null : h('span', { className: 'dsd-tool-error' }, snapshot.error)),
          servers.length === 0
            ? h('div', { className: 'dsd-empty-list' }, snapshot.loading ? t('view.loading') : t('settings.empty'))
            : servers.map((server) => h(SettingsRow, {
              key: server.sessionId,
              server,
              local: snapshot.localUrls[server.sessionId],
              t,
              close,
            }))))
    }

    // ---------------------------------------------------------------------
    // Agent tool card
    // ---------------------------------------------------------------------

    function parseArgs(block) {
      const raw = (block !== undefined && 'call' in block ? block.call?.argsRaw : block?.argsRaw) ?? ''
      try {
        const parsed = JSON.parse(raw)
        return typeof parsed === 'object' && parsed !== null ? parsed : {}
      } catch {
        return {}
      }
    }

    function parsePayload(block) {
      if (block === undefined || !('kind' in block) || block.isError === true) return undefined
      const text = (block.content || [])
        .filter((item) => item.type === 'text')
        .map((item) => item.text)
        .join('\n')
      try {
        const parsed = JSON.parse(text)
        return typeof parsed === 'object' && parsed !== null ? parsed : undefined
      } catch {
        return undefined
      }
    }

    function resultError(block) {
      if (block === undefined || !('kind' in block)) return ''
      if (block.isError !== true && block.error === undefined) return ''
      const text = (block.content || []).filter((item) => item.type === 'text').map((item) => item.text).join('\n')
      if (text !== '') return text
      if (block.error !== undefined) return `${block.error.name || 'Error'}: ${block.error.code || block.error.message || ''}`
      return ''
    }

    function DocToolCard(props) {
      const { sessionId, phase, block, t } = props
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      if (phase === 'preparing') {
        return h(React.Fragment, null,
          h(StyleTag, null),
          h('div', { className: 'dsd-tool-card', 'data-dsh-doc-server-tool': 'preparing' },
            h('div', { className: 'dsd-tool-head' },
              h(DocIcon, { size: 15 }),
              h('span', { className: 'dsd-tool-name' }, t('tool.title')),
              h('span', { className: 'dsd-tool-file dsd-fade' }, t('tool.preparing')))))
      }
      const args = parseArgs(block)
      const payload = parsePayload(block) ?? {}
      const failure = resultError(block)
      const action = typeof payload.action === 'string'
        ? payload.action
        : typeof args.action === 'string' ? args.action : 'open'
      const server = payload.server !== null && typeof payload.server === 'object' ? payload.server : undefined
      const servers = Array.isArray(payload.servers) ? payload.servers : []
      const file = payload.file || server?.currentFile || (typeof args.file === 'string' ? args.file : '')
      const url = payload.url || server?.currentUrl || ''
      const root = payload.root || server?.root || ''
      const port = typeof payload.port === 'number'
        ? payload.port
        : typeof server?.port === 'number' ? server.port : undefined
      const openTarget = url || file
      const isFileAction = action === 'open' || action === 'link' || action === 'locate'
      const canOpen = isFileAction ? openTarget !== '' : server !== undefined

      let summary = file
      if (action === 'list') {
        summary = fill(t('tool.listSummary'), { n: servers.length })
      } else if (action === 'status') {
        summary = server === undefined ? t('tool.notRunning') : `${root} · ${t('view.port')} ${port}`
      } else if (action === 'stop') {
        summary = payload.stopped === true ? t('tool.stopped') : t('tool.notRunning')
      } else if (action === 'start' || action === 'switch') {
        summary = server === undefined ? t('tool.notRunning') : `${root} · ${t('view.port')} ${port}`
      }

      const open = async () => {
        if (busy || !canOpen) return
        setBusy(true)
        setError('')
        try {
          if (isFileAction) {
            const result = await locateAndJump(sessionId, openTarget)
            if (result.switched === false) setError(t('tool.noSwitch'))
            return
          }
          if (server !== undefined) {
            applyServer(server)
            if (!openDocSession(sessionId)) setError(t('tool.noSwitch'))
          }
        } catch (failureInfo) {
          setError(failureInfo.message)
        } finally {
          setBusy(false)
        }
      }
      const copy = () => {
        if (url === '') return
        copyText(url, t)
      }
      return h(React.Fragment, null,
        h(StyleTag, null),
        h('div', {
          className: 'dsd-tool-card',
          'data-dsh-doc-server-tool': phase,
          'data-dsh-doc-server-action': action,
          'data-dsh-doc-server-file': file,
        },
          h('div', { className: 'dsd-tool-head' },
            h(DocIcon, { size: 15 }),
            h('span', { className: 'dsd-tool-name' }, t('tool.title')),
            h('span', { className: 'dsd-tool-file', title: summary }, summary || (phase === 'start' ? t('tool.starting') : '')),
            typeof port === 'number' ? h('span', { className: 'dsd-chip' }, `${t('view.port')} ${port}`) : null),
          root === '' ? null : h('div', { className: 'dsd-tool-meta', title: root }, root),
          url === '' ? null : h('div', { className: 'dsd-tool-meta dsd-mono', title: url }, url),
          failure !== '' ? h('div', { className: 'dsd-tool-error' }, failure) : null,
          error !== '' ? h('div', { className: 'dsd-tool-error' }, error) : null,
          h('div', { className: 'dsd-tool-actions' },
            h('button', {
              type: 'button', className: 'dsd-button dsd-button-primary',
              disabled: busy || !canOpen,
              onClick: () => { void open() },
            }, busy ? t('tool.starting') : isFileAction ? t('tool.open') : t('tool.openService')),
            h('button', {
              type: 'button', className: 'dsd-button', disabled: url === '' || busy, onClick: copy,
            }, t('tool.copy')))))
    }

    // ---------------------------------------------------------------------
    // Apply
    // ---------------------------------------------------------------------

    return {
      name: 'dsh-doc-server',
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctxRef.current = ctx

        for (const [locale, dict] of Object.entries(TEXT)) {
          ctx.effect(() => ctx.locale.register(NS, locale, dict), `doc-server: ${locale} dictionary`)
        }
        const t = ctx.locale.bind(NS)

        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: VIEW_ID,
          order: 20,
          locale: NS,
          label: () => t('view.title'),
        }, DocServerView))

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: VIEW_ID,
          order: 18,
          locale: NS,
          label: () => t('settings.title'),
        }, SettingsPage))

        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon',
          id: VIEW_ID,
          order: 18,
          locale: NS,
          label: () => t('settings.title'),
        }, DocIcon))

        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
          name: 'tool.call.toolview',
          key: TOOL_NAME,
          locale: NS,
        }, DocToolCard))

        // Announce in-iframe navigation so the settings jump and a remounted
        // tab land on the last viewed file, not only the last Host locate.
        const onMessage = (event) => {
          const data = event?.data
          if (data === null || typeof data !== 'object' || data.type !== 'dsh-doc-server:location') return
          if (typeof data.href !== 'string') return
          const current = docStore.getSnapshot()
          for (const server of current.servers) {
            let origin = ''
            try {
              origin = new URL(server.url).origin
            } catch {
              continue
            }
            if (origin !== event.origin) continue
            const frame = document.querySelector(`iframe[data-dsh-doc-server-frame="${server.sessionId}"]`)
            if (frame === null || frame.contentWindow !== event.source) continue
            setLocalUrl(server.sessionId, data.href, typeof data.file === 'string' ? data.file : '', hostVersion(server))
            // Persist the in-page location so a page refresh or a second window
            // still opens the last viewed document.
            api.track(server.sessionId, data.href).catch(() => {})
            return
          }
        }
        ctx.effect(() => {
          window.addEventListener('message', onMessage)
          return () => window.removeEventListener('message', onMessage)
        }, 'doc-server: iframe navigation bridge')
        ctx.effect(() => () => {
          if (pollTimer !== null) {
            clearInterval(pollTimer)
            pollTimer = null
          }
        }, 'doc-server: polling lifetime')

        ctx.inject(['contextMenus'], (child) => {
          const menus = child.get('contextMenus')
          if (menus === undefined) return
          child.effect(() => menus.register({
            id: 'doc-server.directory',
            target: 'directory',
            order: 300,
            resolve: async ({ sessionId, path }, signal) => {
              let running = false
              try {
                const result = await api.state(sessionId, signal)
                running = result.server !== null && result.server !== undefined
              } catch {
                // Unknown session state leaves the menu on its start label;
                // the action itself reports the concrete failure.
              }
              return [{
                id: 'doc-server-root',
                separatorBefore: true,
                failureLabel: t('menu.failed'),
                label: running ? t('menu.switchDirectory') : t('menu.startDirectory'),
                run: () => runMenuAction(
                  running ? t('menu.switched') : t('menu.started'),
                  t('menu.failed'),
                  () => startOrSwitch(sessionId, path),
                  t('menu.noSwitch'),
                ),
              }]
            },
          }), 'doc-server: directory menu')
          child.effect(() => menus.register({
            id: 'doc-server.file',
            target: 'file',
            order: 300,
            resolve: ({ sessionId, path }) => {
              const extension = extensionOf(path)
              if (!SUPPORTED_EXTENSIONS.has(extension)) return []
              return [{
                id: 'doc-server-locate',
                separatorBefore: true,
                failureLabel: t('menu.failed'),
                label: t('menu.locateFile'),
                run: () => runMenuAction(
                  t('menu.located'),
                  t('menu.failed'),
                  () => locateAndJump(sessionId, path),
                  t('menu.noSwitch'),
                ),
              }]
            },
          }), 'doc-server: file menu')
        })
      },
    }

    function extensionOf(path) {
      const name = String(path || '')
      const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
      const base = name.slice(slash + 1)
      const dot = base.lastIndexOf('.')
      return dot <= 0 ? '' : base.slice(dot).toLowerCase()
    }

  },
})
