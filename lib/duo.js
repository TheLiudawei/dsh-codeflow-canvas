/**
 * 双图导入：一次扫描一个项目目录，在同一个项目名下产出**两个**画布视图。
 *
 * v0.6.0 之前，导入对话框让用户在标记任务流水线（`lib/importer.js`）与代码
 * 结构模块图（`lib/analyst.js`）之间二选一。两次扫描读的是同一个目录、用的
 * 是同一套规则，那个选择是虚假的省钱：本模块以一个共享项目名跑两个生成器，
 * 一次返回两张图。
 *
 * 失败隔离是契约的一部分：模块分析产不出可用的图（目录里几乎没有源码，或
 * 意外解析错误）时，任务流水线照常导入——模块视图以可行动的警告上报为
 * 不可用，绝不伪造一张空的模块图。任务流水线失败则整个导入失败。
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
 * 对一个目录跑两个导入生成器。
 *
 * @param options.path - 要导入的目录（绝对或相对 `cwd`）。
 * @param options.cwd - 解析相对路径用的工作区。
 * @param options.existingNames - 项目根下已被占用的项目名。
 * @param options.projectName - 强制项目名（两张图共用）。
 * @param options.maxFiles - 文件预算（默认 200，上限 1000）。
 * @param options.maxDepth - 目录深度上限（任务流水线默认 4 / 模块图默认 6）。
 * @param options.fromComments - 从标记生成任务节点（默认 true）。
 * @param options.addTests - 没有测试文件时补 `testgen`（默认 true）。
 * @returns `{ tasksGraph, modulesGraph?, tasksSummary, modulesSummary?, summary,
 *   modulesWarning?, name }`；模块分析失败时 `modulesGraph` 为 `undefined`
 *   （见 `modulesWarning`）。
 */
export async function importProjectDual(options = {}) {
  const cwd = cleanPathInput(options.cwd ?? process.cwd())
  // 目录只解析（并校验）一次：坏路径在任何一个生成器启动之前就大声失败。
  const root = await resolveProjectRoot(options.path, cwd)
  const existingNames = Array.from(options.existingNames ?? [])
  const name = typeof options.projectName === 'string' && options.projectName.length > 0
    ? safeProjectName(options.projectName)
    : freeName(safeProjectName(path.basename(root)), existingNames)
  const shared = {
    ...options,
    path: root,
    cwd,
    // 一个项目、一个名字：两个生成器必须落进同一个目录，空闲名解析因此
    // 恰好发生一次、就在这里。
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
  // "几乎没有源码"也算失败：一张只有孤零零扫描节点的图是一个假装存在的空
  // 模块视图。至少要有一个 module 节点。
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
