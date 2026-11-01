/**
 * 注释语法：按语言家族从文件头部抽取注释、任务标记与首部文档块。
 *
 * 四种注释文法家族（`import-analysis.md` §3）：
 *
 *   - `python` —— `#` 行注释 + `"""`/`'''` 模块 docstring；
 *   - `hash`   —— `#` 行注释（ruby / shell / yml / toml …）；
 *   - `block`  —— `/* … *​/`（css/scss）；
 *   - `html`   —— `<!‑‑ … ‑‑>`；
 *   - `c`      —— `/* … *​/` 与 `//`；
 *   - `none`   —— 不抽注释（md / txt / json）。
 *
 * 抽取结果是导入流水线的原料：注释行喂任务标记（TODO/FIXME…），首部注释
 * 块喂节点描述。任务流水线（importer）与模块结构图（analyst）共享这里的
 * 语义，保证两家对"同一个文件的注释"看法一致。
 *
 * 依赖方向：只依赖 `node:*`（第 1 层）。
 *
 * @module dsh-codeflow-canvas/scan/comments
 */

/** 文件前多少行里的连续注释算"首部文档块"（节点描述的来源）。 */
export const HEADER_COMMENT_LINES = 15

/** 任务标记及其排序权重（FIXME 最优先），import-analysis.md §4。 */
export const MARKER_WEIGHT = new Map([
  ['FIXME', 5], ['HACK', 4], ['XXX', 4], ['TODO', 3], ['OPTIMIZE', 2], ['NOTE', 1],
])

/**
 * 判断一个语言（或裸扩展名）属于哪种注释文法家族。
 *
 * @param language - `LANG_EXTS` 的语言键（文件不是源码时为 `undefined`）。
 * @param ext - 小写扩展名。
 * @returns `'python' | 'hash' | 'block' | 'html' | 'c' | 'none'`。
 */
export function familyOf(language, ext) {
  if (language === 'python') return 'python'
  if (language === 'ruby' || language === 'shell') return 'hash'
  if (ext === 'yml' || ext === 'yaml' || ext === 'toml' || ext === 'ini' || ext === 'conf') return 'hash'
  if (language === 'html/css') return ext === 'css' || ext === 'scss' ? 'block' : 'html'
  if (ext === 'html' || ext === 'htm' || ext === 'xml' || ext === 'vue') return 'html'
  if (ext === 'md' || ext === 'txt' || ext === 'json') return 'none'
  if (language !== undefined) return 'c'
  return 'none'
}

/**
 * 从一个文件的头部行里抽出注释。
 *
 * 逐行状态机：块注释（html/block/c）与 Python docstring 有开合状态；行注释
 * 直接收集。遇到真正的代码就结束"首部文档块"（但继续收集注释本身）。
 *
 * @param lines - 文件头部行（通常来自 `core/fsio.readHeadLines`）。
 * @param family - {@link familyOf} 的产出。
 * @returns `{ comments, headerText }`——`comments` 是 `[{line, text}]`
 *   （行号从 1 起），`headerText` 是前 15 行内连续注释拼成的文本块。
 */
export function extractComments(lines, family) {
  const comments = []
  let headerText = ''
  let headerOpen = family !== 'none'
  let inBlock = false
  let blockEnd = ''

  const push = (index, text) => {
    const trimmed = text.trim()
    if (trimmed.length === 0) return
    comments.push({ line: index + 1, text: trimmed })
    if (index < HEADER_COMMENT_LINES && headerOpen) {
      headerText = headerText.length === 0 ? trimmed : `${headerText}\n${trimmed}`
    }
  }

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim()
    if (inBlock) {
      const end = trimmed.indexOf(blockEnd)
      if (end < 0) push(i, trimmed.replace(/^[*\s]+/, ''))
      else {
        if (end > 0) push(i, trimmed.slice(0, end).replace(/^[*\s]+/, ''))
        inBlock = false
      }
      continue
    }
    if (trimmed.length === 0) continue
    if (family === 'html' && trimmed.startsWith('<!--')) {
      const rest = trimmed.slice(4)
      const end = rest.indexOf('-->')
      if (end < 0) { inBlock = true; blockEnd = '-->' } else if (end > 0) push(i, rest.slice(0, end))
      continue
    }
    if (family === 'block' && trimmed.startsWith('/*')) {
      const rest = trimmed.slice(2)
      const end = rest.indexOf('*/')
      if (end < 0) { inBlock = true; blockEnd = '*/' } else if (end > 0) push(i, rest.slice(0, end))
      continue
    }
    if (family === 'c' && trimmed.startsWith('/*')) {
      const rest = trimmed.slice(2)
      const end = rest.indexOf('*/')
      if (end < 0) { inBlock = true; blockEnd = '*/' } else if (end > 0) push(i, rest.slice(0, end))
      continue
    }
    if (family === 'c' && trimmed.startsWith('//')) {
      push(i, trimmed.slice(2).replace(/^[/!\s]+/, ''))
      continue
    }
    if ((family === 'python' || family === 'hash') && trimmed.startsWith('#')) {
      push(i, trimmed.replace(/^#+\s*/, ''))
      continue
    }
    if (family === 'python' && (trimmed.startsWith('"""') || trimmed.startsWith("'''"))) {
      const quote = trimmed.slice(0, 3)
      const rest = trimmed.slice(3)
      const end = rest.indexOf(quote)
      if (end >= 0) {
        if (end > 0) push(i, rest.slice(0, end))
      } else {
        inBlock = true
        blockEnd = quote
        if (rest.length > 0) push(i, rest)
      }
      continue
    }
    // 真正的代码结束首部文档块，但不结束注释收集。
    if (i < HEADER_COMMENT_LINES) headerOpen = false
  }
  return { comments, headerText }
}

/**
 * 抽取 Python 模块 docstring——当头部没有 `#` 注释时用它作为模块描述。
 *
 * @param lines - 文件头部行。
 * @returns docstring 文本；没有则空串。
 */
export function docstringText(lines) {
  const match = lines.join('\n').match(/^\s*(?:"""|''')([\s\S]*?)("""|''')/)
  return match === null ? '' : match[1]
}

/**
 * 对一条注释文本做任务标记匹配；标记必须出现在行首。
 *
 * @param text - 注释文本（已去注释前缀）。
 * @returns `{ marker, text }`；不匹配返回 `undefined`。
 */
export function markerOf(text) {
  const match = text.match(/^(TODO|FIXME|HACK|XXX|OPTIMIZE|NOTE)\b[:：\s]?(.*)$/)
  if (match === null) return undefined
  return { marker: match[1], text: match[2].trim() || text }
}

/**
 * 给定实际找到的标记集合，给出能覆盖它们的 `markersSelect` 值。
 *
 * @param found - {@link markerOf} 产出数组。
 * @returns 选择器字符串（画布导入对话框的选项语义）。
 */
export function markersSelectOf(found) {
  const values = new Set(found.map((marker) => marker.marker))
  if (['HACK', 'XXX', 'OPTIMIZE', 'NOTE'].some((marker) => values.has(marker))) return '全部(含NOTE,HACK)'
  if (values.has('FIXME')) return 'TODO,FIXME'
  return 'TODO'
}
