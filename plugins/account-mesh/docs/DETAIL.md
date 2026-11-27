# 同账号互联（account mesh）

多个 **登录同一 DeepSeek 账号** 的 DSH 实例，在局域网（含 Tailscale 组网）内互相发现，用 Ed25519 身份认证做握手，然后用 WebRTC 数据通道传输，允许各自的 agent **只读**访问对方的会话与工作区。

## 能做什么

ai 侧可用的工具（本地 agent 调用，不会写远端）：

| 工具 | 作用 |
| --- | --- |
| `mesh_status` | 本机账号状态、设备指纹、发现地址、信任表 |
| `mesh_peers` | 同账号对端：在线、连接、延迟、是否已信任 |
| `mesh_session_list` | 远端会话列表（标题、工作目录、时间、live/persisted） |
| `mesh_session_read` | 远端会话消息窗口（user / assistant / tool 调用与结果），按 `nextSeq` 翻页 |
| `mesh_session_index` | 会话紧凑索引：每条投影消息的 seq/角色/字节数与全会话总量，不含 reasoning 正文与工具参数（需对端 ≥ rc.10） |
| `mesh_session_summary` | 分页读完远端会话全部事件，返回纯文本 transcript，便于一次总结整段对话 |
| `mesh_workspace_list` | 远端工作区列表，或某个目录内容 |
| `mesh_file_read` | 远端文本文件按行读取，返回 `hasMore` |
| `mesh_peer_pair` | 显式信任一个已发现设备 |
| `mesh_peer_forget` | 撤销信任并断开 |

设置页「同账号互联」显示状态、传输方式、设备指纹、发现地址、Tailscale 探测结果与对端列表，并提供信任 / 撤销 / 重连。

## 会话数据量与传输缓存（rc.10）

- **数据总量**：`sessions/events` 响应附带 `itemCount` / `totalBytes` / `pageBytes`（整个会话，不是当前窗口）；`sessions/index` 返回紧凑索引（每条消息的 seq/时间/角色/字节），用于在不拉全文的情况下知道一个会话多大。面板把已知总量追加在会话行与工具条上。
- **对端兼容**：旧对端（< rc.10）不支持 `sessions/index` 时，面板静默降级——分页若也没带总量，就只显示会话列表，不报错、不产生 502 噪音。
- **传输缓存**：Host 侧对 `sessions/index` 与 `transcript` 分页做有界缓存（64 索引 / 512 页，LRU）。非强制刷新命中缓存时响应标记 `cached: true, bytes: 0`，不再向对端拉取；「强制刷新」按钮带 `force=1` 绕过缓存，另有 `POST /api/cache/clear`。
- **版本互通**：hello / hello-ack 握手互带插件版本（`v`），`peerViews` 暴露 `version`，面板悬停可见对端插件版本，不再出现“两边不同版却不自知”。
- **传输计数器**：每次完成的 RPC 按请求/响应字节数累计（`transferTotals()`、`peerViews[].transfer`），只做统计，不做任何门控。

## 传输方式与双版本（rc.11）

同一份 `dsh-account-mesh` 同时装入原生 DSH 与夜间巡航版，按 Host 启动环境判定版本：

- **原生 DSH**：强制 JSONL 传输，不加载 native 模块；设置页只显示 `[JSONL]`、说明和官网下载链接。`POST /api/codec` 返回 409 `edition-requires-night-cruising`。
- **夜间巡航版**：启动时若 `codec=auto` 且 `native/` 或 `@dsh/jlc` 可加载，显示 `本地到远端 巡航加速中`；用户在设置页开启但当前进程未加载时显示 `本地到远端 重启即出发`，重启后生效。关闭立即回到 JSONL。
- **版本判定**：优先 `DSH_DISTRIBUTION=night-cruising`（夜间巡航 Host 注入），再回退环境变量、可执行路径和 `$DSH_HOME/night-cruising` 标记。原生 DSH 不设置该标记。
- **设置持久化**：`$DSH_HOME/account-mesh/settings.json` 保存 `codec: auto|off`，不改写 profile。
- **站点链接**：下载/插件精选的 `label`、`url`、`hint` 来自官网同源七牛 OSS 的 `data/account-mesh.json`，由 Host `/account-mesh/api/site-links` 代取并缓存；插件内置 `site-links.json` 作为离线快照，UI 不写死链接文案。
- **状态接口**：`/api/state` 新增 `transfer` 字段；`GET /api/site-links`、`POST /api/codec` 只读/本地设置，不写对端。
- **不热加载**：开启 JLC 只写设置并要求重启；native 模块在 Host 启动时加载，避免运行中切换传输通道。

### 当前范围

rc.14 已实现 napi 绑定、传输方式状态/开关、双版本判定、设置页和站点配置，并接通 `mesh-bin` 的 JLC 块传输：`mesh_session_fetch`/`/account-mesh/api/fetch` 把整份会话拉入内存，按 manifest/block 分块校验，并把 archive 写入进程级 AES-256-GCM 加密“保险柜”（`dataDir/vault/*.ncv`，0600），关闭 DSH 清除；不写明文会话文件。原生 DSH 没有 JLC 时，`fetchJsonl` 按 `sessions/events` 每页 500 项串行拉取，返回可见进度；设置页提示用户可下载夜间巡航版加速。rc.14 同时修复了 >48 KiB RPC 文本分片重组的稀疏数组 bug（长会话挂起的根因）。当前“巡航加速中”表示 native 编解码器已加载；具体会话仍需用户触发拉取，不是所有 RPC 自动走 JLC。

### 托管保险柜（设计，未实现）

rc.13 的保险柜密钥只存在于进程内，重启后只能重拉全量。下一步把“档案只传一次、之后每次只换一把小钥匙”做成独立协议：远端 B 派生并保管根密钥，A 只存 B 能开的密文；再次打开时经已认证通道申请一代一用的开柜票据，A 解密后立即把内容密钥重新包到下一代并提交，旧开柜钥失效。B 不接收密文、不代解密、不返回明文，只对自己创建并绑定 A 设备身份的托管项放行，支持撤销、审计与“确认后放行”的严格模式。

完整设计（容器格式、两阶段提交、崩溃恢复、威胁模型、配置与验收）见：

- [`托管保险柜与本地缓存.md`](./托管保险柜与本地缓存.md)

实现前以该文为准；`vaultMode` / `vaultRelease` / `vaultPassTtlMs` 等配置尚未进入 rc.13 代码。

## 工作方式

1. **发现**：UDP 组播/广播（默认端口 `47831`）覆盖物理网段；Tailscale 不转发组播，所以同时用 `tailscale status --json` 列出 tailnet 在线设备并逐台单播探测。也可用 `staticPeers` 手动指定。
2. **握手**：参考 p2play-js —— 每个设备对生成一个房间，设备 id 字典序小的一方发 offer，SDP/ICE 以带 Ed25519 签名的分片帧直连发送。
3. **认证**：双方在数据通道上互发 nonce，签回对方的 nonce；只有签名与信任表里的公钥一致才放行。已信任设备换了公钥会重新绑定并告警。
4. **首次信任**：同账号的陌生设备**不再被自动信任**。它照常被发现并排队成一条「待确认」请求，客户端弹出**阻塞式对话框**（`document.body` portal，覆盖整个应用；Escape 与遮罩点击都不能关闭，Tab 只在两个按钮间循环，未命名 modal 作用域会挡住所有应用快捷键），用户必须选「信任这台设备」或「拒绝并撤销」。在你选择之前，该设备的信令一律被丢弃，不会建立任何通道。
   - 对话框挂在 `shell.overlay`（frame 级 list slot，`id: account-mesh.trust-request`），所以无论当前在会话、设置页还是其它面板都会出现，离开设置页也不会消失。
   - 请求列表来自 Host 的 `/account-mesh/api/state` 轮询（2.5s 节奏，只影响显示，不中止任何请求），经 `@deepseek-ai/dsh-client-store` 的快照 store 发布给 overlay host。
5. **撤销是持久的**：`forget` 不再删除条目，而是写入 `revoked: true` + `revokedAt`（`peers.json` 版本 2）。账号规则不会自动恢复被撤销的设备：后续 announce、心跳、信令都被忽略，重启后仍然撤销。只有显式 `pair`（面板「信任」按钮、`mesh_peer_pair` 工具或 `POST /account-mesh/api/pair`）能清除撤销。
   - **撤销通知**：撤销时先向对端发送一条签名 `revoke` 帧，再断开链接。对端收到后把自己的信任条目也标成 `revoked` 并断链，所以两边状态收敛。对端离线时通知丢失，但被撤销的对端每次 announce 都会收到重发的通知，重新上线后即收敛；本机重启后同样靠这条重发补上。
   - **兼容性**：旧版本对端不认识 `revoke` 帧，会忽略它并保留自己的信任条目——此时本地撤销生效、远端读取被 `not-paired` 拒绝，但远端信任表不会自动收敛。要验收「对面也不再信任我」，远端必须升级到同一版本。
6. **只读数据面**：固定 op 白名单（`sessions/list`、`sessions/events`、`workspaces/list`、`files/list`、`files/stat`、`files/read`）。没有写入、prompt、shell 或任意命令通道。

## 与本仓「去除所有超时」设计的关系

本插件按 `deepseek-harness-night-cruising` 的约定设计，不引入任何会中断在途工作的期限：

- 没有 RPC 超时、没有连接超时、没有空闲超时；读取、握手、重连都只由**用户取消（AbortSignal）**、**真实错误**或**传输状态变化**结束。
- 定时器只有周期节奏：发现广播 5s、Tailscale/静态探测 20–30s、心跳 3–5s、账号刷新 15s、重连退避最长 30s。这些不中止任何进行中的请求。
- 发现层的「在线」是存在性判定（20s 内是否收到 announce）；过期只影响列表显示，**不会**断开会话或取消在途读取。
- `tailscale status` 子进程不设命令超时；同一时刻只跑一个探测，避免堆积。
- 工具分页（`limit`/`offset`）与文件行窗口是模型可控的取数参数，语义与内置 `read` 一致，不是截断。

## 限制

- **只读**：不提供把内容写回远端的能力，也不改写远端会话日志。
- **首次信任需要人工确认**：`autoTrustSameAccount` 默认开启时，首次接触仍要用户回答阻塞对话框；`accountTag` 只能证明对方自称同账号，局域网或 tailnet 内可被冒充，所以确认步骤是必要的。关闭 `autoTrustSameAccount` 后不再排队请求，只能手动信任。
- **撤销不会自动恢复**：被撤销的设备需要用户显式重新信任；这是设计上的持久状态，不是可以靠心跳冲掉的临时标记。
- **范围**：一期只覆盖局域网与 Tailscale tailnet。跨公网需要自建信令与 STUN/TURN，未实现。
- **路径**：文件读取限制在工作区、会话工作目录与 `allowRoots` 内，`realpath` 之后校验；检查与打开之间的符号链接替换（TOCTOU）未完全消除。
- **会话投影**：不含 reasoning 原文与图片字节；图片以占位符出现。
- **未登录**：账号未登录时插件保持 idle，不建立任何通道。
- **单向可达会表现为"离线"**：WebRTC 需要双向可达。如果一台设备能收到对方的包、对方却收不到它的包（常见于 Windows 防火墙拦入站 UDP），面板会显示对端「离线」并给出最后在线时间；需要在被拦的一端放行 DSH 应用（不是只开 47831，ICE 端口是随机的）。
- **受管终端可能无法使用 WebRTC**：公司 EDR（如奇安信天擎）或强制 VPN 会拦截 ICE 的 UDP 流量，表现为「能发现、能交换信令，但连接 31 秒后 failed」。插件侧可尝试 `icePortBegin/icePortEnd` 固定端口段、`iceUdpMux`、`iceTcp`，或在 `iceServers` 配置一个 TURN 服务器（走 TCP/TLS）。受管策略无法关闭时，该环境不适合使用本插件。
- **信任表保留地址**：发现过的对端会把 `address`/`port` 记进 `peers.json`，重启后每 5 秒向该端点单播心跳；地址变化时以新 announce 为准。

## 配置

插件没有 `Config` 导出，所有字段可选，写在 profile 的 `cordis.patch.yml`：

> rc.14 新增 `deviceId` 仅用于同一台机器模拟两端测试；生产留空。`cacheMaxBytes` 是 JLC 内存缓存上限，不是模型用量门控。

```yaml
- id: account-mesh
  config:
    autoTrustSameAccount: true
    discoveryPort: 47831
    staticPeers: ['other-host:47831']
    tailscaleProbe: true
    allowRoots: []
    iceServers: []
    debug: true
    localSessionTest: false   # 测试端：无真实对端时用本机会话渲染远端工作区
    codec: auto               # auto：夜巡启用 JLC；off：都用 JSONL；原生 DSH 始终 JSONL
    distribution: auto        # auto | dsh | night-cruising（测试/强制运维用）
    siteBaseUrl: https://deepseek-harness.partyplay.top
    siteConfigPath: /data/account-mesh.json
    nativeModulePath: ''      # 可选：显式 .node 路径；否则找 @dsh/jlc / native/
    cacheMaxBytes: 268435456  # JLC 已完成会话的内存投影缓存上限（默认 256 MiB）
    vaultEnabled: true         # 加密保险柜（远端 JLC archive，退出清除）
    vaultMaxBytes: 268435456   # 保险柜密文上限（默认 256 MiB）
    deviceId: ''              # 仅测试：同机模拟两端；生产留空
    mcpPort: 47990            # 可选：开启 MCP streamable-HTTP 端点
    mcpToken: ''              # 可选：要求 Authorization: Bearer <token>
```

### MCP 端点（可选）

设置 `mcpPort` 后，插件在 `127.0.0.1:<mcpPort>/mcp` 上提供 MCP streamable-HTTP 端点（协议 `2025-06-18`），工具与 agent 工具一一对应且全部只读：`mesh_status`、`mesh_peers`、`mesh_session_list`、`mesh_session_read`、`mesh_session_summary`、`mesh_workspace_list`、`mesh_file_read`。没有写入、prompt、shell 或任意命令工具。

外部 MCP 客户端可在 profile 里用配置型 bundle 接入：

```yaml
- id: account-mesh-mcp
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    serverName: account-mesh
    transport: streamable-http
    url: http://127.0.0.1:47990/mcp
```

接入后可用 `mcp__account-mesh__mesh_session_summary` 按会话 id 读取远端会话全文并总结。

状态与信任表保存在 `$DSH_HOME/account-mesh/`（`peers.json`、`identity.json`、`settings.json`、`mesh.log`，权限 0600）。`settings.json` 只保存 JLC 开关意图，不保存令牌或会话内容。

## 托管保险柜（rc.15）

- `vaultMode: hosted` 默认：A 侧在用户选择的本地根目录保存 `<workspace相对路径>/<hash>.hdr` + `.dat`；B 侧只保存 `root.key` + `ledger.json`，按次发放代次钥匙。
- NCV2：`.dat` 用随机 DEK 加密 archive + 投影 sidecar；`.hdr` 只保存 DEK 的 `K_g` 包裹、depositId、代次、archiveSha。换钥只重写 `.hdr`。
- `sessions/export/prepare` 首次下发 `depositId/K_0`；再次打开走 `vault/open` 取 K_g/K_{g+1} → 本地重包 `.hdr` → `vault/commit`；失败回退完整 JLC。
- 本机（A）决定远端数据目录：`vault/host/root` 校验可写；默认目录失败/不可写时产生带倒计时的待确认项（`vault.approvalTimeout`），到期自动拒绝；`vault/host/open` 直接打开目录；`vault/host/delete` 删除内容后才允许更换目录。
- 本机作为远端（B）可撤销某设备托管（`vault/revoke`），A 下次打开删除本地容器；B 的账本/根密钥保留。过期票据不会触发删除，容器留在本地。
- 底栏“托管保险柜”入口在设置面板显示两个 scope：`远端在本机的托管`（目录/删除/待确认）和 `本机托管到远端的策略`（撤销/释放策略/钥匙 TTL 跳转超时设置）。`vault.approvalTimeout`、`vault.keyTtl` 在夜间巡航底栏“超时设置”中。
- 当前 P1 使用已认证 DTLS/Ed25519 RPC 通道直接投递钥匙票据；设计中的额外 X25519 链路包裹尚未实现。`vaultRelease: confirm` 暂只返回拒绝，确认 UI 未实现。
- `.dat` 成员当前为 archive + projection；未来电台/游戏可使用同对象格式的额外成员，设计见 `docs/托管保险柜与本地缓存.md` §17。
