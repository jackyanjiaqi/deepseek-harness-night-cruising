# DeepSeek Harness 深夜巡航版

独立维护的桌面发行工程。基线是 DeepSeek Harness `0.2.2-rc.5`，固定提交为 `9c2670d3bce5275e0d1610272958121af87787bb`。登录页和工作区使用夜间巡航主题，工作区默认使用深色配色，底部展示摩托车穿过跨江大桥驶向夜间都市的全景。点「播放音乐」可循环播放当前的 20 秒合成器占位音轨，再次点击暂停。正式配乐已选定动画《乒乓》原声带中牛尾宪辅（牛尾憲輔）的《Night Cruising》，待取得可随包分发的录音后替换。已有外观偏好优先。

## 从仓库启动

需要 Git、Node.js 24、pnpm 11.28.5 以及本机平台的原生编译工具。首次构建会读取锁文件并下载 Electron、Node、Python 和 wheel。调试和打包都从本仓库根目录执行。

构建、测试和补丁命令优先使用工程内已初始化的 `deepseek-harness/`。若该目录缺失或为空，脚本按 `package.json` 中 `submodule-paths.deepseek-harness` 的顺序查找含固定提交的 Git 工作区，相对路径从本工程根目录计算。可用 `npm run patch:config` 查看实际源码路径。外层源码可以有本地改动，构建和补丁重放都从固定提交创建独立副本。独立克隆且没有本地源码时，先执行 `git submodule update --init -- deepseek-harness`。

```sh
npm test
npm run dev
```

| 命令 | 作用 |
| --- | --- |
| `npm run prepare:source` | 从选定的本地 Git 仓库检出固定提交，按 series 应用补丁，打印源码目录 |
| `npm run build` | 按锁文件安装依赖并编译 Host、客户端、Web、Electron |
| `npm start` | 启动桌面，首次启动补齐构建；优先复用已安装版的 primary runtime，并使用独立的开发 userData |
| `npm run dev` | 重新构建后启动，可连接主进程、渲染进程、Host 调试器 |
| `npm run release:source` | 从已应用补丁的 Git 树导出源码压缩包和 SHA-256 |
| `npm run release` | 在当前原生平台准备运行时、打包并执行成品冒烟测试，成功后将安装包和 SHA-256 写入 dist |

启动器继承当前用户环境。DSH 和 Electron 自行选择默认数据目录。显式传入的 `DSH_HOME`、`DSH_DESKTOP_USER_DATA_DIR` 在开发启动时生效；个人配置、凭据和会话由应用按原有方式管理。

`start` / `dev` 会优先复用已安装 DeepSeek Harness 的 primary runtime（macOS 为 `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime`），并把开发实例的 Electron userData 默认放到 `~/.dsh/dev-desktop-user-data`，避免与已安装版抢单实例锁或重复下载 Node/Python/wheel。可用 `DSH_DESKTOP_PRIMARY_RUNTIME_DIR` / `DSH_DESKTOP_USER_DATA_DIR` 覆盖；两者只影响 Electron 运行时与浏览器级数据，`DSH_HOME` 下的 profile 和会话仍然共用。开发调试端口默认是 9229、9222、9230，可以分别用 `DSH_DESKTOP_MAIN_INSPECT_PORT`、`DSH_DESKTOP_RENDERER_DEBUG_PORT`、`DSH_DESKTOP_HOST_INSPECT_PORT` 覆盖。

## 发行

### 从全新克隆重新打包

在巡航仓库根目录执行以下命令。发行用的 JPG 和 WAV 作为独立文件放在目录补丁的 `files/` 下，路径与补丁后的源码一致。构建器按清单还原资源并生成 `.build/` 和 `dist/`。[媒体清单](patches/deepseek-harness/0.2.2-rc.5/000-night-cruising-media.dir.patch/meta.json) · [夜景 JPG](patches/deepseek-harness/0.2.2-rc.5/000-night-cruising-media.dir.patch/files/apps/web/src/night-ride.jpg) · [巡航 WAV](patches/deepseek-harness/0.2.2-rc.5/000-night-cruising-media.dir.patch/files/apps/web/src/night-cruising.wav)

```sh
git submodule update --init -- deepseek-harness
npm run release:source  # 生成带图片的源码包
npm run release         # 生成当前平台的桌面安装包
```

| 原生构建主机 | 产物 | 使用方式 |
| --- | --- | --- |
| Linux x64 | tar.gz、deb、AppImage | `tar.gz` 解压后运行目录中的 `./night-cruising`；`deb` 用 `sudo apt install ./<文件>.deb` 安装；`AppImage` 赋予可执行权限后直接运行。三种产物都带终端入口 `resources/runtime/cli/bin/dsh` |
| macOS arm64 或 x64 | dmg | 挂载镜像，将应用拖入 Applications |
| Windows x64 | exe | 运行 NSIS 安装器 |

Linux 的 `deb` 需要维护者地址，默认写入 `Night Cruising <night-cruising@deepseek-harness.partyplay.top>`；打包前可用 `DSH_DESKTOP_LINUX_MAINTAINER="名称 <邮箱>"` 覆盖。官网下载页同时登记 Linux 的 `tar.gz`、`deb` 与 `AppImage`；三种产物随 `dist/` 一起生成并附带 `.sha256`，主下载入口指向 GitHub Release。

当前使用无发行证书的打包配置。CI 工作流支持手动触发和 `v*` 标签，在 Linux、macOS 和 Windows 各自构建并保留产物。上传 GitHub Release 可使用已通过成品验证的文件及同名校验文件。源码压缩包内含应用补丁后的完整上游树。重新制作桌面发行包时，使用本仓库和固定子模块。

## 长任务的超时行为

| 操作 | 处理方式 | 源码入口（相对于补丁后的源码目录） |
| --- | --- | --- |
| 模型请求、流式响应空闲等待、辅助会话标题 | 共享 deadline 和 idleWatchdog 传递调用者取消信号，SDK 补丁移除自动中止。标题调用直接传入请求信号 | packages/util/timeout、packages/llm、packages/session/session-title-llm、patches |
| Node fetch 直连和 HTTP 代理 | DSH 安装的 Undici Agent 将建连、响应头和响应体超时设为 0 | packages/util/http-proxy/src/install.ts |
| Web 服务端 HTTP/HTTPS | 关闭请求与请求头期限 | packages/host/webserver/src/index.ts |
| MCP 连接、发现、工具调用和清理 | 本地等待直接跟随 Promise；传给 MCP SDK 的计时参数取有符号 32 位毫秒最大值 | packages/mcp/mcp-client |
| Shell、PTY、SSH、LSP、工作流、文件预览和扩展操作 | 默认仍只响应取消；夜间巡航底部栏可启用工具调用、命令、持久终端、工作树、网页抓取与 LSP 收尾期限，到期只结束该次操作 | packages/shell、packages/subprocess、packages/ssh、packages/lsp、packages/workflow、packages/experimental |
| 阻塞等待（`job_output`、`wait_agent`、会话等待） | 到期返回当前状态，绝不终止任务；默认 30 秒，作业上限 10 分钟、子智能体上限 1 小时 | packages/jobs、packages/subagent、packages/api/session-controller、packages/util/timeout |
| 写入者文件锁及插件子进程退出 | 持续等待释放或退出；写锁支持调用者主动取消 | packages/util/atomic-write、packages/boot/plugin-manager/src/run-tree.ts |
| 登录授权、更新和下载 | 保留服务端返回的授权过期时间；运行时下载移除本地截止时间，其他操作见补丁 | packages/credentials/deepseek-account、apps/desktop、scripts/primary-runtime |
| 打包、退出和测试框架 | 依接口关闭或采用最大计时值 | apps/desktop/scripts、scripts/run-gates.ts、vitest.*.config.ts |

`2_147_483_647` 毫秒约为 24.86 天。使用该值的路径仍有上界。操作系统、远端服务和网络代理仍可终止连接。完整变更可按文件核查 `002-disable-operation-timeouts.patch`、`003-night-cruising.patch`、`004-runtime-limits.patch`、`005-desktop-release.patch` 和 `006-test-and-sdk-timeouts.patch`。

### 底部栏统一设置

工作区底部的「夜间巡航」栏折叠时只显示音乐与一行白色超时摘要；点击「超时 …」展开分组面板，可筛选、恢复默认并保存。所有值写入 `$DSH_HOME/night-cruising/timeouts.json`，通过 `GET/PUT /night-cruising/timeouts` 读写，保存后立即生效，不需要重启 Host。当前可编辑项：

| 分组 | 设置键 | 默认 |
| --- | --- | --- |
| 等待与轮询 | `wait.job.default` / `wait.job.max` | 30 秒 / 10 分钟 |
| 等待与轮询 | `wait.agent.default` / `wait.agent.max` | 30 秒 / 1 小时 |
| 等待与轮询 | `wait.session.default` | 30 秒 |
| 工具执行 | `tool.call`、`tool.bash`、`tool.persistentBash`、`tool.worktree`、`web.fetch` | 0（不限制） |
| 服务维护 | `lsp.shutdown` / `lsp.grace` | 10 秒 / 5 秒 |
| 运行观测 | `job.status.afterMs` / `workflow.progress.interval` | 5 分钟 / 60 秒 |
| 重复调用守卫 | `guard.repeat.*`（窗口、阈值、提醒间隔、阻断） | 24 / 8 / 20 / 关闭 |
| 模型请求 | `llm.request` | 固定不限制（仓库政策） |

配置项的说明来源是 [bottom-settings.mjs](bottom-settings.mjs)；运行时目录在 `packages/bundle/web-app/src/night-timeouts.ts`。`job_output` 与 `wait_agent` 不再接受 profile 里的另一套等待配置，底部栏是唯一来源。

新增插件超时只需在 `packages/bundle/web-app/src/night-timeouts.ts` 增加一行目录项，并在 `packages/util/timeout/src/index.ts` 的 `DEADLINE_SETTINGS` 映射 capability code；面板按 `auto-fit` 网格和滚动容器承载任意数量的分组。模型请求相关代码不进入映射表。`deadline()` 只在设置发布后按映射键装表；未发布设置的单元测试上下文仍按调用者传入的期限行为。

## 维护补丁

在本仓库根目录执行 `npm run patch -- --help` 查看用法。也可以从任意目录用 Node 直接调用本工程的 `patches/tools/patch.mjs`。工具使用本地 Git 和 Node.js，构建另需 pnpm。

| 命令 | 作用 |
| --- | --- |
| `npm run patch:init` | 准备独立编辑副本并输出目录。缺少本地源码仓库时才初始化官方子模块 |
| `npm run patch:config`、`npm run patch:list-versions` | 查看基线提交、版本和绝对路径，或列出配置中登记的版本 |
| `npm run patch:list`、`npm run patch:status` | 查看 series 顺序，或查看编辑副本已应用的补丁及本地修改 |
| `npm run patch:create -- <名称> [路径...]` | 根据工作文件生成下一个三位编号的补丁，并登记到 series。路径相对于编辑副本，省略时包含全部非忽略改动 |
| `npm run patch:update -- <编号或名称> [路径...]` | 把本次改动合入已有补丁；写入前重放后续补丁并核对结果 |
| `npm run patch:restore -- [编号或名称]` | 将编辑副本恢复到该补丁应用后的位置，省略编号时恢复整套补丁。`patch:apply` 同义 |
| `npm run patch:clean` | 将编辑副本切回官方基线，保留 series 和补丁文件。`patch:revert` 同义 |
| `npm run patch:verify` | 在临时 Git 仓库中从基线完整重放，无需准备桌面依赖 |
| `npm run patch:build` | 构建已保存的 series，与 `npm run build` 使用相同的构建入口 |

**制作新补丁**。先执行 `npm run patch:init`，在输出的 `.build/patch-work-<版本>/` 中修改源码，再回到仓库根目录执行。例如，只导出桌面主进程的改动：

```sh
npm run patch:create -- desktop-menu apps/desktop/src/main.ts
npm run patch:verify
npm run patch:build
```

**新增、替换或删除媒体**。将视频放入编辑副本中的目标路径后，可执行 `npm run patch:create -- ride-video apps/web/src/ride.mp4`。工具会将原始字节写入 `NNN-ride-video.dir.patch/files/apps/web/src/ride.mp4`，并在同目录的 `meta.json` 中记录 `added`、`deleted`。删除操作只记录路径和基线信息。替换文件时先删除旧版本，再添加新文件。修改同一补丁可用 `npm run patch:update -- ride-video apps/web/src/ride.mp4`，恢复和验证沿用原命令。提交时将目录补丁和更新后的 `series` 一起纳入 Git。

只修改文本时仍生成差异补丁；同一次导出包含新增、删除或二进制替换时，其中的普通文件以完整快照保存。可以通过命令后面的文件路径，将代码修改和大型媒体分别导出。

**维护旧补丁**。例如，先执行 `npm run patch:restore -- 003`，在编辑副本修改文件，再执行 `npm run patch:update -- 003`。成功后用 `npm run patch:restore` 切回完整序列。切换补丁前应先导出改动或在副本内使用 `git stash -u`。若后续补丁与本次更新冲突，可在完整序列末尾用 `patch:create` 保存变更。

版本与固定提交配置在本工程 `package.json` 的 `patches-tools` 字段。可用 `npm run patch -- status --version <版本>` 选择已登记版本。每个版本有独立的编辑副本和 `patches/deepseek-harness/<版本>/series`；桌面构建使用默认版本。构建器按基线及补丁内容生成独立的 `.build/harness-<摘要>/`，官方子模块作为源码来源。

夜景封面由内置 ImageGen 生成，资源位于补丁后的 `apps/web/src/night-ride.jpg`。画面描述为「午夜摩托车骑手穿过悬索桥高速公路，驶向灯火繁密的滨水都市，青蓝夜色、湿路面和暖黄色车灯」。同目录中的 `night-cruising.wav` 是随包提供的 20 秒原创合成器循环。

## 官网与下载发布

官网位于 `site/`。在本仓库运行 `npm ci` 和 `npm run site:preview` 可预览本地安装包；`npm run site:plan` 列出将发布的对象。七牛空间、阿里云 DNS、证书续期及正式发布步骤见[七牛静态站点部署手册](docs/七牛静态站点部署手册.md)。
