/**
 * 工作与报错日志测试（v1.2.2，需求三）——任务书 §8.5 清单：
 *
 *   1. 文件创建、plugin.start/stop 生命周期、JSONL 逐行可解析；
 *   2. 轮转（maxBytes=512 → codeflow.log.1，内容不丢）；
 *   3. 并发 100 条写不交错、无半行；
 *   4. 脱敏（authorization/cookie/token/prompt/content）与截断；
 *   5. 失败安全（只读目录 / 注入抛错的 fs；降级只警告一次；flush 不挂起）；
 *   6. CODEFLOW_LOG=off 不建文件；CODEFLOW_LOG_FILE 生效；
 *   7. 轮转失败（.1 被占用）不崩溃、继续写；
 *   8. e2e：真实 HTTP 触发导入 → import.start/root/done；submit 抛错 →
 *      http.error；/api/log 合法/非法/超批/跨站/洪水 → 200/400/413/403/429；
 *   9. 测试全程不写仓库根（_log-off.mjs + 临时目录）。
 *
 * Run: ELECTRON_RUN_AS_NODE=1 <electron> tests/logging.mjs
 */
import './_log-off.mjs'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = fileURLToPath(new URL('..', import.meta.url))
const load = (rel) => import(pathToFileURL(path.join(pluginRoot, rel)).href)

const { createFileLogger, createCompositeLogger } = await load('lib/logging/file-logger.js')
const { formatLine, sanitizeData, CLIENT_EVENTS } = await load('lib/logging/schema.js')
const { createRouter, ROUTE_PREFIX } = await load('lib/routes.js')
const { createStore } = await load('lib/store.js')

let passed = 0
const ok = (name) => { passed += 1; console.log('  ok ', name) }

const tmp = await mkdtemp(path.join(tmpdir(), 'codeflow-logging-'))

/* 单元段直接考察 logger 自身行为：脱离 _log-off 的 off 状态（off 开关本身
   在 §8 用例里显式验证；apply 接线段各自管理 env）。 */
process.env.CODEFLOW_LOG = ''

/* 基线：插件根是否已存在 codeflow.log。插件以 Junction 安装在仓库根，
   **正在运行的 DSH 会真实地写它**（生产语义）；测试只保证「本进程没写」。 */
const rootLogPath = path.join(pluginRoot, 'codeflow.log')
const rootLogExistedBefore = await stat(rootLogPath).then(() => true, () => false)

/** 读 JSONL 文件为行对象数组（空行忽略）。 */
async function readJsonl(file) {
  const text = await readFile(file, 'utf8').catch(() => '')
  return text.split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line))
}

/* ------------------------------------------------- 1. 生命周期 + JSONL --- */
{
  const file = path.join(tmp, 'life', 'codeflow.log')
  const logger = createFileLogger({ file, hostLogger: console })
  logger.event('plugin.start', { msg: 'codeflow-canvas test', data: { node: process.version } })
  logger.info('宿主文本消息 → log.host')
  logger.warn('store 落盘失败（示例）')
  await logger.flush()
  let lines = await readJsonl(file)
  assert.equal(lines[0].event, 'plugin.start', `首行应为 plugin.start：${lines[0].event}`)
  assert.equal(lines[0].v, 1)
  assert.ok(!Number.isNaN(Date.parse(lines[0].ts)), 'ts 必须是 ISO 8601')
  for (const line of lines) {
    assert.equal(typeof line.event, 'string')
    assert.ok(['debug', 'info', 'warn', 'error'].includes(line.level))
  }
  assert.ok(lines.some((l) => l.event === 'log.host' && l.level === 'info'))
  assert.ok(lines.some((l) => l.event === 'log.host' && l.level === 'warn'), '宿主 warn 转入 log.host')
  await logger.close()
  await logger.event('plugin.stop', {}) // close 之后的写静默丢弃
  await logger.flush()
  lines = await readJsonl(file)
  assert.ok(!lines.some((l) => l.event === 'plugin.stop'), 'close 后不再写入')
  ok('生命周期：首行 plugin.start、JSONL 逐行可解析、close 后停写')
}

/* --------------------------------------------------- 2. 插件级接线 ------- */
{
  const workspace = await mkdtemp(path.join(tmpdir(), 'codeflow-logging-apply-'))
  const logFile = path.join(workspace, 'plugin.log')
  process.env.CODEFLOW_LOG_FILE = logFile
  delete process.env.CODEFLOW_LOG
  const effects = []
  const fakeCtx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(factory, name) { const d = factory(); if (typeof d === 'function') effects.push({ name, dispose: d }); return d },
    on() { return () => {} },
    get(name) { return name === 'agents' ? { get: () => undefined, roots: () => [] } : undefined },
    inject() { /* 测试不装配 webServer：HTTP 面在下面的 router 级用例覆盖 */ },
    skills: { registerProvider() { return () => {} } },
    commands: { register() { return () => {} } },
    tools: { register() { return () => {} } },
  }
  const { apply } = await load('lib/index.js')
  apply(fakeCtx)
  // 宿主 LIFO：后注册的先跑；最后一个 effect 应当是「flush → stop → close」。
  for (const effect of effects.reverse()) await effect.dispose()
  const lines = await readJsonl(logFile)
  assert.equal(lines[0].event, 'plugin.start', `apply() 首行 plugin.start：${lines[0]?.event}`)
  assert.ok(lines[0].data.file === logFile, 'plugin.start 记录日志文件位置')
  assert.equal(lines[lines.length - 1].event, 'plugin.stop', 'dispose 末行 plugin.stop')
  // （组合 logger 的宿主消息转发已由「生命周期」用例的 log.host 断言覆盖；
  //  干净启动的 apply 不产生 warn，这里不重复断言。）
  delete process.env.CODEFLOW_LOG_FILE
  process.env.CODEFLOW_LOG = '' // 恢复单元段状态（off 开关由 §8 显式验证）
  await rm(workspace, { recursive: true, force: true })
  ok('插件接线：apply() 写 plugin.start，dispose 顺序 flush → stop → close')
}

/* ------------------------------------------------------- 3. 轮转 --------- */
{
  const file = path.join(tmp, 'rotate', 'codeflow.log')
  // 5 条 × ~170B ≈ 850B；maxBytes=600 → 恰好一次轮转（keep=1 时多次轮转的
  // .1 会被覆盖——生产语义是「最多 2 个文件」，测试按单次轮转断言内容不丢）。
  const logger = createFileLogger({ file, maxBytes: 600, hostLogger: console })
  const names = ['import.start', 'import.root', 'import.persist', 'import.done', 'coupling.done']
  names.forEach((name, i) => logger.event(name, { data: { i, pad: 'x'.repeat(40) } }))
  await logger.flush()
  const current = await readJsonl(file)
  const rotated = await readJsonl(`${file}.1`)
  assert.ok(rotated.length > 0, '应有轮转出的 .1 文件')
  assert.ok(current.length > 0, '当前文件应有新行')
  const all = [...rotated, ...current]
  const seen = new Set(all.map((l) => l.event))
  for (const name of names) assert.ok(seen.has(name), `轮转合并后事件齐全：缺 ${name}`)
  const info = await stat(file)
  assert.ok(info.size <= 600 + 400, `当前文件接近上限（size=${info.size}）`)
  await logger.close()
  ok('轮转：上限触发 codeflow.log.1，两条文件合并后事件齐全')
}

/* ------------------------------------------------------- 4. 并发 --------- */
{
  const file = path.join(tmp, 'conc', 'codeflow.log')
  const logger = createFileLogger({ file, hostLogger: console })
  await Promise.all(Array.from({ length: 100 }, (_, i) => {
    logger.event('import.root', { data: { i, marker: `m${i}`.repeat(3) } })
    return Promise.resolve()
  }))
  await logger.flush()
  const raw = await readFile(file, 'utf8')
  const lines = raw.split('\n').filter((l) => l.trim().length > 0)
  assert.equal(lines.length, 100, `100 行都在（${lines.length}）`)
  for (const line of lines) JSON.parse(line) // 半行/交错会在这里炸
  const markers = new Set(lines.map((l) => JSON.parse(l).data.i))
  assert.equal(markers.size, 100, '每条都落盘')
  await logger.close()
  ok('并发：Promise 100 条写不交错、无半行、无丢失')
}

/* ------------------------------------------------------- 5. 脱敏 --------- */
{
  const line = formatLine('import.root', {
    data: {
      authorization: 'Bearer x', cookie: 'a=b', token: 't', api_key: 'k', apiKey: 'k2',
      password: 'p', prompt: 'secret prompt', content: 'source', body: '{...}',
      nested: { token: 'inner' },
      path: 'C:\\Users\\someone\\very\\long\\path\\that\\should\\be\\truncated\\because\\it\\is\\a\\path\\value\\in\\the\\log\\entry\\data\\section\\final.txt',
      long: 'y'.repeat(2000),
      deep: { a: { b: { c: { d: { e: 'too deep' } } } } },
      arr: Array.from({ length: 80 }, (_, i) => i),
      project: 'my-proj',
    },
  })
  const d = line.data
  assert.equal(d.authorization, '[redacted]')
  assert.equal(d.cookie, '[redacted]')
  assert.equal(d.token, '[redacted]')
  assert.equal(d.api_key, '[redacted]')
  assert.equal(d.apiKey, '[redacted]')
  assert.equal(d.password, '[redacted]')
  assert.equal(d.prompt, '[redacted]')
  assert.equal(d.content, '[redacted]')
  assert.equal(d.body, '[redacted]')
  assert.equal(d.nested.token, '[redacted]')
  assert.ok(d.path.length <= 300, `路径形状截断到 300（${d.path.length}）`)
  assert.ok(d.long.length <= 1000, '长字符串截断到 1000')
  assert.equal(d.deep.a.b.c, '[depth]', '深度 ≤4（第 5 层起替换为 [depth]）')
  assert.equal(d.arr.length, 50, '数组 ≤50')
  assert.equal(d.project, 'my-proj', '项目名可以记录')
  const errLine = formatLine('http.error', { level: 'error', err: new Error('boom with token inside') })
  assert.equal(errLine.err.name, 'Error')
  assert.ok(errLine.err.message.includes('boom'))
  assert.ok(errLine.err.stack.length <= 4000)
  ok('脱敏：敏感键替换 [redacted]；路径/长串/深度/数组截断；err 只留 name/message/stack')
}

/* -------------------------------------------------- 6. 白名单 / 格式 ---- */
{
  assert.equal(formatLine('not.an.event', { data: { a: 1 } }), undefined, '白名单外事件丢弃')
  for (const name of CLIENT_EVENTS) assert.notEqual(formatLine(name, { data: {} }), undefined)
  const cleaned = sanitizeData({ graph: '{"nodes":[]}', messages: 'hi' })
  assert.equal(cleaned.messages, '[redacted]')
  ok('schema：事件白名单与 sanitizeData 行为')
}

/* -------------------------------------------------- 7. 失败安全 ---------- */
{
  // Windows 上 0o555 目录位不可靠；用「父路径是普通文件」制造确定性写失败
  // （mkdir 一直 ENOTDIR），断言降级行为。
  const blocker = path.join(tmp, 'blocker')
  await writeFile(blocker, 'I am a file, not a directory')
  const warns = []
  const logger = createFileLogger({
    file: path.join(blocker, 'log', 'codeflow.log'),
    hostLogger: { warn: (m) => warns.push(String(m)) },
  })
  logger.error('write attempt', { data: { a: 1 } })
  logger.warn('second')
  await logger.flush()
  await logger.close()
  assert.equal(warns.length, 1, `降级只警告一次（${warns.length}）`)
  assert.ok(warns[0].includes('降级'), '警告文案说明降级')

  const failing = createFileLogger({
    file: path.join(tmp, 'failing', 'codeflow.log'),
    fs: { stat: async () => { throw new Error('boom') }, appendFile: async () => { throw new Error('boom') }, rename: async () => { throw new Error('boom') }, rm: async () => {}, mkdir: async () => {} },
    hostLogger: { warn() {} },
  })
  for (let i = 0; i < 5; i += 1) failing.info('x', { data: { i } })
  await failing.flush()
  await failing.close() // 必须不挂起、不抛
  ok('失败安全：只读目录/抛错 fs 不向调用方抛、只降级一次、flush/close 不挂起')
}

/* ------------------------------------- 8. CODEFLOW_LOG=off / 覆盖路径 ---- */
{
  const before = process.env.CODEFLOW_LOG
  process.env.CODEFLOW_LOG = 'off'
  const file = path.join(tmp, 'off', 'codeflow.log')
  const logger = createFileLogger({ file, hostLogger: console })
  logger.info('should not write')
  logger.event('import.root', { data: { a: 1 } })
  await logger.flush()
  const exists = await stat(file).then(() => true, () => false)
  assert.equal(exists, false, 'off 模式不创建文件')
  const disabled = createFileLogger({ file, enabled: false })
  disabled.info('x')
  await disabled.flush()
  process.env.CODEFLOW_LOG = before
  ok('CODEFLOW_LOG=off / enabled:false：不创建文件、调用面安静')
}

/* ------------------------------------------------- 9. 轮转失败不崩溃 ----- */
{
  const file = path.join(tmp, 'rotatefail', 'codeflow.log')
  const warns = []
  let renameCalls = 0
  const fsp = await import('node:fs/promises')
  const logger = createFileLogger({
    file, maxBytes: 256, hostLogger: { warn: (m) => warns.push(String(m)) },
    fs: {
      stat: fsp.stat,
      appendFile: fsp.appendFile,
      rename: async (...args) => { renameCalls += 1; throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }) },
      rm: async () => {},
      mkdir: fsp.mkdir, // 真实建目录：本用例只考察轮转失败，不考察目录失败
    },
  })
  for (let i = 0; i < 30; i += 1) logger.event('import.persist', { data: { i, pad: 'z'.repeat(30) } })
  await logger.flush()
  await logger.close()
  assert.ok(renameCalls > 0, '触发过轮转尝试')
  assert.ok(warns.some((w) => w.includes('轮转失败')), '轮转失败有一次性警告')
  const lines = await readJsonl(file)
  assert.ok(lines.length > 0, '轮转失败后仍继续写当前文件')
  ok('轮转失败（.1 被占用）：不崩溃、继续写当前文件')
}

/* ------------------------------------------------- 10. HTTP e2e ---------- */
console.log('\n[http e2e]')
{
  const workspace = await mkdtemp(path.join(tmpdir(), 'codeflow-logging-http-'))
  const logFile = path.join(workspace, 'codeflow.log')
  const fileLogger = createFileLogger({ file: logFile, hostLogger: console })
  const logger = createCompositeLogger(console, fileLogger)
  const store = createStore(console)
  let submitBoom = false
  const handler = createRouter({
    store,
    logger,
    resolveCwd: async () => workspace,
    ensureSession: async () => ({ sessionId: 'sess-log', created: false }),
    submit: async () => { if (submitBoom) throw new Error('boom on purpose'); return { sessionId: 'sess-log' } },
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
  // 导入一个真实夹具 → import.start/root/done。
  const sourceRoot = path.join(workspace, 'proj')
  await mkdir2(path.join(sourceRoot, 'src'))
  await writeFile(path.join(sourceRoot, 'package.json'), '{"name":"log-e2e"}')
  await writeFile(path.join(sourceRoot, 'src', 'main.py'), 'print(1)\n')
  const imported = await call('POST', `${ROUTE_PREFIX}/api/import`, { path: sourceRoot })
  assert.equal(imported.status, 200, imported.body.slice(0, 200))
  // store.write 注入故障 → 真实 500 → http.error（/api/action 的 submit 抛错
  // 是设计内的 409「无法投递」，不是故障）。
  submitBoom = false
  const graph = { format: 'codeflow/1', rev: 0, project: { name: 'log-e2e', language: 'python', origin: 'import' }, nodes: [], links: [], meta: {} }
  const realWrite = store.write.bind(store)
  store.write = async () => { throw new Error('boom 500 on purpose') }
  const failed = await call('POST', `${ROUTE_PREFIX}/api/state`, { graph, view: 'tasks' })
  store.write = realWrite
  assert.equal(failed.status, 500, `store.write 抛错应 500：${failed.status}`)
  await fileLogger.flush()
  let lines = await readJsonl(logFile)
  const events = lines.map((l) => l.event)
  assert.ok(events.includes('import.start'), 'import.start 已记录')
  assert.ok(events.includes('import.root'), 'import.root 已记录')
  const rootLine = lines.find((l) => l.event === 'import.root')
  assert.equal(rootLine.data.ambiguous, false)
  assert.ok(events.includes('import.done'), 'import.done 已记录')
  assert.ok(events.includes('coupling.start') && events.includes('coupling.done'), 'coupling.start/done 已记录')
  const errLine = lines.filter((l) => l.event === 'http.error')
  assert.ok(errLine.length >= 1, 'http.error 已记录')
  assert.equal(errLine[0].data.status, 500)
  assert.ok(errLine[0].err && errLine[0].err.message.includes('boom'), 'http.error 带 err.message')
  assert.ok(errLine[0].data.path.endsWith('/api/state'))
  // 日志里不应有图 JSON / 提示词形状的内容
  const rawLog = await readFile(logFile, 'utf8')
  assert.ok(!rawLog.includes('"nodes"'), '图 JSON 不落盘')
  assert.ok(!rawLog.includes('print(1)'), '源码内容不落盘')

  // /api/log：合法 / 非法事件 / 超批 / 跨站 / 洪水。
  const good = await call('POST', `${ROUTE_PREFIX}/api/log`, { events: [{ event: 'ui.action', data: { control: '#cf-tb-save', surface: 'toolbar', outcome: 'ok' } }] })
  assert.equal(good.status, 200)
  assert.deepEqual(good.json, { ok: true }, '成功只回 {ok:true}，不回显内容')
  const bad = await call('POST', `${ROUTE_PREFIX}/api/log`, { events: [{ event: 'plugin.start' }] })
  assert.equal(bad.status, 400, '白名单外事件 → 400')
  const malformed = await call('POST', `${ROUTE_PREFIX}/api/log`, { nope: true })
  assert.equal(malformed.status, 400)
  const oversize = await call('POST', `${ROUTE_PREFIX}/api/log`, { events: [{ event: 'ui.error', data: { message: 'x'.repeat(70 * 1024) } }] })
  assert.equal(oversize.status, 413, '超 64KiB → 413')
  const crossSite = await call('POST', `${ROUTE_PREFIX}/api/log`, { events: [{ event: 'ui.action' }] }, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })
  assert.equal(crossSite.status, 403, '跨站 → 403')
  // 洪水：50/秒上限——先冲满，再期待 429。
  let got429 = false
  for (let round = 0; round < 6; round += 1) {
    const res = await call('POST', `${ROUTE_PREFIX}/api/log`, { events: Array.from({ length: 20 }, () => ({ event: 'ui.action', data: { control: 'flood' } })) })
    if (res.status === 429) { got429 = true; break }
    assert.equal(res.status, 200)
  }
  assert.ok(got429, '超过 50 条/秒 → 429')
  // /api/log 自身不产生 http.request 日志。
  await fileLogger.flush()
  lines = await readJsonl(logFile)
  assert.ok(!lines.some((l) => l.event === 'http.request' && String(l.data?.path ?? '').endsWith('/api/log')), '/api/log 不记 http.request')
  assert.ok(lines.some((l) => l.event === 'ui.action' && l.data.control === '#cf-tb-save'), '上报的 ui.action 落盘（已脱敏）')
  await fileLogger.close()
  await rm(workspace, { recursive: true, force: true }).catch(() => {})
  ok('HTTP e2e：import.*/http.error/限流/白名单/跨站/自排除全部符合契约')
}

/* ------------------------------------------------- 11. 仓库根无日志 ------ */
{
  const probe = await stat(rootLogPath).then((i) => i.isFile(), () => false)
  if (!probe) {
    ok('仓库根没有 codeflow.log（测试默认关闭；DSH 未在运行）')
  } else {
    // 插件以 Junction 安装在仓库根：正在运行的 DSH 会写生产日志——那是特性，
    // 不是污染。断言收紧为「本测试进程没有写过它」（按 pid 判定）。
    const text = await readFile(rootLogPath, 'utf8').catch(() => '')
    const writtenByThisProcess = new RegExp(`"pid":${process.pid}\\b`).test(text)
    assert.equal(writtenByThisProcess, false, '本测试进程不得写仓库根 codeflow.log')
    ok('仓库根 codeflow.log 为运行中的 DSH 插件所写（本测试进程零写入）')
  }
}

async function mkdir2(dir) {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(dir, { recursive: true })
}

await rm(tmp, { recursive: true, force: true }).catch(() => {})
console.log(`\n[summary] logging: ${passed} checks passed`)
