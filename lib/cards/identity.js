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
 * 被认可的源码文件扩展名（小写、不含点）。
 *
 * v1.3.1：锚点只认「像路径」的 token。旧实现把所有 `a.b` 形状都当文件，
 * 于是 `v1.2.3`（版本号）、`3.5`（数字）、`https://x.y/z.md`（URL）、
 * `e.g.`（缩写）都会变成锚点——同一张卡片换一次导入就可能配不上，
 * 或者反过来两张无关卡片配到一起。
 */
export const SOURCE_EXTENSIONS = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx',
  'py', 'pyi', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'swift',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'cs', 'm', 'mm',
  'php', 'lua', 'pl', 'r', 'jl', 'dart', 'ex', 'exs', 'erl', 'hs', 'clj',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd',
  'sql', 'graphql', 'gql', 'proto',
  'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'env',
  'md', 'mdx', 'rst', 'txt', 'adoc',
  'html', 'htm', 'xhtml', 'css', 'scss', 'sass', 'less', 'styl',
  'vue', 'svelte', 'astro', 'xml', 'xsl', 'svg',
  'gradle', 'cmake', 'mk', 'lock', 'csv', 'tsv', 'ipynb', 'tex',
])

/** 版本号 / 纯数字 / 缩写这类「有小数点但不是路径」的形状。 */
const NOT_A_PATH = [
  /^v?\d+(?:\.\d+)+$/i,           // v1.2.3 / 1.2.3 / 2.0
  /^\d+(?:\.\d+)*$/,              // 3.5 / 42
  /^[a-z]\.(?:[a-z]\.)+$/i,       // e.g. / i.e.
  /^\d{4}-\d{2}-\d{2}/,           // 2026-11-02 / 时间戳开头
]

/** 带 scheme 的 URL：显式排除（`https://`、`file://`、`vscode://` …）。 */
const SCHEME_URL = /^[a-z][a-z0-9+.-]*:\/\//i

/**
 * 判断一个 token 是否像源码路径：
 *   含分隔符（`/` 或 `\`）→ 接受（相对/绝对路径都算）；
 *   否则必须命中扩展名白名单，且不能是版本号/纯数字/缩写/URL。
 *
 * @param {string} token
 * @returns {boolean}
 */
export function looksLikePath(token) {
  const text = String(token ?? '').trim()
  if (text.length === 0) return false
  if (SCHEME_URL.test(text)) return false
  if (NOT_A_PATH.some((re) => re.test(text))) return false
  if (/[\\/]/.test(text)) return true
  const dot = text.lastIndexOf('.')
  if (dot <= 0 || dot === text.length - 1) return false
  return SOURCE_EXTENSIONS.has(text.slice(dot + 1).toLowerCase())
}

/**
 * 从导入型任务的 params 里解析「源锚点」：
 * instruction 里的 `文件(:行)` → instruction 里的 `标记` → params.path →
 * 归一化标题哈希。
 */
export function sourceAnchorOf(node, platform = process.platform) {
  const instruction = String(node?.params?.instruction ?? '').trim()
  if (instruction.length > 0) {
    // 文件（:行）：逐个候选 token 判定，第一个「像路径」的才算数。
    // 候选里不能有空白/引号/分隔号；`path:12` 的行号单独捕获。
    const tokens = instruction.match(/[^\s"'`（）()【】\[\]；;，,、]+/g) ?? []
    for (const raw of tokens) {
      const candidate = raw.replace(/[:：]\d+(?:-\d+)?$/, '')
      if (!looksLikePath(candidate)) continue
      const lineMatch = /[:：](\d+)(?:-\d+)?$/.exec(raw)
      const line = lineMatch ? `:${lineMatch[1]}` : ''
      return normalizePathKey(candidate, platform) + line
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
