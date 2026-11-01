/**
 * Mac 交互风险扫描。
 *
 * 画布的键盘/指针处理是**行为**，不是纯函数，无法在 Node 里断言"按空格
 * 会不会误触"。但可以静态定位所有平台敏感的入口，并把它们在 macOS 上的
 * 已知风险写进报告——用户复现"假按键"时，手动清单与控制台探针的观测就能
 * 直接对到具体的监听器和行号。
 *
 * 这里只把可判定的三件事做成检查（IME 守卫、触控板滚轮区分、⌘ 快捷键），
 * 其余以"观察"形式输出，不制造假失败。
 *
 * @module tests/mac/checks/risk
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'

/** 取某个字符串在源码里的行号（1 起）。 */
function lineAt(source, index) {
  return source.slice(0, index).split('\n').length
}

/** 找出所有匹配的行号与片段。 */
function occurrences(source, pattern) {
  const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
  const found = []
  for (const match of source.matchAll(regex)) {
    found.push({ line: lineAt(source, match.index), text: match[0].replace(/\s+/g, ' ').slice(0, 120) })
  }
  return found
}

/** 提取一个函数体的近似范围（到下一个行首 `}`）。 */
function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) return undefined
  const end = source.indexOf('\n}', start)
  return { start, body: source.slice(start, end < 0 ? source.length : end) }
}

/**
 * 运行交互风险扫描。
 *
 * @param ctx - 套件上下文。
 */
export async function runRiskChecks(ctx) {
  const { pluginRoot, runner } = ctx
  runner.group('Mac 交互风险扫描（假按键 / 触控板 / 右键 / 拖拽）')

  const canvas = await readFile(path.join(pluginRoot, 'assets', 'canvas', 'canvas.html'), 'utf8')
  const client = await readFile(path.join(pluginRoot, 'lib', 'client.js'), 'utf8')

  await runner.check('RISK-01', '关键交互入口都能定位（扫描结果可信）', async () => {
    const needed = [
      ['键盘', /addEventListener\('keydown',onKey\)/],
      ['滚轮', /function onWheel\(/],
      ['右键', /addEventListener\('contextmenu',onCtx\)/],
      ['指针', /addEventListener\('pointerdown',onDown\)/],
      ['拖入', /addEventListener\('dragenter'/],
      ['放下', /addEventListener\('drop'/],
      ['输入法', /composition|isComposing/],
    ]
    // 输入法守卫**允许缺失**——缺失正是要报告的风险，因此单独计数。
    const found = needed.filter(([, pattern]) => pattern.test(canvas))
    const missing = needed.filter(([label, pattern]) => !pattern.test(canvas) && label !== '输入法').map(([label]) => label)
    if (missing.length > 0) throw new Error(`画布里找不到这些入口：${missing.join(', ')}`)
    return `${found.length}/${needed.length} 个入口可定位`
  })

  const onKey = functionBody(canvas, 'onKey')
  const onWheel = functionBody(canvas, 'onWheel')

  await runner.check('RISK-02', '输入法组合态（isComposing）有守卫', async () => {
    const guard = /isComposing|composition(start|end)/.test(canvas)
    if (!guard) {
      return {
        warn: '键盘处理没有检查 isComposing，也没有监听 compositionstart/end。中文输入法用空格/回车确认候选词时，keydown 会先到达画布；若画布已持有焦点，空格可能触发平移、回车可能触发弹窗。建议用控制台探针 ime() 复现。',
      }
    }
    return '存在组合态守卫'
  })

  await runner.check('RISK-03', '滚轮处理区分触控板双指滚动与捏合缩放', async () => {
    const body = onWheel?.body ?? ''
    const distinguishes = /ctrlKey/.test(body) || /deltaMode/.test(body) || /deltaX/.test(body)
    if (!distinguishes) {
      return {
        warn: 'onWheel 对任何 wheel 事件都以固定 12% 缩放，不看 ctrlKey（macOS 捏合会带 ctrlKey）、不看 deltaMode、也不看 deltaX。触控板双指滚动会变成缩放；纯横向滚动时 deltaY=0 会落入缩小分支。用控制台探针 wheel() 可量化每次滚动的缩放变化。',
      }
    }
    return '有触控板/捏合区分'
  })

  await runner.check('RISK-04', '撤销快捷键包含 macOS 的 ⌘ 组合', async () => {
    const shortcut = occurrences(canvas, /ctrlKey[^\n]{0,40}altKey[^\n]*z/i)[0]
    if (shortcut === undefined) return { warn: '没有找到撤销快捷键；用户只能点按钮' }
    const meta = /metaKey/.test(canvas)
    if (!meta) {
      return {
        warn: `撤销只绑定了 Ctrl+Alt+Z（canvas.html:${shortcut.line}），没有 ⌘Z/⌘⇧Z。Mac 用户按习惯按 ⌘Z 不会得到撤销；而 Ctrl+Alt+Z 在 Mac 上实际是 Control+Option+Z。手动清单 KEY-12 会验证。`,
      }
    }
    return `Ctrl+Alt+Z 与 ⌘ 组合都存在（canvas.html:${shortcut.line}）`
  })

  // -------- 以下是观察，不参与通过/失败统计 --------

  const keydowns = occurrences(canvas, /window\.addEventListener\('keydown'/g)
  const lines = []
  lines.push(`**[高] 触控板滚动即缩放**：\`canvas.html:${onWheel === undefined ? '?' : lineAt(canvas, onWheel.start)}\` 的 onWheel 对所有 wheel 事件缩放；双指滚动没有平移路径，deltaMode/deltaX 未处理。`)
  if (!/isComposing|compositionstart/.test(canvas)) {
    lines.push('**[高] 中文输入法选词**：键盘处理没有 `isComposing` 守卫。输入法确认候选词的空格/回车会进入画布的 keydown；焦点若仍在 iframe 内会被画布消费。')
  }
  if (!/metaKey/.test(canvas)) {
    lines.push('**[中] ⌘Z 不生效**：撤销快捷键只有 Ctrl+Alt+Z；⌘Z / ⌘⇧Z 没有绑定，也没有提示。')
  }
  lines.push('**[中] 空格被画布占用**：`onKey` 在非 input/textarea/select 上对空格 `preventDefault()` 并进入平移模式；画布点击后会保留焦点，用户切回聊天框前按空格不会进入输入框。')
  lines.push('**[中] 焦点留在 iframe**：面板是普通 `<iframe>`（`lib/client.js`），点击画布后焦点在 iframe 内；没有在鼠标离开/宿主输入框聚焦时主动 blur。')
  lines.push(`**[中] 键盘监听共 ${keydowns.length} 处**：${keydowns.map((entry) => `canvas.html:${entry.line}`).join('、')}。其中既有画布快捷键也有浮层导航，排查"假按键"时优先看这些行。`)
  lines.push('**[中] 右键菜单**：`onCtx` 在 canvas 上 `preventDefault()`，但放过了 input/textarea。Mac 的 Control+点击与双指点按都会走 contextmenu；指针按下（button 0）可能先触发平移/清除选择，再弹出菜单。')
  lines.push('**[中] 拖入只取第一个条目**：`onDropImport` 只处理 `items[0]`，多选 Finder 文件时其余直接忽略；`webkitGetAsEntry()` 不可用时回退到单个 File。')
  lines.push('**[中] 拖入覆盖层可能残留**：`dragenter` 用深度计数，`dragleave` 递减；从 iframe 拖回 Finder 或按 Esc 时，若收不到成对的 dragleave，覆盖层会留在画面上（Esc 只清覆盖层，不取消根部计数以外的状态）。')
  lines.push('**[中] Finder 压缩包的元数据**：上传/解压路径不排除 `__MACOSX/._*` 与 `.DS_Store`；扫描层也没有按隐藏名跳过它们（见 ARC-03）。')
  lines.push('**[低] postMessage 使用 `*`**：主题与打开会话的消息没有校验 origin；`codeflow:open-session` 的处理器接受任意来源的消息。不是 Mac 特有，但值得在安全评审里记录。')
  lines.push('**[低] 剪贴板依赖用户手势**：复制会话 id 走 `navigator.clipboard.writeText`；Mac 上首次调用可能被权限/手势策略拒绝，失败时只回复 `copied:false`。')
  lines.push('**[低] contenteditable 未排除**：`onKey` 只放过 input/textarea/select；未来若画布内出现 contenteditable（例如富文本备注），空格/Delete 会再次被抢。')

  runner.note('Mac 交互风险地图（供手动清单与探针对照）', lines)

  // 把每个入口的精确位置也留在报告里。
  const table = [
    ['onKey（键盘）', onKey === undefined ? '未找到' : `canvas.html:${lineAt(canvas, onKey.start)}`],
    ['onWheel（滚轮）', onWheel === undefined ? '未找到' : `canvas.html:${lineAt(canvas, onWheel.start)}`],
    ['onCtx（右键）', canvas.includes('function onCtx') ? `canvas.html:${lineAt(canvas, canvas.indexOf('function onCtx'))}` : '未找到'],
    ['onDown（指针）', canvas.includes('function onDown') ? `canvas.html:${lineAt(canvas, canvas.indexOf('function onDown'))}` : '未找到'],
    ['onDropImport（拖入）', canvas.includes('function onDropImport') ? `canvas.html:${lineAt(canvas, canvas.indexOf('function onDropImport'))}` : '未找到'],
    ['theme 消息', `canvas.html:${lineAt(canvas, canvas.indexOf('codeflow:theme'))}`],
    ['iframe 面板', `lib/client.js:${lineAt(client, client.indexOf("h('iframe'"))}`],
  ]
  runner.note('交互入口位置索引', table.map(([label, where]) => `${label} → ${where}`))
}
