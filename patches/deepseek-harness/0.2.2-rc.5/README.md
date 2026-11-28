# 0.2.2-rc.5-fixing：迁移版补丁集

- 基线：`9c2670d3bce5275e0d1610272958121af87787bb`
- 结构：**1 个资源目录补丁 + 5 个业务 diff 补丁**
- 重放结果：与旧 19 补丁集的最终树 **逐字节一致**（tree `ecc4cf0e…`）
- 验证：`pnpm patch:verify` → `重放通过：6 个补丁`

## 1. 结构

| 补丁 | 形式 | 文件数 | 业务 | 吸收的旧补丁 |
| --- | --- | ---: | --- | --- |
| `000-night-cruising-assets` | `.dir.patch` | 4 | 二进制资源（2×jpg、wav、png 图标），整文件存放，不做 diff | 000 010 |
| `001-packaging-and-desktop` | diff | 25 | 打包、Linux 运行时、deb/AppImage、Windows 预检、桌面发布脚本、vitest 配置 | 001 005 007 008 009 014 |
| `002-night-cruising-ui` | diff | 16 | 主题、欢迎页、底部栏前端、视图选择、点击外部关闭、保险柜栏 | 003(主题) 011 013(前端) 016 017 |
| `003-timeout-policy` | diff | 39 | 超时注册表、Shell/Job/MCP/子 agent/会话等待、底部设置存储、守卫、SDK 依赖补丁 | 002 004 006(SDK) 012 015 018 |
| `004-session-titles` | diff | 18 | 标题生成、会话统计（TPS 可信度）、bundle 配置、boot、workflow、SDK server | 003(标题) 004 |
| `005-test-infrastructure` | diff | 184 | `apps/web` e2e 夹具、stress、vitest、Python SDK、脚本夹具 | 006(测试) |

代码补丁都是**基线 → 最终**的净差异，文件集合互不重叠；二进制只出现在 `000` 的 `files/` 下，任何 `.patch` 里都不会出现 `GIT binary patch` 或 base64 媒体。

## 2. 升级 DSH 主版本

1. 根 `package.json` 的 `patches-tools.versions` 增加新版本 → 新基线 commit，并切 `patches-tools.version`。
2. 复制本目录为 `patches/deepseek-harness/<新版本>-fixing/`。
3. 资源：把 `000-night-cruising-assets/files/` 覆盖到新树，重建 `meta.json`（`added` 4 项、`before` 留空）。
4. 代码：按 `manifest.json` 的分组文件清单，对每个业务组生成净差异：

   ```sh
   git -C <编辑副本> diff --binary --full-index --no-renames \
     <新基线> <目标树> -- $(jq -r '.groups["003-timeout-policy"][]' manifest.json)
   ```

5. `pnpm patch:verify --version <新版本>`；冲突只可能出现在该组自己的文件里，不会出现补丁间上下文叠加。
6. 文件增删时同步更新 `manifest.json`。

## 3. 约定

- 二进制资源只进 `000-night-cruising-assets.dir.patch`；代码改动一律走普通 diff 补丁，保证可 review、可按业务回滚。
- 运行时超时的唯一真值源是 `packages/util/timeout/src/registry.ts`；新增能力只加一条规则加一行底栏。
- `pnpm check:timeouts` 校验：未注册 code、无界等待、wait 规则缺底栏行。
