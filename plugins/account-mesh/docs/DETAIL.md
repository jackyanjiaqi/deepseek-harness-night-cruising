# 同账号互联（account mesh）

两个 **登录同一 DeepSeek 账号** 的 DSH 实例，在局域网（含 Tailscale 组网）内互相发现，用 Ed25519 身份认证做握手，然后用 WebRTC 数据通道传输，允许各自的 agent **只读**访问对方的会话与工作区。

## 能做什么

ai 侧可用的工具（本地 agent 调用，不会写远端）：

| 工具 | 作用 |
| --- | --- |
| `mesh_status` | 本机账号状态、设备指纹、发现地址、信任表 |
| `mesh_peers` | 同账号对端：在线、连接、延迟、是否已信任 |
| `mesh_session_list` | 远端会话列表（标题、工作目录、时间、live/persisted） |
| `mesh_session_read` | 远端会话消息窗口（user / assistant / tool 调用与结果），按 `nextSeq` 翻页 |
| `mesh_workspace_list` | 远端工作区列表，或某个目录内容 |
| `mesh_file_read` | 远端文本文件按行读取，返回 `hasMore` |
| `mesh_peer_pair` | 显式信任一个已发现设备 |
| `mesh_peer_forget` | 撤销信任并断开 |

设置页「同账号互联」显示状态、设备指纹、发现地址、Tailscale 探测结果与对端列表，并提供信任 / 撤销 / 重连。

## 工作方式

1. **发现**：UDP 组播/广播（默认端口 `47831`）覆盖物理网段；Tailscale 不转发组播，所以同时用 `tailscale status --json` 列出 tailnet 在线设备并逐台单播探测。也可用 `staticPeers` 手动指定。
2. **握手**：参考 p2play-js —— 每个设备对生成一个房间，设备 id 字典序小的一方发 offer，SDP/ICE 以带 Ed25519 签名的分片帧直连发送。
3. **认证**：双方在数据通道上互发 nonce，签回对方的 nonce；只有签名与信任表里的公钥一致才放行。默认同账号自动信任，公钥变化会重新绑定并告警。
4. **只读数据面**：固定 op 白名单（`sessions/list`、`sessions/events`、`workspaces/list`、`files/list`、`files/stat`、`files/read`）。没有写入、prompt、shell 或任意命令通道。

## 与本仓「去除所有超时」设计的关系

本插件按 `deepseek-harness-night-cruising` 的约定设计，不引入任何会中断在途工作的期限：

- 没有 RPC 超时、没有连接超时、没有空闲超时；读取、握手、重连都只由**用户取消（AbortSignal）**、**真实错误**或**传输状态变化**结束。
- 定时器只有周期节奏：发现广播 5s、Tailscale/静态探测 20–30s、心跳 3–5s、账号刷新 15s、重连退避最长 30s。这些不中止任何进行中的请求。
- 发现层的「在线」是存在性判定（20s 内是否收到 announce）；过期只影响列表显示，**不会**断开会话或取消在途读取。
- `tailscale status` 子进程不设命令超时；同一时刻只跑一个探测，避免堆积。
- 工具分页（`limit`/`offset`）与文件行窗口是模型可控的取数参数，语义与内置 `read` 一致，不是截断。

## 限制

- **只读**：不提供把内容写回远端的能力，也不改写远端会话日志。
- **自动信任的风险**：`autoTrustSameAccount` 默认开启。`accountTag` 只能证明对方自称同账号，局域网或 tailnet 内可被冒充；确认风险后再保留默认值，或关闭它改用面板手动信任。
- **范围**：一期只覆盖局域网与 Tailscale tailnet。跨公网需要自建信令与 STUN/TURN，未实现。
- **路径**：文件读取限制在工作区、会话工作目录与 `allowRoots` 内，`realpath` 之后校验；检查与打开之间的符号链接替换（TOCTOU）未完全消除。
- **会话投影**：不含 reasoning 原文与图片字节；图片以占位符出现。
- **未登录**：账号未登录时插件保持 idle，不建立任何通道。
- **单向可达会表现为"离线"**：WebRTC 需要双向可达。如果一台设备能收到对方的包、对方却收不到它的包（常见于 Windows 防火墙拦入站 UDP），面板会显示对端「离线」并给出最后在线时间；需要在被拦的一端放行 DSH 应用（不是只开 47831，ICE 端口是随机的）。
- **信任表保留地址**：发现过的对端会把 `address`/`port` 记进 `peers.json`，重启后每 5 秒向该端点单播心跳；地址变化时以新 announce 为准。

## 配置

插件没有 `Config` 导出，所有字段可选，写在 profile 的 `cordis.patch.yml`：

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
```

状态与信任表保存在 `$DSH_HOME/account-mesh/`（`peers.json`、`identity.json`、`mesh.log`，权限 0600）。
