/**
 * Drop-import staging & orchestration (v1.2) — the server half of "drag a
 * folder / archive onto the canvas". Zero npm dependencies, zero LLM.
 *
 * The browser cannot read dropped files' real paths inside the DSH iframe, so
 * the primary channel is an upload protocol (appendix C):
 *
 *   begin    → validate budgets, mint a token, create `.staging/<token>/`
 *   file     → one raw-body POST per file into the staging tree
 *   finalize → move / extract into `imports/<包名>/`, dehusk, then the route
 *              runs the existing dual import + coupling pipeline
 *   abort    → delete the staging tree (idempotent)
 *
 * A second channel (`/api/drop/path`) imports an in-place path when the host
 * does expose the dropped file's real path: folders import from where they
 * are, archives still extract into `imports/`.
 *
 * Security: tokens never touch a shell; every relative path goes through
 * `archive.safeEntryPath`; writes stay under `imports/` (prefix-checked after
 * `path.resolve`); conflicts answer `409 {code:'conflict'}` so the client can
 * offer 覆盖 / 改名 / 取消 instead of guessing.
 *
 * @module dsh-codeflow-canvas/drop-import
 */
import { cp, mkdir, readdir, rename, rm, stat as statFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

import { ARCHIVE_LIMITS, extractArchive, fail, safeEntryPath, stripSingleRoot } from './archive.js'
import { atomicWriteFile } from './core/fsio.js'
import { safeProjectName } from './core/path.js'

/** Limits of the upload channel (task book §5.6; archive caps live in archive.js). */
export const DROP_LIMITS = Object.freeze({
  maxFiles: 1000,
  maxTotalBytes: 500 * 1024 * 1024,
  maxFileBytes: 64 * 1024 * 1024,
  sessionTtlMs: 6 * 60 * 60 * 1000,
  sweepIntervalMs: 30 * 60 * 1000,
  sweepAgeMs: 6 * 60 * 60 * 1000,
})

/** Kinds the upload protocol accepts. */
const KINDS = new Set(['dir', 'archive'])

/**
 * Create a drop-import manager for one `imports/` root
 * (`<CodeFlow 根>/imports/`; staging lives at `<importsRoot>/.staging/`).
 */
export function createDropManager({ importsRoot, logger, now = () => Date.now() } = {}) {
  if (typeof importsRoot !== 'string' || importsRoot.length === 0) {
    throw new Error('drop-import: importsRoot is required')
  }
  const stagingRoot = path.join(importsRoot, '.staging')
  /** @type {Map<string, {kind,name,files,bytes,received,receivedBytes,createdAt,expiresAt}>} */
  const sessions = new Map()
  let sweeper = null

  const sessionDir = (token) => path.resolve(stagingRoot, token)

  /** True when `token` is a well-formed UUID-looking string and its session exists. */
  function liveSession(token) {
    if (typeof token !== 'string' || token.length === 0) return undefined
    const session = sessions.get(token)
    if (session === undefined) return undefined
    if (session.expiresAt <= now()) {
      sessions.delete(token)
      return undefined
    }
    return session
  }

  /** Best-effort sweep: staging trees older than 6h die, expired sessions too. */
  async function sweep() {
    let entries
    try {
      entries = await readdir(stagingRoot, { withFileTypes: true })
    } catch {
      return 0
    }
    let removed = 0
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = path.join(stagingRoot, entry.name)
      try {
        const info = await statFile(dir)
        if (now() - info.mtimeMs > DROP_LIMITS.sweepAgeMs) {
          await rm(dir, { recursive: true, force: true })
          sessions.delete(entry.name)
          removed += 1
        }
      } catch {
        // unreadable entry: leave it for the next sweep
      }
    }
    for (const [token, session] of sessions) {
      if (session.expiresAt <= now()) sessions.delete(token)
    }
    return removed
  }

  return {
    importsRoot,
    stagingRoot,

    /** Start the 30-minute sweeper (unref'd: never keeps the process alive). */
    start() {
      if (sweeper !== null) return
      sweeper = setInterval(() => {
        sweep().catch((error) => logger?.warn?.(`codeflow: staging sweep failed: ${String(error)}`))
      }, DROP_LIMITS.sweepIntervalMs)
      sweeper.unref?.()
    },

    dispose() {
      if (sweeper !== null) {
        clearInterval(sweeper)
        sweeper = null
      }
    },

    sweep,

    /** Session lookup for finalize/abort (never throws). */
    sessionOf(token) {
      return liveSession(token)
    },

    /**
     * `POST /api/drop/begin` — validate budgets, mint a token, mkdir staging.
     * Reuses an existing token when the client retries with the same one.
     */
    async begin({ kind, name, files, bytes } = {}) {
      if (!KINDS.has(kind)) throw fail('拖拽类型必须是文件夹或压缩包', 400)
      const fileCount = Number(files)
      if (!Number.isFinite(fileCount) || fileCount < 0 || !Number.isInteger(fileCount)) {
        throw fail('文件数不合法', 400)
      }
      if (fileCount > DROP_LIMITS.maxFiles) throw fail(`文件数超过 ${DROP_LIMITS.maxFiles}，已拒绝导入`, 413)
      const totalBytes = Number(bytes)
      if (!Number.isFinite(totalBytes) || totalBytes < 0) throw fail('总大小不合法', 400)
      if (totalBytes > DROP_LIMITS.maxTotalBytes) throw fail('解压后超过 500 MB，已拒绝导入', 413)
      const cleanName = String(name ?? '').replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, 200)
      await mkdir(stagingRoot, { recursive: true })
      const token = randomUUID()
      const createdAt = now()
      sessions.set(token, {
        token,
        kind,
        name: cleanName,
        files: fileCount,
        bytes: totalBytes,
        received: 0,
        receivedBytes: 0,
        createdAt,
        expiresAt: createdAt + DROP_LIMITS.sessionTtlMs,
      })
      await mkdir(sessionDir(token), { recursive: true })
      return { token, expiresAt: createdAt + DROP_LIMITS.sessionTtlMs }
    },

    /**
     * `POST /api/drop/file` — write one uploaded file into the staging tree.
     * The route drains the raw body before calling this, so an oversized body
     * arrives here as a decision, not a surprise.
     */
    async writeFile(token, rawRel, data) {
      const session = liveSession(token)
      if (session === undefined) throw fail('上传会话不存在或已过期，请重新拖入', 400)
      // kind 都收文件进暂存树：dir 是整棵目录，archive 是那个压缩包本体。
      if (!Buffer.isBuffer(data)) throw fail('请求体不是文件内容', 400)
      if (data.length > DROP_LIMITS.maxFileBytes) {
        // 限额违规（附录 C）：413 并清理该 token 的暂存。
        await this.abort(token)
        throw fail('单文件超过 64 MB，已拒绝导入', 413)
      }
      if (session.received >= DROP_LIMITS.maxFiles) {
        await this.abort(token)
        throw fail(`文件数超过 ${DROP_LIMITS.maxFiles}，已拒绝导入`, 413)
      }
      if (session.receivedBytes + data.length > DROP_LIMITS.maxTotalBytes) {
        await this.abort(token)
        throw fail('解压后超过 500 MB，已拒绝导入', 413)
      }
      const rel = safeEntryPath(decodeURIComponent(String(rawRel ?? '')))
      if (rel === undefined || rel.length === 0) throw fail(`文件路径不合法：${JSON.stringify(String(rawRel ?? '').slice(0, 80))}`, 400)
      const target = path.resolve(sessionDir(token), rel)
      if (!target.startsWith(sessionDir(token) + path.sep)) throw fail('文件路径越界，已拒绝', 400)
      await atomicWriteFile(target, data)
      session.received += 1
      session.receivedBytes += data.length
      return { received: session.received }
    },

    /**
     * `POST /api/drop/abort` — delete the staging tree; idempotent, never throws.
     */
    async abort(token) {
      if (typeof token !== 'string' || token.length === 0) return { ok: true }
      sessions.delete(token)
      await rm(sessionDir(token), { recursive: true, force: true }).catch(() => {})
      return { ok: true }
    },

    /** Remove one token's staging tree after a successful finalize. */
    async cleanup(token) {
      return this.abort(token)
    },

    /**
     * Resolve the target directory name under `imports/`: cleaned package /
     * folder name, honouring `rename` (next free `-2`/`-3` suffix) and
     * `overwrite` (existing directory is removed). `409 conflict` when the
     * name is taken and neither flag is set.
     *
     * @returns `{ pkgName, existed }`.
     */
    async resolvePkgName(rawName, { rename = false, overwrite = false } = {}) {
      const base = safeProjectName(rawName)
      const taken = async (name) => {
        try {
          await statFile(path.join(importsRoot, name))
          return true
        } catch {
          return false
        }
      }
      let candidate = base
      if (await taken(candidate)) {
        if (overwrite) {
          await rm(path.join(importsRoot, candidate), { recursive: true, force: true }).catch(() => {})
          return { pkgName: candidate, existed: true }
        }
        if (!rename) {
          const error = fail(`CodeFlow/imports/ 下已存在同名目录：${candidate}`, 409)
          error.code = 'conflict'
          error.target = 'dir'
          error.current = candidate
          throw error
        }
        for (let attempt = 2; ; attempt += 1) {
          candidate = `${base}-${attempt}`
          if (!(await taken(candidate))) break
        }
      }
      return { pkgName: candidate, existed: false }
    },

    /**
     * Move a completed dir-upload staging tree into `imports/<pkgName>/`.
     * Atomic `rename` first; across devices it degrades to copy + verify + rm.
     */
    async commitDirUpload(token, pkgName) {
      const source = sessionDir(token)
      const target = path.join(importsRoot, pkgName)
      await mkdir(importsRoot, { recursive: true })
      try {
        await rename(source, target)
      } catch (error) {
        if (error?.code !== 'EXDEV' && error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error
        await cp(source, target, { recursive: true, force: false, errorOnExist: true })
        await rm(source, { recursive: true, force: true }).catch(() => {})
      }
      sessions.delete(token)
      return target
    },

    /** Locate the single uploaded archive inside a staging tree. */
    async findStagedArchive(token) {
      const dir = sessionDir(token)
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return undefined
      }
      const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
      // The client uploads exactly one archive; accept the first archive-shaped
      // file so a stray descriptor file cannot hijack the import.
      for (const name of files) {
        if (/\.(zip|tar|tar\.gz|tgz|7z|rar)$/i.test(name)) return path.join(dir, name)
      }
      return files.length > 0 ? path.join(dir, files[0]) : undefined
    },

    /**
     * Extract the staged archive into `imports/<pkgName>/`, then delete the
     * staged copy and the (now empty) staging tree — no 500 MB duplicates.
     */
    async commitStagedArchive(token, pkgName, options = {}) {
      const archiveFile = await this.findStagedArchive(token)
      if (archiveFile === undefined) throw fail('暂存区中没有可解压的压缩包，请重新拖入', 400)
      const target = path.join(importsRoot, pkgName)
      await mkdir(importsRoot, { recursive: true })
      const result = await extractArchive(archiveFile, target, options)
      sessions.delete(token)
      await rm(sessionDir(token), { recursive: true, force: true }).catch(() => {})
      return { target, ...result }
    },

    /**
     * Extract an in-place archive (real-path channel) into `imports/<pkgName>/`.
     * The user's original file is never deleted — only staged copies are.
     */
    async commitPathArchive(archivePath, pkgName, options = {}) {
      const target = path.join(importsRoot, pkgName)
      await mkdir(importsRoot, { recursive: true })
      const result = await extractArchive(archivePath, target, options)
      return { target, ...result }
    },
  }
}

/**
 * Project-name conflict resolution on the routes side: `409 conflict` unless
 * `rename` (next free suffix) or `overwrite` (keep the name; the caller backs
 * up the old graph files first).
 *
 * @param exists - predicate answered for a candidate name.
 * @returns the final project name plus whether it already existed.
 */
export async function resolveProjectName(desired, { exists, rename = false, overwrite = false } = {}) {
  const base = safeProjectName(desired)
  let candidate = base
  if (await exists(candidate)) {
    if (overwrite) return { projectName: candidate, existed: true }
    if (!rename) {
      const error = fail(`已存在同名项目：${candidate}`, 409)
      error.code = 'conflict'
      error.target = 'project'
      error.current = candidate
      throw error
    }
    for (let attempt = 2; ; attempt += 1) {
      candidate = `${base}-${attempt}`
      if (!(await exists(candidate))) break
    }
    return { projectName: candidate, existed: false }
  }
  return { projectName: candidate, existed: false }
}

/** Test/export surface kept minimal on purpose. */
export const __internals = { stripSingleRoot, safeEntryPath, ARCHIVE_LIMITS }
