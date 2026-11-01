/**
 * 目录浏览路由组（v1.2.1，需求 C）：`GET /codeflow/api/browse`。
 *
 *   GET /api/browse            path 为空 → 根清单（盘符 / 主目录 / 工作区）
 *   GET /api/browse?path=X     列出该目录的子目录（只读、只列目录、不跟链接）
 *
 * 本文件是**薄路由**：只做参数整理与错误码映射，`readdir` 业务在
 * `lib/browse.js`（经 `ctx.browseDirectory` 注入，lib/index.js 装配）。
 * 走 `/codeflow` 既有安全闸，不新开未经鉴权的路径（C4）。
 *
 * @module dsh-codeflow-canvas/http/browse-routes
 */
import { sendJson } from './respond.js'

/** 浏览错误码 → HTTP 状态（C2 错误映射表）。 */
function browseStatus(code) {
  if (code === 'BROWSE_NOT_FOUND') return 404
  if (code === 'BROWSE_NOT_DIRECTORY' || code === 'BROWSE_BAD_PATH') return 400
  if (code === 'BROWSE_FORBIDDEN') return 403
  if (code === 'BROWSE_TIMEOUT') return 504
  return 500
}

/**
 * @param ctx - 路由上下文。
 * @returns 路由表项数组。
 */
export function createBrowseRoutes(ctx) {
  const { browseDirectory } = ctx
  return [
    {
      method: 'GET',
      path: '/api/browse',
      strict405: true,
      /** 只读目录浏览。所有失败都是带 `code` 的 4xx/5xx JSON，绝不 500 裸抛。 */
      async handler(req, res, { url }) {
        if (typeof browseDirectory !== 'function') {
          sendJson(res, 503, { ok: false, code: 'BROWSE_UNAVAILABLE', error: '当前组合没有注入目录浏览能力。' })
          return
        }
        const raw = url.searchParams.get('path') ?? ''
        try {
          const payload = await browseDirectory(raw)
          sendJson(res, 200, payload)
        } catch (error) {
          const code = typeof error?.code === 'string' && error.code.startsWith('BROWSE_') ? error.code : 'BROWSE_FAILED'
          sendJson(res, browseStatus(code), {
            ok: false,
            code,
            error: String(error?.message ?? error),
          })
        }
      },
    },
  ]
}
