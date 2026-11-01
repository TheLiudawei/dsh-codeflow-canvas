/**
 * 符号与导入提取：按语言从源码行里识别顶层符号与 import 指示符。
 *
 * 三个纯函数服务两个消费方：模块结构图（analyst，用它们建"每文件一个
 * 模块节点 + 依赖连边"的图）与功能归属（features，用「顶层符号 → 功能
 * 词典」和「导入闭包」两个信号做识别）、耦合分析（coupling，用它们建
 * 文件内符号引用图与模块依赖图）。原来它们长在 analyst.js 里并注释着
 * "Exported for lib/features.js"——分析层互相借工具的错位从这里归位。
 *
 * 识别语义刻意保守：正则只认"看起来像定义"的行，宁缺勿滥——这些结果
 * 会直接变成画布节点，错误的确定性比诚实的缺失更糟。
 *
 * 依赖方向：只依赖 `node:*`（第 1 层）。
 *
 * @module dsh-codeflow-canvas/scan/symbols
 */
import path from 'node:path'

/** 各语言家族的顶层符号模式：每命中一行产出 `[name, kind]`。 */
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
 * 从一个文件的源码行里抽取顶层符号。
 *
 * Python 一族只认第 0 列的定义；花括号语言按模式表逐行匹配。结果封顶
 * 200 条——这是摘要，不是索引。
 *
 * @param language - 语言键（无模式的语言返回 `[]`）。
 * @param lines - 源码行。
 * @returns `{ name, kind, line }` 数组（`line` 从 1 起）。
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
      // Ruby 的 def 模式允许缩进；这里只保留顶层 def。
      if (language === 'ruby' && kind === '函数' && (match[1] ?? '').length > 0) continue
      seen.add(name)
      symbols.push({ name, kind, line: i + 1 })
      break
    }
  }
  return symbols
}

/**
 * 按语言家族抽取原始（未解析）的 import 指示符。
 * 支持 Python（`from x import` / `import x`）、JS/TS/Vue（`from '…'` /
 * `require('…')`）、Go（单条与块导入）、Java/Kotlin（`import x.y;`）。
 *
 * @param language - 语言键。
 * @param ext - 小写扩展名（vue/jsx/tsx 走 JS 分支）。
 * @param lines - 源码行。
 * @returns 指示符字符串数组（保持出现顺序）。
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
 * 把一个 import 指示符解析到扫描清单里的某个项目文件；指向项目外
 * （三方包、标准库）时返回 `undefined`。
 *
 * @param spec - 原始指示符。
 * @param fromRel - 导入方文件的相对路径（解析相对导入的基准）。
 * @param byPath - 相对路径 → 命中（扫描清单索引）。
 * @param byStem - 词干 → 命中数组（无扩展名匹配用）。
 * @returns 命中的相对路径，或 `undefined`。
 */
export function resolveImport(spec, fromRel, byPath, byStem) {
  if (spec.startsWith('.')) {
    // Python 相对导入：每个前导点向上走一层包目录（`from .x import` =
    // 同目录）。余下部分按原样（js/ts 的 `./util.js`）与点分模块路径展开
    // （`from .a.b import` → a/b.py）两种拼写尝试。
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
  if (spec.includes(':') || spec.startsWith('@')) return undefined // URL / scoped 包
  // Python 点分路径：a.b.c → a/b/c.py 或 a/b/c/__init__.py。
  const dotted = spec.replaceAll('.', '/')
  for (const candidate of [`${dotted}.py`, `${dotted}/__init__.py`, `${dotted}.go`, `${dotted}.rs`]) {
    if (byPath.has(candidate)) return candidate
  }
  // 裸词干匹配（无扩展名的 js/ts、go 的末段、java 的全限定类名）。
  const stem = (spec.split('/').pop() ?? '').split('.').pop() ?? ''
  if (stem.length < 3) return undefined
  const hits = byStem.get(stem)
  return hits !== undefined && hits.length > 0 ? hits[0] : undefined
}
