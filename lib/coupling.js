/**
 * 模块耦合分析（v1.2）——每个源码文件有多"缠"，机械推导。零 LLM、零 npm
 * 依赖、完全确定：同一棵源码树加同一组阈值永远得到逐字节相同的分数
 * （时间戳只作为元数据随行，绝不作为分数输入）。
 *
 * 每个文件两条轴（v1.2 任务书附录 A）：
 *
 *   - **inter**（模块级）：导入扇入/扇出、传递闭包、SCC 压缩 DAG 上的依赖
 *     深度、是否处于环中、拉进来的不同外部包数量。
 *   - **intra**（符号级）：文件内有向的"符号 A 引用符号 B"图——边数、密度、
 *     最大扇出、符号环。
 *
 * 得分合成为 `0.6 × intra + 0.4 × inter`，按固定阈值 30/60 映射为级别
 * （低 / 中 / 高）。全项目判定（「屎山程度」）是行数加权平均加环惩罚
 * ——见 `overallOf`。
 *
 * 这里的函数为 `tests/coupling.mjs` 而导出；HTTP 面在
 * `lib/http/import-routes.js`（`POST/GET /codeflow/api/coupling`）。
 *
 * @module dsh-codeflow-canvas/coupling
 */
import { open, stat as statFile } from 'node:fs/promises'
import path from 'node:path'

import { extractImportSpecifiers, extractSymbols, resolveImport } from './scan/symbols.js'
import { walk, LANG_EXTS } from './scan/walk.js'
import { safeProjectName } from './core/path.js'

/** Scan bounds: the whole project, capped to keep a click fast and bounded. */
export const COUPLING_SCAN_DEPTH = 6
export const COUPLING_SCAN_FILES = 1000

/** Fixed level thresholds (the task book forbids changing these). */
export const LEVEL_MEDIUM = 30
export const LEVEL_HIGH = 60

/** How much of each file is enough (mirrors `analyst.readBodyLines`). */
const BODY_BYTES = 256 * 1024
const BODY_LINE_CAP = 4000

/** Upper bound on symbols considered inside one file (mirrors analyst). */
const MAX_SYMBOLS = 200

/**
 * 权重集中在这张导出表里，测试可以直接断言。附录 A：
 * inter = 0.35×(Ca+Ce) + 0.20×closure + 0.15×depth + 0.20×cycle + 0.10×external
 * intra = 0.35×edges + 0.25×density + 0.20×maxFanOut + 0.10×innerCycles + 0.10×symbols
 * score = 0.6×intra + 0.4×inter。
 */
export const COUPLING_WEIGHTS = Object.freeze({
  inter: Object.freeze({ degree: 0.35, closure: 0.2, depth: 0.15, cycle: 0.2, external: 0.1 }),
  interMax: Object.freeze({ degree: 12, closure: 40, depth: 6, external: 20 }),
  intra: Object.freeze({ edges: 0.35, density: 0.25, maxFanOut: 0.2, innerCycles: 0.1, symbols: 0.1 }),
  intraMax: Object.freeze({ edges: 20, maxFanOut: 6, symbols: 40 }),
  degraded: Object.freeze({ lines: 0.6, linesMax: 3000, bytes: 0.4, bytesMax: 200000 }),
  composite: Object.freeze({ intra: 0.6, inter: 0.4 }),
  overall: Object.freeze({ cyclePenaltyPerFile: 3, cyclePenaltyMax: 15, lineWeightMax: 4000 }),
})

/** `sat(x, max) = min(1, log1p(x) / log1p(max))` — saturation curve. */
export function sat(x, max) {
  const value = Number(x)
  if (!Number.isFinite(value) || value <= 0) return 0
  const bound = Number(max)
  if (!Number.isFinite(bound) || bound <= 0) return 0
  return Math.min(1, Math.log1p(value) / Math.log1p(bound))
}

/** Clamp to `[0, 1]`. */
export function clamp01(x) {
  const value = Number(x)
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** Round to an integer in `[0, 100]`. */
function score100(x) {
  if (!Number.isFinite(x)) return 0
  return Math.min(100, Math.max(0, Math.round(x)))
}

/** Fixed mapping score → level (thresholds 30/60 are part of the contract). */
export function levelOf(score) {
  const value = Number(score)
  if (!Number.isFinite(value)) return 'low'
  return value >= LEVEL_HIGH ? 'high' : value >= LEVEL_MEDIUM ? 'medium' : 'low'
}

/* ------------------------------------------------------------- scanning --- */

/** Read a bounded slice of one file as lines (same shape as the analyst). */
async function readBodyLines(abs) {
  const handle = await open(abs, 'r')
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(BODY_BYTES), 0, BODY_BYTES, 0)
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split(/\r\n|\r|\n/)
    if (lines.length > BODY_LINE_CAP) lines.length = BODY_LINE_CAP
    return lines
  } catch {
    return []
  } finally {
    await handle.close()
  }
}

/**
 * 与 `analyst.analyzeModules` 相同的方式扫描项目根，两个功能对"项目有哪些
 * 源码文件、各自 import 什么"的看法才会一致。
 *
 * @returns `{ files, byPath, byStem }`；`files` 把 `/` 分隔的项目相对路径映射
 *   到 `{ rel, abs, ext, language }`——**只含源码文件**（`language !==
 *   undefined`），并附每文件的 `lines`、`bytes`、`symbols`、`specs`（原始
 *   import 指示符）、`deps`（解析到源码文件的相对路径）与 `external`（去重
 *   后的未解析指示符）。
 */
export async function scanCouplingSources(root, { maxDepth = COUPLING_SCAN_DEPTH, maxFiles = COUPLING_SCAN_FILES } = {}) {
  const { files } = await walk(root, {
    maxDepth: Math.min(Math.max(Number(maxDepth) || COUPLING_SCAN_DEPTH, 1), 10),
    maxFiles: Math.min(Math.max(Number(maxFiles) || COUPLING_SCAN_FILES, 1), COUPLING_SCAN_FILES),
  })
  // `byPath`/`byStem` 对每个扫描文件（源码与其余都算）镜像 analyst 的构造，
  // 让 `resolveImport` 行为完全一致。
  const scannedAll = files
  const byPath = new Map(scannedAll.map((file) => [file.rel, file]))
  const byStem = new Map()
  for (const file of scannedAll) {
    const stem = path.basename(file.rel, path.extname(file.rel))
    if (!byStem.has(stem)) byStem.set(stem, [])
    byStem.get(stem).push(file.rel)
  }

  const sources = new Map()
  for (const file of scannedAll) {
    if (file.language === undefined) continue
    const lines = await readBodyLines(file.abs)
    let bytes = 0
    try {
      bytes = (await statFile(file.abs)).size
    } catch {
      bytes = 0
    }
    const symbols = extractSymbols(file.language, lines)
    const specs = extractImportSpecifiers(file.language, file.ext, lines)
    const deps = new Set()
    const external = new Set()
    for (const spec of specs) {
      const resolved = resolveImport(spec, file.rel, byPath, byStem)
      if (resolved !== undefined && resolved !== file.rel) {
        // 只有源码文件参与依赖图：解析到 `others` 文件（json/md/…）没有
        // 自己的度量。
        if (byPath.get(resolved)?.language !== undefined) deps.add(resolved)
      } else {
        external.add(spec)
      }
    }
    sources.set(file.rel, {
      rel: file.rel,
      abs: file.abs,
      ext: file.ext,
      language: file.language,
      lines,
      bytes,
      symbols,
      specs,
      deps,
      external: [...external],
    })
  }
  return { files: sources, byPath, byStem }
}

/* -------------------------------------------------------- graph metrics --- */

/**
 * 邻接表上的 Tarjan 强连通分量。
 * 迭代顺序确定（插入序的 Map/Set）；显式栈让 ~2e5 个节点以内都不会有递归
 * 深度意外。
 * @returns 数组的数组（每个内层数组 = 一个分量，按发现顺序）。
 */
export function stronglyConnected(nodes, edgesOf) {
  let index = 0
  const indexOf = new Map()
  const lowOf = new Map()
  const onStack = new Set()
  const stack = []
  const components = []
  for (const start of nodes) {
    if (indexOf.has(start)) continue
    // 显式 DFS 栈：[节点, 迭代器]
    const call = [[start, edgesOf(start)[Symbol.iterator]()]]
    indexOf.set(start, index)
    lowOf.set(start, index)
    index += 1
    stack.push(start)
    onStack.add(start)
    while (call.length > 0) {
      const frame = call[call.length - 1]
      let next = frame[1].next()
      if (!next.done) {
        const target = next.value
        if (!indexOf.has(target)) {
          indexOf.set(target, index)
          lowOf.set(target, index)
          index += 1
          stack.push(target)
          onStack.add(target)
          call.push([target, edgesOf(target)[Symbol.iterator]()])
        } else if (onStack.has(target)) {
          lowOf.set(frame[0], Math.min(lowOf.get(frame[0]), indexOf.get(target)))
        }
        continue
      }
      call.pop()
      if (call.length > 0) {
        const parent = call[call.length - 1][0]
        lowOf.set(parent, Math.min(lowOf.get(parent), lowOf.get(frame[0])))
      }
      if (lowOf.get(frame[0]) === indexOf.get(frame[0])) {
        const component = []
        for (;;) {
          const member = stack.pop()
          onStack.delete(member)
          component.push(member)
          if (member === frame[0]) break
        }
        components.push(component)
      }
    }
  }
  return components
}

/**
 * 整个扫描集的逐文件度量。一次遍历算出每个文件的数字——"分析一个节点"与
 * "分析全部"因此一致：单节点运行算同一张表，只是只写一个节点。
 *
 * @param files - {@link scanCouplingSources} 产出的 `Map<rel, sourceFile>`。
 * @returns `Map<rel, { score, level, intra, inter, metrics }>`；`metrics` 的
 *   键与持久化完全一致：fanIn, fanOut, closure, depth, sccSize, symbols,
 *   refs, density, maxFanOut, lines, parsed。
 */
export function analyzeCoupling(files) {
  const rels = [...files.keys()]
  const relSet = new Set(rels)

  // ---- inter：模块依赖图 -------------------------------------------------
  const fanIn = new Map(rels.map((rel) => [rel, 0]))
  for (const file of files.values()) {
    for (const dep of file.deps) {
      if (relSet.has(dep)) fanIn.set(dep, (fanIn.get(dep) ?? 0) + 1)
    }
  }
  const edgesOf = (rel) => {
    const out = []
    for (const dep of files.get(rel)?.deps ?? []) {
      if (dep !== rel && relSet.has(dep)) out.push(dep)
    }
    return out
  }
  const components = stronglyConnected(rels, edgesOf)
  const sccSizeOf = new Map()
  for (const component of components) {
    for (const member of component) sccSizeOf.set(member, component.length)
  }
  // SCC 压缩 DAG 上的最长依赖深度（按分量记忆化）。
  const componentOf = new Map()
  components.forEach((component, i) => {
    for (const member of component) componentOf.set(member, i)
  })
  const compEdges = components.map((_component, i) => {
    const next = new Set()
    for (const member of components[i]) {
      for (const dep of edgesOf(member)) {
        const target = componentOf.get(dep)
        if (target !== i) next.add(target)
      }
    }
    return [...next]
  })
  const compDepth = new Array(components.length).fill(-1)
  const depthOfComponent = (i) => {
    if (compDepth[i] >= 0) return compDepth[i]
    compDepth[i] = 0 // cycle-safe guard; condensed graph is acyclic anyway
    let value = 0
    for (const next of compEdges[i]) value = Math.max(value, depthOfComponent(next) + 1)
    compDepth[i] = value
    return value
  }
  for (let i = 0; i < components.length; i += 1) depthOfComponent(i)

  // ---- 逐文件：闭包（对 deps 做 BFS，不含自身） ----------------------------
  const results = new Map()
  const w = COUPLING_WEIGHTS
  for (const rel of rels) {
    const file = files.get(rel)
    const seen = new Set([rel])
    const queue = [...edgesOf(rel)]
    while (queue.length > 0) {
      const current = queue.shift()
      if (seen.has(current)) continue
      seen.add(current)
      for (const next of edgesOf(current)) if (!seen.has(next)) queue.push(next)
    }
    seen.delete(rel)
    const closure = seen.size
    const fanOut = edgesOf(rel).length
    const sccSize = sccSizeOf.get(rel) ?? 1
    const depth = compDepth[componentOf.get(rel)] ?? 0
    const interScore = 100 * clamp01(
      w.inter.degree * sat(fanIn.get(rel) + fanOut, w.interMax.degree)
      + w.inter.closure * sat(closure, w.interMax.closure)
      + w.inter.depth * sat(depth, w.interMax.depth)
      + w.inter.cycle * (sccSize > 1 ? 1 : 0)
      + w.inter.external * sat(file.external.length, w.interMax.external),
    )

    // ---- intra：符号交叉引用图 --------------------------------------------
    const intra = intraMetrics(file)
    const intraScore = intra.parsed
      ? (file.symbols.length < 2 ? 0 : 100 * clamp01(
          w.intra.edges * sat(intra.edges, w.intraMax.edges)
          + w.intra.density * Math.min(1, intra.density * 2)
          + w.intra.maxFanOut * sat(intra.maxFanOut, w.intraMax.maxFanOut)
          + w.intra.innerCycles * (intra.innerCycles > 0 ? 1 : 0)
          + w.intra.symbols * sat(file.symbols.length, w.intraMax.symbols),
        ))
      : 100 * clamp01(
          w.degraded.lines * sat(file.lines.length, w.degraded.linesMax)
          + w.degraded.bytes * sat(file.bytes, w.degraded.bytesMax),
        )

    const score = score100(w.composite.intra * intraScore + w.composite.inter * interScore)
    results.set(rel, {
      score,
      level: levelOf(score),
      intra: score100(intraScore),
      inter: score100(interScore),
      metrics: {
        fanIn: fanIn.get(rel) ?? 0,
        fanOut,
        closure,
        depth,
        sccSize,
        symbols: file.symbols.length,
        refs: intra.edges,
        density: Math.round(intra.density * 100) / 100,
        maxFanOut: intra.maxFanOut,
        lines: file.lines.length,
        parsed: intra.parsed,
      },
    })
  }
  return results
}

/**
 * 单文件的符号交叉引用度量。定义行切换"当前归属"符号；归属 `s` 的每个
 * 非注释行只要提到另一个符号 `t`，就加一条去重后的边 `s → t`。
 */
export function intraMetrics(file) {
  const symbols = Array.isArray(file.symbols) ? file.symbols.slice(0, MAX_SYMBOLS) : []
  const parsed = symbols.length > 0
  if (!parsed) {
    return { parsed: false, edges: 0, density: 0, maxFanOut: 0, innerCycles: 0 }
  }
  const lineOf = new Map(symbols.map((symbol) => [symbol.line, symbol]))
  const nameOf = new Map(symbols.map((symbol) => [symbol.name, symbol]))
  const matchers = symbols.map((symbol) => ({ symbol, re: new RegExp(`\\b${escapeRe(symbol.name)}\\b`) }))
  const edges = new Set()
  const outDegree = new Map(symbols.map((symbol) => [symbol.name, 0]))
  let owner = null
  for (let i = 0; i < file.lines.length; i += 1) {
    const lineNumber = i + 1
    const defined = lineOf.get(lineNumber)
    if (defined !== undefined) owner = defined
    const text = file.lines[i]
    if (owner === null) continue
    if (isCommentLine(text)) continue
    for (const { symbol, re } of matchers) {
      if (symbol.name === owner.name) continue // 定义行/owner 自身名不算引用
      if (re.test(text)) {
        const key = `${owner.name}\u0000${symbol.name}`
        if (!edges.has(key)) {
          edges.add(key)
          outDegree.set(symbol.name, (outDegree.get(symbol.name) ?? 0) + 1)
        }
      }
    }
  }
  const n = symbols.length
  const e = edges.size
  const density = n > 1 ? e / (n * (n - 1)) : 0
  let maxFanOut = 0
  for (const degree of outDegree.values()) maxFanOut = Math.max(maxFanOut, degree)
  // 符号之间的环：大小 > 1 的 SCC（自引用已在上面排除）。
  const adj = new Map(symbols.map((symbol) => [symbol.name, []]))
  for (const key of edges) {
    const at = key.indexOf('\u0000')
    const from = key.slice(0, at)
    const to = key.slice(at + 1)
    adj.get(from).push(to)
  }
  const components = stronglyConnected(symbols.map((symbol) => symbol.name), (name) => adj.get(name) ?? [])
  const innerCycles = components.reduce((sum, component) => sum + (component.length > 1 ? component.length : 0), 0)
  return { parsed: true, edges: e, density, maxFanOut, innerCycles }
}

/** Comment-line heuristic shared by the reference scanner (`--` covers SQL/Lua). */
function isCommentLine(text) {
  return /^\s*(#|\/\/|\/\*|\*|--|<!--)/.test(String(text ?? ''))
}

function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/* ------------------------------------------------------------ graph glue --- */

/** `true` for the nodes coupling analysis applies to: file-level `module` nodes. */
export function isFileModuleNode(node) {
  return node !== null && typeof node === 'object'
    && node.type === 'module'
    && typeof node.params?.path === 'string' && node.params.path.length > 0
    && (node.params.symbol === undefined || node.params.symbol === null || node.params.symbol === '')
}

/**
 * 对一张模块图运行耦合分析。
 *
 * @param options.graph - modules 视图的图（它的文件级 `module` 节点与
 *   `meta.importedFrom` 定义了工作范围）。
 * @param options.dir - 项目持久目录（`meta.importedFrom` 缺失或不再是目录时
 *   的回退根）。
 * @param options.nodeIds - 只分析这些节点（id）；缺省分析全部。
 * @param options.now - 盖进 `coupling.at` 的 ISO 时间戳（测试注入以保证
 *   确定性；缺省当前时间）。
 * @returns `{ perNode, skipped, overall, root, durationMs }`；`perNode` 把节点
 *   id 映射到要持久化的 coupling 对象（该节点的源文件消失时为 `null`，含义是
 *   "清空该字段"）。
 */
export async function runCoupling({ graph, dir, nodeIds, now } = {}) {
  const started = Date.now()
  const at = typeof now === 'string' && now.length > 0 ? now : new Date().toISOString()
  const nodes = (Array.isArray(graph?.nodes) ? graph.nodes : []).filter(isFileModuleNode)
  const wanted = Array.isArray(nodeIds) ? new Set(nodeIds) : null

  const root = await couplingRootOf(graph, dir)
  const { files } = await scanCouplingSources(root)
  const results = analyzeCoupling(files)
  // 绝对路径索引：把节点 `params.path` 对到扫描文件上；Windows 盘符大小写
  // 漂移，因此不区分大小写。
  const byAbs = new Map()
  for (const [rel, file] of files) byAbs.set(absKey(file.abs), rel)

  const perNode = new Map()
  const skipped = []
  const analyzedEntries = []
  for (const node of nodes) {
    if (wanted !== null && !wanted.has(node.id)) continue
    const rel = byAbs.get(absKey(node.params.path))
    const result = rel !== undefined ? results.get(rel) : undefined
    if (result === undefined) {
      // 文件可能在扫描根之外（手工放置的节点），或扫描预算没够到它：
      // 诚实降级，绝不编数字。
      const fallback = await analyzeFallbackFile(node.params.path)
      if (fallback === undefined) {
        perNode.set(node.id, null) // missing file: clear any previous label
        skipped.push({ id: node.id, title: String(node.title ?? node.id), path: node.params.path })
        continue
      }
      const coupling = { level: fallback.level, score: fallback.score, intra: fallback.intra, inter: fallback.inter, metrics: fallback.metrics, at }
      perNode.set(node.id, coupling)
      analyzedEntries.push({ id: node.id, title: String(node.title ?? node.id), score: fallback.score, level: fallback.level, metrics: fallback.metrics })
      continue
    }
    const coupling = {
      level: result.level,
      score: result.score,
      intra: result.intra,
      inter: result.inter,
      metrics: { ...result.metrics },
      at,
    }
    perNode.set(node.id, coupling)
    analyzedEntries.push({ id: node.id, title: String(node.title ?? node.id), score: result.score, level: result.level, metrics: result.metrics })
  }
  const overall = overallOf(nodes, perNode, analyzedEntries)
  return { perNode, skipped, overall, root, durationMs: Date.now() - started }
}

/** Case-insensitive absolute-path key (Windows drive casing varies). */
function absKey(absPath) {
  const normalized = path.normalize(String(absPath ?? ''))
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** `meta.importedFrom` when it is still a directory, else the project dir. */
async function couplingRootOf(graph, dir) {
  const imported = graph?.meta?.importedFrom
  if (typeof imported === 'string' && imported.length > 0) {
    try {
      if ((await statFile(imported)).isDirectory()) return imported
    } catch {
      // 已消失：落到项目目录
    }
  }
  return typeof dir === 'string' && dir.length > 0 ? dir : undefined
}

/**
 * 扫描之外的节点的单文件回退（扫描预算没够到、或文件在源码根之外）：intra
 * 度量来自文件自身，需要项目图的部分全为零。`parsed:false` 让 UI 对这个
 * 弱结论保持诚实。
 */
async function analyzeFallbackFile(absPath) {
  if (typeof absPath !== 'string' || absPath.length === 0) return undefined
  const info = await statFile(absPath).catch(() => undefined)
  if (info === undefined || !info.isFile()) return undefined
  const ext = path.extname(absPath).slice(1).toLowerCase()
  const language = fallbackLanguageOf(ext)
  const lines = await readBodyLines(absPath)
  const bytes = info.size
  let symbols = []
  let specs = []
  if (language !== undefined) {
    symbols = extractSymbols(language, lines)
    specs = extractImportSpecifiers(language, ext, lines)
  }
  const w = COUPLING_WEIGHTS
  let intraScore
  let parsed
  let intra = { parsed: false, edges: 0, density: 0, maxFanOut: 0, innerCycles: 0 }
  if (symbols.length > 0) {
    parsed = true
    intra = intraMetrics({ symbols, lines })
    intraScore = symbols.length < 2 ? 0 : 100 * clamp01(
      w.intra.edges * sat(intra.edges, w.intraMax.edges)
      + w.intra.density * Math.min(1, intra.density * 2)
      + w.intra.maxFanOut * sat(intra.maxFanOut, w.intraMax.maxFanOut)
      + w.intra.innerCycles * (intra.innerCycles > 0 ? 1 : 0)
      + w.intra.symbols * sat(symbols.length, w.intraMax.symbols),
    )
  } else {
    parsed = false
    intraScore = 100 * clamp01(
      w.degraded.lines * sat(lines.length, w.degraded.linesMax)
      + w.degraded.bytes * sat(bytes, w.degraded.bytesMax),
    )
  }
  const externalCount = new Set(specs).size
  const interScore = 100 * clamp01(w.inter.external * sat(externalCount, w.interMax.external))
  const score = score100(w.composite.intra * intraScore + w.composite.inter * interScore)
  return {
    score,
    level: levelOf(score),
    intra: score100(intraScore),
    inter: score100(interScore),
    metrics: {
      fanIn: 0, fanOut: 0, closure: 0, depth: 0, sccSize: 1,
      symbols: symbols.length, refs: intra.edges,
      density: 0, maxFanOut: intra.maxFanOut, lines: lines.length, parsed,
    },
  }
}

/** Extension→language for the fallback path (importer's table, subset). */
function fallbackLanguageOf(ext) {
  // 弱判定用的语言归类派生自 lib/scan/walk.js 的 LANG_EXTS——原来这里是
  // 一份手抄子集，会随主表漂移；现在取自同一事实来源。但 html/css 一族
  // （css/scss/vue/html…）保持旧口径排除在外：它们没有符号模式，走
  // 「解析受限」的弱结论，不应获得触发 JS 导入分支的机会。
  const language = LANG_EXTS.get(String(ext ?? '').toLowerCase())
  return language !== undefined && language !== 'html/css' ? language : undefined
}

/**
 * The whole-project verdict ("屎山程度"), appendix A.5: a line-weighted mean of
 * analyzed module scores plus `min(15, 3 × cycleFiles)`, mapped through the
 * same 30/60 thresholds. `analyzed < modules` marks the result partial.
 *
 * @param nodes - file-level module nodes of the modules graph.
 * @param perNode - node id → persisted coupling (or `null` for missing files).
 * @param analyzedEntries - `{ id, title, score, metrics }` for analyzed nodes.
 */
export function overallOf(nodes, perNode, analyzedEntries) {
  const modules = nodes.length
  const analyzedList = (Array.isArray(analyzedEntries) ? analyzedEntries : [])
    .filter((entry) => entry !== null && perNode.get(entry.id) !== null)
  if (analyzedList.length === 0) return null
  const w = COUPLING_WEIGHTS.overall
  let weighted = 0
  let weightSum = 0
  let cycles = 0
  for (const entry of analyzedList) {
    const weight = Math.max(1, Math.min(Number(entry.metrics?.lines) || 1, w.lineWeightMax))
    weighted += weight * entry.score
    weightSum += weight
    if ((Number(entry.metrics?.sccSize) || 1) > 1) cycles += 1
  }
  const base = weightSum > 0 ? weighted / weightSum : 0
  const cyclePenalty = Math.min(w.cyclePenaltyMax, w.cyclePenaltyPerFile * cycles)
  const score = score100(base + cyclePenalty)
  const worst = analyzedList.reduce((best, entry) => {
    if (best === undefined) return entry
    if (entry.score > best.score) return entry
    if (entry.score === best.score && String(entry.id) < String(best.id)) return entry
    return best
  }, undefined)
  return {
    level: levelOf(score),
    score,
    modules,
    analyzed: analyzedList.length,
    cycles,
    partial: analyzedList.length < modules,
    ...(worst !== undefined
      ? { worst: { id: worst.id, title: worst.title, score: worst.score } }
      : {}),
  }
}

/* -------------------------------------------------------------- stale ----- */

/** 10-second cache for the `mtime`-based staleness probe (GET /api/coupling). */
const staleCache = new Map()
export const STALE_CACHE_TTL_MS = 10_000
export const STALE_STAT_CAP = 300

/**
 * 一张模块图的过期判定：节点的源文件 `mtime` 比 `coupling.at` 新、或文件
 * 已消失时该节点过期；任一节点过期或模块数量漂移时整体判定过期。绝不抛错
 * ——读不了的文件按过期计。
 *
 * @returns `{ overall: boolean, nodes: Record<nodeId, true> }`。
 */
export async function computeStale({ graph, cacheKey } = {}) {
  const cached = cacheKey !== undefined ? staleCache.get(cacheKey) : undefined
  if (cached !== undefined && Date.now() - cached.at < STALE_CACHE_TTL_MS) return cached.value
  const value = await computeStaleUncached(graph)
  if (cacheKey !== undefined) {
    staleCache.set(cacheKey, { at: Date.now(), value })
    if (staleCache.size > 32) {
      const oldest = staleCache.keys().next().value
      staleCache.delete(oldest)
    }
  }
  return value
}

async function computeStaleUncached(graph) {
  const nodes = (Array.isArray(graph?.nodes) ? graph.nodes : []).filter(isFileModuleNode)
  const nodeStale = {}
  let anyStale = false
  let statCalls = 0
  const meta = graph?.meta?.coupling
  for (const node of nodes) {
    const coupling = node.coupling
    if (coupling === null || coupling === undefined || typeof coupling !== 'object') continue
    let stale = false
    if (statCalls < STALE_STAT_CAP) {
      statCalls += 1
      const info = await statFile(node.params.path).catch(() => undefined)
      if (info === undefined) stale = true
      else {
        const analyzedAt = Date.parse(String(coupling.at ?? ''))
        stale = !Number.isFinite(analyzedAt) || analyzedAt < info.mtimeMs
      }
    } else {
      stale = true // budget exhausted: honest about not knowing → stale
    }
    if (stale) {
      nodeStale[node.id] = true
      anyStale = true
    }
  }
  const drifted = meta?.overall !== null && typeof meta?.overall === 'object'
    && Number(meta.overall.modules) !== nodes.length
  return { overall: anyStale || drifted === true, nodes: nodeStale }
}

/** Test hook: drop every cached staleness verdict. */
export function clearStaleCache() {
  staleCache.clear()
}

/**
 * 构建持久化的图级 `meta.coupling` 对象。
 *
 * @param options.root - 分析扫描的源码根。
 * @param options.overall - {@link overallOf} 的判定（无可分析内容时为
 *   `null`，此时本函数返回 `undefined`）。
 * @param options.now - ISO 时间戳（测试注入）。
 * @param options.source - tasks 视图镜像用 `'modules'`；modules 图自身省略。
 */
export function metaCouplingOf({ root, overall, now, source } = {}) {
  if (overall === null || overall === undefined) return undefined
  return {
    version: 1,
    ...(typeof root === 'string' && root.length > 0 ? { root } : {}),
    at: typeof now === 'string' && now.length > 0 ? now : new Date().toISOString(),
    overall: {
      level: overall.level,
      score: overall.score,
      modules: overall.modules,
      analyzed: overall.analyzed,
      cycles: overall.cycles,
      partial: overall.partial === true,
      ...(overall.worst !== undefined ? { worst: overall.worst } : {}),
    },
    ...(source === 'modules' ? { source: 'modules' } : {}),
  }
}

