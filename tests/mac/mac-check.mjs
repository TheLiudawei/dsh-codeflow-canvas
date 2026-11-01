#!/usr/bin/env node
/**
 * CodeFlow Canvas · macOS 现场诊断套件（入口）。
 *
 * 用法见 `tests/mac/README.md`。最短路径：
 *
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     tests/mac/mac-check.mjs
 *
 * 或在 Finder 里双击 `run-mac-check.command`。
 *
 * 设计约束：
 *   - 不写用户项目、不动插件源码；所有夹具都在系统临时目录，结束即删；
 *   - 不要求 DSH 正在运行（HTTP 面用假宿主跑真实路由）；
 *   - 任何一项失败都不中止套件，最后统一写 `report.md` / `results.json` /
 *     `environment.json`，用户把整个目录回传即可。
 *
 * @module tests/mac/mac-check
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { captureEnvironment } from './lib/environment.mjs'
import { loadFrom } from './lib/harness.mjs'
import { SUITE_VERSION, writeReports } from './lib/report.mjs'
import { createRunner } from './lib/runner.mjs'

/** 套件所在目录（`tests/mac`）。 */
const SUITE_DIR = fileURLToPath(new URL('.', import.meta.url))

/** 默认插件根 = 仓库根。 */
const DEFAULT_PLUGIN = path.resolve(SUITE_DIR, '..', '..')

/** 打印帮助。 */
function usage() {
  console.log(`CodeFlow Canvas · macOS 诊断套件 v${SUITE_VERSION}

用法:
  mac-check.mjs [选项]

选项:
  --plugin <目录>   被测插件目录（默认: ${DEFAULT_PLUGIN}）
  --out <目录>      报告输出目录（默认: ~/Desktop/codeflow-mac-report-<时间>）
  --filter <前缀>   只跑 id 以该前缀开头的检查，例如 --filter PATH
  --with-core       额外跑仓库自带的 7 个自检（较慢，约 1–3 分钟）
  --keep            保留临时夹具目录（排查导入/撤销问题用）
  --no-redact       报告里保留完整主目录路径（默认脱敏为 ~）
  --quiet           只打印失败/警告与总结
  -h, --help        显示本帮助

退出码: 0 = 没有失败项；1 = 有失败项；2 = 参数/环境错误。`)
}

/** 解析命令行。 */
function parseArgs(argv) {
  const options = {
    plugin: DEFAULT_PLUGIN,
    out: undefined,
    filter: undefined,
    withCore: false,
    keep: false,
    redact: true,
    quiet: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '-h' || arg === '--help') {
      usage()
      process.exit(0)
    } else if (arg === '--plugin') options.plugin = path.resolve(argv[++index])
    else if (arg === '--out') options.out = path.resolve(argv[++index])
    else if (arg === '--filter') options.filter = argv[++index]
    else if (arg === '--with-core') options.withCore = true
    else if (arg === '--keep') options.keep = true
    else if (arg === '--no-redact') options.redact = false
    else if (arg === '--quiet') options.quiet = true
    else {
      console.error(`未知参数：${arg}\n`)
      usage()
      process.exit(2)
    }
  }
  return options
}

/** 本地时间 ISO（带偏移），比 UTC 更容易和用户截图对上。 */
function localIso(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const hours = pad(Math.floor(Math.abs(offset) / 60))
  const minutes = pad(Math.abs(offset) % 60)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${hours}:${minutes}`
}

/** 默认报告目录：桌面优先，不存在则主目录。 */
async function defaultOutDir() {
  const stamp = localIso().replace(/[:+]/g, '-')
  const desktop = path.join(homedir(), 'Desktop')
  const base = await stat(desktop).then((info) => info.isDirectory()).catch(() => false) ? desktop : homedir()
  return path.join(base, `codeflow-mac-report-${stamp}`)
}

/** 读插件版本；失败返回 undefined。 */
async function pluginVersion(pluginRoot) {
  try {
    const pkg = JSON.parse(await readFile(path.join(pluginRoot, 'package.json'), 'utf8'))
    return `${pkg.name ?? '?'}@${pkg.version ?? '?'}`
  } catch {
    return undefined
  }
}

/** 仓库自带的核心自检（可选）。 */
const CORE_SUITES = [
  ['CORE-01', 'validate.mjs'],
  ['CORE-02', 'regression.mjs'],
  ['CORE-03', 'e2e.mjs'],
  ['CORE-04', 'undo.mjs'],
  ['CORE-05', 'coupling.mjs'],
  ['CORE-06', 'features.mjs'],
  ['CORE-07', 'drop-import.mjs'],
]

/** 跑一组可选的核心回归。 */
async function runCoreSuites(ctx) {
  const { runner, pluginRoot } = ctx
  runner.group('核心回归（--with-core）')
  for (const [id, file] of CORE_SUITES) {
    await runner.check(id, file, async () => {
      const script = path.join(pluginRoot, 'tests', file)
      const info = await stat(script).catch(() => undefined)
      if (info === undefined) return { skip: `已安装副本不含 tests/${file}` }
      const started = Date.now()
      const result = spawnSync(process.execPath, [script], {
        cwd: pluginRoot,
        encoding: 'utf8',
        timeout: 300000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1' },
        windowsHide: true,
      })
      const seconds = ((Date.now() - started) / 1000).toFixed(1)
      const tail = `${String(result.stdout ?? '').trim()}\n${String(result.stderr ?? '').trim()}`.trim()
      if (result.status !== 0) {
        throw new Error(`退出码 ${result.status}（${seconds}s）\n${tail.split('\n').slice(-12).join('\n')}`)
      }
      // 自检的输出里既有 `ok` 行也有 logger 警告；只取真正代表结论的一行。
      const summaryLine = tail.split('\n').map((line) => line.trim()).filter(Boolean).reverse()
        .find((line) => /\b\d+\s+checks?\s+passed\b/i.test(line)
          || /^(RESULT:|PASS\b|FAILED$)/i.test(line)
          || /全部通过|结论[:：]/.test(line))
      return `${seconds}s · ${summaryLine ?? '退出码 0'}`
    })
  }
}

/**
 * 主流程。
 */
async function main() {
  const options = parseArgs(process.argv.slice(2))
  const pluginRoot = options.plugin

  const pluginStat = await stat(pluginRoot).catch(() => undefined)
  if (pluginStat === undefined || !pluginStat.isDirectory()) {
    console.error(`插件目录不存在：${pluginRoot}`)
    process.exit(2)
  }

  // 独立压缩包解压后默认根往往不是插件目录；给出可行动的下一步，而不是让
  // 后面的检查以奇怪的 import 错误收场。
  const pkgFile = path.join(pluginRoot, 'package.json')
  const pkgStat = await stat(pkgFile).catch(() => undefined)
  if (pkgStat === undefined) {
    console.error(`这不是 CodeFlow Canvas 插件目录：${pluginRoot}`)
    console.error('缺少 package.json。请用 --plugin 指向已安装的插件目录，例如：')
    console.error(`  ${process.argv[0]} ${process.argv[1]} --plugin "/Applications/…/dsh-codeflow-canvas"`)
    process.exit(2)
  }
  let pkgName
  try {
    pkgName = JSON.parse(await readFile(pkgFile, 'utf8')).name
  } catch (error) {
    console.error(`package.json 无法解析：${String(error?.message ?? error)}`)
    process.exit(2)
  }
  if (pkgName !== 'dsh-codeflow-canvas') {
    console.error(`package.json 的 name 是 ${JSON.stringify(pkgName)}，不是 "dsh-codeflow-canvas"。`)
    console.error('请用 --plugin 指向正确的插件目录。')
    process.exit(2)
  }

  const outDir = options.out ?? await defaultOutDir()
  const workRoot = await mkdtemp(path.join(tmpdir(), 'codeflow-mac-work-'))
  const runner = createRunner({ filter: options.filter, quiet: options.quiet })

  const ctx = {
    pluginRoot,
    workRoot,
    runner,
    env: undefined,
    packageJson: undefined,
    load: (rel) => loadFrom(pluginRoot, rel),
    async temp(prefix = 'case-') {
      const dir = await mkdtemp(path.join(workRoot, prefix))
      return dir
    },
  }

  console.log('CodeFlow Canvas · macOS 诊断套件')
  console.log(`  套件 v${SUITE_VERSION} · 插件 ${pluginRoot}`)
  console.log(`  报告将写入 ${outDir}\n`)

  let environment
  try {
    environment = await captureEnvironment({ pluginRoot })
    ctx.env = environment
    console.log(`  平台 ${environment.platform.type} ${environment.macos?.productVersion ?? ''} · ${environment.platform.arch}${environment.dsh?.rosetta ? '（Rosetta）' : ''}`)
    console.log(`  ${environment.platform.cpus} 核 / ${(environment.platform.memoryBytes / 1024 ** 3).toFixed(1)} GB · ${environment.runtime.electron ? `Electron ${environment.runtime.electron}` : `Node ${environment.runtime.node}`}`)
    console.log(`  文件系统 ${environment.filesystem.caseInsensitive ? '大小写不敏感' : '大小写敏感'} · ${environment.filesystem.unicodeNormalizationInsensitive ? 'NFC/NFD 等价' : 'NFC/NFD 区分'}`)
  } catch (error) {
    // 环境采集失败不应阻止检查；用最小快照继续，报告里记一条失败。
    environment = { captureError: String(error?.message ?? error), platform: { os: process.platform, arch: process.arch, type: process.platform } }
    ctx.env = environment
    console.error(`环境采集失败：${error?.message ?? error}`)
  }

  runner.start()

  /** 依次运行一个检查模块；模块级异常单独记一条失败，不拖垮其余组。 */
  async function runModule(label, loader) {
    try {
      const module = await loader()
      await module(ctx)
    } catch (error) {
      await runner.check(`SUITE-${label}`, `检查模块 ${label} 执行失败`, () => {
        throw error
      })
    }
  }

  const { runEnvironmentChecks } = await import('./checks/environment.mjs')
  const { runPluginChecks } = await import('./checks/plugin.mjs')
  const { runCanvasDocChecks } = await import('./checks/canvas-doc.mjs')
  const { runHttpChecks } = await import('./checks/http.mjs')
  const { runPathChecks } = await import('./checks/paths.mjs')
  const { runImportChecks } = await import('./checks/import.mjs')
  const { runArchiveChecks } = await import('./checks/archive.mjs')
  const { runStateChecks } = await import('./checks/state.mjs')
  const { runRiskChecks } = await import('./checks/risk.mjs')

  try {
    await runModule('environment', async () => runEnvironmentChecks)
    await runModule('plugin', async () => runPluginChecks)
    await runModule('canvas-doc', async () => runCanvasDocChecks)
    await runModule('http', async () => runHttpChecks)
    await runModule('paths', async () => runPathChecks)
    await runModule('import', async () => runImportChecks)
    await runModule('archive', async () => runArchiveChecks)
    await runModule('state', async () => runStateChecks)
    await runModule('risk', async () => runRiskChecks)
    if (options.withCore) await runCoreSuites(ctx)

    const summary = runner.summary()
    const meta = {
      generatedAt: localIso(),
      suiteVersion: SUITE_VERSION,
      pluginVersion: await pluginVersion(pluginRoot),
      pluginRoot,
      command: process.argv.join(' '),
      filter: options.filter ?? null,
    }
    const files = await writeReports(outDir, {
      meta,
      env: environment,
      groups: runner.groups,
      notes: runner.notes,
      summary,
    }, { home: options.redact ? homedir() : undefined })

    const mark = summary.fail === 0 ? 'PASS' : 'FAIL'
    console.log(`\n${'='.repeat(60)}`)
    console.log(`结论: ${mark} · 通过 ${summary.ok} · 失败 ${summary.fail} · 警告 ${summary.warn} · 跳过 ${summary.skip}`)
    console.log(`用时: ${(summary.durationMs / 1000).toFixed(1)}s`)
    console.log(`报告: ${files.markdown}`)
    console.log(`      ${files.results}`)
    console.log(`      ${files.environment}`)
    if (summary.fail > 0) {
      console.log('\n失败项（详见 report.md）：')
      for (const group of runner.groups) {
        for (const entry of group.entries) {
          if (entry.status === 'fail') console.log(`  ${entry.id}  ${entry.title} — ${entry.detail}`)
        }
      }
    }
    console.log('\n下一步：打开 MANUAL-CHECKLIST.md 逐项操作，并用 console-probe.js 采集画布内的键盘/触控板/拖拽观测。')

    process.exitCode = summary.fail > 0 ? 1 : 0
  } finally {
    if (options.keep) console.log(`\n临时夹具保留在: ${workRoot}`)
    else await rm(workRoot, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((error) => {
  console.error(`套件自身失败：${error?.stack ?? error}`)
  process.exit(2)
})
