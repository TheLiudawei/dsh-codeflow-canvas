/**
 * 报告渲染：把检查结果写成一份用户可以直接回传的 Markdown + 两份 JSON。
 *
 * 报告是这套套件的产品本身——用户不会读源码，只会把 `report.md` 和
 * `screenshots/` 发回来。因此：
 *
 *   - 结论放在第一屏，失败项优先；
 *   - 每条结果都有稳定 ID，便于和手动清单、后续修复对照；
 *   - 主目录默认脱敏为 `~`（`--no-redact` 可关），路径里的中文项目名保留，
 *     因为那正是要诊断的东西；
 *   - 完整环境另存 `environment.json`，Markdown 里只放人要看的那部分。
 *
 * @module tests/mac/lib/report
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** 套件版本；报告里带上它，才能判断"这是哪一版测试"。 */
export const SUITE_VERSION = '1.0.0'

/** 递归地把字符串里的主目录替换成 `~`。 */
export function redact(value, home) {
  if (typeof value === 'string') {
    if (typeof home !== 'string' || home.length === 0) return value
    let text = value
    // 同时处理正斜杠与反斜杠拼写；Windows 的 home 也可能出现在 `file://` 里。
    for (const variant of new Set([home, home.replace(/\\/g, '/'), home.replace(/\//g, '\\')])) {
      if (variant.length > 1) text = text.split(variant).join('~')
    }
    return text
  }
  if (Array.isArray(value)) return value.map((entry) => redact(entry, home))
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, entry] of Object.entries(value)) out[key] = redact(entry, home)
    return out
  }
  return value
}

/** Markdown 表格单元格转义。 */
function cell(value) {
  if (value === undefined || value === null) return '—'
  return String(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
}

/** 结果状态的中文标签。 */
const STATUS_LABEL = {
  ok: '通过',
  fail: '失败',
  warn: '警告',
  skip: '跳过',
  info: '信息',
}

/** 人看的字节数。 */
function bytes(value) {
  if (!Number.isFinite(value)) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let number = value
  let unit = 0
  while (number >= 1024 && unit < units.length - 1) {
    number /= 1024
    unit += 1
  }
  return `${number.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

/** 环境里最该出现在 Markdown 表里的字段。 */
function environmentRows(env) {
  const rows = []
  const push = (label, value) => rows.push([label, value])
  push('系统', env.platform?.type)
  push('版本', env.macos?.productVersion ?? env.platform?.release)
  if (env.macos?.buildVersion) push('构建号', env.macos.buildVersion)
  push('架构', `${env.platform?.arch}${env.macos?.translated ? '（Rosetta 翻译运行）' : ''}`)
  push('CPU / 内存', `${env.platform?.cpus} 核 / ${bytes(env.platform?.memoryBytes)}`)
  push('DSH 应用', env.dsh?.appBundle ?? '未找到（可能以 node 直接运行）')
  if (env.dsh?.appInfo) {
    push('DSH 版本', `${env.dsh.appInfo.shortVersion ?? '?'} (build ${env.dsh.appInfo.build ?? '?'})`)
    push('DSH 标识', env.dsh.appInfo.identifier)
  }
  push('Electron / Node / Chrome', `${env.runtime?.electron ?? '—'} / ${env.runtime?.node ?? '—'} / ${env.runtime?.chrome ?? '—'}`)
  push('系统语言 / 区域', `${(env.locale?.systemLanguages ?? []).join(', ') || '—'} / ${env.locale?.systemLocale ?? '—'}`)
  push('Intl 区域 / 时区', `${env.locale?.intlLocale ?? '—'} / ${env.locale?.timeZone ?? '—'}`)
  if (env.input?.summary) {
    const active = [
      env.input.summary.simplifiedChinese ? '简体中文' : '',
      env.input.summary.traditionalChinese ? '繁体中文' : '',
      env.input.summary.japanese ? '日文' : '',
      env.input.summary.korean ? '韩文' : '',
    ].filter(Boolean)
    push('启用输入法', `${active.join('、') || '仅键盘布局'}（${env.input.summary.enabledCount ?? '?'} 个输入源）`)
    push('当前键盘布局', env.input.currentLayout ?? '—')
  }
  push('文件系统大小写', env.filesystem?.caseInsensitive ? '不敏感（APFS 默认）' : '敏感')
  push('Unicode 规范化等价', env.filesystem?.unicodeNormalizationInsensitive ? '是（NFC/NFD 互相命中）' : '否')
  push('根分区', env.filesystem?.rootMount ?? '—')
  push('TMPDIR realpath 改写', env.filesystem?.tmpRealpathDiffers ? '是（/var → /private/var）' : '否')
  push('插件目录', env.plugin?.root)
  push('插件目录安装方式', env.plugin?.linked ? `符号链接 → ${env.plugin.readlink ?? env.plugin.realpath}` : '实体目录')
  push('插件路径含中文 / 空格', `${env.plugin?.hasNonAscii ? '是' : '否'} / ${env.plugin?.hasSpace ? '是' : '否'}`)
  push('主目录含中文 / 空格', `${env.filesystem?.homeHasNonAscii ? '是' : '否'} / ${env.filesystem?.homeHasSpace ? '是' : '否'}`)
  push('插件目录可写', env.plugin?.writable ? '是' : '否')
  push('Gatekeeper 隔离属性', env.plugin?.quarantine?.length ? `有（${env.plugin.quarantine.length} 个文件）` : '无')
  push('终端 / Shell', `${env.shell?.termProgram ?? '—'} / ${env.shell?.shell ?? '—'}`)
  return rows
}

/** 渲染一份完整的 Markdown 报告。 */
export function renderMarkdown({ meta, env, groups, notes, summary }) {
  const lines = []
  const failed = groups.flatMap((group) => group.entries.filter((entry) => entry.status === 'fail'))
  const warned = groups.flatMap((group) => group.entries.filter((entry) => entry.status === 'warn'))

  lines.push('# CodeFlow Canvas · macOS 诊断报告')
  lines.push('')
  lines.push(`- 生成时间：${meta.generatedAt}`)
  lines.push(`- 套件版本：${meta.suiteVersion}`)
  lines.push(`- 插件版本：${meta.pluginVersion ?? '未知'}`)
  lines.push(`- 插件目录：\`${meta.pluginRoot}\``)
  lines.push(`- 运行方式：\`${meta.command}\``)
  if (meta.filter) lines.push(`- 过滤：\`${meta.filter}\``)
  lines.push('')
  lines.push(`## 结论：${summary.verdict === 'PASS' ? 'PASS（无失败项）' : `FAIL（${failed.length} 项失败）`}`)
  lines.push('')
  lines.push(`通过 ${summary.ok} · 失败 ${summary.fail} · 警告 ${summary.warn} · 跳过 ${summary.skip} · 用时 ${(summary.durationMs / 1000).toFixed(1)}s`)
  lines.push('')
  lines.push('> 失败项代表插件在当前环境下的确定行为与预期不符；警告项多是环境事实或已知平台差异，需要和手动清单互相印证。')
  lines.push('')

  lines.push('## 环境')
  lines.push('')
  lines.push('| 项 | 值 |')
  lines.push('| --- | --- |')
  for (const [label, value] of environmentRows(env)) lines.push(`| ${cell(label)} | ${cell(value)} |`)
  lines.push('')

  if (failed.length > 0) {
    lines.push('## 失败项')
    lines.push('')
    lines.push('| ID | 检查 | 说明 |')
    lines.push('| --- | --- | --- |')
    for (const entry of failed) lines.push(`| ${cell(entry.id)} | ${cell(entry.title)} | ${cell(entry.detail)} |`)
    lines.push('')
    lines.push('### 失败详情')
    lines.push('')
    for (const entry of failed) {
      lines.push(`#### ${entry.id} · ${entry.title}`)
      lines.push('')
      lines.push(`\`${entry.detail}\``)
      lines.push('')
      if (entry.error?.stack) {
        lines.push('```')
        lines.push(String(entry.error.stack).split('\n').slice(0, 12).join('\n'))
        lines.push('```')
        lines.push('')
      }
    }
  }

  if (warned.length > 0) {
    lines.push('## 警告项')
    lines.push('')
    lines.push('| ID | 检查 | 说明 |')
    lines.push('| --- | --- | --- |')
    for (const entry of warned) lines.push(`| ${cell(entry.id)} | ${cell(entry.title)} | ${cell(entry.detail)} |`)
    lines.push('')
  }

  lines.push('## 逐项结果')
  lines.push('')
  for (const group of groups) {
    if (group.entries.length === 0) continue
    lines.push(`### ${group.title}`)
    lines.push('')
    lines.push('| ID | 检查 | 结果 | 说明 | 耗时 |')
    lines.push('| --- | --- | --- | --- | --- |')
    for (const entry of group.entries) {
      const elapsed = entry.durationMs === undefined ? '—' : `${entry.durationMs}ms`
      lines.push(`| ${cell(entry.id)} | ${cell(entry.title)} | ${STATUS_LABEL[entry.status] ?? entry.status} | ${cell(entry.detail)} | ${elapsed} |`)
    }
    lines.push('')
  }

  if (notes.length > 0) {
    lines.push('## 平台观察与风险扫描')
    lines.push('')
    for (const note of notes) {
      lines.push(`### ${note.title}`)
      lines.push('')
      for (const line of note.lines) lines.push(`- ${line}`)
      lines.push('')
    }
  }

  lines.push('## 下一步')
  lines.push('')
  lines.push('1. 打开 `MANUAL-CHECKLIST.md`，按 **快速回归（15 项）** 逐项操作并记录；不确定的项标"无法执行"而不是跳过。')
  lines.push('2. 画布打开后，按 `README.md` 的「控制台探针」步骤，在 DevTools 里运行 `console-probe.js`，把 `CodeFlowProbe.report()` 的输出存成 `probe.json` 放进本目录。')
  lines.push('3. 把整个报告目录压缩后回传；如果失败项与本机相关，附上截图和 `~/Library/Logs/DiagnosticReports` 里最近的崩溃日志。')
  lines.push('')
  return lines.join('\n')
}

/**
 * 写出报告目录。
 *
 * @param outDir - 输出目录（不存在则创建）。
 * @param data - `{ meta, env, groups, notes, summary }`。
 * @param options.home - 需要脱敏的主目录；为空则原样写出。
 * @returns 写出的文件路径列表。
 */
export async function writeReports(outDir, data, { home } = {}) {
  await mkdir(outDir, { recursive: true })
  const scrub = (value) => (home === undefined || home === null ? value : redact(value, home))

  const markdown = renderMarkdown({
    meta: scrub(data.meta),
    env: scrub(data.env),
    groups: scrub(data.groups),
    notes: scrub(data.notes),
    summary: data.summary,
  })
  const results = {
    suiteVersion: SUITE_VERSION,
    meta: scrub(data.meta),
    summary: data.summary,
    groups: scrub(data.groups),
    notes: scrub(data.notes),
  }

  const files = {
    markdown: path.join(outDir, 'report.md'),
    results: path.join(outDir, 'results.json'),
    environment: path.join(outDir, 'environment.json'),
  }
  await writeFile(files.markdown, `${markdown}\n`, 'utf8')
  await writeFile(files.results, `${JSON.stringify(results, null, 2)}\n`, 'utf8')
  await writeFile(files.environment, `${JSON.stringify(scrub(data.env), null, 2)}\n`, 'utf8')
  return files
}
