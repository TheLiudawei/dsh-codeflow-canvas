/**
 * 路径解析门面：项目目录的唯一拼装点（v1.0，需求 C）。
 *
 * v0.6.x 里每个模块自己拼 `path.join(cwd, 'flow-projects', …)`，项目永远落在
 * `<工作区>/flow-projects/` 下——它看起来像"写进了插件目录"，其实只是因为插件
 * 源码恰好在同一个工作区里。v1.0 起项目统一写到
 *
 *     <根>/flow-projects/<项目名>/
 *
 * 默认根是 `<工作区>/CodeFlow`；用户可以在配置里改成任意绝对路径（全局根），
 * 也可以给单个项目覆盖它自己的目录（`projects[<key>].dir` 指向项目目录本身）。
 *
 * 重构后的分层：配置（config.json 的读写与设置校验）在 `lib/codeflow-config.js`，
 * 旧项目迁移在 `lib/migration.js`，目录常量在 `lib/core/path.js`。本文件只保留
 * 「解析」本身——生效根、项目目录、目录骨架与项目列表扫描——并把三个来源的
 * 符号 re-export 成历史的 `lib/paths.js` 兼容面（tests 与既有调用方继续从这里
 * 导入即可）。
 *
 * 依赖方向：core/*、codeflow-config、migration ← 本模块 ← index/routes/store/
 * tool/sessions/undo/features-tool。对 migration 的依赖是单向的（迁移模块不
 * 回头 import 本模块），历史 paths ⇄ store 循环已在 core 下沉后斩断。
 *
 * @module dsh-codeflow-canvas/paths
 */
import { mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'

import {
  defaultRoot,
  logWarn,
  readConfig,
} from './codeflow-config.js'
import { FLOW_PROJECTS_DIR, projectDirOf, projectKeyOf } from './core/path.js'
import { looksLikeProject } from './migration.js'

/* ------------------------------------------------------ 历史兼容面 re-export --- */
/* 这三个来源的符号原来都定义在 paths.js；tests 与 lib 内部调用方仍从这里导入。 */

export {
  CONFIG_VERSION,
  emptyConfig,
  configPath,
  defaultRoot,
  migrationPath,
  pluginRoot,
  probeWritable,
  readConfig,
  sanitizeConfiguredDir,
  setPathsLogger,
  validateConfiguredDir,
  writeConfig,
} from './codeflow-config.js'
export { migrationNotice, migrateLegacy } from './migration.js'
export { DEFAULT_DIR_NAME, FLOW_PROJECTS_DIR as LEGACY_DIR_NAME } from './core/path.js'

/* ------------------------------------------------------------- 解析正文 --- */

/**
 * 解析当前生效的根：配置里的自定义根，或默认根。
 * @param workspace - DSH 工作区。
 * @returns 绝对路径。
 */
export async function rootOf(workspace) {
  const cfg = await readConfig(workspace)
  return cfg.root ?? defaultRoot(workspace)
}

/**
 * 解析一个项目的实际目录：
 * 1. 项目覆盖 `projects[<key>].dir`（指向项目目录本身）；
 * 2. 否则 `<当前根>/flow-projects/<目录名>/`。
 *
 * @param workspace - DSH 工作区。
 * @param key - 项目名（任意拼写；`__untitled__` 桶照常映射到 `untitled/`）。
 */
export async function projectDir(workspace, key) {
  const cfg = await readConfig(workspace)
  const name = projectKeyOf(key)
  const override = cfg.projects?.[name]?.dir
  if (typeof override === 'string' && override.length > 0) return override
  const root = cfg.root ?? defaultRoot(workspace)
  return path.join(root, FLOW_PROJECTS_DIR, projectDirOf(name))
}

/**
 * 建立目录骨架：`mkdir -p <根>/flow-projects`。只读/无权限时抛可行动错误，
 * 绝不静默吞掉——用户需要知道该去设置里改根，而不是疑惑项目写到哪了。
 * 配置目录（`<工作区>/CodeFlow`）尽力创建：写不了配置只影响持久化设置，
 * 不该阻断一次运行。
 */
export async function ensureLayout(workspace) {
  const root = await rootOf(workspace)
  const flowProjects = path.join(root, FLOW_PROJECTS_DIR)
  try {
    await mkdir(flowProjects, { recursive: true })
  } catch (error) {
    throw new Error(`无法创建 CodeFlow 项目目录 ${flowProjects}（${error?.code ?? error?.message ?? error}）。`
      + '请检查磁盘与权限，或在画布设置的「项目根目录」里改到一个可写的绝对路径。')
  }
  try {
    await mkdir(defaultRoot(workspace), { recursive: true })
  } catch (error) {
    logWarn(`无法创建配置目录 ${defaultRoot(workspace)}：${String(error?.message ?? error)}`)
  }
  return { root, flowProjects }
}

/* ----------------------------------------------------------- 项目列表扫描 --- */

/**
 * 扫描一个根下的 `flow-projects/*`，返回 `{名称: 目录}`（只认有 workflow*.json 的）。
 */
async function scanRoot(root, into) {
  const flowProjects = path.join(root, FLOW_PROJECTS_DIR)
  let entries
  try {
    entries = await readdir(flowProjects, { withFileTypes: true })
  } catch {
    return // 根不存在/不可读：直接跳过，不算错误（knownRoots 里坏一个不能影响其它）
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(flowProjects, entry.name)
    if (!(await looksLikeProject(dir))) continue
    if (!into.has(entry.name)) into.set(entry.name, dir)
  }
}

/**
 * 所有候选项目目录：去重、只认有 `workflow*.json` 的目录。优先级
 * （先到先得）：项目覆盖 > 当前根 > knownRoots > 旧 `<工作区>/flow-projects/`。
 *
 * @returns `{ dirs: Map<名称, 目录>, root, legacyDir, overrides }`。
 */
export async function listProjectDirs(workspace) {
  const dirs = new Map()
  const cfg = await readConfig(workspace)
  const root = cfg.root ?? defaultRoot(workspace)
  // 1. 项目覆盖（指向项目目录本身，可以不在任何根下面）
  for (const [key, value] of Object.entries(cfg.projects ?? {})) {
    if (typeof value?.dir !== 'string' || value.dir.length === 0) continue
    if (!(await looksLikeProject(value.dir))) continue
    if (!dirs.has(key)) dirs.set(key, value.dir)
  }
  // 2. 当前根
  await scanRoot(root, dirs)
  // 3. knownRoots（改过根之后，旧根里的项目仍要能列出/打开）
  for (const known of cfg.knownRoots ?? []) {
    if (known === root) continue
    await scanRoot(known, dirs)
  }
  // 4. 旧位置（迁移前的项目；迁移失败/冲突保留的也能继续用）
  await scanRoot(workspace, dirs)
  return { dirs, root, legacyDir: path.join(workspace, FLOW_PROJECTS_DIR), overrides: cfg.projects ?? {} }
}
