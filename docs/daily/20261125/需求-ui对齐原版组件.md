# 需求 · account-mesh 面板 UI 对齐 DSH 原版组件

- 提出日期：2026-11-25
- 目标插件：`plugins/account-mesh`
- 相关日志：[开发日志](./开发日志.md)
- 状态：待排期（尚未实现）

## 1. 背景

account-mesh 的面板（`client.js`）是 2026-11-23 建插件时手写的：客户端只从共享模块表取了 React（`const React = require('react')`），Chip、按钮、页签、折叠块、复制按钮、Markdown 渲染全部手写，样式用 62 处 `var(--dsw-*)` 主题变量 + 内联样式对象。

好处是零依赖、`client.js` 直接作为 loader factory 加载、无需构建步骤；问题是控件语义与 DSH 原版存在细节差异：键盘与焦点处理、可访问性标签、按钮尺寸与 hover 态、Markdown 的代码块/链接/公式渲染质量等，都与宿主原生控件不完全一致。

`@deepseek-ai/dsh-client-ui-primitives` 已列在 Web 壳冻结模块表（`PLATFORM_MODULES`）中，`require('@deepseek-ai/dsh-client-ui-primitives')` 无需打包、无需构建步骤即可使用；其 CSS 由 shell 统一构建，运行时直接可用。

## 2. 目标

把 account-mesh 面板的**渲染层**迁移到宿主共享的 `@deepseek-ai/dsh-client-ui-primitives` + 主题 token，使面板控件与 DSH 原版在视觉与交互语义上一致；不改变任何只读数据面、协议、路由与 agent 工具行为。

非目标：

- 不引入构建步骤（保持 `client.js` 为裸 loader factory）。
- 不打包 ant-design 或任何第三方组件库；不新增依赖。
- 不改动 UI 之外的功能（sessions/index、缓存、强制刷新、版本互通、传输计数等保持现状）。
- 不做视觉改版或新功能；只做“对齐原版”。

## 3. 范围与映射

| 当前手写实现 | 目标组件（ui-primitives） | 备注 |
| --- | --- | --- |
| `Chip`（状态/版本/只读/缓存标记） | `Tag`（tone）、`Pill` | 版本徽标保持等宽字体样式 |
| `styles.button` / `styles.buttonPrimary` | `Button`（variant） | 保留禁用态与二次确认文案 |
| 会话/轨迹页签 `styles.tab` | `SegmentedTabs` | 保持 `aria-pressed` 语义 |
| 悬停详情（`title` 多行文本：设备/工作区/会话） | `Tooltip` 或 `HoverCard` | 多行 label/value 排版需自定义内容 |
| `ReasoningBlock` 折叠 | `DisclosureRow` | 默认展开规则不变 |
| `renderMarkdown`（约 70 行迷你实现） | `MarkdownText` | 需提供 labels/delegate 上下文；单独一批 |
| `CopyButton` + `copyText` | `Button` + primitives 剪贴板工具 | 保留复制成功/失败反馈 |
| 会话树行、分裂条、进度行容器 | 维持手写 | 树行/分裂条属布局，非控件 |

主题 token 继续使用 `--dsw-*`，不得引入写死的颜色/尺寸（现有 `--dsh-content-font-size` 等排版变量保留）。

## 4. 约束

1. 遵守仓库「去除所有超时」约定：UI 层不新增任何会中断在途请求的计时器；现有轮询节奏（state 2.5s、tree 15s）不变。
2. 客户端仍只通过 `window.__ModuleLoader__.load` 注册；`require` 仅允许共享模块表内的名字（react、react/jsx-runtime、primitives 等），不得 require 未在模块表中的第三方包。
3. 中英文案全部保留（`TEXT.zh` / `TEXT.en` + `locale/zh.json`），新增可见文本必须走 locale 服务。
4. 冒烟测试 `spike/p0-client.mjs`（含组件渲染断言）与 `spike/p0-apply.mjs`、`spike/p0-mesh.mjs` 必须 ALL PASS；`node scripts/preflight.mjs` 通过。
5. 改动后需实际刷新页面验证设置页与远端工作区面板（含窄宽度、分裂条拖拽、悬停详情），并记录验证结果。
6. 不修改 profile、不重装插件；link: 安装重启即可生效。

## 5. 分批计划

| 批次 | 内容 | 验收 |
| --- | --- | --- |
| P0 | `Tag` / `Pill` / `Button` / `SegmentedTabs` / `Tooltip` 替换对应手写控件 | 视觉与 DSH 原生一致；p0-client ALL PASS；页面手测 |
| P1 | `MarkdownText` 替换 `renderMarkdown`（会话正文、轨迹正文） | 代码块、行内代码、链接、列表、引用、标题、公式渲染正确；失败降级为纯文本 |
| P2 | `DisclosureRow` 替换 `ReasoningBlock`；`CopyButton` 换 `Button` + 剪贴板工具；统一图标改用 primitives 图标（设备/文件夹图标保留自绘） | 展开/收起、复制反馈、图标尺寸一致 |

每批独立可交付、可回退；P0 完成即可上线，P1/P2 依次跟进。

## 6. 验收标准

- 面板控件（按钮、页签、标签、悬停提示、折叠块）在外观与交互语义上与 DSH 原版一致，主题切换（浅色/深色）下无写死颜色。
- 所有既有功能回归通过：对端树、会话选择、对话/轨迹切换、复制会话 ID、强制刷新、缓存标记、数据总量、设置页版本徽标、对端版本与传输计数。
- 无新增依赖；无构建步骤；`client.js` 语法检查通过。
- 冒烟测试 ALL PASS，preflight 通过。
- 窄窗口（树面板 240px）与分裂条拖拽下布局不破。

## 7. 风险与回退

| 风险 | 应对 |
| --- | --- |
| primitives 组件 props 与手写实现不完全等价，交互细节变化 | 逐组件替换、逐批验证；保留手写实现于提交前分支，必要时整批回退 |
| `MarkdownText` 需要 labels/delegate 上下文，接入成本高于预期 | 单独一批；不可用时先回退到现有 `renderMarkdown`，不阻塞 P0 上线 |
| 样式由 shell 构建，若某些 CSS module 未覆盖到 | 实测主题切换与窄宽度；必要时用内联 token 样式补齐容器布局 |
| 手写图标与 primitives 图标风格不一致 | 图标最后统一，优先保证控件一致 |

## 8. 交付

- 代码：`plugins/account-mesh/client.js`（渲染层）。
- 测试：扩展 `spike/p0-client.mjs` 对新组件的渲染断言。
- 文档：本需求文档 + 当日开发日志追加“实现结果”小节。
