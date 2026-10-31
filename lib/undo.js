/**
 * Run-scoped undo for canvas-initiated agent runs.
 *
 * Every `RUN_NODE` / `RUN_ALL` is one "run". Before the prompt is queued, the
 * project's source tree is snapshotted into
 * `<root>/.undo/<runId>/before/`; undoing that run restores exactly those
 * files and the execution state of the nodes involved. Semantics are strict:
 *
 *   - LIFO only. The newest not-yet-undone run is the only candidate; if its
 *     snapshot failed (`undoable:false`) earlier runs stay locked — skipping
 *     it would silently overwrite unknown changes.
 *   - One run at a time per project.
 *   - Deletions during restore only ever touch the *snapshot candidate scope*
 *     (same exclusion list as the snapshot). "Not in before/" is never a
 *     reason to delete `.git`, `node_modules`, `dist`, `.undo` content, the
 *     graph metadata, or anything else excluded.
 *   - Before restoring, the current tree is backed up to
 *     `.undo/<runId>/current-<ts>/`; a failed backup aborts the undo.
 *   - A failed restore keeps the backup and reports `undo-failed`; it never
 *     reports success after a partial restore.
 *
 * Directory layout (D3):
 *
 *   <root>/.undo/
 *     index.json                 fast list; manifests are authoritative
 *     <runId>/manifest.json      { version, runId, project, action, nodeId,
 *                                  root, startedAt, finishedAt?, status,
 *                                  undoable, partial, fileCount, bytes,
 *                                  skipped?, reason?, beforeNodes[],
 *                                  undoneAt?, backupDir? }
 *     <runId>/before/            the pre-run tree
 *     <runId>/current-<ts>/      pre-undo backup
 *
 * `.undo` is local-only: no HTTP route exposes it, it is excluded from
 * delivery/import scans, and nothing here is logged or persisted elsewhere.
 *
 * @module dsh-codeflow-canvas/undo
 */
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

import { normalizeView, projectDirOf, projectKeyOf } from './store.js'

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
 * Project-local metadata files that are canvas state, not project source.
 * Both views' graph files and the active-view sidecar are excluded: undo
 * restores files and node execution fields, never rolls a graph file back to
 * an older revision (the graph state is restored field-by-field instead).
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

/** Containment test: `target` must resolve inside `root` (no traversal). */
function contained(root, target) {
  const rel = path.relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** Temp-file + rename JSON write, so records never land half-written. */
async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temp, JSON.stringify(value, null, 2), 'utf8')
  try {
    await rename(temp, file)
  } catch {
    try {
      await writeFile(file, JSON.stringify(value, null, 2), 'utf8')
    } finally {
      await rm(temp, { force: true }).catch(() => {})
    }
  }
}

/** A short stamp used for runIds and backup directory names. */
function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
    + `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
}

/**
 * Walk one tree under the snapshot rules.
 *
 * @returns `{ files: Map<rel, {size, mtimeMs}>, skipped: string[], fileCount, bytes }`
 *   where `rel` keys are `/`-separated paths under `root`. Symlinks of every
 *   kind are skipped (never followed) and recorded.
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
        // lstat again: withFileTypes can race a delete; and on some platforms
        // the dirent of a symlinked dir reports isDirectory, which lstat corrects.
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
    if (!contained(dest, target)) throw new Error(`refusing to write outside the undo area: ${rel}`)
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
 * Create the undo manager.
 *
 * @param options.store - canvas store (graph reads and node-state restore).
 * @param options.logger - Cordis logger.
 * @param options.limits - limit overrides (tests).
 * @param options.onRestored - hook called with the project key after a
 *   successful restore (used to clear the activity buffer).
 */
export function createUndoManager({ store, logger, limits = UNDO_LIMITS, onRestored }) {
  const effective = { ...UNDO_LIMITS, ...limits }

  /** @type {Map<string, string>} project key -> runId currently being executed */
  const activeRuns = new Map()

  function undoDirOf(root) {
    return path.join(root, '.undo')
  }

  /**
   * Resolve the snapshot root for a project.
   *
   * New projects own `<workspace>/flow-projects/<project>/`; imported projects
   * use the graph's `meta.importedFrom` when it is an existing directory. When
   * neither resolves, the caller gets `{ error }` and the run proceeds
   * un-snapshotted (undoable:false) — a snapshot is never allowed to block a
   * run.
   */
  async function resolveRoot(project) {
    const key = projectKeyOf(project)
    const state = store.get(key)
    const workspace = state?.cwd
    if (typeof workspace === 'string' && workspace.length > 0 && await isDir(workspace)) {
      return { root: path.join(workspace, 'flow-projects', projectDirOf(key)), kind: 'project' }
    }
    // Both views share `meta.importedFrom`; either graph may carry it.
    const importedFrom = ['tasks', 'modules']
      .map((viewName) => store.get(key, viewName)?.graph?.meta?.importedFrom)
      .find((value) => typeof value === 'string' && value.length > 0)
    if (typeof importedFrom === 'string' && importedFrom.length > 0 && await isDir(importedFrom)) {
      return { root: path.normalize(importedFrom), kind: 'import' }
    }
    return { error: '未找到项目根目录（既没有绑定工作区，也没有可用的 meta.importedFrom）' }
  }

  async function isDir(target) {
    try {
      return (await stat(target)).isDirectory()
    } catch {
      return false
    }
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
        // A directory without a manifest is an aborted/crashed write; the
        // spec requires deleting it on startup.
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
      // Nothing else to do; the call exists to keep reconciliation in one place.
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
   * Snapshot the project tree before a run.
   *
   * Acquires the per-project run lock even when the snapshot itself fails:
   * one run at a time is a safety property independent of undoability.
   * Release with {@link releaseRun} when the gesture settles.
   *
   * The snapshot itself is project-level (files), but the manifest records
   * which **view** the run targeted, so the node-state restore touches exactly
   * that view's graph and leaves the other untouched. The LIFO order stays
   * global per project: file snapshots are shared, so a run of either view
   * locks out undoing anything older.
   *
   * @returns `{ runId, undoable, partial, fileCount, bytes, skipped, root, view }`,
   *   or `{ undoable:false, reason }` with **no** exception: a snapshot
   *   failure downgrades the run's undoability, it never blocks the run.
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
      // The half-copied tree is deleted (D2); the manifest stays so the run is
      // visible in history and locks earlier runs out of undo.
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
   * The manifest of the one run a caller may still undo, or a refusal reason.
   *
   * The LIFO candidate is the newest run that is not yet undone — undone runs
   * are consumed history. A candidate whose snapshot failed (`undoable:false`)
   * blocks skip-ahead: undoing an older run would silently overwrite whatever
   * the un-snapshotted newer run changed.
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
   * Preview what an undo would change, without touching anything. Only the
   * snapshot candidate scope is compared — never the whole root, or
   * `node_modules`/`dist` would masquerade as "added" files.
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
    if (!(await isDir(beforeDir))) return { ok: false, error: '快照目录缺失，无法撤销', code: 409 }
    const current = await walkTree(root, effective)
    const before = await walkTree(beforeDir, effective)
    const added = []
    const modified = []
    const deleted = []
    for (const rel of before.files.keys()) {
      const live = current.files.get(rel)
      if (live === undefined) deleted.push(rel)
      else if (live.size !== before.files.get(rel).size || Math.abs(live.mtimeMs - before.files.get(rel).mtimeMs) > 1) modified.push(rel)
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
   * Undo one run: LIFO-checked, backed up, then restored. On any failure the
   * manifest records `undo-failed` and the backup is kept for manual rescue.
   */
  async function restore(project, runId, { dryRunOnly = false } = {}) {
    const key = projectKeyOf(project)
    // Shape validation first: a forged id is a 400, not a LIFO refusal.
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
    if (!contained(root, runDir)) return { ok: false, error: '快照路径越界', code: 400 }
    const beforeDir = path.join(runDir, 'before')
    const manifest = await readManifest(runDir)
    if (manifest === undefined) return { ok: false, error: '找不到该次运行的快照记录', code: 404 }
    if (manifest.project !== key) return { ok: false, error: '项目与快照不匹配', code: 400 }
    if (!(await isDir(beforeDir))) return { ok: false, error: '快照目录缺失，无法撤销', code: 409 }

    if (dryRunOnly) return dryRun(project, runId)

    // 1. Back the current tree up. A failed backup aborts the undo — without
    //    it a partial restore would be unrecoverable.
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

    // 2. Compute the change set, then restore.
    const files = { added: [], modified: [], deleted: [] }
    try {
      const before = await walkTree(beforeDir, effective)
      const current = await walkTree(root, effective)
      for (const rel of before.files.keys()) {
        const live = current.files.get(rel)
        if (live === undefined) files.deleted.push(rel)
        else if (live.size !== before.files.get(rel).size || Math.abs(live.mtimeMs - before.files.get(rel).mtimeMs) > 1) files.modified.push(rel)
      }
      for (const rel of current.files.keys()) {
        if (!before.files.has(rel)) files.added.push(rel)
      }
      // Delete files the run added — only inside the candidate scope: the
      // walker already skipped .undo/.git/node_modules/… and metadata files.
      for (const rel of files.added) {
        const target = absOf(root, rel)
        if (!contained(root, target)) continue
        await rm(target, { force: true })
      }
      // Copy the pre-run tree back over the current one.
      for (const rel of before.files.keys()) {
        const target = absOf(root, rel)
        if (!contained(root, target)) throw new Error(`恢复路径越界：${rel}`)
        await mkdir(path.dirname(target), { recursive: true })
        await copyFile(absOf(beforeDir, rel), target)
      }
      // Prune directories that became empty; excluded dirs are never touched
      // because their contents never entered `files.added`.
      await pruneEmptyDirs(root, [...files.added].map((rel) => path.dirname(absOf(root, rel))))
    } catch (error) {
      const message = `恢复失败，当前状态已保留在 ${path.join('.undo', runId, backupName)}：${String(error?.message ?? error)}`
      await markManifest(runDir, manifest, { status: STATUS.UNDO_FAILED, reason: message, backupDir: backupName })
      return { ok: false, error: message, code: 500 }
    }

    // 3. Restore node execution state. Positions, params, links and titles
    //    are never touched; nodes added after the run are left alone.
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
    // backupDir is reported relative to the run directory (same shape as the
    // manifest), so UI copy stays short; the absolute path is derivable.
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
    // Only the run's view is written back; the other view's graph is untouched.
    const written = await store.write(restored, { persist: 'now', view: viewName })
    return written.rev
  }

  /** Remove directories that a deletion left empty (never the root). */
  async function pruneEmptyDirs(root, dirs) {
    const unique = [...new Set(dirs.filter((dir) => dir !== root && contained(root, dir)))]
    unique.sort((left, right) => right.length - left.length)
    for (const dir of unique) {
      try {
        const entries = await readdir(dir)
        if (entries.length === 0) await rm(dir, { recursive: true, force: true })
      } catch {
        // Vanished already, or not ours to remove.
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
