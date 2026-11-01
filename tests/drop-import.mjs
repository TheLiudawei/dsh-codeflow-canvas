/**
 * Drop-import (v1.2) — archive extraction, path safety, caps, staging
 * sessions and conflict semantics. Archives are written by the test itself
 * (pure Node zip/tar writers below); nothing binary is committed.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 <electron> tests/drop-import.mjs
 */
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deflateRawSync, gzipSync } from 'node:zlib'

const pluginRoot = fileURLToPath(new URL('..', import.meta.url))
const module = (rel) => import(pathToFileURL(path.join(pluginRoot, rel)).href)

const {
  ARCHIVE_LIMITS, decodeEntryName, detectKind, extractArchive, extractTarBuffer, extractZipBuffer,
  safeEntryPath, stripArchiveExtension, stripSingleRoot,
} = await module('lib/archive.js')
const { createDropManager, DROP_LIMITS, resolveProjectName } = await module('lib/drop-import.js')

let passed = 0
const ok = (name) => { passed += 1; console.log('  ok ', name) }

const workspace = await mkdtemp(path.join(tmpdir(), 'codeflow-drop-'))
const importsRoot = path.join(workspace, 'CodeFlow', 'imports')
await mkdir(importsRoot, { recursive: true })

/* ------------------------------------------------------------ zip 构造器 --- */

/** CRC32 (IEEE) for zip records. */
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
 * Build a zip archive from entries. `options`: method (0/8), utf8 flag,
 * externalAttrs, rawName (Buffer, for GBK tests), extra padding.
 */
function buildZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const nameBuf = entry.rawName ?? Buffer.from(entry.name, 'utf8')
    const method = entry.method ?? 0
    let data = entry.data
    let compressed = data
    if (method === 8) compressed = deflateRawSync(data)
    const flags = entry.flags ?? (entry.utf8 ? 0x800 : 0)
    const attrs = entry.externalAttrs ?? 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10) // time
    local.writeUInt16LE(0x5821, 12) // date
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
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(attrs, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + compressed.length
  }
  const centralBody = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  const entryCount = entries.length
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 8)
  eocd.writeUInt16LE(0, 10)
  eocd.writeUInt16LE(entryCount, 8 + 0) // placeholder, fixed below
  eocd.writeUInt16LE(entryCount, 10)
  eocd.writeUInt16LE(entryCount, 8) // entries on this disk
  eocd.writeUInt16LE(entryCount, 10) // total entries
  eocd.writeUInt32LE(centralBody.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, centralBody, eocd])
}

/** ustar tar writer: entries [{name, data?, type?('0'|'5')}]. */
function buildTar(entries) {
  const blocks = []
  for (const entry of entries) {
    const header = Buffer.alloc(512)
    const name = Buffer.from(entry.name, 'utf8')
    name.copy(header, 0)
    const type = entry.type ?? '0'
    const size = entry.data?.length ?? 0
    header.write('0000644', 100, 8, 'ascii') // mode
    header.write('0000000', 108, 8, 'ascii') // uid
    header.write('0000000', 116, 8, 'ascii') // gid
    header.write(size.toString(8).padStart(11, '0') + ' ', 124, 12, 'ascii')
    header.write('00000000000 ', 136, 12, 'ascii') // mtime
    header.write('        ', 148, 8, 'ascii') // checksum placeholder
    header.write(type, 156, 1, 'ascii')
    header.write('ustar', 257, 6, 'ascii')
    header.write('00', 263, 2, 'ascii')
    let sum = 0
    for (let i = 0; i < 512; i += 1) sum += header[i]
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
    blocks.push(header)
    if (entry.data !== undefined) {
      blocks.push(entry.data)
      const padding = (512 - (entry.data.length % 512)) % 512
      if (padding > 0) blocks.push(Buffer.alloc(padding))
    }
  }
  blocks.push(Buffer.alloc(1024)) // end marker
  return Buffer.concat(blocks)
}

const writeFixture = async (name, buffer) => {
  const file = path.join(workspace, name)
  await writeFile(file, buffer)
  return file
}

/* ------------------------------------------------------------ 路径安全 --- */
{
  assert.equal(safeEntryPath('src/a.py'), 'src/a.py')
  assert.equal(safeEntryPath('src\\win\\b.txt'), 'src/win/b.txt')
  assert.equal(safeEntryPath('./x/../y.js'), 'y.js', 'posix normalize collapses inner ..')
  assert.equal(safeEntryPath('dir/'), 'dir', 'trailing slash trimmed (directory still resolvable)')
  assert.equal(safeEntryPath('../evil.txt'), undefined, 'parent escape refused')
  assert.equal(safeEntryPath('/absolute.txt'), undefined)
  assert.equal(safeEntryPath('C:\\evil.txt'), undefined)
  assert.equal(safeEntryPath('a\0b'), undefined, 'NUL refused')
  assert.equal(safeEntryPath('a/../../b'), undefined)
  assert.equal(safeEntryPath(`${'x/'.repeat(33)}deep.txt`), undefined, 'depth > 32 refused')
  assert.equal(safeEntryPath(`${'y'.repeat(401)}`), undefined, 'length > 400 refused')
  ok('safeEntryPath: zip-slip, absolute, NUL, depth and length guards')
}
{
  assert.equal(stripArchiveExtension('proj.zip'), 'proj')
  assert.equal(stripArchiveExtension('proj.tar.gz'), 'proj')
  assert.equal(stripArchiveExtension('proj.tgz'), 'proj')
  assert.equal(stripArchiveExtension('proj.7z'), 'proj')
  assert.equal(stripArchiveExtension('plain'), 'plain')
  ok('stripArchiveExtension: all five suffixes')
}

/* ------------------------------------------------------------ ZIP 解压 --- */
{
  const zip = buildZip([
    { name: 'plain.txt', data: Buffer.from('hello zip\n', 'utf8') },
    { name: 'deflated.txt', data: Buffer.from('z'.repeat(5000), 'utf8'), method: 8 },
    { name: 'src/nested.md', data: Buffer.from('# nested\n', 'utf8'), method: 8 },
  ])
  const file = await writeFixture('plain.zip', zip)
  const dest = path.join(workspace, 'out-plain')
  const result = await extractArchive(file, dest)
  assert.equal(result.kind, 'zip')
  assert.equal(result.files, 3)
  assert.equal(await readFile(path.join(dest, 'plain.txt'), 'utf8'), 'hello zip\n')
  assert.equal((await readFile(path.join(dest, 'deflated.txt'), 'utf8')).length, 5000)
  assert.equal(await readFile(path.join(dest, 'src', 'nested.md'), 'utf8'), '# nested\n')
  ok('plain.zip: store + deflate entries extracted byte-exact')
}
{
  const zip = buildZip([
    { name: 'proj/src/main.py', data: Buffer.from('print(1)\n', 'utf8'), method: 8 },
    { name: 'proj/src/util.py', data: Buffer.from('x = 1\n', 'utf8') },
  ])
  const file = await writeFixture('single-root.zip', zip)
  const dest = path.join(workspace, 'out-shell')
  await extractArchive(file, dest)
  const shell = await stripSingleRoot(dest)
  assert.equal(path.basename(shell.sourceRoot), 'proj', 'the single root directory becomes sourceRoot')
  assert.equal(shell.extractedTo, dest, 'extractedTo stays the extraction directory')
  ok('single-root.zip: 去壳 → sourceRoot = proj/, extractedTo = dest')
}
{
  const zip = buildZip([
    { name: '../evil.txt', data: Buffer.from('slip', 'utf8') },
    { name: 'abs.txt', data: Buffer.from('abs', 'utf8'), rawName: Buffer.from('C:\\evil.txt', 'utf8') },
  ])
  const file = await writeFixture('slip.zip', zip)
  const dest = path.join(workspace, 'out-slip')
  await assert.rejects(() => extractArchive(file, dest), /不安全的路径/)
  const entries = await readdir(dest).catch(() => [])
  assert.equal(entries.length, 0, 'nothing landed in the destination')
  const parentEvil = await stat(path.join(workspace, 'evil.txt')).then(() => true, () => false)
  assert.equal(parentEvil, false, 'nothing landed outside either')
  ok('slip.zip: parent traversal and absolute paths reject the whole archive')
}
{
  const zip = buildZip([
    { name: 'link.txt', data: Buffer.from('x', 'utf8'), externalAttrs: ((0xa1ff << 16) | 0) >>> 0 },
  ])
  const file = await writeFixture('symlink.zip', zip)
  const dest = path.join(workspace, 'out-link')
  const result = await extractArchive(file, dest)
  assert.equal(result.files, 0, 'symlink entry skipped')
  assert.ok(result.warnings.some((w) => w.includes('符号链接')), 'a warning names the skipped entry')
  const entries = await readdir(dest)
  assert.equal(entries.length, 0)
  ok('symlink.zip: symlink entry refused with a warning, nothing written')
}
{
  // GBK 文件名：非 UTF-8 标志 + 非 UTF-8 字节 → TextDecoder('gbk') 兜底。
  const gbkName = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xc3, 0xfb, 0x2e, 0x74, 0x78, 0x74]) // 中文名.txt
  const zip = buildZip([{ name: '', data: Buffer.from('gbk', 'utf8'), rawName: gbkName }])
  const file = await writeFixture('gbk.zip', zip)
  const dest = path.join(workspace, 'out-gbk')
  const result = await extractArchive(file, dest)
  assert.equal(result.files, 1)
  const entries = await readdir(dest)
  assert.deepEqual(entries, ['中文名.txt'], `GBK name decoded: ${entries.join(',')}`)
  ok('gbk.zip: legacy GBK entry name decoded via TextDecoder')
}
{
  assert.equal(decodeEntryName(Buffer.from([0xd6, 0xd0]), false), '中')
  assert.equal(decodeEntryName(Buffer.from('ok.txt', 'utf8'), true), 'ok.txt')
  assert.equal(decodeEntryName(Buffer.from('plain.txt', 'utf8'), false), 'plain.txt', 'valid UTF-8 without the flag still decodes')
  ok('decodeEntryName: UTF-8 flag, strict-UTF-8 sniff, GBK fallback')
}
{
  // 加密与未知算法拒绝；zip64 拒绝。
  const encrypted = buildZip([{ name: 'a.txt', data: Buffer.from('x', 'utf8'), flags: 0x1 }])
  const dest1 = path.join(workspace, 'out-enc')
  await assert.rejects(() => extractZipBuffer(encrypted, dest1), /加密/)
  const weird = buildZip([{ name: 'a.txt', data: Buffer.from('x', 'utf8'), method: 12 }])
  await assert.rejects(() => extractZipBuffer(weird, path.join(workspace, 'out-m12')), /压缩算法/)
  ok('zip: encrypted and unsupported-method archives rejected')
}

/* ------------------------------------------------------------ TAR 解压 --- */
{
  const tar = buildTar([
    { name: 'plain.txt', data: Buffer.from('hello tar\n', 'utf8') },
    { name: 'src', type: '5' },
    { name: 'src/nested.txt', data: Buffer.from('nested', 'utf8') },
  ])
  const file = await writeFixture('plain.tar', tar)
  const dest = path.join(workspace, 'out-tar')
  const result = await extractArchive(file, dest)
  assert.equal(result.kind, 'tar')
  assert.equal(result.files, 2)
  assert.equal(await readFile(path.join(dest, 'plain.txt'), 'utf8'), 'hello tar\n')
  assert.equal(await readFile(path.join(dest, 'src', 'nested.txt'), 'utf8'), 'nested')
  ok('plain.tar: ustar extraction (file + directory + nested file)')
}
{
  const tar = gzipSync(buildTar([
    { name: 'proj/main.py', data: Buffer.from('print("gz")\n', 'utf8') },
  ]))
  const file = await writeFixture('plain.tar.gz', tar)
  const dest = path.join(workspace, 'out-tgz')
  const result = await extractArchive(file, dest)
  assert.equal(result.kind, 'targz')
  assert.equal(await readFile(path.join(dest, 'proj', 'main.py'), 'utf8'), 'print("gz")\n')
  const shell = await stripSingleRoot(dest)
  assert.equal(path.basename(shell.sourceRoot), 'proj')
  ok('plain.tar.gz: streamed gunzip + tar parse + 去壳')
}
{
  const tar = buildTar([
    { name: 'good.txt', data: Buffer.from('ok', 'utf8') },
    { name: 'link', data: Buffer.from(''), type: '2' },
  ])
  const dest = path.join(workspace, 'out-tarlink')
  const result = await extractTarBuffer(tar, dest)
  assert.equal(result.files, 1)
  assert.ok(result.warnings.some((w) => w.includes('符号链接')))
  ok('tar: symlink entry skipped with warning, file entries unaffected')
}
{
  // 非法 tar（全零之外的首块既无 ustar 魔数也无有效校验和）→ 明确报错。
  const bogus = Buffer.alloc(1024)
  bogus.write('NOT A TAR', 0, 'ascii')
  await assert.rejects(() => extractTarBuffer(bogus, path.join(workspace, 'out-bogus')), /不是有效的 tar/)
  ok('tar: garbage input fails loudly instead of writing junk')
}

/* ------------------------------------------------------------ 7z/rar 降级 --- */
{
  const fake7z = Buffer.concat([Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04]), Buffer.alloc(64)])
  const file = await writeFixture('fake.7z', fake7z)
  assert.equal(await detectKind(file), 'sevenzip')
  const dest = path.join(workspace, 'out-7z')
  await assert.rejects(
    () => extractArchive(file, dest, { candidates: [] }),
    (error) => error.message.includes('没有可用的 7z/rar 解压器'),
    'no external tool → actionable Chinese error',
  )
  // 工具存在但失败 → stderr 尾部进错误信息。
  await assert.rejects(
    () => extractArchive(file, dest, { candidates: [{ kind: 'tar', bin: 'definitely-missing-tool.exe' }] }),
    /解压失败/,
  )
  ok('7z: magic sniffed; missing tools and failing tools both degrade with Chinese errors')
}
{
  const fakeRar = Buffer.concat([Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]), Buffer.alloc(32)])
  const file = await writeFixture('fake.rar', fakeRar)
  assert.equal(await detectKind(file), 'rar')
  ok('rar: Rar! magic sniffed')
}

/* ------------------------------------------------------------ 限额 --- */
{
  const entries = Array.from({ length: 1001 }, (_, i) => ({ name: `f${i}.txt`, data: Buffer.from('x', 'utf8') }))
  const zip = buildZip(entries)
  const dest = path.join(workspace, 'out-many')
  await assert.rejects(
    () => extractZipBuffer(zip, dest),
    (error) => error.statusCode === 413 && error.message.includes(`文件数超过 ${ARCHIVE_LIMITS.maxFiles}`),
  )
  ok('limits: >1000 entries → 413 with the Chinese reason')
}
{
  // 单文件上限：中央目录声明 65 MB（data 本身很小，尺寸检查先于解压）。
  const entry = { name: 'big.bin', data: Buffer.from('x', 'utf8') }
  const zip = buildZip([entry])
  // 手工把中央目录与本地头的 uncompressedSize 改成 65 MB。
  const patched = Buffer.from(zip)
  patched.writeUInt32LE(65 * 1024 * 1024, 22) // local header size field
  const cdOffset = patched.length - 22
  void cdOffset
  // 找中央目录头再改。
  for (let i = 0; i < patched.length - 4; i += 1) {
    if (patched.readUInt32LE(i) === 0x02014b50) {
      patched.writeUInt32LE(65 * 1024 * 1024, i + 24)
      break
    }
  }
  const dest = path.join(workspace, 'out-big')
  await assert.rejects(
    () => extractZipBuffer(patched, dest),
    (error) => error.statusCode === 413 && error.message.includes('单文件超过 64 MB'),
  )
  ok('limits: single entry declaring 65 MB → 413 before any inflation')
}

/* ------------------------------------------------------- drop-import 管理 --- */
{
  const manager = createDropManager({ importsRoot, logger: console })
  const session = await manager.begin({ kind: 'dir', name: 'my-folder', files: 2, bytes: 10 })
  assert.ok(session.token && session.expiresAt > Date.now())
  await manager.writeFile(session.token, 'src/a.py', Buffer.from('a=1\n', 'utf8'))
  await manager.writeFile(session.token, 'src/b.py', Buffer.from('b=2\n', 'utf8'))
  assert.equal(manager.sessionOf(session.token).received, 2)
  const staged = path.join(manager.stagingRoot, session.token)
  assert.equal(await readFile(path.join(staged, 'src', 'a.py'), 'utf8'), 'a=1\n')
  // 坏路径 / 越界拒绝。
  await assert.rejects(() => manager.writeFile(session.token, '../escape.txt', Buffer.from('x')), /不合法|越界/)
  await assert.rejects(() => manager.writeFile(session.token, 'C:\\evil.txt', Buffer.from('x')), /不合法|越界/)
  // 覆盖重传同名文件：收到两次，但落盘只有一份（幂等覆盖）。
  await manager.writeFile(session.token, 'src/a.py', Buffer.from('a=2\n', 'utf8'))
  assert.equal(await readFile(path.join(staged, 'src', 'a.py'), 'utf8'), 'a=2\n')
  ok('drop staging: begin/write/count, unsafe paths refused, re-upload overwrites')
}
{
  const manager = createDropManager({ importsRoot, logger: console })
  await assert.rejects(() => manager.begin({ kind: 'dir', name: 'x', files: 1001, bytes: 1 }), (e) => e.statusCode === 413)
  await assert.rejects(() => manager.begin({ kind: 'dir', name: 'x', files: 1, bytes: DROP_LIMITS.maxTotalBytes + 1 }), (e) => e.statusCode === 413)
  await assert.rejects(() => manager.begin({ kind: 'virus', name: 'x', files: 1, bytes: 1 }), /类型/)
  const session = await manager.begin({ kind: 'dir', name: 'x', files: 1, bytes: 1 })
  await assert.rejects(
    () => manager.writeFile(session.token, 'big.bin', Buffer.alloc(DROP_LIMITS.maxFileBytes + 1)),
    (error) => error.statusCode === 413,
    'the oversized upload is refused',
  )
  assert.equal(manager.sessionOf(session.token), undefined, '413 violation tears down the session')
  await manager.abort(session.token)
  ok('drop limits: files/bytes caps at begin, single-file cap kills the session, abort idempotent')
}
{
  const manager = createDropManager({ importsRoot, logger: console })
  // dir 上传 → commitDirUpload → 去壳。
  const dirSession = await manager.begin({ kind: 'dir', name: 'folder-project', files: 2, bytes: 20 })
  await manager.writeFile(dirSession.token, 'main.py', Buffer.from('print(1)\n', 'utf8'))
  await manager.writeFile(dirSession.token, 'lib/util.py', Buffer.from('u=1\n', 'utf8'))
  const moved = await manager.commitDirUpload(dirSession.token, 'folder-project')
  assert.equal(moved, path.join(importsRoot, 'folder-project'))
  assert.equal(await readFile(path.join(moved, 'main.py'), 'utf8'), 'print(1)\n')
  const shell = await stripSingleRoot(moved)
  assert.equal(shell.sourceRoot, moved, 'a flat upload has no extra shell')
  // archive 上传 → commitStagedArchive → 解压 + 暂存压缩包删除。
  const zip = buildZip([{ name: 'arch-main.py', data: Buffer.from('print(2)\n', 'utf8') }])
  const archiveBuffer = zip
  const zipSession = await manager.begin({ kind: 'archive', name: 'archived.zip', files: 1, bytes: archiveBuffer.length })
  await manager.writeFile(zipSession.token, 'archived.zip', archiveBuffer)
  const commit = await manager.commitStagedArchive(zipSession.token, 'archived')
  assert.equal(commit.target, path.join(importsRoot, 'archived'))
  assert.equal(await readFile(path.join(commit.target, 'arch-main.py'), 'utf8'), 'print(2)\n')
  const stagedLeft = await readdir(manager.stagingRoot).catch(() => [])
  assert.ok(!stagedLeft.includes(zipSession.token), 'staging tree cleaned after archive commit')
  ok('commit paths: dir rename into imports/, archive extract + staged copy deleted')
}
{
  const manager = createDropManager({ importsRoot, logger: console })
  // 目录重名：默认 409 conflict(dir)；rename 加后缀；overwrite 删除重移。
  const first = await manager.begin({ kind: 'dir', name: 'dup', files: 1, bytes: 2 })
  await manager.writeFile(first.token, 'a.txt', Buffer.from('one', 'utf8'))
  await manager.commitDirUpload(first.token, 'dup')
  await assert.rejects(
    () => manager.resolvePkgName('dup', {}),
    (error) => error.code === 'conflict' && error.target === 'dir' && error.statusCode === 409,
  )
  const renamed = await manager.resolvePkgName('dup', { rename: true })
  assert.equal(renamed.pkgName, 'dup-2')
  const second = await manager.begin({ kind: 'dir', name: 'dup', files: 1, bytes: 2 })
  await manager.writeFile(second.token, 'a.txt', Buffer.from('two', 'utf8'))
  await manager.commitDirUpload(second.token, 'dup-2')
  const overwritten = await manager.resolvePkgName('dup-2', { overwrite: true })
  assert.equal(overwritten.pkgName, 'dup-2')
  ok('pkg-name conflicts: 409 {code,target}, rename suffixes, overwrite clears')
}
{
  // 项目名冲突（routes 侧同一套语义）。
  let calls = 0
  const exists = async () => (calls += 1) < 3 // dup, dup-2 已占用
  const renamed = await resolveProjectName('dup', { exists, rename: true })
  assert.equal(renamed.projectName, 'dup-3')
  await assert.rejects(() => resolveProjectName('dup', { exists: async () => true }), (e) => e.code === 'conflict' && e.target === 'project')
  const kept = await resolveProjectName('dup', { exists: async () => true, overwrite: true })
  assert.equal(kept.projectName, 'dup')
  ok('resolveProjectName: same 409/rename/overwrite contract for project names')
}
{
  // 清扫：过期的暂存目录被删，新目录保留。
  const manager = createDropManager({ importsRoot, logger: console })
  const oldSession = await manager.begin({ kind: 'dir', name: 'old', files: 1, bytes: 1 })
  const freshSession = await manager.begin({ kind: 'dir', name: 'fresh', files: 1, bytes: 1 })
  await writeFile(path.join(manager.stagingRoot, oldSession.token, 'x.txt'), 'x')
  // 把 old 的 mtime 拨回 7 小时前。
  const past = new Date(Date.now() - 7 * 3600 * 1000)
  await utimesFix(path.join(manager.stagingRoot, oldSession.token), past)
  const removed = await manager.sweep()
  assert.ok(removed >= 1, `sweep removed ${removed}`)
  const left = await readdir(manager.stagingRoot)
  assert.ok(left.includes(freshSession.token), 'the fresh session survives')
  ok('staging sweep: >6h trees removed, fresh ones kept')
}

/* ------------------------------------------------------- 无 LLM 断言 --- */
{
  for (const rel of ['lib/coupling.js', 'lib/archive.js', 'lib/drop-import.js']) {
    const text = await readFile(path.join(pluginRoot, rel), 'utf8')
    assert.ok(!/sessionController/.test(text), `${rel} never references sessionController`)
    assert.ok(!/\bprompt\s*\(/.test(text), `${rel} never calls prompt(`)
    assert.ok(!/sendMessage/.test(text), `${rel} never sends messages`)
    assert.ok(!/spawn|exec\(/.test(text.replace(/execFile[A-Za-z]*/g, '')), `${rel} uses execFile only, no shell`)
  }
  ok('zero-LLM grep: coupling/archive/drop-import are pure deterministic host code')
}

await rm(workspace, { recursive: true, force: true })
console.log(`\ndrop-import: ${passed} checks passed`)

/** utimes helper (name kept short above). */
async function utimesFix(target, date) {
  await chmod(target, 0o755).catch(() => {})
  const { utimes } = await import('node:fs/promises')
  await utimes(target, date, date)
}
