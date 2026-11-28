/**
 * Host half of dsh-account-mesh.
 *
 * DSH instances signed in to the same DeepSeek account discover each other
 * on the LAN (including a Tailscale tailnet), authenticate with Ed25519 device
 * keys, and serve each other a read-only view of sessions and workspace files.
 *
 * There is no Config export: every option has a runtime default, so a partial
 * patch override can never fail validation. See cordis.patch.yml.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Mesh } from './src/mesh.js'
import { createLog } from './src/log.js'
import { registerTools } from './src/tools.js'
import { registerRoutes } from './src/routes.js'
import { registerMcp } from './src/mcp.js'
import { detectDistribution } from './src/distribution.js'
import { CodecController } from './src/codec.js'
import { hardenPermissions } from './src/permissions.js'

export const name = 'account-mesh'
export const inject = []

const here = path.dirname(fileURLToPath(import.meta.url))
const version = readVersion()

export function apply(ctx, config = {}) {
  const dataDir = config.dataDir || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'account-mesh')
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const log = createLog({ dir: dataDir, debug: config.debug !== false, logger: ctx.logger })
  const hardened = hardenPermissions(dataDir, log)
  if (hardened.fixed.length > 0) log.info(`permissions: hardened ${hardened.fixed.length} path(s)`)
  log.info(`starting dsh-account-mesh ${version}`)

  // Edition gate for the optional JLC transfer codec. Standard DSH stays on
  // JSONL; Night Cruising may load the native module after a restart.
  const edition = detectDistribution({ config })
  const codec = new CodecController({ ctx, config, log, edition, dataDir, here })
  ctx.effect(() => {
    codec.start().catch(error => log.warn(`account-mesh: codec start failed: ${error.message}`))
    return () => codec.stop()
  }, 'account-mesh: codec')

  const mesh = new Mesh({ ctx, config, log, version, codec })
  ctx.effect(() => {
    mesh.start()
    return () => mesh.stop()
  }, 'account-mesh: runtime')

  // These services are mounted after this row in a real Host composition, so
  // register through injection instead of a one-shot ctx.get() at apply time.
  ctx.inject(['tools'], child => {
    child.effect(() => registerTools(child, mesh, log), 'account-mesh: agent tools')
  })
  ctx.inject(['webServer'], child => {
    child.effect(() => registerRoutes(child, mesh, log, codec), 'account-mesh: panel routes')
  })
  // Optional MCP endpoint: exposes the same read-only operations to external
  // MCP clients (streamable HTTP). Off unless `mcpPort` is configured.
  if (config.mcpPort) {
    ctx.inject(['webServer'], child => {
      child.effect(() => registerMcp(child, mesh, log, config), 'account-mesh: mcp endpoint')
    })
  }
  // Resolve the account as soon as its service mounts instead of waiting for
  // the first periodic refresh.
  ctx.inject(['deepseekAccount'], () => {
    mesh.refreshAccount().catch(error => mesh.noteError(error))
  })
}

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}
