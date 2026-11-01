/**
 * CodeFlow 配置层：`config.json` 的形状定义、宽容读写与设置校验。
 *
 * 配置文件固定放 `<工作区>/CodeFlow/config.json`——即使项目根被用户改到
 * 别处也放这里，保证"按工作区可发现"：换一个自定义根之后，配置仍然在
 * 工作区里找得到。本模块从原 paths.js 拆出（迁移与项目列表都要读配置，
 * 放在中间层可以避免 paths ⇄ migration 循环）。
 *
 * 坏配置绝不丢项目：`readConfig` 对损坏/形状不对的字段逐项回退默认值并
 * 带一次性 `warning`，已知根（knownRoots）与项目覆盖里仍可解析的部分
 * 全部保留。
 *
 * 依赖方向：core/* ← 本模块 ← migration.js / paths.js。
 *
 * @module dsh-codeflow-canvas/codeflow-config
 */
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { atomicWriteFile } from './core/fsio.js'
import { DEFAULT_DIR_NAME, safeProjectName } from './core/path.js'
import { cleanPathInput } from './workspace.js'

/* ------------------------------------------------------------- 基础设施 --- */

/** 配置 schema 版本。 */
export const CONFIG_VERSION = 1

/** 模块级 logger（index.js 注入）；没有宿主 logger 时退回 console。 */
let moduleLogger = console

/** 已经提示过配置问题的 workspace：同一个工作区只警告一次。 */
const warnedWorkspaces = new Set()

/** 注入宿主 logger（可选；测试无需调用）。 */
export function setPathsLogger(logger) {
  if (logger !== undefined && logger !== null) moduleLogger = logger
}

/** 以 `codeflow: ` 前缀记一条警告（取当前注入的 logger）。 */
export function logWarn(message) {
  moduleLogger?.warn?.(`codeflow: ${message}`)
}

/** 同一工作区只提示一次的警告。 */
function warnOnce(workspace, message) {
  if (warnedWorkspaces.has(workspace)) return
  warnedWorkspaces.add(workspace)
  logWarn(message)
}

/** 插件包自身目录（`<repo>`）：设置里拒绝把项目写进插件源码。 */
export function pluginRoot() {
  return path.resolve(fileURLToPath(new URL('../', import.meta.url)))
}

/** 是否是绝对路径（POSIX 拼写、Windows 盘符与 UNC 都认）。 */
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

/* --------------------------------------------------------- 配置形状/IO --- */

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

/** 原子写配置（core/fsio.atomicWriteFile：临时文件 → rename）。 */
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

/* ------------------------------------------------------------ 设置校验 --- */

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
