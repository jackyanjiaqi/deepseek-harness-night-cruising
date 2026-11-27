# dsh-account-mesh

[English](README.md) | 中文

在登录**同一个 DeepSeek 账号**的 DSH 实例之间建立只读互联，通过局域网（物理局域网 + Tailscale tailnet）上经过认证的 WebRTC 数据通道传输。

- **发现**：UDP 组播/广播，加上对 tailnet 对端的单播探测（`tailscale status --json`），因为组播不跨 Tailscale。
- **握手**：p2play-js 风格的房间 / 确定性发起方 / 在同一 UDP socket 上发送带签名的 `offer`/`answer`/`ice` 分片。
- **认证**：数据通道上的 Ed25519 nonce 挑战，绑定本地信任表。
- **信任**：首次接触的对端会在阻塞式对话框中等待用户回答（信任或拒绝）；撤销是持久的（`peers.json` 中的 `revoked`），只有显式配对才能清除，因此 announce/心跳流量永远无法把用户拒绝过的设备重新信任。
- **数据面**：只读白名单 —— 会话列表/读取、工作区列表、文件列表/状态/读取。不存在写入、prompt、shell 或任意命令通道。
- **信任请求**：`mesh_peer_pair` 回答一条待确认请求；`mesh_peer_forget` 执行持久撤销，并发送一条带签名的 `revoke` 通知，让同版本对端也撤销本设备。阻塞式对话框位于 frame 级 `shell.overlay` 槽位（`id: account-mesh.trust-request`），并通过 `POST /account-mesh/api/trust-request` 提交 `{deviceId, decision: "trust" | "refuse"}`。
- **传输**：原生 DSH 默认 JSONL；夜间巡航版可在重启后启用可选的 JLC 编解码器。设置页与站点提供的下载/精选链接位于 `transfer` 状态中。

完整能力说明与限制见 [docs/DETAIL.md](docs/DETAIL.md)。

## Agent 工具

`mesh_status`、`mesh_peers`、`mesh_session_list`、`mesh_session_read`、`mesh_session_summary`、`mesh_session_fetch`、`mesh_workspace_list`、`mesh_file_read`、`mesh_peer_pair`、`mesh_peer_forget`。

`mesh_session_fetch` 通过 JLC 二进制块通道把整份会话拉入本地内存，并返回投影后的 transcript。JLC 档案可能缓存在加密的、进程生命周期的**保险柜**中（`vault/*.ncv`，AES-256-GCM，0600）；它不是用户可见的文件存储，DSH 退出时清除。

跨重启的**托管保险柜**已设计但尚未实现：密文留在本机，开柜密钥仍由远端对端派生并按次发放，每开一次前进一代。见 [docs/托管保险柜与本地缓存.md](docs/托管保险柜与本地缓存.md)。

`mesh_session_summary` 分页读完整个远端会话，把 transcript 作为纯文本返回，便于 agent 一次总结一段远端对话。

## MCP 端点（可选）

在插件配置里设置 `mcpPort`，即可通过 MCP streamable-HTTP 传输把同样的只读操作暴露给外部 MCP 客户端：

```yaml
- id: account-mesh
  config:
    mcpPort: 47990
    mcpToken: ''        # 设置后要求 Authorization: Bearer <token>
```

端点：`http://127.0.0.1:47990/mcp`（协议 `2025-06-18`）。工具：`mesh_status`、`mesh_peers`、`mesh_session_list`、`mesh_session_read`、`mesh_session_summary`、`mesh_workspace_list`、`mesh_file_read`。不存在写入、prompt、shell 或任意命令工具。

用只含配置的 bundle 从 DSH profile 连接它：

```yaml
- id: account-mesh-mcp
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    serverName: account-mesh
    transport: streamable-http
    url: http://127.0.0.1:47990/mcp
```

之后 `mcp__account-mesh__mesh_session_summary` 可按会话 id 读取远端会话，并返回完整 transcript 供总结。

## 面板

设置 → 同账号互联：状态、传输方式（JSONL / JLC）、设备指纹、发现地址、Tailscale 探测结果、发现通道（含局域网/Tailscale 探测）、本机测试对端开关、对端设备（信任/撤销/重连）。原生 DSH 中传输卡片只显示 JSONL 并链接到夜间巡航版下载页；夜间巡航版显示 `本地到远端 巡航加速中` 或 `本地到远端 重启即出发`，以及站点提供的插件精选链接。

## 本地开发

```sh
pnpm install                       # node-datachannel 针对本平台预编译
node spike/p0-transport.mjs        # 同一进程内的两个 node-datachannel 对端
node spike/p0-mesh.mjs             # 两个 Mesh 实例：发现 → 认证 → 只读 RPC
```

设计说明：本 bundle 遵循发行版的「无超时」约定 —— 没有 RPC、连接或空闲期限；只有调用方取消、真实错误和传输状态变化会结束工作。见 [docs/DETAIL.md](docs/DETAIL.md)。

状态存放在 `$DSH_HOME/account-mesh/`（`identity.json`、`peers.json`、`mesh.log`，均为 `0600`）。
