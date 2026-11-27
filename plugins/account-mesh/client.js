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
    // ReactDOM is part of the Web shell's module baseline; the blocking trust
    // dialog portals to document.body so it covers every panel and seat.
    const ReactDOM = require('react-dom')
    // The store engine is part of the Web shell's module baseline; the
    // frame-wide trust host publishes its request list through it.
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store')
    const h = React.createElement
    const NS = 'account-mesh'
    const PANEL_ID = 'account-mesh'

    const TEXT = {
      zh: {
        title: '同账号互联',
        description: '同一账号的多个 DSH 实例在局域网（含 Tailscale）通过加密数据通道互读会话与工作区，只读。',
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
        revoked: '已撤销',
        revokedHint: '你已撤销这台设备的信任；账号规则不会自动恢复它，只有「信任」按钮可以重新授权。',
        pendingTrust: '待确认',
        trustRequestTitle: '一台设备请求读取你的会话',
        trustRequestBody: '{name} 与你登录了同一个账号，想读取本机 DSH 的会话与工作区（只读）。在你选择之前，它无法连接。',
        trustRequestDevice: '设备 ID',
        trustRequestFingerprint: '设备指纹',
        trustRequestAddress: '地址',
        trustRequestTrust: '信任这台设备',
        trustRequestRefuse: '拒绝并撤销',
        trustRequestHint: '拒绝是持久的：账号规则不会自动恢复信任，之后只能在设置页手动信任。',
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
        signedOut: '账号未登录',
        starting: '正在启动',
        ready: '运行中',
        disabled: '已停用',
        tailnetOn: '可用',
        tailnetOff: '未检测到',
        channels: '发现通道',
        lanChannel: '局域网',
        tailnetChannel: 'Tailscale',
        testLan: '测试局域网',
        testTailnet: '测试 Tailscale',
        refreshNetwork: '刷新网络状态',
        localTestPeer: '本机测试连接端',
        localTestHint: '开启后，没有真实连接时用本机真实会话渲染远端工作区；一旦有真实对端认证成功，测试端自动隐藏。',
        localTestHidden: '已隐藏：当前有真实对端连接',
        localTestEnabled: '已开启',
        localTestDisabled: '已关闭',
        probeTarget: '目标地址',
        probeTargetHint: '留空则测试已知对端；可填 IP:端口',
        probeReplied: '收到应答',
        probeNoReply: '无应答',
        probeRunning: '测试中…',
        lanMulticast: '组播',
        lanBroadcast: '广播',
        lanLocal: '本机地址',
        tailnetPeersKnown: 'tailnet 设备',
        channelPeers: '{n} 个对端',
        channelAnnounces: '已发 {n} 次',
        channelReplies: '收到 {n} 次',
        untitled: '(无标题)',
        live: '进行中',
        justNow: '刚刚',
        minutesAgo: '{n} 分钟',
        hoursAgo: '{n} 小时',
        daysAgo: '{n} 天',
        peerDetails: '设备详情',
        peerIdLabel: '设备 ID',
        peerAddressLabel: '地址',
        peerSourceLabel: '来源',
        peerRttLabel: '延迟',
        peerPairCodeLabel: '配对码',
        peerTrustedAtLabel: '信任时间',
        peerLastSeenLabel: '最后在线',
        peerFingerprintLabel: '指纹',
        peerOnlineLabel: '状态',
        peerOnlineValue: '在线',
        peerOfflineValue: '离线',
        peerVerifiedValue: '已认证',
        peerUnverifiedValue: '未认证',
        peerSourceLan: '局域网',
        peerSourceTailnet: 'Tailscale',
        peerSourceLocal: '本机测试',
        peerSourceTrusted: '信任表',
        peerSessionsLabel: '会话数',
        peerWorkspacesLabel: '工作区数',
        sessionCreatedLabel: '创建时间',
        sessionCwdLabel: '工作目录',
        sessionLiveLabel: '状态',
        sessionLiveValue: '进行中',
        sessionIdLabelShort: '会话 ID',
        empty: '空',
        loadMore: '加载更多',
        sessionsCount: '{n} 个会话',
        devicesCount: '{n} 台设备',
        workspaceUnknown: '未知工作区',
        readOnlyTag: '只读',
        noWorkspaces: '这个对端没有工作区。',
        noVisibleWorkspaces: '这个对端没有可展示的会话。',
        sessionsPane: '会话',
        conversationTab: '对话',
        trajectoryTab: '轨迹',
        sessionIdLabel: '会话 ID',
        copySessionId: '复制会话 ID',
        copied: '已复制',
        copyFailed: '复制失败',
        messageEvent: '消息',
        toolCallEvent: '工具调用',
        toolResultEvent: '工具结果',
        toolResultError: '工具结果 · 报错',
        thinking: '思考过程',
        expandThinking: '展开思考',
        collapseThinking: '收起思考',
        userRole: '用户',
        assistantRole: '助手',
        toolArguments: '参数',
        errorName: '错误',
        emptyConversation: '这个会话没有对话消息。',
        emptyTrajectory: '这个会话没有轨迹事件。',
        conversationHint: '对话只显示用户与助手消息，思考过程可折叠。',
        trajectoryHint: '轨迹按事件顺序显示：消息、思考过程、工具调用与结果。',
        processNote: '过程',
        seeTrajectory: '可在轨迹中查看',
        toolResultsCount: '{n} 个工具结果',
        errorsCount: '{n} 个错误',
        resizeTree: '调整会话树宽度',
        selectSessionHint: '选择左侧会话，然后在右侧切换「对话」或「轨迹」。',
        sessionBytesLabel: '数据量',
        forceRefresh: '强制刷新',
        forceRefreshHint: '强制刷新绕过缓存，重新从对端拉取会话数据。',
        fromCache: '缓存',
        fromRemote: '远端',
        peerVersionLabel: '插件版本',
        transferLabel: '传输',
        transferValue: '已收 {received} · 已发 {sent} · {calls} 次调用',
        transferTitle: '传输方式',
        transferJsonl: 'JSONL',
        transferJlc: 'JLC',
        transferCruising: '本地到远端 巡航加速中',
        transferRestart: '本地到远端 重启即出发',
        transferJsonlHint: '当前为 JSONL 传输方式。夜间巡航版可在本地到远端启用 JLC 巡航加速。',
        transferRestartHint: '设置已保存，重启 DSH 后生效。',
        transferEnable: '启用 JLC 巡航加速',
        transferDisable: '改用 JSONL',
        transferUnavailable: 'JLC 加速组件不可用',
        transferDisabled: 'JLC 巡航加速已关闭，当前为 JSONL 传输方式。',
        transferLinksUnavailable: '精选配置暂不可用',
        transferEditionDsh: '原生 DSH',
        transferEditionNight: '夜间巡航版',
        fetchFull: 'JLC 拉取完整会话',
        fetching: '拉取中',
        fetchProgress: '拉取中 {received}/{total} 块 · {percent}%',
        fetchFailed: '拉取失败',
        fetchDialogReady: '对话已到，继续拉取其余数据…',
        fetchComplete: '完整会话已到',
        vaultTitle: '保险柜',
        vaultHint: '远端会话在本机的加密临时缓存；关闭 DSH 后自动清除，面板不提供查看。',
        vaultEmpty: '保险柜为空',
        vaultUsage: '已加密 {bytes} · {entries} 项',
        vaultClear: '清空保险柜',
        vaultCleared: '保险柜已清空',
      },
      en: {
        title: 'Account mesh',
        description: 'Multiple DSH instances on the same account read each other\'s sessions and workspace over an encrypted data channel on the LAN, Tailscale included. Read-only.',
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
        revoked: 'Revoked',
        revokedHint: 'You revoked this device. The account rule will not restore trust; only the Trust button grants it again.',
        pendingTrust: 'Awaiting confirmation',
        trustRequestTitle: 'A device asks to read your sessions',
        trustRequestBody: '{name} is signed in to the same account and wants to read this DSH instance\'s sessions and workspaces (read-only). It stays disconnected until you answer.',
        trustRequestDevice: 'Device ID',
        trustRequestFingerprint: 'Device fingerprint',
        trustRequestAddress: 'Address',
        trustRequestTrust: 'Trust this device',
        trustRequestRefuse: 'Refuse and revoke',
        trustRequestHint: 'Refusing is durable: the account rule never restores trust, and the settings page is the only way back.',
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
        signedOut: 'Signed out',
        starting: 'Starting',
        ready: 'Running',
        disabled: 'Disabled',
        tailnetOn: 'available',
        tailnetOff: 'not detected',
        channels: 'Discovery channels',
        lanChannel: 'LAN',
        tailnetChannel: 'Tailscale',
        testLan: 'Test LAN',
        testTailnet: 'Test Tailscale',
        refreshNetwork: 'Refresh network',
        localTestPeer: 'Local test peer',
        localTestHint: 'When enabled, the remote workspace renders this host\'s real sessions while no real peer is connected; it hides automatically once a real peer authenticates.',
        localTestHidden: 'Hidden: a real peer is connected',
        localTestEnabled: 'On',
        localTestDisabled: 'Off',
        probeTarget: 'Target address',
        probeTargetHint: 'Leave empty to test known peers; or IP:port',
        probeReplied: 'Replied',
        probeNoReply: 'No reply',
        probeRunning: 'Testing…',
        lanMulticast: 'multicast',
        lanBroadcast: 'broadcast',
        lanLocal: 'Local addresses',
        tailnetPeersKnown: 'tailnet devices',
        channelPeers: '{n} peers',
        channelAnnounces: '{n} sent',
        channelReplies: '{n} received',
        untitled: '(untitled)',
        live: 'live',
        justNow: 'just now',
        minutesAgo: '{n} min',
        hoursAgo: '{n} h',
        daysAgo: '{n} d',
        peerDetails: 'Device details',
        peerIdLabel: 'Device ID',
        peerAddressLabel: 'Address',
        peerSourceLabel: 'Source',
        peerRttLabel: 'Latency',
        peerPairCodeLabel: 'Pair code',
        peerTrustedAtLabel: 'Trusted at',
        peerLastSeenLabel: 'Last seen',
        peerFingerprintLabel: 'Fingerprint',
        peerOnlineLabel: 'State',
        peerOnlineValue: 'online',
        peerOfflineValue: 'offline',
        peerVerifiedValue: 'authenticated',
        peerUnverifiedValue: 'not authenticated',
        peerSourceLan: 'LAN',
        peerSourceTailnet: 'Tailscale',
        peerSourceLocal: 'local test',
        peerSourceTrusted: 'trust table',
        peerSessionsLabel: 'Sessions',
        peerWorkspacesLabel: 'Workspaces',
        sessionCreatedLabel: 'Created',
        sessionCwdLabel: 'Working directory',
        sessionLiveLabel: 'State',
        sessionLiveValue: 'live',
        sessionIdLabelShort: 'Session ID',
        empty: 'empty',
        loadMore: 'Load more',
        sessionsCount: '{n} sessions',
        devicesCount: '{n} device(s)',
        workspaceUnknown: 'Unknown workspace',
        readOnlyTag: 'read-only',
        noWorkspaces: 'This peer has no workspace.',
        noVisibleWorkspaces: 'This peer has no sessions to show.',
        sessionsPane: 'Sessions',
        conversationTab: 'Conversation',
        trajectoryTab: 'Trajectory',
        sessionIdLabel: 'Session ID',
        copySessionId: 'Copy session ID',
        copied: 'Copied',
        copyFailed: 'Copy failed',
        messageEvent: 'Message',
        toolCallEvent: 'Tool call',
        toolResultEvent: 'Tool result',
        toolResultError: 'Tool result · error',
        thinking: 'Thinking',
        expandThinking: 'Show thinking',
        collapseThinking: 'Hide thinking',
        userRole: 'User',
        assistantRole: 'Assistant',
        toolArguments: 'Arguments',
        errorName: 'Error',
        emptyConversation: 'This session has no conversation messages.',
        emptyTrajectory: 'This session has no trajectory events.',
        conversationHint: 'Conversation shows user and assistant messages; thinking is collapsible.',
        trajectoryHint: 'Trajectory events in seq order: messages, thinking, tool calls, and results.',
        processNote: 'Process',
        seeTrajectory: 'See Trajectory',
        toolResultsCount: '{n} tool results',
        errorsCount: '{n} errors',
        resizeTree: 'Resize session tree',
        selectSessionHint: 'Select a session on the left, then switch between Conversation and Trajectory.',
        sessionBytesLabel: 'Data',
        forceRefresh: 'Force refresh',
        forceRefreshHint: 'Force refresh bypasses the cache and pulls the session data again.',
        fromCache: 'cached',
        fromRemote: 'remote',
        peerVersionLabel: 'Plugin version',
        transferLabel: 'Transfer',
        transferValue: 'received {received} · sent {sent} · {calls} calls',
        transferTitle: 'Transfer',
        transferJsonl: 'JSONL',
        transferJlc: 'JLC',
        transferCruising: 'Local → remote: cruising',
        transferRestart: 'Local → remote: restart to take off',
        transferJsonlHint: 'JSONL transfer is in use. Night Cruising can enable JLC cruising acceleration for local → remote.',
        transferRestartHint: 'Saved. Restart DSH to apply.',
        transferEnable: 'Enable JLC cruising',
        transferDisable: 'Switch to JSONL',
        transferUnavailable: 'JLC acceleration component unavailable',
        transferDisabled: 'JLC cruising is off; JSONL transfer is in use.',
        transferLinksUnavailable: 'Featured configuration unavailable',
        transferEditionDsh: 'Standard DSH',
        transferEditionNight: 'Night Cruising',
        fetchFull: 'Fetch full session with JLC',
        fetching: 'Fetching',
        fetchProgress: 'Fetching {received}/{total} blocks · {percent}%',
        fetchFailed: 'Fetch failed',
        fetchDialogReady: 'Dialog is ready; fetching the rest…',
        fetchComplete: 'Full session received',
        vaultTitle: 'Vault',
        vaultHint: 'Encrypted temporary cache of remote sessions on this machine. Cleared when DSH exits; no viewer is provided.',
        vaultEmpty: 'Vault is empty',
        vaultUsage: '{bytes} encrypted · {entries} entries',
        vaultClear: 'Clear vault',
        vaultCleared: 'Vault cleared',
      },
    }

    const monoStyle = {
      fontFamily: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)',
      fontSize: 'var(--dsh-code-font-size, 11px)',
      color: 'var(--dsw-alias-label-secondary)',
      wordBreak: 'break-all',
    }
    /**
     * Marquee scroll velocity in px per second, tuned to a comfortable reading
     * speed. Duration = overflow / velocity, so length changes time, not speed.
     */
    const MARQUEE_PX_PER_SECOND = 60
    const contentFont = 'var(--dsh-content-font-size, 14px)'
    const secondaryFont = 'var(--dsh-content-font-size-secondary, 13px)'
    const contentLine = 'calc(22px + var(--dsh-content-font-delta, 0px))'
    const contentLineTall = 'calc(24px + var(--dsh-content-font-delta, 0px))'
    const secondaryLine = 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))'
    const styles = {
      page: { padding: '4px 2px 24px', maxWidth: '760px', color: 'var(--dsw-alias-label-primary)', fontSize: '13px', lineHeight: 1.55 },
      title: { fontSize: '16px', fontWeight: 600, margin: '0 0 4px' },
      titleVersion: { marginLeft: '10px', fontSize: '11px', fontWeight: 400, verticalAlign: '2px', fontFamily: monoStyle.fontFamily, color: 'var(--dsw-alias-label-secondary)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '999px', padding: '1px 8px', background: 'var(--dsw-alias-bg-layer-2)' },
      desc: { color: 'var(--dsw-alias-label-secondary)', margin: '0 0 16px', fontSize: '12px' },
      // Blocking first-contact dialog: a full-viewport portal layer above every
      // panel. The mask intercepts clicks and the card holds the only two
      // answers, so the rest of the app cannot be used until the user decides.
      dialogRoot: { position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px', pointerEvents: 'auto' },
      dialogMask: { position: 'absolute', inset: 0, background: 'var(--dsw-alias-bg-mask-1)', backdropFilter: 'var(--dsw-mask-blur)' },
      dialogCard: { position: 'relative', zIndex: 1, width: 'min(440px, 100%)', maxHeight: '100%', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '12px', padding: '20px 22px', borderRadius: 'var(--dsw-radius-panel, 12px)', background: 'var(--dsw-alias-bg-layer-2)', boxShadow: 'var(--dsw-elevation-prominent)', border: '1px solid var(--dsw-alias-border-l2)' },
      dialogTitle: { margin: 0, fontSize: '16px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      dialogBody: { margin: 0, fontSize: '13px', lineHeight: 1.6, color: 'var(--dsw-alias-label-primary)' },
      dialogDetails: { display: 'flex', flexDirection: 'column', gap: '2px' },
      dialogFooter: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '4px' },
      card: { border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', borderRadius: '10px', padding: '12px 14px', marginBottom: '12px' },
      row: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      label: { color: 'var(--dsw-alias-label-secondary)', minWidth: '92px', fontSize: '12px' },
      value: { fontFamily: monoStyle.fontFamily, fontSize: '12px', wordBreak: 'break-all' },
      chip: (tone) => ({
        display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '1px 8px', borderRadius: '999px', fontSize: '11px',
        border: '1px solid var(--dsw-alias-border-l2)',
        color: tone === 'on' ? 'var(--dsw-alias-state-success-primary)' : tone === 'warn' ? 'var(--dsw-alias-state-warning-primary, var(--dsw-alias-label-secondary))' : 'var(--dsw-alias-label-secondary)',
        background: 'var(--dsw-alias-bg-layer-2)',
      }),
      peer: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '10px', padding: '10px 12px', marginBottom: '8px', background: 'var(--dsw-alias-bg-layer-2)' },
      peerHead: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap', marginBottom: '8px' },
      peerName: { fontWeight: 600, fontSize: '13px' },
      mono: monoStyle,
      button: { font: 'inherit', fontSize: '12px', cursor: 'pointer', color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '7px', padding: '3px 10px' },
      buttonPrimary: { font: 'inherit', fontSize: '12px', cursor: 'pointer', color: 'var(--dsw-alias-label-primary-foreground, #fff)', background: 'var(--dsw-alias-brand-primary)', border: '1px solid transparent', borderRadius: '7px', padding: '3px 10px' },
      hint: { color: 'var(--dsw-alias-label-secondary)', fontSize: '11.5px', margin: '10px 0 0' },
      error: { color: 'var(--dsw-alias-state-error-primary, #d64545)', fontSize: '12px', margin: '8px 0 0' },
      panel: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, color: 'var(--dsw-alias-label-primary)', fontSize: contentFont, lineHeight: contentLineTall },
      // Padding lives in PANEL_CSS so the darwin clearance rules can override it
      // without fighting an inline shorthand.
      panelHead: { display: 'flex', alignItems: 'center', gap: '10px', borderBottom: '1px solid var(--dsw-alias-border-l2)', flexWrap: 'wrap' },
      panelBody: { display: 'flex', flex: 1, minHeight: 0 },
      treePane: (width) => ({ width: `${width}px`, flex: 'none', overflow: 'auto', padding: '8px 8px 24px', minWidth: 0 }),
      transcriptPane: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 },
      splitter: { width: '8px', flex: 'none', cursor: 'col-resize', touchAction: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent' },
      splitterLine: { width: '1px', height: '100%', background: 'var(--dsw-alias-border-l2)', transition: 'background 120ms ease, width 120ms ease' },
      treeRow: (depth) => ({
        display: 'flex', alignItems: 'center', gap: '8px', padding: '5px 8px', paddingLeft: `${8 + depth * 16}px`,
        borderRadius: 'var(--dsw-radius-sm, 6px)', fontSize: contentFont, minWidth: 0, position: 'relative',
      }),
      treeButton: { display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: 0, padding: 0, background: 'transparent', border: 'none', color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer' },
      treeIcon: { display: 'inline-flex', alignItems: 'center', flex: 'none' },
      treeName: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' },
      treeMeta: { color: 'var(--dsw-alias-label-secondary)', fontSize: secondaryFont, flex: 'none' },
      // Row meta hugs the right edge; the copy affordance floats over it on
      // hover/focus instead of reserving a permanent slot beside the title.
      treeMetaRight: { color: 'var(--dsw-alias-label-secondary)', fontSize: secondaryFont, flex: 'none', marginLeft: 'auto' },
      treeActions: { position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', display: 'flex', alignItems: 'center' },
      msg: { padding: '10px 16px', borderBottom: '1px solid var(--dsw-alias-border-l2)' },
      msgRole: { fontSize: secondaryFont, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--dsw-alias-label-secondary)', marginBottom: '4px' },
      msgText: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: contentFont, lineHeight: contentLineTall },
      userRow: { display: 'flex', justifyContent: 'flex-end', padding: '10px 16px' },
      userBubble: { maxWidth: '82%', background: 'var(--dsw-specific-bubble, var(--dsw-alias-bg-layer-2))', borderRadius: 'var(--dsw-radius-xl, 14px)', padding: '10px 16px', fontSize: contentFont, lineHeight: contentLine, color: 'var(--dsw-alias-label-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      assistantRow: { padding: '10px 16px', borderBottom: '1px solid var(--dsw-alias-border-l2)' },
      processNote: { color: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))', fontSize: secondaryFont, marginTop: '8px' },
      mdParagraph: { margin: '0 0 10px', fontSize: contentFont, lineHeight: contentLineTall },
      mdHeading: { margin: '14px 0 8px', fontSize: `calc(${contentFont} + 2px)`, fontWeight: 600, lineHeight: 'calc(28px + var(--dsh-content-font-delta, 0px))' },
      mdList: { margin: '0 0 10px', paddingLeft: '24px', fontSize: contentFont, lineHeight: contentLineTall },
      mdQuote: { margin: '0 0 10px', paddingLeft: '12px', borderLeft: '2px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-secondary)', fontSize: contentFont, lineHeight: contentLineTall },
      mdRule: { border: 'none', borderTop: '1px solid var(--dsw-alias-border-l2)', margin: '12px 0' },
      codeBlock: { margin: '0 0 10px', padding: '10px 12px', background: 'var(--dsw-alias-bg-layer-2)', borderRadius: 'var(--dsw-radius-md, 6px)', overflow: 'auto', fontSize: 'var(--dsh-code-font-size, 11px)', lineHeight: 'calc(18px + var(--dsh-code-font-delta, 0px))' },
      inlineCode: { fontFamily: monoStyle.fontFamily, fontSize: 'calc(var(--dsh-code-font-size, 11px) + 1px)', background: 'var(--dsw-alias-bg-layer-2)', padding: '0 4px', borderRadius: '4px' },
      link: { color: 'var(--dsw-alias-brand-primary)' },
      toolbar: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', padding: '10px 16px', borderBottom: '1px solid var(--dsw-alias-border-l2)' },
      toolbarTitle: { fontWeight: 600, fontSize: contentFont, minWidth: 0, maxWidth: '340px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      toolbarId: { ...monoStyle, fontSize: secondaryFont, userSelect: 'text', maxWidth: '280px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      empty: { color: 'var(--dsw-alias-label-secondary)', padding: '32px 16px', fontSize: contentFont, lineHeight: contentLineTall },
      paneHead: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', padding: '8px 10px', borderBottom: '1px solid var(--dsw-alias-border-l2)', position: 'sticky', top: 0, background: 'var(--dsw-alias-bg-layer-1)', zIndex: 1 },
      paneTitle: { fontSize: contentFont, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      paneSub: { color: 'var(--dsw-alias-label-secondary)', fontSize: secondaryFont, flex: 'none', minWidth: 0, padding: '4px 10px 8px', lineHeight: secondaryLine },
      tabBar: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', padding: '8px 10px', borderBottom: '1px solid var(--dsw-alias-border-l2)', position: 'sticky', top: 0, background: 'var(--dsw-alias-bg-layer-1)', zIndex: 1 },
      tab: (active) => ({
        font: 'inherit', fontSize: secondaryFont, cursor: 'pointer', padding: '4px 14px', borderRadius: 'var(--dsw-radius-sm, 6px)',
        border: '1px solid var(--dsw-alias-border-l2)',
        color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
        fontWeight: active ? 600 : 400,
        lineHeight: secondaryLine,
      }),
      reasoning: { marginTop: '8px' },
      reasoningToggle: { font: 'inherit', fontSize: secondaryFont, cursor: 'pointer', color: 'var(--dsw-alias-label-secondary)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-sm, 6px)', padding: '2px 10px', lineHeight: secondaryLine },
      reasoningText: { marginTop: '6px', padding: '8px 12px', borderLeft: '2px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: secondaryFont, lineHeight: secondaryLine },
      errorMeta: { color: 'var(--dsw-alias-state-error-primary, #d64545)', fontSize: secondaryFont, marginTop: '4px' },
      copyButton: { font: 'inherit', fontSize: secondaryFont, cursor: 'pointer', color: 'var(--dsw-alias-label-secondary)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-sm, 6px)', padding: '3px 10px', lineHeight: secondaryLine, minWidth: '48px' },
      copyIconButton: { padding: '0 6px', fontSize: contentFont, minWidth: '26px' },
      copyFailed: { color: 'var(--dsw-alias-state-error-primary, #d64545)', borderColor: 'var(--dsw-alias-state-error-primary, #d64545)' },
      input: { font: 'inherit', fontSize: '12px', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '7px', padding: '3px 10px', minWidth: '220px' },
    }

    /** Human byte size: B / KB / MB / GB with one decimal above bytes. */
    function formatBytes(bytes) {
      const value = Number(bytes)
      if (!Number.isFinite(value) || value <= 0) return '0 B'
      const units = ['B', 'KB', 'MB', 'GB', 'TB']
      let index = 0
      let scaled = value
      while (scaled >= 1024 && index < units.length - 1) {
        scaled /= 1024
        index += 1
      }
      return `${index === 0 ? Math.round(scaled) : scaled.toFixed(1)} ${units[index]}`
    }

    /** Fetch one panel route; `force` bypasses the Host transfer cache. */
    async function getJson(path, params = {}, force = false) {
      const query = new URLSearchParams()
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) query.set(key, String(value))
      }
      if (force) query.set('force', '1')
      const suffix = query.toString()
      const response = await fetch(`/account-mesh/api/${path}${suffix ? `?${suffix}` : ''}`, { headers: { accept: 'application/json' } })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
      return body
    }

    /** Hover/focus affordances the inline style objects cannot express. */
    const PANEL_CSS = `
      .am-panel-head { padding: 12px 16px; }
      /* macOS desktop: the main panel can reach the top-left corner while the
         sidebar is collapsed, so the head yields the traffic-light band. The
         clearance replaces the ordinary inset instead of stacking on it, and
         the rule stays inert on every other platform. */
      html[data-platform="darwin"] .am-panel-head {
        padding-top: var(--dsh-frame-top-clearance, 0px);
        padding-inline-start: var(--dsh-frame-leading-clearance, 0px);
      }
      .am-button { background: var(--dsw-alias-bg-layer-1); }
      .am-copy { background: var(--dsw-alias-bg-layer-1); }
      .am-tab { background: var(--dsw-alias-bg-layer-1); }
      .am-tab-active, .am-tree-row-active { background: var(--dsw-alias-interactive-bg-hover); }
      .am-tree-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .am-tree-row:has(.am-tree-button:focus-visible) { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
      .am-tree-button:focus-visible { outline: none; }
      .am-button:hover, .am-tab:hover, .am-copy:hover, .am-reasoning-toggle:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .am-button-primary:hover { filter: brightness(1.08); }
      .am-button:focus-visible, .am-tab:focus-visible, .am-copy:focus-visible, .am-reasoning-toggle:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
      .am-splitter:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .am-splitter:hover .am-splitter-line, .am-splitter[data-dragging] .am-splitter-line { background: var(--dsw-alias-brand-primary); width: 2px; }
      .am-splitter:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
      /* The copy button floats over the row's right edge instead of occupying
         flow space, so the title keeps the full width the rest of the time.
         Tab focus still reaches it: focus-within reveals it, and the meta only
         steps aside while the row is hovered or focused. */
      .am-tree-actions { opacity: 0; pointer-events: none; transition: opacity 120ms ease; }
      .am-tree-row:hover .am-tree-actions, .am-tree-row:focus-within .am-tree-actions { opacity: 1; pointer-events: auto; }
      .am-tree-row:hover .am-tree-meta, .am-tree-row:focus-within .am-tree-meta { padding-right: 30px; }
      /* Only a label wider than its box scrolls: the inner text keeps its full
         width (no ellipsis) and slides left until its end is visible. The
         overflow flag is measured on hover, so short labels never animate.
         The travel distance is written inline per row (--am-marquee-travel, px)
         and the duration is travel / MARQUEE_PX_PER_SECOND, so every label moves
         at the same velocity no matter how long it is. */
      .am-tree-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .am-tree-name > .am-tree-text { display: inline-block; white-space: nowrap; }
      .am-tree-row:hover .am-tree-name[data-overflow] { text-overflow: clip; }
      .am-tree-row:hover .am-tree-name[data-overflow] > .am-tree-text {
        animation: am-marquee-text var(--am-marquee-duration, 6s) linear infinite alternate;
      }
      @keyframes am-marquee-text {
        from { transform: translateX(0); }
        to { transform: translateX(calc(-1 * var(--am-marquee-travel, 0px))); }
      }
      @media (prefers-reduced-motion: reduce) {
        .am-tree-row:hover .am-tree-name[data-overflow],
        .am-tree-row:hover .am-tree-name[data-overflow] > .am-tree-text { animation: none; }
      }
    `

    function useMeshState() {
      const [state, setState] = React.useState({ data: null, error: null })
      // The polling load is also exposed as `refresh`, so a mutation can pull
      // the new state immediately instead of waiting for the next tick.
      const refreshRef = React.useRef(null)
      React.useEffect(() => {
        let alive = true
        let timer
        const fetchState = async () => {
          try {
            const response = await fetch('/account-mesh/api/state', { headers: { accept: 'application/json' } })
            const body = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
            if (alive) setState({ data: body, error: null })
          } catch (error) {
            if (alive) setState(current => ({ data: current.data, error: error.message }))
          }
        }
        const load = async () => {
          await fetchState()
          if (alive) timer = setTimeout(load, 2500)
        }
        refreshRef.current = fetchState
        load()
        return () => {
          alive = false
          clearTimeout(timer)
        }
      }, [])
      return { data: state.data, error: state.error, refresh: () => refreshRef.current?.() }
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

    /** Compact age like DSH: just now / N min / N h / N d. Full date stays in the hover tooltip. */
    function formatRelative(ms, t) {
      if (!ms) return ''
      const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000))
      if (seconds < 60) return t('justNow')
      const minutes = Math.floor(seconds / 60)
      if (minutes < 60) return fill(t('minutesAgo'), { n: minutes })
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return fill(t('hoursAgo'), { n: hours })
      return fill(t('daysAgo'), { n: Math.floor(hours / 24) })
    }

    /** Last path segment for display; the full path stays in the hover tooltip. */
    function lastSegment(pathText) {
      const text = String(pathText ?? '').replace(/[\\/]+$/, '')
      const parts = text.split(/[\\/]/)
      return parts[parts.length - 1] || text
    }

    /** Multi-line hover tooltip: one label/value pair per line. */
    function detailText(pairs) {
      return pairs.filter(([, value]) => value !== undefined && value !== null && value !== '').map(([label, value]) => `${label}: ${value}`).join('\n')
    }

    /** Peer hover details, mirroring the settings page peer card. */
    function peerDetail(peer, t) {
      const source = peer.source === 'tailnet' ? t('peerSourceTailnet') : peer.source === 'local' ? t('peerSourceLocal') : peer.source === 'trusted' ? t('peerSourceTrusted') : t('peerSourceLan')
      return detailText([
        [t('peerDetails'), peer.name || peer.shortId],
        [t('peerIdLabel'), peer.deviceId],
        [t('peerOnlineLabel'), peer.online ? `${t('peerOnlineValue')}${peer.verified ? ` · ${t('peerVerifiedValue')}` : ''}` : t('peerOfflineValue')],
        [t('peerSourceLabel'), source],
        [t('peerAddressLabel'), peer.address],
        [t('peerRttLabel'), peer.rttMs != null ? `${peer.rttMs} ms` : null],
        [t('peerFingerprintLabel'), peer.fingerprint],
        [t('peerPairCodeLabel'), peer.pairCode],
        [t('peerVersionLabel'), peer.version ?? null],
        [t('peerTrustedAtLabel'), peer.trustedAt ? formatTime(peer.trustedAt) : null],
        [t('peerLastSeenLabel'), peer.lastSeenAt ? formatTime(peer.lastSeenAt) : null],
        [t('peerWorkspacesLabel'), (peer.workspaces ?? []).length],
        [t('peerSessionsLabel'), (peer.workspaces ?? []).reduce((sum, workspace) => sum + (workspace.sessions?.length ?? 0), 0)],
        [t('transferLabel'), peer.transfer
          ? fill(t('transferValue'), { received: formatBytes(peer.transfer.receivedBytes), sent: formatBytes(peer.transfer.sentBytes), calls: peer.transfer.calls })
          : null],
      ])
    }

    /** Workspace hover details: full path, session count, summed known data volume. */
    function workspaceDetail(workspace, t) {
      const sessions = workspace.sessions ?? []
      const known = sessions.filter(session => session.totalBytes != null)
      return detailText([
        [t('sessionCwdLabel'), workspace.path ?? workspace.title],
        [t('peerSessionsLabel'), sessions.length],
        [t('sessionBytesLabel'), known.length > 0 ? formatBytes(known.reduce((sum, session) => sum + session.totalBytes, 0)) : null],
      ])
    }

    /** Session hover details: full title, id, cwd, created time, live state and data volume. */
    function sessionDetail(session, t, totals) {
      const total = totals?.totalBytes ?? session.totalBytes
      return detailText([
        [t('untitled'), session.title || t('untitled')],
        [t('sessionIdLabelShort'), session.id],
        [t('sessionCwdLabel'), session.cwd],
        [t('sessionCreatedLabel'), session.createdAt ? formatTime(session.createdAt) : null],
        [t('sessionLiveLabel'), session.live ? t('sessionLiveValue') : null],
        [t('sessionBytesLabel'), total != null ? formatBytes(total) : null],
      ])
    }

    function fill(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) => (values[key] === undefined ? match : String(values[key])))
    }

    /** Known byte total for a session: runtime totals win over the tree payload. */
    function sessionBytes(session, totals) {
      const known = totals?.get?.(session.id)?.totalBytes ?? session.totalBytes
      if (known === null || known === undefined) return null
      return Number(known) || 0
    }

    /**
     * Empty, title-less, zero-byte sessions are pure noise: hide them. A session
     * with content (a known byte total above zero) stays visible even when the
     * peer has not produced a title yet.
     */
    function isVisibleSession(session, totals, t) {
      const title = String(session.title ?? '').trim()
      if (title !== '' && title !== t('untitled')) return true
      const bytes = sessionBytes(session, totals)
      return bytes !== null && bytes > 0
    }

    /** Pinned (when the peer reports it) first, then live, then newest. */
    function compareSessions(left, right) {
      const pinned = (right.pinned === true ? 1 : 0) - (left.pinned === true ? 1 : 0)
      if (pinned !== 0) return pinned
      const live = (right.live === true ? 1 : 0) - (left.live === true ? 1 : 0)
      if (live !== 0) return live
      return (Number(right.createdAt) || 0) - (Number(left.createdAt) || 0)
    }

    /** Newest session timestamp in a peer's tree; peers without sessions fall back to last seen. */
    function latestSessionAt(peer) {
      let latest = 0
      for (const workspace of peer.workspaces ?? []) {
        for (const session of workspace.sessions ?? []) {
          const at = Number(session.createdAt) || 0
          if (at > latest) latest = at
        }
      }
      return latest || Number(peer.lastSeenAt) || 0
    }

    /** Online peers first by newest session, then offline peers by last seen. */
    function comparePeers(left, right) {
      const onlineLeft = left.online === true && !left.error
      const onlineRight = right.online === true && !right.error
      if (onlineLeft !== onlineRight) return onlineLeft ? -1 : 1
      if (onlineLeft) {
        const newest = latestSessionAt(right) - latestSessionAt(left)
        if (newest !== 0) return newest
        return String(left.name ?? left.shortId ?? '').localeCompare(String(right.name ?? right.shortId ?? ''))
      }
      return (Number(right.lastSeenAt) || 0) - (Number(left.lastSeenAt) || 0)
    }

    /** Compact display form for an opaque session id; the copy action keeps the full value. */
    function shortSessionId(id) {
      const text = String(id ?? '')
      return text.length > 18 ? `${text.slice(0, 10)}…${text.slice(-6)}` : text
    }

    /** Inline markdown: bold, italic, inline code and links. */
    function inlineNodes(text) {
      const nodes = []
      const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g
      let last = 0
      let match
      while ((match = pattern.exec(text))) {
        if (match.index > last) nodes.push(text.slice(last, match.index))
        const token = match[0]
        if (token.startsWith('**')) nodes.push(h('strong', { key: `b-${match.index}` }, token.slice(2, -2)))
        else if (token.startsWith('*')) nodes.push(h('em', { key: `i-${match.index}` }, token.slice(1, -1)))
        else if (token.startsWith('`')) nodes.push(h('code', { key: `c-${match.index}`, style: styles.inlineCode }, token.slice(1, -1)))
        else {
          const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
          if (link) nodes.push(h('a', { key: `a-${match.index}`, href: link[2], target: '_blank', rel: 'noreferrer', style: styles.link }, link[1]))
          else nodes.push(token)
        }
        last = match.index + token.length
      }
      if (last < text.length) nodes.push(text.slice(last))
      return nodes
    }

    function isBlockStart(line) {
      return /^\s*```/.test(line) || /^#{1,6}\s+/.test(line) || /^\s*[-*]\s+/.test(line) ||
        /^\s*\d+\.\s+/.test(line) || /^\s*>\s?/.test(line) || /^\s*---+\s*$/.test(line)
    }

    /** Minimal markdown renderer for assistant text: headings, lists, code, quotes, links. */
    function renderMarkdown(text) {
      const lines = String(text ?? '').split('\n')
      const blocks = []
      let index = 0
      while (index < lines.length) {
        const line = lines[index]
        if (!line.trim()) {
          index += 1
          continue
        }
        if (line.trim().startsWith('```')) {
          const code = []
          index += 1
          while (index < lines.length && !lines[index].trim().startsWith('```')) {
            code.push(lines[index])
            index += 1
          }
          index += 1
          blocks.push(h('pre', { key: `code-${blocks.length}`, style: styles.codeBlock }, h('code', null, code.join('\n'))))
          continue
        }
        const heading = line.match(/^(#{1,6})\s+(.*)$/)
        if (heading) {
          const level = Math.min(6, heading[1].length)
          blocks.push(h(`h${level}`, { key: `h-${blocks.length}`, style: styles.mdHeading }, inlineNodes(heading[2])))
          index += 1
          continue
        }
        if (/^\s*[-*]\s+/.test(line)) {
          const items = []
          while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
            items.push(h('li', { key: `li-${items.length}` }, inlineNodes(lines[index].replace(/^\s*[-*]\s+/, ''))))
            index += 1
          }
          blocks.push(h('ul', { key: `ul-${blocks.length}`, style: styles.mdList }, items))
          continue
        }
        if (/^\s*\d+\.\s+/.test(line)) {
          const items = []
          while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
            items.push(h('li', { key: `li-${items.length}` }, inlineNodes(lines[index].replace(/^\s*\d+\.\s+/, ''))))
            index += 1
          }
          blocks.push(h('ol', { key: `ol-${blocks.length}`, style: styles.mdList }, items))
          continue
        }
        if (/^\s*>\s?/.test(line)) {
          const quote = []
          while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
            quote.push(lines[index].replace(/^\s*>\s?/, ''))
            index += 1
          }
          blocks.push(h('blockquote', { key: `quote-${blocks.length}`, style: styles.mdQuote }, inlineNodes(quote.join('\n'))))
          continue
        }
        if (/^\s*---+\s*$/.test(line)) {
          blocks.push(h('hr', { key: `hr-${blocks.length}`, style: styles.mdRule }))
          index += 1
          continue
        }
        const paragraph = []
        while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) {
          paragraph.push(lines[index])
          index += 1
        }
        blocks.push(h('p', { key: `p-${blocks.length}`, style: styles.mdParagraph }, inlineNodes(paragraph.join('\n'))))
      }
      return blocks
    }

    /** Clipboard write with a legacy fallback for browsers without the async API. */
    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        let area
        try {
          area = document.createElement('textarea')
          area.value = text
          area.style.position = 'fixed'
          area.style.opacity = '0'
          document.body.appendChild(area)
          area.select()
          return document.execCommand('copy')
        } catch {
          return false
        } finally {
          try {
            if (area) document.body.removeChild(area)
          } catch {
            // the textarea may never have been attached
          }
        }
      }
    }

    /** Small copy affordance; shows a short confirmation or failure after a click. */
    function CopyButton({ text, label, t, compact = false }) {
      const [status, setStatus] = React.useState('idle')
      React.useEffect(() => {
        if (status === 'idle') return
        const timer = setTimeout(() => setStatus('idle'), 1500)
        return () => clearTimeout(timer)
      }, [status])
      const shown = status === 'copied' ? t('copied') : status === 'failed' ? t('copyFailed') : (compact ? '⧉' : label)
      return h('button', {
        style: {
          ...styles.copyButton,
          ...(compact ? styles.copyIconButton : null),
          ...(status === 'failed' ? styles.copyFailed : null),
        },
        className: 'am-copy',
        title: `${label}: ${text}`,
        'aria-label': `${label}: ${text}`,
        'aria-live': 'polite',
        onClick: async event => {
          event.stopPropagation()
          setStatus(await copyText(text) ? 'copied' : 'failed')
        },
      }, shown)
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
          peer.trusted
            ? h(Chip, { tone: 'on' }, t('trusted'))
            : peer.revoked
              ? h(Chip, { tone: 'warn' }, t('revoked'))
              : peer.pendingTrust
                ? h(Chip, { tone: 'warn' }, t('pendingTrust'))
                : h(Chip, { tone: 'warn' }, t('untrusted')),
          peer.source === 'tailnet' ? h(Chip, { tone: 'off' }, 'Tailscale') : null,
          peer.rttMs !== null && peer.rttMs !== undefined ? h(Chip, { tone: 'off' }, `${peer.rttMs} ms`) : null,
          peer.version ? h(Chip, { tone: 'off' }, `v${peer.version}`) : null),
        h('div', { style: styles.mono }, peer.deviceId),
        peer.fingerprint ? h('div', { style: styles.mono }, `${t('fingerprint')}: ${peer.fingerprint}`) : null,
        peer.online && peer.address ? h('div', { style: styles.mono }, peer.address) : null,
        peer.revoked ? h('p', { style: styles.hint }, t('revokedHint')) : null,
        peer.transfer
          ? h('div', { style: styles.mono }, fill(t('transferValue'), { received: formatBytes(peer.transfer.receivedBytes), sent: formatBytes(peer.transfer.sentBytes), calls: peer.transfer.calls }))
          : null,
        h('div', { style: { ...styles.row, marginTop: '8px' } },
          !peer.trusted
            ? h('button', { style: styles.buttonPrimary, className: 'am-button am-button-primary', disabled: pending, onClick: () => onAction('pair', peer.deviceId) }, t('trust'))
            : null,
          peer.trusted
            ? h('button', { style: styles.button, className: 'am-button', disabled: pending, onClick: () => onAction('reconnect', peer.deviceId) }, t('reconnect'))
            : null,
          peer.trusted
            ? h('button', {
                style: confirming ? styles.buttonPrimary : styles.button,
                className: confirming ? 'am-button am-button-primary' : 'am-button',
                disabled: pending,
                onClick: () => {
                  if (!confirming) return setConfirming(true)
                  setConfirming(false)
                  onAction('forget', peer.deviceId)
                },
              }, confirming ? t('confirmForget') : t('forget'))
            : null))
    }

    /**
     * Normalize one site-provided transfer link. Only an https URL with a
     * non-empty label is rendered; the label/url/hint always come from the
     * Host state, never from constants in this file.
     */
    function transferLink(entry) {
      if (!entry || typeof entry !== 'object') return null
      const label = typeof entry.label === 'string' ? entry.label.trim() : ''
      const url = typeof entry.url === 'string' ? entry.url.trim() : ''
      if (!label || !/^https:\/\//i.test(url)) return null
      const hint = typeof entry.hint === 'string' && entry.hint.trim() ? entry.hint.trim() : ''
      return { label, url, hint }
    }

    /**
     * "Transfer" card: the edition-specific codec state plus the download /
     * featured link supplied by the site configuration. A Host that predates
     * `transfer` renders nothing, so older panels stay unchanged.
     */
    function TransferCard({ transfer, t, pending, onToggle }) {
      if (!transfer || typeof transfer !== 'object') return null
      const night = transfer.edition === 'night-cruising'
      const links = transfer.links ?? {}
      const editionChip = h(Chip, { tone: 'off' }, night ? t('transferEditionNight') : t('transferEditionDsh'))
      const linkNode = entry => {
        const link = transferLink(entry)
        if (!link) return null
        return h('div', null,
          h('div', { style: styles.row },
            h('a', { href: link.url, target: '_blank', rel: 'noreferrer', style: styles.link }, link.label)),
          link.hint ? h('p', { style: styles.hint }, link.hint) : null)
      }
      const linksUnavailable = transfer.linksStatus === 'error'
        ? h('p', { style: styles.hint }, t('transferLinksUnavailable'))
        : null

      if (!night) {
        return h('div', { style: styles.card },
          h('div', { style: styles.row },
            h('span', { style: styles.label }, t('transferTitle')),
            h(Chip, { tone: 'off' }, t('transferJsonl')),
            editionChip),
          h('p', { style: styles.hint }, t('transferJsonlHint')),
          linkNode(links.download) ?? linksUnavailable)
      }

      const active = transfer.active === true && transfer.mode === 'jlc'
      const pendingRestart = transfer.pendingRestart === true
      const tone = active ? 'on' : pendingRestart ? 'warn' : 'off'
      const chipLabel = active || pendingRestart ? t('transferJlc') : t('transferJsonl')
      const statusText = active
        ? t('transferCruising')
        : pendingRestart
          ? t('transferRestart')
          : transfer.available === false
            ? t('transferUnavailable')
            : t('transferDisabled')
      const on = transfer.desired === 'on' || active || pendingRestart
      return h('div', { style: styles.card },
        h('div', { style: styles.row },
          h('span', { style: styles.label }, t('transferTitle')),
          h(Chip, { tone }, chipLabel),
          editionChip,
          h('span', { style: { ...styles.value, fontFamily: 'inherit' } }, statusText)),
        pendingRestart ? h('p', { style: styles.hint }, t('transferRestartHint')) : null,
        h('div', { style: { ...styles.row, marginTop: '10px' } },
          h('button', {
            style: styles.button,
            className: 'am-button',
            disabled: pending === true,
            onClick: () => onToggle(!on),
          }, on ? t('transferDisable') : t('transferEnable'))),
        linkNode(links.featured) ?? linksUnavailable)
    }

    /**
     * Aggregate-only vault card. It never lists entries or exposes a read
     * action; the vault is a process-lifetime encrypted cache, not a file
     * browser. Only size/count and a user-initiated clear are shown.
     */
    function VaultCard({ vault, t, onClear, pending }) {
      if (!vault || typeof vault !== 'object') return null
      const empty = (vault.entries ?? 0) === 0
      return h('div', { style: styles.card },
        h('div', { style: styles.row },
          h('span', { style: styles.label }, t('vaultTitle')),
          h(Chip, { tone: empty ? 'off' : 'on' }, empty ? t('vaultEmpty') : fill(t('vaultUsage'), {
            bytes: formatBytes(vault.bytes ?? 0),
            entries: vault.entries ?? 0,
          }))),
        h('p', { style: styles.hint }, t('vaultHint')),
        empty ? null : h('button', {
          style: styles.button,
          className: 'am-button',
          disabled: pending,
          onClick: onClear,
        }, t('vaultClear')))
    }

    const SettingsPage = props => {
      const t = props.translate
      const { data, error, refresh } = useMeshState()
      const [pending, setPending] = React.useState(false)
      const [actionError, setActionError] = React.useState(null)
      const [probeTarget, setProbeTarget] = React.useState('')
      const [probeResult, setProbeResult] = React.useState(null)
      const [probing, setProbing] = React.useState(false)

      /** Probe one channel; an empty target means "every known peer on that channel". */
      const runProbe = async channel => {
        setProbing(true)
        setProbeResult(null)
        try {
          const targets = probeTarget.trim()
            ? [probeTarget.trim()]
            : channel === 'lan'
              ? (data?.peers ?? []).filter(peer => peer.online && peer.address).map(peer => `${peer.address}:${peer.port ?? 47831}`)
              : ((data?.channels?.tailnet?.addresses ?? []).map(address => `${address}:47831`))
          if (targets.length === 0) {
            setProbeResult({ channel, target: '—', replied: false, elapsedMs: 0 })
            return
          }
          const results = []
          for (const target of targets) results.push(await post('probe', { target, channel }))
          const replied = results.filter(result => result.replied)
          setProbeResult({
            channel,
            target: targets.join(', '),
            replied: replied.length > 0,
            elapsedMs: Math.max(...results.map(result => result.elapsedMs ?? 0)),
          })
        } catch (failure) {
          setActionError(failure.message)
        } finally {
          setProbing(false)
        }
      }

      const refreshNetwork = async () => {
        setProbing(true)
        try {
          await post('refresh-network', {})
          setProbeResult(null)
        } catch (failure) {
          setActionError(failure.message)
        } finally {
          setProbing(false)
        }
      }

      /** Toggle the local test peer; the tree hides it automatically while a real peer is connected. */
      const toggleLocalTest = async enabled => {
        setProbing(true)
        try {
          await post('local-test', { enabled })
        } catch (failure) {
          setActionError(failure.message)
        } finally {
          setProbing(false)
        }
      }

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

      /** Clear the encrypted vault; it only exposes aggregate state, never entries. */
      const clearVault = async () => {
        setPending(true)
        setActionError(null)
        try {
          await post('vault/clear', {})
          refresh()
        } catch (failure) {
          setActionError(failure.message)
        } finally {
          setPending(false)
        }
      }

      /** Persist the codec intent, then pull the fresh state instead of waiting for the poll tick. */
      const toggleCodec = async enabled => {
        setPending(true)
        setActionError(null)
        try {
          await post('codec', { enabled })
          refresh()
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

      const channelCard = () => {
        const channels = state.channels
        if (!channels) return null
        const lan = channels.lan ?? {}
        const tailnet = channels.tailnet ?? {}
        const localTest = state.localTest ?? {}
        const localTestOn = localTest.enabled === true
        return h('div', { style: styles.card },
          h('div', { style: styles.row },
            h('span', { style: styles.label }, t('channels')),
            h(Chip, { tone: lan.replies > 0 ? 'on' : 'off' }, `${t('lanChannel')} · ${fill(t('channelReplies'), { n: lan.replies ?? 0 })}`),
            h(Chip, { tone: tailnet.available ? (tailnet.replies > 0 ? 'on' : 'warn') : 'off' },
              `${t('tailnetChannel')} · ${tailnet.available ? fill(t('channelReplies'), { n: tailnet.replies ?? 0 }) : t('tailnetOff')}`)),
          h(Field, { label: t('lanChannel') },
            `${t('lanMulticast')} ${lan.multicastGroup ?? '—'} · ${t('lanBroadcast')} ${lan.broadcast ?? '—'} · ${fill(t('channelAnnounces'), { n: lan.announces ?? 0 })} · ${fill(t('channelPeers'), { n: lan.peers ?? 0 })}`),
          h(Field, { label: t('lanLocal') }, (lan.localAddresses ?? []).join(', ') || '—'),
          h(Field, { label: t('tailnetChannel') },
            `${t('tailnetPeersKnown')} ${tailnet.peersKnown ?? 0} · ${fill(t('channelPeers'), { n: tailnet.peers ?? 0 })} · ${(tailnet.addresses ?? []).join(', ') || '—'}`),
          h('div', { style: { ...styles.row, marginTop: '10px' } },
            h('input', {
              style: styles.input,
              placeholder: t('probeTargetHint'),
              value: probeTarget,
              onChange: event => setProbeTarget(event.target.value),
              'aria-label': t('probeTarget'),
            }),
            h('button', { style: styles.button, className: 'am-button', disabled: probing, onClick: () => runProbe('lan') }, t('testLan')),
            h('button', { style: styles.button, className: 'am-button', disabled: probing, onClick: () => runProbe('tailnet') }, t('testTailnet')),
            h('button', { style: styles.button, className: 'am-button', disabled: probing, onClick: refreshNetwork }, t('refreshNetwork'))),
          probing ? h('p', { style: styles.hint }, t('probeRunning')) : null,
          probeResult
            ? h('p', { style: probeResult.replied ? styles.hint : styles.error },
                `${t('probeReplied')}: ${probeResult.channel} ${probeResult.target} · ${probeResult.elapsedMs} ms${probeResult.replied ? '' : ` · ${t('probeNoReply')}`}`)
            : null,
          h('div', { style: { ...styles.row, marginTop: '12px' } },
            h('span', { style: styles.label }, t('localTestPeer')),
            h('button', {
              style: localTestOn ? styles.buttonPrimary : styles.button,
              className: localTestOn ? 'am-button am-button-primary' : 'am-button',
              disabled: probing,
              onClick: () => toggleLocalTest(!localTestOn),
            }, localTestOn ? t('localTestEnabled') : t('localTestDisabled')),
            localTestOn
              ? h(Chip, { tone: localTest.hiddenByRealPeer ? 'warn' : 'on' },
                  localTest.hiddenByRealPeer ? t('localTestHidden') : t('localTestEnabled'))
              : null),
          h('p', { style: styles.hint }, t('localTestHint')))
      }

      // Pending first-contact requests are answered by the frame-wide
      // `shell.overlay` host, so this section renders no dialog of its own.
      return h('section', { style: styles.page },
        h('h2', { style: styles.title }, t('title'),
          state.version ? h('span', { style: styles.titleVersion }, `v${state.version}`) : null),
        h('p', { style: styles.desc }, t('description')),
        error ? h('p', { style: styles.error }, `${t('error')}: ${error}`) : null,
        actionError ? h('p', { style: styles.error }, actionError) : null,
        h('div', { style: styles.card },
          h('div', { style: styles.row },
            h('span', { style: styles.label }, t('status')),
            h(Chip, { tone: state.status === 'ready' ? 'on' : state.status === 'disabled' || state.status === 'signed-out' ? 'warn' : 'off' }, statusLabel(t, state.status))),
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
        h(TransferCard, { transfer: state.transfer, t, pending, onToggle: toggleCodec }),
        h(VaultCard, { vault: state.vault, t, pending, onClear: clearVault }),
        channelCard(),
        h('div', { style: { ...styles.row, justifyContent: 'space-between', margin: '14px 0 8px' } },
          h('h3', { style: { ...styles.title, fontSize: '13px', margin: 0 } }, t('peers')),
          h('button', { style: styles.button, className: 'am-button', onClick: () => window.location.reload() }, t('refresh'))),
        peers.length === 0
          ? h('p', { style: styles.hint }, t('noPeers'))
          : peers.map(peer => h(PeerCard, { key: peer.deviceId, peer, t, pending, onAction: run })),
        h('p', { style: styles.hint }, t('toolHint')),
        h('p', { style: styles.hint }, t('readOnly')))
    }

    /** Collapsible reasoning block shared by the conversation and trajectory tabs. */
    function ReasoningBlock({ text, t, defaultOpen = false, locked = false }) {
      const [open, setOpen] = React.useState(defaultOpen && !locked)
      return h('div', { style: styles.reasoning },
        h('button', {
          style: styles.reasoningToggle,
          className: 'am-reasoning-toggle',
          disabled: locked,
          onClick: () => { if (!locked) setOpen(current => !current) },
          'aria-expanded': locked ? false : open,
        }, `${t('thinking')} · ${locked ? t('fetching') : open ? t('collapseThinking') : t('expandThinking')}`),
        !locked && open ? h('div', { style: styles.reasoningText }, text) : null)
    }

    /** System reminders are injected user messages; the chat view hides them. */
    function isSystemReminder(item) {
      if (item.role !== 'user' || typeof item.text !== 'string') return false
      return item.text.includes('<system-reminder>') || item.text.startsWith('Time sampled while preparing')
    }

    /** Collapsed process summary for a run of tool results; details live in the trajectory tab. */
    function ProcessGroup({ items, t }) {
      const errors = items.filter(item => item.isError).length
      return h('div', { style: styles.assistantRow },
        h('div', { style: styles.processNote },
          `${t('processNote')} · ${fill(t('toolResultsCount'), { n: items.length })}${errors ? ` · ${fill(t('errorsCount'), { n: errors })}` : ''} · ${t('seeTrajectory')}`))
    }

    /** Conversation tab: chat-like view with user bubbles, rendered assistant markdown and collapsed process. */
    function ConversationItem({ item, t, locked = false }) {
      if (item.role === 'user') {
        return h('div', { style: styles.userRow },
          h('div', { style: styles.userBubble }, item.text ?? ''))
      }
      return h('div', { style: styles.assistantRow },
        h('div', { style: styles.msgRole }, `${t('assistantRole')} · ${formatTime(item.time)}`),
        item.reasoning ? h(ReasoningBlock, { text: item.reasoning, t, locked }) : null,
        item.text ? h('div', null, renderMarkdown(item.text)) : null,
        item.toolCalls?.length
          ? h('div', { style: styles.processNote },
              `${t('processNote')} · ${item.toolCalls.join(', ')} · ${t('seeTrajectory')}`)
          : null)
    }

    /** Build the conversation list: messages plus one collapsed summary per tool-result run. */
    function conversationNodes(items, t, locked = false) {
      const nodes = []
      let results = []
      const flush = () => {
        if (results.length === 0) return
        nodes.push(h(ProcessGroup, { key: `process-${results[0].seq}`, items: results, t }))
        results = []
      }
      for (const item of items) {
        if (isSystemReminder(item)) continue
        if (item.role === 'tool-result') {
          results.push(item)
          continue
        }
        flush()
        if (item.role === 'user' || item.role === 'assistant') nodes.push(h(ConversationItem, { key: item.seq, item, t, locked }))
      }
      flush()
      return nodes
    }

    /** Trajectory tab: every event in seq order, including thinking, calls and errors. */
    function TrajectoryItem({ item, t, locked = false }) {
      const kind = item.role === 'user' || item.role === 'assistant'
        ? t('messageEvent')
        : item.role === 'tool-call'
          ? t('toolCallEvent')
          : item.isError ? t('toolResultError') : t('toolResultEvent')
      const tone = item.isError ? 'var(--dsw-alias-state-error-primary, #d64545)' : 'var(--dsw-alias-label-secondary)'
      const meta = item.role === 'tool-call' && item.name ? item.name : item.role
      const body = item.text
        ? item.role === 'assistant'
          ? h('div', null, renderMarkdown(item.text))
          : h('div', { style: styles.msgText }, item.role === 'tool-call' ? `${t('toolArguments')}: ${item.text}` : item.text)
        : null
      return h('div', { style: styles.msg },
        h('div', { style: { ...styles.msgRole, color: tone } }, `${kind} · ${meta} · ${formatTime(item.time)}`),
        body,
        item.reasoning ? h(ReasoningBlock, { text: item.reasoning, t, defaultOpen: true, locked }) : null,
        item.isError && (item.errorName || item.errorCode)
          ? h('div', { style: styles.errorMeta }, `${t('errorName')}: ${item.errorName ?? ''}${item.errorCode ? ` (${item.errorCode})` : ''}`)
          : null)
    }

    /** Folder icon: closed and open variants, colored when its workspace is selected. */
    function FolderIcon({ open, selected }) {
      const color = selected ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)'
      return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: color, strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        open
          ? h('path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v1H6.5a2 2 0 0 0-1.9 1.4L3 18z' })
          : h('path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }))
    }

    /** Device icon: monitor with a stand, colored when one of its workspaces is selected. */
    function DeviceIcon({ selected }) {
      const color = selected ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)'
      return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: color, strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('rect', { x: 3, y: 4, width: 18, height: 12, rx: 2 }),
        h('path', { d: 'M9 20h6' }),
        h('path', { d: 'M12 16v4' }))
    }

    /**
     * Frame-wide host for pending first-contact trust requests. It reads the
     * Host's `pendingTrust` list on a cadence and renders the blocking dialog
     * for the oldest unanswered request, so the request appears on whatever
     * panel is open instead of only inside the settings section.
     */
    function TrustRequestHost({ useRequests, decide, t }) {
      const requests = useRequests(current => current)
      const [pending, setPending] = React.useState(false)
      const [failure, setFailure] = React.useState(null)
      const request = Array.isArray(requests) && requests.length > 0 ? requests[0] : null
      // No request live: render nothing, but keep the hooks above unconditional.
      if (request === null) return null
      const answer = decision => {
        if (pending) return
        setPending(true)
        setFailure(null)
        void decide(request.deviceId, decision).then(
          () => setPending(false),
          error => {
            setPending(false)
            setFailure(error instanceof Error ? error.message : String(error))
          },
        )
      }
      return h(TrustRequestDialog, {
        key: request.deviceId,
        request,
        t,
        pending,
        failure,
        onDecide: answer,
      })
    }

    /**
     * Blocking first-contact trust dialog. It renders through a body portal over
     * the whole app, traps Tab inside its two answers, and refuses to close on
     * Escape or a mask press: a peer stays disconnected until the user picks
     * Trust or Refuse. Refusing is a durable revocation, not a dismissal.
     */
    function TrustRequestDialog({ request, t, pending, failure, onDecide }) {
      const dialogRef = React.useRef(null)
      const trustRef = React.useRef(null)
      React.useEffect(() => {
        const node = trustRef.current
        if (node && typeof node.focus === 'function') node.focus({ preventScroll: true })
        // Escape and Tab are owned in the capture phase so neither the app's
        // shortcut dispatcher nor a nested dialog can dismiss the request.
        const onKeyDown = event => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            return
          }
          if (event.key !== 'Tab') return
          const root = dialogRef.current
          if (!root) return
          const focusable = [...root.querySelectorAll('button:not([disabled])')]
          if (focusable.length === 0) return
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          const active = document.activeElement
          if (event.shiftKey && (active === first || !root.contains(active))) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && (active === last || !root.contains(active))) {
            event.preventDefault()
            first.focus()
          }
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [request.deviceId])
      const detail = (label, value) => h('div', { style: { ...styles.row, alignItems: 'flex-start', marginTop: '4px' } },
        h('span', { style: styles.label }, label),
        h('span', { style: styles.value }, value))
      return ReactDOM.createPortal(
        h('div', { style: styles.dialogRoot, role: 'presentation' },
          h('div', { style: styles.dialogMask, 'aria-hidden': true }),
          h('div', {
            ref: dialogRef,
            style: styles.dialogCard,
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t('trustRequestTitle'),
            // Unnamed modal scope: every application shortcut is blocked while
            // this dialog is the foreground modal.
            'data-shortcut-modal': 'other',
          },
            h('h2', { style: styles.dialogTitle }, t('trustRequestTitle')),
            h('p', { style: styles.dialogBody }, fill(t('trustRequestBody'), { name: request.name || request.deviceId })),
            h('div', { style: styles.dialogDetails },
              detail(t('trustRequestDevice'), request.deviceId),
              request.fingerprint ? detail(t('trustRequestFingerprint'), request.fingerprint) : null,
              request.address ? detail(t('trustRequestAddress'), request.address) : null),
            h('p', { style: styles.hint }, t('trustRequestHint')),
            failure ? h('p', { style: styles.error }, `${t('error')}: ${failure}`) : null,
            h('div', { style: styles.dialogFooter },
              h('button', {
                style: styles.button,
                className: 'am-button',
                disabled: pending,
                onClick: () => onDecide('refuse'),
              }, t('trustRequestRefuse')),
              h('button', {
                ref: trustRef,
                style: styles.buttonPrimary,
                className: 'am-button am-button-primary',
                disabled: pending,
                onClick: () => onDecide('trust'),
              }, t('trustRequestTrust'))))),
        document.body)
    }

    /** One tree row: hover tooltip carries full details, overflowing labels marquee on hover. */
    function TreeRow({ depth, label, meta, active, expandable, expanded, onClick, actions, detail, icon }) {
      const nameRef = React.useRef(null)
      const textRef = React.useRef(null)
      // Measure on hover: only a label wider than its box scrolls, so short
      // titles never animate and never carry an ellipsis into the marquee.
      const onEnter = () => {
        const name = nameRef.current
        const text = textRef.current
        if (!name || !text) return
        const overflow = text.scrollWidth - name.clientWidth
        if (overflow > 1) {
          name.setAttribute('data-overflow', '')
          name.style.setProperty('--am-marquee-view', `${name.clientWidth}px`)
          name.style.setProperty('--am-marquee-travel', `${overflow}px`)
          // Fixed reading speed: velocity stays constant, so a longer label
          // takes proportionally longer to scroll instead of moving faster.
          const seconds = Math.max(1.5, overflow / MARQUEE_PX_PER_SECOND)
          name.style.setProperty('--am-marquee-duration', `${seconds.toFixed(2)}s`)
        } else {
          name.removeAttribute('data-overflow')
          name.style.removeProperty('--am-marquee-view')
          name.style.removeProperty('--am-marquee-travel')
          name.style.removeProperty('--am-marquee-duration')
        }
      }
      // No chevron glyph: the whole row is the expand/collapse control and
      // aria-expanded carries the state, so the icon column stays narrow.
      return h('div', { style: styles.treeRow(depth), className: active ? 'am-tree-row am-tree-row-active' : 'am-tree-row', onMouseEnter: onEnter },
        h('button', {
          style: styles.treeButton,
          className: 'am-tree-button',
          onClick,
          title: detail ?? label,
          'aria-expanded': expandable ? expanded : undefined,
          'aria-current': active ? 'true' : undefined,
        },
          icon ? h('span', { style: styles.treeIcon }, icon) : null,
          h('span', { ref: nameRef, style: styles.treeName, className: 'am-tree-name' },
            h('span', { ref: textRef, className: 'am-tree-text' }, label)),
          meta ? h('span', { style: styles.treeMetaRight, className: 'am-tree-meta' }, meta) : null),
        actions ? h('span', { style: styles.treeActions, className: 'am-tree-actions' }, actions) : null)
    }

    const MeshPanel = props => {
      const t = props.translate
      const meshState = useMeshState()
      const [tree, setTree] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [expanded, setExpanded] = React.useState({})
      const [selection, setSelection] = React.useState(null)
      const [transcript, setTranscript] = React.useState(null)
      const [transcriptError, setTranscriptError] = React.useState(null)
      const [loadingMore, setLoadingMore] = React.useState(false)
      const [view, setView] = React.useState('conversation')
      const [treeWidth, setTreeWidth] = React.useState(360)
      const [dragging, setDragging] = React.useState(false)
      const [forcing, setForcing] = React.useState(false)
      const [fetching, setFetching] = React.useState(false)
      const [fetchError, setFetchError] = React.useState(null)
      const [staged, setStaged] = React.useState(false)
      // Known per-session data totals (from the remote index or a page total).
      const [sessionTotals, setSessionTotals] = React.useState(() => new Map())
      const resizeRef = React.useRef(null)

      const onSplitterDown = event => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        resizeRef.current = { id: event.pointerId, startX: event.clientX, startWidth: treeWidth }
        setDragging(true)
      }
      const onSplitterMove = event => {
        const drag = resizeRef.current
        if (!drag || drag.id !== event.pointerId) return
        setTreeWidth(Math.max(240, Math.min(560, drag.startWidth + event.clientX - drag.startX)))
      }
      const onSplitterUp = event => {
        const drag = resizeRef.current
        if (!drag || drag.id !== event.pointerId) return
        resizeRef.current = null
        setDragging(false)
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      }

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

      /** Record a session's data total once any response reports one. */
      const noteTotal = React.useCallback((sessionId, body) => {
        if (body?.totalBytes == null && body?.itemCount == null) return
        setSessionTotals(current => {
          const next = new Map(current)
          next.set(sessionId, { totalBytes: Number(body.totalBytes) || 0, totalItems: Number(body.itemCount) || 0 })
          return next
        })
      }, [])

      /**
       * Pull the compact session index (seq/role/bytes per item, plus totals).
       * The Host serves it from its transfer cache unless `force` is set, so a
       * plain refresh never re-reads the whole session from the peer.
       *
       * Older peers do not support `sessions/index` and answer bad-request;
       * that is not an error the reader should surface — totals simply stay
       * unknown for them until they upgrade.
       */
      const loadIndex = React.useCallback(async (target, force = false) => {
        try {
          const index = await getJson('sessions/index', { peer: target.peer, sessionId: target.sessionId }, force)
          noteTotal(target.sessionId, index)
          return index
        } catch {
          return null
        }
      }, [noteTotal])

      const loadTranscript = React.useCallback(async (target, fromSeq = 0, force = false) => {
        try {
          const body = await getJson('transcript', { peer: target.peer, sessionId: target.sessionId, fromSeq, limit: 200 }, force)
          setTranscript(current => {
            if (fromSeq === 0 || !current) return body
            return { ...body, items: [...current.items, ...(body.items ?? [])] }
          })
          setTranscriptError(null)
          noteTotal(target.sessionId, body)
          // Peers that do not report per-page totals: one compact index read
          // sizes the session. Peers that report totalBytes skip this call.
          if (fromSeq === 0 && body.totalBytes == null) loadIndex(target, false)
        } catch (failure) {
          setTranscriptError(failure.message)
        }
      }, [noteTotal, loadIndex])

      React.useEffect(() => {
        if (!selection) {
          setTranscript(null)
          return
        }
        setTranscript(null)
        setTranscriptError(null)
        loadTranscript(selection, 0, false)
      }, [selection, loadTranscript])

      /** Force refresh: bypass the Host cache and re-pull index and window from the peer. */
      const forceRefresh = async () => {
        if (!selection) return
        setForcing(true)
        setTranscript(null)
        setTranscriptError(null)
        try {
          await loadIndex(selection, true)
          await loadTranscript(selection, 0, true)
        } finally {
          setForcing(false)
        }
      }

      const toggle = key => setExpanded(current => ({ ...current, [key]: current[key] === false }))
      const isOpen = key => expanded[key] !== false

      const peers = [...(tree?.peers ?? [])].sort(comparePeers)
      const offlinePeers = peers.filter(peer => peer.online !== true)
      const verifiedPeers = peers.filter(peer => peer.online === true && !peer.error)
      /**
       * Filtered tree: sessions that carry neither a title nor a known byte
       * total are dropped, and a workspace whose every session was dropped is
       * dropped too. Peers stay listed even when nothing survives, so the pane
       * shows an empty state instead of losing the device.
       */
      const visibleWorkspaces = peer => (peer.workspaces ?? [])
        .map(workspace => ({
          workspace,
          sessions: [...(workspace.sessions ?? [])]
            .filter(session => isVisibleSession(session, sessionTotals, t))
            .sort(compareSessions),
        }))
        .filter(entry => entry.sessions.length > 0)
      const totalSessions = verifiedPeers.reduce(
        (sum, peer) => sum + visibleWorkspaces(peer).reduce((count, entry) => count + entry.sessions.length, 0),
        0,
      )
      const retry = async deviceId => {
        try {
          await post('reconnect', { deviceId })
          await loadTree()
        } catch (failure) {
          setError(failure.message)
        }
      }

      const transfer = meshState.data?.transfer ?? null
      const activeTransfer = (meshState.data?.transfers ?? []).find(entry =>
        entry.peerId === selection?.peer && entry.sessionId === selection?.sessionId) ?? null

      const startFetch = async () => {
        if (!selection || fetching) return
        setFetching(true)
        setFetchError(null)
        setStaged(false)
        try {
          const body = await post('fetch', { peer: selection.peer, sessionId: selection.sessionId, priority: 'dialog' })
          setTranscript({
            session: { id: selection.sessionId, cwd: null, createdAt: null },
            fromSeq: 0,
            nextSeq: 0,
            hasMore: false,
            items: body.items ?? [],
            bytes: body.archiveBytes ?? 0,
            cached: false,
          })
        } catch (failure) {
          setFetchError(failure.message)
        } finally {
          setFetching(false)
        }
      }

      // Stage the dialog as soon as all P0 blocks are in memory; the rest of
      // the session continues pulling and the reasoning blocks stay locked
      // until the full archive is decoded.
      React.useEffect(() => {
        if (!fetching || staged || !activeTransfer?.dialogReady || !activeTransfer.transferId) return
        let alive = true
        fetch(`/account-mesh/api/transfer/dialog?transferId=${encodeURIComponent(activeTransfer.transferId)}`)
          .then(response => response.json())
          .then(body => {
            if (!alive || !body?.ready) return
            setTranscript(current => ({
              ...(current ?? { session: { id: selection?.sessionId }, fromSeq: 0, nextSeq: 0 }),
              hasMore: false,
              items: body.items ?? [],
              bytes: 0,
              cached: false,
            }))
            setStaged(true)
          })
          .catch(() => {})
        return () => { alive = false }
      }, [activeTransfer?.transferId, activeTransfer?.dialogReady, fetching, staged, selection?.sessionId])

      const transcriptBody = () => {
        if (!selection) return h('div', { style: styles.empty }, t('selectSessionHint'))
        if (transcriptError) return h('div', { style: styles.empty }, `${t('error')}: ${transcriptError}`)
        if (!transcript) return h('div', { style: styles.empty }, t('waiting'))
        const items = transcript.items ?? []
        const locked = fetching || staged
        const progress = activeTransfer
          ? fill(t('fetchProgress'), {
              received: activeTransfer.receivedBlocks ?? 0,
              total: activeTransfer.totalBlocks ?? 0,
              percent: activeTransfer.totalBlocks
                ? Math.round((activeTransfer.receivedBlocks ?? 0) / activeTransfer.totalBlocks * 100)
                : 0,
            })
          : null
        const content = view === 'conversation'
          ? conversationNodes(items, t, locked)
          : items.map(item => h(TrajectoryItem, { key: item.seq, item, t, locked }))
        return h(React.Fragment, null,
          progress ? h('div', { style: { ...styles.hint, padding: '6px 14px' } }, progress) : null,
          staged ? h('div', { style: { ...styles.hint, padding: '0 14px 6px' } }, t('fetchDialogReady')) : null,
          fetchError ? h('div', { style: { ...styles.error, padding: '6px 14px' } }, `${t('fetchFailed')}: ${fetchError}`) : null,
          h('div', { style: { flex: 1, overflow: 'auto' } },
            content.length === 0
              ? h('div', { style: styles.empty }, view === 'conversation' ? t('emptyConversation') : t('emptyTrajectory'))
              : null,
            content),
          transcript.hasMore
            ? h('div', { style: { padding: '8px 14px', borderTop: '1px solid var(--dsw-alias-border-l2)' } },
                h('button', {
                  style: styles.button,
                  className: 'am-button',
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
        h('style', null, PANEL_CSS),
        h('div', { style: styles.panelHead, className: 'am-panel-head' },
          h('span', { style: { ...styles.title, margin: 0 } }, t('panelTitle')),
          h(Chip, { tone: 'off' }, t('readOnlyTag')),
          h('span', { style: styles.treeMeta }, fill(t('devicesCount'), { n: verifiedPeers.length })),
          h('span', { style: { flex: 1 } }),
          error ? h('span', { style: styles.treeMeta }, `${t('error')}: ${error}`) : null,
          h('button', { style: styles.button, className: 'am-button', onClick: () => loadTree() }, t('refresh'))),
        h('div', { style: styles.panelBody },
          h('div', { style: styles.treePane(treeWidth) },
            h('div', { style: styles.paneHead },
              h('span', { style: styles.paneTitle }, t('sessionsPane')),
              h('span', { style: styles.treeMeta, title: fill(t('sessionsCount'), { n: totalSessions }) },
                tree === null ? t('waiting') : String(totalSessions))),
            h('div', { style: styles.paneSub }, t('panelHint')),
            verifiedPeers.length === 0 && tree !== null
              ? h('div', { style: styles.empty }, t('noPeersOnline'))
              : null,
            verifiedPeers.map(peer => {
              const peerKey = peer.deviceId
              const peerOpen = isOpen(peerKey)
              const workspaces = visibleWorkspaces(peer)
              return h('div', { key: peerKey },
                h(TreeRow, {
                  depth: 0,
                  label: peer.name || peer.shortId,
                  meta: peer.source === 'tailnet' ? `tailscale · ${peer.rttMs != null ? `${peer.rttMs}ms` : peer.shortId}` : peer.shortId,
                  detail: peerDetail(peer, t),
                  icon: h(DeviceIcon, { selected: selection?.peer === peerKey }),
                  expandable: true,
                  expanded: peerOpen,
                  onClick: () => toggle(peerKey),
                }),
                peer.error ? h('div', { style: { ...styles.empty, padding: '4px 20px' } }, peer.error) : null,
                peerOpen
                  ? (workspaces.length === 0
                      ? h('div', { style: { ...styles.empty, padding: '4px 20px' } },
                          peer.workspaces.length === 0 ? t('noWorkspaces') : t('noVisibleWorkspaces'))
                      : workspaces.map(entry => {
                          const workspace = entry.workspace
                          const workspaceKey = `${peerKey}/${workspace.id}`
                          const workspaceOpen = isOpen(workspaceKey)
                          return h('div', { key: workspaceKey },
                            h(TreeRow, {
                              depth: 1,
                              label: workspace.name || workspace.title || t('workspaceUnknown'),
                              meta: fill(t('sessionsCount'), { n: entry.sessions.length }),
                              detail: workspaceDetail(workspace, t),
                              icon: h(FolderIcon, { open: workspaceOpen, selected: selection?.workspaceKey === workspaceKey }),
                              expandable: true,
                              expanded: workspaceOpen,
                              onClick: () => toggle(workspaceKey),
                            }),
                            workspaceOpen
                              ? entry.sessions.map(session => {
                                  const active = selection?.peer === peerKey && selection?.sessionId === session.id
                                  const total = sessionTotals.get(session.id)?.totalBytes ?? session.totalBytes
                                  const meta = `${session.live ? t('live') : formatRelative(session.createdAt, t)}${total != null ? ` · ${formatBytes(total)}` : ''}`
                                  return h(TreeRow, {
                                    key: session.id,
                                    depth: 2,
                                    label: session.title || t('untitled'),
                                    meta,
                                    detail: sessionDetail(session, t, sessionTotals.get(session.id)),
                                    active,
                                    onClick: () => setSelection({ peer: peerKey, sessionId: session.id, title: session.title, workspaceKey }),
                                    actions: h(CopyButton, { text: session.id, label: t('copySessionId'), t, compact: true }),
                                  })
                                })
                              : null)
                        }))
                  : null)
            }),
            offlinePeers.map(peer => h('div', { key: `offline:${peer.deviceId}`, style: { ...styles.empty, padding: '6px 10px' } },
              h('div', { style: { ...styles.row, color: 'var(--dsw-alias-label-secondary)' } },
                h('span', { style: { ...styles.treeName, color: 'var(--dsw-alias-label-secondary)' } }, peer.name || peer.shortId),
                h(Chip, { tone: 'off' }, t('offlineTag'))),
              h('div', { style: { ...styles.treeMeta, paddingLeft: '18px' } },
                peer.lastSeenAt ? `${t('lastSeen')} ${formatRelative(peer.lastSeenAt, t)}` : `${t('neverSeen')} · ${peer.shortId}`),
              h('div', { style: { paddingLeft: '18px', marginTop: '4px' } },
                h('button', { style: styles.button, className: 'am-button', onClick: () => retry(peer.deviceId) }, t('retry')))))),
          h('div', {
            style: styles.splitter,
            className: 'am-splitter',
            role: 'separator',
            'aria-orientation': 'vertical',
            'aria-label': t('resizeTree'),
            tabIndex: 0,
            'data-dragging': dragging || undefined,
            onPointerDown: onSplitterDown,
            onPointerMove: onSplitterMove,
            onPointerUp: onSplitterUp,
            onPointerCancel: onSplitterUp,
            onLostPointerCapture: onSplitterUp,
            onKeyDown: event => {
              if (event.key === 'ArrowLeft') setTreeWidth(width => Math.max(240, width - 16))
              if (event.key === 'ArrowRight') setTreeWidth(width => Math.min(560, width + 16))
            },
          },
            h('div', { style: styles.splitterLine, className: 'am-splitter-line' })),
          h('div', { style: styles.transcriptPane },
            h('div', { style: styles.tabBar },
              h('button', {
                style: styles.tab(view === 'conversation'),
                className: view === 'conversation' ? 'am-tab am-tab-active' : 'am-tab',
                onClick: () => setView('conversation'),
                'aria-pressed': view === 'conversation',
              }, t('conversationTab')),
              h('button', {
                style: styles.tab(view === 'trajectory'),
                className: view === 'trajectory' ? 'am-tab am-tab-active' : 'am-tab',
                onClick: () => setView('trajectory'),
                'aria-pressed': view === 'trajectory',
              }, t('trajectoryTab')),
              h(Chip, { tone: 'off' }, t('readOnlyTag'))),
            h('div', { style: styles.paneSub }, view === 'conversation' ? t('conversationHint') : t('trajectoryHint')),
            selection
              ? h('div', { style: styles.toolbar },
                  h('span', { style: styles.toolbarTitle, title: selection.title || t('untitled') },
                    selection.title || t('untitled')),
                  h('span', { style: styles.toolbarId, title: selection.sessionId },
                    `${t('sessionIdLabel')}: ${shortSessionId(selection.sessionId)}`),
                  h(CopyButton, { text: selection.sessionId, label: t('copySessionId'), t }),
                  transfer?.active
                    ? h('button', {
                        style: styles.button,
                        className: 'am-button',
                        disabled: fetching,
                        onClick: () => { void startFetch() },
                      }, fetching ? t('fetching') : t('fetchFull'))
                    : null,
                  sessionTotals.get(selection.sessionId) != null
                    ? h(Chip, { tone: 'off' }, `${t('sessionBytesLabel')} ${formatBytes(sessionTotals.get(selection.sessionId).totalBytes)}`)
                    : null,
                  transcript ? h(Chip, { tone: transcript.cached ? 'off' : 'on' }, transcript.cached ? t('fromCache') : t('fromRemote')) : null,
                  h('span', { style: { flex: 1 } }),
                  h('button', {
                    style: styles.button,
                    className: 'am-button',
                    disabled: forcing,
                    title: t('forceRefreshHint'),
                    onClick: forceRefresh,
                  }, forcing ? t('waiting') : t('forceRefresh')),
                  h('button', { style: styles.button, className: 'am-button', onClick: () => setSelection(null) }, '×'))
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

        // Frame-wide pending trust requests. The Host owns the request list;
        // this store publishes the latest read so the `shell.overlay` host can
        // show the blocking dialog on whatever panel is open, and so the
        // settings section and the host never disagree about what is pending.
        const trustRequests = createSnapshotStore([])
        let trustPollTimer = null
        let trustPollAlive = false
        const readTrustRequests = async () => {
          try {
            const response = await fetch('/account-mesh/api/state', { headers: { accept: 'application/json' } })
            const body = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
            const list = Array.isArray(body.pendingTrust) ? body.pendingTrust : []
            // Publish only a changed list: the hook binds to snapshot identity,
            // so an unchanged poll must not republish a new array.
            if (JSON.stringify(trustRequests.getSnapshot()) !== JSON.stringify(list)) trustRequests.set(list)
          } catch {
            // A failed read keeps the previous list: the dialog stays until the
            // user answers, and the next poll retries.
          }
        }
        const pollTrustRequests = async () => {
          await readTrustRequests()
          if (trustPollAlive) trustPollTimer = setTimeout(pollTrustRequests, 2500)
        }
        ctx.effect(() => {
          trustPollAlive = true
          void pollTrustRequests()
          return () => {
            trustPollAlive = false
            if (trustPollTimer !== null) clearTimeout(trustPollTimer)
            trustPollTimer = null
          }
        }, 'account-mesh: pending trust requests')
        /** Answer one pending request and publish the resulting list immediately. */
        const decideTrustRequest = async (deviceId, decision) => {
          const response = await fetch('/account-mesh/api/trust-request', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ deviceId, decision }),
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)
          await readTrustRequests()
        }

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

        // The blocking dialog lives in the frame-wide overlay list, so it
        // appears over every panel and seat instead of only inside Settings.
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'account-mesh.trust-request',
          locale: NS,
          inject: () => ({
            hooks: { requests: trustRequests },
            decide: decideTrustRequest,
          }),
        }, TrustRequestHost))
      },
    }
  },
})
