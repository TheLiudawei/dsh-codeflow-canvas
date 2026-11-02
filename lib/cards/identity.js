/**
 * 卡片身份（v1.3.0，需求三）——任务卡片的**稳定标识**，纯函数。
 *
 * `cardKeyOf(node)` 给出一张卡片跨导入的稳定 key；重新导入时 `mergeCards`
 * 用它把旧卡片的运行状态/结果/位置/用户修改附着到新扫描的节点上。
 *
 * 规则（按顺序）：
 *
 *   0. `node.meta.cf.key` 是合法字符串 → **直接返回**（手工节点改标题后
 *      key 必须保持不变——key 一旦写入就不再重算）；
 *   1. `module` 节点：`module:<归一化 path>:<symbol 或 ''>`；
 *   2. 固定流程节点（scan / comments）：`flow:<type>`；
 *   3. 导入型任务节点（edit/testgen/review/deliver）：`task:<type>:<源锚点>`，
 *      源锚点依次取 params.instruction 里的 `文件(:行)`、`标记`、params.path，
 *      都没有时用归一化标题的哈希；
 *   4. 其余（手工 / agent 创建）：`manual:<type>:<归一化标题哈希>`。
 *
 * 归一化：路径分隔符统一 `/`；Windows 不区分大小写（POSIX 区分）；标题
 * NFC + 折叠连续空白。哈希是 FNV-1a 32 位十六进制——确定性、无依赖，
 * 只用于配对，不是安全原语。
 *
 * 依赖方向：L0 数据层——零 import（被 tests/cards.mjs 直接单测）。
 *
 * @module dsh-codeflow-canvas/cards/identity
 */

/** 导入型任务节点类型（源锚点来自扫描结果）。 */
export const IMPORTED_TASK_TYPES = new Set(['edit', 'testgen', 'review', 'deliver'])

/** 固定流程节点（每次导入固定出现一份）。 */
export const FLOW_TYPES = new Set(['scan', 'comments'])

/** 标题归一化：NFC、折叠空白、去首尾。 */
export function normalizeTitle(title) {
  return String(title ?? '').normalize('NFC').replace(/\s+/g, ' ').trim()
}

/** 路径归一化：分隔符统一 `/`；win32 不区分大小写。 */
export function normalizePathKey(value, platform = process.platform) {
  const text = String(value ?? '').normalize('NFC').replace(/\\/g, '/').trim()
  return platform === 'win32' ? text.toLowerCase() : text
}

/** FNV-1a 32 位哈希（十六进制；确定性配对用）。 */
export function hashKey(text) {
  const input = String(text ?? '')
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * 从导入型任务的 params 里解析「源锚点」：
 * instruction 里的 `文件(:行)` → instruction 里的 `标记` → params.path →
 * 归一化标题哈希。
 */
export function sourceAnchorOf(node, platform = process.platform) {
  const instruction = String(node?.params?.instruction ?? '').trim()
  if (instruction.length > 0) {
    // 文件（:行）：一个带扩展名的路径形 token；容忍 `src/a.py:12 修复…`。
    const file = /((?:[A-Za-z]:)?[^\s:；，,]+?\.[A-Za-z0-9]+)(?::(\d+))?/.exec(instruction)
    if (file) {
      const line = file[2] ? `:${file[2]}` : ''
      return normalizePathKey(file[1], platform) + line
    }
    // 标记：TODO / FIXME / HACK / NOTE 开头 → 标记 + 指令哈希。
    const marker = /^(TODO|FIXME|HACK|NOTE)\b/i.exec(instruction)
    if (marker) return `marker:${marker[1].toUpperCase()}:${hashKey(normalizeTitle(instruction))}`
  }
  const path = typeof node?.params?.path === 'string' && node.params.path.trim().length > 0
    ? normalizePathKey(node.params.path, platform)
    : null
  if (path) return path
  return `title:${hashKey(normalizeTitle(node?.title))}`
}

/** 合法的手写 key：非空字符串（写入 meta.cf.key 后不再重算）。 */
export function isValidPersistedKey(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * 计算一张卡片的稳定标识（见模块头注释的规则表）。**绝不修改输入**。
 *
 * @param node - 画布节点（普通对象）。
 * @param options.platform - 平台（默认 process.platform；测试可固定）。
 * @returns 稳定 key 字符串。
 */
export function cardKeyOf(node, options = {}) {
  const platform = options.platform ?? process.platform
  const cf = node?.meta && typeof node.meta === 'object' ? node.meta.cf : undefined
  if (cf && typeof cf === 'object' && !Array.isArray(cf) && isValidPersistedKey(cf.key)) {
    return cf.key
  }
  const type = String(node?.type ?? '')
  if (type === 'module') {
    const path = normalizePathKey(node?.params?.path, platform)
    const symbol = typeof node?.params?.symbol === 'string' ? node.params.symbol.trim() : ''
    return `module:${path}:${symbol}`
  }
  if (FLOW_TYPES.has(type)) return `flow:${type}`
  if (IMPORTED_TASK_TYPES.has(type)) return `task:${type}:${sourceAnchorOf(node, platform)}`
  return `manual:${type}:${hashKey(normalizeTitle(node?.title))}`
}

/** 导入时写入 `node.meta.cf` 的快照（title / params 哈希用于变更检测）。 */
export function cardMetaOf(node, options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString()
  return {
    key: cardKeyOf(node, options),
    importedTitle: String(node?.title ?? ''),
    importedParamsHash: hashKey(stableParamsText(node?.params)),
    stale: false,
    mergedAt: now(),
  }
}

/** params 的稳定序列化（键序无关：排序后再序列化）。 */
export function stableParamsText(params) {
  if (params === undefined || params === null || typeof params !== 'object' || Array.isArray(params)) {
    return JSON.stringify(params ?? null)
  }
  const keys = Object.keys(params).sort()
  const body = keys.map((key) => `${JSON.stringify(key)}:${JSON.stringify(params[key] ?? null)}`).join(',')
  return `{${body}}`
}
