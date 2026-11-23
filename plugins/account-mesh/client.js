/**
 * Browser half: a sidebar panel that renders peer workspaces and their
 * sessions as a read-only tree, a transcript reader, and the settings page
 * that shows status and owns the trust table.
 *
 * Every read goes through this Host's own `/account-mesh/api/*` routes; the
 * page never opens a peer connection itself and never writes to a peer.
 */
window.__ModuleLoader__.load({
  id: 'dsh-account-mesh',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'account-mesh'
    const PANEL_ID = 'account-mesh'

    const TEXT = {
      zh: {
        title: '同账号互联',
        description: '同一账号的两个 DSH 实例在局域网（含 Tailscale）通过加密数据通道互读会话与工作区，只读。',
        panelTitle: '远端工作区',
        panelHint: '对方的会话按工作区分组显示，只读。',
        status: '状态',
        account: '账号',
        device: '设备',
        fingerprint: '设备指纹',
        directory: '数据目录',
        discovery: '发现',
        addresses: '本机地址',
        tailscale: 'Tailscale',
        peers: '对端设备',
        noPeers: '还没有发现同账号的其它实例。',
        noPeersOnline: '没有在线且已认证的对端。请确认对方已启动 DSH 并安装本插件。',
        offlineTag: '离线',
        lastSeen: '最后在线',
        retry: '重试连接',
        neverSeen: '从未在本设备上线',
        untrusted: '未信任',
        trusted: '已信任',
        verified: '已认证',
        online: '在线',
        offline: '离线',
        trust: '信任',
        forget: '撤销信任',
        confirmForget: '再点一次确认撤销',
        reconnect: '重连',
        refresh: '刷新',
        toolHint: 'agent 使用这些工具读取远端：mesh_peers、mesh_session_list、mesh_session_read、mesh_workspace_list、mesh_file_read。',
        readOnly: '服务端只提供只读操作：没有写入、prompt、bash 或任意命令通道。',
        waiting: '读取中…',
        error: '读取失败',
        lastSeen: '最近信任',
        signedOut: '账号未登录',
        starting: '正在启动',
        ready: '运行中',
        disabled: '已停用',
        tailnetOn: '可用',
        tailnetOff: '未检测到',
        untitled: '(无标题)',
        live: '进行中',
        empty: '空',
        openSession: '打开会话',
        transcriptEmpty: '这个会话没有可显示的文本。',
        loadMore: '加载更多',
        sessionsCount: '{n} 个会话',
        workspaceUnknown: '未知工作区',
        readOnlyTag: '只读',
        noWorkspaces: '这个对端没有工作区。',
      },
      en: {
        title: 'Account mesh',
        description: 'Two DSH instances on the same account read each other\'s sessions and workspace over an encrypted data channel on the LAN, Tailscale included. Read-only.',
        panelTitle: 'Remote workspaces',
        panelHint: 'The peer\'s sessions grouped by workspace, read-only.',
        status: 'Status',
        account: 'Account',
        device: 'Device',
        fingerprint: 'Fingerprint',
        directory: 'Data directory',
        discovery: 'Discovery',
        addresses: 'Local addresses',
        tailscale: 'Tailscale',
        peers: 'Peer devices',
        noPeers: 'No other instance of this account has been discovered yet.',
        noPeersOnline: 'No online authenticated peer. Make sure the other device runs DSH with this plugin.',
        offlineTag: 'offline',
        lastSeen: 'Last seen',
        retry: 'Retry',
        neverSeen: 'Never came online on this device',
        untrusted: 'Untrusted',
        trusted: 'Trusted',
        verified: 'Authenticated',
        online: 'online',
        offline: 'offline',
        trust: 'Trust',
        forget: 'Revoke',
        confirmForget: 'Click again to revoke',
        reconnect: 'Reconnect',
        refresh: 'Refresh',
        toolHint: 'The agent reads the peer through: mesh_peers, mesh_session_list, mesh_session_read, mesh_workspace_list, mesh_file_read.',
        readOnly: 'The serving side exposes read-only operations only: no writes, prompts, shells or arbitrary commands.',
        waiting: 'Loading…',
        error: 'Load failed',
        lastSeen: 'Trusted',
        signedOut: 'Signed out',
        starting: 'Starting',
        ready: 'Running',
        disabled: 'Disabled',
        tailnetOn: 'available',
        tailnetOff: 'not detected',
        untitled: '(untitled)',
        live: 'live',
        empty: 'empty',
        openSession: 'Open session',
        transcriptEmpty: 'This session has no displayable text.',
        loadMore: 'Load more',
        sessionsCount: '{n} sessions',
        workspaceUnknown: 'Unknown workspace',
        readOnlyTag: 'read-only',
        noWorkspaces: 'This peer has no workspace.',
      },
    }

    const styles = {
      page: { padding: '4px 2px 24px', maxWidth: '760px', color: 'var(--dsw-alias-label-primary)', fontSize: '13px', lineHeight: 1.55 },
      title: { fontSize: '16px', fontWeight: 600, margin: '0 0 4px' },
      desc: { color: 'var(--dsw-alias-label-secondary)', margin: '0 0 16px', fontSize: '12px' },
      card: { border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', borderRadius: '10px', padding: '12px 14px', marginBottom: '12px' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      label: { color: 'var(--dsw-alias-label-secondary)', minWidth: '92px', fontSize: '12px' },
      value: { fontFamily: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)', fontSize: '12px', wordBreak: 'break-all' },
      chip: (tone) => ({
        display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '1px 8px', borderRadius: '999px', fontSize: '11px',
        border: '1px solid var(--dsw-alias-border-l2)',
        color: tone === 'on' ? 'var(--dsw-alias-state-success-primary)' : tone === 'warn' ? 'var(--dsw-alias-state-warning-primary, var(--dsw-alias-label-secondary))' : 'var(--dsw-alias-label-secondary)',
        background: 'var(--dsw-alias-bg-layer-2)',
      }),
      peer: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '10px', padding: '10px 12px', marginBottom: '8px', background: 'var(--dsw-alias-bg-layer-2)' },
      peerHead: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap', marginBottom: '6px' },
      peerName: { fontWeight: 600, fontSize: '13px' },
      mono: { fontFamily: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)', fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-all' },
      button: { font: 'inherit', fontSize: '12px', cursor: 'pointer', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '7px', padding: '3px 10px' },
      buttonPrimary: { font: 'inherit', fontSize: '12px', cursor: 'pointer', color: 'var(--dsw-alias-label-primary-foreground, #fff)', background: 'var(--dsw-alias-brand-primary)', border: '1px solid transparent', borderRadius: '7px', padding: '3px 10px' },
      hint: { color: 'var(--dsw-alias-label-secondary)', fontSize: '11.5px', margin: '10px 0 0' },
      error: { color: 'var(--dsw-alias-state-error-primary, #d64545)', fontSize: '12px', margin: '8px 0 0' },
      panel: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, color: 'var(--dsw-alias-label-primary)', fontSize: '13px' },
      panelHead: { display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 14px', borderBottom: '1px solid var(--dsw-alias-border-l2)', flexWrap: 'wrap' },
      panelBody: { display: 'flex', flex: 1, minHeight: 0 },
      treePane: { width: '320px', flex: 'none', borderRight: '1px solid var(--dsw-alias-border-l2)', overflow: 'auto', padding: '8px 6px 24px' },
      transcriptPane: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 },
      treeRow: (depth, active) => ({
        display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 6px', paddingLeft: `${6 + depth * 14}px`,
        borderRadius: '7px', cursor: 'pointer', fontSize: '12.5px',
        background: active ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
      }),
      treeName: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      treeMeta: { color: 'var(--dsw-alias-label-secondary)', fontSize: '11px', flex: 'none' },
      chevron: { width: '12px', flex: 'none', color: 'var(--dsw-alias-label-secondary)' },
      msg: { padding: '8px 14px', borderBottom: '1px solid var(--dsw-alias-border-l2)' },
      msgRole: { fontSize: '10.5px', letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--dsw-alias-label-secondary)', marginBottom: '3px' },
      msgText: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: '12.5px', lineHeight: 1.55 },
      toolbar: { display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 14px', borderBottom: '1px solid var(--dsw-alias-border-l2)' },
      empty: { color: 'var(--dsw-alias-label-secondary)', padding: '24px 14px', fontSize: '12.5px' },
    }

    function useMeshState() {
      const [state, setState] = React.useState({ data: null, error: null })
      React.useEffect(() => {
        let alive = true
        let timer
        const load = async () => {
          try {
            const response = await fetch('/account-mesh/api/state', { headers: { accept: 'application/json' } })
            const body = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
            if (alive) setState({ data: body, error: null })
          } catch (error) {
            if (alive) setState(current => ({ data: current.data, error: error.message }))
          }
          if (alive) timer = setTimeout(load, 2500)
        }
        load()
        return () => {
          alive = false
          clearTimeout(timer)
        }
      }, [])
      return state
    }

    function post(path, body) {
      return fetch(`/account-mesh/api/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(async response => {
        const payload = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)
        return payload
      })
    }

    function Chip({ tone = 'off', children }) {
      return h('span', { style: styles.chip(tone) }, children)
    }

    function Field({ label, children }) {
      return h('div', { style: { ...styles.row, alignItems: 'flex-start', marginTop: '4px' } },
        h('span', { style: styles.label }, label),
        h('span', { style: styles.value }, children))
    }

    function statusLabel(t, status) {
      if (status === 'ready') return t('ready')
      if (status === 'disabled') return t('disabled')
      if (status === 'signed-out') return t('signedOut')
      return t('starting')
    }

    function formatTime(ms) {
      if (!ms) return ''
      try {
        return new Date(ms).toLocaleString()
      } catch {
        return String(ms)
      }
    }

    function fill(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) => (values[key] === undefined ? match : String(values[key])))
    }

    function PeerCard({ peer, t, onAction, pending }) {
      const [confirming, setConfirming] = React.useState(false)
      React.useEffect(() => {
        if (!confirming) return
        const timer = setTimeout(() => setConfirming(false), 4000)
        return () => clearTimeout(timer)
      }, [confirming])
      const tone = peer.online ? (peer.verified ? 'on' : 'warn') : 'off'
      return h('div', { style: styles.peer },
        h('div', { style: styles.peerHead },
          h('span', { style: styles.peerName }, peer.name || peer.shortId),
          h(Chip, { tone }, peer.online ? t('online') : t('offline')),
          peer.verified ? h(Chip, { tone: 'on' }, t('verified')) : null,
          peer.trusted ? h(Chip, { tone: 'on' }, t('trusted')) : h(Chip, { tone: 'warn' }, t('untrusted')),
          peer.source === 'tailnet' ? h(Chip, { tone: 'off' }, 'Tailscale') : null,
          peer.rttMs !== null && peer.rttMs !== undefined ? h(Chip, { tone: 'off' }, `${peer.rttMs} ms`) : null),
        h('div', { style: styles.mono }, peer.deviceId),
        peer.fingerprint ? h('div', { style: styles.mono }, `${t('fingerprint')}: ${peer.fingerprint}`) : null,
        peer.online && peer.address ? h('div', { style: styles.mono }, peer.address) : null,
        h('div', { style: { ...styles.row, marginTop: '8px' } },
          !peer.trusted
            ? h('button', { style: styles.buttonPrimary, disabled: pending, onClick: () => onAction('pair', peer.deviceId) }, t('trust'))
            : null,
          peer.trusted
            ? h('button', { style: styles.button, disabled: pending, onClick: () => onAction('reconnect', peer.deviceId) }, t('reconnect'))
            : null,
          peer.trusted
            ? h('button', {
                style: confirming ? styles.buttonPrimary : styles.button,
                disabled: pending,
                onClick: () => {
                  if (!confirming) return setConfirming(true)
                  setConfirming(false)
                  onAction('forget', peer.deviceId)
                },
              }, confirming ? t('confirmForget') : t('forget'))
            : null))
    }

    const SettingsPage = props => {
      const t = props.translate
      const { data, error } = useMeshState()
      const [pending, setPending] = React.useState(false)
      const [actionError, setActionError] = React.useState(null)

      const run = async (action, deviceId) => {
        setPending(true)
        setActionError(null)
        try {
          await post(action, { deviceId })
        } catch (failure) {
          setActionError(failure.message)
        } finally {
          setPending(false)
        }
      }

      const state = data ?? {}
      const peers = state.peers ?? []
      const discovery = state.discovery ?? null
      const device = state.device ?? {}
      const account = state.account ?? {}

      return h('section', { style: styles.page },
        h('h2', { style: styles.title }, t('title')),
        h('p', { style: styles.desc }, t('description')),
        error ? h('p', { style: styles.error }, `${t('error')}: ${error}`) : null,
        actionError ? h('p', { style: styles.error }, actionError) : null,
        h('div', { style: styles.card },
          h('div', { style: styles.row },
            h('span', { style: styles.label }, t('status')),
            h(Chip, { tone: state.status === 'ready' ? 'on' : state.status === 'disabled' || state.status === 'signed-out' ? 'warn' : 'off' }, statusLabel(t, state.status)),
            state.version ? h(Chip, { tone: 'off' }, `v${state.version}`) : null),
          h(Field, { label: t('account') }, account.status ?? '—'),
          h(Field, { label: t('device') }, `${device.name ?? '—'} · ${device.id ?? '—'}`),
          device.fingerprint ? h(Field, { label: t('fingerprint') }, device.fingerprint) : null,
          device.directory ? h(Field, { label: t('directory') }, device.directory) : null,
          discovery
            ? h(Field, { label: t('discovery') }, `:${discovery.port} · ${discovery.addresses.map(entry => entry.address).join(', ') || '—'}`)
            : null,
          h(Field, { label: t('tailscale') },
            state.tailscale?.available ? h(Chip, { tone: 'on' }, `${t('tailnetOn')} · ${state.tailscale.peers} peer(s)`) : h(Chip, { tone: 'off' }, t('tailnetOff'))),
          state.lastError ? h('p', { style: styles.error }, state.lastError.message) : null),
        h('div', { style: { ...styles.row, justifyContent: 'space-between', margin: '14px 0 8px' } },
          h('h3', { style: { ...styles.title, fontSize: '13px', margin: 0 } }, t('peers')),
          h('button', { style: styles.button, onClick: () => window.location.reload() }, t('refresh'))),
        peers.length === 0
          ? h('p', { style: styles.hint }, t('noPeers'))
          : peers.map(peer => h(PeerCard, { key: peer.deviceId, peer, t, pending, onAction: run })),
        h('p', { style: styles.hint }, t('toolHint')),
        h('p', { style: styles.hint }, t('readOnly')))
    }

    /** One message row in the read-only transcript. */
    function TranscriptItem({ item }) {
      const role = item.role === 'tool-call'
        ? `${item.name ?? 'tool'}`
        : item.role === 'tool-result'
          ? (item.isError ? 'tool · error' : 'tool')
          : item.role
      const tone = item.isError ? 'var(--dsw-alias-state-error-primary, #d64545)' : 'var(--dsw-alias-label-secondary)'
      return h('div', { style: styles.msg },
        h('div', { style: { ...styles.msgRole, color: tone } }, `${role} · ${formatTime(item.time)}`),
        item.text ? h('div', { style: styles.msgText }, item.text) : null)
    }

    function TreeRow({ depth, label, meta, active, expandable, expanded, onClick }) {
      return h('div', {
        style: styles.treeRow(depth, active),
        onClick,
        role: expandable ? 'button' : 'button',
        title: label,
      },
        h('span', { style: styles.chevron }, expandable ? (expanded ? '▾' : '▸') : ''),
        h('span', { style: styles.treeName }, label),
        meta ? h('span', { style: styles.treeMeta }, meta) : null)
    }

    const MeshPanel = props => {
      const t = props.translate
      const [tree, setTree] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [expanded, setExpanded] = React.useState({})
      const [selection, setSelection] = React.useState(null)
      const [transcript, setTranscript] = React.useState(null)
      const [transcriptError, setTranscriptError] = React.useState(null)
      const [loadingMore, setLoadingMore] = React.useState(false)

      const loadTree = React.useCallback(async () => {
        try {
          const response = await fetch('/account-mesh/api/tree', { headers: { accept: 'application/json' } })
          const body = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
          setTree(body)
          setError(null)
        } catch (failure) {
          setError(failure.message)
        }
      }, [])

      React.useEffect(() => {
        let alive = true
        const tick = () => { if (alive) loadTree() }
        tick()
        const timer = setInterval(tick, 15000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [loadTree])

      const loadTranscript = React.useCallback(async (target, fromSeq = 0) => {
        try {
          const query = new URLSearchParams({ peer: target.peer, sessionId: target.sessionId, fromSeq: String(fromSeq), limit: '200' })
          const response = await fetch(`/account-mesh/api/transcript?${query.toString()}`, { headers: { accept: 'application/json' } })
          const body = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
          setTranscript(current => {
            if (fromSeq === 0 || !current) return body
            return { ...body, items: [...current.items, ...(body.items ?? [])] }
          })
          setTranscriptError(null)
        } catch (failure) {
          setTranscriptError(failure.message)
        }
      }, [])

      React.useEffect(() => {
        if (!selection) {
          setTranscript(null)
          return
        }
        setTranscript(null)
        setTranscriptError(null)
        loadTranscript(selection, 0)
      }, [selection, loadTranscript])

      const toggle = key => setExpanded(current => ({ ...current, [key]: current[key] === false }))
      const isOpen = key => expanded[key] !== false

      const peers = tree?.peers ?? []
      const offlinePeers = peers.filter(peer => !peer.online)
      const verifiedPeers = peers.filter(peer => peer.online === true && !peer.error)
      const retry = async deviceId => {
        try {
          await post('reconnect', { deviceId })
          await loadTree()
        } catch (failure) {
          setError(failure.message)
        }
      }

      const transcriptBody = () => {
        if (!selection) return h('div', { style: styles.empty }, t('panelHint'))
        if (transcriptError) return h('div', { style: styles.empty }, `${t('error')}: ${transcriptError}`)
        if (!transcript) return h('div', { style: styles.empty }, t('waiting'))
        const items = transcript.items ?? []
        return h(React.Fragment, null,
          h('div', { style: { flex: 1, overflow: 'auto' } },
            items.length === 0 ? h('div', { style: styles.empty }, t('transcriptEmpty')) : null,
            items.map(item => h(TranscriptItem, { key: item.seq, item: item }))),
          transcript.hasMore
            ? h('div', { style: { padding: '8px 14px', borderTop: '1px solid var(--dsw-alias-border-l2)' } },
                h('button', {
                  style: styles.button,
                  disabled: loadingMore,
                  onClick: async () => {
                    setLoadingMore(true)
                    await loadTranscript(selection, transcript.nextSeq)
                    setLoadingMore(false)
                  },
                }, t('loadMore')))
            : null)
      }

      return h('section', { style: styles.panel },
        h('div', { style: styles.panelHead },
          h('span', { style: { ...styles.title, margin: 0 } }, t('panelTitle')),
          h(Chip, { tone: 'off' }, t('readOnlyTag')),
          h('span', { style: styles.treeMeta }, `${verifiedPeers.length} device(s)`),
          h('span', { style: { flex: 1 } }),
          error ? h('span', { style: styles.treeMeta }, `${t('error')}: ${error}`) : null,
          h('button', { style: styles.button, onClick: () => loadTree() }, t('refresh'))),
        h('div', { style: styles.panelBody },
          h('div', { style: styles.treePane },
            verifiedPeers.length === 0 && tree !== null
              ? h('div', { style: styles.empty }, t('noPeersOnline'))
              : null,
            offlinePeers.map(peer => h('div', { key: `offline:${peer.deviceId}`, style: { ...styles.empty, padding: '6px 10px' } },
              h('div', { style: { ...styles.row, color: 'var(--dsw-alias-label-secondary)' } },
                h('span', { style: styles.chevron }, '·'),
                h('span', { style: { ...styles.treeName, color: 'var(--dsw-alias-label-secondary)' } }, peer.name || peer.shortId),
                h(Chip, { tone: 'off' }, t('offlineTag'))),
              h('div', { style: { ...styles.treeMeta, paddingLeft: '18px' } },
                peer.lastSeenAt ? `${t('lastSeen')} ${formatTime(peer.lastSeenAt)}` : `${t('neverSeen')} · ${peer.shortId}`),
              h('div', { style: { paddingLeft: '18px', marginTop: '4px' } },
                h('button', { style: styles.button, onClick: () => retry(peer.deviceId) }, t('retry'))))),
            verifiedPeers.map(peer => {
              const peerKey = peer.deviceId
              const peerOpen = isOpen(peerKey)
              return h('div', { key: peerKey },
                h(TreeRow, {
                  depth: 0,
                  label: peer.name || peer.shortId,
                  meta: peer.source === 'tailnet' ? `tailscale · ${peer.rttMs != null ? `${peer.rttMs}ms` : peer.shortId}` : peer.shortId,
                  expandable: true,
                  expanded: peerOpen,
                  onClick: () => toggle(peerKey),
                }),
                peer.error ? h('div', { style: { ...styles.empty, padding: '4px 20px' } }, peer.error) : null,
                peerOpen
                  ? (peer.workspaces.length === 0
                      ? h('div', { style: { ...styles.empty, padding: '4px 20px' } }, t('noWorkspaces'))
                      : peer.workspaces.map(workspace => {
                          const workspaceKey = `${peerKey}/${workspace.id}`
                          const workspaceOpen = isOpen(workspaceKey)
                          return h('div', { key: workspaceKey },
                            h(TreeRow, {
                              depth: 1,
                              label: workspace.title || t('workspaceUnknown'),
                              meta: `${workspace.sessions.length}`,
                              expandable: true,
                              expanded: workspaceOpen,
                              onClick: () => toggle(workspaceKey),
                            }),
                            workspaceOpen
                              ? workspace.sessions.map(session => {
                                  const active = selection?.peer === peerKey && selection?.sessionId === session.id
                                  return h(TreeRow, {
                                    key: session.id,
                                    depth: 2,
                                    label: session.title || t('untitled'),
                                    meta: session.live ? t('live') : formatTime(session.createdAt),
                                    active,
                                    onClick: () => setSelection({ peer: peerKey, sessionId: session.id, title: session.title }),
                                  })
                                })
                              : null)
                        }))
                  : null)
            })),
          h('div', { style: styles.transcriptPane },
            selection
              ? h('div', { style: styles.toolbar },
                  h('span', { style: { fontWeight: 600, fontSize: '12.5px' } }, selection.title || t('untitled')),
                  h('span', { style: styles.treeMeta }, selection.sessionId),
                  h(Chip, { tone: 'off' }, t('readOnlyTag')),
                  h('span', { style: { flex: 1 } }),
                  h('button', { style: styles.button, onClick: () => setSelection(null) }, '×'))
              : null,
            transcriptBody())))
    }

    function MeshIcon({ size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('circle', { cx: 6.5, cy: 12, r: 3.2, stroke: 'currentColor', strokeWidth: 1.7 }),
        h('circle', { cx: 17.5, cy: 12, r: 3.2, stroke: 'currentColor', strokeWidth: 1.7 }),
        h('path', { d: 'M9.7 12h4.6', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeDasharray: '1.5 2.2' }))
    }

    return {
      name: 'account-mesh',
      inject: ['slots', 'locale'],
      apply(ctx) {
        for (const [locale, dict] of Object.entries(TEXT)) {
          ctx.effect(() => ctx.locale.register(NS, locale, dict), `account-mesh: ${locale} dictionary`)
        }
        const t = ctx.locale.bind(NS)
        const subscribe = ctx.locale.subscribe.bind(ctx.locale)
        const getSnapshot = ctx.locale.getSnapshot.bind(ctx.locale)
        const localized = Component => props => {
          const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
          void snapshot.revision
          return h(Component, { ...props, translate: t })
        }
        const Settings = localized(SettingsPage)
        const Panel = localized(MeshPanel)

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: PANEL_ID,
          order: 17,
          locale: NS,
          label: () => t('title'),
        }, Settings))

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 30,
          locale: NS,
          label: () => t('panelTitle'),
        }, MeshIcon))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          label: () => t('panelTitle'),
        }, Panel))
      },
    }
  },
})
