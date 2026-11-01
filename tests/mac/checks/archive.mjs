/**
 * 压缩包 / Finder 拖拽检查。
 *
 * 从 Finder 拖一个文件夹或压缩包进画布，是 macOS 用户最自然的导入方式，
 * 也是平台差异最集中的地方：
 *
 *   - Finder 会把文件名存成 NFD，压缩包里还会附带 `.DS_Store` 与
 *     `__MACOSX/._*`（AppleDouble）；
 *   - 归档工具的 zip 条目常带 UTF-8 标志，但中文名仍可能是 NFD；
 *   - `.7z` / `.rar` 依赖外部解压器，而 `lib/archive.js` 的候选列表只写了
 *     Windows 路径（本套件会明确报告这一点）。
 *
 * 这里用纯 Node 构造的 zip/tar 复现这些形状，不依赖用户机器上的 `zip`。
 *
 * @module tests/mac/checks/archive
 */

import { lstat, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { buildMacFinderZip, buildTar, buildZip } from '../lib/fixtures.mjs'

/** 把相对路径里出现的所有反斜杠统一成 `/`，便于断言。 */
const slash = (value) => String(value).split(path.sep).join('/')

/**
 * 运行压缩包与拖拽检查。
 *
 * @param ctx - 套件上下文。
 */
export async function runArchiveChecks(ctx) {
  const { pluginRoot, runner, env } = ctx
  runner.group('压缩包与 Finder 拖拽（macOS 重点）')

  const archive = await ctx.load('lib/archive.js')
  const drop = await ctx.load('lib/drop-import.js')
  const importer = await ctx.load('lib/importer.js')
  const base = await ctx.temp('archive-')

  await runner.check('ARC-01', 'zip：中文 / 空格 / NFD 条目逐字节解出', async () => {
    const nfd = 'src/café 模块.js'.normalize('NFD')
    const zip = buildZip([
      { name: 'src/用户模块.js', data: Buffer.from('// TODO: 中文\n', 'utf8'), method: 8 },
      { name: 'src/订单 处理.py', data: Buffer.from('print("订单")\n', 'utf8'), method: 8 },
      { name: nfd, data: Buffer.from('// NFD\n', 'utf8') },
    ])
    const dest = path.join(base, 'zip-cn')
    const result = await archive.extractZipBuffer(zip, dest)
    if (result.files !== 3) throw new Error(`解出 ${result.files} 个文件，期望 3`)
    const js = await readFile(path.join(dest, 'src/用户模块.js'), 'utf8')
    if (!js.includes('中文')) throw new Error('中文文件名或内容没有正确落盘')
    const spaced = await readFile(path.join(dest, 'src/订单 处理.py'), 'utf8')
    if (!spaced.includes('订单')) throw new Error('含空格文件名没有正确落盘')
    const entries = await readdir(path.join(dest, 'src'))
    if (!entries.some((entry) => entry.normalize('NFC') === path.basename(nfd).normalize('NFC'))) {
      throw new Error(`NFD 文件名丢失（实际：${entries.join(', ')}）`)
    }
    return '3 个条目全部字节一致'
  })

  await runner.check('ARC-02', 'zip-slip / 绝对路径条目会让整包被拒绝，且不写出目录', async () => {
    const dest = path.join(base, 'zip-slip')
    const outside = path.join(base, 'evil.txt')
    const zip = buildZip([
      { name: '../evil.txt', data: Buffer.from('evil', 'utf8') },
      { name: '/absolute.txt', data: Buffer.from('abs', 'utf8') },
      { name: 'a/../../escape.txt', data: Buffer.from('escape', 'utf8') },
      { name: 'safe.txt', data: Buffer.from('safe', 'utf8') },
    ])
    let rejection
    try {
      await archive.extractZipBuffer(zip, dest)
    } catch (error) {
      rejection = error
    }
    if (rejection === undefined) throw new Error('包含 ../ 的压缩包没有被拒绝')
    if (rejection.statusCode !== 400) throw new Error(`拒绝状态码 ${rejection.statusCode}，期望 400`)
    const escaped = await stat(outside).catch(() => undefined)
    if (escaped !== undefined) throw new Error('目录外文件被写出')
    if (await stat(path.join(base, 'escape.txt')).catch(() => undefined) !== undefined) {
      throw new Error('上级目录逃逸成功')
    }
    // 合法压缩包仍应正常解出，确认拒绝不是"所有包都解不了"。
    const safeDest = path.join(base, 'zip-safe')
    await archive.extractZipBuffer(buildZip([{ name: 'safe.txt', data: Buffer.from('safe', 'utf8') }]), safeDest)
    if ((await readFile(path.join(safeDest, 'safe.txt'), 'utf8')) !== 'safe') throw new Error('合法压缩包没有解出')
    return '越界压缩包整体拒绝（400），合法压缩包正常'
  })

  await runner.check('ARC-03', 'Finder 压缩的 zip：__MACOSX 与 .DS_Store 不应进入源码图', async () => {
    const name = '项目 甲'
    const zip = buildMacFinderZip(name, {
      'src/用户模块.js': '// TODO: 中文模块\nexport const x = 1\n',
      'src/billing.js': '// FIXME: 账单\nexport const y = 2\n',
    })
    const dest = path.join(base, 'finder-zip')
    const extracted = await archive.extractZipBuffer(zip, dest)
    const shell = await archive.stripSingleRoot(dest)
    const sourceRoot = shell.sourceRoot

    // 扫描层看到的东西（这才是模块图的输入）。
    const { walk } = await ctx.load('lib/scan/walk.js')
    const scanned = await walk(sourceRoot, { maxDepth: 6, maxFiles: 200 })
    const polluted = scanned.files.filter((file) => file.rel.split('/').some((segment) => (
      segment === '__MACOSX' || segment === '.DS_Store' || segment.startsWith('._')
    )))
    if (polluted.length > 0) {
      throw new Error(`Finder 元数据被当作源码扫描：${polluted.map((file) => file.rel).slice(0, 5).join(', ')}（共 ${polluted.length} 个）`)
    }
    const imported = await importer.importProject({ path: sourceRoot })
    const text = JSON.stringify(imported.graph)
    if (/__MACOSX|\.DS_Store|_用户模块/.test(text)) throw new Error('导入图里出现了 Finder 元数据')
    return `${extracted.files} 个条目解出，${scanned.files.length} 个文件进入扫描，无元数据污染`
  })

  await runner.check('ARC-04', 'tar：./项目/ 单层外壳去掉后仍保留中文路径', async () => {
    const tar = buildTar([
      { name: './项目 甲/', type: '5' },
      { name: './项目 甲/src/用户模块.js', data: Buffer.from('// 用户\n', 'utf8') },
      { name: './项目 甲/src/订单 处理.py', data: Buffer.from('x = 1\n', 'utf8') },
    ])
    const dest = path.join(base, 'tar-cn')
    const result = await archive.extractTarBuffer(tar, dest)
    if (result.files !== 2) throw new Error(`解出 ${result.files} 个文件，期望 2`)
    const shell = await archive.stripSingleRoot(dest)
    if (shell.innerName !== '项目 甲') throw new Error(`innerName=${JSON.stringify(shell.innerName)}`)
    await readFile(path.join(shell.sourceRoot, 'src/用户模块.js'), 'utf8')
    return `去壳为 ${shell.innerName}`
  })

  await runner.check('ARC-05', 'tar.gz：类型嗅探与解压', async () => {
    const { gzipSync } = await import('node:zlib')
    const tar = buildTar([{ name: 'src/a.js', data: Buffer.from('// a\n', 'utf8') }])
    const file = path.join(base, '包 甲.tar.gz')
    await writeFile(file, gzipSync(tar))
    const kind = await archive.detectKind(file)
    if (kind !== 'targz') throw new Error(`嗅探为 ${kind}`)
    const dest = path.join(base, 'targz-out')
    const result = await archive.extractArchive(file, dest)
    if (result.kind !== 'targz' || result.files !== 1) throw new Error(`结果 ${JSON.stringify({ kind: result.kind, files: result.files })}`)
    return 'tar.gz 正常'
  })

  await runner.check('ARC-06', '只有 .DS_Store 的目录不算一个可去壳的根', async () => {
    const dest = path.join(base, 'ds-only')
    await mkdir(path.join(dest, '项目'), { recursive: true })
    await writeFile(path.join(dest, '项目', '.DS_Store'), Buffer.from([0, 0, 0, 1]))
    const shell = await archive.stripSingleRoot(dest)
    if (shell.innerName !== null) {
      return { warn: `只有 .DS_Store 的目录也被当成源码根（innerName=${shell.innerName}）。影响较小，但会让一个空壳被导入成空项目；建议 hasAnyFile 忽略这些元数据文件` }
    }
    return '未去壳'
  })

  await runner.check('ARC-07', 'tar 符号链接条目不会写到目录外', async () => {
    const tar = buildTar([
      { name: 'link-out', type: '2', linkname: '../outside' },
      { name: 'ok.txt', data: Buffer.from('ok', 'utf8') },
    ])
    const dest = path.join(base, 'tar-link')
    const result = await archive.extractTarBuffer(tar, dest)
    const link = await lstat(path.join(dest, 'link-out')).catch(() => undefined)
    if (link?.isSymbolicLink()) throw new Error('符号链接被创建')
    if (!Array.isArray(result.warnings) || !result.warnings.some((warning) => /符号链接/.test(warning))) {
      throw new Error(`没有给出跳过符号链接的警告：${JSON.stringify(result.warnings)}`)
    }
    return '符号链接被跳过并记录警告'
  })

  await runner.check('ARC-08', '拖拽目录上传：编码中文相对路径、去壳、冲突改名', async () => {
    const importsRoot = path.join(base, 'CodeFlow', 'imports')
    const manager = drop.createDropManager({ importsRoot })
    try {
      const name = '项目 甲'
      const first = await manager.begin({ kind: 'dir', name, files: 2, bytes: 32 })
      await manager.writeFile(first.token, encodeURIComponent('src/用户模块.js'), Buffer.from('// 用户\n'))
      await manager.writeFile(first.token, encodeURIComponent('src/café 模块.js'), Buffer.from('// 咖啡\n'))
      const target = await manager.commitDirUpload(first.token, '项目-甲')
      const js = await readFile(path.join(target, 'src/用户模块.js'), 'utf8')
      if (!js.includes('用户')) throw new Error('上传文件内容不正确')

      const conflict = await manager.resolvePkgName(name).then(() => undefined, (error) => error)
      if (conflict?.code !== 'conflict') throw new Error(`同名目录没有给出 conflict：${conflict?.code}`)
      const renamed = await manager.resolvePkgName(name, { rename: true })
      if (renamed.pkgName === '项目-甲') throw new Error(`改名没有生效：${renamed.pkgName}`)
      return `上传到 ${path.basename(target)}，冲突改名为 ${renamed.pkgName}`
    } finally {
      manager.dispose()
    }
  })

  await runner.check('ARC-09', '拖拽上传拒绝 ../ 与绝对路径', async () => {
    const importsRoot = path.join(base, 'CodeFlow', 'imports-safe')
    const manager = drop.createDropManager({ importsRoot })
    try {
      const session = await manager.begin({ kind: 'dir', name: '安全', files: 1, bytes: 4 })
      const attempts = ['..%2Fevil.txt', '/absolute.txt', 'a%2F..%2F..%2Fescape.txt']
      for (const rel of attempts) {
        let error
        try {
          await manager.writeFile(session.token, rel, Buffer.from('x'))
        } catch (caught) {
          error = caught
        }
        if (error === undefined) throw new Error(`越界路径被接受：${rel}`)
      }
      await manager.abort(session.token)
      return `${attempts.length} 种越界路径全部拒绝`
    } finally {
      manager.dispose()
    }
  })

  await runner.check('ARC-10', '7z / rar：macOS 没有外部解压器候选（已知平台缺口）', async () => {
    if (process.platform !== 'darwin') return { skip: '该缺口只在 macOS 上成立' }
    const candidates = archive.externalToolCandidates()
    if (candidates.length > 0) {
      return `找到 ${candidates.length} 个候选：${candidates.map((entry) => path.basename(entry.bin)).join(', ')}`
    }
    // 再确认错误信息确实是可行动的，而不是 undefined。
    let message
    try {
      await archive.extractWithExternalTool(path.join(base, '不存在.7z'), path.join(base, 'seven-out'), { candidates: [] })
    } catch (error) {
      message = error.message
    }
    return { warn: `macOS 上 7z/rar 无可用解压器候选（lib/archive.js 只枚举 Windows 的 tar.exe / 7z.exe / UnRAR）。拖入 .7z/.rar 会得到：${message ?? '未知错误'}。建议手动解压后拖文件夹，或在插件里补 macOS 的 /usr/bin/bsdtar、p7zip、unar。` }
  })

  await runner.check('ARC-11', '真实路径压缩包通道：原文件保留、解压目录独立', async () => {
    const importsRoot = path.join(base, 'CodeFlow', 'imports-path')
    const manager = drop.createDropManager({ importsRoot })
    try {
      const file = path.join(base, '真实 压缩包.zip')
      await writeFile(file, buildZip([{ name: 'src/用户模块.js', data: Buffer.from('// 真实\n', 'utf8') }]))
      const result = await manager.commitPathArchive(file, '项目-乙')
      const content = await readFile(path.join(result.target, 'src/用户模块.js'), 'utf8')
      if (!content.includes('真实')) throw new Error('解压内容不正确')
      if ((await stat(file)).isFile() !== true) throw new Error('用户的原始压缩包被删除')
      return `解压到 ${path.basename(result.target)}，原文件保留`
    } finally {
      manager.dispose()
    }
  })

  // 让平台事实进入报告，供手动清单对照。
  if (env && env.filesystem) {
    runner.info('ARC-INFO', '归档工具环境', `系统探针：${env.filesystem.caseInsensitive ? '大小写不敏感' : '大小写敏感'} / Unicode ${env.filesystem.unicodeNormalizationInsensitive ? '规范化等价' : '区分'}`)
  }
}
