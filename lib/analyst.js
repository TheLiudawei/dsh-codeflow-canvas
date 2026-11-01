/**
 * Structural code analysis: what each code block *is*, derived mechanically.
 *
 * The `modules` import strategy runs this instead of the marker pipeline. From
 * a plain directory scan it extracts, per source file:
 *
 *   - top-level symbols (functions / classes / types) with their lines;
 *   - import specifiers, resolved to local project files wherever possible;
 *   - a role guess (入口 / 路由接口 / 数据模型 / UI组件 / 工具 / 测试 / …) from
 *     framework signals, naming conventions and the header comment.
 *
 * The generated graph places one `module` node per file, links each to its
 * strongest local dependency (the canvas allows one inbound edge per port, so
 * the full dependency list rides in `detail`), and expands the handful of key
 * files — entries and the most-depended-upon modules — into per-symbol child
 * nodes. Every node arrives `pending` with the inference pre-filled: running
 * one sends the agent to read the actual source and deepen the description.
 *
 * Everything here is deterministic; no model is involved until a node runs.
 *
 * @module dsh-codeflow-canvas/analyst
 */
import { open } from 'node:fs/promises'
import path from 'node:path'
import { clip, firstSentence } from './core/text.js'
import { freeName, safeProjectName } from './core/path.js'
import {
  extractComments,
  familyOf,
  languageStats,
  looksLikeTest,
  shortLabel,
  walk,
} from './importer.js'
import { cleanPathInput, resolveProjectRoot } from './workspace.js'

/** How much of each file is enough for symbol extraction. */
const BODY_BYTES = 256 * 1024
const BODY_LINE_CAP = 4000

/** Node budget: the canvas guidance says a graph should stay ≤ 60 nodes. */
const MAX_FILE_NODES = 36
const MAX_KEY_FILES = 3
const MAX_SYMBOLS_PER_KEY = 6
const MAX_TOTAL_NODES = 60

/** Symbols listed in a module node's detail, at most. */
const MAX_DETAIL_SYMBOLS = 8

/**
 * Read a whole (bounded) file as lines, for symbol and import extraction.
 * @returns an array of lines; very large files are silently truncated.
 */
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

/** Symbol extractors per language family: `[name, kind]` per top-level hit. */
const SYMBOL_PATTERNS = new Map([
  ['python', [
    [/^def\s+(\w+)/, '函数'],
    [/^class\s+(\w+)/, '类'],
    [/^async\s+def\s+(\w+)/, '函数'],
  ]],
  ['javascript', [
    [/(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+(\w+)/, '函数'],
    [/(?:export\s+)?class\s+(\w+)/, '类'],
    [/export\s+(?:const|let|var)\s+(\w+)\s*=/, '导出'],
  ]],
  ['typescript', [
    [/(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+(\w+)/, '函数'],
    [/(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/, '类'],
    [/export\s+(?:const|let|var)\s+(\w+)\s*[:=]/, '导出'],
    [/export\s+(?:interface|type)\s+(\w+)/, '类型'],
  ]],
  ['go', [
    [/^func\s+(?:\([^)]*\)\s*)?(\w+)/, '函数'],
    [/^type\s+(\w+)\s+(?:struct|interface)/, '类型'],
  ]],
  ['java', [
    [/(?:public\s+|private\s+|protected\s+)?(?:final\s+|abstract\s+)*(?:class|interface|enum|record)\s+(\w+)/, '类'],
  ]],
  ['csharp', [
    [/(?:public\s+|private\s+|protected\s+|internal\s+)?(?:sealed\s+|abstract\s+|static\s+)*(?:class|interface|record)\s+(\w+)/, '类'],
  ]],
  ['kotlin', [
    [/(?:class|interface|object)\s+(\w+)/, '类'],
  ]],
  ['swift', [
    [/(?:class|struct|protocol|enum)\s+(\w+)/, '类型'],
  ]],
  ['rust', [
    [/(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/, '函数'],
    [/(?:pub\s+)?(?:struct|enum|trait)\s+(\w+)/, '类型'],
  ]],
  ['c/cpp', [
    [/^(?:static\s+)?[\w*]+\s+\**(\w+)\s*\([^;]*\)\s*\{?\s*$/, '函数'],
    [/^(?:typedef\s+)?(?:struct|class|enum)\s+(\w+)/, '类型'],
  ]],
  ['ruby', [
    [/^(\s*)def\s+(\w+)/, '函数'],
    [/^module\s+(\w+)/, '模块'],
    [/^class\s+(\w+)/, '类'],
  ]],
  ['php', [
    [/function\s+(\w+)\s*\(/, '函数'],
    [/class\s+(\w+)/, '类'],
  ]],
  ['shell', [
    [/^(?:function\s+)?(\w+)\s*\(\)\s*\{/, '函数'],
  ]],
])

/**
 * Pull top-level symbols out of one file's lines.
 *
 * Python and friends only count column-zero definitions; brace languages use
 * the pattern list verbatim. The result is capped — this is a summary, not an
 * index.
 *
 * Exported for `lib/features.js`, which reuses the same extractor for its
 * 「顶层符号 → 功能词典」 signal (pure function, no behaviour change here).
 */
export function extractSymbols(language, lines) {
  const patterns = SYMBOL_PATTERNS.get(language)
  if (patterns === undefined) return []
  const symbols = []
  const seen = new Set()
  for (let i = 0; i < lines.length && symbols.length < 200; i += 1) {
    for (const [pattern, kind] of patterns) {
      const match = lines[i].match(pattern)
      const name = match?.[match.length - 1]
      if (match === null || name === undefined || seen.has(name)) continue
      // Ruby's `def` pattern allows indentation; keep only top-level defs.
      if (language === 'ruby' && kind === '函数' && (match[1] ?? '').length > 0) continue
      seen.add(name)
      symbols.push({ name, kind, line: i + 1 })
      break
    }
  }
  return symbols
}

/**
 * Import specifiers per language family, raw and unresolved.
 * Exported for `lib/features.js` (import-closure signal); pure function.
 */
export function extractImportSpecifiers(language, ext, lines) {
  const specs = []
  if (language === 'python') {
    for (const line of lines) {
      const from = line.match(/^from\s+([.\w]+)\s+import/)
      if (from !== null) { specs.push(from[1]); continue }
      const plain = line.match(/^import\s+([\w.]+)/)
      if (plain !== null) specs.push(plain[1])
    }
    return specs
  }
  if (language === 'javascript' || language === 'typescript' || ext === 'vue' || ext === 'jsx' || ext === 'tsx') {
    for (const line of lines) {
      const imported = line.match(/(?:import\s[^'"]*?from|export\s[^'"]*?from)\s+['"]([^'"]+)['"]/)
      if (imported !== null) { specs.push(imported[1]); continue }
      const required = line.match(/require\(\s*['"]([^'"]+)['"]/)
      if (required !== null) specs.push(required[1])
    }
    return specs
  }
  if (language === 'go') {
    let inBlock = false
    for (const line of lines) {
      if (/^import\s+\(/.test(line)) { inBlock = true; continue }
      if (inBlock) {
        if (line.trim() === ')') inBlock = false
        const quoted = line.match(/"([^"]+)"/)
        if (quoted !== null) specs.push(quoted[1])
        continue
      }
      const single = line.match(/^import\s+"([^"]+)"/)
      if (single !== null) specs.push(single[1])
    }
    return specs
  }
  if (language === 'java' || language === 'kotlin') {
    for (const line of lines) {
      const imported = line.match(/^import\s+([\w.]+)\s*;?/)
      if (imported !== null) specs.push(imported[1])
    }
    return specs
  }
  return specs
}

/**
 * Resolve one import specifier to a scanned project file, or `undefined` when
 * it points outside the project (packages, stdlib).
 * Exported for `lib/features.js` (import-closure signal); pure function.
 */
export function resolveImport(spec, fromRel, byPath, byStem) {
  if (spec.startsWith('.')) {
    // Python relative import: each leading dot is one package level up from
    // the importing module's directory (`from .x import` = same directory).
    // The remainder is tried as-is (js/ts `./util.js`) and with dotted module
    // paths expanded (`from .a.b import` → a/b.py).
    const match = spec.match(/^\.+/)
    const level = match?.[0].length ?? 0
    const remainder = spec.slice(level)
    let dir = path.posix.dirname(fromRel)
    for (let i = 1; i < level; i += 1) dir = path.posix.dirname(dir)
    const variants = remainder.length === 0 ? [dir] : [remainder]
    if (remainder.includes('.')) variants.push(remainder.replaceAll('.', '/'))
    for (const variant of variants) {
      const base = path.posix.normalize(path.posix.join(dir, variant))
      for (const candidate of [base, `${base}.py`, `${base}.js`, `${base}.ts`, `${base}.tsx`, `${base}.jsx`,
        `${base}/__init__.py`, `${base}/index.js`, `${base}/index.ts`, `${base}/index.tsx`]) {
        if (byPath.has(candidate)) return candidate
      }
    }
    return undefined
  }
  if (spec.includes(':') || spec.startsWith('@')) return undefined // URL / scoped package
  // Python dotted path: a.b.c → a/b/c.py or a/b/c/__init__.py.
  const dotted = spec.replaceAll('.', '/')
  for (const candidate of [`${dotted}.py`, `${dotted}/__init__.py`, `${dotted}.go`, `${dotted}.rs`]) {
    if (byPath.has(candidate)) return candidate
  }
  // Bare stem match (js/ts without extension, go last path segment, java FQCN).
  const stem = (spec.split('/').pop() ?? '').split('.').pop() ?? ''
  if (stem.length < 3) return undefined
  const hits = byStem.get(stem)
  return hits !== undefined && hits.length > 0 ? hits[0] : undefined
}

/** Role labels, checked in order; the first hit wins. */
const ROLE_SIGNALS = [
  ['测试', (rel) => looksLikeTest(rel)],
  ['入口', (rel, ctx) => /^(main|app|index|server|cli|run|manage|wsgi|asgi)\.(py|js|ts|go|rs)$/i.test(rel.split('/').pop() ?? '') || ctx.entrySignal],
  ['路由接口', (rel, ctx) => /(@app\.|@router\.|@(get|post|put|delete|patch)[\s(]|@api_view|Blueprint|@RestController|@RequestMapping|@GetMapping|@PostMapping|express\(\)|Router\(\)|gin\.|fiber\.)/.test(ctx.text)],
  ['数据模型', (rel, ctx) => /class\s+\w+\((?:db\.Model|Base|BaseModel|models\.Model|Document|Parcelable)\)|@(Entity|Table|Serializable|dataclass|pytest\.fixture)/.test(ctx.text) || /CREATE TABLE|mongoose\.Schema|sequelize\.define|prisma/i.test(ctx.text)],
  ['UI组件', (rel, ctx) => /\.(vue|svelte)$/.test(rel) || (/react|vue|svelte|preact/i.test(ctx.text) && /<[A-Z]\w*[\s/>]/.test(ctx.text))],
  ['服务', (rel) => /(service|controller|handler|manager|worker|job|task|middleware|interceptor)/i.test(rel)],
  ['工具', (rel) => /(util|helper|common|lib|tool)/i.test(rel)],
  ['脚本', (rel) => /\.(sh|bash|ps1)$/.test(rel)],
  ['样式', (rel) => /\.(css|scss)$/.test(rel)],
]

/**
 * Guess what a file is for, from its name, framework signals and content.
 * Deterministic and honest about uncertainty: with no signal the role is the
 * plain `模块` and the header comment (if any) carries the description.
 */
function roleOf(rel, language, lines) {
  const text = lines.slice(0, 80).join('\n')
  const ctx = {
    text,
    entrySignal: language === 'python' && lines.some((line) => /if\s+__name__\s*==\s*['"]__main__['"]/.test(line)),
  }
  for (const [role, test] of ROLE_SIGNALS) {
    if (test(rel, ctx)) return role
  }
  return '模块'
}

/**
 * Analyze a project's code blocks and build the module-structure graph.
 *
 * @param options - same shape as `importProject` (path/cwd/existingNames/…).
 * @returns `{ graph, summary, stats }`; throws when the path is not a directory.
 */
export async function analyzeModules(options = {}) {
  const cwd = cleanPathInput(options.cwd ?? process.cwd())
  const root = await resolveProjectRoot(options.path, cwd)

  const maxFiles = Math.min(Math.max(Number(options.maxFiles) || 200, 1), 1000)
  const maxDepth = Math.min(Math.max(Number(options.maxDepth) || 6, 1), 10)
  const { files, truncated } = await walk(root, { maxDepth, maxFiles })
  const langStats = languageStats(files)
  const { statRows, primary } = langStats

  // ---- per-file structural facts ------------------------------------------
  const byPath = new Map(files.map((file) => [file.rel, file]))
  const byStem = new Map()
  for (const file of files) {
    const stem = path.basename(file.rel, path.extname(file.rel))
    if (!byStem.has(stem)) byStem.set(stem, [])
    byStem.get(stem).push(file.rel)
  }
  const modules = new Map()
  const headerEntries = []
  for (const file of files) {
    if (file.language === undefined) continue
    const lines = await readBodyLines(file.abs)
    const symbols = extractSymbols(file.language, lines)
    const head = lines.slice(0, 200)
    const { headerText } = extractComments(head, familyOf(file.language, file.ext))
    const intent = headerText.length > 0 ? firstSentence(headerText) : ''
    if (intent.length > 0) headerEntries.push({ rel: file.rel, sentence: intent, key: looksLikeTest(file.rel) === false && /main|app|index|server/i.test(file.rel) })
    const specifiers = extractImportSpecifiers(file.language, file.ext, lines)
    const deps = new Set()
    for (const spec of specifiers) {
      const resolved = resolveImport(spec, file.rel, byPath, byStem)
      if (resolved !== undefined && resolved !== file.rel) deps.add(resolved)
    }
    modules.set(file.rel, {
      ...file,
      symbols,
      deps,
      role: looksLikeTest(file.rel) ? '测试' : roleOf(file.rel, file.language, lines),
      intent,
    })
  }
  for (const module of modules.values()) module.dependents = new Set()
  for (const module of modules.values()) {
    for (const dep of module.deps) modules.get(dep)?.dependents.add(module.rel)
  }
  headerEntries.sort((left, right) => Number(right.key) - Number(left.key))

  // ---- node selection: entries and hubs first ------------------------------
  const ranked = [...modules.keys()].sort((left, right) => {
    const a = modules.get(left)
    const b = modules.get(right)
    return (b.role === '入口') - (a.role === '入口')
      || b.dependents.size - a.dependents.size
      || a.rel.localeCompare(b.rel)
  })
  const selected = ranked.slice(0, MAX_FILE_NODES)
  const moduleCount = selected.length
  const omitted = modules.size - moduleCount

  // Symbol expansion: the top key files — entries, then hubs — one node each
  // for their most interesting symbols (classes first, then functions).
  const kindWeight = new Map([['类', 2], ['类型', 2], ['模块', 1]])
  const keyFiles = selected
    .filter((rel) => (modules.get(rel).symbols.length > 0))
    .sort((left, right) => (modules.get(right).role === '入口') - (modules.get(left).role === '入口')
      || modules.get(right).dependents.size - modules.get(left).dependents.size)
    .slice(0, MAX_KEY_FILES)
  const symbolNodes = []
  for (const rel of keyFiles) {
    const module = modules.get(rel)
    const chosen = module.symbols
      .slice()
      .sort((left, right) => (kindWeight.get(right.kind) ?? 0) - (kindWeight.get(left.kind) ?? 0) || left.line - right.line)
      .slice(0, MAX_SYMBOLS_PER_KEY)
    for (const symbol of chosen) symbolNodes.push({ rel, symbol })
  }
  const overflowed = 1 + moduleCount + symbolNodes.length > MAX_TOTAL_NODES

  // ---- layout: layered by dependency depth ---------------------------------
  // x = dependency depth (dependencies sit left of their dependents), y =
  // per-layer stacking. The scan node takes the far-left column.
  const selectedSet = new Set(selected)
  const depthOf = new Map()
  const depth = (rel, stack) => {
    if (depthOf.has(rel)) return depthOf.get(rel)
    if (stack.has(rel)) return 0
    stack.add(rel)
    let value = 0
    for (const dep of modules.get(rel)?.deps ?? []) {
      if (selectedSet.has(dep)) value = Math.max(value, depth(dep, stack) + 1)
    }
    stack.delete(rel)
    depthOf.set(rel, value)
    return value
  }
  for (const rel of selected) depth(rel, new Set())
  const layerIndex = new Map()
  const positions = new Map()
  for (const rel of selected) {
    const layer = depthOf.get(rel) ?? 0
    const index = layerIndex.get(layer) ?? 0
    layerIndex.set(layer, index + 1)
    positions.set(rel, [400 + layer * 340, 80 + index * 170])
  }

  // ---- graph assembly -------------------------------------------------------
  const nodes = []
  const links = []
  // Dual import resolves the name once (lib/duo.js) so both generators land
  // in one project directory.
  const name = typeof options.projectName === 'string' && options.projectName.length > 0
    ? options.projectName
    : freeName(safeProjectName(path.basename(root)), options.existingNames)

  const scanDetail = clip(
    [
      `路径：${root}`,
      `语言统计：${statRows.map(([language, count]) => `${language} ${count}`).join('、') || '（无源码文件）'}`,
      `文件总数：${files.length}（二进制/锁定 ${langStats.binaryCount}，其他 ${langStats.otherCount}）`,
      omitted > 0 ? `注意：源码文件较多，仅展开 ${moduleCount} 个核心模块（入口/被依赖最多优先）` : '',
      truncated ? '注意：已达扫描上限，结果已截断' : '',
      headerEntries.length > 0 ? ['关键文件：', ...headerEntries.slice(0, 20).map((e) => `${e.rel} — ${e.sentence}`)].join('\n') : '',
    ].filter(Boolean).join('\n'),
    400,
  )
  const scanId = 'm1'
  nodes.push({
    id: scanId,
    type: 'scan',
    title: '项目扫描',
    pos: [60, 240],
    params: { path: root, recursive: true, maxFiles },
    status: 'done',
    result: clip(statRows.length === 0
      ? `共 ${files.length} 个文件`
      : `${statRows.slice(0, 3).map(([language, count]) => `${shortLabel(language)} ${count} 文件`).join(' / ')} · 共 ${files.length} 文件`, 80),
    detail: scanDetail,
  })

  const idOf = new Map()
  let nextId = 2 // m1 is the scan node
  for (const rel of selected) {
    const module = modules.get(rel)
    const id = `m${nextId}`
    nextId += 1
    idOf.set(rel, id)
    const [x, y] = positions.get(rel)
    const [fn, cls] = [module.symbols.filter((s) => s.kind === '函数').length, module.symbols.filter((s) => ['类', '类型', '模块'].includes(s.kind)).length]
    nodes.push({
      id,
      type: 'module',
      title: clip(rel.split('/').pop() ?? rel, 40),
      pos: [x, y],
      params: { path: module.abs, symbol: '' },
      status: 'pending',
      result: clip(`${module.role} · ${fn} 函数 / ${cls} 类 · 导入 ${module.deps.size} 模块`, 80),
      detail: clip(
        [
          `职责猜测：${module.intent || '（无头注释，待运行确认）'}`,
          module.symbols.length > 0
            ? `符号：${module.symbols.slice(0, MAX_DETAIL_SYMBOLS).map((s) => `${s.kind} ${s.name}（行${s.line}）`).join('、')}${module.symbols.length > MAX_DETAIL_SYMBOLS ? ` …共 ${module.symbols.length} 个` : ''}`
            : '符号：（未识别到顶层定义）',
          module.deps.size > 0 ? `导入：${[...module.deps].sort().join('、')}` : '',
          module.dependents.size > 0 ? `被依赖：${[...module.dependents].sort().join('、')}` : '',
          omitted > 0 ? '（部分文件未展开，见 scan 节点说明）' : '',
        ].filter(Boolean).join('\n'),
        400,
      ),
    })
  }

  for (const { rel, symbol } of symbolNodes) {
    const id = `m${nextId}`
    nextId += 1
    const parent = modules.get(rel)
    nodes.push({
      id,
      type: 'module',
      title: clip(`${rel.split('/').pop()} · ${symbol.name}`, 40),
      pos: [(positions.get(rel)?.[0] ?? 60) + 170, (positions.get(rel)?.[1] ?? 80) + 150],
      params: { path: parent.abs, symbol: symbol.name },
      status: 'pending',
      result: clip(`${parent.role}的${symbol.kind}（行${symbol.line}）· 待运行确认职责`, 80),
      detail: clip(`所在文件：${rel}\n同文件符号：${parent.symbols.slice(0, 6).map((s) => s.name).join('、')}\n运行后将输出该${symbol.kind}的职责、输入输出与依赖说明`, 400),
    })
    links.push([idOf.get(rel), 0, id, 0])
  }

  // Edges: scan feeds the roots; every other module hangs off its strongest
  // local dependency (one inbound edge per port — the rest ride in `detail`).
  for (const rel of selected) {
    const module = modules.get(rel)
    const depCandidates = [...module.deps].filter((dep) => idOf.has(dep))
    if (depCandidates.length === 0) {
      links.push([scanId, 0, idOf.get(rel), 0])
      continue
    }
    depCandidates.sort((left, right) => modules.get(right).dependents.size - modules.get(left).dependents.size || left.localeCompare(right))
    links.push([idOf.get(depCandidates[0]), 0, idOf.get(rel), 0])
  }

  const now = new Date().toISOString()
  const graph = {
    format: 'codeflow/1',
    rev: 0,
    project: { name, language: primary, origin: 'import' },
    nodes,
    links,
    meta: { createdAt: now, updatedAt: now, importedFrom: root, strategy: 'modules' },
  }
  const summary = clip(
    `模块结构图：${moduleCount} 文件 / ${symbolNodes.length} 符号 · 主语言 ${shortLabel(primary)}${omitted > 0 ? ` · 另有 ${omitted} 文件未展开` : ''}${overflowed ? '（已达节点上限）' : ''}`,
    80,
  )
  return {
    graph,
    summary,
    stats: {
      files: files.length,
      modules: moduleCount,
      symbols: symbolNodes.length,
      omitted,
      primary,
      truncated: truncated || omitted > 0,
      name,
    },
  }
}
