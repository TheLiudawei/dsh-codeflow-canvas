/**
 * HTTP 传输基元：响应写出与请求体读取（/codeflow 路由层共用的最底层）。
 *
 * 两条从现场事故里换来的铁律都固化在这里：
 *
 *   1. **先排空再应答**（readJsonBody / readRawBody）：超限的请求体必须继续
 *      读完（内容直接丢弃）再回答 413——在未读完的连接上提前应答会污染
 *      keep-alive socket，客户端**同一条连接上的下一个请求**死于 ECONNRESET
 *      （现场表现为偶发 `fetch failed (status=0)`，B10）。
 *   2. **尺寸问题是客户端的错**：413/400 用带 `statusCode` 的 Error 表达，
 *      由 routes.js 的统一错误边界原样转成状态码，而不是落进 500。
 *
 * 依赖方向：无 lib 依赖（`node:*` only）。
 *
 * @module dsh-codeflow-canvas/http/respond
 */

/** 请求体上限：一张图加视口状态远小于这个值。 */
export const MAX_BODY_BYTES = 4 * 1024 * 1024

/**
 * 判定一个请求是否允许被应答。
 *
 * 宿主传输层已拒绝伪造的权限，但本路由对浏览器加载的任何内容可读可写，
 * 所以这里重复两条最便宜的检查：跨站 fetch，或 `Origin` 与它发往的 `Host`
 * 不一致。
 *
 * @param req - 来站请求。
 * @returns `0` 表示放行；否则为应答用的状态码。
 */
export function rejectionFor(req) {
  const headers = req.headers ?? {}
  const site = String(headers['sec-fetch-site'] ?? '').toLowerCase()
  if (site === 'cross-site') return 403
  const origin = headers.origin
  if (typeof origin === 'string' && origin.length > 0 && origin !== 'null') {
    let parsed
    try {
      parsed = new URL(origin)
    } catch {
      return 403
    }
    if (parsed.host.toLowerCase() !== String(headers.host ?? '').toLowerCase()) return 403
  }
  return 0
}

/** 写一个 JSON 响应（no-store）。 */
export function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** 写一个 HTML 响应（no-store）。 */
export function sendHtml(res, status, html) {
  const body = Buffer.from(html, 'utf8')
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * 读并解析一个 JSON 请求体。
 * @param req - 来站请求。
 * @returns 解析出的值；请求体缺失或非法 JSON 时 `undefined`。
 */
export async function readJsonBody(req) {
  const chunks = []
  let total = 0
  let oversized = false
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) {
      // 超限也继续排空（内容直接丢弃）而不是立刻应答：在未读完的请求上应答
      // 会污染 keep-alive 连接，客户端同一条连接上的下一个请求死于
      // ECONNRESET——字段报告里那次偶发 `fetch failed (status=0)` 的真凶。
      // 本路由只服务 loopback，无界但无记忆的排空没有代价。
      oversized = true
      continue
    }
    chunks.push(chunk)
  }
  if (oversized) {
    // 尺寸问题是客户端的错，不是服务端故障：回答 413，而不是统一错误边界
    // 对普通错误给出的 500。
    const error = new Error(`request body too large (limit ${MAX_BODY_BYTES} bytes)`)
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
 * 读一个原始（非 JSON）请求体并设硬上限——拖拽导入的上传通道
 * （`/api/drop/file`）直接 POST 文件字节。keep-alive 规则与
 * {@link readJsonBody} 相同：超限的体也排空到底再回 413。
 *
 * @returns `{ buffer, total, oversized }`；超限时 `buffer` 为 `null`。
 */
export async function readRawBody(req, cap) {
  const chunks = []
  let total = 0
  let oversized = false
  for await (const chunk of req) {
    total += chunk.length
    if (total > cap) {
      oversized = true
      continue
    }
    chunks.push(chunk)
  }
  return { buffer: oversized ? null : Buffer.concat(chunks), total, oversized }
}

/**
 * 错误对象的 HTTP 状态惯例：带整数 `statusCode` 的用之，否则 400。
 * 路由层各 handler 内部校验失败统一走这里，避免四份手写三元表达式。
 *
 * @param error - catch 到的任意值。
 */
export function statusOf(error) {
  return Number.isInteger(error?.statusCode) ? error.statusCode : 400
}
