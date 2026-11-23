/**
 * Browser half: one settings page showing mesh status and the trust table.
 *
 * The page reads only this Host's own `/account-mesh/api/*` routes; remote
 * session and file content is never rendered here, so nothing remote is
 * buffered into the page.
 */
window.__ModuleLoader__.load({
  id: 'dsh-account-mesh',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'account-mesh'

    const TEXT = {
      zh: {
        title: '同账号互联',
        description: '同一账号的两个 DSH 实例在局域网（含 Tailscale）通过加密数据通道互读会话与工作区，只读。',
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
        copyFp: '点击复制指纹',
      },
      en: {
        title: 'Account mesh',
        description: 'Two DSH instances on the same account read each other\'s sessions and workspace over an encrypted data channel on the LAN, Tailscale included. Read-only.',
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
        copyFp: 'Click to copy the fingerprint',
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

    const Page = props => {
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

    return {
      name: 'account-mesh',
      inject: ['slots', 'locale'],
      apply(ctx) {
        for (const [locale, dict] of Object.entries(TEXT)) {
          ctx.effect(() => ctx.locale.register(NS, locale, dict), `account-mesh: ${locale} dictionary`)
        }
        const t = ctx.locale.bind(NS)
        // Bind the face methods: they are service methods and must keep their receiver.
        const subscribe = ctx.locale.subscribe.bind(ctx.locale)
        const getSnapshot = ctx.locale.getSnapshot.bind(ctx.locale)
        const Wrapped = props => {
          const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
          void snapshot.revision
          return h(Page, { ...props, translate: t })
        }
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'account-mesh',
          order: 17,
          locale: NS,
          label: () => t('title'),
        }, Wrapped))
      },
    }
  },
})
