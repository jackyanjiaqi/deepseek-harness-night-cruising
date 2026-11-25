# dev 启动 `fetch failed`：运行时下载与单实例锁排查

- 日期：2026-11-25
- 影响命令：`npm run start`、`npm run dev`（`npm run build` 本身正常）
- 运行环境：macOS arm64，DSH `0.2.2-rc.5`，版本号 `0.2.2-rc.5-20261125v1`
- 结论：不是构建失败，是 `scripts/dev.ts` 在组装 dev 运行时（primary runtime）时联网下载 Python/wheel 被网络拒绝；同时旧安装版 App 占用同一个 Electron userData 的单实例锁。

## 1. 现象

```sh
npm run start
# ...
$ tsx scripts/dev.ts --skip-build
fetch failed
Error: pnpm failed: 1
```

`npm run build` 可以正常结束（exit 0），说明源码、类型和 Web 构建都没问题。失败只发生在**未打包启动**这一步：`dev.ts` 需要一份 primary runtime（Node + Python + pnpm + wheel），默认会去 `nodejs.org`、GitHub、PyPI 下载。

## 2. 排查过程

### 2.1 先确认 build 是否真的失败

```sh
cd deepseek-harness-night-cruising
npm run build; echo $?
# 0
```

`build` 只跑 `build:artifacts` 和桌面 bundle，不准备 primary runtime，所以能通过。

### 2.2 找到报 `fetch failed` 的调用

```sh
sed -n '100,160p' apps/desktop/scripts/dev.ts
sed -n '1,80p' apps/desktop/scripts/prepare-primary-runtime.ts
sed -n '1,70p' scripts/primary-runtime/prepare.ts
```

调用链：

```
apps/desktop/scripts/dev.ts
  → prepareDevelopmentRuntime()
  → apps/desktop/scripts/prepare-primary-runtime.ts
  → scripts/primary-runtime/prepare.ts
  → downloadPrimaryRuntimeAsset(fetch(url))
```

`prepare.ts` 依次下载：

- Node 官方压缩包
- Python standalone（`github.com/astral-sh/python-build-standalone`）
- PyPI 上的 numpy / pandas / Pillow / lxml 等 wheel

### 2.3 看缓存缺什么

```sh
ls -la apps/desktop/.desktop-build/downloads
```

只看到 Node 的 52.9 MB 压缩包（sha256 `bed7...`，与 `lock.json` 的 `nodeSha256` 一致），Python 与 wheel 没有缓存。说明 Node 下载成功，后面的 GitHub/PyPI 请求失败。

### 2.4 确认旧 App 的单实例锁

```sh
ps -o pid,command -ax | grep -E "DeepSeek Harness|Harness Dev"
ls "$HOME/Library/Application Support/@deepseek-ai/dsh-desktop"
```

旧安装版仍在运行，`userData` 里有 `SingletonLock`、`SingletonCookie`、`SingletonSocket`。dev 启动默认也使用同一个 userData，因此即使 runtime 准备好，新的 dev 实例也可能被旧实例的单实例锁顶掉。

## 3. 修复

### 3.1 让 dev 启动器复用已有 runtime

`apps/desktop/scripts/dev.ts`：

```ts
const configured = process.env.DSH_DESKTOP_PRIMARY_RUNTIME_DIR
if (configured && existsSync(join(configured, 'runtime.json'))) {
  console.log(`desktop development: reusing primary runtime at ${configured}`)
  return
}

const prepared = primaryRuntimeDirectory()
if (existsSync(join(prepared, 'runtime.json'))) {
  console.log(`desktop development: reusing prepared primary runtime at ${prepared}`)
  return
}
```

含义：

1. 显式指定 `DSH_DESKTOP_PRIMARY_RUNTIME_DIR` 且目录里有 `runtime.json` → 直接使用；
2. 之前准备过默认 dev runtime → 直接复用；
3. 两者都没有才走原来的下载流程。

### 3.2 `npm start` 自动选择安装版 runtime 和独立 userData

`patches/tools/cruise.mjs` 新增：

- 在 macOS/Windows/Linux 的常见安装位置查找 `resources/runtime/primary-runtime`；
- 找到就设置 `DSH_DESKTOP_PRIMARY_RUNTIME_DIR`；
- 未设置 `DSH_DESKTOP_USER_DATA_DIR` 时默认到：
  - `~/.dsh/dev-desktop-user-data`（本机实际使用，保留已有登录 cookie）
- 仅对 `start` / `dev` 生效，`build`、`release` 不受影响。

因此现在直接执行：

```sh
cd deepseek-harness-night-cruising
npm start
```

即可，不再需要每次手写两个环境变量。需要覆盖时仍可显式传入：

```sh
DSH_DESKTOP_PRIMARY_RUNTIME_DIR=/path/to/primary-runtime \
DSH_DESKTOP_USER_DATA_DIR=/path/to/dev-user-data \
npm start
```

### 3.3 打包时也复用运行时

`apps/desktop/scripts/prepare-primary-runtime.ts` 增加同样的复用逻辑：

- 目标 `runtime/primary-runtime` 已有完整 `runtime.json` → 直接用；
- 否则 `DSH_DESKTOP_PRIMARY_RUNTIME_DIR` 指向完整运行时 → 复制到目标目录；
- 否则在常见安装位置查找安装版 runtime → 复制；
- 都没有才走原来的下载流程。

`npm run release` 输出中可以看到：

```text
desktop packaging: seeding primary runtime from /Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime
```

这样打包不再依赖 GitHub 上的 Python/wheel 下载；Electron 分发仍由 electron-builder 缓存或下载，属于正常的一次性构建依赖。

### 3.4 userData 与 DSH 数据分开

| 数据 | 位置 | 内容 |
| --- | --- | --- |
| Electron userData | `~/.dsh/dev-desktop-user-data`（dev）/ `~/Library/Application Support/@deepseek-ai/dsh-desktop`（安装版） | Cookies、Local Storage、Session Storage、Cache、GPU 缓存、Preferences、`SingletonLock`、`DevToolsActivePort`、`desktop/settings.json`、`plugin-operations/operations.jsonl` |
| DSH_HOME | `~/.dsh` | `sessions/`（会话 JSONL）、`profiles/desktop/`（profile、插件、node_modules）、`storages/`、`.credentials.yaml`、`attachments/`、`cache/`、`account-mesh/`、`dsh-market/` |

userData 分离只解决 Electron 级冲突；profile 和会话仍然共用 `~/.dsh`。这样 dev 实例能看到已有会话和插件，但同一个 session 不要同时开在两个实例里（writer 锁会拒绝第二个）。

## 4. 验证

```sh
# 补丁重放
npm run patch:verify
# 重放通过：13 个补丁

# 构建
npm run build; echo $?
# 0

# 启动
npm start
```

新实例：

- 进程：`Harness Dev.app/Contents/MacOS/Electron`
- host：`127.0.0.1:<随机端口>`
- runtime：复用 `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime`
- userData：`~/.dsh/dev-desktop-user-data`

## 5. 打包结果

```text
night-cruising-0.2.2-rc.5-20261125v1-darwin-arm64.dmg        266 MB
sha256 0dc93cc2b34308583907eb9be16015c6f5ffff8df07f3f1b3e18760fbc8701bd（20261126v2）
```

- 输出目录：`dist/`
- 文件名规则：`night-cruising-<package.json version>-<platform>-<arch>.dmg`
- 打包后冒烟通过：CLI 离线插件安装/移除、Office 技能加载、DOCX/XLSX/PPTX 转 PDF、图片渲染、转换与重算、`dsh web` 启动
- 已核对 `app.asar` 内的 `dsh-web-frontend/dist/index.html` 含 `night-timeouts-toggle` 与「超时设置」，`dsh-web-app/lib/index.js` 含 `night-cruising/timeouts` 路由
- 该 DMG 已包含 013 的底栏扩展（重复守卫 / 运行观测）与底栏读取重试；应用内部版本为 `0.2.2-rc.5.20261126.2`，可与旧安装版区分

## 6. 后续注意

1. 安装版 App 与 dev 实例可以同时运行，但不要打开同一个会话。
2. 如果换了机器、没有安装版 App，也没有准备过 dev runtime，第一次启动仍需要网络下载；可提前设置 `DSH_DESKTOP_PRIMARY_RUNTIME_DIR` 指向任意完整的 `primary-runtime`。
3. `npm run dev` 与 `npm start` 使用同一套默认环境；`dev` 会先构建再启动。
4. 打包使用 `npm run release`，输出文件名取 `package.json` 的版本号（本次为 `night-cruising-0.2.2-rc.5-20261125v1-darwin-arm64.dmg`）。
5. 当前正在运行的 dev 实例使用旧 build；退出该实例后再执行 `npm start`，才会启动本次打包对应的新 build（同一个 dev userData 只能有一个实例）。
