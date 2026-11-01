/**
 * Dual import: one scan of a project directory produces **both** canvas views
 * under one project name.
 *
 * Until v0.6.0 the import dialog asked the user to choose between the marker
 * task pipeline (`lib/importer.js`) and the code-structure module graph
 * (`lib/analyst.js`). The two scans read the same directory with the same
 * rules, so the choice was false economy: this module runs both generators
 * against one shared project name and returns both graphs.
 *
 * Failure isolation is part of the contract: if the module analysis cannot
 * produce a usable graph (a directory with almost no source code, or an
 * unexpected parse error), the task pipeline still imports — the module view
 * is reported unavailable with an actionable warning instead of a fabricated
 * empty module graph. A task-pipeline failure still fails the whole import.
 *
 * @module dsh-codeflow-canvas/duo
 */
import path from 'node:path'

import { analyzeModules } from './analyst.js'
import { clip } from './core/text.js'
import { freeName, safeProjectName } from './core/path.js'
import { importProject } from './importer.js'
import { buildFeatureIndex, graphRootOf, summarize, writeFeatureIndex } from './features.js'
import { cleanPathInput, resolveProjectRoot } from './workspace.js'

/**
 * Run both import generators against one directory.
 *
 * @param options.path - absolute or `cwd`-relative directory to import.
 * @param options.cwd - workspace used to resolve relative paths.
 * @param options.existingNames - project names already under the project roots.
 * @param options.projectName - force a project name (shared by both graphs).
 * @param options.maxFiles - file budget (default 200, capped at 1000).
 * @param options.maxDepth - directory depth limit (default 4 for tasks / 6 for modules).
 * @param options.fromComments - generate task nodes from markers (default true).
 * @param options.addTests - add `testgen` when no test file exists (default true).
 * @returns `{ tasksGraph, modulesGraph?, tasksSummary, modulesSummary?, summary,
 *   modulesWarning?, name }`; `modulesGraph` is `undefined` when the module
 *   analysis failed (see `modulesWarning`).
 */
export async function importProjectDual(options = {}) {
  const cwd = cleanPathInput(options.cwd ?? process.cwd())
  // Resolve (and validate) the directory once: a bad path fails loudly before
  // either generator runs.
  const root = await resolveProjectRoot(options.path, cwd)
  const existingNames = Array.from(options.existingNames ?? [])
  const name = typeof options.projectName === 'string' && options.projectName.length > 0
    ? safeProjectName(options.projectName)
    : freeName(safeProjectName(path.basename(root)), existingNames)
  const shared = {
    ...options,
    path: root,
    cwd,
    // One project, one name: both generators must land in the same directory,
    // so the free-name resolution happens exactly once, here.
    projectName: name,
    existingNames,
  }

  const tasks = await importProject(shared)

  let modules
  let modulesWarning
  try {
    modules = await analyzeModules(shared)
  } catch (error) {
    modulesWarning = String(error?.message ?? error)
  }
  // "Almost no source" is a failure too: a graph of a lone scan node would be
  // an empty module view pretending to exist. Require at least one module node.
  if (modules !== undefined && !modules.graph?.nodes?.some((node) => node.type === 'module')) {
    modules = undefined
    modulesWarning ??= '目录中没有可识别的源码文件，无法构建模块结构图'
  }

  const summary = modules !== undefined
    ? clip(`已生成：任务流水线 ${tasks.graph.nodes.length} 节点 · 模块结构图 ${modules.graph.nodes.filter((node) => node.type === 'module').length} 节点（可切换）`, 120)
    : clip(`已生成：任务流水线 ${tasks.graph.nodes.length} 节点 · 模块结构图不可用（可切换控件隐藏）`, 120)

  return {
    tasksGraph: tasks.graph,
    modulesGraph: modules?.graph,
    tasksSummary: tasks.summary,
    modulesSummary: modules?.summary,
    modulesWarning,
    summary,
    name,
  }
}

/**
 * 双图导入结果的持久化落地下限（HTTP /api/import、拖拽导入与 /flow-import
 * 命令共用的最小序列）：
 *
 *   1. 写任务图（persist:'now'）——主图，失败抛错（导入本身失败）；
 *   2. 写模块图——失败**绝不**回滚任务图（视图摘要如实显示模块视图缺失）；
 *   3. v1.1 功能索引钩子：两张图落定后立刻做一次功能识别并落盘
 *      （纯本地、确定性）；失败只降级为「没有 featuresSummary」。
 *
 * 三个入口各不相同的部分（自动耦合、会话绑定、响应载荷 / 摘要文本）留在
 * 各自的调用方——这里只收敛真正重复的那一段。
 *
 * @param store - 画布 store。
 * @param options.result - {@link importProjectDual} 的返回。
 * @param options.cwd - 工作区（可为 `undefined`：图只在内存中）。
 * @param options.dir - 项目持久目录（可为 `undefined`：store 回退默认根拼写）。
 * @param options.title - 写任务图时附着的标题（/flow-import 附项目名；
 *   HTTP 路由不附，保持行为不变）。
 * @param options.logger - 诊断日志（可选）。
 * @returns `{ writtenTasks, writtenModules, featuresSummary }`。
 */
export async function persistDualResult(store, options = {}) {
  const { result, cwd, dir, title, logger } = options
  const writtenTasks = await store.write(result.tasksGraph, {
    persist: 'now',
    cwd,
    dir,
    view: 'tasks',
    ...(title !== undefined ? { title } : {}),
  })
  let writtenModules
  if (result.modulesGraph !== undefined) {
    try {
      writtenModules = await store.write(result.modulesGraph, { persist: 'now', cwd, dir, view: 'modules' })
    } catch (error) {
      writtenModules = { error: String(error?.message ?? error) }
    }
  }
  let featuresSummary
  if (dir !== undefined && result.modulesGraph !== undefined) {
    try {
      const built = await buildFeatureIndex({
        root: graphRootOf(result.modulesGraph) ?? dir,
        graph: result.modulesGraph,
      })
      await writeFeatureIndex(dir, built)
      featuresSummary = summarize(built)
    } catch (error) {
      logger?.warn?.(`codeflow: feature recognition failed after import: ${String(error)}`)
    }
  }
  return { writtenTasks, writtenModules, featuresSummary }
}
