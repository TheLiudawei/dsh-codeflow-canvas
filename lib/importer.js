/**
 * 确定性项目导入：扫描一个目录、构建导入工作流图，不唤醒 agent。
 *
 * 本模块是 `references/import-analysis.md` 的可执行形态：扫描规则、语言表、
 * 各家族注释文法与标记权重都是机械的，宿主直接执行它们，而不是花一个
 * agent 回合（和 token）重新推导。产出是一张 `codeflow/1` 图：`scan` 与
 * `comments` 节点已经 `done`（导入本身就是扫描），外加最强标记对应的待运行
 * 任务节点、`review` 与 `deliver`。
 *
 * 同一个文件兼任 CLI：
 *
 *   node lib/importer.js <项目路径> [--out <工作区>] [--max-files N] [--depth N]
 *                        [--no-tasks] [--no-tests] [--json]
 *
 * 自 v0.6.0 起 CLI（与面板一致）同时导入**两个**视图：写
 * `<out>/CodeFlow/flow-projects/<项目名>/workflow.json`（任务流水线），目录里
 * 有源码时还写 `workflow.modules.json`（模块结构图），导入因此不依赖活的
 * DSH 会话。`--modules` 仍作为兼容别名被接受，但不再选择"只导模块图"。
 *
 * 扫描层（跳过清单/语言表/注释文法/符号提取）在 `lib/scan/`；本文件只保留
 * 任务流水线的组装与 CLI。
 *
 * @module dsh-codeflow-canvas/importer
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { atomicWriteFile, readHeadLines } from './core/fsio.js'
import { freeName, safeProjectName } from './core/path.js'
import { clip, firstSentence } from './core/text.js'
import { familyOf, docstringText, extractComments, markerOf, markersSelectOf, MARKER_WEIGHT } from './scan/comments.js'
import { languageStats, shortLabel, walk } from './scan/walk.js'
import { cleanPathInput, resolveProjectRoot } from './workspace.js'
/* ====================================================== 常量表 ==== */
/* 只保留任务流水线生成自身需要的常量；跳过清单/语言表/注释文法/标记权重
 * 等扫描层契约在 lib/scan/ 里（本文件按需导入）。 */

/**
 * 扫描文件数硬上限（import-analysis.md）。v1.2 起 1000：drop-import 要喂
 * 整个项目（画布节点预算不受影响——模块图仍只选 ≤36 个文件节点、任务
 * 流水线 ≤5 个任务节点）。与 lib/scan/walk.js 注释中的上限同值。
 */
export const MAX_FILES_CAP = 1000

/** 每个文件读取的头部行数（注释/标记采样窗口）。 */
const HEAD_LINES = 200

/** 读取头部行时的字节上限（core.readHeadLines 的 bytes 参数）。 */
const HEAD_BYTES = 64 * 1024

/** 参与生成任务节点的标记上限（按权重排序后截断）。 */
const MAX_MARKERS = 50

/** 一次导入最多生成的任务节点数。 */
const MAX_TASK_NODES = 5

/** 结果文本里列出的"关键文件"上限。 */
const MAX_HEADER_FILES = 20

/** 入口/配置文件名：结果报告里算作"关键文件"。 */
const KEY_FILE_NAMES = new Set([
  'main.py', 'app.py', '__init__.py', 'index.js', 'index.ts', 'main.js', 'main.ts',
  'main.go', 'lib.rs', 'main.rs', 'app.js', 'server.js', 'manage.py',
  'package.json', 'pyproject.toml', 'setup.py', 'Cargo.toml', 'go.mod',
  'pom.xml', 'build.gradle', 'requirements.txt', 'Gemfile', 'composer.json', 'Makefile',
])

/* ====================================================== 正文 ==== */
/**
 * 把一个项目目录导入成 `codeflow/1` 图——没有任何 agent 参与。
 *
 * @param options.path - 要导入的目录（绝对或相对 `cwd`）。
 * @param options.cwd - 解析相对路径用的工作区。
 * @param options.existingNames - 项目根下已被占用的项目名。
 * @param options.projectName - 强制项目名（双图导入在任务流水线与模块图之间
 *   共用一个名字）。
 * @param options.maxFiles - 文件预算（默认 200，上限 1000）。
 * @param options.maxDepth - 目录深度上限（默认 4）。
 * @param options.fromComments - 从标记生成任务节点（默认 true）。
 * @param options.addTests - 没有测试文件时补 `testgen`（默认 true）。
 * @returns `{ graph, summary, stats }`；路径不是目录时抛错。
 */
export async function importProject(options = {}) {
  const cwd = cleanPathInput(options.cwd ?? process.cwd())
  const root = await resolveProjectRoot(options.path, cwd)

  const maxFiles = Math.min(Math.max(Number(options.maxFiles) || 200, 1), MAX_FILES_CAP)
  const maxDepth = Math.min(Math.max(Number(options.maxDepth) || 4, 1), 10)
  const fromComments = options.fromComments !== false
  const addTests = options.addTests !== false

  const { files, truncated } = await walk(root, { maxDepth, maxFiles })

  // ---- 语言统计 -----------------------------------------------------------
  const stats = languageStats(files)
  const { statRows, primary } = stats
  const scanResult = clip(
    statRows.length === 0
      ? `共 ${files.length} 个文件`
      : `${statRows.slice(0, 3).map(([language, count]) => `${shortLabel(language)} ${count} 文件`).join(' / ')} · 共 ${files.length} 文件`,
    80,
  )

  // ---- 注释、标记、首部意图 -------------------------------------------------
  const markers = []
  const headerEntries = []
  const markerFiles = new Set()
  for (const file of files) {
    if (file.language === undefined) continue
    let lines
    try {
      lines = await readHeadLines(file.abs, { bytes: HEAD_BYTES, maxLines: HEAD_LINES })
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
  // 入口/配置文件最可靠地承载项目意图：它们排在首部报告最前，其余文件填满
  // 20 行预算的剩余部分。
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

  // ---- 图装配 ---------------------------------------------------------------
  // 链条：scan → comments → [任务编辑] → [testgen] → [review] → deliver。
  // 没有任务节点时 review/testgen 也一并省去：review 需要 `code` 输入而
  // comments 只产出 `json`，一个空的 review 只是噪音。
  const nodes = []
  const links = []
  const projectBase = safeProjectName(path.basename(root))
  // 双图导入只解析一次名字（在 lib/duo.js）并传到这里，任务流水线与模块图
  // 因此共享一个项目目录。
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

  // 任务节点：最强的标记各自成为一个 `edit`；只有 1–2 条标记时坍缩成一个
  // 汇总节点，图不至于碎片化。
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
    // `strategy:'tasks'` 标记本文件是任务流水线视图；同一项目的模块图带的是
    // `strategy:'modules'`。
    meta: { createdAt: now, updatedAt: now, importedFrom: root, strategy: 'tasks' },
  }
  const summary = `${nodes.length} 个节点 · 主语言 ${shortLabel(primary)} · ${files.length} 文件 · ${totalMarkers} 条标记${truncated ? '（已截断）' : ''}`
  return { graph, summary, stats: { files: files.length, markers: totalMarkers, primary, truncated, name } }
}

/* ------------------------------------------------------------------ CLI --- */

/**
 * 命令行入口：导入一个目录并写出两个视图。
 *
 * 自 v0.6.0 起 CLI 总是同时产出任务流水线与模块图（`workflow.json` +
 * `workflow.modules.json`）。`--modules` 仍作为兼容别名被接受，但不再表示
 * "只要模块图"。
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
  // v1.0：CLI 与宿主写同一种布局——`<out>/CodeFlow/flow-projects/<名>/`
  // （默认根；CLI 不读配置文件）。既有名扫描走 lib/paths.js，knownRoots 与
  // 旧位置里的项目照样占着它们的名字。
  const { listProjectDirs } = await import('./paths.js')
  const existing = []
  try {
    const scanned = await listProjectDirs(options.out)
    for (const name of scanned.dirs.keys()) existing.push(name)
  } catch {
    // 还没有任何根：所有名字都空闲。
  }
  // 动态 import 让 importer → analyst → importer 的环不进静态图；
  // lib/duo.js 编排两个生成器。
  const { importProjectDual } = await import('./duo.js')
  const result = await importProjectDual({ ...options, existingNames: existing })
  const dir = path.join(options.out, 'CodeFlow', 'flow-projects', result.name)
  const tasksFile = path.join(dir, 'workflow.json')
  // 这里同样原子写：CLI 曾经可能留下半个文件，下次启动就会把它读成损坏
  // 的画布。
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
