/**
 * 功能识别的信号层：扫描源码树、收集五类确定性信号、合并评分、构建索引。
 *
 * 五类信号（按置信度权重，见 constants.WEIGHT）：
 *   1. design.md 的人工功能清单（0.9）
 *   2. 入口信号：路由装饰器 / 子命令 / main 守卫 / shebang / package.json bin（0.8）
 *   3. 顶层符号 → 词典命中（0.6）
 *   4. 目录/文件名词典命中（0.5）
 *   5. module 节点 result/detail 文本里的词典命中（0.35）
 *
 * 入口命中后沿导入依赖做 ≤2 跳闭包，把入口文件的直接依赖并入该功能。
 * 全部是本地确定性计算——零模型调用是这个模块的硬契约。
 *
 * 依赖方向：core/*、scan/*、features/{constants,dictionary,index-file,map} ← 本模块
 * ← features.js（聚合入口）与 ops.js（rebuild 分支）。
 *
 * @module dsh-codeflow-canvas/features/detect
 */
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import { readHeadLines } from '../core/fsio.js'
import { extractImportSpecifiers, extractSymbols, resolveImport } from '../scan/symbols.js'
import { walk } from '../scan/walk.js'
import { GENERIC_NAMES, MAX_ALIASES, MAX_EVIDENCE, MAX_FEATURES, MAX_FILES_PER_FEATURE, WEIGHT } from './constants.js'
import { BASE_DICTIONARY, buildDictionary, lookupDictionary } from './dictionary.js'
import { cleanFeatureName, cleanRel, emptyIndex, emptyManual, relOf, sanitizeManual } from './index-file.js'
import { graphRootOf, mapNodes } from './map.js'

/** 每个文件读取多少字节足够（256KB 预算，行数不设上限）。 */
const BODY_READ = { bytes: 256 * 1024 }

/** 扫描预算：最多 300 个文件、6 层深（walk 自带跳过目录）。 */
const SCAN_MAX_FILES = 300
const SCAN_MAX_DEPTH = 6

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

/** 文件名主干（不含扩展名）。保留本地实现（与 core.stemOf 的点文件语义略有差异）。 */
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
    const lines = await readHeadLines(file.abs, BODY_READ)
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
