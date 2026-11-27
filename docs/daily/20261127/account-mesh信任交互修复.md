# account-mesh 信任交互修复：撤销被心跳冲掉 + 阻塞式首次信任确认

- 日期：2026-11-27
- 影响范围：`plugins/account-mesh`（`dsh-account-mesh@0.1.0-rc.13` 源码，未改版本号）
- 现象：在设置页点「撤销信任」后，下一次心跳/announce 到达就把对端重新标成「已信任」，界面马上又变回信任状态；撤销形同虚设。
- 结论：`forget()` 只是从信任表**删除**条目，而 `autoTrustSameAccount` 的规则是「没有条目就 upsert」，于是任何一次 announce/信令都会把删除的条目补回来。修复分两层：① 撤销改成**持久状态**而不是删除；② 首次信任改成**阻塞式人工确认**，不再自动信任。

## 1. 根因

`src/mesh.js` 里两条自动信任路径都以「条目不存在」为触发条件：

```js
// onPeer（announce 到达，每 5s 一次）
if (this.config.autoTrustSameAccount && (!trusted || keyChanged)) this.trust.upsert(...)

// onSignal（offer/answer/ice 到达）
if (!this.trust.has(peer.deviceId)) {
  if (!this.config.autoTrustSameAccount) return
  this.trust.upsert(...)
}
```

`forget()` 当时是 `this.trust.remove(deviceId)`。删除之后 `!trusted` 成立，下一次心跳就重新 upsert——所以撤销只能维持到下一个心跳周期（≤5s）。`peers.json` 里也没有任何「拒绝」标记可以区分「从未见过」和「用户明确拒绝」。

## 2. 修复内容

### 2.1 撤销成为持久状态（`src/trust.js`）

- 新增 `revoke(deviceId)`：保留条目，写入 `revoked: true` + `revokedAt`；`upsert` 会清掉这两个字段（即显式信任解除撤销）。
- 新增 `isTrusted(deviceId)`：条目存在且 `revoked !== true` 才算信任。
- `list()` 只返回未撤销条目；新增 `revokedList()`。
- `save()` 持久化**两类条目**（`version: 2`），否则重启后撤销标记丢失、账号规则又会重新信任。
- `rememberEndpoint` 跳过撤销条目，避免心跳继续更新被拒绝设备的地址。

### 2.2 自动信任不再覆盖用户决定（`src/mesh.js`）

- `onPeer`：只有「已信任设备换了公钥」才 rebound；撤销条目永不 rebound；首次接触不再 upsert。
- `onSignal`：撤销条目直接丢弃信令并记日志；未信任条目不再 upsert，只排队成待确认请求。
- `connect`、`serve`、`call`、`housekeeping` 全部改用 `isTrusted`，撤销条目不会被重连或服务。
- 新增 `pendingTrust` 内存表 + `refreshPendingTrust(peer)`：首次接触且 `autoTrustSameAccount` 开启时排队一条请求（设备名、指纹、地址、时间）；已信任或撤销的设备不排队。
- `pair()` 清除撤销与待确认条目；`forget()` 改为调用 `revoke()` 并清掉待确认条目。
- `state()` 新增 `pendingTrust` 列表；`peerViews()` 新增 `revoked`、`revokedAt`、`pendingTrust` 字段。

### 2.3 阻塞式首次信任对话框（`client.js`）

参照 DSH 原版机制拼装（调研结论见 `docs/research/account-mesh-vs-agent-mesh.md`）：

- `ReactDOM.createPortal` 到 `document.body`：全屏 `position: fixed; inset: 0; z-index: 1000`，遮罩拦截点击，覆盖所有面板与 seat。
- `role="dialog"` + `aria-modal="true"` + `data-shortcut-modal="other"`：未命名 modal 作用域会让 DSH 快捷键分发器 `consume()` 并 `blocked`（`packages/client/shortcuts/src/client/registry.ts`），所有应用快捷键被挡住。
- `window` capture 阶段接管 Escape 与 Tab：Escape 被 `preventDefault` + `stopPropagation`（不能关闭），Tab 只在「拒绝并撤销」「信任这台设备」两个按钮间循环。
- 初始焦点落在「信任这台设备」。
- 两个按钮分别调用 `POST /account-mesh/api/trust-request`，`decision` 为 `trust` / `refuse`。
- 拒绝后写持久撤销；对话框只在用户回答后消失，遮罩点击与 Esc 都不算回答。

### 2.4 面板与工具

- `PeerCard` 增加「已撤销」/「待确认」chip，撤销设备显示持久撤销提示。
- `src/routes.js` 新增 `POST /api/trust-request`（`trust` → `pair` + `reconnect`；`refuse` → `forget`），`/api/forget` 返回 `revokedAt`。
- `src/tools.js`：`mesh_peer_forget` 返回 `{ revoked, revokedAt }`，描述改为「持久撤销，只有 `mesh_peer_pair` 能恢复」；`mesh_peer_pair` 描述改为可解除撤销/回答待确认请求。

## 3. 验证

```sh
cd plugins/account-mesh
npm run check                     # node --check index.js client.js src/*.js
node spike/p0-mesh.mjs            # 双实例：发现→待确认→显式信任→撤销→心跳不复活→重启仍撤销→显式信任恢复
node spike/p0-client.mjs          # 客户端：对话框 portal/aria-modal/shortcut-modal/两个按钮/持久撤销 chip
node spike/p0-apply.mjs           # Host 半侧 + 面板路由
node spike/p0-jlc.mjs             # JLC 块传输（已改为显式 pair）
node spike/p0-vault.mjs           # 保险柜
node spike/p0-transport.mjs       # WebRTC 传输
```

新增断言（`p0-mesh.mjs`）：

```text
PASS first contact queues a pending trust request
PASS pending peer is not trusted yet
PASS explicit trust clears the pending request
PASS peer is trusted after the explicit answer
PASS revoked peer is not trusted
PASS revoked peer is reported as revoked
PASS revoked entry stays in the store
PASS heartbeats do not re-trust a revoked peer      # 等待 7s 覆盖至少一次 announce
PASS revoked peer queues no trust request
PASS reads stay refused after revocation
PASS revocation survives a restart
PASS explicit trust clears the revocation
```

新增断言（`p0-client.mjs`）：

```text
PASS pending request renders a portal dialog
PASS dialog is modal and blocks shortcuts
PASS dialog names the requesting device
PASS dialog offers trust and refuse
PASS dialog explains durable refusal
PASS revoked peer shows the revoked chip
PASS pending peer shows the awaiting chip
PASS client posts trust decisions through the route
```

全部 6 个 spike 与 `npm run check` 通过（`ALL PASS`）。

## 4. 行为变化（需要注意）

1. **首次接触不再自动建立通道**：陌生同账号设备会被发现并排队，必须由用户点一次「信任这台设备」。这改变了原来「装好即互通」的体验；`autoTrustSameAccount: false` 时不再排队，只能手动信任。
2. **撤销不可被心跳冲掉**：撤销后即使对方持续 announce/发信令也不会恢复；只有面板「信任」、`mesh_peer_pair` 或 `POST /api/pair` 能恢复。
3. **`peers.json` 版本升到 2**：旧文件（版本 1）照常读取，条目按 `revoked: false` 处理。
4. **`spike/p0-jlc.mjs` 与 `spike/p0-remote-service.mjs`** 已改为显式 `pair`，否则它们会因为等待「自动信任」而超时。

## 5. 后续：对话框改为 frame 级 `shell.overlay`

第一版把对话框挂在 `settings.section` 的渲染树里（portal 到 `document.body`，覆盖全屏），但离开设置页时 section 卸载、对话框随之消失。已改为 frame 级 overlay：

- **注册位置**：`ctx.slots.inject('shell.overlay', ...)` + `ctx.slots.register({ name: 'shell.overlay', id: 'account-mesh.trust-request', locale: NS, inject })`。`shell.overlay` 是 `ui-layout` 声明的 root 级 list slot（`AppFrame` 渲染，容器 `pointer-events: none`，子元素自己 opt-in），`agent-team.disable` 与 `chat.quota-notice` 都是这样挂的。
- **数据来源**：`apply` 里创建 `createSnapshotStore([])`（来自 Web shell 模块基线的 `@deepseek-ai/dsh-client-store`），每 2.5s 轮询 `/account-mesh/api/state` 的 `pendingTrust`，只在列表变化时 `set()`（hook 绑定 snapshot 身份，未变化不重发）。轮询挂在 `ctx.effect` 里，插件卸载时清理定时器。
- **回答**：`decideTrustRequest(deviceId, decision)` 直接 `POST /account-mesh/api/trust-request`，成功后立即重读列表，对话框随列表清空而消失；失败信息显示在对话框内。
- **inject face**：`hooks: { requests }` → 组件拿到 `useRequests` 选择器 hook；`decide` 作为普通回调。组件内 hooks 无条件调用，空列表时返回 `null`。
- **设置页**：删除了 section 内的对话框与 `answered` 状态，设置页只显示对端 chip（「已撤销」/「待确认」）。对话框不再依赖设置页是否打开。
- **验证**：`p0-client.mjs` 增加 overlay 注册断言（`injects into shell.overlay`、`registers four slots`、`overlay entry id names the trust request host`），并直接驱动 overlay 组件：pending 列表 → 渲染 portal 对话框；空列表 → 渲染 `null`；设置页不再包含 portal。

```text
PASS injects into shell.overlay
PASS registers four slots
PASS overlay entry id names the trust request host
PASS overlay entry carries a locale namespace
PASS pending request renders a portal dialog
PASS dialog is modal and blocks shortcuts
PASS dialog names the requesting device
PASS dialog offers trust and refuse
PASS dialog explains durable refusal
PASS no pending request renders nothing
PASS revoked peer shows the revoked chip
PASS pending peer shows the awaiting chip
PASS settings section renders no dialog of its own
```

## 6. 远端机器是否也要升级

验收「我撤销后对面不再信任我」有两种情况：

1. **对面已升级到本版本**：撤销时发送一条签名 `revoke` 通知（`sendSignal(peer, 'revoke', { v })`）。对端 `onSignal` 收到后调用 `onRevokeNotice()`，把自己的信任条目也标成 `revoked` 并断开链接；此后它的读取被 `not-paired` 拒绝。两边的撤销状态收敛，不需要在远端手动操作。
   - 通知在 `forget()` 里**先发后断链**；对端即使已经撤销我们，也会处理这条通知（`onSignal` 对 `revoke` 有单独分支），所以双向撤销不会互相忽略。
   - 通知是签名帧，与 offer/answer/ice 走同一条 UDP 通道；对端离线时通知丢失，对端保留自己的信任条目——这是本地撤销的固有局限，本地撤销本身仍生效。
2. **对面仍是旧版本**：旧版 `onSignal` 不认识 `revoke` 这个 kind，会忽略它，**保留自己的信任条目**。此时「我撤销后对面依然信任我」成立——对面仍会尝试向我发起连接，但我的 `serve()`/`call()` 用 `isTrusted` 拒绝，所以对面读不到任何东西；只是对面面板仍显示「已信任」。

结论：**要验收「对面也不再信任我」，远端必须升级到同一版本**；只升级一端时，撤销在本地生效、远端读取被拒，但远端信任表不会自动收敛。

新增断言（`p0-mesh.mjs`）：

```text
PASS revoke notice revokes the peer side too
PASS peer side reports the revocation in its views
PASS peer side refuses reads after the notice
```

## 7. 尚未做的部分

- 没有实现 `inert` 级别的「父级控件全部禁用」：插件拿不到 AppFrame 的 DOM 引用，当前靠 mask + 快捷键阻塞 + Tab 循环三层实现阻塞。
- overlay host 的轮询是 2.5s 节奏，只影响显示延迟，不中止任何请求（符合本仓「去除所有超时」约定）。
- 未改动传输层、只读白名单、JLC 与保险柜协议。
