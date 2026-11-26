/**
 * Host half of the DSH "文档服务" (document service) plugin.
 *
 * One HTTP document server per Session, built from the copied
 * cmd_tools/doc-server implementation in `server/`. The Client half owns the
 * Conversation View tab, workspace-file context menus, the settings roster,
 * and the `doc_server` tool card; this half owns instance lifetime, ports,
 * roots, and the agent tool.
 *
 * The row has no Config export: every option below is optional and read with
 * a default at activation, so a partial profile override never breaks the
 * row. See cordis.patch.yml.
 */
import fs from 'node:fs'
import { DocServerManager } from './src/manager.js'
import { registerRoutes } from './src/routes.js'
import { registerTools } from './src/tools.js'

export const name = 'doc-server'
export const inject = []

/**
 * Plugin version, read from this package's own manifest so the settings page
 * badge never drifts from what was actually installed. No new dependency.
 */
const PACKAGE_VERSION = (() => {
  try {
    const manifest = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : null
  } catch {
    return null
  }
})()

export const version = PACKAGE_VERSION

/**
 * Activate the document-service manager.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context.
 * @param {object} [config] - optional row config.
 */
export function apply(ctx, config = {}) {
  const manager = new DocServerManager({ ctx, config })
  ctx.effect(() => () => manager.stopAll(), 'doc-server: server lifetime')

  ctx.inject(['webServer'], (child) => {
    child.effect(() => registerRoutes(child, manager, child.logger, PACKAGE_VERSION), 'doc-server: control routes')
  })

  ctx.inject(['tools'], (child) => {
    child.effect(() => registerTools(child, manager), 'doc-server: agent tool')
  })

  ctx.inject(['sessions'], (child) => {
    child.effect(() => child.on('session/disposed', (session) => {
      if (session?.id !== undefined) void manager.stop(String(session.id))
    }), 'doc-server: stop on session disposal')
    child.effect(() => child.on('workspace/session-archived', (request) => {
      if (request?.sessionId !== undefined) void manager.stop(String(request.sessionId))
    }), 'doc-server: stop on session archive')
  })
}
