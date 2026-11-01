/**
 * 浏览器日志上报路由组（v1.2.2，需求三）。
 *
 *   POST /api/log   画布批量上报 ui.action / ui.error / ui.selftest
 *
 * 契约（任务书 §8.3.6）：
 *
 *   - 与其它路由同源的 `rejectionFor` 闸与 `options.fence` 由 routes.js 统一
 *     施加（画布同源 iframe 自动带 cookie）；
 *   - body 上限 **64 KiB**：超限排空后 413（保 keep-alive 的排空语义与
 *     respond.js 一致）；
 *   - 只接受白名单事件（ui.action / ui.error / ui.selftest），拒绝任意事件名；
 *   - 限流：每进程 50 条/秒、单批 ≤ 20 条；超限 429 并计入 dropped；
 *   - 成功 `{ok:true}`，绝不回显日志内容；写入失败也回 200（客户端不重试
 *     轰炸）；
 *   - `/api/log` 自身不产生 http.request 日志（防日志风暴，由 routes.js 排除）。
 *
 * 依赖方向：L3——不 import `node:fs`（红线），只调用注入的 logger。
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
 * @param ctx - 路由上下文（`logger` 为组合 logger，`event()` 进文件）。
 * @returns `{ routes }`。
 */
export function createLogRoutes(ctx) {
  const { logger } = ctx

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
  ]

  return { routes }
}
