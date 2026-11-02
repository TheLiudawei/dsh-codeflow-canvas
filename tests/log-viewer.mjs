/**
 * 工作日志查看器（v1.3.0，需求四）——任务书 §7.5 用例：
 *
 *   - readLogTail：尾部 N 行、坏行跳过、truncated、.1 拼接、level/query 过滤、
 *     文件不存在/空文件/读失败不抛、路径不由请求控制；
 *   - 路由：GET 200 形状、tail 夹紧、level 非法 400、q 超长 400、reveal 无能力
 *     501、?path= 不生效；POST 既有白名单/限流/413 不回归；
 *   - /api/log 不产生 http.request 日志（既有排除保持）。
 *
 * Run: ELECTRON_RUN_AS_NODE=1 <electron> tests/log-viewer.mjs
 */
import './_log-off.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = fileURLToPath(new URL('..', import.meta.url))
const load = (rel) => import(pathToFileURL(path.join(pluginRoot, rel)).href)

const { readLogTail } = await load('lib/logging/reader.js')
const { createReveal } = await load('lib/logging/reveal.js')
const { createRouter } = await load('lib/routes.js')
const { createStore } = await load('lib/store.js')

let passed = 0
const ok = (name) => { passed += 1; console.log('  ok ', name) }
const tmp = await mkdtemp(path.join(tmpdir(), 'codeflow-logviewer-'))
const line = (event, extra = {}) => JSON.stringify({ v: 1, ts: '2026-11-02T08:00:00.000Z', level: 'info', event, pid: 1, ...extra })

/* ------------------------------------------------ 1. readLogTail 单测 --- */
{
  const file = path.join(tmp, 'codeflow.log')
  const rows = [
    line('plugin.start', { msg: 'start' }),
    line('import.root', { data: { requested: 'x', resolved: 'y', unwrappedDepth: 1 } }),
    '{ broken json',
    '',
    line('coupling.done', { data: { durationMs: 12 } }),
    '{"ts":"2026-11-02T08:00:00.000Z","level":"nope","event":"bad.level"}',
    '{"level":"info","event":"no.ts"}',
  ]
  await writeFile(file, rows.join('\n') + '\n', 'utf8')
  const r = await readLogTail({ file, maxLines: 100 })
  assert.equal(r.lines.length, 3, `坏行/坏形状跳过：${r.lines.length}`)
  assert.equal(r.invalidLines, 3, '坏 JSON 与形状不合法的行都计 invalidLines（空行不计）')
  assert.deepEqual(r.lines.map((l) => l.event), ['plugin.start', 'import.root', 'coupling.done'])
  assert.equal(r.truncated, false)
  assert.ok(r.mtime, 'mtime 为 ISO 字符串')
  /* 尾部 N 行。 */
  const two = await readLogTail({ file, maxLines: 2 })
  assert.equal(two.lines.length, 2)
  assert.equal(two.lines[1].event, 'coupling.done', '取的是最新两行')
  /* truncated。 */
  const tiny = await readLogTail({ file, maxLines: 100, maxBytes: 16 })
  assert.equal(tiny.truncated, true, 'maxBytes 截断标记')
  ok('readLogTail：尾部/坏行/形状校验/truncated')
}
{
  /* level / query 过滤（query 不匹配 err.stack）。 */
  const file = path.join(tmp, 'filter.log')
  const rows = [
    line('a.one', { msg: 'alpha thing' }),
    line('b.two', { level: 'warn', data: { project: 'acme' } }),
    line('c.three', { level: 'error', err: { name: 'Error', message: 'boom', stack: 'Error: boom\n    at SECRET-NEEDLE' } }),
    line('d.four', { data: { note: 'Alpha CASE' } }),
  ]
  await writeFile(file, rows.join('\n') + '\n', 'utf8')
  const byLevel = await readLogTail({ file, level: 'warn' })
  assert.deepEqual(byLevel.lines.map((l) => l.event), ['b.two'])
  const byQuery = await readLogTail({ file, query: 'alpha' })
  assert.deepEqual(byQuery.lines.map((l) => l.event).sort(), ['a.one', 'd.four'], 'query 大小写不敏感，仅 event/msg/data')
  const byStack = await readLogTail({ file, query: 'SECRET-NEEDLE' })
  assert.equal(byStack.lines.length, 0, 'query 不匹配 err.stack')
  ok('readLogTail：level/query 过滤（不搜堆栈）')
}
{
  /* includeRotated：.1 在前、当前文件在后。 */
  const file = path.join(tmp, 'rot', 'codeflow.log')
  await mkdir2(path.join(tmp, 'rot'))
  await writeFile(`${file}.1`, [line('old.one'), line('old.two')].join('\n') + '\n', 'utf8')
  await writeFile(file, [line('new.one')].join('\n') + '\n', 'utf8')
  const r = await readLogTail({ file, includeRotated: true })
  assert.deepEqual(r.lines.map((l) => l.event), ['old.one', 'old.two', 'new.one'], '.1 在前')
  assert.equal(r.rotatedSize > 0, true)
  const without = await readLogTail({ file })
  assert.deepEqual(without.lines.map((l) => l.event), ['new.one'])
  ok('readLogTail：includeRotated 拼接 .1')
}
{
  /* 文件不存在 / 空文件 / 未启用：不抛。 */
  const missing = await readLogTail({ file: path.join(tmp, 'nope', 'missing.log') })
  assert.equal(missing.lines.length, 0)
  assert.equal(missing.missing, true)
  const emptyFile = path.join(tmp, 'empty.log')
  await writeFile(emptyFile, '', 'utf8')
  const empty = await readLogTail({ file: emptyFile })
  assert.deepEqual(empty.lines, [])
  const disabled = await readLogTail({ file: null })
  assert.equal(disabled.disabled, true)
  ok('readLogTail：不存在/空文件/未启用 不抛')
}
{
  /* reveal 适配器：无能力 501；注入 spawn 不真开窗。 */
  const noCap = createReveal({})
  const denied = await noCap('item')
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 501)
  let spawned = false
  const withSpawn = createReveal({
    spawn: () => { spawned = true; return { on() {}, unref() {} } },
    allowedFile: path.join(tmp, 'codeflow.log'),
  })
  const revealed = await withSpawn('item')
  assert.equal(revealed.ok, true)
  assert.equal(spawned, true, 'spawn 注入生效（单测不真开窗）')
  const hostShell = { calls: [] }
  const withShell = createReveal({ hostShell: { showItemInFolder: (p) => hostShell.calls.push(p) }, spawn: () => { throw new Error('should not spawn') }, allowedFile: path.join(tmp, 'codeflow.log') })
  const viaShell = await withShell('item')
  assert.equal(viaShell.ok, true)
  assert.equal(hostShell.calls.length, 1, '宿主 shell 优先')
  ok('reveal：501 降级 / spawn 注入 / 宿主 shell 优先')
}

/* ------------------------------------------------------- 2. 路由契约 --- */
{
  const workspace = await mkdtemp(path.join(tmpdir(), 'codeflow-logview-http-'))
  const logFile = path.join(workspace, 'codeflow.log')
  await writeFile(logFile, [line('plugin.start', { msg: 'hi' }), line('ui.action', { data: { control: '#x' } })].join('\n') + '\n', 'utf8')
  const calls = []
  const handler = createRouter({
    store: createStore(console),
    logger: console,
    resolveCwd: async () => workspace,
    ensureSession: async () => ({ sessionId: 's', created: false }),
    submit: async () => ({ sessionId: 's' }),
    // 与 index.js 相同的绑定形状：路径固定注入，请求参数控制不了它。
    readLogTail: (options) => readLogTail({ ...(options ?? {}), file: logFile, rotatedPath: `${logFile}.1` }),
    revealPath: async () => ({ ok: false, code: 501, error: '当前宿主不支持打开目录；请复制路径手动查看。' }),
  })
  const call = async (method, url, body, headers) => {
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')]
    const req = Object.assign(Readable.from(chunks), { method, url, headers: { host: '127.0.0.1:19387', ...(headers ?? {}) } })
    const res = {
      statusCode: 0, headers: {}, body: '',
      writeHead(status, h) { this.statusCode = status; this.headers = h ?? {} },
      end(chunk) { if (chunk !== undefined) this.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk) },
    }
    await handler(req, res)
    let json = null
    try { json = JSON.parse(res.body) } catch { /* ignore */ }
    return { status: res.statusCode, json, body: res.body }
  }
  const good = await call('GET', '/codeflow/api/log')
  assert.equal(good.status, 200)
  assert.equal(good.json.ok, true)
  assert.equal(good.json.lines.length, 2)
  assert.equal(good.json.path, logFile, '路径是注入的固定路径')
  assert.equal(good.json.truncated, false)
  const tailed = await call('GET', '/codeflow/api/log?tail=1')
  assert.equal(tailed.json.lines.length, 1, 'tail 生效')
  const clamped = await call('GET', '/codeflow/api/log?tail=99999')
  assert.equal(clamped.status, 200, '超出范围夹紧不报错')
  const badLevel = await call('GET', '/codeflow/api/log?level=loud')
  assert.equal(badLevel.status, 400, 'level 非法 → 400')
  const longQ = await call('GET', `/codeflow/api/log?q=${'x'.repeat(201)}`)
  assert.equal(longQ.status, 400, 'q 超 200 → 400')
  const pathed = await call('GET', `/codeflow/api/log?path=${encodeURIComponent('C:\\Windows\\win.ini')}`)
  assert.equal(pathed.json.path, logFile, '?path= 请求参数不生效（注入绑定）')
  const reveal = await call('POST', '/codeflow/api/log/reveal', { kind: 'item' })
  assert.equal(reveal.status, 501, '宿主无能力 → 501')
  assert.ok(String(reveal.json.error).includes('不支持'), '501 错误可行动')
  /* POST 既有契约不回归。 */
  const post = await call('POST', '/codeflow/api/log', { events: [{ event: 'ui.action', data: { control: '#x' } }] })
  assert.equal(post.status, 200)
  const flood = []
  for (let i = 0; i < 4; i += 1) {
    const r = await call('POST', '/codeflow/api/log', { events: Array.from({ length: 20 }, () => ({ event: 'ui.action', data: { control: 'flood' } })) })
    flood.push(r.status)
    if (r.status === 429) break
  }
  assert.ok(flood.includes(429), '限流 429 仍在')
  const bigPost = await call('POST', '/codeflow/api/log', { events: [{ event: 'ui.error', data: { message: 'x'.repeat(70 * 1024) } }] })
  assert.equal(bigPost.status, 413, '413 仍在')
  ok('路由：GET 形状/夹紧/400/注入绑定/reveal 501 + POST 白名单/限流/413 不回归')
  await rm(workspace, { recursive: true, force: true }).catch(() => {})
}

async function mkdir2(dir) {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(dir, { recursive: true })
}

await rm(tmp, { recursive: true, force: true }).catch(() => {})
console.log(`\n[summary] log-viewer: ${passed} checks passed`)
