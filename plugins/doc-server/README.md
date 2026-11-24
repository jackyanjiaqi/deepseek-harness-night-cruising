# dsh-doc-server — 文档服务

DSH 会话视图插件：每个会话拥有独立的文档服务，完整复刻 `cmd_tools/doc-server`。

- 会话视图标签「文档服务」：内嵌该会话的文档服务页面。
- 侧边栏工作区文件右键：目录「启动目录 / 切换目录」，文件「定位文件」。
- 设置 → 文档服务：列出所有已启动服务（会话标题、地址、端口、根目录、最后定位），一键跳转到会话并切标签。
- agent 工具 `doc_server`：把文档链接渲染成对话内「在文档服务中打开」按钮。
- 如果当前构建缺少会话视图程序化切换能力，需要应用 `patches/` 中的补丁（见下）。

## 目录

```
plugins/doc-server/
├── index.js              Host 入口：实例管理、/doc-server 控制路由、doc_server 工具
├── client.js             浏览器入口：View 标签、右键菜单、设置页、工具卡片
├── server/               从 cmd_tools/doc-server 完整复刻的实现
│   ├── lib/              原 lib/（config.js 改为每实例 createConfig）
│   ├── public/           原 public/（doc-app.js、graph-app.js、mermaid）
│   └── standalone.js     手工运行入口：node server/standalone.js [port] [root]
├── src/
│   ├── manager.js        每会话 HTTP 服务、root/端口/定位
│   ├── routes.js         /doc-server/api/* 控制接口
│   └── tools.js          doc_server agent 工具
├── docs/DETAIL.md        Plugin Manager 详情页
├── locale/*.json         标题、描述、详情入口
└── test/manager.test.mjs 不依赖 DSH 的管理器测试
```

## 启动与定位语义

每个会话一个服务：

| 操作 | 行为 |
| --- | --- |
| 目录右键「启动目录」 | 未启动时以该目录为 root 启动；已启动时等价于「切换目录」。 |
| 目录右键「切换目录」 | 复用同一端口和 URL，只替换 root，清空文档缓存并回到首页。 |
| 文件右键「定位文件」 | 未启动时先以会话工作空间根目录启动，再定位；已启动时定位到当前 root 内文件。文件越界会报错。 |
| agent `doc_server` | 同上；返回 `{ file, url, root, port, markdown }`。 |
| 设置页「跳转」 | 打开会话并切到「文档服务」标签，保留最后定位/最后浏览位置。 |

定位和跳转都优先切换「文档服务」标签。文档页内的导航通过 `postMessage` 回传，客户端记住每个会话最后浏览的 URL。

## 会话视图切换补丁

`client.js` 优先调用 `ctx.uiConversation.selectView(sessionId, viewId)`。该方法是
`patches/deepseek-harness/0.2.2-rc.5/011-view-selection.patch` 新增的：

- `packages/client/ui-conversation/src/client/apply.ts`：登记每个会话已挂载的选择动作。
- `packages/client/ui-conversation/src/client/assembly.ts`：暴露 `selectView(sessionId, view)`。
- `packages/client/ui-conversation/src/client/stores.ts`：未挂载会话的持久化偏好。

没有补丁时，插件仍会注册标签、启动/定位服务、写持久化偏好；但自动切换标签会退化为提示用户手动点击。应用补丁后需要按 night-cruising 的构建流程重新构建客户端资源。

## 安装

在 `deepseek-harness-night-cruising` 仓库根目录：

```sh
npm run patch:verify   # 验证补丁序列（可选，但建议）
npm run build          # 需要补丁生效时
```

然后在 DSH 的 Plugins → Add plugin 选择本目录，或用 `plugin_manager` 的
`install_bundle` 安装 `plugins/doc-server`。安装后刷新页面；客户端插件会立即加载。

## 配置

`cordis.patch.yml` 插入一行 `doc-server`，可选覆盖：

```yaml
- id: doc-server
  config:
    bindHost: 127.0.0.1        # 默认仅回环
    graphFileNames: [CATALOG.md]
    ignoreDirs: [.git, node_modules, dist]
```

`bindHost: 0.0.0.0` 会把文档暴露到局域网；文档服务自身没有鉴权，默认不要这样设置。

## 测试

```sh
cd plugins/doc-server
npm run check   # node --check 全部 JS
npm test        # 启动/定位/切换 root/越界/停止
```

`server/standalone.js` 可直接验证复刻实现：

```sh
node server/standalone.js 0 /path/to/docs
```

## 已知限制

- 文档页保留 doc-server 自己的浅色样式，不继承 DSH 深色主题（完整复刻优先）。
- 服务实例不跨 DSH 重启持久化；设置页只列当前已启动的服务。
- iframe 使用独立端口，页面导航只能通过 `postMessage` 回传；不读取 iframe DOM。
- 仅对文档服务支持的扩展名显示「定位文件」：md/html/pdf/pptx/doc/docx/txt 与图片。
