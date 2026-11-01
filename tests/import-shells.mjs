/**
 * 空壳目录/压缩包导入矩阵（v1.2.2，需求二）——任务书 §7.5 的 25 个夹具。
 *
 * 三条通道都打到真实 HTTP handler（fake req/res，与 validate.mjs 同法）：
 *
 *   - 压缩包   → POST /api/drop/finalize（token 暂存 + 上传）；
 *   - 上传目录 → POST /api/drop/begin + /file + /finalize（逐文件）；
 *   - 路径目录 → POST /api/drop/path（kind:'dir'）与 POST /api/import（对话框）。
 *
 * 硬门槛（产品决策，写进断言消息）：
 *   - #5/#6/#22/#24/#25：`proj/src` 必须保留 `proj`，绝不无信号下钻到 `src`；
 *   - #19/#20：多个内容子目录不误判为单链外壳（保留根 + multiProject）；
 *   - #23：强直接文件阻止 findMarkerRoot 跨层下钻；
 *   - 空壳 400；单链无标记外壳 400 SHELL_AMBIGUOUS；不留 imports 半成品；
 *     路径源目录绝不删除。
 *
 * Run: ELECTRON_RUN_AS_NODE=1 <electron> tests/import-shells.mjs
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deflateRawSync } from 'node:zlib'

const pluginRoot = fileURLToPath(new URL('..', import.meta.url))
const load = (rel) => import(pathToFileURL(path.join(pluginRoot, rel)).href)

const { createRouter } = await load('lib/routes.js')
const { createStore } = await load('lib/store.js')
const { extractArchive } = await load('lib/archive.js')
const { detectProjectRoot, isShellName, isWeakFileName, isProjectMarkerName } = await load('lib/import/root-detect.js')

let passed = 0
const ok = (name) => { passed += 1; console.log('  ok ', name) }

/* ------------------------------------------------------------ zip 构造器 --- */
/* 与 tests/drop-import.mjs 相同的纯 Node zip 写手（零 npm 依赖；不提交二进制）。 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function buildZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const method = entry.method ?? 0
    const data = entry.data
    const compressed = method === 8 ? deflateRawSync(data) : data
    const flags = entry.flags ?? 0x800 /* UTF-8 */
    const attrs = entry.externalAttrs ?? 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x5821, 12)
    local.writeUInt32LE(crc32(data), 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBuf, compressed)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc32(data), 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(attrs, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + compressed.length
  }
  const centralBody = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBody.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBody, eocd])
}

/* ------------------------------------------------------------- HTTP 装配 --- */

const workspaces = []

/** 每个夹具一个独立工作区 + 路由 handler（项目名互不污染）。 */
async function makeHarness() {
  const workspace = await mkdtemp(path.join(tmpdir(), 'codeflow-shells-'))
  workspaces.push(workspace)
  const store = createStore(console)
  const handler = createRouter({
    store,
    logger: console,
    resolveCwd: async () => workspace,
    ensureSession: async () => ({ sessionId: 'sess-shells', created: false }),
  })
  const call = async (method, url, body, raw) => {
    const chunks = raw !== undefined ? [raw] : (body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')])
    const req = Object.assign(Readable.from(chunks), { method, url, headers: { host: '127.0.0.1:19387' } })
    const res = {
      statusCode: 0, headers: {}, body: '',
      writeHead(status, headers) { this.statusCode = status; this.headers = headers ?? {} },
      end(chunk) { if (chunk !== undefined) this.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk) },
    }
    await handler(req, res)
    let json = null
    try { json = JSON.parse(res.body) } catch { /* 非 JSON 响应 */ }
    return { status: res.statusCode, json, body: res.body }
  }
  const importsRoot = path.join(workspace, 'CodeFlow', 'imports')
  return { workspace, store, call, importsRoot }
}

/** 上传通道：begin → 逐文件 → 返回 token。 */
async function uploadDir(harness, entries) {
  const begin = await harness.call('POST', '/codeflow/api/drop/begin', {
    kind: 'dir', name: 'drop-dir', files: entries.length, bytes: entries.reduce((sum, e) => sum + e.data.length, 0),
  })
  assert.equal(begin.status, 200, `drop/begin failed: ${begin.body}`)
  for (const entry of entries) {
    const res = await harness.call('POST', `/codeflow/api/drop/file?token=${encodeURIComponent(begin.json.token)}&path=${encodeURIComponent(entry.name)}`, undefined, entry.data)
    assert.equal(res.status, 200, `drop/file ${entry.name} failed: ${res.body}`)
  }
  return begin.json.token
}

/** 上传压缩包：begin → zip 字节 → 返回 token。 */
async function uploadArchive(harness, name, buffer) {
  const begin = await harness.call('POST', '/codeflow/api/drop/begin', {
    kind: 'archive', name, files: 1, bytes: buffer.length,
  })
  assert.equal(begin.status, 200, `drop/begin failed: ${begin.body}`)
  const res = await harness.call('POST', `/codeflow/api/drop/file?token=${encodeURIComponent(begin.json.token)}&path=${encodeURIComponent(name)}`, undefined, buffer)
  assert.equal(res.status, 200, `drop/file failed: ${res.body}`)
  return begin.json.token
}

/** 通道适配：archiveZip / dirUpload / pathDir / dialogImport。 */
const channels = {
  archiveZip: async (harness, fixture, name) => {
    const zip = buildZip(fixture.zipEntries())
    const token = await uploadArchive(harness, name, zip)
    return harness.call('POST', '/codeflow/api/drop/finalize', { token, kind: 'archive', depth: 6 })
  },
  dirUpload: async (harness, fixture) => {
    const token = await uploadDir(harness, fixture.files())
    return harness.call('POST', '/codeflow/api/drop/finalize', { token, kind: 'dir', depth: 6 })
  },
  pathDir: async (harness, fixture, rootAbs) =>
    harness.call('POST', '/codeflow/api/drop/path', { path: rootAbs, kind: 'dir', depth: 6 }),
  dialogImport: async (harness, fixture, rootAbs) =>
    harness.call('POST', '/codeflow/api/import', { path: rootAbs, depth: 6 }),
}

/* ------------------------------------------------------------ 夹具工厂 --- */

const PY = Buffer.from('print("hello")\n', 'utf8')
const JS = Buffer.from('module.exports = 1\n', 'utf8')
const PKG = Buffer.from('{"name":"x","version":"1.0.0"}\n', 'utf8')
const PYPROJECT = Buffer.from('[project]\nname = "x"\n', 'utf8')
const README = Buffer.from('# readme\n', 'utf8')

/** 在 dirRoot 下按 `<rel>` 建文件（自动建父目录）。 */
async function put(dirRoot, rel, data) {
  const target = path.join(dirRoot, rel)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, data)
  return target
}

const fixtures = {
  /* #1 outer/project/src/main.py + project/package.json */
  1: {
    name: 'outer', expectRoot: 'project',
    async build(base) {
      await put(base, 'outer/project/src/main.py', PY)
      await put(base, 'outer/project/package.json', PKG)
    },
    zipEntries: () => [
      { name: 'outer/project/src/main.py', data: PY },
      { name: 'outer/project/package.json', data: PKG },
    ],
    files: (base) => [
      { name: 'outer/project/src/main.py', data: PY },
      { name: 'outer/project/package.json', data: PKG },
    ],
  },
  /* #2 a/b/c/project/… + pyproject.toml */
  2: {
    name: 'a', expectRoot: 'project', minUnwrap: 3,
    async build(base) {
      await put(base, 'a/b/c/project/src/main.py', PY)
      await put(base, 'a/b/c/project/pyproject.toml', PYPROJECT)
    },
    zipEntries: () => [
      { name: 'a/b/c/project/src/main.py', data: PY },
      { name: 'a/b/c/project/pyproject.toml', data: PYPROJECT },
    ],
    files: () => [
      { name: 'a/b/c/project/src/main.py', data: PY },
      { name: 'a/b/c/project/pyproject.toml', data: PYPROJECT },
    ],
  },
  /* #3 shell/a/b/ 只有空目录 */
  3: {
    name: 'shell', expectFail: true, empty: true,
    async build(base) {
      await mkdir(path.join(base, 'shell/a/b'), { recursive: true })
    },
    zipEntries: () => [{ name: 'shell/a/b/', data: Buffer.alloc(0) }],
    files: () => [],
  },
  /* #4 proj（带 package.json + 空壳兄弟目录） */
  4: {
    name: 'proj4', expectRoot: 'proj4', zipRootsAt: 'proj4',
    async build(base) {
      await put(base, 'proj4/src/main.py', PY)
      await put(base, 'proj4/package.json', PKG)
      await mkdir(path.join(base, 'proj4/empty1/empty2'), { recursive: true })
    },
    zipEntries: () => [
      { name: 'proj4/src/main.py', data: PY },
      { name: 'proj4/package.json', data: PKG },
      { name: 'proj4/empty1/empty2/', data: Buffer.alloc(0) },
    ],
    files: () => [
      { name: 'proj4/src/main.py', data: PY },
      { name: 'proj4/package.json', data: PKG },
    ],
  },
  /* #5 proj/src/main.py（无标记、proj 下无文件）——关键回归：保留 proj */
  5: {
    name: 'proj5', expectRoot: 'proj5', zipRootsAt: 'proj5', select: 'proj5',
    async build(base) { await put(base, 'proj5/src/main.py', PY) },
    zipEntries: () => [{ name: 'proj5/src/main.py', data: PY }],
    files: () => [{ name: 'proj5/src/main.py', data: PY }],
  },
  /* #6 路径选中 proj（无标记）——同 #5 的路径通道 */
  6: {
    name: 'proj6', expectRoot: 'proj6', pathOnly: true, zipRootsAt: 'proj6', select: 'proj6',
    async build(base) { await put(base, 'proj6/src/main.py', PY) },
  },
  /* #7 路径选中 outer（唯一内容子目录带标记） */
  7: {
    name: 'outer7', expectRoot: 'proj7', pathOnly: true, select: 'outer7',
    async build(base) {
      await put(base, 'outer7/proj7/package.json', PKG)
      await put(base, 'outer7/proj7/src/main.py', PY)
    },
  },
  /* #8 路径选中 outer（唯一内容子目录无标记）→ 400 SHELL_AMBIGUOUS */
  8: {
    name: 'outer8', expectFail: true, failCode: 'SHELL_AMBIGUOUS', pathOnly: true, select: 'outer8',
    async build(base) { await put(base, 'outer8/proj8/src/main.py', PY) },
  },
  /* #9 压缩包 outer/proj/src（无标记）→ 400 + 清理 imports */
  9: {
    name: 'outer9', expectFail: true, failCode: 'SHELL_AMBIGUOUS',
    async build(base) { await put(base, 'outer9/proj9/src/main.py', PY) },
    zipEntries: () => [{ name: 'outer9/proj9/src/main.py', data: PY }],
  },
  /* #10 外壳名 + 标记 */
  10: {
    name: 'outer10', expectRoot: 'proj10',
    async build(base) {
      await put(base, 'outer10/新建文件夹/proj10/package.json', PKG)
      await put(base, 'outer10/新建文件夹/proj10/src/main.py', PY)
    },
    zipEntries: () => [
      { name: 'outer10/新建文件夹/proj10/package.json', data: PKG },
      { name: 'outer10/新建文件夹/proj10/src/main.py', data: PY },
    ],
    files: () => [
      { name: 'outer10/新建文件夹/proj10/package.json', data: PKG },
      { name: 'outer10/新建文件夹/proj10/src/main.py', data: PY },
    ],
  },
  /* #11 .DS_Store 不算内容 */
  11: {
    name: 'outer11', expectRoot: 'proj11', zipRootsAt: 'outer11',
    async build(base) {
      await put(base, 'outer11/.DS_Store', Buffer.from('junk'))
      await put(base, 'outer11/proj11/package.json', PKG)
      await put(base, 'outer11/proj11/src/main.py', PY)
    },
    zipEntries: () => [
      { name: 'outer11/.DS_Store', data: Buffer.from('junk') },
      { name: 'outer11/proj11/package.json', data: PKG },
      { name: 'outer11/proj11/src/main.py', data: PY },
    ],
  },
  /* #12 只有 .DS_Store 的目录 */
  12: {
    name: 'dsonly', expectFail: true, empty: true,
    async build(base) { await put(base, 'dsonly/.DS_Store', Buffer.from('junk')) },
    zipEntries: () => [{ name: 'dsonly/.DS_Store', data: Buffer.from('junk') }],
  },
  /* #13 中文/空格/NFD */
  13: {
    name: 'shell13', expectRoot: '项目 甲', zipRootsAt: '项目 甲',
    async build(base) {
      await put(base, `shell13/${'项目 甲'}/外包/源码/main.py`, PY)
      await put(base, `shell13/${'项目 甲'}/package.json`, PKG)
    },
    zipEntries: () => [
      { name: 'shell13/项目 甲/外包/源码/main.py', data: PY },
      { name: 'shell13/项目 甲/package.json', data: PKG },
    ],
  },
  /* #14 同名项目已存在 → -2 */
  14: {
    name: 'proj14', expectRoot: 'proj14', zipRootsAt: 'proj14', rename: true,
    async build(base) {
      await put(base, 'proj14/src/main.py', PY)
      await put(base, 'proj14/package.json', PKG)
    },
    zipEntries: () => [
      { name: 'proj14/src/main.py', data: PY },
      { name: 'proj14/package.json', data: PKG },
    ],
  },
  /* #15 超过 maxUnwrap 的 20 层壳，标记在更深处 → 停在上限并 400 */
  15: {
    name: 'deep15', expectFail: true, failCode: 'SHELL_AMBIGUOUS',
    async build(base) {
      let rel = 'deep15'
      for (let i = 1; i <= 20; i += 1) rel += `/level${i}`
      await put(path.join(base, rel, 'proj15'), 'package.json', PKG)
    },
    zipEntries() {
      const entries = []
      let rel = 'deep15'
      for (let i = 1; i <= 20; i += 1) {
        rel += `/level${i}`
        entries.push({ name: `${rel}/.keep`, data: Buffer.from('x') })
      }
      entries.push({ name: `${rel}/proj15/package.json`, data: PKG })
      return entries
    },
  },
  /* #16 zip 内符号链接条目：不跟随、不越界 */
  16: {
    name: 'proj16', expectRoot: 'proj16', zipRootsAt: 'proj16',
    async build(base) {
      await put(base, 'proj16/src/main.py', PY)
      await put(base, 'proj16/package.json', PKG)
    },
    zipEntries: () => [
      { name: 'proj16/src/main.py', data: PY },
      { name: 'proj16/package.json', data: PKG },
      /* symlink 条目：unix mode 0xa000 → 解压层必须跳过（绝不物化） */
      { name: 'proj16/evil', data: Buffer.from('../../../evil.txt'), externalAttrs: ((0xa000 << 16) >>> 0) },
    ],
  },
  /* #17 根下只有一个目录，目录内只有 .DS_Store */
  17: {
    name: 'dsinner', expectFail: true, empty: true,
    async build(base) { await put(base, 'dsinner/inner/.DS_Store', Buffer.from('junk')) },
    zipEntries: () => [{ name: 'dsinner/inner/.DS_Store', data: Buffer.from('junk') }],
  },
  /* #18 正常单根（与既有 stripSingleRoot 行为一致） */
  18: {
    name: 'proj18', expectRoot: 'proj18', zipRootsAt: 'proj18',
    async build(base) { await put(base, 'proj18/main.py', PY) },
    zipEntries: () => [{ name: 'proj18/main.py', data: PY }],
  },
  /* #19 根下 src/ + docs/（根无文件）→ 保留根 */
  19: {
    name: 'proj19', expectRoot: 'proj19', zipRootsAt: 'proj19', select: 'proj19', multiProject: true,
    async build(base) {
      await put(base, 'proj19/src/main.py', PY)
      await put(base, 'proj19/docs/readme.md', README)
    },
    zipEntries: () => [
      { name: 'proj19/src/main.py', data: PY },
      { name: 'proj19/docs/readme.md', data: README },
    ],
  },
  /* #20 路径选中多项目父目录 → 保留 parent + multiProject:true，不 400 */
  20: {
    name: 'parent20', expectRoot: 'parent20', pathOnly: true, select: 'parent20', multiProject: true,
    async build(base) {
      await put(base, 'parent20/p1/src/a.py', PY)
      await put(base, 'parent20/p2/src/b.py', JS)
    },
  },
  /* #21 外层 README（弱文件）不阻止去壳 */
  21: {
    name: 'outer21', expectRoot: 'proj21',
    async build(base) {
      await put(base, 'outer21/README.md', README)
      await put(base, 'outer21/proj21/package.json', PKG)
      await put(base, 'outer21/proj21/src/main.py', PY)
    },
    zipEntries: () => [
      { name: 'outer21/README.md', data: README },
      { name: 'outer21/proj21/package.json', data: PKG },
      { name: 'outer21/proj21/src/main.py', data: PY },
    ],
  },
  /* #22 proj 只有 README + src（无强标记）→ 保留 proj */
  22: {
    name: 'proj22', expectRoot: 'proj22', zipRootsAt: 'proj22', select: 'proj22',
    async build(base) {
      await put(base, 'proj22/README.md', README)
      await put(base, 'proj22/src/main.py', PY)
    },
    zipEntries: () => [
      { name: 'proj22/README.md', data: README },
      { name: 'proj22/src/main.py', data: PY },
    ],
  },
  /* #23 外层强直接文件阻止跨层下钻 → 根 outer */
  23: {
    name: 'outer23', expectRoot: 'outer23', select: 'outer23',
    async build(base) {
      await put(base, 'outer23/main.py', PY)
      await put(base, 'outer23/proj23/package.json', PKG)
      await put(base, 'outer23/proj23/src/main.py', PY)
    },
    zipEntries: () => [
      { name: 'outer23/main.py', data: PY },
      { name: 'outer23/proj23/package.json', data: PKG },
      { name: 'outer23/proj23/src/main.py', data: PY },
    ],
  },
  /* #24 压缩包根下直接 README + src → 根保持解压目录（不剥到 src） */
  24: {
    name: 'flat24', expectRoot: 'flat24', zipRootsAt: 'flat24', select: 'flat24',
    async build(base) {
      await put(base, 'flat24/README.md', README)
      await put(base, 'flat24/src/main.py', PY)
    },
    zipEntries: () => [
      { name: 'flat24/README.md', data: README },
      { name: 'flat24/src/main.py', data: PY },
    ],
  },
  /* #25 中文源码目录（SOURCE_DIRS）不下钻 */
  25: {
    name: 'proj25', expectRoot: 'proj25', zipRootsAt: 'proj25', select: 'proj25',
    async build(base) {
      await put(base, 'proj25/源码/main.py', PY)
      await put(base, 'proj25/readme.txt', Buffer.from('notes\n'))
    },
    zipEntries: () => [{ name: 'proj25/源码/main.py', data: PY }],
  },
}

/* ------------------------------------------------------------ 断言助手 --- */

async function assertSuccess(label, res, { expectRoot, sourceDir, minUnwrap, multiProject }) {
  const body = res.json ?? {}
  assert.equal(res.status, 200, `${label}: expected 200, got ${res.status} ${res.body.slice(0, 300)}`)
  assert.equal(body.ok, true, `${label}: ok !== true`)
  // scan.params.path 指向真实根（/api/import 响应没有 sourceRoot 字段，
  // 两条通道都以 scan.params.path 为根的权威来源）。
  const scan = (body.graph?.nodes ?? []).find((n) => n.type === 'scan')
  assert.ok(scan, `${label}: 任务图缺 scan 节点`)
  const resolvedRoot = String(body.sourceRoot ?? scan.params?.path ?? '')
  assert.ok(resolvedRoot.endsWith(expectRoot), `${label}: 解析根 ${resolvedRoot} 不以 ${expectRoot} 结尾`)
  if (body.sourceRoot !== undefined) {
    assert.equal(scan.params?.path, body.sourceRoot, `${label}: scan.params.path 不等于真实根`)
  }
  if (minUnwrap !== undefined) {
    assert.ok((body.unwrappedDepth ?? 0) >= minUnwrap, `${label}: unwrappedDepth ${body.unwrappedDepth} < ${minUnwrap}`)
  }
  if (multiProject) assert.equal(body.multiProject, true, `${label}: multiProject 未上报`)
  else assert.notEqual(body.multiProject, true, `${label}: 不该报 multiProject`)
  // 双图 importedFrom 一致且指向真实根（duo 只解析一次根）
  const tasksFrom = body.graph?.meta?.importedFrom
  assert.ok(String(tasksFrom ?? '').endsWith(expectRoot), `${label}: tasks meta.importedFrom=${tasksFrom} 错`)
  if (body.modulesAvailable) {
    const mods = await modState(body.project)
    const modulesFrom = mods?.graph?.meta?.importedFrom
    assert.equal(modulesFrom, tasksFrom, `${label}: 两图 importedFrom 不一致`)
    const moduleNodes = (mods?.graph?.nodes ?? []).filter((n) => n.type === 'module')
    assert.ok(moduleNodes.length >= 1, `${label}: 模块图没有任何 module 节点`)
    for (const node of moduleNodes) {
      const rel = String(node.params?.path ?? '')
      assert.ok(!rel.startsWith('outer') && !rel.includes('empty1') && !rel.includes('empty2'),
        `${label}: 模块相对路径越界：${rel}`)
    }
  }
  return body
  async function modState(project) {
    const r = await harnessCurrent.call('GET', `/codeflow/api/state?project=${encodeURIComponent(project)}&view=modules`)
    return r.json
  }
}

/** 当前 harness（assertSuccess 里访问 GET state 用）——由 runCase 设置。 */
let harnessCurrent = null

async function assertFailure(label, res, { failCode, expectEmptyImports, importsRoot, pkgName, sourceDir }) {
  const body = res.json ?? {}
  assert.equal(res.status, 400, `${label}: expected 400, got ${res.status} ${res.body.slice(0, 300)}`)
  assert.equal(body.ok, false)
  if (failCode) assert.equal(body.code, failCode, `${label}: code=${body.code} 错误=${body.error}`)
  assert.ok(String(body.error ?? '').length > 8, `${label}: 错误消息为空`)
  if (expectEmptyImports) {
    const exists = await stat(path.join(importsRoot, pkgName)).then(() => true, () => false)
    assert.equal(exists, false, `${label}: imports/${pkgName} 半成品未被清理`)
  }
  if (sourceDir) {
    const kept = await stat(sourceDir).then(() => true, () => false)
    assert.equal(kept, true, `${label}: 用户源目录被删除！`)
  }
}

/* ------------------------------------------------------------- 用例执行 --- */

/** 每个夹具 × 通道：新 harness（项目名/imports 互不污染）。 */
async function runCase(num, fixture, channelName) {
  const label = `#${num} ${fixture.name} × ${channelName}`
  const harness = await makeHarness()
  harnessCurrent = harness
  try {
    const sourceBase = path.join(harness.workspace, 'source')
    await mkdir(sourceBase, { recursive: true })
    await fixture.build(sourceBase)
    const pkgName = fixture.expectRoot ?? fixture.name

    if (channelName === 'archiveZip') {
      if (fixture.pathOnly) return // 该夹具只声明了路径通道
      const res = await channels.archiveZip(harness, fixture, `${fixture.name}.zip`)
      if (fixture.expectFail) {
        await assertFailure(label, res, {
          failCode: fixture.failCode, expectEmptyImports: fixture.empty !== true || fixture.failCode === 'SHELL_AMBIGUOUS',
          importsRoot: harness.importsRoot, pkgName,
        })
      } else {
        await assertSuccess(label, res, { expectRoot: fixture.expectRoot, minUnwrap: fixture.minUnwrap, multiProject: fixture.multiProject })
      }
      return
    }
    if (channelName === 'dirUpload') {
      if (fixture.pathOnly) return
      if (!fixture.files) return // 夹具未声明上传目录形态
      const res = await channels.dirUpload(harness, fixture)
      if (fixture.expectFail) {
        await assertFailure(label, res, { failCode: fixture.failCode, importsRoot: harness.importsRoot, pkgName })
      } else {
        await assertSuccess(label, res, { expectRoot: fixture.expectRoot, multiProject: fixture.multiProject })
      }
      return
    }
    // 路径通道（drop/path 与 /api/import）：选中目录 = sourceBase 或其子目录
    const selected = fixture.select ? path.join(sourceBase, fixture.select) : sourceBase
    for (const [chan, fn] of [['drop/path', channels.pathDir], ['/api/import', channels.dialogImport]]) {
      const res = await fn(harness, fixture, selected)
      if (fixture.expectFail) {
        await assertFailure(`${label} × ${chan}`, res, {
          failCode: fixture.failCode ?? (fixture.empty ? 'EMPTY_SHELL' : undefined),
          sourceDir: selected,
        })
      } else {
        await assertSuccess(`${label} × ${chan}`, res, { expectRoot: fixture.expectRoot, multiProject: fixture.multiProject })
      }
    }
  } finally {
    harnessCurrent = null
  }
}

/* ----------------------------------------------------------- 1. 纯单元 --- */

console.log('[root-detect 单元]')
{
  assert.equal(isShellName('新建文件夹 (2)'), true)
  assert.equal(isShellName('项目'), true)
  assert.equal(isShellName('项目 甲'), false, '「项目 甲」不是外壳名')
  assert.equal(isShellName('proj-main'), true)
  assert.equal(isShellName('src'), false)
  assert.equal(isWeakFileName('README.md'), true)
  assert.equal(isWeakFileName('main.py'), false)
  assert.equal(isProjectMarkerName('.git'), true)
  assert.equal(isProjectMarkerName('README.md'), false)
  ok('词汇表：SHELL_NAMES / 弱文件 / 项目标记的判定形状')
}
{
  const base = await mkdtemp(path.join(tmpdir(), 'codeflow-shells-unit-'))
  await put(base, 'proj/src/main.py', PY)
  const r = await detectProjectRoot(path.join(base, 'proj'), { mode: 'path' })
  assert.equal(r.root, path.join(base, 'proj'), 'proj/src 必须保留 proj（单元级）')
  assert.equal(r.reason, 'source-dir-child')
  const r2 = await detectProjectRoot(base, { mode: 'path' })
  assert.equal(r2.multiProject, false)
  await rm(base, { recursive: true, force: true })
  ok('detectProjectRoot：proj/src 保留 proj（mode:path）')
}
{
  const base = await mkdtemp(path.join(tmpdir(), 'codeflow-shells-unit-'))
  await mkdir(path.join(base, 'empty/a/b'), { recursive: true })
  const r = await detectProjectRoot(path.join(base, 'empty'), { mode: 'path' })
  assert.equal(r.hasContent, false)
  ok('detectProjectRoot：纯空目录 hasContent:false')
}

/* ------------------------------------------------- 2. 25 项矩阵 × 通道 --- */

console.log('\n[夹具矩阵]')
const CHANNELS_PER_FIXTURE = {
  1: ['archiveZip', 'dirUpload', 'path'], 2: ['archiveZip', 'path'], 3: ['archiveZip', 'dirUpload', 'path'],
  4: ['archiveZip'], 5: ['archiveZip', 'dirUpload', 'path'], 6: ['path'], 7: ['path'], 8: ['path'],
  9: ['archiveZip'], 10: ['archiveZip', 'dirUpload', 'path'], 11: ['archiveZip'], 12: ['archiveZip', 'dirUpload', 'path'],
  13: ['archiveZip', 'path'], 14: ['archiveZip', 'dirUpload'], 15: ['archiveZip'], 16: ['archiveZip'],
  17: ['archiveZip', 'path'], 18: ['archiveZip'], 19: ['archiveZip', 'dirUpload', 'path'], 20: ['path'],
  21: ['archiveZip', 'dirUpload', 'path'], 22: ['archiveZip', 'dirUpload', 'path'], 23: ['archiveZip', 'dirUpload', 'path'],
  24: ['archiveZip', 'dirUpload', 'path'], 25: ['archiveZip', 'dirUpload', 'path'],
}
let ran = 0
for (const [numText, channelList] of Object.entries(CHANNELS_PER_FIXTURE)) {
  const num = Number(numText)
  const fixture = fixtures[num]
  for (const channel of channelList) {
    await runCase(num, fixture, channel)
    ran += 1
  }
}
ok(`${ran} 个「夹具 × 通道」组合全部通过`)

/* ------------------------------------------------- 3. 专项补充断言 ------- */

console.log('\n[专项补充]')
{
  /* #14 同名项目：第一次导入后再次导入同名 → -2 后缀，不覆盖旧项目 */
  const harness = await makeHarness()
  const sourceBase = path.join(harness.workspace, 'source')
  await fixtures[14].build(sourceBase)
  const zip = buildZip(fixtures[14].zipEntries())
  const first = await channels.archiveZip(harness, fixtures[14], 'proj14.zip')
  assert.equal(first.status, 200)
  assert.equal(first.json.project, 'proj14')
  const token = await uploadArchive(harness, 'proj14.zip', zip)
  const conflict = await harness.call('POST', '/codeflow/api/drop/finalize', { token, kind: 'archive', depth: 6 })
  assert.equal(conflict.status, 409, '同名项目默认 409 conflict（客户端弹 覆盖/改名/取消）')
  assert.equal(conflict.json.code, 'conflict')
  const token2 = await uploadArchive(harness, 'proj14.zip', zip)
  const second = await harness.call('POST', '/codeflow/api/drop/finalize', { token: token2, kind: 'archive', depth: 6, rename: true })
  assert.equal(second.status, 200)
  assert.equal(second.json.project, 'proj14-2', '同名项目应改名 -2，不覆盖')
  ok('#14 同名项目 409 → rename → -2 后缀（不覆盖旧项目）')
}
{
  /* .git 之外没有强文件的真项目（.git 即标记）也停在对的根 */
  const harness = await makeHarness()
  const sourceBase = path.join(harness.workspace, 'source')
  await mkdir(path.join(sourceBase, 'projgit/.git'), { recursive: true })
  await put(sourceBase, 'projgit/src/main.py', PY)
  const res = await harness.call('POST', '/codeflow/api/import', { path: sourceBase, depth: 6 })
  assert.equal(res.status, 200, res.body.slice(0, 200))
  const scanNode = (res.json.graph?.nodes ?? []).find((n) => n.type === 'scan')
  assert.ok(String(scanNode?.params?.path ?? '').endsWith('projgit'), `根应保留 projgit：${scanNode?.params?.path}`)
  ok('补例：.git 目录作为项目标记阻止去壳')
}
{
  /* 深度上限：maxUnwrap 内可达的多层壳 + 深处标记（8 层）仍能找到 */
  const base = await mkdtemp(path.join(tmpdir(), 'codeflow-shells-unwrap-'))
  let rel = ''
  for (let i = 1; i <= 7; i += 1) rel += `/l${i}`
  await put(path.join(base, rel, 'real'), 'package.json', PKG)
  await put(path.join(base, rel, 'real'), 'src/main.py', PY)
  const r = await detectProjectRoot(base, { mode: 'archive' })
  assert.ok(r.root.endsWith('real'), `8 层内应找到标记：${r.root}`)
  assert.ok(r.unwrappedDepth >= 8, `unwrappedDepth=${r.unwrappedDepth}`)
  await rm(base, { recursive: true, force: true })
  ok('补例：maxUnwrap 内的多层壳 + 深处标记可达')
}

/* ------------------------------------------------------------- 清理 ----- */

for (const ws of workspaces) await rm(ws, { recursive: true, force: true }).catch(() => {})

console.log(`\n[summary] import-shells: ${passed} checks passed`)
