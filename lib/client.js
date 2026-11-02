window.__ModuleLoader__.load({
  id: 'dsh-codeflow-canvas',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var react = require('react')
    var h = react.createElement

    /** Panel id shared by the main-panel cell and the sidebar entry. */
    var PANEL_ID = 'codeflow'

    /** Where the Host serves the canvas document. `boot=1` loads the latest durable project. */
    var CANVAS_SRC = '/codeflow/canvas?boot=1'

    /**
     * Sidebar glyph: the CodeFlow mark — a hex canvas cut by the flow channel —
     * drawn with `currentColor` so the shell decides hover and selected tint.
     * Same geometry as `assets/branding/logo-mono.svg`.
     *
     * Owner props are exactly `{ size, active }`.
     */
    function CodeFlowIcon(props) {
      var size = typeof props.size === 'number' ? props.size : 18
      var mark = 'M41 24 32.5 9.28 15.5 9.28 7 24 15.5 38.72 32.5 38.72Z'
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 48 48',
        fill: 'none',
        'aria-hidden': true,
        focusable: false,
        style: { display: 'block' },
      },
        h('defs', null,
          h('mask', { id: 'cf-sidebar-mark', maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: 48, height: 48 },
            h('rect', { width: 48, height: 48, fill: '#000' }),
            h('path', { d: mark, fill: '#fff', stroke: '#fff', strokeWidth: 4, strokeLinejoin: 'round' }),
            h('path', {
              d: 'M8.5 30h10.5q4 0 4-4v-4q0-4 4-4h12.5',
              fill: 'none',
              stroke: '#000',
              strokeWidth: 4.2,
              strokeLinecap: 'round',
            }),
          ),
        ),
        h('path', {
          d: mark,
          fill: 'currentColor',
          stroke: 'currentColor',
          strokeWidth: 4,
          strokeLinejoin: 'round',
          mask: 'url(#cf-sidebar-mark)',
        }),
      )
    }

    /**
     * Hand the canvas one colour scheme.
     *
     * A message rather than a new `src`: reloading the iframe would discard the
     * canvas's in-memory viewport, selection and any unsaved gesture.
     */
    function pushScheme(frame, scheme) {
      if (scheme !== 'light' && scheme !== 'dark') return
      var win = frame && frame.contentWindow
      if (win) win.postMessage({ type: 'codeflow:theme', scheme: scheme }, '*')
    }

    /**
     * Client plugin body: the panel plus its sidebar entry.
     *
     * The panel is built inside `apply` so its component can close over `ctx`:
     * slot components receive props, not the plugin context, and this one needs
     * the theme service to follow the shell.
     *
     * @param ctx - client plugin context (services declared by `exports.inject`).
     */
    function apply(ctx) {
      /**
       * The theme service, read as an *optional* dependency.
       *
       * Deliberately not in `inject`: a required service that never appears
       * would keep the whole plugin from applying, and losing the canvas is far
       * worse than losing theme following (which falls back to the OS below).
       *
       * @returns the service, or undefined when this composition has none.
       */
      function themeService() {
        try {
          return typeof ctx.get === 'function' ? ctx.get('theme') : undefined
        } catch (error) {
          return undefined
        }
      }

      /**
       * The resolved DSH colour scheme.
       *
       * `active.colorScheme` is the scheme actually in force — it already folds
       * in the `system` preference against the OS media query — so reading it is
       * what makes the canvas follow both the OS and an explicit DSH override.
       *
       * @returns `'light'`, `'dark'`, or `undefined` when the service is absent.
       */
      function schemeOf() {
        try {
          var service = themeService()
          var snapshot = service && typeof service.getTheme === 'function' ? service.getTheme() : undefined
          var active = snapshot && snapshot.active
          if (active && (active.colorScheme === 'light' || active.colorScheme === 'dark')) return active.colorScheme
          if (snapshot && (snapshot.preference === 'light' || snapshot.preference === 'dark')) return snapshot.preference
        } catch (error) {
          // A missing or reconfigured theme service must not break the panel.
        }
        return undefined
      }

      function CodeFlowPanel() {
        // Captured once: it builds the iframe src, and that src must stay stable.
        var initialRef = react.useRef(null)
        if (initialRef.current === null) initialRef.current = schemeOf() || ''

        var frameRef = react.useRef(null)
        var state = react.useState(initialRef.current)
        var scheme = state[0]
        var setScheme = state[1]

        // Follow later shell theme changes (manual switch or an OS change while
        // the preference is `system`).
        react.useEffect(function () {
          if (typeof ctx.on !== 'function') return undefined
          return ctx.on('theme/change', function () {
            var next = schemeOf()
            if (next) setScheme(next)
          })
        }, [])

        react.useEffect(function () {
          pushScheme(frameRef.current, scheme)
        }, [scheme])

        // "打开会话" channel: the canvas asks the shell to navigate to the
        // project's dedicated session. There is no stable public navigation API
        // declared for plugin bundles, so this is strictly feature-detected:
        // `uiWorkspace.openSession(sessionId)` exists in the desktop client; any
        // other composition falls back to copying the session id, and the canvas
        // tells the user to look the session up by title. No URLs are guessed.
        react.useEffect(function () {
          function uiWorkspace() {
            try {
              var service = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined
              return service && typeof service.openSession === 'function' ? service : undefined
            } catch (error) {
              return undefined
            }
          }
          function reply(source, payload) {
            if (source && typeof source.postMessage === 'function') source.postMessage(payload, '*')
          }
          function onMessage(event) {
            var data = event && event.data
            if (!data || data.type !== 'codeflow:open-session' || typeof data.sessionId !== 'string') return
            var service = uiWorkspace()
            if (service) {
              try {
                service.openSession(data.sessionId)
                reply(event.source, { type: 'codeflow:session-opened', sessionId: data.sessionId })
                return
              } catch (error) {
                // Navigation refused: fall through to the copy fallback below.
              }
            }
            var text = data.sessionId
            if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
              navigator.clipboard.writeText(text).then(
                function () {
                  reply(event.source, { type: 'codeflow:session-open-failed', sessionId: data.sessionId, copied: true })
                },
                function () {
                  reply(event.source, { type: 'codeflow:session-open-failed', sessionId: data.sessionId, copied: false })
                },
              )
            } else {
              reply(event.source, { type: 'codeflow:session-open-failed', sessionId: data.sessionId, copied: false })
            }
          }
          window.addEventListener('message', onMessage)
          return function () {
            window.removeEventListener('message', onMessage)
          }
        }, [])

        return h('div', {
          style: {
            position: 'relative',
            display: 'block',
            width: '100%',
            height: '100%',
            minHeight: '360px',
            minWidth: 0,
            overflow: 'hidden',
            // Follows the shell so no dark frame flashes around a light canvas.
            background: 'var(--dsw-alias-bg-base, #0b0b0e)',
          },
        }, h('iframe', {
          ref: frameRef,
          src: initialRef.current === '' ? CANVAS_SRC : CANVAS_SRC + '&theme=' + initialRef.current,
          title: 'CodeFlow 画布',
          // Re-send on load: a theme change racing the iframe's first paint would
          // otherwise be lost, leaving the canvas on its boot-time scheme.
          onLoad: function () { pushScheme(frameRef.current, scheme) },
          style: {
            position: 'absolute',
            inset: '0',
            display: 'block',
            width: '100%',
            height: '100%',
            border: '0',
            background: 'var(--dsw-alias-bg-base, #0b0b0e)',
          },
        }))
      }

      // Both slots are declared by other packages' entries, so registration
      // must wait for the declaration rather than running bare.
      ctx.slots.inject('main', function () {
        return ctx.slots.register({ name: 'main', key: PANEL_ID }, CodeFlowPanel)
      })
      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 30,
          label: function () { return 'CodeFlow' },
        }, CodeFlowIcon)
      })
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
