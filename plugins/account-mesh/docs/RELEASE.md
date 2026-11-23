# 预发布清单（dsh-account-mesh）

当前目标版本：**`0.1.0-rc.1`**，`publishConfig.tag = "next"`，即 `npm publish` 只会写 `next` dist-tag，不会覆盖 `latest`。

## 1. 发布前必须全绿

```sh
cd plugins/account-mesh

npm run check          # 所有 JS 语法检查
npm test               # Host / Client 离线冒烟（真实 apply、真实路由、真实工具定义）
npm run test:mesh      # 双实例 harness，33 秒跨过所有定时器边界
node scripts/preflight.mjs
```

`test:mesh` 会真实建立 WebRTC 连接、做 Ed25519 双向认证、读会话与文件、验证越界拒绝。它跑满 33 秒是**必须**的：之前一次致命的定时器异常只有在 20 秒后才触发。

## 2. 打包产物自检（改用 tarball 而不是工作目录）

`plugin_manager` 安装本地目录是 `link:`，会掩盖「文件没打进包」的问题。发布前用产物验证：

```sh
npm pack  # 生成 dsh-account-mesh-0.1.0-rc.1.tgz

# 用一个临时 profile 装 tarball，避免污染 desktop profile
mkdir -p ~/.dsh/profiles/mesh-pack
dsh --profile mesh-pack --from-default-profile web --dump-config > /dev/null
dsh plugin --profile mesh-pack add "$PWD/dsh-account-mesh-0.1.0-rc.1.tgz"
# 把 dsh-account-mesh 加进 ~/.dsh/profiles/mesh-pack/package.json 的 dsh.profile.bundles
dsh --profile mesh-pack --port 59396 --no-open
```

验收点：

- `~/.dsh/account-mesh/mesh.log` 出现 `starting dsh-account-mesh 0.1.0-rc.1`、`agent tools registered (8)`、`discovery on 47831`、`account ready`；
- 进程存活 **≥ 30 秒**（跨过 5/15/20/30 秒定时器）；
- `curl -o /dev/null -w '%{http_code}' http://127.0.0.1:59396/account-mesh/api/state` 返回 401（路由已挂载，浏览器信任围栏生效）。

收尾：删掉临时 profile 与 `.tgz`。本次 `0.1.0-rc.1` 已按上述方式验证通过。

## 3. 发布

```sh
npm login
npm publish            # 因 publishConfig.tag=next，落到 next
npm view dsh-account-mesh@0.1.0-rc.1 dist-tags
```

安装方式（用户侧）：

- 界面：**Plugins → Add plugin**，填 `dsh-account-mesh@0.1.0-rc.1`；
- 或 `plugin_manager install_bundle`，target 为 `dsh-account-mesh@0.1.0-rc.1`。

预发布阶段不要用 `@latest` 安装，也不要把 `next` 提升为 `latest`。

## 4. 升级到 latest 的条件

- 至少两台**真实设备**（局域网 / Tailscale）完成一次双向只读读取；
- 断开一方后重连、撤销信任、拒绝对端读取这三条路径实测过；
- 面板在中文与英文下各看一眼，无 `active: false`、无渲染报错；
- 再按第 2 节做一次 tarball 验证。

然后：

```sh
npm dist-tag add dsh-account-mesh@0.1.0-rc.1 latest
```

## 5. 回滚

```sh
npm deprecate dsh-account-mesh@0.1.0-rc.1 "reason"
# 或把用户降回上一个版本：
npm install dsh-account-mesh@<previous>
```

Node 包一旦发布不能删除重发同名版本，只能发新版本或 `deprecate`。

## 6. 已知限制（发布说明里要写）

- 只读：没有写入、prompt、shell 或任意命令通道。
- 同账号自动信任默认开启；局域网内可冒充同账号，可关闭后手动信任。
- 一期只覆盖局域网与 Tailscale tailnet，不含跨公网。
- 同一 `DSH_HOME` 的两个进程 deviceId 相同，会被视为同一设备而互相忽略。
- 文件读取限制在工作区、会话 cwd 与 `allowRoots` 内，`realpath` 后校验；检查与打开之间的符号链接替换未完全消除。
- 本插件不设请求/连接/空闲期限，只跟随用户取消、真实错误与传输状态；发现层 20 秒只是「在线」判定。
