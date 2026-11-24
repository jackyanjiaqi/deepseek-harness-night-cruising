/**
 * Agent-facing document-service tool.
 *
 * The tool exists so the model can emit a durable, UI-rendered reference to
 * a document in the current Session's document service instead of a bare
 * Markdown path. The browser half installs a `tool.call.toolview` card for
 * this wire name and renders the returned URL as a "在文档服务中打开" button.
 */

const TOOL_NAME = 'doc_server'

const FILE_PROP = {
  type: 'string',
  description: '文件路径：绝对路径、相对会话工作空间根目录的路径，或文档服务返回的 /view?file=... URL。',
}
const DIRECTORY_PROP = {
  type: 'string',
  description: '目录路径：绝对路径或相对会话工作空间根目录的路径；省略时使用会话工作空间根目录。',
}

function textRender(_args, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

function jsonSafe(value) {
  if (value === undefined) return null
  return JSON.parse(JSON.stringify(value))
}

function requireAgent(exec) {
  const agent = exec?.agent
  const session = agent?.session
  if (session === undefined) {
    throw new Error('doc_server 需要由会话中的 agent 调用')
  }
  return session
}

/**
 * Register the `doc_server` tool.
 * @param {any} ctx - Host context with `tools`.
 * @param {import('./manager.js').DocServerManager} manager - instance owner.
 * @returns {() => void} unregister.
 */
export function registerTools(ctx, manager) {
  return ctx.tools.register({
    name: TOOL_NAME,
    description:
      '在当前会话的“文档服务”中打开或链接一个文档。需要给用户展示工作区内的 Markdown、图片、PDF、Office 或文本文件时优先调用此工具；结果会在对话中渲染成“在文档服务中打开”的按钮，并返回可直接引用的 URL。文档服务尚未启动时会自动以会话工作空间根目录启动。文件不在当前根目录内时，先调用 action=switch 切换根目录；action=status/list 查看状态。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['open', 'link', 'locate', 'start', 'switch', 'status', 'list', 'stop'],
          description: 'open/link/locate 定位文件；start/switch 设置根目录；status 查看当前会话服务；list 查看全部服务；stop 停止当前会话服务。默认为 open。',
        },
        file: FILE_PROP,
        directory: DIRECTORY_PROP,
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: textRender,
    },
    execute: async (args, exec) => {
      const action = typeof args?.action === 'string' ? args.action : 'open'
      const session = requireAgent(exec)
      if (action === 'list') {
        return jsonSafe({ ok: true, action: 'list', servers: manager.list() })
      }
      if (action === 'status') {
        return jsonSafe({ ok: true, action: 'status', server: manager.state(String(session.id)) ?? null })
      }
      if (action === 'stop') {
        const stopped = await manager.stop(String(session.id))
        return jsonSafe({ ok: true, action: 'stop', stopped })
      }
      if (action === 'start' || action === 'switch') {
        const directory = typeof args?.directory === 'string' ? args.directory : undefined
        if (action === 'switch' && (directory === undefined || directory.trim() === '')) {
          throw new Error('action=switch 时 directory 不能为空')
        }
        const server = await manager.start(session, directory)
        return jsonSafe({ ok: true, action, server })
      }
      const file = typeof args?.file === 'string' ? args.file.trim() : ''
      if (file === '') {
        throw new Error('open/link/locate 需要 file 参数；只启动服务请使用 action=start')
      }
      const server = await manager.locate(session, file)
      return jsonSafe({
        ok: true,
        action,
        sessionId: server.sessionId,
        title: server.title,
        file: server.currentFile,
        url: server.currentUrl,
        root: server.root,
        port: server.port,
        markdown: `[在文档服务中打开 ${server.currentFile}](${server.currentUrl})`,
      })
    },
  })
}

export { TOOL_NAME }
