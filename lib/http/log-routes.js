/**
 * 浏览器日志上报/读取路由组（v1.2.2 上报 + v1.3.0 只读查看，需求四）。
 *
 *   POST /api/log          画布批量上报 ui.action / ui.error / ui.selftest
 *   GET  /api/log          只读日志尾部（tail/rotated/level/q 参数）
 *   POST /api/log/reveal   打开日志所在目录（宿主能力降级，见 logging/reveal）
 *
 * 契约（任务书 §8.3.6 / §7.3）：
 *
 *   - 与其它路由同源的 `rejectionFor` 闸与 `options.fence` 由 routes.js 统一
 *     施加（画布同源 iframe 自动带 cookie）；
 *   - 上报 body 上限 **64 KiB**：超限排空后 413；白名单事件；限流 50 条/秒、
 *     单批 ≤ 20 条；超限 429；成功 `{ok:true}`；写入失败也回 200；
 *   - GET 的 `tail` 夹紧 1–5000；`level` 非法 400（不静默回退）；`q` 超 200
 *     字符 400；文件读取与路径解析全部经 `ctx.readLogTail` 注入（本模块不碰
 *     `node:fs`——架构红线），路径不由请求控制；
 *   - reveal 经 `ctx.revealPath` 注入；能力缺失回 501，UI 明确提示；
 *   - `/api/log` 自身不产生 http.request 日志（防日志风暴，由 routes.js 排除）。
 *
 * 依赖方向：L3——不 import `node:fs`（红线），只调用注入的 logger/reader。
 *
 * @module dsh-codeflow-canvas/http/log-routes
 */
import { CLIENT_EVENTS } from '../logging/schema.js'
import { sendJson } from './respond.js'

/** 上报请求体上限（字节）。 */
export const LOG_BODY_LIMIT = 64 * 1024
/** 单批事件数上限。 */
export const LOG_BATCH_LIMIT = 20
/** 每进程每秒接受的事件数。 */
export const LOG_RATE_PER_SECOND = 50
/** GET tail 的合法范围。 */
export const LOG_TAIL_MIN = 1
export const LOG_TAIL_MAX = 5000
/** GET q 的最大长度。 */
export const LOG_QUERY_MAX = 200
const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error'])

/**
 * 读一个 JSON 请求体，超过 `cap` 排空后报 413（先排空再应答，保 keep-alive）。
 * @returns 解析值（非法 JSON → undefined）；超限时抛 `statusCode=413`。
 */
async function readJsonBodyCapped(req, cap) {
  const chunks = []
  let total = 0
  let oversized = false
  for await (const chunk of req) {
    total += chunk.length
    if (total > cap) { oversized = true; continue }
    chunks.push(chunk)
  }
  if (oversized) {
    const error = new Error(`log request body too large (limit ${cap} bytes)`)
    error.statusCode = 413
    throw error
  }
  if (total === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/**
 * @param ctx - 路由上下文（`logger` 为组合 logger；`readLogTail` / `revealPath`
 *   由 index.js 注入——本模块不碰 fs、不解析路径）。
 * @returns `{ routes }`。
 */
export function createLogRoutes(ctx) {
  const { logger, readLogTail, revealPath } = ctx

  /** 令牌桶之外的简单滑窗：记录最近 1s 内接受的事件时间戳。 */
  let acceptedTimestamps = []
  let rateLimitedDropped = 0

  /** 客户端事件 → 文件日志（data 已由 schema 的 sanitizeData 统一脱敏/截断）。 */
  function accept(entry) {
    const level = entry.level === 'error' ? 'error' : (entry.level === 'warn' ? 'warn' : 'info')
    try {
      logger?.event?.(entry.event, { level, ...(entry.msg !== undefined ? { msg: String(entry.msg) } : {}), data: entry.data })
    } catch { /* 写失败也回 200 */ }
  }

  const routes = [
    {
      method: 'POST',
      path: '/api/log',
      /** 画布批量日志上报：白名单 + 64 KiB + 单批 20 + 50 条/秒。 */
      async handler(req, res) {
        let body
        try {
          body = await readJsonBodyCapped(req, LOG_BODY_LIMIT)
        } catch (error) {
          sendJson(res, error?.statusCode ?? 400, { ok: false, error: String(error?.message ?? error) })
          return
        }
        const events = body !== null && typeof body === 'object' && !Array.isArray(body) ? body.events : undefined
        if (!Array.isArray(events) || events.length === 0) {
          sendJson(res, 400, { ok: false, error: 'expected {events:[{event,...}]}' })
          return
        }
        if (events.length > LOG_BATCH_LIMIT) {
          sendJson(res, 413, { ok: false, error: `单批最多 ${LOG_BATCH_LIMIT} 条` })
          return
        }
        // 限流：1 秒滑窗。超限的整批 429（客户端失败静默丢弃，不重试）。
        const now = Date.now()
        acceptedTimestamps = acceptedTimestamps.filter((t) => now - t < 1000)
        if (acceptedTimestamps.length + events.length > LOG_RATE_PER_SECOND) {
          rateLimitedDropped += events.length
          try { logger?.event?.('log.dropped', { data: { reason: 'rate-limit', count: events.length, total: rateLimitedDropped } }) } catch { /* ignore */ }
          sendJson(res, 429, { ok: false, error: 'log rate exceeded' })
          return
        }
        for (const entry of events) {
          const event = entry !== null && typeof entry === 'object' ? entry.event : undefined
          if (!CLIENT_EVENTS.has(event)) {
            sendJson(res, 400, { ok: false, error: `event 不在白名单：${String(event).slice(0, 40)}` })
            return
          }
        }
        for (const entry of events) acceptedTimestamps.push(now)
        for (const entry of events) accept(entry)
        sendJson(res, 200, { ok: true })
      },
    },
    {
      method: 'GET',
      path: '/api/log',
      /**
       * 只读日志尾部（v1.3.0，需求四）。参数：`tail`（1–5000，默认 2000，超出
       * 夹紧）、`rotated`（1/true 包含 .1）、`level`（四级别之一，非法 400）、
       * `q`（≤200 字符，超长 400 不截断）。文件路径由 index.js 绑定注入，
       * 请求传什么都不生效；日志关闭时 `{ok:true, disabled:true}`。
       */
      async handler(req, res, { url }) {
        if (typeof readLogTail !== 'function') {
          sendJson(res, 501, { ok: false, error: '日志读取能力未注入（日志组件不可用）。' })
          return
        }
        const tailRaw = url.searchParams.get('tail')
        let tail = 2000
        if (tailRaw !== null) {
          const parsed = Number(tailRaw)
          if (!Number.isFinite(parsed)) {
            sendJson(res, 400, { ok: false, error: 'tail 必须是整数。' })
            return
          }
          tail = Math.min(LOG_TAIL_MAX, Math.max(LOG_TAIL_MIN, Math.floor(parsed)))
        }
        const rotatedRaw = String(url.searchParams.get('rotated') ?? '')
        const rotated = rotatedRaw === '1' || rotatedRaw.toLowerCase() === 'true'
        const levelRaw = url.searchParams.get('level')
        if (levelRaw !== null && !LOG_LEVELS.has(levelRaw)) {
          sendJson(res, 400, { ok: false, error: `level 只接受 debug/info/warn/error（收到：${levelRaw.slice(0, 40)}）。` })
          return
        }
        const q = url.searchParams.get('q') ?? ''
        if (q.length > LOG_QUERY_MAX) {
          sendJson(res, 400, { ok: false, error: `q 最长 ${LOG_QUERY_MAX} 字符（当前 ${q.length}）。` })
          return
        }
        try {
          const result = await readLogTail({
            maxLines: tail,
            includeRotated: rotated,
            ...(levelRaw !== null ? { level: levelRaw } : {}),
            ...(q.length > 0 ? { query: q } : {}),
          })
          sendJson(res, 200, { ok: true, ...result })
        } catch (error) {
          // 失败 500 但绝不回显文件内容。
          sendJson(res, 500, { ok: false, error: '日志读取失败。' })
        }
      },
    },
    {
      method: 'POST',
      path: '/api/log/reveal',
      /** 打开日志所在目录（宿主能力降级；能力缺失 501，UI 明确提示）。 */
      async handler(req, res) {
        if (typeof revealPath !== 'function') {
          sendJson(res, 501, { ok: false, error: '当前宿主不支持打开目录；请复制路径手动查看。' })
          return
        }
        let body = null
        try {
          body = await readJsonBodyCapped(req, 4 * 1024)
        } catch { /* body 可缺省 */ }
        const kind = body !== null && typeof body === 'object' && body.kind === 'dir' ? 'dir' : 'item'
        try {
          const result = await revealPath(kind)
          if (result && result.ok === true) {
            sendJson(res, 200, { ok: true, ...(result.path !== undefined ? { path: result.path } : {}), ...(result.dir !== undefined ? { dir: result.dir } : {}) })
          } else {
            sendJson(res, 501, { ok: false, error: String(result?.error ?? '当前宿主不支持打开目录') })
          }
        } catch (error) {
          sendJson(res, 501, { ok: false, error: String(error?.message ?? '当前宿主不支持打开目录') })
        }
      },
    },
  ]

  return { routes }
}
