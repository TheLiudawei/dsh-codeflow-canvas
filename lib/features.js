/**
 * 功能归属识别（v1.1）：把「功能 → 文件 → 画布节点」的映射做成一个纯本地、
 * 确定性的索引，落在项目目录的 `features.json`（与 workflow.json 同目录）。
 *
 * 设计要点（与需求契约一一对应）：
 *
 *   - **零模型调用**：识别全部是本地确定性计算（design.md 解析、入口信号、
 *     顶层符号、目录/文件名词典、节点文字），不访问网络、不调用任何模型。
 *   - **持久键是 files**（相对源码根、`/` 分隔）；`nodes` 只是本次图的缓存，
 *     重建时按 files 重新映射到节点 id（图重新导入后 id 会变）。
 *   - **manual 段最高优先级**且任何重建都原样保留；重建只重写
 *     `features`/`unmapped`/`generatedAt`/`source`。
 *   - **宽容解析**：坏字段丢弃、最多 `console.warn` 一次，绝不抛错让菜单崩。
 *   - **诚实**：完全无信号 → `features: []`，不做目录硬聚类。
 *
 * 索引由模块图的 `module` 节点（`params.path` 绝对路径）+ 项目根目录推导；
 * `symbol` 子节点允许存在，但归属只登记在文件级（子节点随父文件继承）。
 *
 * @module dsh-codeflow-canvas/features
 */
import { open, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import { extractImportSpecifiers, extractSymbols, resolveImport } from './analyst.js'
import { clip, walk } from './importer.js'
import { atomicWriteFile } from './store.js'

/** 与 workflow.json 同目录的索引文件名。 */
export const FEATURES_FILE = 'features.json'

/** 每个文件读取多少字节足够（参考 analyst.readBodyLines 的 256KB 预算）。 */
const BODY_BYTES = 256 * 1024

/** 扫描预算：与导入一致，最多 1000 个文件、6 层深（importer.walk 自带跳过目录）。 */
const SCAN_MAX_FILES = 300
const SCAN_MAX_DEPTH = 6

/** 上限：12 个功能、每功能 30 个文件（超出截断并在 evidence 追加「已截断 N 个」）。 */
export const MAX_FEATURES = 12
export const MAX_FILES_PER_FEATURE = 30

/** 置信度权重（命中信号类型的加权均值）；低于阈值的组带「低置信」。 */
const WEIGHT = { manual: 1.0, design: 0.9, entry: 0.8, symbol: 0.6, dir: 0.5, text: 0.35 }
export const LOW_CONFIDENCE = 0.5

/** 每条 evidence / aliases 的展示上限。 */
const MAX_EVIDENCE = 6
const MAX_ALIASES = 8

/** 入口信号里不值得当功能名的段（路由前缀、通用入口名）。 */
const GENERIC_NAMES = /^(api|apis|v\d+|index|main|app|www|admin|internal|src|lib|core|common|utils?|helpers?|server|client)$/i

/**
 * 词典（静态常量，不引分词库）：canonical 功能名 → 归一 tokens（小写英文 + 中文别名）。
 * 刻意**不收**最泛化的编程词（order/push/find/query/node/file/user 单独出现时
 * 噪声远大于信号），只保留领域含义明确的组合——未命中就显示标识符原文。
 */
const BASE_DICTIONARY = [
  ['登录', ['login', 'signin', 'auth', 'authentication', 'session', 'oauth', 'jwt', 'passport', '登录', '认证', '鉴权', '会话']],
  ['注册', ['register', 'signup', 'registration', '注册']],
  ['权限', ['permission', 'rbac', 'acl', '权限', '角色']],
  ['支付', ['payment', 'checkout', 'billing', '支付', '结算', '钱包', '账单']],
  ['订单', ['orders', 'cart', '订单', '购物车']],
  ['上传', ['upload', '上传']],
  ['下载', ['download', '下载']],
  ['导出', ['导出', '报表']],
  ['导入', ['importer', '导入']],
  ['搜索', ['search', '搜索', '检索']],
  ['通知', ['notify', 'notification', '通知', '推送']],
  ['设置', ['setting', 'settings', 'preference', '偏好', '设置']],
  ['收藏', ['favorite', 'favorites', 'bookmark', '收藏', '书签', '点赞']],
  ['评论', ['comment', 'comments', '评论', '回复']],
  ['统计', ['statistics', 'analytics', '统计', '指标']],
  ['缓存', ['cache', 'cached', 'redis', '缓存']],
  ['日志', ['logger', 'logging', '日志']],
  ['配置', ['config', 'configuration', '配置']],
  ['路由', ['router', 'routing', '路由']],
  ['数据库', ['database', 'schema', 'migration', 'migrations', '数据库']],
  ['测试', ['test', 'tests', 'spec', '测试']],
  ['部署', ['deploy', 'deployment', '部署']],
  ['画布', ['canvas', '画布']],
  ['节点', ['节点']],
  ['插件', ['plugin', 'plugins', '插件', '扩展']],
  ['用户', ['user', 'users', 'account', 'profile', '用户', '账户', '账号']],
  ['消息', ['messages', '消息', '聊天']],
  ['文件', ['files', 'storage', '文件', '存储']],
  ['任务', ['tasks', '任务', '作业']],
  ['首页', ['dashboard', '首页', '仪表盘', '总览']],
]

/**
 * 把一次识别到的原始名称归一到词典里的功能名；未命中就显示标识符原文。
 * `extra` 是 `manual.aliases` 扩展出来的 token（canonical → [tokens]）。
 */
function buildDictionary(extraAliases) {
  const map = new Map()
  for (const [canonical, tokens] of BASE_DICTIONARY) {
    map.set(canonical, canonical)
    for (const token of tokens) {
      const key = token.toLowerCase()
      if (!map.has(key)) map.set(key, canonical)
    }
  }
  for (const [canonical, tokens] of Object.entries(extraAliases ?? {})) {
    if (!Array.isArray(tokens)) continue
    if (!map.has(canonical)) map.set(canonical, canonical)
    for (const token of tokens) {
      if (typeof token !== 'string' || token.trim().length === 0) continue
      const key = token.trim().toLowerCase()
      if (!map.has(key)) map.set(key, canonical)
    }
  }
  return map
}

/**
 * 拆词：camelCase / snake_case / kebab-case / 中文连续段。
 * 中文长段额外产出 2-gram（「用户登录」→ 用户/户登/登录），使词典能命中。
 */
function wordsOf(text) {
  const out = []
  const parts = String(text ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9\u4e00-\u9fff]+/)
  for (const part of parts) {
    if (!part) continue
    if (/^[\u4e00-\u9fff]+$/.test(part) && part.length > 2) {
      out.push(part)
      for (let i = 0; i < part.length - 1; i += 1) out.push(part.slice(i, i + 2))
    } else {
      out.push(part.toLowerCase())
    }
  }
  return [...new Set(out.filter(Boolean))]
}

/** 词典查找：整词优先，其次拆词正序、再倒序；命中返回 canonical 名。 */
function lookupDictionary(token, dictionary) {
  const text = String(token ?? '').trim()
  if (!text) return undefined
  const words = wordsOf(text)
  const candidates = [text.toLowerCase(), ...words]
  for (let i = words.length - 1; i >= 0; i -= 1) candidates.push(words[i])
  for (const candidate of candidates) {
    const hit = dictionary.get(candidate)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** 归一一个相对路径：`/` 分隔、去 `./` 前缀与尾 `/`。 */
export function cleanRel(value) {
  return String(value ?? '')
    // eslint-disable-next-line no-control-regex -- 与 store.cleanArtifactPath 一致：去控制字符
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .trim()
    .split('\\').join('/')
    .replace(/^\.\//, '')
    .replace(/^\/+|\/+$/g, '')
}

/** 绝对路径 → 相对源码根的 rel（Windows/POSIX 分隔符与盘符大小写都宽容）。 */
export function relOf(abs, root) {
  const a = cleanRel(abs)
  const r = cleanRel(root)
  if (!a || !r) return a
  const lowerA = a.toLowerCase()
  const lowerR = r.toLowerCase()
  if (lowerA === lowerR) return ''
  if (lowerA.startsWith(`${lowerR}/`)) return a.slice(r.length + 1)
  return a
}

/** 清洗一个功能名：非空、≤40 字符、去掉首尾空白与多余引号。 */
export function cleanFeatureName(value) {
  const text = String(value ?? '').trim().replace(/^["'`]+|["'`]+$/g, '').trim()
  return text.length > 0 ? text.slice(0, 40) : ''
}

/** 功能 id：`f-` + 安全化名称（同名去重由调用方处理）。 */
export function featureIdOf(name) {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
  return slug.length > 0 ? `f-${slug}` : 'f'
}

/* ------------------------------------------------------------------ 空值 --- */

/** 一个形状完整、空的索引（也是坏文件的回退值）。 */
export function emptyIndex() {
  return {
    version: 1,
    generatedAt: null,
    source: 'auto',
    features: [],
    unmapped: [],
    manual: emptyManual(),
  }
}

/** manual 段的标准形状（含扩展键 dissolved / excluded，见下方说明）。 */
export function emptyManual() {
  return { labels: {}, renames: {}, aliases: {}, merged: {}, dissolved: [], excluded: {} }
}

/* ------------------------------------------------------------- 宽容解析 --- */

const warnedFiles = new Set()

/** 同一文件只警告一次（进程内）。 */
function warnOnce(file, message) {
  if (warnedFiles.has(file)) return
  warnedFiles.add(file)
  console.warn(`codeflow: ${message}`)
}

/** 清洗 manual 段：形状不对的键整体丢弃，值归一为字符串数组/字符串。（内部助手） */
function sanitizeManual(raw) {
  const out = emptyManual()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  const listOfNames = (value) => {
    if (!Array.isArray(value)) return null
    const list = [...new Set(value
      .filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => cleanFeatureName(entry))
      .filter(Boolean))].slice(0, 12)
    return list.length > 0 ? list : null
  }
  const mapOfLists = (value, into) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return
    for (const [key, list] of Object.entries(value)) {
      const cleaned = listOfNames(list)
      if (cleaned !== null) into[cleanRel(key) || key.trim()] = cleaned
    }
  }
  const mapOfStrings = (value, into) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return
    for (const [key, target] of Object.entries(value)) {
      if (typeof target !== 'string' || target.trim().length === 0) continue
      into[key.trim()] = cleanFeatureName(target)
    }
  }
  mapOfLists(raw.labels, out.labels)
  mapOfLists(raw.excluded, out.excluded)
  mapOfStrings(raw.renames, out.renames)
  mapOfStrings(raw.merged, out.merged)
  mapOfStrings(raw.aliases, out.aliases)
  if (Array.isArray(raw.dissolved)) {
    out.dissolved = [...new Set(raw.dissolved
      .filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => cleanFeatureName(entry))
      .filter(Boolean))].slice(0, 60)
  }
  return out
}

/** 清洗一个 feature 条目；无法挽回（没有名字）时返回 undefined。 */
function sanitizeFeature(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const name = cleanFeatureName(raw.name)
  if (!name) return undefined
  const files = (Array.isArray(raw.files) ? raw.files : [])
    .map((entry) => cleanRel(entry))
    .filter(Boolean)
  const nodes = (Array.isArray(raw.nodes) ? raw.nodes : [])
    .filter((entry) => typeof entry === 'string' && entry.length > 0)
  const aliases = (Array.isArray(raw.aliases) ? raw.aliases : [])
    .filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim().slice(0, 60))
    .slice(0, MAX_ALIASES)
  const evidence = (Array.isArray(raw.evidence) ? raw.evidence : [])
    .filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim().slice(0, 80))
    .slice(0, MAX_EVIDENCE)
  const confidence = Number.isFinite(Number(raw.confidence))
    ? Math.min(1, Math.max(0, Number(raw.confidence)))
    : 0.5
  return {
    ...(typeof raw.id === 'string' && raw.id.length > 0 ? { id: raw.id } : {}),
    name,
    aliases,
    files: [...new Set(files)].slice(0, 200),
    nodes: [...new Set(nodes)],
    confidence,
    evidence,
  }
}

/**
 * 宽容清洗整份索引：坏字段丢弃；关键字段（features/manual）类型不对时打上
 * `_degraded` 标记（读侧据此走「识别兜底」，不抛错）。未知内部字段（如
 * `unavailable`）不会进入结果。
 */
export function sanitizeIndex(raw) {
  const index = emptyIndex()
  let degraded = false
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    index._degraded = true
    return index
  }
  if (typeof raw.version === 'number' && Number.isFinite(raw.version)) index.version = Math.trunc(raw.version)
  if (typeof raw.generatedAt === 'string' && raw.generatedAt.length > 0) index.generatedAt = raw.generatedAt
  if (typeof raw.source === 'string' && raw.source.length > 0) index.source = raw.source
  if (Array.isArray(raw.features)) {
    index.features = raw.features.map(sanitizeFeature).filter(Boolean)
  } else if (raw.features !== undefined) {
    degraded = true
  }
  if (Array.isArray(raw.unmapped)) {
    index.unmapped = raw.unmapped.filter((entry) => typeof entry === 'string' && entry.length > 0).slice(0, 500)
  } else if (raw.unmapped !== undefined) {
    degraded = true
  }
  if (raw.manual !== null && typeof raw.manual === 'object' && !Array.isArray(raw.manual)) {
    index.manual = sanitizeManual(raw.manual)
  } else if (raw.manual !== undefined) {
    degraded = true
  }
  index._degraded = degraded
  return index
}

/**
 * 读 `features.json`。文件不存在 → `null`（调用方决定是否自动识别）；
 * 损坏 → 空索引 + `_degraded`，同一文件最多 `console.warn` 一次，绝不抛错。
 */
export async function readFeatureIndex(dir) {
  const file = path.join(dir, FEATURES_FILE)
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return null
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    warnOnce(file, `features.json 无法解析（${String(error?.message ?? error)}），本次走识别兜底`)
    const index = emptyIndex()
    index._degraded = true
    return index
  }
  const index = sanitizeIndex(parsed)
  if (index._degraded) warnOnce(file, 'features.json 存在类型不对的字段（features/unmapped/manual），坏字段已丢弃')
  return index
}

/**
 * 原子写 `features.json`（复用 store.atomicWriteFile：临时文件 → rename）。
 * 写入前重新 sanitize：内部标记（`_degraded`/`unavailable`）不落盘。
 */
export async function writeFeatureIndex(dir, index) {
  const clean = sanitizeIndex(index)
  clean.version = 1
  if (typeof clean.generatedAt !== 'string' || clean.generatedAt.length === 0) {
    clean.generatedAt = new Date().toISOString()
  }
  await atomicWriteFile(path.join(dir, FEATURES_FILE), JSON.stringify(clean))
  return clean
}

/** 索引是否比图文件旧（任一视图的 workflow 文件 mtime 晚于 generatedAt）。 */
export async function computeStale(index, dir) {
  if (index === null || index === undefined) return true
  const generatedAt = Date.parse(index.generatedAt ?? '')
  if (!Number.isFinite(generatedAt)) return true
  for (const fileName of ['workflow.json', 'workflow.modules.json']) {
    try {
      const info = await stat(path.join(dir, fileName))
      if (info.mtimeMs > generatedAt) return true
    } catch {
      // 该视图没有文件：不影响 stale 判断。
    }
  }
  return false
}

/* ------------------------------------------------------------ 源码扫描 --- */

/** 读一个文件的前 256KB 并按行拆开（读失败返回空数组，绝不抛错）。 */
async function readBody(abs) {
  const handle = await open(abs, 'r')
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(BODY_BYTES), 0, BODY_BYTES, 0)
    return buffer.subarray(0, bytesRead).toString('utf8').split(/\r\n|\r|\n/)
  } catch {
    return []
  } finally {
    await handle.close()
  }
}

/** 入口信号：按语言的确定性正则（路由 / 子命令 / main 守卫 / shebang）。 */
const ENTRY_PATTERNS = [
  { langs: ['python'], re: /@(?:app|bp|blueprint|router|api|v1)\.(?:route|get|post|put|delete|patch)\(\s*['"]([^'"\s]{1,80})['"]/g, kind: 'route' },
  { langs: ['python'], re: /\bBlueprint\(\s*['"]([\w.-]{1,40})['"]/g, kind: 'name' },
  { langs: ['python'], re: /\badd_parser\(\s*['"]([\w.-]{1,40})['"]/g, kind: 'name' },
  { langs: ['python'], re: /@click\.command\(\s*['"]([\w.-]{1,40})['"]\s*\)/g, kind: 'name' },
  { langs: ['python'], re: /if\s+__name__\s*==\s*['"]__main__['"]/g, kind: 'main' },
  { langs: ['javascript', 'typescript'], re: /(?:^|[^\w.])(?:router|app|server|api)\.(?:get|post|put|delete|patch|all|use)\(\s*['"`]([^'"`\s]{1,80})['"`]/g, kind: 'route' },
  { langs: ['javascript', 'typescript'], re: /export\s+default\s+(?:async\s+)?function\s+([\w$]{1,60})/g, kind: 'name' },
  { langs: ['go'], re: /HandleFunc\(\s*"([^"\s]{1,80})"/g, kind: 'route' },
  { langs: ['go'], re: /\.Handle\(\s*"([^"\s]{1,80})"/g, kind: 'route' },
  { langs: ['java', 'kotlin'], re: /@(?:Get|Post|Put|Delete|Patch|Request)Mapping\(\s*(?:value\s*=\s*)?"([^"\s]{1,80})"/g, kind: 'route' },
]

/** 文件名主干（不含扩展名）。 */
function stemOf(rel) {
  const base = rel.split('/').pop() ?? ''
  return base.replace(/\.[^.]+$/, '')
}

/** 路由路径 → 功能名：最后一个有意义的段。 */
function nameFromRoute(routePath) {
  const segments = String(routePath ?? '').split(/[/?]/).filter(Boolean)
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const segment = segments[i]
    if (GENERIC_NAMES.test(segment)) continue
    if (!/[\w\u4e00-\u9fff]/.test(segment)) continue
    return segment
  }
  return ''
}

/** 从一个源码记录里抽「入口信号」候选名（≤12 条）。 */
function entryHitsOf(record) {
  const hits = []
  const push = (rawName, evidence) => {
    const name = cleanFeatureName(rawName)
    if (name && hits.length < 12) hits.push({ name, evidence })
  }
  const stem = stemOf(record.rel)
  if (record.language === 'python' || record.language === 'javascript' || record.language === 'typescript'
    || record.language === 'go' || record.language === 'java' || record.language === 'kotlin') {
    for (const pattern of ENTRY_PATTERNS) {
      if (!pattern.langs.includes(record.language)) continue
      pattern.re.lastIndex = 0
      let match
      while ((match = pattern.re.exec(record.text)) !== null && hits.length < 12) {
        if (pattern.kind === 'route') {
          const segment = nameFromRoute(match[1])
          if (segment) push(segment, `路由 ${match[1]}`)
        } else if (pattern.kind === 'main') {
          // `__main__` 本身没有名字：只有入口名不通用时才用它（main.py 之类跳过）。
          if (!GENERIC_NAMES.test(stem)) push(stem, '入口脚本')
        } else {
          push(match[1], `入口 ${match[1]}`)
        }
      }
    }
    if (record.lines.length > 0 && /^#!\s*\/usr\/bin\/env\s+node/.test(record.lines[0])) {
      if (!GENERIC_NAMES.test(stem)) push(stem, 'node 脚本')
    }
  }
  if (record.isPkg) {
    try {
      const pkg = JSON.parse(record.text)
      const names = [...Object.keys(pkg?.bin ?? {}), ...Object.keys(pkg?.scripts ?? {})]
      for (const name of names.slice(0, 8)) {
        if (!GENERIC_NAMES.test(name)) push(name, 'package.json bin/scripts')
      }
    } catch {
      // 坏 package.json：跳过。
    }
  }
  return hits
}

/**
 * 解析 design 文档（design 节点产物 `docs/design.md`）：
 * `## 功能 / 功能清单 / 模块划分` 之后的子弹点与 Markdown 表格，
 * 形如 `- 登录：src/auth.py、src/session.py` 或 `| 登录 | src/auth.py |`。
 * 返回 `[{ name, files[] }]`（只保留能在扫描结果里对上号的文件）。
 */
export function parseDesignDoc(text, knownRels) {
  const out = []
  if (typeof text !== 'string' || text.length === 0) return out
  const lines = text.split(/\r\n|\r|\n/)
  let inSection = false
  const matchFiles = (token) => {
    const rel = cleanRel(token)
    if (!rel || rel.length > 200) return []
    if (knownRels.has(rel)) return [rel]
    const hits = []
    for (const candidate of knownRels) {
      if (candidate.endsWith(`/${rel}`)) hits.push(candidate)
    }
    if (hits.length > 0) return hits
    // 裸文件名（无路径）：按主干对号。
    const stem = stemOf(rel)
    if (stem.length >= 3) {
      for (const candidate of knownRels) {
        if (stemOf(candidate) === stem) hits.push(candidate)
      }
    }
    return hits
  }
  const fileTokensOf = (text) => {
    const tokens = String(text ?? '')
      .replace(/`+/g, ' ')
      .split(/[、，,;；|\s]+/)
    const outTokens = []
    for (const token of tokens) {
      const rel = cleanRel(token)
      if (!rel) continue
      if (rel.includes('/') || /\.(py|js|ts|tsx|jsx|mjs|cjs|go|rs|java|kt|rb|php|cs|c|cpp|h|hpp|vue|sh|sql)$/i.test(rel)) {
        outTokens.push(rel)
      }
    }
    return outTokens
  }
  for (const line of lines) {
    const heading = line.match(/^#{1,6}\s*(.+?)\s*$/)
    if (heading !== null) {
      inSection = /功能|模块/.test(heading[1])
      continue
    }
    if (!inSection) continue
    const table = line.match(/^\s*\|(.+)\|\s*$/)
    if (table !== null) {
      const cells = table[1].split('|').map((cell) => cell.trim())
      const name = cleanFeatureName(cells[0] ?? '')
      if (!name || cells[0] === '' || /^[-: ]+$/.test(cells[0] ?? '')) continue
      const files = []
      for (const cell of cells.slice(1)) {
        for (const token of fileTokensOf(cell)) {
          for (const rel of matchFiles(token)) files.push(rel)
        }
      }
      if (files.length > 0) out.push({ name, files: [...new Set(files)] })
      continue
    }
    const bullet = line.match(/^\s*(?:[-*+]|\d+[.、)])\s+(.+?)\s*$/)
    if (bullet !== null) {
      const at = bullet[1].search(/[：:]/)
      if (at <= 0) continue
      const name = cleanFeatureName(bullet[1].slice(0, at))
      if (!name) continue
      const files = []
      for (const token of fileTokensOf(bullet[1].slice(at + 1))) {
        for (const rel of matchFiles(token)) files.push(rel)
      }
      if (files.length > 0) out.push({ name, files: [...new Set(files)] })
    }
  }
  return out
}

/**
 * 扫描源码树：每语言文件读前 256KB，抽入口信号 / 顶层符号 / 导入依赖。
 * package.json 单独解析 bin/scripts。返回 `Map<rel, record>`。
 */
async function scanRecords(root) {
  const { files } = await walk(root, { maxDepth: SCAN_MAX_DEPTH, maxFiles: SCAN_MAX_FILES })
  const byPath = new Map()
  const byStem = new Map()
  for (const file of files) {
    byPath.set(file.rel, file)
    const stem = stemOf(file.rel)
    if (!byStem.has(stem)) byStem.set(stem, [])
    byStem.get(stem).push(file.rel)
  }
  const records = new Map()
  for (const file of files) {
    const isPkg = file.rel === 'package.json'
    if (file.language === undefined && !isPkg) continue
    const lines = await readBody(file.abs)
    const record = {
      rel: file.rel,
      language: file.language,
      ext: file.ext,
      lines,
      text: lines.join('\n'),
      isPkg,
      entry: [],
      symbols: file.language !== undefined ? extractSymbols(file.language, lines) : [],
      deps: new Set(),
    }
    record.entry = entryHitsOf(record)
    if (file.language !== undefined) {
      for (const spec of extractImportSpecifiers(file.language, file.ext, lines)) {
        const resolved = resolveImport(spec, file.rel, byPath, byStem)
        if (resolved !== undefined && resolved !== file.rel) record.deps.add(resolved)
      }
    }
    records.set(file.rel, record)
  }
  return records
}

/** 目录段 + 文件名主干（不含根级通用目录）的词典候选。 */
function pathWordsOf(rel) {
  const segments = rel.split('/')
  const words = []
  for (const segment of segments.slice(0, -1)) {
    if (GENERIC_NAMES.test(segment)) continue
    words.push(segment)
  }
  words.push(stemOf(rel))
  return words
}

/**
 * 确定性识别主流程：信号 → 合并 → 闭包 → 上限与置信度。
 * 返回 auto features（不含 manual；manual 在 effectiveFeatures 里应用）。
 */
async function detectFeatures({ records, designDoc, dictionary, graphNodes, graphRoot }) {
  /** name → { name, files:Set, signals:Set, evidence:Set, aliases:Set } */
  const candidates = new Map()
  const candidateOf = (name) => {
    let candidate = candidates.get(name)
    if (candidate === undefined) {
      candidate = { name, files: new Set(), signals: new Set(), evidence: new Set(), aliases: new Set(), entryRels: new Set() }
      candidates.set(name, candidate)
    }
    return candidate
  }
  const addFile = (name, rel, signal, evidence) => {
    if (!name || !rel) return
    const candidate = candidateOf(name)
    candidate.files.add(rel)
    candidate.signals.add(signal)
    if (evidence && candidate.evidence.size < 12) candidate.evidence.add(evidence)
  }

  // 信号 3：入口（0.8）。记录候选别名（词典 token）。
  for (const record of records.values()) {
    for (const hit of record.entry) {
      const canonical = lookupDictionary(hit.name, dictionary)
      const name = canonical ?? hit.name
      if (canonical !== undefined) candidateOf(name).aliases.add(hit.name.toLowerCase())
      addFile(name, record.rel, 'entry', hit.evidence)
      candidateOf(name).entryRels.add(record.rel)
    }
  }

  // 信号 2：design.md（0.9）。
  for (const entry of designDoc) {
    const canonical = lookupDictionary(entry.name, dictionary)
    const name = canonical ?? entry.name
    if (canonical !== undefined) candidateOf(name).aliases.add(entry.name)
    for (const rel of entry.files) {
      addFile(name, rel, 'design', 'docs/design.md')
    }
  }

  // 信号 4：顶层符号（0.6）。
  for (const record of records.values()) {
    for (const symbol of record.symbols) {
      const canonical = lookupDictionary(symbol.name, dictionary)
      if (canonical === undefined) continue
      candidateOf(canonical).aliases.add(symbol.name)
      addFile(canonical, record.rel, 'symbol', `符号 ${symbol.name}`)
    }
  }

  // 信号 5：目录/文件名（0.5）。
  for (const record of records.values()) {
    for (const word of pathWordsOf(record.rel)) {
      const canonical = lookupDictionary(word, dictionary)
      if (canonical === undefined) continue
      candidateOf(canonical).aliases.add(String(word).toLowerCase())
      addFile(canonical, record.rel, 'dir', `${record.rel.includes('/') ? '目录' : '文件名'} ${word}`)
    }
  }

  // 信号 6：节点已有文字（0.35）——module 节点 result/detail 的「职责猜测」。
  // 文本层用词典 token 的包含匹配（英文加词边界），命中即把该文件归入功能。
  const textTargets = () => {
    if (!Array.isArray(graphNodes)) return []
    const targets = []
    for (const node of graphNodes) {
      if (node === null || typeof node !== 'object') continue
      if (node.type !== 'module') continue
      const rel = relOf(node.params?.path, graphRoot ?? '')
      if (!rel || !records.has(rel)) continue
      const text = [node.result, node.detail].filter((value) => typeof value === 'string').join('\n')
      if (text.length === 0) continue
      targets.push({ rel, text })
    }
    return targets
  }
  for (const target of textTargets()) {
    for (const [canonical, tokens] of BASE_DICTIONARY) {
      for (const token of tokens) {
        if (token.length < 2) continue
        const hit = /^[\u4e00-\u9fff]+$/.test(token)
          ? target.text.includes(token)
          : new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(target.text)
        if (!hit) continue
        candidateOf(canonical).aliases.add(token.toLowerCase())
        addFile(canonical, target.rel, 'text', '节点职责猜测')
        break
      }
    }
  }

  // 合并闭包：入口命中后沿导入依赖向上游做 1–2 跳闭包。
  for (const candidate of candidates.values()) {
    if (candidate.entryRels.size === 0) continue
    const seen = new Set(candidate.files)
    let frontier = [...candidate.entryRels]
    for (let hop = 0; hop < 2 && frontier.length > 0; hop += 1) {
      const next = []
      for (const rel of frontier) {
        const record = records.get(rel)
        if (record === undefined) continue
        for (const dep of record.deps) {
          if (seen.has(dep)) continue
          seen.add(dep)
          candidate.files.add(dep)
          next.push(dep)
        }
      }
      frontier = next
    }
    if (candidate.files.size > candidate.entryRels.size) {
      candidate.evidence.add('依赖闭包(≤2跳)')
    }
  }

  // 汇总：置信度 = 命中信号类型的加权均值；无文件的功能丢弃。
  let list = [...candidates.values()]
    .filter((candidate) => candidate.files.size > 0)
    .map((candidate) => ({
      name: candidate.name,
      aliases: [...candidate.aliases].slice(0, MAX_ALIASES),
      files: [...candidate.files].sort(),
      evidence: [...candidate.evidence].slice(0, MAX_EVIDENCE),
      confidence: meanOf([...candidate.signals].map((signal) => WEIGHT[signal] ?? 0.35)),
      source: 'auto',
    }))
  list.sort((left, right) =>
    right.confidence - left.confidence
    || right.files.length - left.files.length
    || left.name.localeCompare(right.name, 'zh-CN'))
  list = list.slice(0, MAX_FEATURES)
  for (const feature of list) {
    if (feature.files.length > MAX_FILES_PER_FEATURE) {
      const dropped = feature.files.length - MAX_FILES_PER_FEATURE
      feature.files = feature.files.slice(0, MAX_FILES_PER_FEATURE)
      feature.evidence.push(`已截断 ${dropped} 个`)
    }
  }
  return list
}

/** 加权均值。 */
function meanOf(values) {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/* ------------------------------------------------------- effective/manual --- */

/**
 * 替换索引的 manual 段（优先级最高）：输入原样清洗后保存，重建时传回即可。
 * @returns 新索引（manual 已替换，其余字段不变）。
 */
export function applyManual(index, manual) {
  const next = sanitizeIndex(index)
  next.manual = sanitizeManual(manual)
  return next
}

/**
 * 应用 manual 段（优先级最高）得到「生效功能表」：
 * merged（合并）→ renames（改名）→ labels（人工归属，路径键）→ dissolved（解散）。
 * 幂等：对同一索引重复应用结果不变（持久层保存的始终是 auto features + manual）。
 */
export function effectiveFeatures(index) {
  const manual = index?.manual ?? emptyManual()
  const features = new Map()
  for (const feature of index?.features ?? []) {
    if (!feature || typeof feature.name !== 'string' || !feature.name) continue
    features.set(feature.name, {
      name: feature.name,
      aliases: [...(feature.aliases ?? [])],
      files: new Set((feature.files ?? []).map((entry) => cleanRel(entry)).filter(Boolean)),
      evidence: [...(feature.evidence ?? [])],
      confidence: Number.isFinite(Number(feature.confidence)) ? Math.min(1, Math.max(0, Number(feature.confidence))) : 0.5,
      source: 'auto',
    })
  }
  const ensureFeature = (name) => {
    let feature = features.get(name)
    if (feature === undefined) {
      feature = {
        name,
        aliases: [...((manual.aliases ?? {})[name] ?? [])],
        files: new Set(),
        evidence: ['人工标注'],
        confidence: WEIGHT.manual,
        source: 'manual',
      }
      features.set(name, feature)
    }
    return feature
  }
  // 1. merged：src 的文件并入 dst（循环到稳定，支持 A→B→C 链）。
  const merged = manual.merged ?? {}
  for (let round = 0; round < MAX_FEATURES + 1; round += 1) {
    let changed = false
    for (const [srcRaw, dstRaw] of Object.entries(merged)) {
      const src = features.get(srcRaw)
      if (src === undefined) continue
      const dstName = cleanFeatureName(dstRaw)
      if (!dstName || dstName === srcRaw) continue
      const dst = ensureFeature(dstName)
      for (const rel of src.files) dst.files.add(rel)
      dst.evidence.push(...src.evidence.filter((entry) => !dst.evidence.includes(entry)).slice(0, 3))
      features.delete(srcRaw)
      changed = true
    }
    if (!changed) break
  }
  // 2. renames：改名（持久层保持原名，展示名在这里解析）。
  for (const feature of features.values()) {
    const renamed = cleanFeatureName((manual.renames ?? {})[feature.name] ?? '')
    if (renamed && renamed !== feature.name) feature.name = renamed
  }
  // 3. labels（路径键）：人工归属，直接生效、不再推断。
  for (const [key, names] of Object.entries(manual.labels ?? {})) {
    if (!Array.isArray(names)) continue
    if (!key.includes('/')) continue // 节点 id 键在 mapNodes 里按图应用
    const rel = cleanRel(key)
    if (!rel) continue
    for (const rawName of names) {
      const name = cleanFeatureName(rawName)
      if (!name) continue
      const feature = resolveByName(features, name) ?? ensureFeature(name)
      feature.files.add(rel)
      const evidence = `人工标注 ${rel}`
      if (!feature.evidence.includes(evidence) && feature.evidence.length < 10) feature.evidence.push(evidence)
    }
  }
  // 4. dissolved：解散（按原名或展示名）。
  const dissolved = new Set((manual.dissolved ?? []).map((name) => cleanFeatureName(name)).filter(Boolean))
  const renamedFrom = new Map(Object.entries(manual.renames ?? {}))
  for (const [original, feature] of [...features.entries()]) {
    if (dissolved.has(original) || dissolved.has(feature.name) || dissolved.has(renamedFrom.get(original) ?? '')) {
      features.delete(original)
    }
  }
  // files 归一为数组：调用方（mapNodes / 测试 / 二次应用）拿到的都是可 map 的形态。
  return [...features.values()].map((feature) => ({ ...feature, files: [...feature.files] }))
}

/** 按展示名或别名找一个 feature（labels 引用旧名时尽量对上既有功能）。 */
function resolveByName(features, name) {
  const direct = features.get(name)
  if (direct !== undefined) return direct
  for (const feature of features.values()) {
    if (feature.name === name) return feature
    if (feature.aliases.some((alias) => alias.toLowerCase() === name.toLowerCase())) return feature
  }
  return undefined
}

/** 展示名 → 持久层里的原名（rename/merge/dissolve 写 manual 时用）。 */
export function originalNameOf(index, displayName) {
  const renames = index?.manual?.renames ?? {}
  for (const [original, renamed] of Object.entries(renames)) {
    if (renamed === displayName) return original
  }
  const exists = (index?.features ?? []).some((feature) => feature?.name === displayName)
  return exists ? displayName : displayName
}

/* ---------------------------------------------------------------- mapNodes --- */

/**
 * 把生效功能表映射到一张图上，得到每个功能的节点 id 与未归属清单。
 *
 * - modules 图（module 节点，params.path 绝对路径）：按文件 rel 归属；
 *   `symbol` 子节点与父文件同 path，自然继承——「父文件命中即算命中」。
 * - tasks 图：依次用 `artifacts[].path` → `params.dir` → `detail` 中出现
 *   该功能文件路径匹配。
 * - manual.labels 的节点 id 键在这里直接生效；excluded 键强制摘除。
 */
export function mapNodes(indexOrFeatures, graph, options = {}) {
  const isIndex = indexOrFeatures !== null && typeof indexOrFeatures === 'object' && !Array.isArray(indexOrFeatures)
    && Array.isArray(indexOrFeatures.features)
  const features = isIndex ? effectiveFeatures(indexOrFeatures) : (indexOrFeatures ?? [])
  const manual = (isIndex ? indexOrFeatures.manual : options.manual) ?? emptyManual()
  const root = options.root ?? graphRootOf(graph) ?? ''

  const fileOwners = new Map()
  for (const feature of features) {
    for (const rel of feature.files) {
      if (!fileOwners.has(rel)) fileOwners.set(rel, new Set())
      fileOwners.get(rel).add(feature.name)
    }
  }

  const nodeNames = new Map()
  const unmapped = []
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  const isModulesView = graph?.meta?.strategy === 'modules' || nodes.some((node) => node?.type === 'module')

  const namesWithLabels = (nodeId, autoNames) => {
    const names = new Set(autoNames)
    const labels = manual.labels?.[nodeId]
    if (Array.isArray(labels)) for (const name of labels) if (cleanFeatureName(name)) names.add(cleanFeatureName(name))
    const excluded = manual.excluded?.[nodeId]
    if (Array.isArray(excluded)) for (const name of excluded) names.delete(cleanFeatureName(name))
    return names
  }

  if (isModulesView) {
    for (const node of nodes) {
      if (node === null || typeof node !== 'object' || node.type !== 'module') continue
      const rel = relOf(node.params?.path, root)
      const names = namesWithLabels(node.id, rel ? (fileOwners.get(rel) ?? new Set()) : new Set())
      if (names.size > 0) nodeNames.set(node.id, names)
      else if (!node.params?.symbol) unmapped.push(node.id)
    }
  } else {
    for (const node of nodes) {
      if (node === null || typeof node !== 'object') continue
      const names = namesWithLabels(node.id, taskNodeNames(node, features, root))
      if (names.size > 0) nodeNames.set(node.id, names)
    }
  }

  const mapped = features.map((feature) => {
    const owned = []
    for (const [nodeId, names] of nodeNames) {
      if (names.has(feature.name)) owned.push(nodeId)
    }
    return { ...feature, files: [...feature.files], nodes: owned }
  })
  return { features: mapped, unmapped, nodeNames }
}

/** tasks 视图匹配：artifacts[].path → params.dir → detail。 */
function taskNodeNames(node, features, root) {
  const names = new Set()
  if (features.length === 0) return names
  const artifactPaths = (Array.isArray(node.artifacts) ? node.artifacts : [])
    .map((artifact) => cleanRel(artifact?.path))
    .filter(Boolean)
  const dir = cleanRel(node.params?.dir).replace(/\/+$/g, '')
  const detail = typeof node.detail === 'string' ? node.detail : ''
  for (const feature of features) {
    for (const rel of feature.files) {
      if (artifactPaths.some((artifactPath) => {
        const relFromRoot = relOf(artifactPath, root)
        return relFromRoot === rel || artifactPath === rel || artifactPath.endsWith(`/${rel}`)
      })) {
        names.add(feature.name)
        break
      }
      if (dir.length > 0 && (rel === dir || rel.startsWith(`${dir}/`))) {
        names.add(feature.name)
        break
      }
      if (detail.length > 0 && detail.includes(rel)) {
        names.add(feature.name)
        break
      }
    }
  }
  return names
}

/** 图的源码根：`meta.importedFrom`（导入项目）为绝对路径。 */
export function graphRootOf(graph) {
  const root = graph?.meta?.importedFrom
  return typeof root === 'string' && root.length > 0 ? root : undefined
}

/* -------------------------------------------------------------- 构建入口 --- */

/**
 * 构建功能索引（识别一次并可选映射到模块图）。
 *
 * @param options.root - 源码根（`meta.importedFrom`；新建项目用它自己的项目目录）。
 * @param options.graph - 可选；模块图。提供时把 files 映射为节点 id（缓存）+ unmapped。
 * @param options.designDoc - 可选；design 文档文本。缺省读 `<root>/docs/design.md`。
 * @param options.manual - 可选；保留的 manual 段（重建时传入）。
 * @returns 索引对象；源码根不存在时返回带 `unavailable` 的空索引（不抛错）。
 */
export async function buildFeatureIndex(options = {}) {
  const root = typeof options.root === 'string' && options.root.length > 0 ? options.root : undefined
  const startedAt = Date.now()
  if (root === undefined) {
    const index = emptyIndex()
    index.unavailable = '缺少源码根（图没有 meta.importedFrom，项目也未绑定目录）'
    return index
  }
  let rootStat
  try {
    rootStat = await stat(root)
  } catch {
    const index = emptyIndex()
    index.unavailable = `源码目录不存在：${root}`
    return index
  }
  if (!rootStat.isDirectory()) {
    const index = emptyIndex()
    index.unavailable = `源码根不是目录：${root}`
    return index
  }
  let designText = options.designDoc
  if (typeof designText !== 'string') {
    try {
      designText = await readFile(path.join(root, 'docs', 'design.md'), 'utf8')
    } catch {
      designText = ''
    }
  }
  let records
  try {
    records = await scanRecords(root)
  } catch (error) {
    const index = emptyIndex()
    index.unavailable = `源码扫描失败：${String(error?.message ?? error)}`
    return index
  }
  const dictionary = buildDictionary(options.manual?.aliases)
  const knownRels = new Set(records.keys())
  const designEntries = parseDesignDoc(designText, knownRels)
  const features = await detectFeatures({
    records,
    designDoc: designEntries,
    dictionary,
    graphNodes: options.graph?.nodes,
    graphRoot: root,
  })
  const index = emptyIndex()
  index.generatedAt = new Date().toISOString()
  index.source = 'auto'
  index.features = features
  index.recognizedInMs = Date.now() - startedAt
  if (options.manual !== undefined) index.manual = sanitizeManual(options.manual)
  if (options.graph !== null && typeof options.graph === 'object') {
    // 节点缓存按 auto 视角映射（manual 在读侧 effectiveFeatures 里应用，保持幂等）。
    const mapped = mapNodes({ features, manual: emptyManual() }, options.graph, { root })
    index.features = mapped.features
    index.unmapped = mapped.unmapped
  }
  return index
}

/* ------------------------------------------------------------------- ops --- */

/** op 校验失败抛出的错误（路由层转 400）。 */
function badRequest(message) {
  const error = new Error(message)
  error.statusCode = 400
  return error
}

/**
 * 对索引执行一次写操作（HTTP `/api/features` 与 `codeflow_features` 工具共用）。
 *
 * 支持：label / rename / merge / dissolve / rebuild / write（工具专用）。
 * 写操作只动 `features.json` 的 manual 段（rebuild 重写 auto 段），绝不触碰
 * 图文件与 rev。
 *
 * @returns `{ index, info }`；`info.unmatched` 仅 write 时存在（未匹配文件清单）。
 */
export async function featureOp(options = {}) {
  const op = String(options.op ?? '')
  const body = options.body ?? {}
  let index = options.index ?? emptyIndex()
  if (index._degraded === true) index = emptyIndex()
  const manual = index.manual
  const dir = options.dir
  const logger = options.logger

  if (op === 'label') {
    const key = cleanRel(body.nodeId ?? body.path)
    if (!key) throw badRequest('label 需要 nodeId 或 path')
    const name = cleanFeatureName(body.feature)
    if (!name) throw badRequest('label 需要 feature（功能名）')
    if (body.remove === true) {
      const excluded = [...new Set([...(manual.excluded[key] ?? []), name])]
      manual.excluded[key] = excluded
      const labels = (manual.labels[key] ?? []).filter((entry) => entry !== name)
      if (labels.length > 0) manual.labels[key] = labels
      else delete manual.labels[key]
    } else {
      const labels = [...new Set([...(manual.labels[key] ?? []), name])]
      manual.labels[key] = labels
      const excluded = (manual.excluded[key] ?? []).filter((entry) => entry !== name)
      if (excluded.length > 0) manual.excluded[key] = excluded
      else delete manual.excluded[key]
    }
  } else if (op === 'rename') {
    const from = cleanFeatureName(body.from)
    const to = cleanFeatureName(body.to)
    if (!from || !to) throw badRequest('rename 需要 from 与 to')
    if (from === to) throw badRequest('rename 的新旧名称相同')
    manual.renames[originalNameOf(index, from)] = to
  } else if (op === 'merge') {
    const from = cleanFeatureName(body.from)
    const to = cleanFeatureName(body.to)
    if (!from || !to) throw badRequest('merge 需要 from 与 to')
    const fromOriginal = originalNameOf(index, from)
    const toOriginal = originalNameOf(index, to)
    if (fromOriginal === toOriginal) throw badRequest('不能把功能合并到它自己')
    manual.merged[fromOriginal] = toOriginal
  } else if (op === 'dissolve') {
    const name = cleanFeatureName(body.feature)
    if (!name) throw badRequest('dissolve 需要 feature（功能名）')
    const original = originalNameOf(index, name)
    if (!manual.dissolved.includes(original)) manual.dissolved.push(original)
  } else if (op === 'rebuild') {
    const built = await buildFeatureIndex({
      root: options.root,
      designDoc: options.designDoc,
      manual,
    })
    // 重建只重写 features/unmapped/generatedAt/source；manual 原样保留。
    index.features = built.features
    index.unmapped = built.unmapped
    index.generatedAt = built.generatedAt
    index.source = built.source
    if (built.unavailable !== undefined) index.unavailable = built.unavailable
  } else if (op === 'write') {
    // codeflow_features op="write"：agent 一次性写人工归属。
    const entries = Array.isArray(body.features) ? body.features : []
    if (entries.length === 0) throw badRequest('write 需要 features 数组（[{name, files:[...]}]）')
    const mode = body.mode === 'append' ? 'append' : 'replace-manual'
    if (mode === 'replace-manual') {
      manual.labels = {}
      manual.excluded = {}
    }
    const unmatched = []
    let fileCount = 0
    const graphs = []
    for (const graph of [options.graphs?.modules, options.graphs?.tasks, options.graph]) {
      if (graph !== null && typeof graph === 'object' && Array.isArray(graph.nodes) && graph.nodes.length > 0) graphs.push(graph)
    }
    const nodeRels = new Set()
    for (const graph of graphs) {
      const root = graphRootOf(graph) ?? options.root ?? ''
      for (const node of graph.nodes) {
        const rel = relOf(node?.params?.path, root)
        if (rel) nodeRels.add(rel)
        // tasks 视图：artifacts 指到的文件也算「能找到节点」。
        for (const artifact of Array.isArray(node?.artifacts) ? node.artifacts : []) {
          const artifactRel = relOf(artifact?.path, root)
          if (artifactRel) nodeRels.add(artifactRel)
        }
      }
    }
    for (const entry of entries.slice(0, MAX_FEATURES)) {
      const name = cleanFeatureName(entry?.name)
      if (!name) continue
      const files = (Array.isArray(entry?.files) ? entry.files : []).map((file) => cleanRel(file)).filter(Boolean)
      for (const rel of files.slice(0, MAX_FILES_PER_FEATURE)) {
        fileCount += 1
        if (nodeRels.has(rel) || graphs.length === 0) {
          const labels = [...new Set([...(manual.labels[rel] ?? []), name])]
          manual.labels[rel] = labels
        } else {
          unmatched.push(`${name}: ${rel}`)
        }
      }
    }
    if (manual.dissolved === undefined) manual.dissolved = []
    const info = { unmatched, fileCount, written: entries.length }
    await persistAndRemap(options, index, dir, logger)
    return { index, info }
  } else {
    throw badRequest(`unknown op "${op}"`)
  }

  await persistAndRemap(options, index, dir, logger)
  return { index, info: undefined }
}

/** op 之后：重算模块图节点缓存（auto 视角）并原子落盘。 */
async function persistAndRemap(options, index, dir, logger) {
  const graph = options.graph ?? options.graphs?.modules
  if (graph !== null && typeof graph === 'object' && Array.isArray(graph.nodes) && graph.nodes.length > 0) {
    try {
      const mapped = mapNodes({ features: index.features, manual: emptyManual() }, graph, { root: options.root })
      index.features = mapped.features
      index.unmapped = mapped.unmapped
    } catch (error) {
      logger?.warn?.(`codeflow: features remap failed: ${String(error)}`)
    }
  }
  if (options.persist !== false && typeof dir === 'string' && dir.length > 0) {
    try {
      await writeFeatureIndex(dir, index)
    } catch (error) {
      logger?.warn?.(`codeflow: cannot write ${FEATURES_FILE}: ${String(error)}`)
    }
  }
}

/* --------------------------------------------------------------- summary --- */

/**
 ≤80 字的一行汇总，例如 `识别 8 个功能 / 24 个模块（3 个低置信）`。
 优先用已映射的节点数；没有节点缓存时退回文件数。
 */
export function summarize(index) {
  const features = Array.isArray(index?.features) ? index.features : []
  const low = features.filter((feature) => (Number(feature?.confidence) || 0) < LOW_CONFIDENCE).length
  const nodes = new Set()
  let files = 0
  for (const feature of features) {
    files += Array.isArray(feature?.files) ? feature.files.length : 0
    for (const nodeId of Array.isArray(feature?.nodes) ? feature.nodes : []) nodes.add(nodeId)
  }
  const modules = nodes.size > 0 ? nodes.size : files
  return `识别 ${features.length} 个功能 / ${modules} 个模块${low > 0 ? `（${low} 个低置信）` : ''}`
}

/** 供 HTTP/工具层复用的 clip。 */
export { clip }
