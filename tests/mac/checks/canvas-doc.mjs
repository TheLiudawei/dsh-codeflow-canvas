/**
 * 画布文档检查：面板 iframe 里那份自包含 HTML 是否完整、可解析、能启动。
 *
 * "UI 不显示"最常见的技术原因，按发生概率排序：
 *
 *   1. 片段被截断或复制不完整 → 内联脚本语法错误，整段 IIFE 不执行；
 *   2. 关键 DOM id 被改名/漏掉 → 启动时 `$('cf-xxx')` 返回 null，首绘抛错；
 *   3. boot 载荷没注入或不是合法 JSON → 画布退化成空图；
 *   4. 主题/空格/样式外壳缺失 → 有 DOM 但看不见（高度 0、黑底黑字）；
 *   5. 项目名等用户数据里的 `</script>` 提前闭合内联脚本 → 白屏。
 *
 * 这些都不需要浏览器，可以直接对字符串做结构断言。真正的渲染仍需手动
 * 清单与控制台探针，见 README。
 *
 * @module tests/mac/checks/canvas-doc
 */

import vm from 'node:vm'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import { bootOf } from '../lib/harness.mjs'
import { makeGraph } from '../lib/harness.mjs'

/** 画布启动与首绘依赖的元素；少一个就会在 boot 时抛错。 */
const CRITICAL_IDS = [
  'codeflow-canvas',
  'cf-tb-new', 'cf-tb-import', 'cf-tb-add', 'cf-tb-runall', 'cf-tb-undo',
  'cf-tb-coupling', 'cf-tb-layout', 'cf-tb-fit', 'cf-tb-settings', 'cf-tb-save', 'cf-tb-help',
  'cf-viewtabs', 'cf-vtab-tasks', 'cf-vtab-modules',
  'cf-stage', 'cf-world', 'cf-links', 'cf-nodes', 'cf-empty', 'cf-empty-new', 'cf-empty-import',
  'cf-zoomer', 'cf-z-in', 'cf-z-out', 'cf-z-fit', 'cf-nav', 'cf-navpop', 'cf-navsearch', 'cf-navlist', 'cf-mini',
  'cf-projname', 'cf-origin', 'cf-count', 'cf-zoomlab', 'cf-saved', 'cf-session', 'cf-mode',
  'cf-banner', 'cf-banner-text', 'cf-banner-retry', 'cf-banner-x', 'cf-toasts', 'cf-modal', 'cf-dialog',
]

/** 从片段里取出内联脚本正文。 */
function inlineScriptOf(fragment) {
  const start = fragment.indexOf('<script>')
  const end = fragment.lastIndexOf('</script>')
  if (start < 0 || end < 0 || end < start) throw new Error('找不到完整的内联 <script>')
  return fragment.slice(start + '<script>'.length, end)
}

/** 提取标记部分的 id（`<style>` 之前）。 */
function markupIds(fragment) {
  const markup = fragment.slice(0, fragment.indexOf('<style>'))
  return [...markup.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1])
}

/**
 * 运行画布文档检查。
 *
 * @param ctx - 套件上下文。
 */
export async function runCanvasDocChecks(ctx) {
  const { pluginRoot, runner } = ctx
  runner.group('画布文档（UI 不显示的第一现场）')

  const fragmentPath = path.join(pluginRoot, 'assets', 'canvas', 'canvas.html')
  let fragment
  await runner.check('DOC-01', '片段结构完整：一个样式块 + 一个内联脚本', async () => {
    const info = await stat(fragmentPath)
    if (info.size === 0) throw new Error('canvas.html 是空文件')
    fragment = await readFile(fragmentPath, 'utf8')
    const scripts = (fragment.match(/<script\b/g) ?? []).length
    const scriptEnds = (fragment.match(/<\/script>/g) ?? []).length
    const styles = (fragment.match(/<style\b/g) ?? []).length
    const styleEnds = (fragment.match(/<\/style>/g) ?? []).length
    if (styles !== 1 || styleEnds !== 1) throw new Error(`样式块数量异常：<style> ${styles} / </style> ${styleEnds}`)
    if (scripts !== 1 || scriptEnds !== 1) throw new Error(`脚本块数量异常：<script> ${scripts} / </script> ${scriptEnds}`)
    if (/<script[^>]+\bsrc\s*=/.test(fragment)) throw new Error('存在外部脚本引用；画布应完全自包含')
    if (/<link[^>]+\bhref\s*=\s*["']https?:/i.test(fragment)) throw new Error('存在外部样式引用；画布应完全自包含')
    return `${(info.size / 1024).toFixed(1)} KB，${fragment.split('\n').length} 行`
  })

  await runner.check('DOC-02', '内联脚本语法合法（语法错误会让整块 UI 不执行）', async () => {
    if (fragment === undefined) throw new Error('片段不可用（见 DOC-01）')
    const script = inlineScriptOf(fragment)
    new vm.Script(script, { filename: 'canvas.html#script' })
    return `${script.split('\n').length} 行脚本通过 V8 解析`
  })

  await runner.check('DOC-03', '启动依赖的 DOM id 齐全且不重复', async () => {
    if (fragment === undefined) throw new Error('片段不可用（见 DOC-01）')
    const ids = markupIds(fragment)
    const seen = new Map()
    for (const id of ids) seen.set(id, (seen.get(id) ?? 0) + 1)
    const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id)
    if (duplicates.length > 0) throw new Error(`标记里重复的 id：${duplicates.join(', ')}`)
    const missing = CRITICAL_IDS.filter((id) => !seen.has(id))
    if (missing.length > 0) throw new Error(`缺少启动依赖的 id：${missing.join(', ')}`)
    return `${CRITICAL_IDS.length} 个关键 id 全部存在`
  })

  await runner.check('DOC-04', '启动链路完整：boot → 首绘 → 同步/事件初始化', async () => {
    if (fragment === undefined) throw new Error('片段不可用（见 DOC-01）')
    const required = [
      ['读取 boot 载荷', /window\.__CF_BOOT__/],
      ['boot() 定义', /function boot\(\)/],
      ['boot() 调用', /^boot\(\);$/m],
      ['主题应用', /applyTheme\(/],
      ['节点首绘', /function renderNodes\(/],
      ['空状态切换', /function updateEmpty\(/],
      ['连线重绘', /function redrawLinks\(/],
      ['视图变换', /function applyView\(/],
      ['宿主轮询', /function startSync\(/],
      ['拖拽初始化', /initDropExtras\(\);/],
      ['功能/耦合初始化', /initCouplingExtras\(\);/],
    ]
    const missing = required.filter(([, pattern]) => !pattern.test(fragment)).map(([label]) => label)
    if (missing.length > 0) throw new Error(`启动链路缺少：${missing.join(', ')}`)
    return `${required.length} 个启动环节全部存在`
  })

  await runner.check('DOC-05', '主题机制完整：首帧属性 + 浅色覆盖 + 宿主消息', async () => {
    if (fragment === undefined) throw new Error('片段不可用（见 DOC-01）')
    if (!/data-cf-theme/.test(fragment)) throw new Error('缺少 data-cf-theme 主题属性')
    if (!/prefers-color-scheme:\s*dark/.test(fragment)) throw new Error('缺少 prefers-color-scheme 回退')
    if (!/codeflow:theme/.test(fragment)) throw new Error('缺少宿主主题消息 codeflow:theme')
    const lightRules = (fragment.match(/html\[data-cf-theme="light"\]/g) ?? []).length
    if (lightRules < 10) throw new Error(`浅色覆盖只有 ${lightRules} 条，疑似主题样式缺失`)
    return `浅色覆盖 ${lightRules} 条`
  })

  const { renderCanvasPage } = await ctx.load('lib/canvas-page.js')

  await runner.check('DOC-06', 'renderCanvasPage：外壳、boot 载荷与宿主铺满样式', async () => {
    const boot = {
      graph: makeGraph('中文 项目'),
      rev: 7,
      view: [10, 20, 1],
      viewport: [10, 20, 1],
      activeView: 'tasks',
      views: { tasks: { available: true }, modules: { available: false } },
      project: '中文 项目',
      sessionId: 'sess-mac',
      sessionTitle: 'CodeFlow · 中文 项目',
      sessionNew: false,
      sessionWarning: null,
      workspace: '/Users/tester/工作 区',
      projectDir: '/Users/tester/工作 区/CodeFlow/flow-projects/中文-项目',
      degraded: null,
      notice: null,
      theme: 'light',
      standalone: false,
    }
    const html = renderCanvasPage(boot)
    if (!html.startsWith('<!doctype html>')) throw new Error('文档没有以 <!doctype html> 开始')
    if (!html.includes('<html lang="zh-CN" data-cf-theme="light">')) throw new Error('html 元素缺少 lang 或主题属性')
    if (!html.includes('<meta charset="utf-8">')) throw new Error('缺少 UTF-8 声明（中文会乱码）')
    if (!html.includes('<title>CodeFlow 画布</title>')) throw new Error('缺少标题')
    if (!html.includes('html body>div#codeflow-canvas{border:0;border-radius:0;width:100%;height:100%;}')) {
      throw new Error('缺少 iframe 内四边铺满的宿主覆盖样式')
    }
    const parsed = bootOf(html)
    if (parsed.project !== boot.project) throw new Error('boot 载荷的 project 字段丢失')
    if (parsed.rev !== boot.rev) throw new Error('boot 载荷的 rev 字段丢失')
    if (JSON.stringify(parsed.graph.project) !== JSON.stringify(boot.graph.project)) throw new Error('boot 载荷的图与输入不一致')
    if ((html.match(/id="codeflow-canvas"/g) ?? []).length !== 1) throw new Error('片段被注入多次')
    if (!html.trimEnd().endsWith('</html>')) throw new Error('文档没有以 </html> 结束')
    return `${(html.length / 1024).toFixed(1)} KB`
  })

  await runner.check('DOC-07', '用户数据里的 </script> 不会截断画布文档', async () => {
    const hostile = '</script><img src=x onerror=alert(1)>'
    const html = renderCanvasPage({
      graph: makeGraph(hostile),
      rev: 1,
      project: hostile,
      notice: `项目 ${hostile}`,
      theme: 'dark',
      standalone: false,
    })
    if (html.includes(`</script><img`)) throw new Error('恶意字符串未经转义就进入文档')
    if (!html.includes('\\u003c/script')) throw new Error('boot JSON 没有把 < 转成 \\u003c')
    const parsed = bootOf(html)
    if (parsed.project !== hostile) throw new Error('转义后 project 无法原样往返')
    return '仍可解析，且 project 原样往返'
  })

  await runner.check('DOC-08', '空图 / 损坏隔离 / 提示横幅的 boot 载荷可传递', async () => {
    const empty = renderCanvasPage({ graph: null, rev: 0, theme: 'dark', standalone: false })
    const emptyBoot = bootOf(empty)
    if (emptyBoot.graph !== null) throw new Error('空图的 graph 应为 null')
    if ((empty.match(/id="cf-empty"/g) ?? []).length !== 1) throw new Error('空状态容器不存在')

    const degraded = renderCanvasPage({
      graph: makeGraph('损坏项目'),
      rev: 3,
      degraded: { reason: 'JSON 解析失败', quarantinedTo: 'workflow.json.bad-123' },
      notice: '未找到可用的 DSH 工作区',
      theme: 'light',
      standalone: false,
    })
    const detail = bootOf(degraded)
    if (detail.degraded?.reason !== 'JSON 解析失败') throw new Error('degraded.reason 未传递')
    if (detail.notice !== '未找到可用的 DSH 工作区') throw new Error('notice 未传递')
    return '空图、degraded 与 notice 均可往返'
  })

  await runner.check('DOC-09', '画布不依赖任何网络资源', async () => {
    if (fragment === undefined) throw new Error('片段不可用（见 DOC-01）')
    const external = [...fragment.matchAll(/\b(?:src|href)\s*=\s*["'](https?:|\/\/)[^"']*/g)].map((match) => match[0])
    if (external.length > 0) throw new Error(`存在外部资源：${external.slice(0, 3).join(', ')}`)
    return '没有外部 script/style/图片引用'
  })
}
