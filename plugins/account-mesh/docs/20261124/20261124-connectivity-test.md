# 2026-11-24 连通性测试记录

记录当天对 `dsh-account-mesh` 双通道发现（局域网 + Tailscale）的实测结果与代码状态。

## 测试环境

| 设备 | 地址 | 说明 |
| --- | --- | --- |
| Mac Studio | `192.168.5.2` | macOS，DSH Desktop，Tailscale 可用 |
| Linux `admin-jysg-2301-SER` | `192.168.5.3` | Linux，DSH CLI，未连接 Tailscale |
| Mac mini `JIAQIdeMac-mini` | `100.71.160.71` | tailnet 设备，历史上有连接记录 |

插件版本：`0.1.0-rc.8`，协议 1。两台设备登录同一 DeepSeek 账号（tag `tjbZ-U…`）。

## 一、纯局域网：测通

两台设备同时关机再开机后，Mac 发现 Linux：

```
account-mesh: found peer admin-jysg-2301-SER (4f122575…054) via lan
```

`mesh_status`：

- Linux：`verified: true`、`link: open`、`rttMs: 1`
- 信任表已写入 `192.168.5.3:47831`

### 之前一直找不到的原因

重启前，Mac → Linux 单向不通：

1. Mac 的组播路由被 Tailscale 接管：`224.0.0/4` 和 `255.255.255.255/32` 指向 `utun2`，mesh 的组播/广播 announce 进了隧道，Linux 收不到。
2. Mac 的 ARP 解析不到 Linux 的 MAC（`arp -n 192.168.5.3` 无条目），Linux 却能解析 Mac（`ip neigh` 有 `7c:d6:2c:0d:16:d5`）——单向二层不通。
3. Linux 侧监听正常（`ss -ulpn` 显示 `0.0.0.0:47831`，进程 `night-cruising`），ufw 未启用，iptables/nftables 无规则，组播成员已加入（`239.255.42.99`）。
4. Linux 能 ping Mac，Mac 不能 ping Linux；tcpdump 只看到 Linux 自己发出的组播/广播，没有 Mac 的包。

结论：不是插件逻辑问题，是操作系统网络状态（ARP 表、路由表、Tailscale 隧道）陈旧导致的单向可达。两台同时重启后状态重建，双向恢复。

## 二、纯 Tailscale：连接一会儿后断开，原因尚未查明

现象：

- tailnet 对端 `JIAQIdeMac-mini`（`100.71.160.71`）曾被发现并信任（`source: tailnet`）。
- 连接建立后一段时间断开，`mesh_status` 显示 `verified: false`、`link: closed` 或 `connecting`。
- Mac 日志反复出现 `handshake with adc121ec…1e3 stalled, retrying`，offer 发出后没有收到 answer。

尚未查明原因，可能方向：

- tailnet 路径上的 WebRTC ICE 候选（UDP）被中间设备拦截。
- 对端进程重启或网络状态变化导致信令帧丢失。
- 单向可达（Mac 能发、对端不能回）。

**待办**：用设置页的「测试 Tailscale」按钮对 `100.71.160.71:47831` 做 unicast probe，确认 tailnet 通道本身是否可达。

## 三、Tailscale 与局域网同时存在：代码支持已完成

当天完成代码改动，让局域网和 Tailscale 两个通道并行运行：

### `src/discovery.js`

- 新增 `channels` 计数器：`lan`（组播/广播发出次数、收到次数、对端数、本机地址）和 `tailnet`（unicast 探测次数、收到次数、对端数、地址）。
- 新增 `probe(target, channel)`：手动探测一个目标，轮询等待应答，返回真实 RTT。
- 新增 `channelState()`：返回两个通道的计数与探测结果，供面板显示。
- 收到 announce 时按来源地址判定通道（tailnet 地址段 `100.64/10` → `tailnet`，其余 → `lan`），并累加对应通道的收到次数。

### `src/mesh.js`

- 新增 `channels()`、`probe(target, channel)`、`refreshNetwork()`。
- `refreshNetwork()` 重建 discovery（重新绑定 socket、重新加入组播、重新探测 tailnet），相当于不重启 DSH 也能刷新 OS 网络状态。

### `src/routes.js`

- `GET /account-mesh/api/channels`：通道计数。
- `POST /account-mesh/api/probe`：`{ target, channel }`。
- `POST /account-mesh/api/refresh-network`：重建 discovery。
- `/api/state` 响应增加 `channels` 字段。

### `client.js`（设置页）

新增「发现通道」卡片：

- **局域网**：显示组播地址、广播地址、发出/收到次数、对端数、本机地址。
- **Tailscale**：显示可用状态、已知设备数、对端数、地址列表。
- **测试局域网** / **测试 Tailscale**：两个独立按钮，对已知对端或输入的目标地址发 unicast probe。
- **刷新网络状态**：重建 discovery。
- 目标地址输入框留空时自动测试已知对端；填 `IP:端口` 测指定地址。

### 配置

移除了 profile 里写死的 `staticPeers: ['192.168.5.3:47831']`。发现完全依赖组播/广播 + tailnet 探测 + 信任表里记住的地址，不硬编码 IP。

## 四、本机测试连接端的显示规则

`localSessionTest` 测试端只用于在没有真实连接时渲染远端工作区，不能和真实数据混在一起：

- 设置页「发现通道」卡片新增 **本机测试连接端** 开关，可随时开启/关闭（`POST /account-mesh/api/local-test`）。
- **只要有真实对端在线且认证成功**，测试端自动隐藏：
  - 远端工作区树里不再出现 `local-test` 节点。
  - `/api/transcript?peer=local-test` 返回 404，不再提供本机会话。
  - 设置页显示「已隐藏：当前有真实对端连接」。
- 没有真实对端时，测试端按开关状态显示。
- `/api/state` 增加 `localTest: { enabled, visible, hiddenByRealPeer }`，面板据此渲染开关状态。

验证：`p0-apply.mjs` 新增断言——有真实 verified 对端时 `local-test` 节点和 transcript 都被隐藏；无真实对端时测试端可见。

## 验证

- `npm test`（`p0-apply.mjs` + `p0-client.mjs`）：ALL PASS。
- `node spike/p0-mesh.mjs`：ALL PASS。
- 实测 `mesh.probe('192.168.5.3:47831', 'lan')` 返回 `replied: true`、`peer: admin-jysg-2301-SER`、`elapsedMs: 101`。

## 待办

- [ ] 查明纯 Tailscale 连接一段时间后断开的原因。
- [ ] 三台设备（Mac Studio + Linux + Mac mini）同时在线时，验证 LAN 与 tailnet 双通道并行发现。
- [ ] 重启 DSH 后确认设置页「发现通道」卡片与两个测试按钮生效。
- [ ] 验证有真实对端时测试端自动隐藏、无真实对端时可手动开启。

## 五、MCP 端点（可选）

新增 `src/mcp.js`：设置 `mcpPort` 后，插件在 `127.0.0.1:<mcpPort>/mcp` 提供 MCP streamable-HTTP 端点（协议 `2025-06-18`），工具与 agent 工具一一对应且全部只读：

`mesh_status`、`mesh_peers`、`mesh_session_list`、`mesh_session_read`、`mesh_session_summary`、`mesh_workspace_list`、`mesh_file_read`。

- `mcpToken` 非空时要求 `Authorization: Bearer <token>`。
- `DELETE /mcp` 关闭会话。
- 外部客户端接入示例（profile `cordis.patch.yml`）：

```yaml
- id: account-mesh-mcp
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    serverName: account-mesh
    transport: streamable-http
    url: http://127.0.0.1:47990/mcp
```

接入后 `mcp__account-mesh__mesh_session_summary` 可按会话 id 读取远端会话全文并总结。

新增 agent 工具 `mesh_session_summary`：分页读完远端会话全部事件，返回纯文本 transcript，用于一次总结整段对话（实测读取 Linux 设备会话 `session-313bc118-29cb-4251-9b3f-9f8bf50f7770` 并完成总结）。
