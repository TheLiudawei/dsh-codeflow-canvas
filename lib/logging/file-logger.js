/**
 * 独立文件日志（v1.2.2，需求三）——JSONL、追加、5 MiB 轮转、串行写、
 * 失败绝不抛错、fs/clock 可注入（测试用临时文件与假时钟）。
 *
 * 行为契约（任务书 §8.1）：
 *
 *   - 默认文件在插件根 `codeflow.log`；`CODEFLOW_LOG_FILE` 覆盖路径；
 *     `CODEFLOW_LOG=off` 完全关闭（enabled:false 时全部方法变 no-op）；
 *   - 写之前若 `size + line > maxBytes`：把当前文件重命名为
 *     `codeflow.log.1`（覆盖旧 `.1`），再新建 `codeflow.log`；最多保留
 *     2 个文件（10 MiB）；
 *   - 串行写队列：`Promise.all` 并发写也不交错、无半行；
 *   - 写失败绝不向调用方抛错：`warn` 一次「日志降级」（hostLogger），
 *     计入内存 `dropped`，下次成功写时补一条 `log.dropped`；
 *   - Windows 文件被占用/EPERM：重试一次；仍失败跳过本轮；
 *   - `flush()` 冲刷队列；`close()` 冲刷后停写（之后的调用静默丢弃）。
 *
 * 依赖方向：L0——只允许 `node:*` 与注入的 fs。
 *
 * @module dsh-codeflow-canvas/logging/file-logger
 */
import { mkdir, rename, rm, stat, appendFile } from 'node:fs/promises'
import path from 'node:path'

import { formatLine, lineTooLarge, SCHEMA_LIMITS } from './schema.js'

/** 默认轮转上限：5 MiB（任务书 §8.1）。 */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024

/**
 * 创建文件日志器。
 *
 * @param options.file - 日志文件绝对路径（必需，除非 enabled:false）。
 * @param options.maxBytes - 单文件字节上限（默认 5 MiB）。
 * @param options.keep - 轮转保留的旧文件个数（默认 1 → `codeflow.log.1`）。
 * @param options.fs - `{ stat, appendFile, rename, rm, mkdir }` 注入（测试）。
 * @param options.clock - `() => number`（测试固定时间）。
 * @param options.hostLogger - 宿主 logger（降级警告走这里，不进文件）。
 * @param options.enabled - false = no-op（`CODEFLOW_LOG=off`）。
 * @returns `{ debug, info, warn, error, event, child, flush, close, path, degraded }`。
 */
export function createFileLogger(options = {}) {
  const file = typeof options.file === 'string' && options.file.length > 0 ? options.file : null
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : DEFAULT_MAX_BYTES
  const keep = Number.isFinite(options.keep) && options.keep >= 0 ? options.keep : 1
  const fs = {
    stat: options.fs?.stat ?? stat,
    appendFile: options.fs?.appendFile ?? appendFile,
    rename: options.fs?.rename ?? rename,
    rm: options.fs?.rm ?? rm,
    mkdir: options.fs?.mkdir ?? mkdir,
  }
  const clock = typeof options.clock === 'function' ? options.clock : () => Date.now()
  const hostLogger = options.hostLogger
  // 开关三态：显式 enabled:false 永远关；显式 enabled:true 永远开（测试可
  // 越过环境变量）；未给时由 CODEFLOW_LOG=off 决定（logger 层直接读环境变量，
  // 测试/宿主不接线也遵守同一约定）。
  const envOff = String(process.env.CODEFLOW_LOG ?? '').toLowerCase() === 'off'
  const enabled = options.enabled === false ? false
    : options.enabled === true ? true
      : file !== null && !envOff

  /** 串行写队列（永不 reject）。 */
  let chain = Promise.resolve()
  let closed = false
  let degraded = false // 已向 hostLogger 报过一次降级
  let dropped = 0 // 降级期间丢弃的行数

  const warnOnce = (message) => {
    if (degraded) return
    degraded = true
    try { hostLogger?.warn?.(message) } catch { /* 宿主 logger 失败与文件日志无关 */ }
  }

  /** 追加一行（原始文本）。 */
  async function appendRaw(text) {
    try {
      await fs.mkdir(path.dirname(file), { recursive: true })
    } catch { /* 目录已存在或不可建：写入时再报错 */ }
    let attempts = 0
    for (;;) {
      attempts += 1
      try {
        // 轮转检查：size + line > maxBytes → 当前文件改名 .1，再新建。
        let size = 0
        try {
          const info = await fs.stat(file)
          if (info?.size) size = info.size
        } catch { /* 文件尚不存在 */ }
        if (size > 0 && size + Buffer.byteLength(text, 'utf8') > maxBytes) {
          if (keep > 0) {
            const rotated = `${file}.1`
            await fs.rm(rotated, { force: true }).catch(() => {})
            await fs.rename(file, rotated).catch((error) => {
              // .1 被占用等轮转失败：不崩溃，继续写当前文件（会超限一点）。
              warnOnce(`codeflow: 日志轮转失败（${String(error?.code ?? error?.message ?? error)}），继续写入当前文件`)
            })
          } else {
            await fs.rm(file, { force: true }).catch(() => {})
          }
        }
        await fs.appendFile(file, text, 'utf8')
        // 从降级中恢复：补一条 dropped 统计。
        if (dropped > 0) {
          const recovered = dropped
          dropped = 0
          const line = formatLine('log.dropped', { level: 'warn', msg: `日志降级期间丢弃 ${recovered} 行，已恢复写入`, clock })
          if (line) await fs.appendFile(file, `${JSON.stringify(line)}\n`, 'utf8').catch(() => {})
        }
        return
      } catch (error) {
        if (attempts === 1) {
          // Windows 文件被占用/EPERM：稍候重试一次。
          await new Promise((resolve) => setTimeout(resolve, 25))
          continue
        }
        // 仍失败：跳过本轮，计数 + 一次性降级警告（绝不向调用方抛）。
        dropped += 1
        warnOnce(`codeflow: 文件日志不可写（${String(error?.code ?? error?.message ?? error)}），日志降级为仅宿主输出`)
        return
      }
    }
  }

  /** 入队一行（序列化 + 单行限宽；超宽时收缩 data 到 [line-too-large]）。 */
  function enqueue(line) {
    if (!enabled || closed || !line) return
    let text
    try {
      if (lineTooLarge(line)) {
        line = { ...line, data: { note: '[line-too-large]' } }
        if (lineTooLarge(line)) line.msg = ''
      }
      text = `${JSON.stringify(line)}\n`
    } catch {
      return // 序列化失败：静默丢弃（日志绝不打断业务）
    }
    chain = chain.then(() => appendRaw(text), () => appendRaw(text))
  }

  function write(event, { level = 'info', msg, data, err } = {}) {
    enqueue(formatLine(event, { level, msg, data, err, clock }))
  }

  const levelWriter = (level) => (eventOrMsg, opts) => {
    // 两种调用形状：
    //   level('event-name', { msg, data, err }) —— 结构化事件（白名单校验）；
    //   level('宿主文本消息')                    —— 归入 log.host（如 store 落盘失败）。
    if (opts !== undefined && typeof opts === 'object' && !Array.isArray(opts)) {
      write(eventOrMsg, { ...opts, level })
      return
    }
    write('log.host', { level, msg: eventOrMsg })
  }

  return {
    debug: levelWriter('debug'),
    info: levelWriter('info'),
    warn: levelWriter('warn'),
    error: levelWriter('error'),
    /** 结构化事件（白名单外的事件被丢弃——schema.formatLine 返回 undefined）。
     *  调用约定：`event(name, { level?, msg?, data?, err? })`。 */
    event: (event, opts = {}) => write(event, {
      level: opts?.level ?? 'info',
      ...(opts?.msg !== undefined ? { msg: opts.msg } : {}),
      data: opts?.data,
      ...(opts?.err !== undefined ? { err: opts.err } : {}),
    }),
    /** 带默认字段的子日志器（topic 进 data；仍受白名单约束）。 */
    child(topic) {
      const base = this
      return {
        debug: (e, o) => base.debug(e, { ...(o ?? {}), data: { topic, ...(o?.data ?? {}) } }),
        info: (e, o) => base.info(e, { ...(o ?? {}), data: { topic, ...(o?.data ?? {}) } }),
        warn: (e, o) => base.warn(e, { ...(o ?? {}), data: { topic, ...(o?.data ?? {}) } }),
        error: (e, o) => base.error(e, { ...(o ?? {}), data: { topic, ...(o?.data ?? {}) } }),
        event: (e, data) => base.event(e, { topic, ...(data ?? {}) }),
      }
    },
    /** 冲刷挂起的写队列（插件 dispose / 测试断言前）。 */
    async flush() {
      await chain.catch(() => {})
    },
    /** 冲刷并停写；之后的写静默丢弃。 */
    async close() {
      await this.flush()
      closed = true
    },
    path: file,
    get degraded() { return degraded },
    get droppedCount() { return dropped },
    limits: SCHEMA_LIMITS,
  }
}

/**
 * 组合 logger：宿主 logger（Cordis/console）+ 文件 logger。
 *
 *   - info/warn/error 同时走宿主与文件（文件侧归入 `log.host`）；
 *   - `event(name, data)` 只进文件（结构化事件；白名单由 schema 把关）；
 *   - 文件日志关闭（`CODEFLOW_LOG=off`）时退化为纯宿主 logger——插件照常工作。
 *
 * @param hostLogger - 宿主 logger 形状（`{ info, warn, error }`，可缺失）。
 * @param fileLogger - {@link createFileLogger} 的返回（可 undefined）。
 * @returns 与现有调用方兼容的 logger（`warn?.()` 形状 + `event()`）。
 */
export function createCompositeLogger(hostLogger, fileLogger) {
  const host = hostLogger ?? console
  const forward = (level, args) => {
    try { host[level]?.(...args) } catch { /* 宿主 logger 异常不阻断 */ }
    try { fileLogger?.[level]?.(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')) } catch { /* 文件日志绝不抛 */ }
  }
  return {
    info: (...args) => forward('info', args),
    warn: (...args) => forward('warn', args),
    error: (...args) => forward('error', args),
    event: (event, data) => {
      try { fileLogger?.event?.(event, data) } catch { /* 日志绝不打断业务 */ }
    },
    /** 透传宿主 logger 的可选方法（遍历等场景的原样行为）。 */
    get file() { return fileLogger },
  }
}
