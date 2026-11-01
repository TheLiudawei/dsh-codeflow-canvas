/**
 * 集中路径解析（v1.0，需求 C）：项目目录的唯一拼装点。
 *
 * v0.6.x 里每个模块自己拼 `path.join(cwd, 'flow-projects', …)`，项目永远落在
 * `<工作区>/flow-projects/` 下——它看起来像"写进了插件目录"，其实只是因为插件
 * 源码恰好在同一个工作区里。v1.0 起项目统一写到
 *
 *     <根>/flow-projects/<项目名>/
 *
 * 默认根是 `<工作区>/CodeFlow`；用户可以在配置里改成任意绝对路径（全局根），
 * 也可以给单个项目覆盖它自己的目录（`projects[<key>].dir` 指向项目目录本身）。
 * 配置文件固定放 `<工作区>/CodeFlow/config.json`——即使根被改到别处也放这里，
 * 保证"按工作区可发现"：换一个自定义根之后，配置仍然在工作区里找得到。
 *
 * 旧数据迁移（`migrateLegacy`）：首次解析到可用工作区时，把
 * `<工作区>/flow-projects/` 里的旧项目搬进 `<根>/flow-projects/`。迁移只搬目录、
 * 不改内容；冲突不覆盖、失败保留旧目录，绝不丢数据。
 *
 * 依赖方向说明：本模块从 `store.js` 复用原子写与键名清洗，`store.js` 又从本模块
 * 取默认目录名——这是一个只在函数体内互访的 ESM 环（两边都不在模块求值期解引用
 * 对方），Node 可以安全处理。
 *
 * @module dsh-codeflow-canvas/paths
 */
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { atomicWriteFile } from './core/fsio.js'
import { DEFAULT_DIR_NAME, FLOW_PROJECTS_DIR, projectDirOf, projectKeyOf, safeProjectName } from './core/path.js'
import { VIEW_FILES } from './graph-format.js'
import { cleanPathInput } from './workspace.js'

/* 目录常量（默认根名 `CodeFlow` / 项目段名 `flow-projects`）统一定义在
 * lib/core/path.js——那是项目命名契约的唯一事实来源；这里以历史名称
 * re-export（LEGACY_DIR_NAME 兼容旧称，语义同 FLOW_PROJECTS_DIR）。 */
export { DEFAULT_DIR_NAME, FLOW_PROJECTS_DIR as LEGACY_DIR_NAME }

/** 配置 schema 版本。 */
const CONFIG_VERSION = 1

/** 模块级 logger（index.js 注入）；没有宿主 logger 时退回 console。 */
let moduleLogger = console

/** 已经提示过配置问题的 workspace：同一个工作区只警告一次。 */
const warnedWorkspaces = new Set()

/** 迁移已完成/进行中的 workspace：进程内幂等守卫（另一层是 config.migratedAt）。 */
const migratedWorkspaces = new Set()

/** 注入宿主 logger（可选；测试无需调用）。 */
export function setPathsLogger(logger) {
  if (logger !== undefined && logger !== null) moduleLogger = logger
}

/** 插件包自身目录（`<repo>`）：设置里拒绝把项目写进插件源码。 */
export function pluginRoot() {
  return path.resolve(fileURLToPath(new URL('../', import.meta.url)))
}

/** 一个空的、形状完整的配置（也是损坏配置的回退值）。 */
export function emptyConfig() {
  return { version: CONFIG_VERSION, root: null, knownRoots: [], projects: {}, migratedAt: null }
}

/** 配置文件的绝对路径：永远在 `<工作区>/CodeFlow/config.json`，与当前根无关。 */
export function configPath(workspace) {
  return path.join(defaultRoot(workspace), 'config.json')
}

/** 迁移报告的绝对路径：`<工作区>/CodeFlow/migration.json`。 */
export function migrationPath(workspace) {
  return path.join(defaultRoot(workspace), 'migration.json')
}

/** 默认根：`<工作区>/CodeFlow`。 */
export function defaultRoot(workspace) {
  if (typeof workspace !== 'string' || workspace.length === 0) {
    throw new Error('paths: 需要一个可用的工作区路径')
  }
  return path.join(workspace, DEFAULT_DIR_NAME)
}

/** 是否是绝对路径（两种分隔符都认）。 */
function isAbsolute(target) {
  return path.isAbsolute(target) || /^[a-zA-Z]:[\\/]/.test(target) || target.startsWith('\\\\')
}

/** 目录是否存在且确实是目录。 */
async function isDir(target) {
  try {
    return (await stat(target)).isDirectory()
  } catch {
    return false
  }
}

/** 规整一个绝对路径拼写（大小写、分隔符原样保留；仅折叠冗余分隔符）。 */
function normalizeAbs(target) {
  return path.normalize(target)
}

/**
 * 读取配置。配置缺失 → 空配置；JSON 损坏 / 形状不对 / root 不是绝对路径 →
 * 回退默认根并带一次性 `warning`。**坏配置绝不能丢项目**：knownRoots 与
 * projects 覆盖里仍可解析的部分会保留，坏掉的字段整体回退默认值。
 *
 * @returns 配置对象（`root` 为 `null` 表示用默认根），可能带 `warning` 字段。
 */
export async function readConfig(workspace) {
  const fallback = emptyConfig()
  if (typeof workspace !== 'string' || workspace.length === 0) return fallback
  let raw
  try {
    raw = await readFile(configPath(workspace), 'utf8')
  } catch {
    return fallback // 不存在：首次使用，属于正常路径
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    warnOnce(workspace, `CodeFlow config.json 无法解析（${String(error?.message ?? error)}），已回退默认根；项目仍可从已知位置找到。`)
    return fallback
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warnOnce(workspace, 'CodeFlow config.json 内容不是对象，已回退默认根；项目仍可从已知位置找到。')
    return fallback
  }
  const cfg = emptyConfig()
  if (typeof parsed.root === 'string' && isAbsolute(parsed.root.trim()) && parsed.root.trim().length > 0) {
    cfg.root = normalizeAbs(parsed.root.trim())
  } else if (parsed.root !== undefined && parsed.root !== null) {
    warnOnce(workspace, 'CodeFlow config.json 里的 root 不是绝对路径，已回退默认根。')
  }
  if (Array.isArray(parsed.knownRoots)) {
    cfg.knownRoots = [...new Set(parsed.knownRoots
      .filter((entry) => typeof entry === 'string' && isAbsolute(entry.trim()) && entry.trim().length > 0)
      .map((entry) => normalizeAbs(entry.trim())))]
  }
  if (parsed.projects !== null && typeof parsed.projects === 'object' && !Array.isArray(parsed.projects)) {
    for (const [key, value] of Object.entries(parsed.projects)) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
      if (typeof value.dir !== 'string' || !isAbsolute(value.dir.trim()) || value.dir.trim().length === 0) continue
      const name = safeProjectName(key)
      cfg.projects[name] = { dir: normalizeAbs(value.dir.trim()), ...(Number.isFinite(value.updatedAt) ? { updatedAt: value.updatedAt } : {}) }
    }
  }
  if (Number.isFinite(parsed.migratedAt)) cfg.migratedAt = parsed.migratedAt
  else if (parsed.migratedAt !== undefined && parsed.migratedAt !== null) {
    warnOnce(workspace, 'CodeFlow config.json 里的 migratedAt 不是数字，忽略。')
  }
  return cfg
}

/** 同一工作区只提示一次的警告。 */
function warnOnce(workspace, message) {
  if (warnedWorkspaces.has(workspace)) return
  warnedWorkspaces.add(workspace)
  moduleLogger?.warn?.(`codeflow: ${message}`)
}

/** 原子写配置（与 store.atomicWriteFile 同一思路：临时文件 → rename）。 */
export async function writeConfig(workspace, cfg) {
  const body = {
    version: CONFIG_VERSION,
    ...(cfg.root ? { root: cfg.root } : { root: null }),
    knownRoots: [...(cfg.knownRoots ?? [])],
    projects: cfg.projects ?? {},
    ...(cfg.migratedAt ? { migratedAt: cfg.migratedAt } : {}),
    updatedAt: Date.now(),
  }
  await mkdir(defaultRoot(workspace), { recursive: true })
  await atomicWriteFile(configPath(workspace), JSON.stringify(body, null, 2))
  return body
}

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
    moduleLogger?.warn?.(`codeflow: 无法创建配置目录 ${defaultRoot(workspace)}：${String(error?.message ?? error)}`)
  }
  return { root, flowProjects }
}

/**
 * 一个目录里是否有任何 `workflow*.json`（判定"这是一个 CodeFlow 项目目录"）。
 */
async function looksLikeProject(dir) {
  for (const file of Object.values(VIEW_FILES)) {
    try {
      if ((await stat(path.join(dir, file))).isFile()) return true
    } catch {
      // 缺这个文件很正常；两个都没有才算"不是项目"。
    }
  }
  return false
}

/** 目录是否存在且至少有一个条目（判定"目标已占用"）。 */
async function hasEntries(dir) {
  try {
    return (await readdir(dir)).length > 0
  } catch {
    return false
  }
}

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

/* --------------------------------------------------------------- 迁移 --- */

/**
 * `.undo/` 里是否有"开始了但没写 finishedAt"的 run（项目正在运行 → 本次跳过）。
 */
async function hasActiveRun(projectDirPath) {
  const undoDir = path.join(projectDirPath, '.undo')
  let entries
  try {
    entries = await readdir(undoDir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    let manifest
    try {
      manifest = JSON.parse(await readFile(path.join(undoDir, entry.name, 'manifest.json'), 'utf8'))
    } catch {
      continue // 没有 manifest 的目录由 undo 自身的 reconcile 清理，与迁移无关
    }
    if (manifest !== null && typeof manifest === 'object' && manifest.finishedAt === undefined) return true
  }
  return false
}

/** 关键文件跟着到了目标目录（复制回退路径的校验）。 */
async function migratedIntact(dest) {
  if (await looksLikeProject(dest)) return true
  // 至少要有一些内容：workflow 缺失但目录非空也算"搬过去了"（如纯代码项目）
  return hasEntries(dest)
}

/** 把迁移结果写进 migration.json 与 config.migratedAt（尽力而为，失败只警告）。 */
async function recordMigration(workspace, cfg, report) {
  try {
    await mkdir(defaultRoot(workspace), { recursive: true })
    await atomicWriteFile(migrationPath(workspace), JSON.stringify({ version: CONFIG_VERSION, at: Date.now(), ...report }, null, 2))
  } catch (error) {
    moduleLogger?.warn?.(`codeflow: 无法写 migration.json：${String(error?.message ?? error)}`)
  }
  cfg.migratedAt = Date.now()
  try {
    await writeConfig(workspace, cfg)
  } catch (error) {
    moduleLogger?.warn?.(`codeflow: 无法把 migratedAt 写进 config.json：${String(error?.message ?? error)}`)
  }
}

/**
 * 旧项目自动迁移：`<工作区>/flow-projects/*` → `<根>/flow-projects/*`。
 *
 * 触发：插件激活后第一次解析到可用工作区（routes 在 boot / 列项目 / 新建 /
 * 导入前调用），每个工作区只做一次（`config.migratedAt` + 进程内 Set 双保险）。
 *
 * 单个项目：
 *   1. 目标存在且非空 → 不覆盖，记 `conflict`，旧目录保留；
 *   2. 否则 `rename`；`EXDEV`/`EPERM`/`EACCES` → 递归复制 + 校验关键文件后删旧目录；
 *   3. 其它失败 → 保留旧目录，记 `failed`（含原因）。**绝不丢数据。**
 *
 * 幂等：重复执行不重复搬、不报错；旧目录不存在时直接跳过并补记 migratedAt。
 *
 * @returns `{ moved, conflicts, failed, deferred, skipped, root, legacyDir }`。
 */
export async function migrateLegacy(workspace) {
  const empty = { moved: [], conflicts: [], failed: [], deferred: [], skipped: true, root: undefined, legacyDir: undefined }
  if (typeof workspace !== 'string' || workspace.length === 0) return empty
  const cfg = await readConfig(workspace)
  if (cfg.migratedAt) return { ...empty, root: cfg.root ?? defaultRoot(workspace) }
  if (migratedWorkspaces.has(workspace)) return { ...empty, root: cfg.root ?? defaultRoot(workspace) }
  migratedWorkspaces.add(workspace)

  const root = cfg.root ?? defaultRoot(workspace)
  const legacyDir = path.join(workspace, FLOW_PROJECTS_DIR)
  const targetRoot = path.join(root, FLOW_PROJECTS_DIR)
  const report = { moved: [], conflicts: [], failed: [], deferred: [], skipped: false, root, legacyDir }

  let entries
  try {
    entries = await readdir(legacyDir, { withFileTypes: true })
  } catch {
    // 没有旧目录：首次使用或已迁移过（migration.json 丢失）。补记一次即幂等。
    await recordMigration(workspace, cfg, { moved: [], conflicts: [], failed: [], deferred: [] })
    return { ...report, skipped: true }
  }
  if (entries.filter((entry) => entry.isDirectory()).length === 0) {
    await recordMigration(workspace, cfg, { moved: [], conflicts: [], failed: [], deferred: [] })
    return { ...report, skipped: true }
  }
  try {
    await mkdir(targetRoot, { recursive: true })
  } catch (error) {
    // 目标根建不出来（只读/被文件占位/跨盘问题）：不在这里放弃——继续逐项目
    // 尝试，让每个项目都得到自己的 failed 记录（原因里带上目标根的错误），
    // 旧目录全部保留；修好根之后删除 config.migratedAt 即可再次触发。
    moduleLogger?.warn?.(`codeflow: 迁移目标 ${targetRoot} 无法创建：${String(error?.message ?? error)}`)
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const name = entry.name
    const src = path.join(legacyDir, name)
    const dest = path.join(targetRoot, name)
    if (await hasActiveRun(src)) {
      // 正在运行的项目跳过，下次再迁（.undo 里有未完结的 run）。
      report.deferred.push(name)
      continue
    }
    if (await hasEntries(dest)) {
      // 目标已存在且非空：不覆盖（覆盖会丢数据），旧目录保留并在旧位置继续可用。
      report.conflicts.push(name)
      continue
    }
    try {
      await rename(src, dest)
      report.moved.push(name)
    } catch (error) {
      const code = error?.code
      if (code === 'EXDEV' || code === 'EPERM' || code === 'EACCES') {
        // 跨盘/被占用：递归复制后校验，再删旧目录；校验不过就保留旧目录。
        try {
          await cp(src, dest, { recursive: true, force: false, errorOnExist: true })
          if (!(await migratedIntact(dest))) throw new Error('复制完成后未在目标目录找到工作流文件')
          await rm(src, { recursive: true, force: true })
          report.moved.push(name)
        } catch (copyError) {
          await rm(dest, { recursive: true, force: true }).catch(() => {})
          report.failed.push({ name, error: String(copyError?.message ?? copyError) })
        }
      } else {
        report.failed.push({ name, error: String(error?.message ?? error) })
      }
    }
    // 迁移内容是整个目录（rename 天然全量）；顺手清掉项目顶层的 *.tmp 临时文件
    // （*.bad-* 隔离文件随目录一起搬，绝不丢）。
    if (report.moved.includes(name)) {
      try {
        for (const child of await readdir(dest)) {
          if (child.endsWith('.tmp')) await rm(path.join(dest, child), { force: true }).catch(() => {})
        }
      } catch {
        // 清理失败无关紧要。
      }
    }
  }
  await recordMigration(workspace, cfg, {
    moved: report.moved,
    conflicts: report.conflicts,
    failed: report.failed,
    deferred: report.deferred,
  })
  return report
}

/** 一次迁移的中文汇总（画布 banner 用）；没有可汇报的内容时返回 `undefined`。 */
export function migrationNotice(report) {
  if (report === undefined || report === null || report.skipped === true) return undefined
  const parts = []
  if (report.moved?.length) parts.push(`已迁移 ${report.moved.length} 个项目到 ${DEFAULT_DIR_NAME}/flow-projects/`)
  if (report.conflicts?.length) parts.push(`同名冲突未覆盖：${report.conflicts.join('、')}（旧目录保留）`)
  if (report.failed?.length) parts.push(`迁移失败：${report.failed.map((entry) => entry.name).join('、')}`)
  if (report.deferred?.length) parts.push(`正在运行、稍后再迁：${report.deferred.join('、')}`)
  if (parts.length === 0) return undefined
  return parts.join('；') + '。'
}

/* ----------------------------------------------------------- 配置校验 --- */

/** 校验失败抛出的错误：携带 statusCode 供路由层直接回答 400/409。 */
function invalid(message, statusCode = 400) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

/**
 * 清洗并校验用户在设置里输入的一个绝对路径（根目录或项目目录）：
 * 展开 `~`/引号/`@`/`file://`，**必须绝对路径**（相对路径直接拒绝——设置会在
 * 重启后原样使用，相对路径无法保持含义）、必须不是文件、必须不等于/不位于
 * 插件包目录内。
 *
 * @returns 规整后的绝对路径。
 * @throws 带 `statusCode` 的中文错误。
 */
export function sanitizeConfiguredDir(raw, { kind = '目录' } = {}) {
  let value = String(raw ?? '').trim()
  if (value.length === 0) throw invalid(`${kind}不能为空；要恢复默认请把输入框留空后直接保存。`)
  // cleanPathInput 只做清洗（@/引号/~/file://），不给 cwd：相对路径保持相对，
  // 由下面的绝对路径检查统一拒绝，而不是被静默解析成"工作区下的某个位置"。
  value = cleanPathInput(value)
  if (value.length === 0) throw invalid(`${kind}不能为空。`)
  if (!isAbsolute(value)) throw invalid(`${kind}必须是绝对路径（收到：${value}）。相对路径无法在重启后保持含义，请改为完整路径。`)
  value = normalizeAbs(value)
  const plugin = pluginRoot()
  if (value === plugin || value.startsWith(plugin + path.sep)) {
    throw invalid(`${kind}不能在插件包目录（${plugin}）内：插件更新会被覆盖，请选择工作区内或其它磁盘位置。`, 409)
  }
  return value
}

/**
 * 探测一个目录可写：`mkdir -p` + 写/删一个探测文件。
 * @throws 带 `statusCode` 的中文错误（409）。
 */
export async function probeWritable(dir) {
  const probe = path.join(dir, `.codeflow-probe-${process.pid}-${randomBytes(3).toString('hex')}`)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(probe, 'codeflow', 'utf8')
    await rm(probe, { force: true })
  } catch (error) {
    throw invalid(`目录不可写：${dir}（${error?.code ?? error?.message ?? error}）。请检查权限，或换一个位置。`, 409)
  }
}

/**
 * 校验一个"还不存在也可以"的目录：不存在 → 检查父目录存在；存在 → 必须是目录。
 * @throws 带 `statusCode` 的中文错误。
 */
export async function validateConfiguredDir(raw, { kind = '目录' } = {}) {
  const value = sanitizeConfiguredDir(raw, { kind })
  let info
  try {
    info = await stat(value)
  } catch {
    // 不存在：允许（根目录会在 ensureLayout 时创建），但父目录必须存在，
    // 否则八成是拼写错误（多了一层、盘符写错）。
    const parent = path.dirname(value)
    if (!(await isDir(parent))) {
      throw invalid(`父目录不存在：${parent}。请先创建它，或检查路径拼写。`, 409)
    }
    return value
  }
  if (!info.isDirectory()) throw invalid(`该路径是一个文件，不是目录：${value}`, 400)
  return value
}
