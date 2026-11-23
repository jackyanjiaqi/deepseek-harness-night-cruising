# dsh-account-mesh

Read-only mesh between two DSH instances signed in to the **same DeepSeek account**, over an authenticated WebRTC data channel on the LAN (physical LAN + Tailscale tailnet).

- Discovery: UDP multicast/broadcast, plus unicast probing of tailnet peers (`tailscale status --json`) because multicast does not cross Tailscale.
- Handshake: p2play-js style room / deterministic initiator / signed `offer`/`answer`/`ice` fragments over the same UDP socket.
- Authentication: Ed25519 nonce challenge on the data channel, bound to a local trust table.
- Data plane: read-only whitelist — sessions list/read, workspaces list, file list/stat/read. No write, prompt, shell or arbitrary-command path exists.

Full capability notes and limitations: [docs/DETAIL.md](docs/DETAIL.md).

## Agent tools

`mesh_status`, `mesh_peers`, `mesh_session_list`, `mesh_session_read`, `mesh_workspace_list`, `mesh_file_read`, `mesh_peer_pair`, `mesh_peer_forget`.

## Panel

Settings → Account mesh: status, device fingerprint, discovery addresses, Tailscale probe result, peer devices with trust/revoke/reconnect.

## Local development

```sh
pnpm install                       # node-datachannel prebuilt for this platform
node spike/p0-transport.mjs        # two node-datachannel peers in one process
node spike/p0-mesh.mjs             # two Mesh instances: discovery → auth → read-only RPC
```

Design note: this bundle follows the distribution's no-timeout policy — no RPC, connection, or idle deadline; only caller cancellation, real errors and transport state end work. See [docs/DETAIL.md](docs/DETAIL.md).

State lives in `$DSH_HOME/account-mesh/` (`identity.json`, `peers.json`, `mesh.log`, all `0600`).
