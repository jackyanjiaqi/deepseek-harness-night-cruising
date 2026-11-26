# dsh-account-mesh

Read-only mesh between DSH instances signed in to the **same DeepSeek account**, over an authenticated WebRTC data channel on the LAN (physical LAN + Tailscale tailnet).

- Discovery: UDP multicast/broadcast, plus unicast probing of tailnet peers (`tailscale status --json`) because multicast does not cross Tailscale.
- Handshake: p2play-js style room / deterministic initiator / signed `offer`/`answer`/`ice` fragments over the same UDP socket.
- Authentication: Ed25519 nonce challenge on the data channel, bound to a local trust table.
- Data plane: read-only whitelist — sessions list/read, workspaces list, file list/stat/read. No write, prompt, shell or arbitrary-command path exists.
- Transfer: JSONL by default in standard DSH; Night Cruising may enable the optional JLC codec after a restart. The setting page and site-owned download/featured links live in the `transfer` state.

Full capability notes and limitations: [docs/DETAIL.md](docs/DETAIL.md).

## Agent tools

`mesh_status`, `mesh_peers`, `mesh_session_list`, `mesh_session_read`, `mesh_session_summary`, `mesh_session_fetch`, `mesh_workspace_list`, `mesh_file_read`, `mesh_peer_pair`, `mesh_peer_forget`.

`mesh_session_fetch` pulls a whole session through the JLC binary block channel into local memory and returns its projected transcript. The JLC archive may be cached in the encrypted, process-lifetime **vault** (`vault/*.ncv`, AES-256-GCM, 0600); it is not a user-visible file store and is cleared when DSH exits.

`mesh_session_summary` pages through a whole remote session and returns its transcript as plain text, so the agent can summarise a remote conversation in one call.

## MCP endpoint (optional)

Set `mcpPort` in the plugin config to expose the same read-only operations to external MCP clients over the MCP streamable-HTTP transport:

```yaml
- id: account-mesh
  config:
    mcpPort: 47990
    mcpToken: ''        # set to require Authorization: Bearer <token>
```

Endpoint: `http://127.0.0.1:47990/mcp` (protocol `2025-06-18`). Tools: `mesh_status`, `mesh_peers`, `mesh_session_list`, `mesh_session_read`, `mesh_session_summary`, `mesh_workspace_list`, `mesh_file_read`. No write, prompt, shell or arbitrary-command tool exists.

Connect it from a DSH profile with a configuration-only bundle:

```yaml
- id: account-mesh-mcp
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    serverName: account-mesh
    transport: streamable-http
    url: http://127.0.0.1:47990/mcp
```

Then `mcp__account-mesh__mesh_session_summary` reads a remote session by id and returns its full transcript for summarising.

## Panel

Settings → Account mesh: status, transfer mode (JSONL / JLC), device fingerprint, discovery addresses, Tailscale probe result, discovery channels with LAN/Tailscale probes, local test peer toggle, peer devices with trust/revoke/reconnect. In standard DSH the transfer card shows JSONL only and links to the Night Cruising download page; Night Cruising shows `本地到远端 巡航加速中` or `本地到远端 重启即出发` and a site-owned 插件精选 link.

## Local development

```sh
pnpm install                       # node-datachannel prebuilt for this platform
node spike/p0-transport.mjs        # two node-datachannel peers in one process
node spike/p0-mesh.mjs             # two Mesh instances: discovery → auth → read-only RPC
```

Design note: this bundle follows the distribution's no-timeout policy — no RPC, connection, or idle deadline; only caller cancellation, real errors and transport state end work. See [docs/DETAIL.md](docs/DETAIL.md).

State lives in `$DSH_HOME/account-mesh/` (`identity.json`, `peers.json`, `mesh.log`, all `0600`).
