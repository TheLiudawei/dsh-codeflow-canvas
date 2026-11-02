/**
 * 日志事件模型（v1.2.2，需求三）——纯数据/纯函数，零 IO。
 *
 * 统一行结构（JSONL，一行一个对象）：
 *
 *     {"v":1,"ts":"2026-11-01T12:34:56.789Z","level":"info","event":"import.root",
 *      "pid":12345,"msg":"…","data":{…},"err":{"name","message","stack"}}
 *
 * 约定（任务书 §8.2）：
 *
 *   - `v` 固定 1；`ts` ISO 8601；`level` ∈ debug|info|warn|error；
 *   - `event` 白名单见 {@link EVENTS}（/api/log 只接受其中的客户端子集
 *     {@link CLIENT_EVENTS}，拒绝任意事件名）；
 *   - 单行 ≤8 KiB；`msg` ≤500 字符；`data` 浅层对象（深度 ≤4、键 ≤30、
 *     数组 ≤50 项、字符串 ≤1000 字符，路径形状的值 ≤300）；
 *   - 脱敏：data 的键名匹配 {@link SENSITIVE_KEY_RE}（prompt/message/content/
 *     body/authorization/cookie/token/secret/password/api-key…）时值替换为
 *     `[redacted]`——绝不记录提示词、源码、图 JSON、Cookie/Token；
 *   - 错误只留 `name` / `message`（截断）/ `stack`（截断 4000），绝不
 *     `JSON.stringify(error)` 整个对象。
 *
 * 依赖方向：L0，零 import（node 内建也不需要）。
 *
 * @module dsh-codeflow-canvas/logging/schema
 */

/** 宿主侧事件白名单（点分小写）。`log.host` 承接组合 logger 转发的
 *  宿主 warn/info 文本（如 store 落盘失败），其余按任务书 §8.2。 */
export const EVENTS = new Set([
  'plugin.start', 'plugin.stop', 'plugin.fatal',
  'http.request', 'http.error',
  'ui.action', 'ui.error', 'ui.selftest',
  'import.start', 'import.root', 'import.scan', 'import.persist',
  'import.coupling', 'import.done', 'import.fail',
  'cards.merge',
  'coupling.start', 'coupling.done', 'coupling.fail',
  'session.ensure', 'session.fail',
  'log.rotate', 'log.fallback', 'log.dropped', 'log.host',
])

/** 浏览器上报通道（POST /api/log）允许的事件子集。 */
export const CLIENT_EVENTS = new Set(['ui.action', 'ui.error', 'ui.selftest'])

/** 合法日志级别。 */
export const LEVELS = new Set(['debug', 'info', 'warn', 'error'])

/** data 键名命中即脱敏（大小写不敏感；`message` 只在 data 里脱敏，err.message 不受影响）。 */
export const SENSITIVE_KEY_RE = /prompt|message|content|body|authorization|cookie|token|secret|password|api[-_]?key/i

/** data 键名像路径时截断到 300（避免泄露完整目录结构）。 */
const PATHISH_KEY_RE = /path|dir|root|file|folder|cwd|workspace/i

const LIMITS = Object.freeze({
  maxLineBytes: 8 * 1024,
  maxMsg: 500,
  maxString: 1000,
  maxPathString: 300,
  maxDepth: 4,
  maxKeys: 30,
  maxArray: 50,
  maxStack: 4000,
  maxErrMessage: 300,
})

/** 字符串截断（带省略号标记，保证确定性行宽）。 */
export function truncateString(value, max) {
  const text = String(value ?? '')
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

/** 递归清洗 data：脱敏 + 截断 + 限深/限键/限数组。纯函数，不改输入。 */
export function sanitizeData(value, options = {}) {
  const depth = options.depth ?? 1
  const key = options.key ?? ''
  if (value === undefined) return undefined
  // 键名敏感 → 一律 [redacted]（先于任何值形状检查，原始值也不放过）。
  if (SENSITIVE_KEY_RE.test(key)) return '[redacted]'
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string') {
      const max = PATHISH_KEY_RE.test(key) ? LIMITS.maxPathString : LIMITS.maxString
      return truncateString(value, max)
    }
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
    if (typeof value === 'bigint') return String(value)
    if (typeof value === 'function') return '[function]'
    if (typeof value === 'symbol') return String(value)
    return value
  }
  if (SENSITIVE_KEY_RE.test(key)) return '[redacted]'
  if (depth > LIMITS.maxDepth) return '[depth]'
  if (Array.isArray(value)) {
    return value.slice(0, LIMITS.maxArray).map((item, i) => sanitizeData(item, { depth: depth + 1, key: `${key}[${i}]` }))
  }
  const out = {}
  let keys = 0
  for (const [k, v] of Object.entries(value)) {
    keys += 1
    if (keys > LIMITS.maxKeys) { out['[truncated]'] = '[keys]'; break }
    if (SENSITIVE_KEY_RE.test(k)) { out[k] = '[redacted]'; continue }
    out[k] = sanitizeData(v, { depth: depth + 1, key: k })
  }
  return out
}

/** 错误对象 → 安全形状（name/message 截断/stack 截断 4000）。 */
export function sanitizeError(error) {
  if (error === undefined || error === null) return undefined
  if (!(error instanceof Error)) {
    return { name: 'NonError', message: truncateString(String(error), LIMITS.maxErrMessage) }
  }
  return {
    name: truncateString(error.name ?? 'Error', 80),
    message: truncateString(error.message ?? '', LIMITS.maxErrMessage),
    ...(typeof error.stack === 'string' ? { stack: truncateString(error.stack, LIMITS.maxStack) } : {}),
  }
}

/**
 * 组装一行日志对象（不序列化——由 file-logger 统一 stringify 并限宽）。
 * 超白名单的 event 返回 `undefined`（调用方丢弃）。
 */
export function formatLine(event, { level = 'info', msg, data, err, pid = process.pid, clock } = {}) {
  if (!EVENTS.has(event)) return undefined
  const line = {
    v: 1,
    ts: new Date(typeof clock === 'function' ? clock() : Date.now()).toISOString(),
    level: LEVELS.has(level) ? level : 'info',
    event,
    pid,
  }
  if (msg !== undefined && msg !== null && String(msg).length > 0) line.msg = truncateString(String(msg), LIMITS.maxMsg)
  const cleanData = sanitizeData(data)
  if (cleanData !== undefined && cleanData !== null && Object.keys(cleanData).length > 0) line.data = cleanData
  const cleanErr = sanitizeError(err)
  if (cleanErr !== undefined) line.err = cleanErr
  return line
}

/** 一行是否超出单行字节上限（超出时由 file-logger 二次收缩 data）。 */
export function lineTooLarge(line) {
  return Buffer.byteLength(JSON.stringify(line), 'utf8') > LIMITS.maxLineBytes
}

/** 测试与调用方可读的上限。 */
export const SCHEMA_LIMITS = LIMITS
