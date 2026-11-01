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
import { freeName } from './core/path.js'
import { importProject } from './importer.js'
import { safeProjectName } from './core/path.js'
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
