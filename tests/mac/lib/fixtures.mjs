/**
 * 测试夹具：一棵"Mac 形状"的源码树，以及纯 Node 的 zip / tar 构造器。
 *
 * 夹具刻意包含 macOS 上真实会出现的形状：
 *
 *   - 中文、空格、重音符号（NFC/NFD）文件名；
 *   - Finder / 归档工具会产生的 `.DS_Store`、`__MACOSX/._*`；
 *   - 大写的 `Icon\r`、带 `%`/`#` 的文件名；
 *   - 中文注释里的 TODO（导入的任务流水线依赖它）；
 *   - `node_modules` / `.git` / `.undo` / `dist` 里的诱饵（必须被跳过）。
 *
 * 构造器不依赖系统 `zip` / `tar`：macOS 自带它们，但调用系统工具会让结果
 * 随版本漂移，而这里需要的是"同一份字节，在任何机器上都一样"。
 *
 * @module tests/mac/lib/fixtures
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { deflateRawSync } from 'node:zlib'

/** 夹具里用到的相对路径（断言与报告共用一份事实来源）。 */
export const FIXTURE = Object.freeze({
  readme: 'README.md',
  js: 'src/用户模块.js',
  billing: 'src/billing.js',
  python: 'src/order 处理.py',
  accented: 'src/café-逻辑.js',
  spaced: 'src/带 空格 #与% 的模块.js',
  emoji: 'src/🚀-启动.js',
  test: 'tests/test_用户.py',
  design: 'docs/设计.md',
  binary: 'assets/logo.png',
  decoySkip: 'node_modules/decoy/index.js',
  decoyGit: '.git/config',
  decoyUndo: '.undo/manifest.json',
  decoyDist: 'dist/bundle.js',
  dsStore: '.DS_Store',
})

/** 在 `root` 下写一棵夹具树。返回 root。 */
export async function buildProjectFixture(root) {
  await mkdir(root, { recursive: true })
  const put = async (rel, contents) => {
    const full = path.join(root, rel)
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, contents, 'utf8')
  }

  await put(FIXTURE.readme, [
    '# 示例项目',
    '',
    '一个用于 macOS 诊断的夹具项目。',
    'TODO: 验证中文路径下的导入与撤销。',
    '',
  ].join('\n'))

  await put(FIXTURE.js, [
    '/** 用户模块：处理用户注册与登录。 */',
    '',
    '// TODO: 修复中文用户名在 macOS 上的规范化问题',
    'export function createUser(name) {',
    "  return { name: String(name ?? '').normalize('NFC') }",
    '}',
    '',
    'export const SUMMARY = \'用户模块\'',
    '',
  ].join('\n'))

  await put(FIXTURE.billing, [
    '/** 账单模块：依赖用户模块。 */',
    "import { createUser } from './用户模块.js'",
    '',
    '// FIXME: 金额格式化尚未本地化',
    'export function billFor(name) {',
    '  return createUser(name)',
    '}',
    '',
  ].join('\n'))

  await put(FIXTURE.python, [
    '"""订单处理。',
    '',
    '中文 docstring：TODO 支持多币种。',
    '"""',
    '',
    'def total(items):',
    '    return sum(item.get("price", 0) for item in items)',
    '',
  ].join('\n'))

  await put(FIXTURE.accented, [
    '/** 文件名使用 NFC 组合形式的 café。 */',
    '// TODO: NFD/NFC 文件名映射',
    'export const cafe = () => \'café\'',
    '',
  ].join('\n'))

  await put(FIXTURE.spaced, [
    '/** 文件名含空格、井号与百分号。 */',
    'export const odd = () => 42',
    '',
  ].join('\n'))

  await put(FIXTURE.emoji, [
    '/** 文件名含 emoji。 */',
    'export const launch = () => \'🚀\'',
    '',
  ].join('\n'))

  await put(FIXTURE.test, [
    'import { total } from "../src/order 处理.py"',
    '',
    'def test_total():',
    '    assert total([]) == 0',
    '',
  ].join('\n'))

  await put(FIXTURE.design, [
    '# 设计',
    '',
    '- 用户模块：`src/用户模块.js`',
    '- 账单模块：`src/billing.js`',
    '',
  ].join('\n'))

  // 功能识别默认读 `<root>/docs/design.md`（英文文件名）；也放一份，验证
  // 中文设计文档与英文文件名可以被一起解析。
  await put('docs/design.md', [
    '# 设计文档',
    '',
    '## 用户',
    '- `src/用户模块.js`：注册、登录与用户资料。',
    '',
    '## 订单',
    '- `src/order 处理.py`：订单金额汇总。',
    '',
  ].join('\n'))

  // 二进制（导入应只计数、不读取）。
  await mkdir(path.join(root, 'assets'), { recursive: true })
  await writeFile(path.join(root, FIXTURE.binary), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]))

  // 必须被跳过的诱饵：其中的 TODO 绝不能出现在任务节点里。
  await put(FIXTURE.decoySkip, '// TODO: 依赖目录里的诱饵，绝不能被扫描\nmodule.exports = 1\n')
  await put(FIXTURE.decoyGit, '[core]\n\trepositoryformatversion = 0\n')
  await put(FIXTURE.decoyUndo, '{"decoy":true}\n')
  await put(FIXTURE.decoyDist, '// TODO: 构建产物诱饵\nconsole.log(1)\n')

  // Finder 与归档工具会留下的元数据。
  await put(FIXTURE.dsStore, Buffer.from([0, 0, 0, 1, 0x42, 0x75, 0x64, 0x31]))

  // CRLF + BOM 的源码：注释解析不能因 BOM 或换行符而失效。
  await put('src/附注.py', '\uFEFF# TODO: BOM 与 CRLF\r\nvalue = 1\r\n')

  return root
}

/* ------------------------------------------------------------- zip --- */

/** CRC32 (IEEE) 查表，zip 记录用。 */
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

/**
 * 构造一个 zip。
 *
 * @param entries - `{ name, data, method=0|8, utf8=true, flags, rawName, externalAttrs }`。
 *   `rawName` 允许写入任意字节的名字（GBK 用例）；默认按 UTF-8 写并置 UTF-8 标志。
 * @returns Buffer。
 */
export function buildZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const nameBuf = entry.rawName ?? Buffer.from(entry.name, 'utf8')
    const method = entry.method ?? 0
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ''), 'utf8')
    const compressed = method === 8 ? deflateRawSync(data) : data
    const flags = entry.flags ?? (entry.utf8 === false ? 0 : 0x800)
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
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x5821, 14)
    central.writeUInt32LE(crc32(data), 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
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

/* ------------------------------------------------------------- tar --- */

/**
 * 构造一个 ustar tar。
 *
 * @param entries - `{ name, data?, type?('0'|'5'|'2'), linkname? }`。
 */
export function buildTar(entries) {
  const blocks = []
  for (const entry of entries) {
    const header = Buffer.alloc(512)
    Buffer.from(entry.name, 'utf8').copy(header, 0)
    const type = entry.type ?? '0'
    const data = entry.data === undefined ? undefined : (Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8'))
    const size = data?.length ?? 0
    header.write('0000644', 100, 8, 'ascii')
    header.write('0000000', 108, 8, 'ascii')
    header.write('0000000', 116, 8, 'ascii')
    header.write(size.toString(8).padStart(11, '0') + ' ', 124, 12, 'ascii')
    header.write('00000000000 ', 136, 12, 'ascii')
    header.write('        ', 148, 8, 'ascii')
    header.write(type, 156, 1, 'ascii')
    if (entry.linkname !== undefined) Buffer.from(entry.linkname, 'utf8').copy(header, 157)
    header.write('ustar', 257, 6, 'ascii')
    header.write('00', 263, 2, 'ascii')
    let sum = 0
    for (let i = 0; i < 512; i += 1) sum += header[i]
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
    blocks.push(header)
    if (data !== undefined) {
      blocks.push(data)
      const padding = (512 - (data.length % 512)) % 512
      if (padding > 0) blocks.push(Buffer.alloc(padding))
    }
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

/**
 * 一个"Finder 用归档工具压缩出来的 zip"的形状：
 *
 *   <name>/src/用户模块.js
 *   <name>/.DS_Store
 *   __MACOSX/<name>/src/._用户模块.js
 *
 * `__MACOSX` 里的 `._*` 是 AppleDouble 元数据，内容是二进制，但扩展名可能
 * 是 `.js`——扫描层若不排除它，模块图里就会出现一堆垃圾节点。
 */
export function buildMacFinderZip(name, files) {
  const entries = []
  for (const [rel, contents] of Object.entries(files)) {
    entries.push({ name: `${name}/${rel}`, data: Buffer.from(contents, 'utf8'), method: 8 })
  }
  entries.push({ name: `${name}/.DS_Store`, data: Buffer.from([0, 0, 0, 1, 0x42, 0x75, 0x64, 0x31]) })
  entries.push({
    name: `__MACOSX/${name}/src/._用户模块.js`,
    data: Buffer.from([0x00, 0x05, 0x16, 0x07, 0x00, 0x02, 0x00, 0x00, 0x4d, 0x61, 0x63, 0x20, 0x4f, 0x53, 0x20, 0x58]),
  })
  return buildZip(entries)
}

/** 把 Buffer 写进目录下的一个文件，返回路径。 */
export async function writeFileIn(dir, name, buffer) {
  const full = path.join(dir, name)
  await writeFile(full, buffer)
  return full
}

/**
 * 给 `tree` 里的每个文件加一个确定性的修改时间，避免撤销测试因
 * "同一毫秒内改了大小相同的文件"而无法识别变更。
 */
export async function ageFiles(root, files, seconds) {
  const { utimes } = await import('node:fs/promises')
  const when = new Date(Date.now() - seconds * 1000)
  for (const rel of files) {
    const full = path.join(root, rel)
    await utimes(full, when, when).catch(() => {})
  }
}
