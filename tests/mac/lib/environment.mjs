/**
 * 运行环境采集：macOS 诊断的第一步是知道"这是哪台机器"。
 *
 * macOS 现场问题经常与以下因素纠缠，而它们在 Windows 上都不会出现：
 *
 *   - 大小写不敏感、Unicode 规范化保持的 APFS（Finder 给出的名字可能是
 *     NFD，Node 写进去的可能是 NFC）；
 *   - Rosetta 下的 x64 应用跑在 Apple Silicon 上；
 *   - Gatekeeper 的 `com.apple.quarantine` 隔离属性；
 *   - 中文/日文输入法（输入法选词会改变 keydown 的语义）；
 *   - `TMPDIR` 位于 `/var/folders/…`，而 `realpath` 会把它改写成
 *     `/private/var/…`；
 *   - 安装路径或主目录包含中文、空格。
 *
 * 这里只采集事实，不判定成败。判定在 `checks/environment.mjs` 里，且大多
 * 是 warn——环境不是插件的错，但报告必须带上它才能解释后面的失败。
 *
 * @module tests/mac/lib/environment
 */

import { spawnSync } from 'node:child_process'
import { access, lstat, mkdtemp, readdir, readlink, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { cpus, homedir, release as osRelease, tmpdir, totalmem, version as osVersion } from 'node:os'
import path from 'node:path'

/** 跑一个系统命令；失败返回 `{ ok:false }`，绝不抛错。 */
function run(command, args, { timeout = 8000 } = {}) {
  try {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      timeout,
      maxBuffer: 1 << 20,
      windowsHide: true,
    })
    const stdout = String(result.stdout ?? '').trim()
    const stderr = String(result.stderr ?? '').trim()
    return { ok: result.status === 0, status: result.status, stdout, stderr }
  } catch (error) {
    return { ok: false, status: -1, stdout: '', stderr: String(error?.message ?? error) }
  }
}

/** 路径是否包含非 ASCII 字符（中文主目录是最常见的一种）。 */
function hasNonAscii(value) {
  return typeof value === 'string' && /[^\u0000-\u007f]/u.test(value)
}

/** 从 Electron 可执行文件推出 `.app` 包路径。 */
function appBundleOf(executable) {
  if (typeof executable !== 'string') return undefined
  const marker = `${path.sep}Contents${path.sep}MacOS${path.sep}`
  const index = executable.indexOf(marker)
  if (index < 0) return undefined
  return `${executable.slice(0, index)}.app`
}

/** 读 Info.plist 的关键字段（macOS 才有 plutil）。 */
function readBundleInfo(appBundle) {
  if (appBundle === undefined) return undefined
  const result = run('plutil', ['-convert', 'json', '-o', '-', path.join(appBundle, 'Contents', 'Info.plist')])
  if (!result.ok) return undefined
  try {
    const info = JSON.parse(result.stdout)
    return {
      identifier: info.CFBundleIdentifier ?? null,
      name: info.CFBundleName ?? info.CFBundleDisplayName ?? null,
      shortVersion: info.CFBundleShortVersionString ?? null,
      build: info.CFBundleVersion ?? null,
      executable: info.CFBundleExecutable ?? null,
      minSystemVersion: info.LSMinimumSystemVersion ?? null,
    }
  } catch {
    return undefined
  }
}

/** 在 `/Applications` 与用户 Applications 里找可能的 DSH 应用。 */
async function findHarnessApps() {
  const roots = ['/Applications', path.join(homedir(), 'Applications')]
  const found = []
  for (const root of roots) {
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.endsWith('.app')) continue
      if (!/harness|deepseek|\bdsh\b/i.test(entry.name)) continue
      found.push(path.join(root, entry.name))
    }
  }
  return found
}

/** 输入法摘要：中文/日文/韩文输入法是否启用。 */
function inputSourceSummary(raw) {
  const text = String(raw ?? '')
  if (text.length === 0) return undefined
  const ids = [...new Set(text.match(/com\.apple\.(?:inputmethod|keylayout)[\w.-]+/g) ?? [])]
  const kinds = [...new Set((text.match(/InputSourceKind\s*=\s*"([^"]*)"/g) ?? [])
    .map((line) => line.replace(/^InputSourceKind\s*=\s*"|"$/g, '')))]
  return {
    enabledCount: ids.length || undefined,
    ids: ids.slice(0, 20),
    kinds,
    simplifiedChinese: ids.some((id) => /SCIM|Pinyin|ITABC/i.test(id)),
    traditionalChinese: ids.some((id) => /TCIM|Zhuyin|Cangjie|Bopomofo/i.test(id)),
    japanese: ids.some((id) => /Kotoeri|Japanese|TIS|Hiragana|Katakana/i.test(id)),
    korean: ids.some((id) => /Korean|Gureum|Hangul/i.test(id)),
  }
}

/**
 * 探测文件系统的两个 macOS 特性：大小写是否敏感、名字是否按 Unicode
 * 规范化后等价。探测目录只用一次 mkdtemp，结束即删。
 */
async function probeFilesystem() {
  const dir = await mkdtemp(path.join(tmpdir(), 'codeflow-mac-fs-'))
  try {
    const composed = 'café-路径.txt'
    const nfc = composed.normalize('NFC')
    const nfd = composed.normalize('NFD')
    await writeFile(path.join(dir, nfc), 'probe', 'utf8')

    const names = await readdir(dir)
    const stored = names.find((name) => name.normalize('NFC') === nfc)
    let nfdLookup = false
    try {
      await stat(path.join(dir, nfd))
      nfdLookup = true
    } catch {
      nfdLookup = false
    }

    await writeFile(path.join(dir, 'CaseProbe.TXT'), 'probe', 'utf8')
    let lowerLookup = false
    try {
      await stat(path.join(dir, 'caseprobe.txt'))
      lowerLookup = true
    } catch {
      lowerLookup = false
    }

    return {
      dir,
      caseInsensitive: lowerLookup,
      unicodeNormalizationInsensitive: nfdLookup,
      storedForm: stored === undefined ? 'missing' : stored === nfd ? 'NFD' : stored === nfc ? 'NFC' : 'other',
      tmpdir: tmpdir(),
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** `mount` 里根分区的文件系统类型（APFS / HFS+ / 外置卷）。 */
function rootMount() {
  const result = run('mount', [])
  if (!result.ok) return undefined
  const line = result.stdout.split('\n').find((entry) => /\son\s+\/\s+\(/.test(entry))
  return line?.trim()
}

/**
 * 采集整个环境快照。
 *
 * @param options.pluginRoot - 被测插件目录（报告里给出它的真实路径与是否
 *   为符号链接——`dsh plugin add link:` 安装就是链接）。
 * @returns 可 JSON 序列化的对象。
 */
export async function captureEnvironment({ pluginRoot } = {}) {
  const executable = process.execPath
  const appBundle = process.platform === 'darwin' ? appBundleOf(executable) : undefined
  const appInfo = readBundleInfo(appBundle)
  const fsProbe = await probeFilesystem()

  let pluginLink = { linked: false, realpath: undefined, readlink: undefined }
  try {
    const info = await lstat(pluginRoot)
    pluginLink = {
      linked: info.isSymbolicLink(),
      realpath: info.isSymbolicLink() ? await realpath(pluginRoot) : pluginRoot,
      readlink: info.isSymbolicLink() ? await readlink(pluginRoot) : undefined,
    }
  } catch {
    // 目录不存在时让后续检查给出可行动的失败。
  }

  let writable = false
  try {
    await access(pluginRoot, fsConstants.W_OK)
    writable = true
  } catch {
    writable = false
  }

  const quarantine = []
  for (const file of ['package.json', 'lib/index.js', 'assets/canvas/canvas.html']) {
    const full = path.join(pluginRoot, file)
    const result = run('xattr', ['-l', full])
    if (result.ok && /com\.apple\.quarantine/.test(result.stdout)) {
      quarantine.push({ file, attributes: result.stdout.split('\n').filter(Boolean).slice(0, 6) })
    }
  }

  const defaults = (domain, key) => {
    const args = ['read']
    if (domain !== undefined) args.push(domain)
    args.push(key)
    const result = run('defaults', args)
    return result.ok ? result.stdout : undefined
  }

  const languagesRaw = defaults('-g', 'AppleLanguages')
  const languages = [...(languagesRaw?.match(/"([^"]+)"/g) ?? [])].map((token) => token.replace(/"/g, ''))

  const inputSourcesRaw = defaults('com.apple.HIToolbox', 'AppleEnabledInputSources')

  const harnessApps = process.platform === 'darwin' ? await findHarnessApps() : []

  const intl = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions()
    } catch {
      return {}
    }
  })()

  return {
    collectedAt: new Date().toISOString(),
    platform: {
      os: process.platform,
      type: process.platform === 'darwin' ? 'macOS' : process.platform,
      version: osVersion(),
      release: osRelease(),
      arch: process.arch,
      cpus: cpus().length,
      memoryBytes: totalmem(),
    },
    macos: process.platform === 'darwin'
      ? {
        productVersion: run('sw_vers', ['-productVersion']).stdout || undefined,
        buildVersion: run('sw_vers', ['-buildVersion']).stdout || undefined,
        kernel: osRelease(),
        translated: run('sysctl', ['-in', 'sysctl.proc_translated']).stdout === '1',
        hardware: run('uname', ['-m']).stdout || undefined,
        rootMount: rootMount(),
      }
      : undefined,
    runtime: {
      executable,
      node: process.versions.node,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      v8: process.versions.v8,
      icu: process.versions.icu,
      unicode: process.versions.unicode,
      openssl: process.versions.openssl,
      argv: process.argv.slice(0, 4),
    },
    dsh: {
      appBundle,
      appInfo,
      harnessApps,
      rosetta: process.platform === 'darwin'
        ? run('sysctl', ['-in', 'sysctl.proc_translated']).stdout === '1'
        : false,
    },
    plugin: {
      root: pluginRoot,
      ...pluginLink,
      writable,
      hasNonAscii: hasNonAscii(pluginRoot),
      hasSpace: typeof pluginRoot === 'string' && pluginRoot.includes(' '),
      quarantine,
    },
    locale: {
      intlLocale: intl.locale,
      timeZone: intl.timeZone,
      systemLocale: defaults('-g', 'AppleLocale'),
      systemLanguages: languages,
      envLang: process.env.LANG,
      envLcAll: process.env.LC_ALL,
      envLcCtype: process.env.LC_CTYPE,
    },
    input: {
      sourcesRaw: inputSourcesRaw,
      summary: inputSourceSummary(inputSourcesRaw),
      currentLayout: defaults('com.apple.HIToolbox', 'AppleCurrentKeyboardLayoutInputSourceID'),
      fullKeyboardAccess: defaults('-g', 'AppleKeyboardUIMode'),
    },
    filesystem: {
      ...fsProbe,
      tmpdirRealpath: await realpath(tmpdir()).catch(() => undefined),
      tmpRealpathDiffers: await realpath(tmpdir()).catch(() => tmpdir()).then((value) => value !== tmpdir()),
      home: homedir(),
      homeHasNonAscii: hasNonAscii(homedir()),
      homeHasSpace: homedir().includes(' '),
    },
    shell: {
      shell: process.env.SHELL,
      term: process.env.TERM,
      termProgram: process.env.TERM_PROGRAM,
      ssh: process.env.SSH_CONNECTION !== undefined || process.env.SSH_TTY !== undefined,
    },
  }
}
