/**
 * 画布发起的 agent 运行的按次撤销。
 *
 * 每次 `RUN_NODE` / `RUN_ALL` 是一次"运行"。提示词入队之前，项目的源码树
 * 被快照进 `<根>/.undo/<runId>/before/`；撤销该运行会精确恢复这些文件和
 * 相关节点的执行状态。语义从严：
 *
 *   - 只允许 LIFO。最新的未撤销运行是唯一候选；它的快照失败
 *     （`undoable:false`）时更早的运行保持锁定——跳过它等于悄悄覆盖未知改动。
 *   - 每项目同时只有一次运行。
 *   - 恢复期间的删除只触碰**快照候选范围**（与快照同一份排除清单）。
 *     "不在 before/ 里"绝不是删除 `.git`、`node_modules`、`dist`、`.undo`
 *     内容、图元数据或任何其它被排除对象的理由。
 *   - 恢复之前先把当前树备份到 `.undo/<runId>/current-<ts>/`；备份失败则
 *     中止撤销。
 *   - 失败的恢复保留备份并上报 `undo-failed`；部分恢复后绝不报成功。
 *
 * 目录布局（D3）：
 *
 *   <root>/.undo/
 *     index.json                 快速列表；manifests 才是权威
 *     <runId>/manifest.json      { version, runId, project, action, nodeId,
 *                                  root, startedAt, finishedAt?, status,
 *                                  undoable, partial, fileCount, bytes,
 *                                  skipped?, reason?, beforeNodes[],
 *                                  undoneAt?, backupDir? }
 *     <runId>/before/            运行前的树
 *     <runId>/current-<ts>/      撤销前备份
 *
 * `.undo` 只在本地：没有任何 HTTP 路由暴露它，交付/导入扫描排除它，这里的
 * 一切也绝不进日志或其它持久化。
 *
 * @module dsh-codeflow-canvas/undo
 */
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

import { projectDir } from './paths.js'
import { normalizeView } from './graph-format.js'
import { isDirectory, writeJsonAtomic } from './core/fsio.js'
import { pathContains, projectKeyOf } from './core/path.js'

/** Default limits; tests override them via `options.limits`. */
export const UNDO_LIMITS = Object.freeze({
  maxFiles: 5000,
  maxBytes: 512 * 1024 * 1024,
  keepRuns: 10,
  keepBytes: 1024 * 1024 * 1024,
})

/** Directories never snapshotted, never restored-over, never deleted. */
export const UNDO_EXCLUDE_DIRS = Object.freeze(new Set([
  '.undo', '.git', 'node_modules', 'venv', '.venv', '__pycache__',
  'dist', 'build', 'target', 'coverage', '.next', '.cache',
]))

/**
 * 项目内的元数据文件——它们是画布状态，不是项目源码。两个视图的图文件与
 * 激活视图侧车都被排除：撤销恢复文件与节点执行字段，绝不把图文件滚回旧
 * 修订（图状态改为逐字段恢复）。
 */
const UNDO_EXCLUDE_FILES = Object.freeze(new Set(['workflow.json', 'workflow.modules.json', 'session.json', 'view.json']))

/** runId shape: timestamp + short random suffix, both filesystem-safe. */
const RUN_ID_RE = /^[A-Za-z0-9_-]{8,64}$/

/** Manifest statuses. */
const STATUS = Object.freeze({
  COMPLETE: 'complete',
  INTERRUPTED: 'interrupted',
  UNDONE: 'undone',
  UNDO_FAILED: 'undo-failed',
  ABORTED: 'aborted',
})

/** Statuses an undo may still target. */
const UNDOABLE_STATUSES = new Set([STATUS.COMPLETE, STATUS.INTERRUPTED])

/** Serialize a relative path for manifests: `/`-separated on every platform. */
function relOf(root, absolute) {
  return path.relative(root, absolute).split(path.sep).join('/')
}

/** Expand a manifest-style relative path back onto the root. */
function absOf(root, rel) {
  return path.join(root, ...String(rel).split('/'))
}

/* `contained`（包含性判断）与 `writeJsonAtomic`（原子写 JSON）原来在本文件
 * 各有一份手写实现——分别与 activity.js 的 insidePath、store.js 的原子写
 * 逐字相同。现统一取自 lib/core/path.js 与 lib/core/fsio.js。 */

/** A short stamp used for runIds and backup directory names. */
function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
    + `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
}

/**
 * 按快照规则遍历一棵树。
 *
 * @returns `{ files: Map<rel, {size, mtimeMs}>, skipped: string[], fileCount, bytes }`；
 *   `rel` 键是 `root` 下 `/` 分隔的路径。各种符号链接一律跳过（绝不跟随）
 *   并记录。
 */
async function walkTree(root, limits) {
  const files = new Map()
  const skipped = []
  let fileCount = 0
  let bytes = 0
  let overLimit = false

  async function visit(dir, rel) {
    if (overLimit) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      skipped.push(`${rel}（无法读取）`)
      return
    }
    for (const entry of entries) {
      if (overLimit) return
      const childAbs = path.join(dir, entry.name)
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        if (UNDO_EXCLUDE_DIRS.has(entry.name)) continue
        await visit(childAbs, childRel)
        continue
      }
      if (entry.isSymbolicLink()) {
        skipped.push(childRel)
        continue
      }
      if (!entry.isFile()) {
        skipped.push(childRel)
        continue
      }
      if (UNDO_EXCLUDE_FILES.has(entry.name)) continue
      let info
      try {
        // 再 lstat 一次：withFileTypes 可能与删除竞态；某些平台上符号链接
        // 目录的 dirent 会报告 isDirectory，lstat 能纠正它。
        info = await lstat(childAbs)
      } catch {
        skipped.push(childRel)
        continue
      }
      if (info.isSymbolicLink()) {
        skipped.push(childRel)
        continue
      }
      if (!info.isFile()) continue
      if (files.has(childRel)) continue
      fileCount += 1
      bytes += info.size
      if (fileCount > limits.maxFiles || bytes > limits.maxBytes) {
        overLimit = true
        return
      }
      files.set(childRel, { size: info.size, mtimeMs: info.mtimeMs })
    }
  }

  await visit(root, '')
  return { files, skipped, fileCount, bytes, overLimit }
}

/** Copy a walked tree into `dest`, recreating directories as needed. */
async function copyTree(root, files, dest) {
  for (const rel of files.keys()) {
    const target = absOf(dest, rel)
    if (!pathContains(dest, target)) throw new Error(`refusing to write outside the undo area: ${rel}`)
    await mkdir(path.dirname(target), { recursive: true })
    await copyFile(absOf(root, rel), target)
  }
}

/** Read one manifest, or `undefined` when missing/corrupt. */
async function readManifest(runDir) {
  try {
    const raw = await readFile(path.join(runDir, 'manifest.json'), 'utf8')
    const manifest = JSON.parse(raw)
    if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return undefined
    if (typeof manifest.runId !== 'string' || !RUN_ID_RE.test(manifest.runId)) return undefined
    return manifest
  } catch {
    return undefined
  }
}

/**
 * 创建撤销管理器。
 *
 * @param options.store - 画布 store（图读取与节点状态恢复）。
 * @param options.logger - Cordis logger。
 * @param options.limits - 上限覆盖（测试用）。
 * @param options.onRestored - 恢复成功后以项目键调用的钩子（用于清空活动
 *   缓冲）。
 */
export function createUndoManager({ store, logger, limits = UNDO_LIMITS, onRestored }) {
  const effective = { ...UNDO_LIMITS, ...limits }

  /** @type {Map<string, string>} project key -> runId currently being executed */
  const activeRuns = new Map()

  function undoDirOf(root) {
    return path.join(root, '.undo')
  }

  /**
   * 解析项目的快照根。
   *
   * 新项目拥有自己的持久目录——v1.0 经 `lib/paths.js` 解析（可配置根、单
   * 项目覆盖）；导入项目在 `meta.importedFrom` 是存在的目录时用它。两者都
   * 解析不出时调用方拿到 `{ error }`，运行在没有快照的情况下继续
   * （undoable:false）——快照绝不被允许阻塞一次运行。
   */
  async function resolveRoot(project) {
    const key = projectKeyOf(project)
    const state = store.get(key)
    // 已解析的持久目录（自定义根/覆盖）存在时优先；状态里也可能带着
    // 默认根拼写的回退值。
    const boundDir = state?.dir
    if (typeof boundDir === 'string' && boundDir.length > 0 && await isDirectory(boundDir)) {
      return { root: boundDir, kind: 'project' }
    }
    const workspace = state?.cwd
    if (typeof workspace === 'string' && workspace.length > 0 && await isDirectory(workspace)) {
      // 与 v1.0 之前同语义：绑定了工作区就由它决定根，哪怕项目目录本身还
      // 不存在（首次运行会创建它）。
      let resolved
      try {
        resolved = await projectDir(workspace, key)
      } catch {
        resolved = undefined
      }
      if (typeof resolved === 'string' && resolved.length > 0) {
        return { root: resolved, kind: 'project' }
      }
    }
    // 两个视图共享 `meta.importedFrom`；任一张图都可能带着它。
    const importedFrom = ['tasks', 'modules']
      .map((viewName) => store.get(key, viewName)?.graph?.meta?.importedFrom)
      .find((value) => typeof value === 'string' && value.length > 0)
    if (typeof importedFrom === 'string' && importedFrom.length > 0 && await isDirectory(importedFrom)) {
      return { root: path.normalize(importedFrom), kind: 'import' }
    }
    return { error: '未找到项目根目录（既没有绑定工作区，也没有可用的 meta.importedFrom）' }
  }


  /** List run manifests for a project, newest first, after reconciliation. */
  async function listRuns(project) {
    const resolved = await resolveRoot(project)
    if (resolved.error !== undefined) return { runs: [], ...(resolved) }
    const root = resolved.root
    const undoDir = undoDirOf(root)
    await reconcile(project, root)
    let entries
    try {
      entries = await readdir(undoDir, { withFileTypes: true })
    } catch {
      return { runs: [] }
    }
    const runs = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !RUN_ID_RE.test(entry.name)) continue
      const manifest = await readManifest(path.join(undoDir, entry.name))
      if (manifest === undefined) continue // orphan cleanup happens in reconcile
      runs.push(manifest)
    }
    runs.sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0) || String(right.runId).localeCompare(String(left.runId)))
    return {
      runs: runs.map((manifest) => ({
        runId: manifest.runId,
        action: manifest.action,
        nodeId: manifest.nodeId ?? null,
        view: normalizeView(manifest.view) ?? 'tasks',
        startedAt: manifest.startedAt,
        finishedAt: manifest.finishedAt ?? null,
        status: manifest.status,
        undoable: manifest.undoable === true && UNDOABLE_STATUSES.has(manifest.status),
        partial: manifest.partial === true,
        fileCount: manifest.fileCount ?? 0,
        bytes: manifest.bytes ?? 0,
        ...(manifest.reason ? { reason: manifest.reason } : {}),
        ...(manifest.skipped?.length ? { skippedCount: manifest.skipped.length } : {}),
      })),
    }
  }

  /** Startup/lazy reconciliation: orphan cleanup + interrupted marking. */
  async function reconcile(project, root) {
    const undoDir = undoDirOf(root)
    let entries
    try {
      entries = await readdir(undoDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !RUN_ID_RE.test(entry.name)) continue
      const runDir = path.join(undoDir, entry.name)
      const manifest = await readManifest(runDir)
      if (manifest === undefined) {
        // 没有 manifest 的目录是一次被中止/崩溃的写；规格要求启动时删除
        // 它。
        await rm(runDir, { recursive: true, force: true }).catch(() => {})
        continue
      }
      if (manifest.status === STATUS.COMPLETE && manifest.finishedAt === undefined) {
        manifest.status = STATUS.INTERRUPTED
        await writeJsonAtomic(path.join(runDir, 'manifest.json'), manifest)
      }
    }
    await enforceQuota(root)
    if (activeRuns.get(projectKeyOf(project)) === undefined) {
      // 没有别的要做；这个入口存在的意义是把对账集中在一处。
    }
  }

  /** Keep at most `keepRuns` runs / `keepBytes`, never dropping the newest undoable. */
  async function enforceQuota(root) {
    const undoDir = undoDirOf(root)
    let entries
    try {
      entries = await readdir(undoDir, { withFileTypes: true })
    } catch {
      return
    }
    const manifests = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !RUN_ID_RE.test(entry.name)) continue
      const manifest = await readManifest(path.join(undoDir, entry.name))
      if (manifest !== undefined) manifests.push(manifest)
    }
    manifests.sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0))
    let totalBytes = manifests.reduce((sum, manifest) => sum + (manifest.bytes ?? 0), 0)
    const newestUndoable = manifests.find((manifest) => manifest.undoable === true && UNDOABLE_STATUSES.has(manifest.status))
    for (let index = 0; index < manifests.length; index += 1) {
      const manifest = manifests[index]
      if (manifest === newestUndoable) continue
      if (index < effective.keepRuns && totalBytes <= effective.keepBytes) continue
      await rm(path.join(undoDir, manifest.runId), { recursive: true, force: true }).catch(() => {})
      totalBytes -= manifest.bytes ?? 0
    }
  }

  /**
   * 在一次运行之前给项目树拍快照。
   *
   * 即使快照本身失败也持有每项目运行锁：一次只许一个运行是与可撤销性无关
   * 的安全属性。手势尘埃落定后用 {@link releaseRun} 释放。
   *
   * 快照本身是项目级的（文件），但 manifest 记录了运行瞄准的**视图**，节点
   * 状态恢复因此只触碰那个视图的图、另一个原样不动。LIFO 顺序保持每项目
   * 全局：文件快照是共享的，任一视图的运行都会锁住更早运行的可撤销性。
   *
   * @returns `{ runId, undoable, partial, fileCount, bytes, skipped, root, view }`；
   *   或 `{ undoable:false, reason }` 且**绝不**抛异常：快照失败只把本次运行
   *   降级为不可撤销，绝不阻塞运行。
   */
  async function beginRun(project, { action, nodeId, nodes, view } = {}) {
    const key = projectKeyOf(project)
    const runView = normalizeView(view) ?? 'tasks'
    if (activeRuns.has(key)) {
      return { undoable: false, reason: '该项目已有一个正在进行的运行', locked: true }
    }
    activeRuns.set(key, 'pending')
    const resolved = await resolveRoot(project)
    if (resolved.error !== undefined) {
      return { undoable: false, reason: resolved.error }
    }
    const root = resolved.root
    const undoDir = undoDirOf(root)
    await reconcile(project, root)
    const date = new Date()
    const runId = `${stamp(date)}-${randomBytes(3).toString('hex')}`
    activeRuns.set(key, runId)
    const runDir = path.join(undoDir, runId)
    const beforeDir = path.join(runDir, 'before')
    /** Record a failed snapshot as an undoable:false run: it blocks skip-ahead. */
    const recordFailed = async (reason) => {
      // 半途而废的复制树被删除（D2）；manifest 保留——这次运行在历史里
      // 可见，并锁住更早运行的撤销。
      await rm(beforeDir, { recursive: true, force: true }).catch(() => {})
      const manifest = {
        version: 1,
        runId,
        project: key,
        action: action === 'RUN_NODE' ? 'RUN_NODE' : 'RUN_ALL',
        nodeId: typeof nodeId === 'string' ? nodeId : null,
        view: runView,
        root,
        startedAt: date.getTime(),
        finishedAt: Date.now(),
        status: STATUS.COMPLETE,
        undoable: false,
        partial: false,
        fileCount: 0,
        bytes: 0,
        reason,
        beforeNodes: [],
      }
      await writeJsonAtomic(path.join(runDir, 'manifest.json'), manifest)
      await writeIndex(root).catch(() => {})
    }
    try {
      const walk = await walkTree(root, effective)
      if (walk.overLimit) {
        const reason = `项目树超过快照上限（${effective.maxFiles} 个文件 / ${Math.round(effective.maxBytes / (1024 * 1024))} MB），本次运行不可撤销`
        await recordFailed(reason)
        return { runId, undoable: false, reason }
      }
      await mkdir(beforeDir, { recursive: true })
      await copyTree(root, walk.files, beforeDir)
      const manifest = {
        version: 1,
        runId,
        project: key,
        action: action === 'RUN_NODE' ? 'RUN_NODE' : 'RUN_ALL',
        nodeId: typeof nodeId === 'string' ? nodeId : null,
        view: runView,
        root,
        startedAt: date.getTime(),
        status: STATUS.COMPLETE,
        undoable: true,
        partial: walk.skipped.length > 0,
        fileCount: walk.fileCount,
        bytes: walk.bytes,
        ...(walk.skipped.length > 0 ? { skipped: walk.skipped.slice(0, 200) } : {}),
        beforeNodes: (Array.isArray(nodes) ? nodes : [])
          .filter((node) => node !== null && typeof node === 'object' && typeof node.id === 'string')
          .map((node) => ({
            id: node.id,
            status: typeof node.status === 'string' ? node.status : 'pending',
            result: typeof node.result === 'string' ? node.result : '',
            detail: typeof node.detail === 'string' ? node.detail : '',
            ...(Array.isArray(node.artifacts) ? { artifacts: node.artifacts } : {}),
            ...(Array.isArray(node.presented) ? { presented: node.presented } : {}),
          })),
      }
      await writeJsonAtomic(path.join(runDir, 'manifest.json'), manifest)
      await writeIndex(root)
      return {
        runId,
        undoable: true,
        partial: manifest.partial,
        fileCount: manifest.fileCount,
        bytes: manifest.bytes,
        skipped: walk.skipped,
        root,
        view: runView,
      }
    } catch (error) {
      const reason = `快照创建失败：${String(error?.message ?? error)}`
      await recordFailed(reason).catch(() => {})
      logger?.warn?.(`codeflow: undo snapshot failed for ${key}: ${String(error)}`)
      return { runId, undoable: false, reason }
    }
  }

  /** Rebuild the fast index from the authoritative manifests. */
  async function writeIndex(root) {
    const undoDir = undoDirOf(root)
    let entries
    try {
      entries = await readdir(undoDir, { withFileTypes: true })
    } catch {
      return
    }
    const runs = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !RUN_ID_RE.test(entry.name)) continue
      const manifest = await readManifest(path.join(undoDir, entry.name))
      if (manifest !== undefined) {
        runs.push({
          runId: manifest.runId,
          status: manifest.status,
          undoable: manifest.undoable,
          startedAt: manifest.startedAt,
          fileCount: manifest.fileCount ?? 0,
          bytes: manifest.bytes ?? 0,
        })
      }
    }
    runs.sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0))
    await writeJsonAtomic(path.join(undoDir, 'index.json'), { version: 1, runs })
  }

  /**
   * 调用方仍可撤销的那一次运行的 manifest，或拒绝的原因。
   *
   * LIFO 候选是尚未撤销的最近一次运行——已撤销的运行是已消费的历史。
   * 快照失败（`undoable:false`）的候选会挡住"跳过它往前撤"：撤销更早的
   * 运行会悄悄覆盖那次没有快照的运行改过的任何东西。
   */
  async function latestUndoable(project) {
    const { runs } = await listRuns(project)
    const latest = runs.find((run) => run.status === STATUS.COMPLETE || run.status === STATUS.INTERRUPTED)
    if (latest === undefined) {
      return { error: '还没有可撤销的运行（只能按时间倒序逐次撤销）', code: 409 }
    }
    if (latest.undoable !== true) {
      return { error: `最近一次运行未创建可用快照，无法安全撤销更早的运行（${latest.reason ?? '快照不完整'}）`, code: 409, latest }
    }
    return { latest }
  }

  /** Finish a run: release the active slot and stamp finishedAt. */
  async function finishRun(project, runId) {
    const key = projectKeyOf(project)
    releaseRun(key)
    if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) return
    const resolved = await resolveRoot(project)
    if (resolved.error !== undefined) return
    const manifest = await readManifest(path.join(undoDirOf(resolved.root), runId))
    if (manifest === undefined || manifest.status !== STATUS.COMPLETE) return
    manifest.finishedAt = Date.now()
    await writeJsonAtomic(path.join(undoDirOf(resolved.root), runId, 'manifest.json'), manifest)
    await writeIndex(resolved.root)
  }

  /** Release the per-project run lock unconditionally (failure paths). */
  function releaseRun(project) {
    activeRuns.delete(projectKeyOf(project))
  }

  /** Abort a run whose prompt never reached the session: delete the snapshot. */
  async function abortRun(project, runId) {
    const key = projectKeyOf(project)
    releaseRun(key)
    if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) return
    const resolved = await resolveRoot(project)
    if (resolved.error !== undefined) return
    await rm(path.join(undoDirOf(resolved.root), runId), { recursive: true, force: true }).catch(() => {})
    await writeIndex(resolved.root).catch(() => {})
  }

  /**
   * 快照里的一个文件与当前文件是否不同。
   *
   * v1.3.2：大小 + mtime 不足以判定。同尺寸的内容修改（`print("v1")` →
   * `print("v2")`）在时间戳分辨率较高的文件系统上可能落在同一毫秒内，于是
   * 被当成「未修改」漏报。尺寸相同且时间戳差 ≤1ms 时按内容兜底。
   *
   * @param {string} livePath - 当前文件绝对路径。
   * @param {string} beforePath - 快照副本绝对路径。
   * @param {{size:number,mtimeMs:number}} live
   * @param {{size:number,mtimeMs:number}} before
   * @returns {Promise<boolean>} true 表示内容/元信息已不同。
   */
  async function fileChanged(livePath, beforePath, live, before) {
    if (live.size !== before.size) return true
    if (Math.abs(live.mtimeMs - before.mtimeMs) > 1) return true
    try {
      const [current, snapshot] = await Promise.all([readFile(livePath), readFile(beforePath)])
      return !current.equals(snapshot)
    } catch {
      // 读不到（权限/竞态）→ 按「变了」处理，宁可多报也不漏报。
      return true
    }
  }

  /**
   * 预览一次撤销会改变什么，不碰任何东西。只比较快照候选范围——绝不比较
   * 整个根，否则 `node_modules`/`dist` 会伪装成"新增"文件。
   */
  async function dryRun(project, runId) {
    const guard = await latestUndoable(project)
    if (guard.error !== undefined) return { ok: false, error: guard.error, code: guard.code }
    if (guard.latest.runId !== runId) {
      return { ok: false, error: '只能撤销最近一次未撤销的运行：请先撤销更新的运行', code: 409 }
    }
    const resolved = await resolveRoot(project)
    if (resolved.error !== undefined) return { ok: false, error: resolved.error, code: 409 }
    const root = resolved.root
    const beforeDir = path.join(undoDirOf(root), runId, 'before')
    if (!(await isDirectory(beforeDir))) return { ok: false, error: '快照目录缺失，无法撤销', code: 409 }
    const current = await walkTree(root, effective)
    const before = await walkTree(beforeDir, effective)
    const added = []
    const modified = []
    const deleted = []
    for (const rel of before.files.keys()) {
      const live = current.files.get(rel)
      if (live === undefined) deleted.push(rel)
      else if (await fileChanged(path.join(root, rel), path.join(beforeDir, rel), live, before.files.get(rel))) modified.push(rel)
    }
    for (const rel of current.files.keys()) {
      if (!before.files.has(rel)) added.push(rel)
    }
    return {
      ok: true,
      dryRun: true,
      runId,
      files: { added, modified, deleted },
      skipped: current.skipped.length > 0 || before.skipped.length > 0
        ? [...new Set([...current.skipped, ...before.skipped])]
        : undefined,
    }
  }

  /**
   * 撤销一次运行：LIFO 校验、备份、然后恢复。任何失败都会在 manifest 记
   * `undo-failed`，备份保留以供人工抢救。
   */
  async function restore(project, runId, { dryRunOnly = false } = {}) {
    const key = projectKeyOf(project)
    // 先做形状校验：伪造的 id 是 400，而不是 LIFO 拒绝。
    if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) {
      return { ok: false, error: 'runId 不合法', code: 400 }
    }
    if (activeRuns.has(key)) {
      return { ok: false, error: '该项目正在运行中，不能撤销', code: 409 }
    }
    const guard = await latestUndoable(project)
    if (guard.error !== undefined) return { ok: false, error: guard.error, code: guard.code }
    if (guard.latest.runId !== runId) {
      return { ok: false, error: '只能撤销最近一次未撤销的运行：请先撤销更新的运行', code: 409 }
    }
    const resolved = await resolveRoot(project)
    if (resolved.error !== undefined) return { ok: false, error: resolved.error, code: 409 }
    const root = resolved.root
    const runDir = path.join(undoDirOf(root), runId)
    if (!pathContains(root, runDir)) return { ok: false, error: '快照路径越界', code: 400 }
    const beforeDir = path.join(runDir, 'before')
    const manifest = await readManifest(runDir)
    if (manifest === undefined) return { ok: false, error: '找不到该次运行的快照记录', code: 404 }
    if (manifest.project !== key) return { ok: false, error: '项目与快照不匹配', code: 400 }
    if (!(await isDirectory(beforeDir))) return { ok: false, error: '快照目录缺失，无法撤销', code: 409 }

    if (dryRunOnly) return dryRun(project, runId)

    // 1. 备份当前树。备份失败中止撤销——没有备份，一次部分恢复将不可
    //    挽救。
    const backupName = `current-${Date.now()}`
    const backupDir = path.join(runDir, backupName)
    try {
      const current = await walkTree(root, effective)
      if (current.overLimit) {
        throw new Error(`当前项目树超过备份上限（${effective.maxFiles} 个文件 / ${Math.round(effective.maxBytes / (1024 * 1024))} MB）`)
      }
      await mkdir(backupDir, { recursive: true })
      await copyTree(root, current.files, backupDir)
    } catch (error) {
      const message = `撤销前备份失败，已中止恢复：${String(error?.message ?? error)}`
      await markManifest(runDir, manifest, { status: STATUS.UNDO_FAILED, reason: message })
      return { ok: false, error: message, code: 500 }
    }

    // 2. 计算变更集，然后恢复。
    const files = { added: [], modified: [], deleted: [] }
    try {
      const before = await walkTree(beforeDir, effective)
      const current = await walkTree(root, effective)
      for (const rel of before.files.keys()) {
        const live = current.files.get(rel)
        if (live === undefined) files.deleted.push(rel)
        else if (await fileChanged(path.join(root, rel), path.join(beforeDir, rel), live, before.files.get(rel))) files.modified.push(rel)
      }
      for (const rel of current.files.keys()) {
        if (!before.files.has(rel)) files.added.push(rel)
      }
      // 删除运行新增的文件——只在候选范围之内：遍历器已经跳过了
      // .undo/.git/node_modules/… 与元数据文件。
      for (const rel of files.added) {
        const target = absOf(root, rel)
        if (!pathContains(root, target)) continue
        await rm(target, { force: true })
      }
      // 把运行前的树复制回当前树之上。
      for (const rel of before.files.keys()) {
        const target = absOf(root, rel)
        if (!pathContains(root, target)) throw new Error(`恢复路径越界：${rel}`)
        await mkdir(path.dirname(target), { recursive: true })
        await copyFile(absOf(beforeDir, rel), target)
      }
      // 剪掉变空的目录；被排除的目录绝不被触碰——它们的内容从未进入
      // `files.added`。
      await pruneEmptyDirs(root, [...files.added].map((rel) => path.dirname(absOf(root, rel))))
    } catch (error) {
      const message = `恢复失败，当前状态已保留在 ${path.join('.undo', runId, backupName)}：${String(error?.message ?? error)}`
      await markManifest(runDir, manifest, { status: STATUS.UNDO_FAILED, reason: message, backupDir: backupName })
      return { ok: false, error: message, code: 500 }
    }

    // 3. 恢复节点执行状态。位置、params、连线与标题绝不被触碰；运行之后
    //    新增的节点原样保留。
    let graphRev
    try {
      graphRev = await restoreNodes(project, manifest)
    } catch (error) {
      const message = `文件已恢复，但节点状态恢复失败：${String(error?.message ?? error)}`
      await markManifest(runDir, manifest, { status: STATUS.UNDO_FAILED, reason: message, backupDir: backupName })
      return { ok: false, error: message, code: 500, files, backupDir }
    }

    await markManifest(runDir, manifest, {
      status: STATUS.UNDONE,
      undoneAt: Date.now(),
      backupDir: backupName,
      finishedAt: manifest.finishedAt ?? Date.now(),
    })
    await writeIndex(root).catch(() => {})
    if (typeof onRestored === 'function') {
      try {
        onRestored(key)
      } catch (error) {
        logger?.warn?.(`codeflow: onRestored failed: ${String(error)}`)
      }
    }
    // backupDir 以相对运行目录的形式上报（与 manifest 同形状），UI 文案
    // 因此保持简短；绝对路径可以推导。
    return { ok: true, runId, files, backupDir: backupName, backupPath: backupDir, graphRev }
  }

  /** Flip an already-read manifest's status fields and rewrite it. */
  async function markManifest(runDir, manifest, patch) {
    const next = { ...manifest, ...patch }
    await writeJsonAtomic(path.join(runDir, 'manifest.json'), next)
  }

  /** Apply `manifest.beforeNodes` onto the manifest's view and persist it. */
  async function restoreNodes(project, manifest) {
    const viewName = normalizeView(manifest.view) ?? 'tasks'
    const before = new Map((manifest.beforeNodes ?? []).map((node) => [node.id, node]))
    if (before.size === 0) return store.get(project, viewName)?.rev ?? 0
    let view = store.get(project, viewName)
    if (view === undefined || view.graph.nodes.length === 0) {
      const state = store.get(project)
      if (typeof state?.cwd === 'string') {
        try {
          await store.loadView(project, state.cwd, viewName)
          view = store.get(project, viewName)
        } catch {
          view = undefined
        }
      }
    }
    const graph = view?.graph
    if (graph === undefined || graph.nodes.length === 0) return undefined
    const restored = {
      ...graph,
      nodes: graph.nodes.map((node) => {
        const snapshot = before.get(node.id)
        if (snapshot === undefined) return node
        const clean = {
          ...node,
          status: snapshot.status,
          result: snapshot.result,
          detail: snapshot.detail,
        }
        if (Array.isArray(snapshot.artifacts)) clean.artifacts = snapshot.artifacts
        else delete clean.artifacts
        if (Array.isArray(snapshot.presented)) clean.presented = snapshot.presented
        else delete clean.presented
        return clean
      }),
    }
    // 只写回本次运行的视图；另一个视图的图原样不动。
    const written = await store.write(restored, { persist: 'now', view: viewName })
    return written.rev
  }

  /** Remove directories that a deletion left empty (never the root). */
  async function pruneEmptyDirs(root, dirs) {
    const unique = [...new Set(dirs.filter((dir) => dir !== root && pathContains(root, dir)))]
    unique.sort((left, right) => right.length - left.length)
    for (const dir of unique) {
      try {
        const entries = await readdir(dir)
        if (entries.length === 0) await rm(dir, { recursive: true, force: true })
      } catch {
        // 已经消失，或者不属于本快照的删除范围。
      }
    }
  }

  /** Whether a run for this project is currently in flight. */
  function isRunning(project) {
    return activeRuns.has(projectKeyOf(project))
  }

  /** Drop all in-memory state (used by tests between cases). */
  function reset() {
    activeRuns.clear()
  }

  return { beginRun, finishRun, abortRun, releaseRun, restore, dryRun, listRuns, isRunning, reset, resolveRoot }
}

/** Test helper: a temp directory for scratch trees (kept here for symmetry). */
export async function tempDir(prefix = 'codeflow-undo-') {
  return mkdtemp(path.join(tmpdir(), prefix))
}
