# session-8b340fbc 超长异常诊断报告

- **日期**：2026-11-25
- **诊断对象**：`session-8b340fbc-2bab-44a7-84ce-f7b0e705ca69`
  - cwd：`/Volumes/TennisPrince ExtDisk/Workspace`，preset `standard`
  - 主智能体模型：`deepseek-account / deepseek-flash`（contextWindow 1,048,576）
  - 子智能体模型：`mlx-serve / ddalcu/DeepSeek-V4.1-Flash-1017-MLX-Serve-iQ-MLX-3.0bpw`（用户指定）
  - 任务：复刻 SteelTide 风格的 3D 海战单机合作游戏 → 产出 `IronTide/`
- **数据快照**：2026-11-25 20:00:58（`turn/end` 落盘后解压）
- **数据来源**：`~/.dsh/sessions/--Volumes-TennisPrince~0020ExtDisk-Workspace--/` 下 5 个 `session.v4.jsonl.zstd`（主会话 + 2 个长跑子会话 + 2 个短子会话）
- **结论等级**：现象、时序、计数均已从原始事件逐条核对；「等待为何不超时」「为何守卫不生效」已定位到补丁与源码行；本地模型为何退化为重复环只有间接证据（见 §8）

---

## 0. 结论（TL;DR）

这次会话“超长”的不是某一条消息或某一段日志，而是**两段合计 17 小时 37 分的阻塞等待，占整个 turn 的 98.5%**。阻塞期间子智能体并不是“卡死无响应”，它在持续跑——但陷入了**退化重复环**：同一个调试命令被逐字重发上千次、零推理、零新信息。三层保护同时缺位，最终只能由用户手动插话解锁：

| 层级 | 应有的作用 | 实际表现 |
| --- | --- | --- |
| 重复调用守卫 `repeat-tool-reminder` | 提醒模型换做法 | 只提醒不否决；阈值止于 `[3,5,8]`，第 8 次后永久静默；只比较“连续相同”，A/B 交替完全绕过 |
| 操作超时 `deadline()` | 让 `job_output` 的 `timeout_ms` 到期返回 | 被本地补丁 `002-disable-operation-timeouts.patch` 改成 **no-op**，`timeout_ms` 形同虚设 |
| 进度可见性 | 父智能体能看见子智能体在做什么 | workflow 进度写入 job ring 的 `log` 通道，而 `job_output` **过滤掉 `log` 通道**，父会话永远只看到 `(no new output)` |

由此串成完整事故链：

```
本地模型退化重复环（1276 次同一调用）
  → 守卫只提醒、8 次后静默（tier0 则被 A/B 交替绕过，0 次提醒）
  → 子智能体无步数上限，1400 步照跑
  → 父会话 job_output wait 因 deadline 被阉割而永不到期
  → 父会话看不到任何进度输出
  → 用户只能凭墙钟发现异常，手动插话才会解锁
```

---

## 1. 诊断对象与数据画像

| 会话 | 角色 | 事件数 | 原始 JSONL | 磁盘 zstd | 步数 | 工具调用 | 墙钟时长 | 结局 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `session-8b340fbc` | 主会话 | 1,267 | 3.57 MB | 1.06 MB | 144 | 187 | 17h53m（turn） | 完成交付 |
| `815c0476`（child） | Tier-0 实现子智能体 | 6,045 | 12.15 MB | 3.38 MB | 872 | 873 | **6h30m** | cancelled |
| `93833d09`（child） | 修复轮子智能体 | 9,878 | 12.86 MB | 4.18 MB | **1,400** | 1,401 | **11h06m** | cancelled |
| `3e00e135`（child） | 设计评审子智能体 | 38 | 0.24 MB | 60 KB | 4 | 2 | 85 s | completed |
| `12b9bdb9`（child） | 路由探针子智能体 | 19 | 0.06 MB | 18 KB | 1 | 1 | 4.4 s | completed |

一个游戏复刻任务产生了 **28.9 MB 原始会话日志**（磁盘 8.7 MB）。两个短子会话（评审 85 s、探针 4.4 s）证明工作流与本地模型链路本身可用；两个长子会话则是同一台本地模型在长任务上的退化。

主会话自身统计：4 次 workflow、2 次用户插话、9 条 user message、126 个 job 注册。

---

## 2. 时间线（Asia/Shanghai）

| 时间 | 事件 |
| --- | --- |
| 11-24 01:17:15 | 会话创建，随后静置约 24.8 h（`session/end-seed` 到首条用户消息） |
| 11-25 02:07:21 | 用户下达海战游戏需求，turn 开始 |
| 02:11:51–02:11:55 | `local-route-probe` 工作流，4.4 s，验证本地 MLX 路由可用 |
| 02:13:54–02:15:19 | `irontide-design-review` 工作流，85 s，完成 |
| 02:15–02:17 | 主智能体写 `DESIGN.md` / `REVIEW.md` / `IMPLEMENTATION_BRIEF.md`，启动 Tier-0 实现工作流 |
| **02:17:09 → 08:47:42** | **卡死 #1**：`job_output(wait=true, timeout_ms=120000)` 实际阻塞 **6h30m33s**，由用户插话解除 |
| 08:47:48 | 主智能体 `job_kill` 终止 Tier-0 工作流 |
| 08:48–08:49 | 主智能体验收（31/31 单测）、写 `PLAYTEST_REVIEW.md`、启动修复轮工作流 |
| **08:49:20 → 19:56:04** | **卡死 #2**：`job_output(wait=true, timeout_ms=180000)` 实际阻塞 **11h06m44s**，由用户插话解除 |
| 19:56:06 | 主智能体 `job_kill` 终止修复轮 |
| 19:56–20:00:58 | 4 分钟内完成验收、浏览器测试、`README.md` / `TEST_REPORT.md` / `POSTMORTEM.md` 并结束 turn |

**turn 总长 64,417 s，两段阻塞合计 63,437 s（98.5%）**。其余所有工作（设计、评审、验收、修复、文档、测试）挤在约 16 分钟里完成。

---

## 3. 两处卡死现场

### 3.1 卡死 #1：Tier-0 实现（step 74）

- 调用：`job_output({job_id:"workflow-20318fc3cfd04f5a", wait:true, timeout_ms:120000})`
- 期望：2 分钟后返回状态（工具描述原文：*"Block until the job finishes or the timeout expires; a timed-out wait leaves the job running"*）
- 实际：**6h30m33s** 后返回，触发者是用户消息「提示子agent已经进行了6个半小时 尽快完成输出」
- 返回体：

```
(no new output)
[status: running, implementation; user steered]
```

主智能体当时的推理（原文节选）说明它完全按工具契约行事、并主动避免了忙轮询：

> "We shouldn't busy-poll ... Let's wait 60s with job_output wait true."

它被自己的工具骗了：`wait:true` 从此不再返回。

### 3.2 卡死 #2：修复轮（step 91）

- 调用：`job_output({job_id:"workflow-1faf786fe88b4d6b", wait:true, timeout_ms:180000})`
- 实际：**11h06m44s** 后返回，触发者是用户消息「已经运行18个小时了 为何没有输出」
- 返回体：`(no new output)` / `[status: running, focused fixes; user steered]`
- 主智能体推理已经预判了观测缺陷，却仍然只能赌 `wait` 会到期：

> "But job output likely only final; not progress. The workflow UI may stream progress but tool output only final. ... Let's wait maybe 120s via job_output; if no output, inspect file mtimes."

### 3.3 两次卡死的共同结构

两次都是「**单次长 wait** + **子智能体长时间无进度输出** + **无任何到期机制**」。两次都只在用户插话时返回，返回后主智能体立刻 `job_kill`——说明它一旦拿到控制权就会处理，只是永远拿不到。

---

## 4. 根本原因链

### 4.1 触发层：本地模型陷入退化重复环

子智能体不是挂起，而是**快节奏地重复同一个动作**。

| 指标 | Tier-0 子智能体（`815c0476`） | 修复轮子智能体（`93833d09`） |
| --- | --- | --- |
| 步数 / 工具调用 | 872 / 873 | 1,400 / 1,401 |
| 每步中位耗时 | 12.5 s | 26.0 s |
| 重复环区间 | step 300 → 871（03:18:21 → 08:47:14，5h28m） | step 124 → 1399（09:14:03 → 19:54:55，10h41m） |
| 重复形态 | **A/B 两条命令严格交替**（加 hook / 去 hook），284 + 281 = **565 次**，占 873 次调用的 **64.7%** | **同一条命令 1,276 次**，占 1,401 次调用的 **91.1%** |
| 结果多样性 | 13 种归一化输出 | **1 种**（1,276 次全部相同） |
| 期间推理文本 | 0 字 | 0 字 |
| 重复调用导致的日志膨胀 | 1.75 MB（14.4%） | 2.28 MB（17.7%） |

Tier-0 的 A/B 交替序列实测为 `AABABABABA...`，565 次里 **564 次发生切换**——它们永远不构成“连续相同”，因此绕过了按连续计数工作的守卫。

修复轮那条被重放 1,276 次的命令（节选）：复制 `tests/browser.mjs` → `tests/_dbg.mjs`，注入一段打印舵角/航向的 `console.log`，跑 200 s 超时的浏览器测试，grep `DBG|FAIL`，删除临时文件。归一化后每次输出都是同一行 `FAIL 3 heading change ...`——**模型反复观察同一个失败，却从不修改代码**。该子智能体最后一次源码写入是 09:08:28，之后 10h46m 没有任何文件变更，直到被父会话 kill。

### 4.2 守卫层：`repeat-tool-reminder` 的四个盲区

源码：`packages/guard/repeat-tool-reminder/src/index.ts`

1. **纯建议，不否决**：`ctx.on('tools/post-execute', ...)` 只把提醒塞进 `additionalContexts`，注释明确写 "Observe-and-enrich, never veto"（`index.ts:216-225`）。
2. **只比较“连续相同”**：`Chain{key,count}` 每次调用不同 key 就重置（`index.ts:196-205`）。A/B 交替 → count 永远在 1 和 2 之间，**一次提醒都不会触发**。Tier-0 的 5.5 小时重复环正是这样零提醒地跑完的。
3. **阈值封顶在 8**：默认 `thresholds = [3,5,8]`（`index.ts:53`），命中即 `thresholdSet.has(count)`，第 9 次之后**永久静默**。修复轮实测只在 09:10–09:17 收到 4 条提醒（count=3 两次、count=5、count=8），此后上千次重复再无任何干预。
4. **无终止能力**：即使提醒送达，也没有升级路径（阻断调用、要求换参、终止子智能体）。

### 4.3 边界层：没有任何步数/迭代上限

本 build 的 agent loop、subagent、workflow 均无 `maxSteps` 类配置。1,400 步、11 小时的子智能体在机制上完全合法。这与根 `AGENTS.md` 的「不设置总请求数/累计用量门控」政策一致，但结果是单个退化会话可以无限延长。

### 4.4 等待层：`deadline()` 被本地补丁改成 no-op

这是“为什么不超时”的直接答案。

`packages/util/timeout/src/index.ts:89-98`（当前运行的 build）：

```ts
export function deadline(upstream, timeoutMs, code): Deadline {
  // Local desktop policy: only the caller can cancel work.
  void timeoutMs
  void code
  return { signal: upstream ?? new AbortController().signal, [Symbol.dispose]() {} }
}
```

`clampTimeout()` 同样恒返回 `MAX_TIMER_DELAY_MS`（`index.ts:39-51`）。来源是仓库补丁 `patches/deepseek-harness/0.2.2-rc.5/002-disable-operation-timeouts.patch`（5,031 行、241 个文件），它把 `job_output` 的等待缺省/上限改成 `Math.max(..., 2_147_483_647)`（约 24.8 天）：

```diff
-    waitTimeoutMs: z.number().min(1).default(30_000),
-    maxWaitTimeoutMs: z.number().min(1).default(600_000),
+    waitTimeoutMs: z.number().min(1).default(Math.max(30_000, 2_147_483_647)),
+    maxWaitTimeoutMs: z.number().min(1).default(Math.max(600_000, 2_147_483_647)),
```

于是 `job_output` 的 `timeout_ms` 经 `Math.min(...)` 后仍是原值（180000），传入 `jobs.wait` 后由 `deadline()` 丢弃；`waitJob` 的 `new Promise` 只剩两个出口——**job 结算**或**上游 signal abort**（`jobs-local/src/index.ts:507-539`）。用户插话正是那条 abort（`tool-jobs/src/index.ts:484-506` 把 `source.kind==='user'` 的 current-step 输入当作释放信号）。这解释了为何两次卡死的结束时间与用户插话相差不到 3 秒：卡死 #1 的 tool/result 紧随 `next-step` 注入仅 1 ms，卡死 #2 为 2 s。

**文档与行为不一致**：工具描述仍承诺"Block until the job finishes or the timeout expires"（`tool-jobs/src/index.ts:439-440`），模型据此规划，必然踩坑。

### 4.5 观测层：进度写在 `log` 通道，而 `job_output` 过滤 `log`

- workflow 的实时进度以 `channel: 'log'` 写入 job ring（`workflow/tool-workflow/src/record.ts:44,47,50,53`），注释写明 “observer-only narration the model's `job_output` never renders”。
- `job_output` 渲染时显式过滤：`const visible = chunks.filter(chunk => chunk.channel !== 'log')`（`jobs/tool-jobs/src/render.ts:76`）。
- 该镜像只在 `workflow/phase`、`workflow/log`、`agent-start/end` 三个时机写 ring；父会话的脚本只在开头调用过一次 `phase('implementation')`，之后 6.5 小时里没有任何 `log()`，更没有“子智能体单步心跳”。

结果：父会话在 17.6 小时里每次读到的都是 `(no new output)`；这段 narration 按设计只面向 GUI 的 job 视图，模型侧拿不到。观测断层让唯一的发现渠道退化为“用户看墙钟”。

---

## 5. 影响量化

| 维度 | 数值 |
| --- | --- |
| turn 总墙钟 | 17h53m（64,417 s） |
| 阻塞在 2 次 `job_output` | 17h37m（63,437 s，**98.5%**） |
| 真正做事的墙钟 | ≈16 min（设计 2 min + 验收/修复/文档/测试 14 min） |
| Tier-0 产出 | 02:18–02:49 建成可玩版本（31 min），之后 5.5 h 探测环无持久改动 |
| 修复轮产出 | 08:50–09:08 有效改动 6 个文件，之后 10h46m 零变更 |
| 子智能体总步数 | 2,272 步，其中重复环 1,841 步（81%） |
| 会话日志总量 | 28.9 MB 原始 / 8.7 MB 磁盘；重复调用贡献 ≈4.0 MB |
| 用户干预 | 2 次插话，均为“为什么这么久/没输出” |

注：两个子会话最终都以 `cancelled` 结束，其“产出”由父会话在最后 4 分钟内以自有测试（31/31 + 浏览器 5 轮）补齐，任务本身交付成功——本报告诊断的是**过程异常**，不是交付失败。

---

## 6. 复现与取证方法

解压任意会话（本机无 `zstd` CLI，用 Node 26 内置 zstd）：

```bash
node -e "const fs=require('fs'),z=require('zlib');
const b=z.zstdDecompressSync(fs.readFileSync(process.argv[1]));
fs.writeFileSync('/tmp/s.jsonl',b);console.log(b.length)" \
  ~/.dsh/sessions/--Volumes-TennisPrince~0020ExtDisk-Workspace--/session-8b340fbc-2bab-44a7-84ce-f7b0e705ca69/session.v4.jsonl.zstd
```

关键取证点：

```bash
# 1) 两段卡死：step/end 与 step/start 的 6.5h / 11.1h 差
#    → session.jsonl 中 data.step === 74 与 91 的 step/start、step/end

# 2) 等待为什么解锁：插话后 1 ms–2 s 内出 tool/result，内容含 "user steered"
grep -n "user steered" /tmp/s.jsonl

# 3) 超时被阉割
sed -n '89,98p' .build/harness-a1c6d40c490dbcc7/packages/util/timeout/src/index.ts
grep -n "2_147_483_647" patches/deepseek-harness/0.2.2-rc.5/002-disable-operation-timeouts.patch | head

# 4) log 通道被过滤
sed -n '75,84p' .build/harness-a1c6d40c490dbcc7/packages/jobs/tool-jobs/src/render.ts

# 5) 重复环：子会话里同一 arguments 的调用次数
#    → 815c0476: 284 + 281 交替；93833d09: 1276 次同一命令
```

---

## 7. 修复建议

> 前提：根 `AGENTS.md` 禁止「应用层大模型请求超时、输出长度上限、请求数/用量门控」。下列 P0/P1 都不终止在途任务、不限制模型输出、不按用量门控，因此不与该政策冲突；唯一有政策张力的是 P1-2 的硬阻断，需显式确认后再做。

### P0-1 让 `job_output` 的等待真实到期（不改任务生命周期）

- 在 `tool-jobs` 内为 wait 实现自己的、**不依赖被阉割 `deadline()`** 的返回机制（例如 `Promise.race([jobs.wait(...), timer])`），到期返回 `(no new output)` + `[status: running, …]`，**只返回状态，绝不 kill**。
- 或退一步：把工具描述改成事实（"只在结算或用户插话时返回"），并要求模型用 `wait:false` 轮询。二者必须居其一，不能维持“文档承诺超时、实现永不到期”。
- `job_output` 的等待属于**轮询便利**，不是模型请求超时，不应被 `002-disable-operation-timeouts.patch` 覆盖；建议在补丁里为 jobs 等待显式豁免并加注释。

### P0-2 重做重复调用守卫（`repeat-tool-reminder`）

1. **窗口化签名检测**：除连续计数外，维护最近 N 次调用的多重集合；若窗口内某签名出现 ≥ 阈值次数（覆盖 A/B 交替），同样触发。
2. **递增提醒而非封顶**：阈值改为 `[3,5,8,16,32,...]` 或达到上限后按固定间隔（如每 +20 次）重复提醒，绝不进入永久静默。
3. **提醒内容落地为可检验要求**：要求模型先引用上一条结果的差异，再换参数/换做法，否则下一条提醒升级。
4. **升级通道**（不含终止）：把重复状态写进 job status 行进而让父智能体看到（见 P1-1）；把“同一命令已重复 N 次”的通知发给父会话的 next-step 输入。

### P1-1 打通模型侧进度可见性

- `renderModelDelta` 不再整体丢弃 `log` 通道：可只渲染**节流后的摘要**（每 30–60 s 最多一行，如 `[progress] running 1h20m · step 1240 · last file change 45m ago`），既不改压缩/去重语义，也让父会话不再是瞎子。
- 对单子智能体长跑，补充 `agent-step` 心跳（目前镜像只有 start/end，单步长跑期间为空）。

### P1-2 无进展检测（需要政策确认后决定是否硬阻断）

- 子智能体 N 分钟无文件写入 / 结果哈希不变 / 连续 M 步无新文件 → 注入强提醒，并在 job status 标注 `no-progress`。
- 若确认允许，可给 workflow 的 `agent()` 增加可选的 `maxSteps`（默认关闭；属于任务边界而非用量门控，但需与 AGENTS.md 对齐并写进文档）。

### P2 观测与提示词

- 会话日志增加 stall 标记事件（相邻事件间隔 > 10 min），便于事后诊断与 GUI 提示。
- 给本地模型子智能体的任务书加硬约束：「同一命令最多重试 3 次；仍失败则换思路或上报阻塞」，并在 workflow 提示中禁止“200 s 浏览器测试 + grep 一行输出”的探测式循环。
- 采集 MLX serve 侧每次请求的延迟/token/采样参数（见 §8）。

**优先级排序理由**：P0-1 直接把 17.6 h 的不可控阻塞变成“2 分钟后拿到状态、由模型决策”，收益最大且零政策冲突；P0-2 治本，防止同类退化再次发生；P1-1 让父智能体能自己发现异常，减少对用户墙钟的依赖。

---

## 8. 未决问题与后续采集

1. **本地模型为何退化**：两段重复环期间推理文本为 0，模型只输出同一个 tool-call。可能是长上下文下的退化、缺少 repetition penalty、或 tool-call 解析后丢掉 reasoning。当前没有 MLX serve 侧请求日志，无法定论——建议下一步采集该端点的 usage/latency/采样参数。
2. **子会话上下文规模**：两个子会话分别 6045 / 9878 事件，后期上下文很可能接近本地模型窗口上限；是否需要为本地模型启用压缩（`packages/compaction`）值得单独评估。
3. **是否曾发生主机休眠**：已排除。卡死期间子会话以 12.5 s / 26.0 s 的稳定步进持续写盘，父进程的 job registry 也持续收到事件——不是计时器被系统冻结。
4. **策略边界**：`AGENTS.md` 的“无超时”针对**大模型请求**；本次受害的是 `job_output` 等待。建议在政策文档里显式区分「请求/输出/预算」与「等待/轮询/进度通知」，避免下次再被同一补丁误伤。
5. **用户指定本地模型的约束**：本任务的“必须由本地模型编码”是用户硬要求，退化风险属预期内；harness 侧应把该风险转化为可观测状态与可恢复路径，而不是交由用户守夜。

---

## 附录 A · 关键事件索引（主会话）

| seq | step | 时间 | 事件 |
| ---: | ---: | --- | --- |
| 3 | — | 11-25 01:55:29 | `session/end-seed`（此前静置 24.8 h） |
| 4–12 | 1 | 02:07:21 | 首条用户需求 + turn 开始 |
| 654, 660 | 71 | 02:17:08 | `irontide-tier0-implementation` run/agent 启动 |
| 667–670 | 74 | 02:17:09–12 | `job_output` wait=true, timeout=120s |
| 671 | 74 | 08:47:39 | 用户插话「子agent已经进行了6个半小时」 |
| 674 | 74 | 08:47:42 | tool/result：`(no new output) [user steered]` |
| 700–701 | 74 | 08:47:48 | 工作流 agent-end / run-end `cancelled` |
| 828, 834 | 90 | 08:49:20 | `irontide-fix-round-1` 启动 |
| 838 | 91 | 19:56:02 | 用户插话「已经运行18个小时了 为何没有输出」 |
| 841 | 91 | 19:56:04 | tool/result：`(no new output) [user steered]` |
| 853–854 | 91 | 19:56:06 | 修复轮 `cancelled` |
| 1260–1265 | 144 | 20:00:50–20:00:58 | 交付文档 + `turn/end` |

## 附录 B · 数据文件位置

```
~/.dsh/sessions/--Volumes-TennisPrince~0020ExtDisk-Workspace--/
├── session-8b340fbc-2bab-44a7-84ce-f7b0e705ca69/   # 主会话 1.06 MB
├── 815c0476-3017-4303-873e-fdf9b2f8ddcc/           # Tier-0 子会话 3.38 MB
├── 93833d09-3f23-48ba-91cc-e983db1412a1/           # 修复轮子会话 4.18 MB
├── 3e00e135-2da0-4ffc-899b-af8a307332f7/           # 评审 60 KB
└── 12b9bdb9-ed11-4d3a-ac5e-ec4c642ee49b/           # 探针 18 KB
```

相关代码（本地 build 检出 `.build/harness-a1c6d40c490dbcc7/`）：

- `packages/util/timeout/src/index.ts:89` — `deadline()` no-op
- `packages/jobs/tool-jobs/src/index.ts:439,506` — 工具描述承诺 + wait 调用
- `packages/jobs/jobs-local/src/index.ts:507` — `waitJob()` 仅两个出口
- `packages/jobs/tool-jobs/src/render.ts:76` — 过滤 `log` 通道
- `packages/workflow/tool-workflow/src/record.ts:44` — 进度写 `log` 通道
- `packages/guard/repeat-tool-reminder/src/index.ts:53,196,220` — 阈值/连续计数/仅建议
- `patches/deepseek-harness/0.2.2-rc.5/002-disable-operation-timeouts.patch` — 超时禁用补丁
