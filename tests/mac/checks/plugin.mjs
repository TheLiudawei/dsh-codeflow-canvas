/**
 * 插件包完整性检查。
 *
 * macOS 现场最常见的"装上了但画布不显示"并不是 UI 代码的错，而是包在复制/
 * 解压/链接的过程中缺了文件、大小写对不上，或客户端 bundle 在宿主 Loader
 * 里没注册成功。这些都能在无浏览器、无 DSH 的情况下静态验证：
 *
 *   1. package.json 的导出面与实际文件一一对应；
 *   2. `lib/**` 的相对 import 全部能精确解析（macOS 默认大小写不敏感会
 *      掩盖错误大小写，换到 case-sensitive 卷才炸）；
 *   3. 每个宿主模块都能被 Node 真正 import（语法 + 顶层求值）；
 *   4. 手写的 `__ModuleLoader__` 客户端 bundle 能注册、能被 `apply()`；
 *   5. 技能文档与画布资产存在且引用的参考文件齐全。
 *
 * @module tests/mac/checks/plugin
 */

import vm from 'node:vm'
import { lstat, readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** 递归列出 `dir` 下的文件（相对 root，`/` 分隔）。跳过依赖与 VCS。 */
async function listFiles(dir, root = dir, into = []) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return into
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await listFiles(full, root, into)
    else if (entry.isFile()) into.push(path.relative(root, full).split(path.sep).join('/'))
  }
  return into
}

/** 读一个包的 `package.json`。 */
async function readPackage(pluginRoot) {
  return JSON.parse(await readFile(path.join(pluginRoot, 'package.json'), 'utf8'))
}

/** 把 `exports` 里的一项解析成相对路径。 */
function exportTarget(value) {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object' && typeof value.default === 'string') return value.default
  return undefined
}

/**
 * 在 `file` 所在的目录里找 import 目标；返回 `{ kind: 'exact'|'case'|'missing', file }`。
 * 扩展名缺省时依次尝试 `.js` / `.mjs` / `index.js`。
 */
async function resolveSpecifier(file, spec) {
  const base = path.resolve(path.dirname(file), spec)
  const candidates = [base]
  if (path.extname(base) === '') {
    candidates.push(`${base}.js`, `${base}.mjs`, `${base}.cjs`, path.join(base, 'index.js'))
  }
  for (const candidate of candidates) {
    let entries
    try {
      entries = await readdir(path.dirname(candidate))
    } catch {
      continue
    }
    const baseName = path.basename(candidate)
    if (entries.includes(baseName)) {
      try {
        if ((await stat(candidate)).isFile()) return { kind: 'exact', file: candidate }
      } catch {
        // 读不了就当作不存在。
      }
    }
  }
  // 大小写不敏感的回退：只在读目录时逐项比较，给出可读的诊断。
  for (const candidate of candidates) {
    let entries
    try {
      entries = await readdir(path.dirname(candidate))
    } catch {
      continue
    }
    const baseName = path.basename(candidate).toLowerCase()
    const match = entries.find((entry) => entry.toLowerCase() === baseName)
    if (match !== undefined) return { kind: 'case', file: path.join(path.dirname(candidate), match) }
  }
  return { kind: 'missing', file: base }
}

/** 从源码里提取相对 import 与 `new URL(..., import.meta.url)` 引用。 */
function referencesOf(source) {
  const specs = new Set()
  for (const match of source.matchAll(/\b(?:from\s*|import\s*\(?\s*)['"](\.[^'"]+)['"]/g)) specs.add(match[1])
  for (const match of source.matchAll(/new\s+URL\(\s*['"](\.[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g)) specs.add(match[1])
  return [...specs]
}

/**
 * 客户端 bundle 的最小复刻：注册 → factory → apply。
 *
 * 与 `tools/verify-client-bundle.mjs` 同源；放在套件里是为了即使 `--plugin`
 * 指向一个不含 `tools/` 的已安装副本也能工作。
 */
async function verifyClientBundle(pluginRoot) {
  const pkg = await readPackage(pluginRoot)
  const declared = pkg.dsh?.client
  if (declared === undefined) throw new Error('package.json 没有 dsh.client')
  if (declared.platform !== 'web') throw new Error(`dsh.client.platform 是 ${JSON.stringify(declared.platform)}，必须是 "web"`)

  const target = exportTarget(pkg.exports?.['./client'])
  if (target === undefined) throw new Error('exports["./client"] 缺失或不是字符串')
  const clientFile = path.join(pluginRoot, target)
  const info = await stat(clientFile).catch(() => undefined)
  if (info === undefined || !info.isFile()) throw new Error(`exports["./client"] 指向的 ${target} 不存在`)

  const registrations = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (registration) => registrations.push(registration) } },
    console,
    Symbol,
    Object,
  }
  vm.runInNewContext(await readFile(clientFile, 'utf8'), sandbox, { filename: clientFile })
  if (registrations.length !== 1) throw new Error(`bundle 注册了 ${registrations.length} 个 factory，期望 1 个`)
  const registration = registrations[0]
  if (registration.id !== pkg.name) throw new Error(`注册 id ${JSON.stringify(registration.id)} ≠ 包名 ${JSON.stringify(pkg.name)}`)
  if (typeof registration.factory !== 'function') throw new Error('factory 不是函数')

  const noop = () => null
  const reactStub = new Proxy({
    createElement: noop,
    memo: (component) => component,
    forwardRef: (component) => component,
    Fragment: 'Fragment',
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
    useRef: (value) => ({ current: value }),
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useEffect: () => {},
    useLayoutEffect: () => {},
    useContext: () => undefined,
    createContext: (value) => ({ Provider: 'Provider', _value: value }),
    isValidElement: () => false,
    Children: { map: () => [], toArray: () => [], only: (child) => child },
  }, { get: (target, key) => (key in target ? target[key] : noop) })

  const platformModules = new Set([
    'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
    '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
  ])
  const externals = new Set(Array.isArray(declared.external) ? declared.external : [])
  const requested = []
  const fakeRequire = (spec) => {
    requested.push(spec)
    if (spec === 'react') return reactStub
    if (spec === 'react/jsx-runtime') return { jsx: noop, jsxs: noop, Fragment: 'Fragment' }
    if (spec === 'react-dom') return { createPortal: noop, flushSync: (fn) => fn() }
    if (spec === 'react-dom/client') return { createRoot: () => ({ render() {}, unmount() {} }) }
    if (platformModules.has(spec) || externals.has(spec)) return {}
    throw new Error(`require("${spec}") 不在平台模块表里，也没有在 dsh.client.external 声明`)
  }
  const exportsObj = registration.factory(fakeRequire)
  if (typeof exportsObj?.apply !== 'function') throw new Error('factory() 没有暴露 apply()')

  const registered = []
  const injected = []
  const ctx = {
    get: () => undefined,
    on: () => () => {},
    effect: (fn) => (typeof fn === 'function' ? fn() : () => {}),
    slots: {
      inject: (key, callback) => {
        injected.push(key)
        const dispose = callback()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      register: (options, component) => {
        registered.push({ options, component })
        return () => {}
      },
    },
  }
  exportsObj.apply(ctx)
  if (registered.length !== 2) throw new Error(`apply() 注册了 ${registered.length} 个槽位，期望 2 个（main + sidebar.panellist）`)
  for (const { options, component } of registered) {
    if (typeof component !== 'function') throw new Error(`槽位 ${JSON.stringify(options)} 的组件不是函数`)
  }
  const main = registered.find((entry) => entry.options?.name === 'main')
  const sidebar = registered.find((entry) => entry.options?.name === 'sidebar.panellist')
  if (main === undefined || main.options.key !== 'codeflow') throw new Error('main 槽位没有以 key="codeflow" 注册')
  if (sidebar === undefined || sidebar.options.id !== 'codeflow') throw new Error('sidebar.panellist 槽位没有以 id="codeflow" 注册')
  if (!injected.includes('main') || !injected.includes('sidebar.panellist')) {
    throw new Error(`apply() 等待的槽位是 ${JSON.stringify(injected)}，缺少 main 或 sidebar.panellist`)
  }
  return {
    target,
    bytes: info.size,
    requires: [...new Set(requested)],
    registered: registered.map((entry) => entry.options.name),
  }
}

/** 校验技能文档的 frontmatter 与 references 引用。 */
async function verifySkill(pluginRoot) {
  const skillDir = path.join(pluginRoot, 'assets', 'skill', 'codeflow-canvas')
  const doc = await readFile(path.join(skillDir, 'SKILL.md'), 'utf8')
  if (!/^---\r?\n/.test(doc)) throw new Error('SKILL.md 缺少 frontmatter')
  const nameMatch = doc.match(/^name:\s*(.+)$/m)
  if (nameMatch === null) throw new Error('SKILL.md frontmatter 缺少 name')
  const name = nameMatch[1].trim().replace(/^['"]|['"]$/g, '')
  if (name !== 'codeflow-canvas') throw new Error(`SKILL.md 的 name 是 ${JSON.stringify(name)}，期望 "codeflow-canvas"`)

  const references = [...new Set([...doc.matchAll(/references\/([\w.-]+\.md)/g)].map((match) => match[1]))]
  const missing = []
  for (const reference of references) {
    const info = await stat(path.join(skillDir, 'references', reference)).catch(() => undefined)
    if (info === undefined) missing.push(reference)
  }
  if (missing.length > 0) throw new Error(`SKILL.md 引用了不存在的参考文件：${missing.join(', ')}`)
  return { references, docBytes: Buffer.byteLength(doc) }
}

/**
 * 运行插件包完整性检查。
 *
 * @param ctx - 套件上下文（`pluginRoot` / `runner`）。
 */
export async function runPluginChecks(ctx) {
  const { pluginRoot, runner } = ctx
  runner.group('插件包完整性')

  let pkg
  await runner.check('PKG-01', 'package.json 可解析且包身份正确', async () => {
    pkg = await readPackage(pluginRoot)
    if (typeof pkg.name !== 'string' || pkg.name.length === 0) throw new Error('package.json 缺少 name')
    if (pkg.type !== 'module') throw new Error(`type 是 ${JSON.stringify(pkg.type)}，期望 "module"`)
    if (typeof pkg.version !== 'string' || pkg.version.length === 0) throw new Error('package.json 缺少 version')
    return `${pkg.name}@${pkg.version}`
  })

  await runner.check('PKG-02', '导出面与实际文件一一对应', async () => {
    if (pkg === undefined) throw new Error('package.json 不可用（见 PKG-01）')
    const targets = []
    const main = exportTarget(pkg.exports?.['.'] ?? pkg.main)
    if (main === undefined) throw new Error('没有 main / exports["."]')
    targets.push(main)
    for (const key of ['./client', './package.json', './cordis.patch.yml']) {
      const target = exportTarget(pkg.exports?.[key])
      if (target === undefined) throw new Error(`exports["${key}"] 缺失`)
      targets.push(target)
    }
    const patch = pkg.dsh?.bundle?.patch
    if (typeof patch !== 'string') throw new Error('dsh.bundle.patch 缺失')
    targets.push(patch)
    for (const file of ['assets/canvas/canvas.html', 'assets/skill/codeflow-canvas/SKILL.md']) targets.push(file)
    const missing = []
    for (const target of targets) {
      const info = await stat(path.join(pluginRoot, target)).catch(() => undefined)
      if (info === undefined) missing.push(target)
    }
    if (missing.length > 0) throw new Error(`导出面指向的文件不存在：${missing.join(', ')}`)
    return `${targets.length} 个导出目标全部存在`
  })

  await runner.check('PKG-03', 'lib/ 模块清单完整', async () => {
    const files = await listFiles(path.join(pluginRoot, 'lib'))
    const js = files.filter((file) => file.endsWith('.js'))
    if (js.length < 20) throw new Error(`lib/ 下只有 ${js.length} 个 .js，包可能不完整`)
    for (const required of ['index.js', 'client.js', 'routes.js', 'store.js', 'paths.js', 'canvas-page.js']) {
      if (!js.includes(required)) throw new Error(`缺少 lib/${required}`)
    }
    return `${js.length} 个宿主模块 + 1 个浏览器 bundle`
  })

  await runner.check('PKG-04', 'lib/ 的相对 import 与资源引用全部可解析', async () => {
    const root = path.join(pluginRoot, 'lib')
    const files = (await listFiles(root)).filter((file) => file.endsWith('.js'))
    const missing = []
    const caseMismatch = []
    for (const rel of files) {
      const file = path.join(root, rel)
      const source = await readFile(file, 'utf8')
      for (const spec of referencesOf(source)) {
        if (!spec.startsWith('.')) continue
        const resolved = await resolveSpecifier(file, spec)
        if (resolved.kind === 'missing') missing.push(`${rel} → ${spec}`)
        else if (resolved.kind === 'case') caseMismatch.push(`${rel} → ${spec}（实际为 ${path.basename(resolved.file)}）`)
      }
    }
    if (missing.length > 0) throw new Error(`无法解析：${missing.slice(0, 6).join('；')}${missing.length > 6 ? ` 等 ${missing.length} 处` : ''}`)
    if (caseMismatch.length > 0) {
      return { warn: `大小写与实际文件名不一致（macOS 默认不敏感，case-sensitive 卷会失败）：${caseMismatch.slice(0, 4).join('；')}` }
    }
    return `${files.length} 个模块的引用全部精确命中`
  })

  await runner.check('PKG-05', '每个宿主模块都能被 Node 真正加载', async () => {
    const root = path.join(pluginRoot, 'lib')
    const files = (await listFiles(root)).filter((file) => file.endsWith('.js') && file !== 'client.js')
    const failures = []
    for (const rel of files) {
      try {
        await import(pathToFileURL(path.join(root, rel)).href)
      } catch (error) {
        failures.push(`${rel}: ${error?.message ?? error}`)
      }
    }
    if (failures.length > 0) throw new Error(failures.slice(0, 6).join('；'))
    return `${files.length} 个模块全部 import 成功`
  })

  await runner.check('PKG-06', '客户端 bundle 能在宿主 Loader 里注册并 apply()', async () => {
    const detail = await verifyClientBundle(pluginRoot)
    return `注册 ${detail.registered.join(' + ')}；依赖 ${detail.requires.join(', ') || '无'}；${(detail.bytes / 1024).toFixed(1)} KB`
  })

  await runner.check('PKG-07', '画布资产未被截断', async () => {
    const file = path.join(pluginRoot, 'assets', 'canvas', 'canvas.html')
    const info = await stat(file)
    const text = await readFile(file, 'utf8')
    if (info.size < 50 * 1024) throw new Error(`canvas.html 只有 ${(info.size / 1024).toFixed(1)} KB，疑似被截断`)
    if (!text.trimEnd().endsWith('</script>')) throw new Error('canvas.html 没有以 </script> 结束')
    if (!text.includes('id="codeflow-canvas"')) throw new Error('canvas.html 缺少根节点 #codeflow-canvas')
    return `${(info.size / 1024).toFixed(1)} KB / ${text.split('\n').length} 行`
  })

  await runner.check('PKG-08', '技能文档 frontmatter 与 references 齐全', async () => {
    const detail = await verifySkill(pluginRoot)
    return `引用 ${detail.references.length} 个参考文件`
  })

  await runner.check('PKG-09', 'cordis.patch.yml 存在且声明了插件', async () => {
    if (pkg === undefined) throw new Error('package.json 不可用（见 PKG-01）')
    const file = path.join(pluginRoot, exportTarget(pkg.exports?.['./cordis.patch.yml']) ?? pkg.dsh?.bundle?.patch ?? 'cordis.patch.yml')
    const text = await readFile(file, 'utf8')
    if (text.trim().length === 0) throw new Error('cordis.patch.yml 为空')
    if (!/codeflow|canvas/i.test(text)) throw new Error('cordis.patch.yml 里没有 codeflow / canvas 字样')
    return `${text.split('\n').length} 行`
  })

  await runner.check('PKG-10', '已安装副本的版本与 README 徽章一致', async () => {
    if (pkg === undefined) throw new Error('package.json 不可用（见 PKG-01）')
    const readme = await readFile(path.join(pluginRoot, 'README.md'), 'utf8')
    const badge = readme.match(/badge\/version-([\w.-]+)-/)
    if (badge === null) return { warn: 'README 里没有版本徽章，无法交叉核对' }
    if (badge[1] !== pkg.version) return { warn: `README 徽章 ${badge[1]} ≠ package.json ${pkg.version}` }
    return pkg.version
  })

  // 供后续组使用的共享事实。
  ctx.packageJson = pkg
}
