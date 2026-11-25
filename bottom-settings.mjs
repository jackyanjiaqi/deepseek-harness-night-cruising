/**
 * Night Cruising bottom bar settings — the human-readable catalog.
 *
 * This module is the documentation of record for every row the workspace
 * footer exposes. The runtime catalog lives in the harness patch at
 * `packages/bundle/web-app/src/night-timeouts.ts`; keep the two in sync when
 * adding a row. Values persist to `$DSH_HOME/night-cruising/timeouts.json`
 * and are served over `GET/PUT /night-cruising/timeouts`.
 *
 * To add a row:
 * 1. Add the entry here with its unit, default, range and consumer.
 * 2. Add the same entry to `NIGHT_TIMEOUT_GROUPS` in `night-timeouts.ts`.
 * 3. If it is a duration consumed by `deadline()`, map its capability code in
 *    `DEADLINE_SETTINGS` (`packages/util/timeout/src/index.ts`). If it is a
 *    count, call `settingNumber(key, fallback)` at the consumer.
 *
 * Model request timeouts are intentionally absent: the repository policy
 * keeps model requests uncancellable except by the caller.
 *
 * @module night-cruising/bottom-settings
 */

/** Persisted values file. */
export const BOTTOM_SETTINGS_FILE = '$DSH_HOME/night-cruising/timeouts.json'

/** Authenticated same-origin route used by the footer. */
export const BOTTOM_SETTINGS_ROUTE = '/night-cruising/timeouts'

/**
 * @typedef {'ms' | 'count'} SettingUnit
 * `ms` renders as seconds, `count` renders as 次.
 */

/**
 * @typedef {object} BottomSetting
 * @property {string} key persisted key and `settingNumber` lookup key
 * @property {string} label footer label
 * @property {string} hint one-line explanation shown under the label
 * @property {SettingUnit} unit input unit
 * @property {number} default default value in the stored unit
 * @property {number} min lowest accepted value
 * @property {number} max highest accepted value
 * @property {string} consumer code path that reads the value
 * @property {boolean} [locked] repository-policy row, rendered read-only
 */

/**
 * @typedef {object} BottomSettingGroup
 * @property {string} id stable group id
 * @property {string} label section heading
 * @property {string} [hint] section explanation
 * @property {readonly BottomSetting[]} entries rows in display order
 */

/** @type {readonly BottomSettingGroup[]} */
export const BOTTOM_SETTING_GROUPS = [
  {
    id: 'waits',
    label: '等待与轮询',
    hint: '到期只返回当前状态，不终止在途任务。',
    entries: [
      {
        key: 'wait.job.default', label: '作业等待', unit: 'ms', default: 30_000, min: 1_000, max: 600_000,
        hint: 'job_output 未指定 timeout_ms 时的等待时长。',
        consumer: 'packages/jobs/tool-jobs/src/index.ts',
      },
      {
        key: 'wait.job.max', label: '作业等待上限', unit: 'ms', default: 600_000, min: 1_000, max: 86_400_000,
        hint: '单次 job_output 等待的硬上限。',
        consumer: 'packages/jobs/tool-jobs/src/index.ts',
      },
      {
        key: 'wait.agent.default', label: '子智能体等待', unit: 'ms', default: 30_000, min: 10_000, max: 3_600_000,
        hint: 'wait_agent 未指定 timeout_ms 时的等待时长。',
        consumer: 'packages/subagent/tool-subagent-control/src/wait-agent.ts',
      },
      {
        key: 'wait.agent.max', label: '子智能体等待上限', unit: 'ms', default: 3_600_000, min: 10_000, max: 86_400_000,
        hint: 'wait_agent 允许指定的最大等待时长。',
        consumer: 'packages/subagent/tool-subagent-control/src/wait-agent.ts',
      },
      {
        key: 'wait.session.default', label: '会话等待', unit: 'ms', default: 30_000, min: 1_000, max: 600_000,
        hint: '远端会话状态等待的默认时长。',
        consumer: 'packages/api/session-controller/src/state/controller.ts',
      },
    ],
  },
  {
    id: 'tools',
    label: '工具执行',
    hint: '0 表示不限制，只保留用户主动取消。',
    entries: [
      { key: 'tool.call', label: '工具调用', unit: 'ms', default: 0, min: 0, max: 86_400_000, hint: '工具声明的执行预算上限。', consumer: 'packages/guard/timeout-policy/src/index.ts' },
      { key: 'tool.bash', label: '命令执行', unit: 'ms', default: 0, min: 0, max: 86_400_000, hint: '单条 Shell 命令的运行上限。', consumer: 'packages/shell/bash-local/src/index.ts' },
      { key: 'tool.persistentBash', label: '持久终端命令', unit: 'ms', default: 0, min: 0, max: 86_400_000, hint: '持久 Bash/Pwsh 会话的单条命令上限。', consumer: 'packages/shell/tool-bash-persistent/src/index.ts' },
      { key: 'tool.worktree', label: '工作树操作', unit: 'ms', default: 0, min: 0, max: 86_400_000, hint: '创建、清理工作树的上限。', consumer: 'packages/experimental/worktree/src/process.ts' },
      { key: 'web.fetch', label: '网页抓取', unit: 'ms', default: 0, min: 0, max: 86_400_000, hint: '网页抓取请求的上限。', consumer: 'packages/web/web-fetch-http/src/provider.ts' },
    ],
  },
  {
    id: 'services',
    label: '服务维护',
    hint: '关闭与取消的收尾预算，避免退出时无限等待。',
    entries: [
      { key: 'lsp.shutdown', label: 'LSP 关闭', unit: 'ms', default: 10_000, min: 1_000, max: 600_000, hint: '关闭语言服务器时的等待上限。', consumer: 'packages/lsp/lsp-stdio/src/instance.ts' },
      { key: 'lsp.grace', label: 'LSP 取消宽限', unit: 'ms', default: 5_000, min: 1_000, max: 600_000, hint: '取消请求后等待进程退出的宽限。', consumer: 'packages/lsp/lsp-stdio/src/instance.ts' },
    ],
  },
  {
    id: 'observability',
    label: '运行观测',
    hint: '长跑任务的可见性阈值；0 表示立即可见。',
    entries: [
      {
        key: 'job.status.afterMs', label: '状态时长阈值', unit: 'ms', default: 300_000, min: 0, max: 86_400_000,
        hint: '作业运行/静默超过该时长后，状态行附带 running / idle。',
        consumer: 'packages/jobs/tool-jobs/src/render.ts',
      },
      {
        key: 'workflow.progress.interval', label: '子智能体心跳', unit: 'ms', default: 60_000, min: 1_000, max: 600_000,
        hint: 'workflow 子智能体刷新 job progress 的最小间隔。',
        consumer: 'packages/workflow/workflow-ptc/src/index.ts',
      },
    ],
  },
  {
    id: 'guard',
    label: '重复调用守卫',
    hint: '窗口计数覆盖 A/B 交替；阻断默认关闭。',
    entries: [
      { key: 'guard.repeat.enabled', label: '启用守卫', unit: 'count', default: 1, min: 0, max: 1, hint: '0 关闭，1 启用。', consumer: 'packages/guard/repeat-tool-reminder/src/index.ts' },
      { key: 'guard.repeat.window', label: '观察窗口', unit: 'count', default: 24, min: 4, max: 10_000, hint: '最近 N 次跟踪调用。', consumer: 'packages/guard/repeat-tool-reminder/src/index.ts' },
      { key: 'guard.repeat.windowThreshold', label: '窗口阈值', unit: 'count', default: 8, min: 2, max: 10_000, hint: '同签名在窗口内出现 N 次时提醒；后续按 N×2、N×4 升级。', consumer: 'packages/guard/repeat-tool-reminder/src/index.ts' },
      { key: 'guard.repeat.every', label: '重复提醒间隔', unit: 'count', default: 20, min: 1, max: 10_000, hint: '超过最大阈值后，每 +N 次再提醒。', consumer: 'packages/guard/repeat-tool-reminder/src/index.ts' },
      { key: 'guard.repeat.block', label: '重复阻断', unit: 'count', default: 0, min: 0, max: 1, hint: '0 仅提醒，1 在达到阻断阈值时拒绝该次调用。', consumer: 'packages/guard/repeat-tool-reminder/src/index.ts' },
      { key: 'guard.repeat.blockAfter', label: '阻断阈值', unit: 'count', default: 40, min: 1, max: 100_000, hint: '窗口/连续计数达到 N 时阻断（仅在重复阻断启用时生效）。', consumer: 'packages/guard/repeat-tool-reminder/src/index.ts' },
    ],
  },
  {
    id: 'policy',
    label: '模型请求',
    hint: '仓库政策：模型请求不设应用层超时，只保留用户主动取消。',
    entries: [
      { key: 'llm.request', label: '请求超时', unit: 'ms', default: 0, min: 0, max: 0, hint: '固定为不限制，不可编辑。', consumer: 'repository policy', locked: true },
    ],
  },
]

/** Default values keyed by setting key, in the stored unit. */
export const BOTTOM_SETTING_DEFAULTS = Object.freeze(Object.fromEntries(
  BOTTOM_SETTING_GROUPS.flatMap(group => group.entries.map(entry => [entry.key, entry.default])),
))

/**
 * Describe one setting for a log line or a test assertion.
 * @param {string} key persisted key.
 * @returns {string} `label=value unit (default …)` or an unknown-key notice.
 */
export function describeBottomSetting(key) {
  const entry = BOTTOM_SETTING_GROUPS.flatMap(group => group.entries).find(candidate => candidate.key === key)
  if (entry === undefined) return `${key}=<unknown>`
  const unit = entry.unit === 'count' ? '次' : '毫秒'
  return `${entry.label}=${String(entry.default)} ${unit}（默认；范围 ${String(entry.min)}–${String(entry.max)}）`
}
