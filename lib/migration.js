/**
 * 旧项目自动迁移（v1.0，需求 C）：`<工作区>/flow-projects/*` →
 * `<根>/flow-projects/*`，一次性、幂等、绝不丢数据。
 *
 * 触发：插件激活后第一次解析到可用工作区（routes 在 boot / 列项目 / 新建 /
 * 导入前调用），每个工作区只做一次（`config.migratedAt` + 进程内 Set 双保险）。
 *
 * 单个项目的迁移策略：
 *   1. 目标存在且非空 → 不覆盖，记 `conflict`，旧目录保留（旧位置继续可用）；
 *   2. 否则 `rename` 整目录；`EXDEV`/`EPERM`/`EACCES` → 递归复制 + 校验关键
 *      文件后删旧目录（校验不过就保留旧目录）；
 *   3. 其它失败 → 保留旧目录，记 `failed`（含原因）；
 *   4. `.undo/` 里有未完结 run（正在运行）的项目 → 本次跳过，记 `deferred`。
 *
 * 结果汇总落盘 `<工作区>/CodeFlow/migration.json`（画布 banner 用），进度
 * 记进 `config.migratedAt`。幂等：重复执行不重复搬、不报错；旧目录不存在时
 * 直接跳过并补记 migratedAt。
 *
 * 依赖方向：core/* 与 codeflow-config ← 本模块 ← paths.js（仅 re-export 与
 * 项目目录识别助手）。
 *
 * @module dsh-codeflow-canvas/migration
 */
import { cp, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'

import { atomicWriteFile } from './core/fsio.js'
import { DEFAULT_DIR_NAME, FLOW_PROJECTS_DIR } from './core/path.js'
import { CONFIG_VERSION, defaultRoot, logWarn, migrationPath, readConfig, writeConfig } from './codeflow-config.js'
import { VIEW_FILES } from './graph-format.js'

/** 迁移已完成/进行中的 workspace：进程内幂等守卫（另一层是 config.migratedAt）。 */
const migratedWorkspaces = new Set()

/* ------------------------------------------------- 项目目录识别（共享）--- */

/**
 * 一个目录里是否有任何 `workflow*.json`（判定"这是一个 CodeFlow 项目目录"）。
 * 项目列表扫描与迁移完整性校验共用同一份判据。
 */
export async function looksLikeProject(dir) {
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
export async function hasEntries(dir) {
  try {
    return (await readdir(dir)).length > 0
  } catch {
    return false
  }
}

/* ------------------------------------------------------------ 迁移正文 --- */

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
    logWarn(`无法写 migration.json：${String(error?.message ?? error)}`)
  }
  cfg.migratedAt = Date.now()
  try {
    await writeConfig(workspace, cfg)
  } catch (error) {
    logWarn(`无法把 migratedAt 写进 config.json：${String(error?.message ?? error)}`)
  }
}

/**
 * 执行一次旧项目迁移（详见模块头注释）。
 *
 * @param workspace - DSH 工作区。
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
    logWarn(`迁移目标 ${targetRoot} 无法创建：${String(error?.message ?? error)}`)
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
