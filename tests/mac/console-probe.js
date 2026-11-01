/**
 * CodeFlow 画布 · 浏览器控制台探针（macOS 现场观测用）
 * ====================================================
 *
 * 这段脚本不修改插件、不注入插件代码，只在运行时**旁听**：
 *
 *   - UI 是否真的渲染出来（尺寸、可见性、节点/连线/图标、boot 载荷）；
 *   - 按键去了哪里（目标是聊天框还是画布？是否被画布 preventDefault？）；
 *   - 中文输入法组合态下的空格/回车是否被画布消费；
 *   - 触控板双指滚动是否被当成缩放（以及每次缩放了多少）；
 *   - 右键 / Control+点击 / 双指点按是否弹出画布菜单；
 *   - 从 Finder 拖入时浏览器到底给了什么（目录条目还是文件、名字是否 NFD）。
 *
 * 用法（两种上下文都支持）：
 *
 *   1. 在 DSH 主窗口打开 DevTools（⌘⌥I），Console 里粘贴本文件全部内容；
 *   2. 运行 `CodeFlowProbe.ui()` 先看 UI 诊断；
 *   3. 运行 `CodeFlowProbe.start()` 开始记录；
 *   4. 按 MANUAL-CHECKLIST 的步骤操作（打字、选词、双指滚动、右键、拖文件）；
 *   5. 运行 `CodeFlowProbe.download()` 保存 `codeflow-probe-*.json`；
 *      或 `CodeFlowProbe.report()` 打印并把 JSON 复制到剪贴板。
 *
 * 如果控制台提示 "Don't paste code"，先在 Console 里输入 `allow pasting`
 * 回车（Chromium 的粘贴保护），或把本文件保存为 DevTools → Sources →
 * Snippets 里的片段再运行。
 *
 * 所有数据只存在页面内存里，不上传、不写 localStorage。
 */
(function () {
  'use strict';

  var VERSION = '1.0.0';
  var MAX_LOG = 300;
  var previous = window.__CodeFlowProbeInternal;

  /** 找到画布文档：优先当前上下文，其次主窗口里的 CodeFlow iframe。 */
  function locate() {
    var selfRoot = document.getElementById('codeflow-canvas');
    if (selfRoot) {
      return { mode: 'canvas-iframe', win: window, doc: document, root: selfRoot, frame: null };
    }
    var frames = Array.prototype.slice.call(document.querySelectorAll('iframe'));
    for (var i = 0; i < frames.length; i += 1) {
      var frame = frames[i];
      var looksRight = (frame.title && frame.title.indexOf('CodeFlow') >= 0)
        || (frame.src && frame.src.indexOf('/codeflow/canvas') >= 0);
      if (!looksRight) continue;
      try {
        var doc = frame.contentDocument;
        var root = doc && doc.getElementById('codeflow-canvas');
        if (root) {
          return { mode: 'host-window', win: frame.contentWindow, doc: doc, root: root, frame: frame };
        }
      } catch (error) {
        return { mode: 'cross-origin', win: null, doc: null, root: null, frame: frame, error: String(error && error.message || error) };
      }
    }
    return { mode: 'not-found', win: null, doc: null, root: null, frame: null };
  }

  function now() { return new Date().toISOString(); }

  function round(value) { return Math.round(Number(value) * 100) / 100; }

  function textOf(doc, selector) {
    var el = doc.querySelector(selector);
    return el ? String(el.textContent || '').trim() : null;
  }

  function rectOf(el) {
    if (!el) return null;
    var rect = el.getBoundingClientRect();
    return {
      x: round(rect.x), y: round(rect.y),
      width: round(rect.width), height: round(rect.height),
      top: round(rect.top), left: round(rect.left),
    };
  }

  function stylesOf(el, props) {
    if (!el) return null;
    var computed = el.ownerDocument.defaultView.getComputedStyle(el);
    var out = {};
    for (var i = 0; i < props.length; i += 1) out[props[i]] = computed.getPropertyValue(props[i]);
    return out;
  }

  function summarizeTarget(target) {
    if (!target || !target.tagName) return null;
    var tag = String(target.tagName).toLowerCase();
    var editable = tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable === true;
    return {
      tag: tag,
      id: target.id || null,
      cls: typeof target.className === 'string' ? target.className.slice(0, 80) : null,
      editable: editable,
      inCanvas: !!(target.closest && target.closest('#codeflow-canvas')),
      text: editable ? null : String(target.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
    };
  }

  /** 画布的可观测状态快照；用于比较一次事件前后的变化。 */
  function canvasState(win, doc) {
    if (!win || !doc) return null;
    var root = doc.getElementById('codeflow-canvas');
    var world = doc.getElementById('cf-world');
    var modal = doc.getElementById('cf-modal');
    return {
      nodes: doc.querySelectorAll('#cf-nodes .cf-node').length,
      links: doc.querySelectorAll('#cf-links .cf-link').length,
      menus: doc.querySelectorAll('.cf-menu').length,
      zoom: textOf(doc, '#cf-zoomlab'),
      worldTransform: world ? world.style.transform : null,
      rootClass: root ? root.className : null,
      modalHidden: modal ? modal.hidden === true : null,
      active: (function () {
        var active = doc.activeElement;
        return active ? { tag: String(active.tagName || '').toLowerCase(), id: active.id || null } : null;
      })(),
    };
  }

  function diff(before, after) {
    if (!before || !after) return null;
    var out = {};
    var keys = ['nodes', 'links', 'menus', 'zoom', 'worldTransform', 'rootClass', 'modalHidden'];
    for (var i = 0; i < keys.length; i += 1) {
      var key = keys[i];
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) out[key] = { before: before[key], after: after[key] };
    }
    return Object.keys(out).length ? out : null;
  }

  var state = {
    version: VERSION,
    startedAt: null,
    installed: false,
    mode: null,
    keys: [],
    ime: [],
    wheel: [],
    ctx: [],
    drop: [],
    focus: [],
    errors: [],
    listeners: [],
  };

  function push(list, entry) {
    list.push(entry);
    if (list.length > MAX_LOG) list.splice(0, list.length - MAX_LOG);
  }

  function isEditableEvent(e) {
    var target = e.target;
    if (!target || !target.tagName) return false;
    var tag = String(target.tagName).toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable === true;
  }

  /* ------------------------------------------------------------ UI ---- */

  function ui() {
    var loc = locate();
    if (!loc.win || !loc.doc) {
      return {
        ok: false,
        mode: loc.mode,
        error: loc.error || '没有找到 CodeFlow 画布。请先打开 CodeFlow 面板，或在画布 iframe 的 DevTools 上下文里运行。',
        candidates: Array.prototype.slice.call(document.querySelectorAll('iframe')).map(function (frame) {
          return { title: frame.title || null, src: frame.src || null };
        }),
        framesInDocument: document.querySelectorAll('iframe').length,
      };
    }
    var win = loc.win;
    var doc = loc.doc;
    var root = loc.root;
    var boot = win.__CF_BOOT__ && typeof win.__CF_BOOT__ === 'object' ? win.__CF_BOOT__ : null;
    var empty = doc.getElementById('cf-empty');
    var frameRect = loc.frame ? rectOf(loc.frame) : null;
    var rootRect = rectOf(root);
    var stageRect = rectOf(doc.getElementById('cf-stage'));
    var nodeEls = doc.querySelectorAll('#cf-nodes .cf-node');
    var zeroNodes = 0;
    for (var i = 0; i < nodeEls.length; i += 1) {
      var nodeRect = nodeEls[i].getBoundingClientRect();
      if (nodeRect.width === 0 || nodeRect.height === 0) zeroNodes += 1;
    }
    var toolbarButtons = doc.querySelectorAll('#codeflow-canvas .cf-tbtn');
    var visibleButtons = 0;
    for (var j = 0; j < toolbarButtons.length; j += 1) {
      var buttonRect = toolbarButtons[j].getBoundingClientRect();
      if (buttonRect.width > 0 && buttonRect.height > 0) visibleButtons += 1;
    }
    var lucideLeft = doc.querySelectorAll('#codeflow-canvas [data-lucide]').length;
    var problems = [];
    if (!boot) problems.push('没有 window.__CF_BOOT__：这份文档不是宿主注入的画布，或是旧缓存/手工打开的文件。');
    if (rootRect && (rootRect.width === 0 || rootRect.height === 0)) problems.push('画布根节点尺寸为 0（iframe 高度塌陷或 display:none）。');
    if (stageRect && (stageRect.width === 0 || stageRect.height === 0)) problems.push('画布 stage 尺寸为 0，节点不可能可见。');
    if (visibleButtons === 0) problems.push('工具栏按钮全部不可见。');
    if (lucideLeft > 0) problems.push('工具栏仍有 ' + lucideLeft + ' 个未替换的 data-lucide 图标：内联脚本可能没有执行完（语法错误/被 CSP 拦截）。');
    if (boot && boot.graph && Array.isArray(boot.graph.nodes) && boot.graph.nodes.length > 0 && nodeEls.length === 0) {
      problems.push('boot 里有 ' + boot.graph.nodes.length + ' 个节点，但 DOM 里一个 .cf-node 都没有：首绘失败或节点被 CSS 隐藏。');
    }
    if (zeroNodes > 0) problems.push(zeroNodes + ' 个节点卡片的宽或高为 0。');
    if (boot && boot.graph && boot.graph.nodes && boot.graph.nodes.length === 0 && empty && empty.hidden) {
      problems.push('空图时 #cf-empty 仍是 hidden：空状态没有显示出来。');
    }
    if (!boot && empty && empty.hidden && nodeEls.length === 0) problems.push('既没有 boot 也没有空状态：画布看起来会是全空白。');
    var bannerText = textOf(doc, '#cf-banner-text');
    var banner = doc.getElementById('cf-banner');
    if (banner && banner.hidden === false && bannerText) problems.push('横幅显示：' + bannerText);

    var computedRoot = stylesOf(root, ['display', 'visibility', 'opacity', 'background-color', 'color', 'font-family', 'font-size', 'height', 'position']);
    var htmlStyle = stylesOf(doc.documentElement, ['color-scheme', 'background-color']);
    var cssVars = null;
    try {
      var rootComputed = win.getComputedStyle(root);
      cssVars = {
        bg: rootComputed.getPropertyValue('--cf-bg').trim(),
        stage: rootComputed.getPropertyValue('--cf-stage').trim(),
        text: rootComputed.getPropertyValue('--cf-text').trim(),
        accent: rootComputed.getPropertyValue('--cf-accent').trim(),
      };
    } catch (error) {
      cssVars = null;
    }

    return {
      ok: true,
      capturedAt: now(),
      mode: loc.mode,
      url: loc.doc.location ? loc.doc.location.href : null,
      readyState: doc.readyState,
      boot: boot ? {
        keys: Object.keys(boot),
        project: boot.project || (boot.graph && boot.graph.project && boot.graph.project.name) || null,
        rev: boot.rev,
        activeView: boot.activeView,
        theme: boot.theme,
        nodeCount: boot.graph && Array.isArray(boot.graph.nodes) ? boot.graph.nodes.length : null,
        linkCount: boot.graph && Array.isArray(boot.graph.links) ? boot.graph.links.length : null,
        views: boot.views || null,
        hasSession: typeof boot.sessionId === 'string' && boot.sessionId.length > 0,
        sessionWarning: boot.sessionWarning || null,
        workspace: boot.workspace || null,
        projectDir: boot.projectDir || null,
        degraded: boot.degraded || null,
        notice: boot.notice || null,
      } : null,
      dom: {
        rootRect: rootRect,
        stageRect: stageRect,
        iframeRect: frameRect,
        nodes: nodeEls.length,
        zeroSizeNodes: zeroNodes,
        links: doc.querySelectorAll('#cf-links .cf-link').length,
        linkHits: doc.querySelectorAll('.cf-link-hit').length,
        toolbarButtons: toolbarButtons.length,
        visibleToolbarButtons: visibleButtons,
        icons: doc.querySelectorAll('#codeflow-canvas .cf-tbtn svg').length,
        unlucide: lucideLeft,
        emptyHidden: empty ? empty.hidden === true : null,
        emptyRect: empty ? rectOf(empty) : null,
        bannerHidden: banner ? banner.hidden === true : null,
        bannerText: bannerText,
        modalHidden: doc.getElementById('cf-modal') ? doc.getElementById('cf-modal').hidden === true : null,
        toasts: doc.querySelectorAll('.cf-toasts > *').length,
        projectName: textOf(doc, '#cf-projname'),
        count: textOf(doc, '#cf-count'),
        zoom: textOf(doc, '#cf-zoomlab'),
        saved: textOf(doc, '#cf-saved'),
        modeTag: textOf(doc, '#cf-mode'),
      },
      styles: {
        root: computedRoot,
        html: htmlStyle,
        themeAttr: doc.documentElement.getAttribute('data-cf-theme'),
        cssVars: cssVars,
      },
      viewport: {
        winWidth: win.innerWidth,
        winHeight: win.innerHeight,
        clientWidth: doc.documentElement.clientWidth,
        clientHeight: doc.documentElement.clientHeight,
        scrollWidth: Math.max(doc.documentElement.scrollWidth, doc.body ? doc.body.scrollWidth : 0),
        scrollHeight: Math.max(doc.documentElement.scrollHeight, doc.body ? doc.body.scrollHeight : 0),
        devicePixelRatio: win.devicePixelRatio,
        screen: { width: win.screen && win.screen.width, height: win.screen && win.screen.height },
      },
      focus: {
        documentHasFocus: doc.hasFocus ? doc.hasFocus() : null,
        active: summarizeTarget(doc.activeElement),
        hostActive: loc.mode === 'host-window' && document.activeElement ? summarizeTarget(document.activeElement) : null,
      },
      agents: {
        userAgent: win.navigator.userAgent,
        platform: win.navigator.platform,
        language: win.navigator.language,
        languages: win.navigator.languages,
      },
      problems: problems,
    };
  }

  /* --------------------------------------------------- 记录器安装 ---- */

  function addListener(targetWin, type, handler, options) {
    var useCapture = options === true;
    targetWin.addEventListener(type, handler, useCapture);
    state.listeners.push(function () {
      try { targetWin.removeEventListener(type, handler, useCapture); } catch (error) { /* 页面已卸载 */ }
    });
  }

  function attach(win, doc) {
    // 键盘：捕获阶段先看到事件，再等一拍看画布是否 preventDefault。
    addListener(win, 'keydown', function (event) {
      var before = canvasState(win, doc);
      var target = summarizeTarget(event.target);
      var entry = {
        at: now(),
        key: event.key,
        code: event.code,
        keyCode: event.keyCode,
        repeat: event.repeat === true,
        isComposing: event.isComposing === true || event.keyCode === 229,
        ctrl: event.ctrlKey, meta: event.metaKey, alt: event.altKey, shift: event.shiftKey,
        target: target,
        editable: isEditableEvent(event),
        preventedAtCapture: event.defaultPrevented,
        inCanvas: !!(target && target.inCanvas),
      };
      setTimeout(function () {
        entry.preventedAfter = event.defaultPrevented;
        entry.changed = diff(before, canvasState(win, doc));
        entry.after = entry.changed ? null : undefined;
      }, 30);
      push(state.keys, entry);
    }, true);

    addListener(win, 'keyup', function (event) {
      if (event.key === ' ' || event.key === 'Escape' || event.metaKey || event.ctrlKey || event.altKey) {
        push(state.keys, {
          at: now(), type: 'keyup', key: event.key, code: event.code,
          ctrl: event.ctrlKey, meta: event.metaKey, alt: event.altKey,
          target: summarizeTarget(event.target), editable: isEditableEvent(event),
        });
      }
    }, true);

    // 输入法：组合开始/更新/结束，以及组合态内到达的按键。
    addListener(win, 'compositionstart', function (event) {
      push(state.ime, { at: now(), type: 'compositionstart', data: event.data, target: summarizeTarget(event.target) });
    }, true);
    addListener(win, 'compositionupdate', function (event) {
      push(state.ime, { at: now(), type: 'compositionupdate', data: String(event.data || '').slice(0, 40), target: summarizeTarget(event.target) });
    }, true);
    addListener(win, 'compositionend', function (event) {
      push(state.ime, { at: now(), type: 'compositionend', data: String(event.data || '').slice(0, 40), target: summarizeTarget(event.target) });
    }, true);

    // 触控板/滚轮：捕获前后缩放标签，直接量化"滚动被当成缩放"。
    addListener(win, 'wheel', function (event) {
      var before = canvasState(win, doc);
      var entry = {
        at: now(),
        deltaX: round(event.deltaX),
        deltaY: round(event.deltaY),
        deltaZ: round(event.deltaZ),
        deltaMode: event.deltaMode,
        ctrl: event.ctrlKey === true,
        meta: event.metaKey === true,
        target: summarizeTarget(event.target),
        zoomBefore: before && before.zoom,
      };
      setTimeout(function () {
        var after = canvasState(win, doc);
        entry.zoomAfter = after && after.zoom;
        entry.zoomChanged = !!(entry.zoomBefore && entry.zoomAfter && entry.zoomBefore !== entry.zoomAfter);
        entry.transformChanged = !!(before && after && before.worldTransform !== after.worldTransform);
        entry.preventedAfter = event.defaultPrevented;
        entry.changed = diff(before, after);
      }, 0);
      push(state.wheel, entry);
    }, true);

    // 右键 / Control+点击 / 双指点按。
    addListener(win, 'contextmenu', function (event) {
      var before = canvasState(win, doc);
      var entry = {
        at: now(),
        button: event.button,
        ctrl: event.ctrlKey === true,
        target: summarizeTarget(event.target),
        preventedAtCapture: event.defaultPrevented,
      };
      setTimeout(function () {
        var after = canvasState(win, doc);
        entry.preventedAfter = event.defaultPrevented;
        entry.menus = after ? after.menus : null;
        entry.changed = diff(before, after);
      }, 30);
      push(state.ctx, entry);
    }, true);

    addListener(win, 'pointerdown', function (event) {
      if (event.button === 0 && event.ctrlKey !== true) return; // 只看右键/Control+点击
      push(state.ctx, {
        at: now(), type: 'pointerdown', button: event.button, ctrl: event.ctrlKey === true,
        meta: event.metaKey === true, target: summarizeTarget(event.target),
      });
    }, true);

    // 拖拽：浏览器到底交付了什么。
    function dragEntry(event, type) {
      var transfer = event.dataTransfer;
      var entry = {
        at: now(), type: type,
        types: transfer ? Array.prototype.slice.call(transfer.types || []) : null,
        items: [],
        files: [],
        preventedAtCapture: event.defaultPrevented,
        overlay: (function () {
          var overlay = doc.querySelector('.cf-drop-overlay');
          return overlay ? { hidden: overlay.hidden === true, text: String(overlay.textContent || '').slice(0, 60) } : null;
        })(),
      };
      if (transfer) {
        if (transfer.items) {
          for (var i = 0; i < transfer.items.length && i < 20; i += 1) {
            var item = transfer.items[i];
            var described = { kind: item.kind, type: item.type };
            try {
              var itemEntry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
              described.entry = itemEntry ? { name: itemEntry.name, isDirectory: itemEntry.isDirectory === true, isFile: itemEntry.isFile === true } : null;
            } catch (error) {
              described.entryError = String(error && error.message || error);
            }
            entry.items.push(described);
          }
        }
        if (transfer.files) {
          for (var j = 0; j < transfer.files.length && j < 20; j += 1) {
            var file = transfer.files[j];
            entry.files.push({ name: file.name, size: file.size, type: file.type, path: file.path || null });
          }
        }
      }
      setTimeout(function () {
        entry.preventedAfter = event.defaultPrevented;
        var afterOverlay = doc.querySelector('.cf-drop-overlay');
        entry.overlayAfter = afterOverlay ? { hidden: afterOverlay.hidden === true } : null;
      }, 60);
      push(state.drop, entry);
    }
    addListener(win, 'dragenter', function (event) { dragEntry(event, 'dragenter'); }, true);
    addListener(win, 'dragover', function (event) { dragEntry(event, 'dragover'); }, true);
    addListener(win, 'drop', function (event) { dragEntry(event, 'drop'); }, true);

    // 焦点：谁拿走了键盘。
    addListener(win, 'focusin', function (event) {
      push(state.focus, { at: now(), type: 'focusin', target: summarizeTarget(event.target) });
    }, true);
    addListener(win, 'focusout', function (event) {
      push(state.focus, { at: now(), type: 'focusout', target: summarizeTarget(event.target) });
    }, true);
    addListener(win, 'blur', function () {
      push(state.focus, { at: now(), type: 'window-blur' });
    }, true);
    addListener(win, 'focus', function () {
      push(state.focus, { at: now(), type: 'window-focus' });
    }, true);
  }

  function attachErrors(win) {
    addListener(win, 'error', function (event) {
      push(state.errors, {
        at: now(), type: 'error',
        message: event.message,
        filename: event.filename,
        lineno: event.lineno, colno: event.colno,
        stack: event.error && event.error.stack ? String(event.error.stack).slice(0, 800) : null,
      });
    }, true);
    addListener(win, 'unhandledrejection', function (event) {
      var reason = event.reason;
      push(state.errors, {
        at: now(), type: 'unhandledrejection',
        message: reason && reason.message ? reason.message : String(reason),
        stack: reason && reason.stack ? String(reason.stack).slice(0, 800) : null,
      });
    }, true);
  }

  function start() {
    if (state.installed) {
      return { ok: true, already: true, listeners: state.listeners.length, mode: state.mode };
    }
    var loc = locate();
    if (!loc.win) return { ok: false, error: loc.error || '没有找到画布；请先打开 CodeFlow 面板。' };
    state.mode = loc.mode;
    state.startedAt = now();
    attach(loc.win, loc.doc);
    attachErrors(loc.win);
    if (loc.win !== window) {
      // 从主窗口运行时，同时盯住宿主窗口：按键可能根本没进 iframe。
      attach(window, document);
      attachErrors(window);
    }
    state.installed = true;
    return { ok: true, mode: state.mode, listeners: state.listeners.length };
  }

  function stop() {
    for (var i = 0; i < state.listeners.length; i += 1) {
      try { state.listeners[i](); } catch (error) { /* 忽略 */ }
    }
    state.listeners = [];
    state.installed = false;
    return { ok: true, stopped: true };
  }

  function clear() {
    state.keys = []; state.ime = []; state.wheel = []; state.ctx = []; state.drop = []; state.focus = []; state.errors = [];
    return { ok: true };
  }

  /* --------------------------------------------------------- 报告 ---- */

  function summaryOf() {
    var loc = locate();
    var win = loc.win;
    var doc = loc.doc;
    var wheelZoom = state.wheel.filter(function (entry) { return entry.zoomChanged === true; });
    var wheelHorizontal = state.wheel.filter(function (entry) { return entry.deltaY === 0 && entry.deltaX !== 0; });
    var imeKeys = state.keys.filter(function (entry) { return entry.isComposing === true || entry.repeat === true; });
    var preventedKeys = state.keys.filter(function (entry) { return entry.preventedAfter === true; });
    return {
      mode: state.mode,
      startedAt: state.startedAt,
      endedAt: now(),
      counts: {
        keys: state.keys.length,
        ime: state.ime.length,
        wheel: state.wheel.length,
        contextmenu: state.ctx.length,
        drag: state.drop.length,
        focus: state.focus.length,
        errors: state.errors.length,
      },
      findings: {
        keysPreventedByCanvas: preventedKeys.length,
        keysDuringComposition: imeKeys.length,
        wheelEvents: state.wheel.length,
        wheelEventsThatZoomed: wheelZoom.length,
        horizontalWheelEvents: wheelHorizontal.length,
        wheelWithCtrlKey: state.wheel.filter(function (entry) { return entry.ctrl === true; }).length,
        dragDeliveredDirectoryEntry: state.drop.some(function (entry) {
          return (entry.items || []).some(function (item) { return item.entry && item.entry.isDirectory === true; });
        }),
        dragDeliveredNoItems: state.drop.some(function (entry) {
          return entry.type === 'drop' && (entry.items || []).length === 0 && (entry.files || []).length === 0;
        }),
        focusInCanvas: state.focus.filter(function (entry) {
          return entry.type === 'focusin' && entry.target && entry.target.inCanvas === true;
        }).length,
      },
      activeElement: win && doc ? summarizeTarget(doc.activeElement) : null,
      hostActiveElement: loc.mode === 'host-window' ? summarizeTarget(document.activeElement) : null,
      lastError: state.errors.length ? state.errors[state.errors.length - 1] : null,
    };
  }

  function report() {
    var payload = {
      probe: 'codeflow-canvas-macos',
      version: VERSION,
      capturedAt: now(),
      ui: ui(),
      summary: summaryOf(),
      logs: {
        keys: state.keys,
        ime: state.ime,
        wheel: state.wheel,
        contextmenu: state.ctx,
        drag: state.drop,
        focus: state.focus,
        errors: state.errors,
      },
    };
    var json = JSON.stringify(payload, null, 2);
    // 控制台里先给一段人看的摘要，再给完整 JSON。
    console.log('%c[CodeFlowProbe] 摘要', 'font-weight:bold');
    console.log(payload.summary);
    console.log('%c[CodeFlowProbe] 完整 JSON（已尝试复制到剪贴板）', 'font-weight:bold');
    console.log(json);
    copyText(json);
    return payload;
  }

  function copyText(text) {
    function fallback() {
      try {
        var area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(area);
        return ok;
      } catch (error) {
        return false;
      }
    }
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(text).then(function () {
          console.log('[CodeFlowProbe] 已复制到剪贴板');
        }, function () {
          console.log('[CodeFlowProbe] 剪贴板写入被拒绝，请使用 CodeFlowProbe.download() 保存文件');
        });
        return;
      }
    } catch (error) {
      // 落到 execCommand。
    }
    var ok = fallback();
    console.log(ok ? '[CodeFlowProbe] 已复制到剪贴板（execCommand）' : '[CodeFlowProbe] 复制失败，请使用 CodeFlowProbe.download()');
  }

  function download() {
    var payload = {
      probe: 'codeflow-canvas-macos',
      version: VERSION,
      capturedAt: now(),
      ui: ui(),
      summary: summaryOf(),
      logs: {
        keys: state.keys, ime: state.ime, wheel: state.wheel,
        contextmenu: state.ctx, drag: state.drop, focus: state.focus, errors: state.errors,
      },
    };
    var text = JSON.stringify(payload, null, 2);
    var blob = new Blob([text], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var anchor = document.createElement('a');
    var stamp = new Date().toISOString().replace(/[:.]/g, '-');
    anchor.href = url;
    anchor.download = 'codeflow-probe-' + stamp + '.json';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
    console.log('[CodeFlowProbe] 已生成 ' + anchor.download + '（在浏览器下载目录）');
    return anchor.download;
  }

  function help() {
    console.log([
      'CodeFlowProbe v' + VERSION,
      '  CodeFlowProbe.ui()        —— 立即采集 UI 诊断（尺寸、节点、图标、boot、问题清单）',
      '  CodeFlowProbe.start()     —— 开始记录键盘/输入法/滚轮/右键/拖拽/焦点/报错',
      '  CodeFlowProbe.stop()      —— 停止记录',
      '  CodeFlowProbe.clear()     —— 清空已记录条目',
      '  CodeFlowProbe.report()    —— 打印摘要与完整 JSON，并尝试复制到剪贴板',
      '  CodeFlowProbe.download()  —— 下载 codeflow-probe-*.json',
      '',
      '典型流程：ui() → start() → 按清单操作 → download()',
    ].join('\n'));
  }

  if (previous && typeof previous.stop === 'function') {
    try { previous.stop(); } catch (error) { /* 旧实例已失效 */ }
  }

  window.CodeFlowProbe = {
    version: VERSION,
    ui: ui,
    start: start,
    stop: stop,
    clear: clear,
    report: report,
    download: download,
    summary: summaryOf,
    help: help,
    locate: locate,
  };
  window.__CodeFlowProbeInternal = { stop: stop };

  console.log('%c[CodeFlowProbe] v' + VERSION + ' 已加载。运行 CodeFlowProbe.help() 查看用法。', 'font-weight:bold;color:#4f46e5');
  var located = locate();
  console.log('[CodeFlowProbe] 上下文：' + located.mode + (located.mode === 'not-found' ? '（请先打开 CodeFlow 面板）' : ''));
})();
