# DeepSeek Harness 深夜巡航版

独立维护的桌面发行工程。基线是 DeepSeek Harness `0.2.2-rc.5`，固定提交为 `9c2670d3bce5275e0d1610272958121af87787bb`。登录页和工作区使用夜间巡航主题，工作区默认使用深色配色，底部展示摩托车穿过跨江大桥驶向夜间都市的全景。点「播放音乐」可循环播放原创曲《夜间巡航》，再次点击暂停。已有外观偏好优先。

## 从仓库启动

需要 Git、Node.js 24、pnpm 11.28.5 以及本机平台的原生编译工具。首次构建会读取锁文件并下载 Electron、Node、Python 和 wheel。调试和打包都从本仓库根目录执行。

```sh
git submodule update --init
npm test
npm run dev
```

| 命令 | 作用 |
| --- | --- |
| `npm run prepare:source` | 从固定子模块创建本地副本，按 series 应用补丁，打印源码目录 |
| `npm run build` | 按锁文件安装依赖并编译 Host、客户端、Web、Electron |
| `npm start` | 启动桌面，首次启动补齐构建 |
| `npm run dev` | 重新构建后启动，可连接主进程、渲染进程、Host 调试器 |
| `npm run release:source` | 从已应用补丁的 Git 树导出源码压缩包和 SHA-256 |
| `npm run release` | 在当前原生平台准备运行时、打包并执行成品冒烟测试，成功后将安装包和 SHA-256 写入 dist |

启动器继承当前用户环境。DSH 和 Electron 自行选择默认数据目录。显式传入的 `DSH_HOME`、`DSH_DESKTOP_USER_DATA_DIR` 在开发启动时生效；个人配置、凭据和会话由应用按原有方式管理。开发调试端口默认是 9229、9222、9230，可以分别用 `DSH_DESKTOP_MAIN_INSPECT_PORT`、`DSH_DESKTOP_RENDERER_DEBUG_PORT`、`DSH_DESKTOP_HOST_INSPECT_PORT` 覆盖。

## 发行

| 原生构建主机 | 产物 | 使用方式 |
| --- | --- | --- |
| Linux x64 | tar.gz | 解压后运行目录中的 `./night-cruising`，附带终端入口 `resources/runtime/cli/bin/dsh` |
| macOS arm64 或 x64 | dmg | 挂载镜像，将应用拖入 Applications |
| Windows x64 | exe | 运行 NSIS 安装器 |

当前使用无发行证书的打包配置。CI 工作流支持手动触发和 `v*` 标签，在 Linux、macOS 和 Windows 各自构建并保留产物。上传 GitHub Release 可使用已通过成品验证的文件及同名校验文件。源码压缩包内含应用补丁后的完整上游树。重新制作桌面发行包时，使用本仓库和固定子模块。

## 长任务的超时行为

| 操作 | 处理方式 | 源码入口（相对于补丁后的源码目录） |
| --- | --- | --- |
| 模型请求、流式响应空闲等待、辅助会话标题 | 共享 deadline 和 idleWatchdog 传递调用者取消信号，SDK 补丁移除自动中止。标题调用直接传入请求信号 | packages/util/timeout、packages/llm、packages/session/session-title-llm、patches |
| Node fetch 直连和 HTTP 代理 | DSH 安装的 Undici Agent 将建连、响应头和响应体超时设为 0 | packages/util/http-proxy/src/install.ts |
| Web 服务端 HTTP/HTTPS | 关闭请求与请求头期限 | packages/host/webserver/src/index.ts |
| MCP 连接、发现、工具调用和清理 | 本地等待直接跟随 Promise；传给 MCP SDK 的计时参数取有符号 32 位毫秒最大值 | packages/mcp/mcp-client |
| Shell、PTY、SSH、LSP、工作流、文件预览和扩展操作 | 共用 deadline 的路径仅响应取消；仍需传定长时长的接口使用其支持的最大值 | packages/shell、packages/subprocess、packages/ssh、packages/lsp、packages/workflow、packages/experimental |
| 写入者文件锁及插件子进程退出 | 持续等待释放或退出；写锁支持调用者主动取消 | packages/util/atomic-write、packages/boot/plugin-manager/src/run-tree.ts |
| 登录授权、更新和下载 | 保留服务端返回的授权过期时间；运行时下载移除本地截止时间，其他操作见补丁 | packages/credentials/deepseek-account、apps/desktop、scripts/primary-runtime |
| 打包、退出和测试框架 | 依接口关闭或采用最大计时值 | apps/desktop/scripts、scripts/run-gates.ts、vitest.*.config.ts |

`2_147_483_647` 毫秒约为 24.86 天。使用该值的路径仍有上界。操作系统、远端服务和网络代理仍可终止连接。完整变更可按文件核查 `002-disable-operation-timeouts.patch`、`003-night-cruising.patch`、`004-runtime-limits.patch` 和 `005-desktop-release.patch`。

## 维护补丁

`deepseek-harness/` 是官方 Git 子模块。启动器从该提交创建 `.build/harness-<摘要>/`，摘要包含基线和全部补丁。修改 `patches/deepseek-harness/0.2.2-rc.5/` 中的 series 或补丁后重新准备，即可得到新的副本。用 `npm test` 检查子模块、Linux 目标、音频资源和取消语义。打包工具在 `patches/tools/`。

夜景封面由内置 ImageGen 生成，资源位于补丁后的 `apps/web/src/night-ride.jpg`。画面描述为「午夜摩托车骑手穿过悬索桥高速公路，驶向灯火繁密的滨水都市，青蓝夜色、湿路面和暖黄色车灯」。同目录中的 `night-cruising.wav` 是随包提供的 20 秒原创合成器循环。
