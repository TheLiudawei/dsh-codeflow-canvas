/*
 * CodeFlow 画布 · 按钮真实点击自检（v1.2.2，需求一 B 层）
 * ========================================================
 *
 * 定位与 tests/mac/console-probe.js 相同：**不修改插件文件**的独立 IIFE，
 * 粘贴到 DevTools Console 里运行。它证明的是 A 层（tests/buttons.mjs 静态
 * 审计）证明不了的「点了真的有反应」：
 *
 *   - 自动找到当前窗口或同源 CodeFlow iframe；
 *   - 读取生成器注入的 window.__CF_ACTION_MANIFEST__（没有时退化为枚举 DOM）；
 *   - 逐个点击当前可见的 button / [role="button"]，观察点击前后的可观察变化
 *     （modal / 菜单 / toast / 横幅 / 视图切换 / fetch 请求 / disabled 变化）；
 *   - 破坏性控件（运行、撤销恢复、覆盖、清空、导入提交、设置保存…）默认
 *     skipped，只在 CodeFlowButtonTest.run({ unsafe:true }) 且一次性测试项目
 *     里才执行；
 *   - 结束后恢复现场：关掉所有弹层、切回原视图；不保存、不改图。
 *
 * 用法：
 *
 *   1. DSH 主窗口 DevTools（⌘⌥I / Ctrl+Shift+I）→ Console；
 *      提示 "Don't paste code" 时先输入 `allow pasting` 回车；
 *   2. 打开一个**测试项目**（含模块结构图的更佳），让画布可见；
 *   3. 粘贴本文件全部内容 → 回车（定义 CodeFlowButtonTest）；
 *   4. `await CodeFlowButtonTest.run()`         —— 安全模式（推荐先跑）；
 *      `await CodeFlowButtonTest.run({unsafe:true})` —— 执行破坏性控件；
 *   5. `CodeFlowButtonTest.report()`  打印 Markdown 摘要；
 *      `CodeFlowButtonTest.download()` 下载 codeflow-buttons-<时间>.json。
 *
 * 汇总还会通过 POST /codeflow/api/log 记一条 ui.selftest 事件（日志关闭时
 * 服务端直接丢弃，不报错）。所有数据只存在页面内存里，不上传。
 */
(function () {
  'use strict'

  var VERSION = '1.2.2'
  var previous = window.__CodeFlowButtonTest
  if (previous && previous.dispose) { try { previous.dispose() } catch (e) { /* 忽略 */ } }

  /* ------------------------------------------------------------- 定位 ----- */

  function locate() {
    var selfRoot = document.getElementById('codeflow-canvas')
    if (selfRoot) return { mode: 'canvas-iframe', win: window, doc: document, root: selfRoot }
    var frames = Array.prototype.slice.call(document.querySelectorAll('iframe'))
    for (var i = 0; i < frames.length; i += 1) {
      var frame = frames[i]
      var looksRight = (frame.title && frame.title.indexOf('CodeFlow') >= 0)
        || (frame.src && frame.src.indexOf('/codeflow/canvas') >= 0)
      if (!looksRight) continue
      try {
        var doc = frame.contentDocument
        var root = doc && doc.getElementById('codeflow-canvas')
        if (root) return { mode: 'host-window', win: frame.contentWindow, doc: doc, root: root }
      } catch (error) {
        return { mode: 'cross-origin', win: null, doc: null, root: null, error: String(error) }
      }
    }
    return { mode: 'not-found', win: null, doc: null, root: null }
  }

  /* ------------------------------------------------------- 破坏性清单 ----- */
  /* 这些控件默认 skipped：会唤醒 agent、改配置、删数据或产生项目。unsafe 模式
     且用户确认在一次性测试项目里时才执行。 */
  var DESTRUCTIVE = [
    { match: /cf-tb-runall/, reason: '运行全部会唤醒 agent 消耗 token' },
    { match: /data-run/, reason: '撤销恢复会改写项目文件' },
    { match: /cf-tb-undo/, reason: '撤销对话框本身安全，但恢复动作破坏性——仅对话框开放' },
    { label: /运行|重跑|撤销这次|覆盖|解散|清空|删除/, reason: '破坏性菜单/确认动作' },
    { label: /^导入$|^生成初版$|^开始导入$/, reason: '会创建项目（新建/导入对话框的提交）' },
    { label: /^保存$/, reason: '设置保存会改 CodeFlow 配置' },
    { label: /新建会话|打开会话/, reason: '会话重绑/导航有副作用' },
    { label: /^让 agent 识别$/, reason: '会投递识别请求到画布会话' },
  ]
  /* 需要项目上下文才有意义的控件（无项目时点击只 toast 报错，也算可观察效果）。 */
  var NEEDS_PROJECT = ['cf-tb-save', 'cf-projname', 'cf-tb-coupling', 'cf-vtab-tasks', 'cf-vtab-modules']

  function classifyDestructive(el) {
    var id = el.id || ''
    var act = el.getAttribute('data-act') || el.getAttribute('data-b') || ''
    var label = (el.textContent || '').trim().slice(0, 24)
    for (var i = 0; i < DESTRUCTIVE.length; i += 1) {
      var rule = DESTRUCTIVE[i]
      if (rule.match && rule.match.test(id)) return rule.reason
      if (rule.match && act && rule.match.test(act)) return rule.reason
      if (rule.label && label && rule.label.test(label)) return rule.reason
    }
    return null
  }

  /* ---------------------------------------------------------- 环境探针 --- */

  function createEnv(win) {
    var env = { fetches: [], errors: [], installed: false }
    env.install = function () {
      if (env.installed) return
      env.installed = true
      if (!win.__codeflowSelftestOrigFetch) win.__codeflowSelftestOrigFetch = win.fetch
      var orig = win.__codeflowSelftestOrigFetch
      win.fetch = function () {
        var url = ''
        try { url = String(arguments[0] && arguments[0].url || arguments[0] || '') } catch (e) { /* ignore */ }
        var method = 'GET'
        try { method = String((arguments[1] && arguments[1].method) || 'GET').toUpperCase() } catch (e) { /* ignore */ }
        env.fetches.push({ method: method, path: url.replace(/^https?:\/\/[^/]+/, '') })
        return orig.apply(this, arguments)
      }
      if (!win.__codeflowSelftestOrigError) win.__codeflowSelftestOrigError = win.console.error
      var origError = win.__codeflowSelftestOrigError
      win.console.error = function () {
        try { env.errors.push(Array.prototype.map.call(arguments, String).join(' ').slice(0, 200)) } catch (e) { /* ignore */ }
        return origError.apply(this, arguments)
      }
    }
    env.uninstall = function () {
      if (!env.installed) return
      env.installed = false
      if (win.__codeflowSelftestOrigFetch) { win.fetch = win.__codeflowSelftestOrigFetch }
      if (win.__codeflowSelftestOrigError) { win.console.error = win.__codeflowSelftestOrigError }
    }
    return env
  }

  /* --------------------------------------------------------- 状态快照 ----- */

  function snapshot(doc) {
    var modal = doc.getElementById('cf-modal')
    return {
      modalOpen: !!(modal && !modal.hidden),
      menus: doc.querySelectorAll('.cf-menu').length,
      toasts: doc.querySelectorAll('.cf-toast').length,
      banner: (function () {
        var b = doc.getElementById('cf-banner')
        return b && !b.hidden ? (doc.getElementById('cf-banner-text') || {}).textContent || '' : null
      })(),
      view: (function () {
        var t = doc.getElementById('cf-vtab-tasks')
        var m = doc.getElementById('cf-vtab-modules')
        if (t && t.classList.contains('active')) return 'tasks'
        if (m && m.classList.contains('active')) return 'modules'
        return null
      })(),
      browseOpen: (function () {
        var el = doc.querySelector('.cf-browse')
        return !!(el && !el.hidden)
      })(),
    }
  }

  function diff(before, after) {
    var changes = []
    if (before.modalOpen !== after.modalOpen) changes.push(before.modalOpen ? 'modal-closed' : 'modal-open')
    if (after.menus > before.menus) changes.push('menu-open')
    if (after.menus < before.menus) changes.push('menu-closed')
    if (after.toasts > before.toasts) changes.push('toast')
    if (before.banner !== after.banner) changes.push(after.banner ? 'banner-shown' : 'banner-cleared')
    if (before.view !== after.view && after.view) changes.push('view:' + after.view)
    if (before.browseOpen !== after.browseOpen) changes.push(after.browseOpen ? 'browse-open' : 'browse-closed')
    return changes
  }

  function visible(el) {
    if (!el || !el.getClientRects().length) return false
    var style
    try { style = el.ownerDocument.defaultView.getComputedStyle(el) } catch (e) { return false }
    return style.display !== 'none' && style.visibility !== 'hidden'
  }

  /* 汇报控件的稳定 key：优先清单 key，其次 id / data-act / 文本。 */
  function keyOf(el, manifestIndex) {
    if (el.id && manifestIndex.byId[el.id]) return manifestIndex.byId[el.id].key
    var act = el.getAttribute('data-act') || el.getAttribute('data-b') || ''
    if (act && manifestIndex.bySelector['[data-act="' + act + '"]']) return manifestIndex.bySelector['[data-act="' + act + '"]'].key
    if (act && manifestIndex.bySelector['[data-b="' + act + '"]']) return manifestIndex.bySelector['[data-b="' + act + '"]'].key
    if (el.getAttribute('data-farrow') !== null && manifestIndex.bySelector['.cf-farrow']) return manifestIndex.bySelector['.cf-farrow'].key
    var cls = el.className && String(el.className).split(' ')[0]
    if (cls && manifestIndex.bySelector['.' + cls]) return manifestIndex.bySelector['.' + cls].key
    return el.id ? ('adhoc:' + el.id) : ('adhoc:' + (act || (el.textContent || '').trim().slice(0, 16) || 'unnamed'))
  }

  function surfaceOf(el, manifestIndex) {
    var key = keyOf(el, manifestIndex)
    var entry = manifestIndex.byKey[key]
    if (entry && entry.surface) return entry.surface
    if (key.indexOf(':') > 0) return key.slice(0, key.indexOf(':'))
    return 'adhoc'
  }

  /* ---------------------------------------------------------- 清理现场 --- */

  function cleanup(loc, env) {
    var doc = loc.doc
    var win = loc.win
    var guard = 0
    while (guard < 8) {
      guard += 1
      var modal = doc.getElementById('cf-modal')
      if (modal && !modal.hidden) {
        var closer = modal.querySelector('[data-act="close"],[data-act="cancel"]')
        if (closer && !closer.disabled) { closer.click() } else if (modal) { modal.hidden = true }
        continue
      }
      var menu = doc.querySelector('.cf-menu')
      if (menu) { menu.remove(); continue }
      var browse = doc.querySelector('.cf-browse')
      if (browse && !browse.hidden) {
        var cancel = browse.querySelector('[data-b="cancel"]')
        if (cancel) cancel.click()
        else browse.hidden = true
        continue
      }
      break
    }
    try { win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) } catch (e) { /* ignore */ }
  }

  /* ----------------------------------------------------------- 主流程 ---- */

  var results = []
  var startedAt = null
  var finishedAt = null
  var env = null
  var loc = null

  function currentResults() { return results.slice() }

  async function run(options) {
    options = options || {}
    var unsafe = options.unsafe === true
    var waitMs = typeof options.waitMs === 'number' ? options.waitMs : 350
    loc = locate()
    if (!loc.root || !loc.win) {
      console.error('[CodeFlowButtonTest] 找不到画布：请打开含 CodeFlow 画布的面板后重试。mode=' + loc.mode + (loc.error ? ' error=' + loc.error : ''))
      return currentResults()
    }
    var win = loc.win
    var doc = loc.doc
    env = createEnv(win)
    env.install()
    startedAt = Date.now()
    results = []
    var manifest = null
    try { manifest = win.__CF_ACTION_MANIFEST__ || null } catch (e) { manifest = null }
    var manifestIndex = { byKey: {}, byId: {}, bySelector: {} }
    ;(Array.isArray(manifest) ? manifest : []).forEach(function (entry) {
      manifestIndex.byKey[entry.key] = entry
      if (entry.id) manifestIndex.byId[entry.id] = entry
      if (entry.selector) manifestIndex.bySelector[entry.selector] = entry
    })
    var manifestCount = Object.keys(manifestIndex.byKey).length

    console.log('[CodeFlowButtonTest] v' + VERSION + ' · 画布=' + loc.mode + ' · 清单=' + (manifestCount || '缺失(退化为 DOM 枚举)')
      + ' · 项目=' + (((doc.getElementById('cf-projname') || {}).textContent || '').trim() || '(未命名)')
      + (unsafe ? ' · unsafe=执行破坏性控件' : ' · 安全模式'))
    if (!unsafe) {
      console.log('[CodeFlowButtonTest] 破坏性控件将 skipped；要连它们一起跑：await CodeFlowButtonTest.run({unsafe:true})（请先确认画布上是测试项目）')
    }

    var originalView = snapshot(doc).view
    var els = Array.prototype.slice.call(doc.querySelectorAll('button, [role="button"]'))
    var seen = new Set()
    var queue = []
    for (var i = 0; i < els.length; i += 1) {
      var el = els[i]
      var key = keyOf(el, manifestIndex)
      if (seen.has(key)) continue
      seen.add(key)
      queue.push(el)
    }

    for (var q = 0; q < queue.length; q += 1) {
      var control = queue[q]
      var k = keyOf(control, manifestIndex)
      var surface = surfaceOf(control, manifestIndex)
      var record = {
        key: k,
        surface: surface,
        label: (control.textContent || '').trim().slice(0, 30) || control.getAttribute('aria-label') || '',
        outcome: 'no-effect',
        evidence: '',
        fetches: 0,
      }
      if (!visible(control)) {
        record.outcome = 'hidden'
        record.evidence = '控件不可见（视图/宿主状态下按设计隐藏）'
        results.push(record)
        continue
      }
      if (control.disabled) {
        record.outcome = 'disabled'
        record.evidence = control.getAttribute('data-tooltip') || 'disabled（有 data-tooltip 说明状态按设计维护）'
        results.push(record)
        continue
      }
      var destructiveReason = classifyDestructive(control)
      if (destructiveReason && !unsafe) {
        record.outcome = 'skipped'
        record.evidence = destructiveReason
        results.push(record)
        continue
      }
      var pre = snapshot(doc)
      env.fetches.length = 0
      var preDisabled = control.disabled
      try {
        control.click()
      } catch (error) {
        record.outcome = 'error'
        record.evidence = 'click() 抛错：' + String(error)
        results.push(record)
        cleanup(loc, env)
        continue
      }
      await new Promise(function (resolve) { setTimeout(resolve, waitMs) })
      var post = snapshot(doc)
      var changes = diff(pre, post)
      record.fetches = env.fetches.length
      var fetchPaths = env.fetches.map(function (f) { return f.method + ' ' + f.path }).slice(0, 4)
      if (env.errors.length > 0) {
        record.outcome = 'error'
        record.evidence = 'console.error: ' + env.errors[0]
      } else if (changes.length > 0) {
        record.outcome = 'triggered'
        record.evidence = changes.join(',') + (fetchPaths.length ? (' · ' + fetchPaths.join(' | ')) : '')
      } else if (env.fetches.length > 0) {
        record.outcome = 'triggered'
        record.evidence = 'fetch: ' + fetchPaths.join(' | ')
      } else if (control.disabled && !preDisabled) {
        record.outcome = 'no-effect'
        record.evidence = '点击后被置 disabled（防重入）——视为有响应'
        record.outcome = 'triggered'
      } else {
        record.outcome = 'no-effect'
        record.evidence = NEEDS_PROJECT.indexOf(k) >= 0 ? '未打开项目时的分支（先打开测试项目重试）' : '无可观察变化'
      }
      results.push(record)
      cleanup(loc, env)
      await new Promise(function (resolve) { setTimeout(resolve, 60) })
    }

    /* 恢复：关弹层（cleanup 已做）；切回原视图。 */
    var now = snapshot(doc)
    if (originalView && now.view && originalView !== now.view) {
      var tab = doc.getElementById('cf-vtab-' + originalView)
      if (tab && visible(tab) && !tab.disabled) tab.click()
    }
    finishedAt = Date.now()
    env.uninstall()
    summarize()
    await reportToLog()
    return currentResults()
  }

  /* ----------------------------------------------------------- 输出 ------ */

  function summarize() {
    var counts = {}
    results.forEach(function (r) { counts[r.outcome] = (counts[r.outcome] || 0) + 1 })
    console.log('[CodeFlowButtonTest] 结果：' + JSON.stringify(counts) + '（共 ' + results.length + ' 个控件）')
    try { console.table(results.map(function (r) {
      return { key: r.key, surface: r.surface, label: r.label, outcome: r.outcome, evidence: String(r.evidence).slice(0, 90) }
    })) } catch (e) { results.forEach(function (r) { console.log('  ' + r.outcome.padEnd(10) + ' ' + r.key + ' — ' + r.evidence) }) }
    var bad = results.filter(function (r) { return r.outcome === 'no-effect' || r.outcome === 'error' })
    if (bad.length) {
      console.log('[CodeFlowButtonTest] ⚠ 以下控件点击无可观察效果或报错（先确认前置条件，再对照 MANUAL-CHECKLIST）：')
      bad.forEach(function (r) { console.log('   ' + r.outcome.toUpperCase() + ' ' + r.key + ' — ' + r.evidence) })
    }
  }

  function markdown() {
    var lines = ['# CodeFlow 画布按钮自检（v' + VERSION + '）', '',
      '- 时间：' + new Date(startedAt || Date.now()).toISOString(),
      '- 结果：' + results.length + ' 个控件', '',
      '| key | surface | label | outcome | evidence |', '| --- | --- | --- | --- | --- |']
    results.forEach(function (r) {
      lines.push('| ' + r.key + ' | ' + r.surface + ' | ' + r.label.replace(/\|/g, '\\|') + ' | ' + r.outcome + ' | ' + String(r.evidence).replace(/\|/g, '\\|').slice(0, 120) + ' |')
    })
    return lines.join('\n')
  }

  function download() {
    var payload = JSON.stringify({ version: VERSION, startedAt: startedAt, finishedAt: finishedAt, results: results, markdown: markdown() }, null, 2)
    var blob = new Blob([payload], { type: 'application/json' })
    var a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'codeflow-buttons-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.json'
    ;(loc && loc.doc.body || document.body).appendChild(a)
    a.click()
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove() }, 2000)
    console.log('[CodeFlowButtonTest] 已下载 JSON 报告')
  }

  /** 把一条汇总写进插件文件日志（ui.selftest 白名单事件；日志关闭时服务端丢弃）。 */
  async function reportToLog() {
    try {
      var counts = {}
      results.forEach(function (r) { counts[r.outcome] = (counts[r.outcome] || 0) + 1 })
      await fetch('/codeflow/api/log', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({ events: [{ event: 'ui.selftest', level: 'info', msg: 'canvas button selftest', data: {
          total: results.length,
          triggered: counts.triggered || 0,
          noEffect: counts['no-effect'] || 0,
          disabled: counts.disabled || 0,
          hidden: counts.hidden || 0,
          skipped: counts.skipped || 0,
          error: counts.error || 0,
          durationMs: (finishedAt || Date.now()) - (startedAt || Date.now()),
        } }] }),
      })
    } catch (e) { /* 日志上报失败静默：不应打断自检 */ }
  }

  window.CodeFlowButtonTest = {
    version: VERSION,
    run: run,
    report: function () { console.log(markdown()) },
    download: download,
    results: currentResults,
    dispose: function () { if (env) env.uninstall() },
  }
  console.log('[CodeFlowButtonTest] 已就绪（v' + VERSION + '）：await CodeFlowButtonTest.run() 开始安全模式自检')
})()
