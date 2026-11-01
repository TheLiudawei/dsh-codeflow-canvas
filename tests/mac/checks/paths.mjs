/**
 * 路径与 Unicode 检查：macOS 上最容易"看起来是 UI 的 bug、其实是路径"的一层。
 *
 * 覆盖四类现场形状：
 *
 *   1. DSH 输入框给的 `@` 提及、引号、`file://`、`~`（用户从 Finder 拖路径
 *      进来时全都会出现）；
 *   2. Finder 写出的 NFD 名字与 Node 写出的 NFC 名字互相查找；
 *   3. APFS 默认大小写不敏感，但代码里若假设敏感，真实文件名会找不到；
 *   4. 会话工作目录失效（`working-directory: directory does not exist`），
 *      插件必须逐级修复而不是让每个 agent 回合死在组提示词上。
 *
 * @module tests/mac/checks/paths
 */

import { chmod, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * 运行路径检查。
 *
 * @param ctx - 套件上下文。
 */
export async function runPathChecks(ctx) {
  const { pluginRoot, runner, env } = ctx
  runner.group('路径、Unicode 与工作目录（macOS 重点）')

  const workspace = await ctx.load('lib/workspace.js')
  const paths = await ctx.load('lib/paths.js')
  const core = await ctx.load('lib/core/path.js')

  const base = await ctx.temp('paths-')
  const home = path.join(base, '主目录 用户')
  await mkdir(home, { recursive: true })

  await runner.check('PATH-01', 'cleanPathInput：@ 提及、引号、file://、~ 全部归一', async () => {
    // POSIX 绝对路径在 Windows 上会被 path.normalize 换成反斜杠；套件
    // 以 macOS 为目标，但开发期在 Windows 跑时不应误报。
    const absolute = (value) => path.normalize(value)
    const cases = [
      ['@/Users/me/项目', absolute('/Users/me/项目')],
      ['"@/Users/me/My Project"', absolute('/Users/me/My Project')],
      ["'~/甲 乙'", path.join(home, '甲 乙')],
      ['@', ''],
      ['  @  ~/x  ', path.join(home, 'x')],
      ['/Users/me/a@b', absolute('/Users/me/a@b')],
    ]
    const failed = []
    for (const [input, expected] of cases) {
      const actual = workspace.cleanPathInput(input, { home })
      if (actual !== expected) failed.push(`${JSON.stringify(input)} → ${JSON.stringify(actual)}（期望 ${JSON.stringify(expected)}）`)
    }
    const url = pathToFileURL(path.join(home, '项目 甲')).href
    const fromUrl = workspace.cleanPathInput(url)
    if (fromUrl !== path.join(home, '项目 甲')) failed.push(`file:// → ${JSON.stringify(fromUrl)}`)
    if (failed.length > 0) throw new Error(failed.join('；'))
    return `${cases.length + 1} 种输入形状全部正确`
  })

  await runner.check('PATH-02', 'resolveProjectRoot：中文/空格/引号/@ 提及都能落到真实目录', async () => {
    const project = path.join(base, '工作 区', '项目 甲')
    await mkdir(project, { recursive: true })
    const inputs = [
      project,
      `"${project}"`,
      `@${project}`,
      pathToFileURL(project).href,
      `${project}${path.sep}`,
    ]
    const failed = []
    const normalize = (value) => path.normalize(value).replace(/[\\/]+$/, '')
    for (const input of inputs) {
      try {
        const resolved = await workspace.resolveProjectRoot(input, base)
        if (normalize(resolved) !== normalize(project)) failed.push(`${input} → ${resolved}`)
      } catch (error) {
        failed.push(`${input} 抛错：${error.message}`)
      }
    }
    if (failed.length > 0) throw new Error(failed.join('；'))
    return `${inputs.length} 种拼写全部解析到同一目录`
  })

  await runner.check('PATH-03', 'NFD 拼写能命中 NFC 目录（Finder 与 Node 混用）', async () => {
    const composed = 'café 项目'
    const nfc = composed.normalize('NFC')
    const nfd = composed.normalize('NFD')
    if (nfc === nfd) return { skip: '当前运行时没有改变规范化形式' }
    if (!env.filesystem.unicodeNormalizationInsensitive) {
      return { skip: '当前文件系统不按 Unicode 规范化查找（非 APFS），该场景不适用' }
    }
    const dir = path.join(base, nfc)
    await mkdir(dir, { recursive: true })
    const resolved = await workspace.resolveProjectRoot(path.join(base, nfd), base)
    if (path.basename(resolved).normalize('NFC') !== nfc) throw new Error(`解析结果 ${path.basename(resolved)} 与 ${nfc} 不等价`)
    const found = await workspace.findDirectory(path.join(base, nfd))
    if (found === undefined) throw new Error('findDirectory 没有找到 NFD 拼写')
    return 'NFC/NFD 互相命中'
  })

  await runner.check('PATH-04', '大小写不敏感卷：错误大小写仍能解析', async () => {
    if (process.platform !== 'darwin') return { skip: '大小写回退只在 macOS 上实现（lib/workspace.js 的 darwin 分支）' }
    if (!env.filesystem.caseInsensitive) return { skip: '当前文件系统大小写敏感（非 APFS 默认）' }
    const dir = path.join(base, 'CaseDir')
    await mkdir(dir, { recursive: true })
    const resolved = await workspace.resolveProjectRoot(path.join(base, 'casedir'), base)
    if (path.basename(resolved) !== 'CaseDir') throw new Error(`解析结果 ${path.basename(resolved)} 不是真实文件名`)
    return '错误大小写解析到真实大小写'
  })

  await runner.check('PATH-05', '不存在/是文件/不可访问：错误信息可行动', async () => {
    const file = path.join(base, '普通文件.txt')
    await writeFile(file, 'x', 'utf8')
    let fileError
    try {
      await workspace.resolveProjectRoot(file, base)
    } catch (error) {
      fileError = error
    }
    if (fileError === undefined || !/不是目录/.test(fileError.message)) {
      throw new Error(`文件路径没有给出「不是目录」：${fileError?.message}`)
    }
    let missingError
    try {
      await workspace.resolveProjectRoot(path.join(base, '不存在的目录'), base)
    } catch (error) {
      missingError = error
    }
    if (missingError === undefined || !/目录不存在/.test(missingError.message)) {
      throw new Error(`缺失路径没有给出「目录不存在」：${missingError?.message}`)
    }

    if (process.platform !== 'darwin' || (typeof process.getuid === 'function' && process.getuid() === 0)) {
      return { skip: '权限用例只在非 root 的 macOS 上执行' }
    }
    const gate = path.join(base, '受保护目录')
    const child = path.join(gate, '子目录')
    await mkdir(child, { recursive: true })
    await chmod(gate, 0o000)
    try {
      let denied
      try {
        await workspace.resolveProjectRoot(child, base)
      } catch (error) {
        denied = error
      }
      if (denied === undefined || !/无法访问/.test(denied.message)) {
        throw new Error(`权限拒绝没有给出「无法访问」：${denied?.message}`)
      }
    } finally {
      await chmod(gate, 0o700).catch(() => {})
      await rm(gate, { recursive: true, force: true }).catch(() => {})
    }
    return '文件 / 缺失 / 权限三种错误均可行动'
  })

  await runner.check('PATH-06', '符号链接路径保留用户拼写', async () => {
    const real = path.join(base, '真实 目录')
    const link = path.join(base, '链接 目录')
    await mkdir(real, { recursive: true })
    try {
      await symlink(real, link, 'dir')
    } catch (error) {
      return { skip: `无法创建符号链接：${error.code ?? error.message}` }
    }
    const resolved = await workspace.resolveProjectRoot(link, base)
    if (path.normalize(resolved) !== path.normalize(link)) {
      throw new Error(`解析成 ${resolved}，期望保留链接拼写 ${link}`)
    }
    return '保留符号链接拼写'
  })

  await runner.check('PATH-07', 'TMPDIR 的 /var 拼写不被 realpath 改写', async () => {
    if (process.platform !== 'darwin') return { skip: '仅 macOS 的 /var → /private/var 场景' }
    const tmp = (await import('node:os')).tmpdir()
    const resolved = await workspace.resolveProjectRoot(tmp, tmp)
    if (path.normalize(resolved) !== path.normalize(tmp)) {
      throw new Error(`解析成 ${resolved}，期望保留 ${tmp}`)
    }
    return `保留 ${tmp}`
  })

  await runner.check('PATH-08', 'ensureAgentDirectory：失效 cwd 会逐级修复而不是抛死', async () => {
    const parent = path.join(base, '工作区 根')
    const missing = path.join(parent, '已经被删除的项目')
    await mkdir(parent, { recursive: true })

    const agent = { session: { header: { cwd: missing } } }
    const setCalls = []
    const workingDirectory = {
      get: () => missing,
      ensure: async () => {
        const error = new Error(`working-directory: directory does not exist: "${missing}"`)
        throw error
      },
      set: async (_agent, candidate) => {
        setCalls.push(candidate)
        if (candidate === parent || candidate === missing) return candidate
        throw new Error('refused')
      },
      defaultDirectory: parent,
    }
    const ctx = {
      get: (name) => (name === 'workingDirectory' ? workingDirectory : undefined),
      workingDirectory,
    }
    const result = await workspace.ensureAgentDirectory(ctx, agent, { timeoutMs: 2000 })
    if (result.available !== true) throw new Error(`available=${result.available}，error=${result.error?.message}`)
    if (typeof result.cwd !== 'string' || result.cwd.length === 0) throw new Error('没有返回修复后的 cwd')
    if (setCalls.length === 0) throw new Error('没有调用 workingDirectory.set 提交修复目录')
    if (!(await workspace.isDirectory(parent))) throw new Error('修复后父目录不存在')
    const text = workspace.directoryErrorText(result)
    if (!/会话工作目录不可用|DSH/.test(text)) throw new Error(`directoryErrorText 不可读：${text}`)
    return `修复到 ${result.cwd}`
  })

  await runner.check('PATH-09', 'ensureAgentDirectory：宿主服务可用时原样通过', async () => {
    const dir = path.join(base, '正常 目录')
    await mkdir(dir, { recursive: true })
    const agent = { session: { header: { cwd: dir } } }
    const workingDirectory = {
      get: () => dir,
      ensure: async () => dir,
      set: async () => {
        throw new Error('不应该调用 set')
      },
    }
    const ctx = { get: (name) => (name === 'workingDirectory' ? workingDirectory : undefined) }
    const result = await workspace.ensureAgentDirectory(ctx, agent)
    if (result.cwd !== dir || result.available !== true || result.repaired === true) {
      throw new Error(`结果异常：${JSON.stringify(result)}`)
    }
    return '原样通过'
  })

  await runner.check('PATH-10', 'B1 工作区解析：binding → project-dir → session → 硬失败（v1.2.1）', async () => {
    const binding = await ctx.load('lib/workspace-binding.js')
    const registered = path.join(base, '已登记 工作区')
    const nested = path.join(registered, '嵌套 工作区')
    const second = path.join(base, '第二个 工作区')
    const projectDir = path.join(registered, 'CodeFlow', 'flow-projects', 'demo')
    for (const dir of [registered, nested, second, projectDir]) await mkdir(dir, { recursive: true })
    const registry = { list: () => [{ path: registered }, { path: nested }, { path: second }] }
    const mkCtx = (extra = {}) => ({
      get(name) {
        if (name === 'workspaceRegistry') return registry
        if (name === 'agents') return extra.agents
        return undefined
      },
    })
    const mkStore = (state, anyCwd) => ({
      get: () => state,
      anyCwd: () => anyCwd,
    })

    // 1. binding：store 里的显式绑定仍是已登记工作区 → 直接命中。
    const bound = await binding.resolveProjectWorkspace(
      mkCtx(), mkStore({ cwd: registered, dir: undefined, sessionId: undefined }), 'demo',
    )
    if (bound.workspace === undefined || bound.source !== 'binding') throw new Error(`binding 未命中：${JSON.stringify(bound)}`)

    // 2. binding 失效（目录被删）：落到 project-dir 的最长前缀。
    const fallen = await binding.resolveProjectWorkspace(
      mkCtx(), mkStore({ cwd: path.join(base, '已失效'), dir: projectDir, sessionId: undefined }), 'demo',
    )
    if (fallen.source !== 'project-dir' || path.normalize(fallen.workspace) !== path.normalize(registered)) {
      throw new Error(`失效绑定应落到 project-dir：${JSON.stringify(fallen)}`)
    }

    // 3. session：绑定与目录都缺席时，活会话 cwd 命中所在工作区。
    const sessionCtx = mkCtx({ agents: { roots: () => [{ session: { header: { cwd: nested } } }] } })
    const fromSession = await binding.resolveProjectWorkspace(sessionCtx, mkStore({ cwd: undefined, dir: undefined, sessionId: undefined }), 'demo')
    if (fromSession.source !== 'session' || path.normalize(fromSession.workspace) !== path.normalize(nested)) {
      throw new Error(`session 归属应取最长前缀：${JSON.stringify(fromSession)}`)
    }

    // 4. 回归：没有绑定、没有会话 → 必须硬失败并带候选清单，绝不选第一个。
    const refused = await binding.resolveProjectWorkspace(mkCtx(), mkStore({ cwd: undefined, dir: undefined, sessionId: undefined }), 'demo')
    if (refused.workspace !== undefined || refused.code !== 'NO_WORKSPACE') throw new Error(`应硬失败：${JSON.stringify(refused)}`)
    if (!refused.message.includes(second) || !refused.message.includes(registered)) throw new Error('候选清单不完整')
    return '优先 binding，失效落 project-dir，session 取最长前缀，无锚点硬失败'
  })

  await runner.check('PATH-11', '配置：绝对路径、~ 展开、插件目录拒绝、坏 JSON 回退', async () => {
    const area = await ctx.temp('paths-config-')
    const custom = path.join(area, '自定义 根')
    await mkdir(custom, { recursive: true })

    const expanded = paths.sanitizeConfiguredDir(`"~/${path.basename(custom)}"`)
    if (!path.isAbsolute(expanded)) throw new Error('~ 没有展开成绝对路径')

    let relativeError
    try {
      paths.sanitizeConfiguredDir('相对/目录')
    } catch (error) {
      relativeError = error
    }
    if (relativeError?.statusCode !== 400) throw new Error('相对路径没有以 400 拒绝')

    let pluginError
    try {
      paths.sanitizeConfiguredDir(pluginRoot)
    } catch (error) {
      pluginError = error
    }
    if (pluginError?.statusCode !== 409) throw new Error('插件目录内的路径没有以 409 拒绝')

    await paths.writeConfig(area, { root: custom })
    const read = await paths.readConfig(area)
    if (path.normalize(read.root ?? '') !== path.normalize(custom)) throw new Error(`配置回读 root=${read.root}`)
    if (path.normalize(paths.configPath(area)) !== path.normalize(path.join(area, 'CodeFlow', 'config.json'))) {
      throw new Error('configPath 不在 <工作区>/CodeFlow/config.json')
    }

    await writeFile(paths.configPath(area), '{坏掉的 JSON', 'utf8')
    const fallback = await paths.readConfig(area)
    if (fallback.root !== null) throw new Error('坏配置没有回退默认根')

    const created = await paths.projectDir(area, '中文 项目')
    if (!created.endsWith(path.join('flow-projects', '中文-项目'))) throw new Error(`projectDir=${created}`)
    return '配置读写与校验正确'
  })

  await runner.check('PATH-12', 'safeProjectName：NFC、中文、非法字符与未命名桶', async () => {
    if (core.safeProjectName('中文 项目') !== '中文-项目') throw new Error('中文/空格清理不正确')
    const accented = core.safeProjectName('café 项目'.normalize('NFD'))
    if (accented !== accented.normalize('NFC')) throw new Error('项目名没有归一为 NFC')
    if (core.safeProjectName('..') !== 'untitled') throw new Error(`".." → ${core.safeProjectName('..')}`)
    if (core.projectKeyOf('UNTITLED') !== '__untitled__') throw new Error('untitled 没有收敛到唯一桶')
    if (core.safeProjectName('a'.repeat(200)).length > 60) throw new Error('项目名没有截断到 60')
    return 'NFC / 中文 / 非法输入 / 长度均正确'
  })

  await runner.check('PATH-13', 'isDirectory 对缺失与文件安静返回 false', async () => {
    const file = path.join(base, '一个文件.txt')
    await writeFile(file, 'x', 'utf8')
    if (await workspace.isDirectory(file)) throw new Error('文件被判断成目录')
    if (await workspace.isDirectory(path.join(base, '不存在'))) throw new Error('缺失路径被判断成目录')
    if (!(await workspace.isDirectory(base))) throw new Error('真实目录被判断成不存在')
    return '文件/缺失/目录三种判断正确'
  })
}
