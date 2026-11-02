/**
 * 工作日志只读读取（v1.3.0，需求四）——`readLogTail` 纯读取，零写入。
 *
 * 契约（任务书 §7.2）：
 *
 *   - 从文件**尾部**反向读，最多 `maxBytes`（默认 8 MiB）；超过时
 *     `truncated: true`，不整读 5 MiB 以上的文件；
 *   - 逐行 `JSON.parse`；坏行/空行跳过并计入 `invalidLines`，绝不整体失败；
 *   - 行形状不合法（缺 ts/level/event）也跳过；
 *   - `includeRotated` 时读 `codeflow.log.1`（.1 行在前、当前文件在后，时间
 *     升序）；`.1` 不存在就忽略；
 *   - `level` / `query` 在读取端过滤；query 大小写不敏感，只匹配
 *     event/msg/data 的字符串值，**不匹配 err.stack**（不把堆栈当搜索目标）；
 *   - 文件不存在 / 空文件 / 读取失败 → 不抛，返回 `lines: []` 与原因标记；
 *   - 路径只能由插件注入（logger 解析出的固定路径），**绝不接受请求传入**。
 *
 * 依赖方向：L0——只依赖 `node:fs/promises` 与 `./schema.js` 的级别表。
 *
 * @module dsh-codeflow-canvas/logging/reader
 */
import { open, stat } from 'node:fs/promises'
import path from 'node:path'

import { LEVELS } from './schema.js'

const DEFAULTS = Object.freeze({
  maxLines: 2000,
  maxBytes: 8 * 1024 * 1024,
})

/** 从文件尾部读最多 maxBytes 字节，按行拆分（丢弃可能被截断的首行）。 */
async function tailLines(file, maxBytes) {
  let info
  try {
    info = await stat(file)
  } catch {
    return { lines: [], truncated: false, missing: true }
  }
  if (!info.isFile()) return { lines: [], truncated: false, missing: true }
  const size = info.size
  const start = Math.max(0, size - maxBytes)
  const handle = await open(file, 'r')
  try {
    const length = size - start
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    const text = buffer.toString('utf8')
    const allLines = text.split('\n')
    // 从中间开始的读取可能截断首行：start > 0 时丢弃第一段。
    const body = start > 0 ? allLines.slice(1) : allLines
    return { lines: body, truncated: start > 0, missing: false }
  } catch {
    return { lines: [], truncated: false, missing: true }
  } finally {
    await handle.close().catch(() => {})
  }
}

/** 单行 → 合法日志对象；坏行返回 undefined。 */
function parseLine(line) {
  const text = line.trim()
  if (text.length === 0) return undefined
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  if (typeof parsed.ts !== 'string' || parsed.ts.length === 0) return undefined
  if (typeof parsed.level !== 'string' || !LEVELS.has(parsed.level)) return undefined
  if (typeof parsed.event !== 'string' || parsed.event.length === 0) return undefined
  return parsed
}

/** query 是否命中（大小写不敏感；只看 event/msg/data 的字符串值）。 */
function matchesQuery(entry, query) {
  if (query.length === 0) return true
  const needle = query.toLowerCase()
  if (String(entry.event ?? '').toLowerCase().includes(needle)) return true
  if (String(entry.msg ?? '').toLowerCase().includes(needle)) return true
  const data = entry.data
  if (data !== undefined && data !== null && typeof data === 'object' && !Array.isArray(data)) {
    for (const value of Object.values(data)) {
      if (typeof value === 'string' && value.toLowerCase().includes(needle)) return true
      if (typeof value === 'number' && String(value).includes(needle)) return true
    }
  }
  return false
}

/**
 * 读取日志尾部。
 *
 * @param options.file - 日志文件绝对路径（**必须由插件注入**，不由请求传入）。
 * @param options.rotatedPath - 轮转文件绝对路径（`.1`；可缺省）。
 * @param options.maxLines - 返回的最大行数（默认 2000）。
 * @param options.maxBytes - 尾部读取的字节上限（默认 8 MiB）。
 * @param options.includeRotated - 是否包含 `.1`。
 * @param options.level - 可选级别过滤。
 * @param options.query - 可选大小写不敏感子串。
 * @returns `{ path, size, mtime, rotatedPath?, rotatedSize?, lines, scannedBytes,
 *   truncated, invalidLines, missing?, disabled? }`。
 */
export async function readLogTail(options = {}) {
  const file = typeof options.file === 'string' && options.file.length > 0 ? options.file : null
  const maxLines = Math.max(1, Number.isFinite(options.maxLines) ? Math.floor(options.maxLines) : DEFAULTS.maxLines)
  // maxBytes 显式给出时尊重原值（测试用小值验证截断路径）；缺省 8 MiB。
  const maxBytes = Number.isFinite(options.maxBytes) ? Math.max(1, Math.floor(options.maxBytes)) : DEFAULTS.maxBytes
  const level = typeof options.level === 'string' && LEVELS.has(options.level) ? options.level : undefined
  const query = typeof options.query === 'string' ? options.query : ''

  if (file === null) {
    return { path: null, size: 0, mtime: null, lines: [], scannedBytes: 0, truncated: false, invalidLines: 0, disabled: true }
  }

  const rotatedPath = options.includeRotated === true
    ? (typeof options.rotatedPath === 'string' && options.rotatedPath.length > 0
      ? options.rotatedPath
      : `${file}.1`)
    : undefined

  const tail = await tailLines(file, maxBytes)
  const entries = []
  let invalidLines = 0
  const consume = (line) => {
    const entry = parseLine(line)
    if (entry === undefined) {
      if (line.trim().length > 0) invalidLines += 1
      return
    }
    if (level !== undefined && entry.level !== level) return
    if (!matchesQuery(entry, query)) return
    entries.push(entry)
  }
  let rotatedSize
  if (rotatedPath !== undefined) {
    const rotated = await tailLines(rotatedPath, maxBytes)
    if (!rotated.missing) {
      try {
        rotatedSize = (await stat(rotatedPath)).size
      } catch { /* stat 失败不影响行 */ }
      for (const line of rotated.lines) consume(line)
    }
  }
  for (const line of tail.lines) consume(line)
  // 时间升序（.1 在前、当前文件在后已是升序；过滤后仍保持原序）。
  const lines = entries.slice(-maxLines)
  let size = 0
  let mtime = null
  try {
    const info = await stat(file)
    size = info.size
    mtime = new Date(info.mtimeMs).toISOString()
  } catch { /* 文件在读取间隙消失：返回已有内容 */ }

  const result = {
    path: file,
    size,
    mtime,
    lines,
    scannedBytes: tail.truncated ? maxBytes : size,
    truncated: tail.truncated,
    invalidLines,
  }
  if (tail.missing) result.missing = true
  if (rotatedPath !== undefined) {
    result.rotatedPath = rotatedPath
    if (rotatedSize !== undefined) result.rotatedSize = rotatedSize
  }
  return result
}

/** 由当前日志路径推导轮转路径（`codeflow.log` → `codeflow.log.1`）。 */
export function rotatedPathOf(file) {
  if (typeof file !== 'string' || file.length === 0) return undefined
  return `${file}.1`
}

/** 目录名（reveal 用；避免路由层拼路径）。 */
export function dirNameOf(file) {
  if (typeof file !== 'string' || file.length === 0) return undefined
  return path.dirname(file)
}
