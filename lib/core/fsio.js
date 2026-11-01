/**
 * 基础文件 IO：全插件共用的原子写入、宽容 JSON 读取与有界按行读取。
 *
 * 这里收敛的是三处历史重复实现：
 *
 *   - 原子写（原 store.js / sessions.js / undo.js 各有一份）：
 *     临时文件 → fsync → rename 覆盖目标。崩溃时留下的要么是旧内容要么是
 *     新内容，绝不会是半个文件——v0.5.2 之前"半截 workflow.json 导致下次
 *     启动画布损坏"就是这个环节缺了原子性。
 *   - 宽容 JSON 读取：读失败 / JSON 损坏 / 形状不对时返回调用方指定的
 *     回退值，绝不抛错（配置、侧车、清单等 7 处同型逻辑）。
 *   - 有界按行读取：只读文件头部若干字节就按行拆开（符号提取、注释提取、
 *     入口信号三类扫描共用；原 analyst.js / coupling.js / features.js 各有一份）。
 *
 * 依赖方向：本模块是第 0 层基础件，只 import `node:*`，不 import 任何 lib 代码。
 *
 * @module dsh-codeflow-canvas/core/fsio
 */
import { open, mkdir, readFile, rename, rm, stat as statFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

/* ------------------------------------------------------------ 原子写入 --- */

/**
 * 原子写文件：临时文件 → fsync → rename 覆盖目标文件。
 *
 * fsync 让 rename 真正意味着"已落盘"；不支持 fsync 的文件系统（FAT、部分
 * 网络盘）仍然保住 rename 的原子顺序。某些文件系统拒绝跨句柄 rename
 * （部分 Windows 锁），此时降级为原地直写——仍然远好于让保存直接失败。
 *
 * @param file - 目标文件绝对路径（父目录不存在会自动创建）。
 * @param data - 写入的文本内容。
 */
export async function atomicWriteFile(file, data) {
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now().toString(36)}${randomBytes(3).toString('hex')}.tmp`
  const handle = await open(temp, 'w')
  try {
    await handle.writeFile(data, 'utf8')
    // fsync 是 rename "持久化"语义的来源；个别文件系统不支持也不影响写入本身。
    try {
      await handle.sync()
    } catch {
      // 并非所有文件系统都支持 fsync；写入本身已经成功。
    }
  } finally {
    await handle.close()
  }
  try {
    await rename(temp, file)
  } catch {
    try {
      await writeFile(file, data, 'utf8')
    } finally {
      await rm(temp, { force: true }).catch(() => {})
    }
  }
}

/**
 * 原子写 JSON（undo 记录、迁移报告等结构化小文件用）。
 * 内容序列化为缩进两格的 JSON，其余语义与 {@link atomicWriteFile} 一致。
 *
 * @param file - 目标文件绝对路径。
 * @param value - 可 JSON 序列化的值。
 */
export async function writeJsonAtomic(file, value) {
  await atomicWriteFile(file, JSON.stringify(value, null, 2))
}

/* ------------------------------------------------------------ 存在判断 --- */

/**
 * 目标路径是否是一个真实存在的目录（不存在 / 是文件 / 无权限都算否）。
 *
 * @param target - 待检查路径。
 */
export async function isDirectory(target) {
  try {
    return (await statFile(target)).isDirectory()
  } catch {
    return false
  }
}

/**
 * 目标路径是否存在（文件或目录都算；仅用于"有没有"判断，不做类型区分）。
 *
 * @param target - 待检查路径。
 */
export async function entryExists(target) {
  try {
    await statFile(target)
    return true
  } catch {
    return false
  }
}

/* ---------------------------------------------------------- 宽容 JSON --- */

/**
 * 宽容地读取一个 JSON 文件：文件缺失、读取失败、JSON 损坏一律返回回退值，
 * 绝不抛错。形状校验交给调用方（它们各自知道自己的记录长什么样）。
 *
 * @param file - 待读取文件。
 * @param fallback - 读取失败时的返回值（常用 `undefined` 或空配置对象）。
 * @returns 解析出的值，或 `fallback`。
 */
export async function readJsonFile(file, fallback = undefined) {
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return fallback
  }
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

/**
 * 同 {@link readJsonFile}，但多一层形状守卫：解析结果不是普通对象
 * （null / 数组 / 基本类型）时也返回回退值。侧车与清单类记录都是对象形状，
 * 这是 7 处历史同型判断的公共部分。
 *
 * @param file - 待读取文件。
 * @param fallback - 读取失败或形状不对时的返回值。
 */
export async function readJsonObject(file, fallback = undefined) {
  const value = await readJsonFile(file, fallback)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fallback
  return value
}

/* -------------------------------------------------------- 有界按行读取 --- */

/** 有界读取的默认字节上限：256 KB（对源码符号/注释扫描绰绰有余）。 */
export const READ_BYTES_DEFAULT = 256 * 1024

/**
 * 读取一个文件的前若干字节并按行拆开（`\r\n` / `\r` / `\n` 都认）。
 *
 * 三类调用方共用：
 *   - 符号/导入提取（analyst、coupling）：`maxLines: 4000`；
 *   - 入口信号扫描（features）：不限行数；
 *   - 头部注释采样（importer）：更小的字节上限 + 行数上限。
 *
 * 读取失败（文件消失、权限等）返回空数组——扫描器把它们当作"没有内容"，
 * 绝不让单个坏文件打断整棵目录的分析。
 *
 * @param abs - 文件绝对路径。
 * @param options - `{ bytes }` 读取字节上限；`{ maxLines }` 返回行数上限。
 * @returns 行数组；大文件被静默截断到上限内。
 */
export async function readHeadLines(abs, { bytes = READ_BYTES_DEFAULT, maxLines = Number.POSITIVE_INFINITY } = {}) {
  const handle = await open(abs, 'r')
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(bytes), 0, bytes, 0)
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split(/\r\n|\r|\n/)
    if (Number.isFinite(maxLines) && lines.length > maxLines) lines.length = maxLines
    return lines
  } catch {
    return []
  } finally {
    await handle.close()
  }
}
