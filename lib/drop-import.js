/**
 * 拖拽导入的暂存与编排（v1.2）——"把文件夹/压缩包拖到画布上"的服务器半边。
 * 零 npm 依赖、零 LLM。
 *
 * 浏览器在 DSH 的 iframe 里拿不到拖入文件的真实路径，所以主通道是上传协议
 * （附录 C）：
 *
 *   begin    → 校验限额，发 token，建 `.staging/<token>/`
 *   file     → 每个文件一次 raw-body POST，写进暂存树
 *   finalize → 移动/解压到 `imports/<包名>/`，去壳，然后路由侧跑既有的
 *              双图导入 + 耦合流水线
 *   abort    → 删除暂存树（幂等）
 *
 * 第二条通道（`/api/drop/path`）：宿主真的暴露了拖入文件路径时就地导入
 * ——文件夹原地导入，压缩包仍解压进 `imports/`。
 *
 * 安全：token 绝不接触 shell；每个相对路径都过 `archive.safeEntryPath`；
 * 写入限制在 `imports/` 之内（`path.resolve` 后再做前缀校验）；冲突回答
 * `409 {code:'conflict'}`，客户端得以提供 覆盖 / 改名 / 取消 而不是靠猜。
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
        // 读不了的条目：留给下一次清扫
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
     * `POST /api/drop/begin` —— 校验限额、发 token、建暂存目录。
     * 客户端带同一个 token 重试时复用既有 token。
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
     * `POST /api/drop/file` —— 把一个上传文件写进暂存树。
     * 路由层先排空 raw body 再调用这里，超限的体到这里已经是"决定"，
     * 不是"意外"。
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
     * `POST /api/drop/abort` —— 删除暂存树；幂等、绝不抛错。
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
     * 解析 `imports/` 下的目标目录名：清洗后的包名/文件夹名，尊重 `rename`
     * （下一个空闲的 `-2`/`-3` 后缀）与 `overwrite`（移除既有目录）。名字
     * 被占且两个标志都没给时 `409 conflict`。
     *
     * @returns `{ pkgName, existed }`。
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
     * 把完成上传的文件夹暂存树挪进 `imports/<pkgName>/`。
     * 先原子 `rename`；跨盘时降级为复制 + 校验 + 删除。
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
      // 客户端恰好上传一个压缩包；接受第一个压缩包形状的文件，零散的
      // 描述文件劫持不了导入。
      for (const name of files) {
        if (/\.(zip|tar|tar\.gz|tgz|7z|rar)$/i.test(name)) return path.join(dir, name)
      }
      return files.length > 0 ? path.join(dir, files[0]) : undefined
    },

    /**
     * 把暂存的压缩包解进 `imports/<pkgName>/`，然后删掉暂存副本与（已空的）
     * 暂存树——不留 500 MB 的重复份。
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
     * 把就地压缩包（真实路径通道）解进 `imports/<pkgName>/`。
     * 用户的原始文件绝不删除——只有暂存副本会。
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
 * 路由侧的项目名冲突处置：`409 conflict`，除非 `rename`（下一个空闲后缀）
 * 或 `overwrite`（保留名字；调用方会先备份旧图文件）。
 *
 * @param exists - 对候选名回答是否已存在的谓词。
 * @returns 最终项目名，以及它是否原本已存在。
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
