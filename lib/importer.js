/**
 * Deterministic project import: scan a directory and build the import workflow
 * graph without waking the agent.
 *
 * This module is the executable form of `references/import-analysis.md`: the
 * scan rules, the language table, the per-family comment grammars and the
 * marker weights are all mechanical, so the host runs them directly instead of
 * spending an agent turn (and tokens) re-deriving them. The output is a
 * `codeflow/1` graph whose `scan` and `comments` nodes are already `done` —
 * the import itself *is* the scan — plus pending task nodes for the strongest
 * markers, `review` and `deliver`.
 *
 * The same file doubles as a CLI:
 *
 *   node lib/importer.js <项目路径> [--out <工作区>] [--max-files N] [--depth N]
 *                        [--no-tasks] [--no-tests] [--json]
 *
 * Since v0.6.0 the CLI (like the panel) imports **both** views: it writes
 * `<out>/flow-projects/<项目名>/workflow.json` (task pipeline) and, when the
 * directory holds source code, `workflow.modules.json` (module graph) as well,
 * so imports also work without a live DSH session. `--modules` is still
 * accepted as a compatibility alias but no longer selects a modules-only run.
 *
 * @module dsh-codeflow-canvas/importer
 */
import { open, mkdir, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { atomicWriteFile, safeProjectName } from './store.js'
import { cleanPathInput, resolveProjectRoot } from './workspace.js'

/** Directories never entered during the scan. `.undo` holds run backups, never source. */
const SKIP_DIRS = new Set([
  '.git', '.undo', 'node_modules', 'venv', '.venv', 'env', '__pycache__', 'dist',
  'build', 'out', '.idea', '.vscode', 'vendor', 'target', 'bin', 'obj',
])

/** Extensions that are counted but never read (binary / media / archives). */
const BINARY_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'icns',
  'pdf', 'zip', 'gz', 'tgz', 'tar', 'rar', '7z', 'bz2', 'xz',
  'mp3', 'mp4', 'avi', 'mov', 'mkv', 'wav', 'flac', 'ogg',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'exe', 'dll', 'so', 'dylib', 'class', 'jar', 'pyc', 'pyd', 'wasm',
  'db', 'sqlite', 'sqlite3', 'psd', 'bin', 'dat',
])

/** Language → extensions, mirroring import-analysis.md §2. */
const LANG_EXTS = new Map([
  ['python', ['py', 'pyw']],
  ['javascript', ['js', 'mjs', 'cjs', 'jsx']],
  ['typescript', ['ts', 'tsx']],
  ['java', ['java']],
  ['go', ['go']],
  ['rust', ['rs']],
  ['c/cpp', ['c', 'h', 'cpp', 'hpp', 'cc']],
  ['csharp', ['cs']],
  ['ruby', ['rb']],
  ['php', ['php']],
  ['swift', ['swift']],
  ['kotlin', ['kt']],
  ['html/css', ['html', 'htm', 'css', 'scss', 'vue']],
  ['shell', ['sh', 'bash', 'ps1']],
])

/** extension (lowercased) → language, derived from {@link LANG_EXTS}. */
const EXT_LANG = new Map()
for (const [language, extensions] of LANG_EXTS) {
  for (const extension of extensions) EXT_LANG.set(extension, language)
}

/** Lock files and their friends: never read, only counted. */
const LOCK_FILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json',
  'Pipfile.lock', 'poetry.lock', 'Cargo.lock', 'composer.lock', 'go.sum', 'Gemfile.lock',
])

/** Task markers with their sort weight (FIXME first), import-analysis.md §4. */
const MARKER_WEIGHT = new Map([
  ['FIXME', 5], ['HACK', 4], ['XXX', 4], ['TODO', 3], ['OPTIMIZE', 2], ['NOTE', 1],
])

/** Hard bounds from import-analysis.md. */
const MAX_FILES_CAP = 300
const HEAD_LINES = 200
const HEADER_COMMENT_LINES = 15
const MAX_MARKERS = 50
const MAX_TASK_NODES = 5
const MAX_HEADER_FILES = 20

/** How many bytes of each file are enough for the first 200 lines. */
const HEAD_BYTES = 64 * 1024

/** Entry/config file names that count as "key files" for the header report. */
const KEY_FILE_NAMES = new Set([
  'main.py', 'app.py', '__init__.py', 'index.js', 'index.ts', 'main.js', 'main.ts',
  'main.go', 'lib.rs', 'main.rs', 'app.js', 'server.js', 'manage.py',
  'package.json', 'pyproject.toml', 'setup.py', 'Cargo.toml', 'go.mod',
  'pom.xml', 'build.gradle', 'requirements.txt', 'Gemfile', 'composer.json', 'Makefile',
])

/** Short canvas labels for the result line. */
const SHORT_LABEL = new Map([
  ['python', 'Python'], ['javascript', 'JS'], ['typescript', 'TS'], ['java', 'Java'],
  ['go', 'Go'], ['rust', 'Rust'], ['c/cpp', 'C/C++'], ['csharp', 'C#'], ['ruby', 'Ruby'],
  ['php', 'PHP'], ['swift', 'Swift'], ['kotlin', 'Kotlin'], ['html/css', 'HTML/CSS'],
  ['shell', 'Shell'], ['unknown', '未知'],
])

/** Display label for a language key, shared with the module analyst. */
export function shortLabel(language) {
  return SHORT_LABEL.get(language) ?? language
}

/**
 * Tally a scanned file list by language.
 * @returns `{ languages, primary, statRows, binaryCount, otherCount, hasTests }`.
 */
export function languageStats(files) {
  const languages = new Map()
  let binaryCount = 0
  let otherCount = 0
  let hasTests = false
  for (const file of files) {
    if (file.language === undefined) { binaryCount += 1; continue }
    if (EXT_LANG.get(file.ext) !== undefined) languages.set(file.language, (languages.get(file.language) ?? 0) + 1)
    else otherCount += 1
    if (looksLikeTest(file.rel)) hasTests = true
  }
  const statRows = [...languages.entries()].sort((left, right) => right[1] - left[1])
  return { languages, primary: statRows[0]?.[0] ?? 'unknown', statRows, binaryCount, otherCount, hasTests }
}

/**
 * Pick a free project directory name: `base`, then `base-flow`, then
 * `base-flow-2`, … for every name already taken under `flow-projects/`.
 */
export function freeName(base, existing) {
  const taken = new Set(existing ?? [])
  if (!taken.has(base)) return base
  for (let attempt = 1; ; attempt += 1) {
    const name = attempt === 1 ? `${base}-flow` : `${base}-flow-${attempt}`
    if (!taken.has(name)) return name
  }
}

/** Clip a node result/detail to the limits the schema documents. */
export function clip(text, limit) {
  const value = String(text ?? '')
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
}

/** First sentence of a comment block: up to the first sentence end. */
export function firstSentence(text) {
  const line = String(text ?? '').trim().split('\n')[0] ?? ''
  const at = line.search(/[。．！？!?.](\s|$)/)
  return (at > 0 ? line.slice(0, at + 1) : line).trim()
}

/** True when a path looks like a test file, so `testgen` is not added. */
export function looksLikeTest(rel) {
  const base = rel.split('/').pop() ?? ''
  if (/(^|[.\-_])(test|spec)[.\-_]/i.test(base) || /^test_/i.test(base)) return true
  return rel.split('/').some((segment) => /^(tests?|__tests__)$/i.test(segment))
}

/**
 * List candidate files under `root`, honouring the skip list, the depth limit
 * and the file budget. Source-extension files survive truncation first;
 * everything else only fills the remaining budget.
 */
export async function walk(root, { maxDepth, maxFiles }) {
  const sources = []
  const others = []
  let overflow = false

  /** Bounded depth-first walk; `depth` 1 = directly inside root. */
  async function visit(dir, depth) {
    if (overflow && sources.length > maxFiles && others.length > maxFiles) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.endsWith('.egg-info')) continue
        if (depth < maxDepth) await visit(abs, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).slice(1).toLowerCase()
      const rel = path.relative(root, abs).split(path.sep).join('/')
      const isSkip = BINARY_EXTS.has(ext) || LOCK_FILES.has(entry.name) || /\.min\.[cm]?js$/.test(entry.name)
      const language = isSkip ? undefined : EXT_LANG.get(ext)
      const bucket = language !== undefined ? sources : others
      // Keep walking until both buckets are clearly past budget, so the
      // source-first repack below always has enough candidates.
      if (bucket.length >= maxFiles + maxFiles) { overflow = true; continue }
      bucket.push({ rel, abs, ext, language })
    }
  }

  await visit(root, 1)
  const files = sources.slice(0, maxFiles)
  for (const file of others) {
    if (files.length >= maxFiles) { overflow = true; break }
    files.push(file)
  }
  return { files, truncated: overflow || sources.length > maxFiles || files.length >= maxFiles && others.length > 0 }
}

/**
 * Read the first `limit` lines of a file without loading all of it.
 * @returns an array of lines (no trailing newline), possibly fewer than asked.
 */
export async function readHeadLines(abs, limit) {
  const handle = await open(abs, 'r')
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(HEAD_BYTES), 0, HEAD_BYTES, 0)
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split(/\r\n|\r|\n/)
    if (lines.length > limit) lines.length = limit
    return lines
  } finally {
    await handle.close()
  }
}

/** Which comment grammar family a language (or bare extension) belongs to. */
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
 * Pull comment lines out of the head of one file.
 *
 * @returns `{ comments, headerText }` where `comments` is `[{line, text}]` and
 *   `headerText` is the contiguous comment block from the first 15 lines.
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
    // Real code ends the header block but not comment collection.
    if (i < HEADER_COMMENT_LINES) headerOpen = false
  }
  return { comments, headerText }
}

/** Extract the Python module docstring when the head carries no `#` header. */
function docstringText(lines) {
  const match = lines.join('\n').match(/^\s*(?:"""|''')([\s\S]*?)("""|''')/)
  return match === null ? '' : match[1]
}

/** Run one marker match over comment text; the marker must open the line. */
function markerOf(text) {
  const match = text.match(/^(TODO|FIXME|HACK|XXX|OPTIMIZE|NOTE)\b[:：\s]?(.*)$/)
  if (match === null) return undefined
  return { marker: match[1], text: match[2].trim() || text }
}

/** First marker select value that covers every marker actually found. */
function markersSelectOf(found) {
  const values = new Set(found.map((marker) => marker.marker))
  if (['HACK', 'XXX', 'OPTIMIZE', 'NOTE'].some((marker) => values.has(marker))) return '全部(含NOTE,HACK)'
  if (values.has('FIXME')) return 'TODO,FIXME'
  return 'TODO'
}

/**
 * Import a project directory into a `codeflow/1` graph — no agent involved.
 *
 * @param options.path - absolute or `cwd`-relative directory to import.
 * @param options.cwd - workspace used to resolve relative paths.
 * @param options.existingNames - project names already under `flow-projects/`.
 * @param options.projectName - force the project name (dual import shares one
 *   name between the task pipeline and the module graph).
 * @param options.maxFiles - file budget (default 200, capped at 300).
 * @param options.maxDepth - directory depth limit (default 4).
 * @param options.fromComments - generate task nodes from markers (default true).
 * @param options.addTests - add `testgen` when no test file exists (default true).
 * @returns `{ graph, summary, stats }`; throws when the path is not a directory.
 */
export async function importProject(options = {}) {
  const cwd = cleanPathInput(options.cwd ?? process.cwd())
  const root = await resolveProjectRoot(options.path, cwd)

  const maxFiles = Math.min(Math.max(Number(options.maxFiles) || 200, 1), MAX_FILES_CAP)
  const maxDepth = Math.min(Math.max(Number(options.maxDepth) || 4, 1), 10)
  const fromComments = options.fromComments !== false
  const addTests = options.addTests !== false

  const { files, truncated } = await walk(root, { maxDepth, maxFiles })

  // ---- language statistics ----------------------------------------------
  const stats = languageStats(files)
  const { statRows, primary } = stats
  const scanResult = clip(
    statRows.length === 0
      ? `共 ${files.length} 个文件`
      : `${statRows.slice(0, 3).map(([language, count]) => `${shortLabel(language)} ${count} 文件`).join(' / ')} · 共 ${files.length} 文件`,
    80,
  )

  // ---- comments, markers, header intents ----------------------------------
  const markers = []
  const headerEntries = []
  const markerFiles = new Set()
  for (const file of files) {
    if (file.language === undefined) continue
    let lines
    try {
      lines = await readHeadLines(file.abs, HEAD_LINES)
    } catch {
      continue
    }
    const family = familyOf(file.language, file.ext)
    const { comments, headerText } = extractComments(lines, family)
    const header = headerText.length > 0 ? headerText : (family === 'python' ? docstringText(lines) : '')
    if (header.length > 0) {
      headerEntries.push({
        rel: file.rel,
        sentence: firstSentence(header),
        key: KEY_FILE_NAMES.has(path.basename(file.rel)),
      })
    }
    for (const comment of comments) {
      const found = markerOf(comment.text)
      if (found === undefined) continue
      markers.push({ file: file.rel, line: comment.line, marker: found.marker, text: clip(found.text, 120) })
      markerFiles.add(file.rel)
    }
  }
  // Entry/config files carry the project intent most reliably: they lead the
  // header report, everything else fills the rest of the 20-line budget.
  headerEntries.sort((left, right) => Number(right.key) - Number(left.key))
  const headerLines = headerEntries.slice(0, MAX_HEADER_FILES).map((e) => `${e.rel} — ${e.sentence}`)
  markers.sort((left, right) =>
    (MARKER_WEIGHT.get(right.marker) - MARKER_WEIGHT.get(left.marker))
    || left.file.localeCompare(right.file)
    || left.line - right.line)
  const totalMarkers = markers.length
  const keptMarkers = markers.slice(0, MAX_MARKERS)

  const commentsResult = clip(`发现 ${totalMarkers} 条标记，${markerFiles.size} 个文件`, 80)
  const commentsDetail = clip(
    keptMarkers.slice(0, 8).map((m) => `${m.file}:${m.line} ${m.marker} ${m.text}`).join('\n')
    + (totalMarkers > 8 ? `\n…共 ${totalMarkers} 条` : ''),
    400,
  )
  const scanDetail = clip(
    [
      `路径：${root}`,
      `语言统计：${statRows.map(([language, count]) => `${language} ${count}`).join('、') || '（无源码文件）'}`,
      `文件总数：${files.length}（二进制/锁定 ${stats.binaryCount}，其他 ${stats.otherCount}）`,
      truncated ? '注意：已达扫描上限，结果已截断' : '',
      headerLines.length > 0 ? ['关键文件：', ...headerLines.slice(0, MAX_HEADER_FILES)].join('\n') : '',
    ].filter(Boolean).join('\n'),
    400,
  )

  // ---- graph assembly -----------------------------------------------------
  // Chain: scan → comments → [task edits] → [testgen] → [review] → deliver.
  // With no task nodes the review/testgen nodes are dropped too: review needs a
  // `code` input and comments only emits `json`, and an empty review is noise.
  const nodes = []
  const links = []
  const projectBase = safeProjectName(path.basename(root))
  // Dual import resolves the name once (in lib/duo.js) and passes it here, so
  // the task pipeline and the module graph share one project directory.
  const name = typeof options.projectName === 'string' && options.projectName.length > 0
    ? options.projectName
    : freeName(projectBase, options.existingNames)

  let x = 60
  const add = (node) => {
    node.pos = [x, 80]
    x += 320
    nodes.push(node)
    return node.id
  }
  const link = (from, fromSlot, to, toSlot) => links.push([from, fromSlot, to, toSlot])

  const scanId = add({
    id: `t${nodes.length + 1}`, type: 'scan', title: '项目扫描',
    params: { path: root, recursive: true, maxFiles },
    status: 'done', result: scanResult, detail: scanDetail,
  })
  const commentsId = add({
    id: `t${nodes.length + 1}`, type: 'comments', title: '注释解析',
    params: { markers: markersSelectOf(keptMarkers), makeTasks: fromComments },
    status: 'done', result: commentsResult, detail: commentsDetail,
  })
  link(scanId, 1, commentsId, 0)

  // Task nodes: the strongest markers become one `edit` each; 1–2 markers
  // collapse into a single summary node so the graph does not fragment.
  const taskIds = []
  if (fromComments && keptMarkers.length > 0) {
    if (keptMarkers.length < 3) {
      taskIds.push(add({
        id: `t${nodes.length + 1}`, type: 'edit',
        title: clip(`处理全部 ${keptMarkers.length} 条待办注释`, 40),
        params: {
          instruction: clip(
            `处理全部 ${keptMarkers.length} 条待办注释：\n${keptMarkers.map((m) => `${m.file}:${m.line} ${m.marker} ${m.text}`).join('\n')}`,
            400,
          ),
        },
        status: 'pending', result: '', detail: '',
      }))
    } else {
      for (const marker of keptMarkers.slice(0, MAX_TASK_NODES)) {
        taskIds.push(add({
          id: `t${nodes.length + 1}`, type: 'edit',
          title: clip(`任务：${marker.text.slice(0, 18)}`, 40),
          params: { instruction: clip(`${marker.marker}: ${marker.text}（来自 ${marker.file}:${marker.line}）`, 400) },
          status: 'pending', result: '', detail: '',
        }))
      }
    }
  }

  let tail = commentsId
  if (taskIds.length > 0) {
    // comments hands the task list to the first edit (its `任务` input); each
    // later edit receives the previous edit's code.
    link(commentsId, 0, taskIds[0], 1)
    for (let i = 1; i < taskIds.length; i += 1) link(taskIds[i - 1], 0, taskIds[i], 0)
    tail = taskIds[taskIds.length - 1]
    if (addTests && !stats.hasTests) {
      const testgenId = add({
        id: `t${nodes.length + 1}`, type: 'testgen', title: '补齐测试',
        params: {
          framework: primary === 'python' ? 'pytest'
            : primary === 'javascript' || primary === 'typescript' ? 'jest/vitest' : '自动',
        },
        status: 'pending', result: '', detail: '',
      })
      link(tail, 0, testgenId, 0)
      tail = testgenId
    }
    const reviewId = add({
      id: `t${nodes.length + 1}`, type: 'review', title: '整体代码审查',
      params: { focus: '正确性,安全,可读性' },
      status: 'pending', result: '', detail: '',
    })
    link(tail, 0, reviewId, 0)
    tail = reviewId
  }

  const deliverId = add({
    id: `t${nodes.length + 1}`, type: 'deliver', title: '交付打包',
    params: { notes: `汇总 ${name} 的导入结果与后续任务` },
    status: 'pending', result: '', detail: '',
  })
  link(tail, 0, deliverId, 0)

  const now = new Date().toISOString()
  const graph = {
    format: 'codeflow/1',
    rev: 0,
    project: { name, language: primary, origin: 'import' },
    nodes,
    links,
    // `strategy:'tasks'` marks this file as the task-pipeline view; the module
    // graph of the same project carries `strategy:'modules'` instead.
    meta: { createdAt: now, updatedAt: now, importedFrom: root, strategy: 'tasks' },
  }
  const summary = `${nodes.length} 个节点 · 主语言 ${shortLabel(primary)} · ${files.length} 文件 · ${totalMarkers} 条标记${truncated ? '（已截断）' : ''}`
  return { graph, summary, stats: { files: files.length, markers: totalMarkers, primary, truncated, name } }
}

/* ------------------------------------------------------------------ CLI --- */

/**
 * Command-line entry: import a directory and write both views.
 *
 * Since v0.6.0 the CLI always produces the task pipeline AND the module graph
 * (`workflow.json` + `workflow.modules.json`). `--modules` remains accepted as
 * a compatibility alias and no longer means "only the module graph".
 */
export async function main(argv = process.argv.slice(2)) {
  const options = { path: undefined, out: process.cwd(), maxFiles: 200, maxDepth: 4, fromComments: true, addTests: true, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--out') options.out = cleanPathInput(argv[++i], { cwd: process.cwd() })
    else if (arg === '--max-files') options.maxFiles = Number(argv[++i])
    else if (arg === '--depth') options.maxDepth = Number(argv[++i])
    else if (arg === '--no-tasks') options.fromComments = false
    else if (arg === '--no-tests') options.addTests = false
    else if (arg === '--modules') { /* compat alias: dual import is the only behaviour now */ }
    else if (arg === '--json') options.json = true
    else if (arg === '-h' || arg === '--help') {
      console.log('用法: node lib/importer.js <项目路径> [--out <工作区>] [--max-files N] [--depth N] [--no-tasks] [--no-tests] [--json]')
      console.log('一次导入同时生成任务流水线（workflow.json）与模块结构图（workflow.modules.json）；--modules 仅为兼容别名。')
      return 0
    } else if (options.path === undefined) options.path = arg
  }
  if (options.path === undefined) {
    console.error('错误: 缺少项目路径。用法: node lib/importer.js <项目路径> [--out <工作区>]')
    return 2
  }
  const existing = []
  try {
    for (const entry of await readdir(path.join(options.out, 'flow-projects'))) existing.push(entry)
  } catch {
    // No flow-projects yet: every name is free.
  }
  // Dynamic import keeps the importer → analyst → importer cycle out of the
  // static graph; lib/duo.js orchestrates both generators.
  const { importProjectDual } = await import('./duo.js')
  const result = await importProjectDual({ ...options, existingNames: existing })
  const dir = path.join(options.out, 'flow-projects', result.name)
  const tasksFile = path.join(dir, 'workflow.json')
  // Atomic write here too: the CLI used to be able to leave a half file behind,
  // which the next boot would then read as a corrupt canvas.
  await atomicWriteFile(tasksFile, JSON.stringify(result.tasksGraph))
  if (options.json) {
    console.log(JSON.stringify({ tasks: result.tasksGraph, modules: result.modulesGraph ?? null }, null, 2))
  } else {
    console.log(`已导入: ${result.summary}`)
    console.log(`  项目: ${result.name}`)
    console.log(`  任务流水线: ${tasksFile}`)
    if (result.modulesGraph !== undefined) {
      const modulesFile = path.join(dir, 'workflow.modules.json')
      await atomicWriteFile(modulesFile, JSON.stringify(result.modulesGraph))
      console.log(`  模块结构图: ${modulesFile}`)
    } else {
      console.log(`  模块结构图: 未生成（${result.modulesWarning ?? '未知原因'}）`)
    }
  }
  return 0
}

/** Run as CLI when invoked directly (`node lib/importer.js …`). */
const invoked = process.argv[1] !== undefined ? pathToFileURL(path.resolve(process.argv[1])).href : undefined
if (invoked === import.meta.url) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`导入失败: ${error?.message ?? error}`)
      process.exit(1)
    },
  )
}
