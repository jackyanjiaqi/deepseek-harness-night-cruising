# D · 现有机制现状（供设计文档直接引用）

> 调研：2026-11-28，只读（未改仓库现有文件）；基准 `dsh-account-mesh@0.1.0-rc.15`（`plugins/account-mesh/package.json:3`），补丁集 `patches/deepseek-harness/0.2.2-rc.5`（旧 19 补丁在 `-deprecated`）；路径相对仓库根、行号按当前工作树；同目录 B/C 是外部调研，本文只写仓库现状。

## 现状摘要

- 已有：同账号设备发现 → 签名信令 → WebRTC(DTLS) → Ed25519 双向认证 → **设备级信任表** → 只读 RPC；托管保险柜 P1（NCV2、按代发钥匙、两阶段提交）；底栏"超时 / 托管保险柜"两个入口。
- 账号侧只有内部 `userId` 派生的 `accountTag`：只做发现过滤与展示，**不参与授权**；没有邮箱/手机号、主/子账号、账号网域结构（全仓未找到）。
- 信任粒度=设备（`deviceId`+公钥）；首次接触要本机阻塞对话框确认、撤销持久且双端收敛；**没有**"强通知到手机/其它终端"的通道，也没有账号级信任。
- 保险柜钥匙发给**对方设备**（ledger `peer`=A 的 `deviceId`），不是账号；换设备=新 deposit、旧容器失联；同安装换账号后旧对端不可发现，但 trust/ledger 留在 `$DSH_HOME`、不随账号清理。
- 缺：radio/game 插件与页面、房间/邀请/门票/访客准入、手机信任终端、`vaultRelease=confirm` 审批 UI；保险柜 §17 只预留 `kind` 位，电台方案 06 未引用它。

## 机制清单

| 能力 | 实现位置（文件:行） | 当前粒度 | 可复用性 |
| --- | --- | --- | --- |
| 账号身份读取 | `plugins/account-mesh/src/account.js:40-81` | 账号 | 可复用；字段需扩展 |
| 账号标签 accountTag | `plugins/account-mesh/src/identity.js:14-18` | 账号（哈希） | 可复用；只能表达"一个账号" |
| 设备身份 Ed25519 | `plugins/account-mesh/src/identity.js:49-77` | 设备 | 可复用 |
| 发现 announce / 准入 | `plugins/account-mesh/src/discovery.js:192-206,369-393` | 设备（同账号过滤） | 可复用；无签名、tag 缺省不丢 |
| 信令帧 offer/answer/ice/revoke | `plugins/account-mesh/src/signaling.js:19-22,38-62,101-106` | 设备对 | 可复用；加新 kind 成本低 |
| hello/hello-ack 互认证 | `plugins/account-mesh/src/mesh.js:358-375,563-605` | 设备 | 可复用；无 caps/xpk |
| 信任表 peers.json v2 | `plugins/account-mesh/src/trust.js:16-135` | 设备 | 可复用；需加 subject/状态 |
| 首次接触待确认 | `plugins/account-mesh/src/mesh.js:250-266` + `client.js:1388-1497` | 设备 | 可复用；仅本机可答 |
| 显式信任 / 持久撤销 | `plugins/account-mesh/src/mesh.js:961-994`、`src/tools.js:290-338`、`src/routes.js:236-271` | 设备 | 可复用 |
| 只读数据面 | `plugins/account-mesh/src/data.js:249-272`、`src/mesh.js:608-638` | 会话/工作区 | 只读，不承载授权 |
| JLC 块传输 sessions/export/* | `plugins/account-mesh/src/transfer.js:171-238` | 会话 | 可复用 |
| 托管容器 NCV2 | `plugins/account-mesh/src/vault2.js:27-34,346-426` | 设备×会话 | 可复用；有 kind/objectId/variant 位 |
| 开柜票据 vault/open、commit、status | `plugins/account-mesh/src/vault2.js:470-554` | 设备 | 可复用；需加 purpose/subject |
| 托管策略与 TTL | `plugins/account-mesh/src/vault2.js:156-165,592-617` | 本机（B） | 可复用 |
| 托管 HTTP 面 | `plugins/account-mesh/src/routes.js:137-197` | 本机 | 可复用 |
| 底栏托管面板 | `patches/deepseek-harness/0.2.2-rc.5/002-night-cruising-ui.patch:49-90,695-701,1043-1050` | 本机 | 可复用（HTML/vanilla TS） |
| 底栏计时行 | `patches/deepseek-harness/0.2.2-rc.5/003-timeout-policy.patch:160-168` | 本机 | 可复用；`bottom-settings.mjs` 未同步 |
| 电台/小游戏 | **未实现**（`docs/sdd/02_P2P实时电台.md`、`docs/sdd/06_P2P网络与连接服务技术方案.md` 仅需求/设计） | — | 设计可参考，无代码 |
| 子账号/手机信任 | **未实现**（仅 `docs/daily/20261127/子账号与手机信任终端.md:1-45` 需求笔记） | — | 需求素材 |

## 1. 账号体系

- 唯一入口 `readAccount()`（`src/account.js:40-81`）：`ctx.get('deepseekAccount')` → `getPlatformSession()`（:45，内部含 `{origin, token, userId}`，token 设计上不外传）→ `getDeviceIdentity()`（:51，`{deviceId, userId, osVersion}`）；userId 缺失时最多每 60s 一次 `getProfile` 兜底（:27-37,55-65）。返回 `{status, userId, deviceId, accountTag, origin}`（:74-80）。
- 账号表示：`accountTag = base64url(sha256("dsh-mesh/v1:"+userId)).slice(0,22)`（`src/identity.js:15-18`）；`/api/state` 只暴露前 6 位（`src/mesh.js:861-864`），测试断言 state 不泄露 userId/token（`spike/p0-apply.mjs:209`）。
- mesh 的 `deviceId` = 平台设备 id，缺失退回 `local-<digest(公钥,12)>`（`src/mesh.js:171`）；`identity.json` 只存 Ed25519 密钥对（`src/identity.js:59-67`），不含账号。**邮箱/手机号字段全仓未找到。**
- 账号只决定"能否看见对方"：discovery 按 tag 过滤（`src/discovery.js:369-374`），room 名含 tag（`src/signaling.js:19-22`）；能否读只看设备信任（`src/mesh.js:282,395-401,615-618`）。
- 未找到：主/子账号层级、账号→设备成员表、账号级吊销、账号网域对象。`otherAccounts` 只是丢弃计数（`src/discovery.js:372`、`src/mesh.js:876`）。
- 未确认（重要）：`getDeviceIdentity().deviceId` 是否跨账号稳定。本仓无定义；DSH 构建树 `.build/patch-work-0.2.2-rc.5/packages/credentials/deepseek-account/src/index.ts:35-37,737-738` 显示它是首次登录写入 credentials 的随机 UUID 并复用 → 同一安装换账号 deviceId 不变。此为构建树旁证，升级 DSH 需复核。

## 2. mesh 受信

### 2.1 真实协议名与字段

- 产品/协议：`PRODUCT='dsh-account-mesh'`、`PROTOCOL_VERSION=1`（`src/util.js:5-6`）。
- UDP 发现（默认 47831）：`{v,t:'announce',product,tag,dev,name,port,addrs[],pk,ver}`（`src/discovery.js:192-206`）；`query` 同构（:249-250）。
- 信令：`{v,t:'sig',product,room,from,kind,id,frag,total,data,sig}`，签名覆盖 `room|kind|from|id|frag|sha256(data)`（`src/signaling.js:30-62`）；kind ∈ offer/answer/ice/revoke（:101-106；`src/mesh.js:382,409-411,445`）。
- `room = base64url(sha256("dsh-mesh/v1:room:"+accountTag+":"+a+":"+b)).slice(0,24)`（`src/signaling.js:19-22`）。
- 通道：WebRTC datachannel（node-datachannel）；`hello` 参数 `nonce/dev/name/v/pk/sig`，签名上下文 `dsh-account-mesh/v1/hello`，双向互验后 `markVerified`（`src/mesh.js:26,358-375,563-605`）。
- RPC：`{id,op,params}` → `{id,ok,result|err}`；op 白名单 = `sessions/list|events|index`、`workspaces/list`、`files/list|stat|read`、`summary`（`src/mesh.js:621-638`、`src/data.js:249-272`）+ `sessions/export/prepare|block|cancel`（`src/transfer.js`）+ `vault/open|commit|status`（`src/mesh.js:624-626`）。未授信一律 `not-paired`（:615-618），未认证 `not-verified`（:611-614）。
- Agent 工具 11 个（`spike/p0-apply.mjs:126`；`src/tools.js`）：`mesh_status`、`mesh_peers`、`mesh_session_list`、`mesh_session_fetch`、`mesh_session_summary`、`mesh_session_read`、`mesh_session_index`、`mesh_workspace_list`、`mesh_file_read`、`mesh_peer_pair`、`mesh_peer_forget`；可选 MCP 端点暴露其中 7 个只读工具（`src/mcp.js`、`docs/DETAIL.md:124-139`）。

### 2.2 受信流程（行号）

1. 发现：LAN 组播/广播 + tailnet 单播；信任表记住地址后周期单播（`src/discovery.js:145-150`、`src/mesh.js:193`）。
2. 信令直连：`sendSignal`（`src/mesh.js:512-532`）；字典序小的一方发 offer（:275-277）。
3. 通道 open → 双方 `hello`（:326-333,358-375）。
4. `markVerified` 校验信任表公钥与通道公钥一致（:592-605）。
5. 首次接触：`refreshPendingTrust` 入**内存** `pendingTrust`（:115,250-266）→ 客户端 2.5s 轮询 `/api/state` 的 `pendingTrust`（`client.js:1989-2020`）→ `shell.overlay` 阻塞对话框（`client.js:1388-1497`，portal/aria-modal/data-shortcut-modal）→ `POST /account-mesh/api/trust-request {deviceId, decision: trust|refuse}`（`src/routes.js:236-249`）。
6. 撤销：`forget()` → `trust.revoke()` 保留条目写 `revoked/revokedAt` → **先发签名 `revoke` 再断链**（`src/mesh.js:980-994`）；对端 `onRevokeNotice` 同样标记并断链（:420-436）；被撤销对端每次 announce 都重发通知（:238）→ 双端收敛。

### 2.3 信任模型：现在是哪一种

| 需求里的写法 | 出处 | 现状 |
| --- | --- | --- |
| 首次连接默认受信、之后可撤销 | `docs/daily/20261127/子账号与手机信任终端.md:19` | **已不再**；rc.13 曾如此（`docs/daily/20261127/account-mesh信任交互修复.md:6-23,108-110`） |
| 首次不受信、需强通知受信 | 同文件:21 | **未实现**（无跨设备通知/推送通道） |
| 当前实现（第三种） | `plugins/account-mesh/docs/DETAIL.md:63-67` | 首次不受信 + **本机**阻塞对话框人工确认；`autoTrustSameAccount:true` 只决定"是否排队请求"（`src/mesh.js:250-266`），为 `false` 时信令直接丢弃（:395-400） |

- 粒度=**设备**：信任以 `deviceId` 为键（`src/trust.js:69-88`），`isTrusted` 只看条目存在且 `revoked!==true`，**不校验 accountTag**（:58-62）；`accountTag` 仅作字段记录（:77）。工具/面板的 pair/forget 入参都是 device id（`src/mesh.js:961-994`、`src/tools.js:290-338`）。
- "同账号"判定 = `accountTag` 相等，且是**自报**：announce 帧无签名（`src/discovery.js:192-206`），过滤只在 `frame.tag` 为字符串时生效（:371-374）——不带 tag 的 announce 不会被拒；真正的闸门是人工确认（`docs/DETAIL.md:84`）。
- 公钥变更：已信任且未撤销 → 自动 rebound（`src/mesh.js:217-231`）；撤销条目永不 rebound。
- 未找到：账号级信任、设备分组、信任委托、"同账号免确认"、任何推送/强通知（`pendingTrust` 只是本机内存列表）。

## 3. 托管保险柜（hosted vault）

角色：A=观看方（存密文、发起开柜）；B=托管方（存根密钥、发钥匙）（`docs/托管保险柜与本地缓存.md:35-46`；`src/vault2.js:1-18`）。

### 3.1 文件在哪（代码为准）

| 侧 | 文件 | 位置 |
| --- | --- | --- |
| B | `root.key`(32B)、`ledger.json`、`host-settings.json`、`index.json` | `$DSH_HOME/account-mesh/hosted-vault/`（`src/vault2.js:88-95`；dataDir 见 `src/mesh.js:86`） |
| A | `index.json` + `<hash>.hdr/.dat` | A 选定的 root；默认 `<cwd>/.night-cruising/vault/<peerId 前 24>`（`src/vault2.js:64-66,184-200`），文件在 `root/<cwd 尾 3 段>/<hash>.hdr` 与 `.dat`（:73-77,346-355） |

> 设计稿写 `$DSH_HOME/account-mesh/vault/...`（`docs/托管保险柜与本地缓存.md:178-195`），与实现不一致；以实现与 `docs/daily/20261127/托管保险柜实现与验收.md:17-24,39-45` 为准。

### 3.2 容器与密钥链

- `root_B` 随机 32B（`src/vault2.js:125-135`）；`K_g = HKDF-SHA256(root_B, salt=depositId, info="dsh-mesh/vault/v2/K|"+peerDeviceId+"|"+archiveSha+"|"+g)`（:465-467）。
- `.dat`：随机 `DEK` 加密 archive + projection sidecar；布局 `NCV2D`+ver+u32 archiveLen+archiveBox+u32 projLen+projBox（:331-343,364-370,439-453）。
- `.hdr`：**实现是 JSON 文本** `{magic:'NCV2',version:2,gen,kind,variant,priority,depositId,archiveSha,wrap:base64,createdAt}`（:377-391），换钥只重写它（:413-426）；设计稿 §6.1 的二进制 120B 头未按实现落地（doc:141-151）。
- `K_g/DEK` 只在内存，A 的静态数据只有 `wrap_g(DEK)`（doc:48,§5.2）；`vaultMaxBytes` 只传给旧 session 模式 `EncryptedVault`（`src/mesh.js:101-103`），**HostedVault 未做容量 LRU**（`src/vault2.js` 无 maxBytes 逻辑）。

### 3.3 协议与票据字段（真实 op）

| op | 方向 | 入参 | 返回 | 代码 |
| --- | --- | --- | --- | --- |
| `sessions/export/prepare` | A→B | sessionId,priority | manifest/header + `vault{depositId,gen:0,key(K_0),archiveSha,expiresAt,sessionCwd}` | `src/transfer.js:171-214`；`src/vault2.js:470-509` |
| `vault/open` | A→B | depositId,gen,challenge,archiveSha,priority,kind,objectId,variant | `{ok,gen,nextGen,key,nextKey,expiresAt,challenge,fresh,fingerprint,sig,payload}` | `src/mesh.js:624`；`src/vault2.js:512-554` |
| `vault/commit` | A→B | depositId,gen | `{ok,gen}` | `src/vault2.js:556-567` |
| `vault/status` | A→B | — | **实现返回 hostState**（roots/pending/ownerPeers/policy） | `src/mesh.js:626`；`src/vault2.js:619-642` |

- 校验顺序：账本存在且未 superseded → `entry.peer===peerId` → 未 revoked → archiveSha/variant/kind 一致 → `gen ∈ {confirmedGen,issuedGen}` → policy（auto 放行 / deny / confirm）（`src/vault2.js:514-524`）。
- `sig = Ed25519_B(payload)`，payload 绑定 `depositId,gen,nextGen,archiveSha,kind,variant,challenge,expiresAt,fresh`（:550-552）；A 用**信任表里的对端公钥**验签（`src/mesh.js:722-723`）并校验 `expiresAt`（`src/transfer.js:274-276`）。
- 实现与设计差异（写设计文档时要留意）：A 端**未见** `ack.challenge` 与本地 challenge 的比对（`src/transfer.js:257-277`、`src/mesh.js:712-729`）；`vault/status` 插件内无调用方（grep 仅 `src/mesh.js:626`），且返回 B 的本地 root 路径，设计要求的聚合计数形态（doc:460-464）未实现。
- 无能力协商：`hello` 不带 `caps`，`prepare` 只要 B 有 hostedVault 就 `hostPrepare`（`src/transfer.js:179-196`）→ 旧版 A 走 JLC 拉取时也会在 B 侧留下账本条目，靠老化清理。设计 §12.1 的 `caps:["vault2"]`/`xpk` 全仓 grep 为空。

### 3.4 钥匙投递给谁（重点）

- 通道：既有 **WebRTC DTLS + Ed25519 双向认证 RPC** 直接投递；无额外 X25519 链路包裹（`docs/DETAIL.md:151`；doc:615）。
- **发给设备，不是账号**，三条证据：① prepare 时 `peerId = entry.peer.deviceId` 写入账本 `peer`（`src/transfer.js:180-192`；`src/vault2.js:479-497`）；② `vault/open` 校验 `entry.peer !== peerId` 即 `peer-mismatch`（`src/vault2.js:516`，peerId 来自已认证链路的 `entry.peer.deviceId`，`src/mesh.js:624`）；③ 账本无任何 `accountTag/userId` 字段（`src/vault2.js:479-497`）。
- 换设备：A 的容器索引键含 `peerId`（`hash(peer + kind + objectId + variant)`，`src/vault2.js:352-353,392-407`），新 B 的 deviceId 不同 → 查不到容器 → 完整 JLC + 新 `depositId`（`src/transfer.js:330-404`）；B 侧旧账本按 `vaultRetentionDays` 老化（`src/vault2.js:146-150`）。
- 同一台 B 重装（新公钥、deviceId 不变）：信任表自动 rebound（`src/mesh.js:217-231`），账本只绑 deviceId → **旧托管项仍可开**。这是"钥匙绑设备 id 而非公钥"的直接后果。
- 换账号（同一安装）：deviceId 不变、accountTag 变 → `refreshAccount` 重启 discovery（`src/mesh.js:163-181`），discovery 丢弃 tag 不匹配的 announce（`src/discovery.js:371-374`）→ 旧对端全部不可发现；但 `peers.json`/`hosted-vault/` 在 `$DSH_HOME` 下不随账号清理，**换回原账号即恢复信任与开柜、无需重新确认**（isTrusted 不看 accountTag，`src/trust.js:58-62`）。
- 同账号另一台设备 C 拷走 A 的容器：C 用自己 deviceId 申请 → B 返回 `peer-mismatch`，C 侧删除本地拷贝并回退完整拉取（`src/transfer.js:302-307`），容器即使被拷贝也打不开（doc §3 T2:54-56）。

### 3.5 撤销、TTL、清理

| 项 | 实现 |
| --- | --- |
| 撤销 | B 本地 `POST /account-mesh/api/vault/revoke {peer}`（`src/routes.js:189-194`）→ 该 peer 全部账本条目 `revoked=true`（`src/vault2.js:569-577`）；A 下次 open 收 `revoked` → 删本地容器+完整 JLC（`src/transfer.js:302-307`） |
| 钥匙 TTL | `vault.keyTtl`（底栏超时设置，默认 600s；`003-timeout-policy.patch:165`），读取优先级 footer > settings.owner > config（`src/vault2.js:592-600`）；过期只拒绝本次开柜、不删容器（`docs/DETAIL.md:149`；doc:610） |
| 目录审批倒计时 | `vault.approvalTimeout`（默认 60s，`003-timeout-policy.patch:164`）；默认目录不可写→pending（`src/vault2.js:184-228`）→ 到期 `denied/deniedReason=timeout`（:137-145,283-294） |
| 删除条件 | 只有 `revoked/unknown/peer-mismatch/archive-mismatch/kind-mismatch/gen-mismatch/bad-signature/denied` 才删容器（`src/transfer.js:304-306`）；`confirmation-required`/离线/过期保留 |
| 保留期 | `vaultRetentionDays` 默认 30 天（`src/mesh.js:74`；`src/vault2.js:146-150`） |
| `vaultRelease=confirm` | 后端直接返回 `{error:'confirmation-required'}`（`src/vault2.js:524`）；审批 UI 与 `/api/vault/pending` 路由**未实现**（`src/routes.js:137-197` 无 pending 路由；设计 §7.7 只在纸上） |
| 审计 `releases.json` | **未实现**（doc:188-195 设计；`src/vault2.js` 无此文件） |

## 4. 电台与小游戏

- 实现状态：**没有** radio/game 插件或运行时代码。`plugins/` 只有 `account-mesh/` 与 `doc-server/`；`site/` 只有 index/downloads/plugins 三页（无 `radio.html`）；电台/游戏只存在于 `docs/sdd/` 的需求与设计文本。
- 需求 `docs/sdd/02_P2P实时电台.md:3-31`：主播开房/目标机器呼入接听（:7）、预告 + **手机号预约**上报主播（:9）、静音听众/抢麦/读秒（:11-13）、聊天板（:15）、ASR 知识库（:17-19）、DJ 歌单（:29-31）。
- `docs/sdd/03_会话橱窗&算力租赁.md:1-17` 通读：只有匿名登录、橱窗发帖/留言、算力租赁；**未提及**房间/邀请/门票/限时访问（用户问题里的"观众接入"只在 02/06 有）。
- 技术方案 `docs/sdd/06_P2P网络与连接服务技术方案.md`（2135 行，中心化 OSS+ECS 方案，**不是** mesh 内网）：
  - 角色：主播/listener/**guest**/hub/board（:122-129）；`node_id` 由公钥哈希（:285-292）；多端靠二维码/一次性码绑定（:292）。
  - 房间状态机 `scheduled → live → ended`（另有 private/public）（:348-360）；租约 `{room_id,anchor_id,edge_id,epoch,state,expires_at,seq,route{privacy...}}`，TTL 30s（:366-380）。
  - **邀请/准入**：一次性 `invite_token`（10 分钟，绑定房间/主播/用途），呼入 `call.incoming/accepted/rejected`，接听后 `scheduled/private → live/public`（:848-853）；WSS `call.invite` 参数 `room_id,invite_token,ttl`（:1635-1636）。
  - 可见性：`信任域 public/share/rent`（:1857）、`public（电台）` 权限表（:1397）。
  - 布告板对象 `data/radio/v1/*`、`archive/{date}/...`、`events/...ndjson.gz`（:437-445）；页面 `site/radio.html`（:1521,1537）。
- 保险柜 §17 的复用位：对象键 `(peerDeviceId, kind, objectId, variant)`，`kind ∈ session|radio|game`，协议泛化为 `depositId,gen,challenge,contentHash,kind,objectIdHash,variant`（`plugins/account-mesh/docs/托管保险柜与本地缓存.md:545-592`）；代码已把 `kind/objectId/variant` 贯穿 index/ledger/hostPrepare/hostOpen（`src/vault2.js:309-407,470-554`），但只注册 `session`（`src/transfer.js:186-188,391-393`）。
- **交叉缺口**：06 全文未引用托管保险柜/NCV2，也未引用 account-mesh 信任表；"门票/访客"在 06 里只是 WSS+hub 设计，无代码、无同账号网域接入方式。

## 5. 底栏设置面

- 两块东西：①"超时设置"运行时目录在 `003-timeout-policy.patch`，其中 `vault` 组在 :160-168（`night-timeouts.ts` 形式）；②"托管保险柜"面板在 `002-night-cruising-ui.patch:49-90`（`#night-vault` section + `#night-vault-toggle` 按钮），元素引用 :695-701，`VaultHostState/VaultRoot/VaultPending` 类型 :1043-1050，加载/渲染 :1095-1230；入口默认隐藏，`GET /account-mesh/api/vault/host` 成功才显示（:1095-1110）。
- 面板两个 scope：远端在本机的托管（目录/删除/待确认倒计时）+ 本机托管到远端的策略（撤销/release/保留期），数据来自 `hostState()`（`src/vault2.js:619-642`）。
- 插件内 React 设置页：4 个 slot（`settings.section` order 17、`sidebar.panellist`、`main`、`shell.overlay` `id: account-mesh.trust-request`，`client.js:2034-2068`）；卡片顺序 传输→保险柜→通道→对端（`client.js:1262-1270`）。
- 本地 HTTP 路由（同源、`/account-mesh` 前缀，`src/routes.js`）：`GET /api/state`(:36)、`/api/tree`(:75)、`/api/sessions/index`(:78)、`/api/transcript`(:97)、`/api/transfer/dialog`(:132)、`/api/channels`(:203)、`/api/local-test`(:224)、`/api/site-links`(:45)、`/api/vault/host`(:137)；`POST /api/fetch`(:118)、`/api/codec`(:61)、`/api/probe`(:206)、`/api/refresh-network`(:217)、`/api/local-test`(:227)、`/api/cache/clear`(:199)、`/api/vault/host/root`(:140)、`host/open`(:152)、`host/deny`(:162)、`host/delete`(:169)、`host/policy`(:176)、`/api/vault/revoke`(:189)、`/api/vault/clear`(:195)、`/api/trust-request`(:236)、`/api/pair`(:251)、`/api/forget`(:259)、`/api/reconnect`(:266)。
- 文档漂移（设计时要顺手修）：`bottom-settings.mjs:56-150` 的文档目录**没有 vault 组**（运行时有）；`plugins/account-mesh/README.zh.md:23` 仍写"托管保险柜已设计但尚未实现"（实际 rc.15 已实现，`docs/DETAIL.md:143-152`）。
- 加设置项的路径：计时类只改 `night-timeouts.ts`（003 补丁）+ `bottom-settings.mjs`（文档）；面板类需改 002 补丁的 HTML+vanilla TS，并在 `src/routes.js` 加同名 HTTP 路由（现有模式）。

## 6. 若要加"子账号 + 门票 + 手机钥匙"：最小的 5 个改动点

1. `plugins/account-mesh/src/account.js:40-81` + `src/identity.js:14-18` —— **账号事实与网域标签的唯一来源**。当前返回只有 `status/userId/deviceId/accountTag/origin`；主/子账号、手机号绑定、域标签都应在这里扩展，并把 `accountTagOf` 从"单账号哈希"升级为"主账号域+子账号角色"的域标签。下游 discovery/trust/vault 全部从这里取值，可保持旧字段兼容。
2. `plugins/account-mesh/src/discovery.js:192-206,369-393` + `src/mesh.js:163-181,250-266` —— **同账号准入判定点**。announce 目前只带一个自报 `tag`（无签名、缺省不丢）；"a 机 b 机 phone 同域"应落成域标签集合/角色字段，并在 mesh 候选过滤处加"子账号是否属于主账号域"的判定。这是唯一决定"能否看见对方"的地方。
3. `plugins/account-mesh/src/trust.js:69-118` + `src/mesh.js:250-266,961-994`（+`client.js:1989-2032`）—— **受信状态机**。当前条目字段固定、状态只有 trusted/revoked、`pendingTrust` 是内存 Map；"待手机强通知批准/代批准"需要持久化 pending、加 `subject/approvedBy/approvedFrom`，并允许非本机可信设备回答（现在只有本机 `POST /api/trust-request`）。
4. `plugins/account-mesh/src/vault2.js:470-509,512-554,592-600`（+`src/transfer.js:253-309`）—— **门票签发**。`hostPrepare` 已生成 `depositId`、`hostOpen` 已按 `confirmedGen/issuedGen` 发 `K_g/K_{g+1}`、`ownerPolicy` 已有 `keyTtlMs`；"门票=限时+限定对象+限定访客"的最小实现是账本条目加 `purpose/expiresAt/subject` 并在 `hostOpen` 校验，不需要新协议栈。
5. `plugins/account-mesh/src/signaling.js:101-106` + `src/mesh.js:377-412`（配合 `src/mesh.js:358-375` 的 hello）—— **跨设备强通知/授权消息载体**。现有签名信号只有 offer/answer/ice/revoke；`revoke` 已证明"新增一个签名 kind + 一个分支"成本很低，手机作为通知/授权中心需要这类帧把"待批准"送到另一台可信设备（或新增一个 RPC op）。

> 配套但非最小语义改动：底栏入口/面板（`002-night-cruising-ui.patch:49-90`）、计时行（`003-timeout-policy.patch:160-168`）与 `bottom-settings.mjs:56-150` 的文档同步；以及 `docs/DETAIL.md`、`docs/托管保险柜与本地缓存.md` 的状态回写。
