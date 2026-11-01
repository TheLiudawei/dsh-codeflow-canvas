/**
 * Archive extraction for drop-import (v1.2) — zip / tar / tar.gz parsed with
 * nothing but Node built-ins, 7z / rar delegated to external tools when the
 * machine has one. Zero npm dependencies, zero LLM, deterministic.
 *
 * Security posture (v1.2 task book §5.6 / appendix B):
 *
 *   - every entry path is normalized in POSIX space and rejected when it is
 *     absolute, drive-lettered, contains a `..` segment, a NUL, or exceeds the
 *     path-length / depth bounds (zip-slip);
 *   - symlink entries are refused with a warning, never materialized;
 *   - parent directories are `lstat`-checked before each write so a symlink
 *     planted inside the destination cannot redirect it;
 *   - resource caps (file count, per-file and total bytes) are enforced during
 *     extraction, so a zip bomb fails loudly instead of filling the disk;
 *   - external tools never see shell interpolation (`execFile` only), and
 *     their output is re-walked and re-verified afterwards — an external
 *     unpacker will not defend us.
 *
 * @module dsh-codeflow-canvas/archive
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, rm, stat as statFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { promisify } from 'node:util'
import { createGunzip, inflateRawSync } from 'node:zlib'
import { isUtf8 } from 'node:buffer'

const execFileAsync = promisify(execFile)

/** Resource caps shared by every extraction path (task book §5.6). */
export const ARCHIVE_LIMITS = Object.freeze({
  maxFiles: 1000,
  maxTotalBytes: 500 * 1024 * 1024,
  maxFileBytes: 64 * 1024 * 1024,
  maxArchiveBytes: 500 * 1024 * 1024,
  maxPathLength: 400,
  maxDepth: 32,
})

/** Supported archive kinds and the extensions that claim them. */
const EXT_KINDS = [
  ['.zip', 'zip'],
  ['.tar.gz', 'targz'],
  ['.tgz', 'targz'],
  ['.tar', 'tar'],
  ['.7z', 'sevenzip'],
  ['.rar', 'rar'],
]

/** Strip the archive extension from a file name (`proj.tar.gz` → `proj`). */
export function stripArchiveExtension(name) {
  const text = String(name ?? '').trim()
  for (const [ext] of EXT_KINDS) {
    if (text.toLowerCase().endsWith(ext)) return text.slice(0, -ext.length)
  }
  return text
}

/** Guess the archive kind from a file name extension. */
export function kindFromName(name) {
  const text = String(name ?? '').toLowerCase()
  for (const [ext, kind] of EXT_KINDS) {
    if (text.endsWith(ext)) return kind
  }
  return undefined
}

/** Human label for a kind (`确认框` copy). */
export function kindLabel(kind) {
  return { zip: 'zip', tar: 'tar', targz: 'tar.gz', sevenzip: '7z', rar: 'rar' }[kind] ?? String(kind ?? '')
}

/**
 * Sniff the archive kind from magic bytes (falls back to the extension).
 * @returns the kind, or `undefined` when neither bytes nor extension are known.
 */
export async function detectKind(archivePath) {
  const handle = await open(archivePath, 'r')
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(8), 0, 8, 0)
    const head = buffer.subarray(0, bytesRead)
    if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b) return 'zip'
    if (head.length >= 6 && head[0] === 0x37 && head[1] === 0x7a && head[2] === 0xbc
      && head[3] === 0xaf && head[4] === 0x27 && head[5] === 0x1c) return 'sevenzip'
    if (head.length >= 7 && head[0] === 0x52 && head[1] === 0x61 && head[2] === 0x72
      && head[3] === 0x21 && head[4] === 0x1a && head[5] === 0x07) return 'rar'
    if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return 'targz'
  } finally {
    await handle.close()
  }
  // tar has no magic at offset 0 — trust the extension, then the ustar field.
  const byExt = kindFromName(path.basename(archivePath))
  if (byExt !== undefined) return byExt
  try {
    const header = Buffer.alloc(512)
    const handle2 = await open(archivePath, 'r')
    try {
      await handle2.read(header, 0, 512, 0)
    } finally {
      await handle2.close()
    }
    if (header.subarray(257, 262).toString('ascii') === 'ustar') return 'tar'
  } catch {
    // unreadable: the caller surfaces a friendly error
  }
  return undefined
}

/* ------------------------------------------------------------ 路径安全 --- */

/** `Error` with an HTTP status the route layer answers verbatim. */
export function fail(message, statusCode = 400) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

/**
 * Clean one archive entry path (or one uploaded relative path) into a safe,
 * `/`-separated relative path. Returns `undefined` for anything that could
 * escape the destination: absolute, drive-lettered, `..` segments, NUL, or
 * beyond the length/depth caps.
 */
export function safeEntryPath(rawRel) {
  const text = String(rawRel ?? '')
  if (text.length === 0 || text.includes('\0')) return undefined
  let rel = text.replace(/\\/g, '/')
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel) || rel.startsWith('//')) return undefined
  rel = path.posix.normalize(rel)
  if (rel === '.' || rel === '' || rel.startsWith('../')) return undefined
  if (rel.split('/').some((segment) => segment === '..')) return undefined
  if (rel.length > ARCHIVE_LIMITS.maxPathLength) return undefined
  if (rel.split('/').length > ARCHIVE_LIMITS.maxDepth) return undefined
  return rel.replace(/\/+$/, '')
}

/**
 * Reject (by throwing) when any parent directory between `dest` and `target`
 * is a symlink: `lstat` (not `stat`) is what actually sees the link.
 */
async function assertNoSymlinkParents(dest, target) {
  const rel = path.relative(dest, target)
  if (rel.length === 0 || rel.startsWith('..')) return
  const segments = rel.split(path.sep)
  let current = dest
  for (let i = 0; i < segments.length - 1; i += 1) {
    current = path.join(current, segments[i])
    let info
    try {
      info = await lstat(current)
    } catch {
      continue // missing parent: created below
    }
    if (info.isSymbolicLink()) throw fail('目标目录中出现符号链接，已中止写入', 400)
  }
}

/* ------------------------------------------------------------- 工具函数 --- */

/** GBK decoder (created lazily; Electron's Node provides it). */
let gbkDecoder = null

/** Decode one ZIP entry name per the v1.2 rules (UTF-8 flag → strict UTF-8 → GBK). */
export function decodeEntryName(buffer, utf8Flag) {
  if (utf8Flag) return buffer.toString('utf8')
  if (isUtf8(buffer)) return buffer.toString('utf8')
  try {
    gbkDecoder ??= new TextDecoder('gbk')
    return gbkDecoder.decode(buffer)
  } catch {
    // No GBK support after all: replace invalid bytes and flag it.
    return buffer.toString('utf8')
  }
}

/** Mutable extraction state shared by the zip/tar implementations. */
function createContext(dest, warnings) {
  return {
    dest,
    warnings,
    count: 0,
    totalBytes: 0,
    async ensureDir(relDir) {
      if (relDir.length === 0) return dest
      const target = path.resolve(dest, relDir)
      if (!target.startsWith(dest + path.sep)) throw fail('解压路径越界，已拒绝', 400)
      await assertNoSymlinkParents(dest, target)
      await mkdir(target, { recursive: true })
      return target
    },
    async writeEntry(rel, data) {
      const target = path.resolve(dest, rel)
      if (!target.startsWith(dest + path.sep)) throw fail('解压路径越界，已拒绝', 400)
      this.count += 1
      this.totalBytes += data.length
      if (this.count > ARCHIVE_LIMITS.maxFiles) throw fail(`文件数超过 ${ARCHIVE_LIMITS.maxFiles}，已拒绝导入`, 413)
      if (data.length > ARCHIVE_LIMITS.maxFileBytes) throw fail('单文件超过 64 MB，已拒绝导入', 413)
      if (this.totalBytes > ARCHIVE_LIMITS.maxTotalBytes) throw fail('解压后超过 500 MB，已拒绝导入', 413)
      await assertNoSymlinkParents(dest, target)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, data)
      return target
    },
  }
}

/* ----------------------------------------------------------------- ZIP --- */

/** Parse a pax extended-header record block (`len key=value\n`…). */
function parsePaxRecords(buffer) {
  const records = new Map()
  let offset = 0
  while (offset + 1 < buffer.length) {
    let digitsEnd = offset
    while (digitsEnd < buffer.length && buffer[digitsEnd] !== 0x20) digitsEnd += 1
    const length = Number.parseInt(buffer.subarray(offset, digitsEnd).toString('ascii'), 10)
    if (!Number.isFinite(length) || length <= 0 || offset + length > buffer.length) break
    const record = buffer.subarray(digitsEnd + 1, offset + length).toString('utf8')
    const eq = record.indexOf('=')
    if (eq > 0) records.set(record.slice(0, eq), record.slice(eq + 1).replace(/\n$/, ''))
    offset += length
  }
  return records
}

/**
 * Extract one ZIP archive from an in-memory buffer. Pure Node: EOCD → central
 * directory → local headers → store/deflate. Encrypted entries, unsupported
 * methods, zip64 and unsafe paths reject the whole extraction.
 */
export async function extractZipBuffer(buffer, dest, { warnings = [] } = {}) {
  // ---- EOCD ---------------------------------------------------------------
  const total = buffer.length
  let eocd = -1
  const scanFrom = Math.max(0, total - 22 - 65535)
  for (let i = total - 22; i >= scanFrom; i -= 1) {
    if (buffer.readUInt32LE(i) !== 0x06054b50) continue
    const commentLen = buffer.readUInt16LE(i + 20)
    if (i + 22 + commentLen === total) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw fail('压缩包已损坏（找不到 ZIP 结尾记录）', 400)
  const entriesTotal = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  const cdSize = buffer.readUInt32LE(eocd + 12)
  if (offset === 0xffffffff || cdSize === 0xffffffff || entriesTotal === 0xffff) {
    throw fail('暂不支持 zip64 压缩包，请先手动解压后拖入文件夹', 400)
  }
  void cdSize
  const ctx = createContext(dest, warnings)
  for (let index = 0; index < entriesTotal; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw fail('压缩包已损坏（中央目录不完整）', 400)
    }
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameLen = buffer.readUInt16LE(offset + 28)
    const extraLen = buffer.readUInt16LE(offset + 30)
    const commentLen = buffer.readUInt16LE(offset + 32)
    const externalAttrs = buffer.readUInt32LE(offset + 38)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const nameBuf = buffer.subarray(offset + 46, offset + 46 + nameLen)
    offset = offset + 46 + nameLen + extraLen + commentLen
    if ((flags & 0x1) !== 0) throw fail('压缩包已加密，请先解密或手动解压后再拖入', 400)
    if (method !== 0 && method !== 8) throw fail(`压缩包使用了不支持的压缩算法（method ${method}）`, 400)
    const mode = externalAttrs >>> 16
    if ((mode & 0xf000) === 0xa000) {
      warnings.push('已跳过符号链接条目（不允许解压符号链接）')
      continue
    }
    if (uncompressedSize > ARCHIVE_LIMITS.maxFileBytes) throw fail('单文件超过 64 MB，已拒绝导入', 413)
    const rawName = decodeEntryName(nameBuf, (flags & 0x800) !== 0)
    // 目录判定：名字以 / 结尾、unix mode 目录位、或 DOS 目录属性（size=0 才认）。
    const isDir = rawName.endsWith('/')
      || (mode & 0xf000) === 0x4000
      || ((externalAttrs & 0x10) !== 0 && uncompressedSize === 0)
    const rel = safeEntryPath(rawName)
    if (rel === undefined) throw fail(`压缩包内含不安全的路径（${JSON.stringify(rawName.slice(0, 80))}），已拒绝整个压缩包`, 400)
    if (isDir) {
      await ctx.ensureDir(rel)
      continue
    }
    // ---- local header: locate the data ------------------------------------
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw fail('压缩包已损坏（本地文件头不完整）', 400)
    }
    const localNameLen = buffer.readUInt16LE(localOffset + 26)
    const localExtraLen = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    if (dataStart + compressedSize > buffer.length) throw fail('压缩包已损坏（条目数据越界）', 400)
    const payload = buffer.subarray(dataStart, dataStart + compressedSize)
    let data
    if (method === 0) {
      data = payload
      if (data.length !== uncompressedSize) throw fail('压缩包已损坏（条目大小不一致）', 400)
    } else {
      try {
        data = inflateRawSync(payload)
      } catch {
        throw fail('压缩包已损坏（解压失败）', 400)
      }
      if (data.length !== uncompressedSize) throw fail('压缩包已损坏（解压后大小不一致）', 400)
    }
    await ctx.writeEntry(rel, data)
  }
  return { files: ctx.count, bytes: ctx.totalBytes, warnings }
}

/* ----------------------------------------------------------------- TAR --- */

/** Read a NUL-terminated ASCII/UTF-8 field from a tar header. */
function tarString(buffer, offset, length) {
  const end = buffer.subarray(offset, offset + length).indexOf(0)
  return buffer.subarray(offset, end < 0 ? offset + length : offset + end).toString('utf8')
}

/** Compute the tar header checksum the POSIX way (checksum bytes as spaces). */
function tarChecksum(header) {
  let computed = 0
  for (let i = 0; i < 512; i += 1) computed += (i >= 148 && i < 156) ? 0x20 : header[i]
  return computed
}

/**
 * Extract one TAR archive from an in-memory buffer (ustar / pax / GNU
 * longname). Only regular files and directories are materialized; symlink,
 * hardlink and device entries are skipped with a warning.
 */
export async function extractTarBuffer(buffer, dest, { warnings = [] } = {}) {
  const ctx = createContext(dest, warnings)
  let offset = 0
  let pendingName = null
  let pendingSize = null
  let first = true
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break // end marker
    let name = tarString(header, 0, 100)
    let size = Number.parseInt(tarString(header, 124, 12).trim() || '0', 8)
    const typeflag = String.fromCharCode(header[156] || 0x30)
    const magic = header.subarray(257, 262).toString('ascii')
    const prefix = magic === 'ustar' ? tarString(header, 345, 155) : ''
    const storedSum = Number.parseInt(tarString(header, 148, 8).replace(/[^0-7]/g, '') || '-1', 8)
    const checksumOk = storedSum === tarChecksum(header)
    if (first && magic !== 'ustar' && !checksumOk) {
      throw fail('不是有效的 tar / tar.gz 压缩包', 400)
    }
    first = false
    if (!checksumOk) warnings.push('TAR 校验和与预期不符（已忽略）')
    const dataStart = offset + 512
    const dataBlocks = Math.ceil((Number.isFinite(size) ? size : 0) / 512) * 512
    const data = buffer.subarray(dataStart, dataStart + (Number.isFinite(size) ? size : 0))
    offset = dataStart + dataBlocks
    if (typeflag === 'x' || typeflag === 'g') {
      // pax 扩展头：path/size 记录作用于下一个条目。
      const records = parsePaxRecords(data)
      if (records.has('path')) pendingName = records.get('path')
      if (records.has('size')) pendingSize = Number.parseInt(records.get('size'), 10)
      continue
    }
    if (typeflag === 'L') {
      pendingName = data.toString('utf8').replace(/\0[\s\S]*$/, '')
      continue
    }
    if (pendingName !== null) name = pendingName
    if (pendingSize !== null && Number.isFinite(pendingSize)) size = pendingSize
    pendingName = null
    pendingSize = null
    if (prefix.length > 0) name = `${prefix}/${name}`
    const rel = safeEntryPath(name)
    if (rel === undefined) throw fail(`压缩包内含不安全的路径（${JSON.stringify(String(name).slice(0, 80))}），已拒绝整个压缩包`, 400)
    if (typeflag === '5' || rel === '' || name.endsWith('/')) {
      await ctx.ensureDir(rel)
      continue
    }
    if (typeflag === '2' || typeflag === '1') {
      warnings.push(typeflag === '2' ? '已跳过符号链接条目（不允许解压符号链接）' : '已跳过硬链接条目')
      continue
    }
    if (typeflag !== '0' && typeflag !== '\0' && typeflag !== '7') {
      warnings.push(`已跳过不支持类型的条目（typeflag ${JSON.stringify(typeflag)}）`)
      continue
    }
    if (!Number.isFinite(size) || size < 0) throw fail('压缩包已损坏（条目大小非法）', 400)
    if (dataStart + size > buffer.length) throw fail('压缩包已损坏（条目数据越界）', 400)
    await ctx.writeEntry(rel, buffer.subarray(dataStart, dataStart + size))
  }
  return { files: ctx.count, bytes: ctx.totalBytes, warnings }
}

/** Stream-decompress a .tar.gz to a temp file, refusing to exceed `maxBytes`. */
async function gunzipCapped(archivePath, maxBytes) {
  const tmp = path.join(tmpdir(), `codeflow-gunzip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tar`)
  let written = 0
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      written += chunk.length
      if (written > maxBytes) {
        callback(fail('解压后超过 500 MB，已拒绝导入', 413))
        return
      }
      callback(null, chunk)
    },
  })
  try {
    await pipeline(createReadStream(archivePath), createGunzip(), counter, createWriteStream(tmp))
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
  return tmp
}

/* ------------------------------------------------------- 外部工具 7z/rar --- */

/**
 * Candidate external unpackers, in priority order: Windows' bsdtar first
 * (`System32\tar.exe` reads 7z/rar; a PATH `tar` may be GNU tar, which cannot,
 * so only the absolute System32 path qualifies), then 7-Zip, then WinRAR/UnRAR
 * (known install dirs, then every PATH entry). Exported for tests, which
 * override it to simulate "no tool installed".
 */
export function externalToolCandidates() {
  const candidates = []
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const systemTar = path.join(systemRoot, 'System32', 'tar.exe')
  if (existsSync(systemTar)) candidates.push({ kind: 'tar', bin: systemTar })
  const bases = [process.env['ProgramFiles'] ?? 'C:\\Program Files', process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)']
  const names = ['7z.exe', '7za.exe', 'UnRAR.exe', 'WinRAR.exe']
  for (const base of bases) {
    for (const sub of ['7-Zip', 'WinRAR']) {
      for (const name of names) {
        const bin = path.join(base, sub, name)
        if (existsSync(bin)) candidates.push({ kind: kindOfTool(name), bin })
      }
    }
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (typeof dir !== 'string' || dir.length === 0) continue
    for (const name of names) {
      const bin = path.join(dir, name)
      if (existsSync(bin)) candidates.push({ kind: kindOfTool(name), bin })
    }
  }
  return candidates
}

function kindOfTool(name) {
  const lower = name.toLowerCase()
  if (lower.startsWith('7z')) return 'sevenzip'
  if (lower.startsWith('unrar')) return 'unrar'
  return 'winrar'
}

/** argv shapes per tool (task book appendix B.3). */
function toolArgs(kind, archive, dest) {
  if (kind === 'tar') return [['-xf', archive, '-C', dest]]
  if (kind === 'sevenzip') return [['x', '-y', `-o${dest}`, archive]]
  // WinRAR / UnRAR want a trailing separator on the destination.
  return [['x', '-y', archive, dest.endsWith(path.sep) ? dest : dest + path.sep]]
}

/**
 * Extract a 7z / rar archive with an external tool. Never touches the shell:
 * `execFile` with an argv array, 120 s timeout, hidden window. A non-zero exit
 * surfaces the stderr tail (≤200 chars) so the user sees the real reason.
 */
export async function extractWithExternalTool(archivePath, dest, { candidates = externalToolCandidates(), warnings = [] } = {}) {
  if (candidates.length === 0) {
    throw fail('这台机器没有可用的 7z/rar 解压器，请先手动解压后拖入文件夹', 400)
  }
  const errors = []
  for (const candidate of candidates) {
    for (const argv of toolArgs(candidate.kind, archivePath, dest)) {
      try {
        await execFileAsync(candidate.bin, argv, { timeout: 120000, windowsHide: true, maxBuffer: 1 << 20 })
        return { used: candidate.bin, warnings }
      } catch (error) {
        const stderr = String(error?.stderr ?? '').trim()
        errors.push(`${path.basename(candidate.bin)}: ${stderr.length > 0 ? stderr.slice(-200) : String(error?.message ?? error)}`)
      }
    }
  }
  throw fail(`解压失败（${errors[0] ?? '未知原因'}）。也可先手动解压后拖入文件夹`, 400)
}

/* ------------------------------------------------------------ 统一入口 --- */

/** Recursively verify file count / sizes under `dir` (external-tool output). */
async function verifyExtracted(dir, { warnings = [] } = {}) {
  let files = 0
  let bytes = 0
  const visit = async (current, depth) => {
    if (depth > ARCHIVE_LIMITS.maxDepth) throw fail('目录层级超过 32 层，已拒绝导入', 400)
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name)
      if (entry.isSymbolicLink()) {
        warnings.push('已跳过符号链接（外部解压工具产出）')
        continue
      }
      if (entry.isDirectory()) {
        await visit(target, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      files += 1
      if (files > ARCHIVE_LIMITS.maxFiles) throw fail(`文件数超过 ${ARCHIVE_LIMITS.maxFiles}，已拒绝导入`, 413)
      const info = await statFile(target).catch(() => undefined)
      if (info === undefined) continue
      bytes += info.size
      if (info.size > ARCHIVE_LIMITS.maxFileBytes) throw fail('单文件超过 64 MB，已拒绝导入', 413)
      if (bytes > ARCHIVE_LIMITS.maxTotalBytes) throw fail('解压后超过 500 MB，已拒绝导入', 413)
      const rel = path.relative(dir, target)
      if (rel.length > ARCHIVE_LIMITS.maxPathLength) throw fail('文件路径过长，已拒绝导入', 400)
    }
  }
  await visit(dir, 1)
  return { files, bytes, warnings }
}

/**
 * Extract `archivePath` into `destDir` (created). Dispatches by sniffed kind:
 * zip/tar/tar.gz run the pure-Node parsers, 7z/rar try the external tools.
 *
 * @returns `{ kind, files, bytes, warnings }`.
 */
export async function extractArchive(archivePath, destDir, options = {}) {
  const warnings = []
  const info = await statFile(archivePath).catch(() => {
    throw fail('压缩包不存在或不可读', 400)
  })
  if (!info.isFile()) throw fail('压缩包路径不是文件', 400)
  if (info.size > ARCHIVE_LIMITS.maxArchiveBytes) throw fail('压缩包超过 500 MB，已拒绝导入', 413)
  const kind = await detectKind(archivePath)
  if (kind === undefined) throw fail('不支持的压缩包格式（支持 zip / tar / tar.gz / 7z / rar）', 400)
  await mkdir(destDir, { recursive: true })
  if (kind === 'zip') {
    const buffer = await readFile(archivePath)
    return { kind, ...(await extractZipBuffer(buffer, destDir, { warnings })) }
  }
  if (kind === 'tar') {
    const buffer = await readFile(archivePath)
    return { kind, ...(await extractTarBuffer(buffer, destDir, { warnings })) }
  }
  if (kind === 'targz') {
    const tmp = await gunzipCapped(archivePath, ARCHIVE_LIMITS.maxTotalBytes)
    try {
      const buffer = await readFile(tmp)
      return { kind, ...(await extractTarBuffer(buffer, destDir, { warnings })) }
    } finally {
      await rm(tmp, { force: true }).catch(() => {})
    }
  }
  // 7z / rar: external tools, then re-verify what landed on disk.
  const externalOptions = { warnings }
  if (options.candidates !== undefined) externalOptions.candidates = options.candidates
  const external = await extractWithExternalTool(archivePath, destDir, externalOptions)
  const verified = await verifyExtracted(destDir, { warnings: external.warnings })
  return { kind, ...verified }
}

/**
 * 去壳（appendix B.4）：解压/上传完成后，若根下只有一个目录且其中确有文件，
 * 把该目录当作项目根。`extractedTo` 始终是解压目录本身。
 *
 * @returns `{ sourceRoot, extractedTo, innerName }`.
 */
export async function stripSingleRoot(dest) {
  let entries
  try {
    entries = await readdir(dest, { withFileTypes: true })
  } catch {
    return { sourceRoot: dest, extractedTo: dest, innerName: null }
  }
  if (entries.length === 1 && entries[0].isDirectory()) {
    const inner = path.join(dest, entries[0].name)
    if (await hasAnyFile(inner)) return { sourceRoot: inner, extractedTo: dest, innerName: entries[0].name }
  }
  return { sourceRoot: dest, extractedTo: dest, innerName: null }
}

/** Bounded recursive "does this directory contain any regular file". */
export async function hasAnyFile(dir, { cap = ARCHIVE_LIMITS.maxFiles } = {}) {
  let seen = 0
  const visit = async (current) => {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return false
    }
    for (const entry of entries) {
      seen += 1
      if (seen > cap) return false
      const target = path.join(current, entry.name)
      if (entry.isFile()) return true
      if (entry.isDirectory() && (await visit(target))) return true
    }
    return false
  }
  return visit(dir)
}
