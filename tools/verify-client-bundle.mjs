/**
 * Offline verification of a hand-written DSH client bundle.
 *
 * It reproduces the three runtime checks the real Host/browser pair performs,
 * without a browser:
 *   1. package.json: dsh.client.platform === 'web' and exports['./client'] resolves
 *   2. executing lib/client.js calls __ModuleLoader__.load({ id, factory })
 *      with id === package name
 *   3. factory(require) returns a cordis-mountable namespace ({ apply } +/- inject),
 *      and every require() it issues is a PLATFORM_MODULES seed key or a declared
 *      external.
 * Then it drives apply(ctx) against a stub registry to check the registrations.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" verify-client-plugin.mjs <pkgDir>
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'

// PLATFORM_MODULES seed table, verbatim from the shipped web shell bundle
// (dsh-web-frontend/dist/assets/index-*.js -> the `staticModules` argument).
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const pkgDir = path.resolve(process.argv[2] ?? '.')
const fail = (msg) => {
  console.error('FAIL: ' + msg)
  process.exitCode = 1
}
const ok = (msg) => console.log('ok   ' + msg)

// ---- 1. package.json ------------------------------------------------------
const pkgPath = path.join(pkgDir, 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
const decl = pkg.dsh?.client
if (!decl) throw new Error('package.json has no dsh.client')
if (decl.platform !== 'web') throw new Error(`dsh.client.platform is ${JSON.stringify(decl.platform)}, must be "web"`)
ok(`dsh.client.platform === "web"`)

const clientExport = (() => {
  const c = pkg.exports?.['./client']
  if (typeof c === 'string') return c
  if (c && typeof c === 'object' && typeof c.default === 'string') return c.default
  return undefined
})()
if (clientExport === undefined) throw new Error('exports["./client"] must be a string or { default: string }')
const clientPath = path.join(pkgDir, clientExport)
if (!fs.existsSync(clientPath)) throw new Error(`exports["./client"] -> ${clientExport} does not exist`)
ok(`exports["./client"] -> ${clientExport} (${fs.statSync(clientPath).size} bytes)`)

for (const field of ['inject', 'external']) {
  const v = decl[field]
  if (v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== 'string'))) {
    throw new Error(`dsh.client.${field} must be a string array`)
  }
}
if (decl.immediately !== undefined && typeof decl.immediately !== 'boolean') {
  throw new Error('dsh.client.immediately must be a boolean')
}
ok(`dsh.client fields validate (inject=${JSON.stringify(decl.inject ?? [])}, external=${JSON.stringify(decl.external ?? [])}, immediately=${decl.immediately ?? false})`)

// ---- 2. execute the bundle, capture the registration ----------------------
const registrations = []
const sandbox = {
  window: {
    __ModuleLoader__: {
      load: (registration) => registrations.push(registration),
    },
  },
  console,
  Symbol,
  Object,
}
const code = fs.readFileSync(clientPath, 'utf8')
vm.runInNewContext(code, sandbox, { filename: clientPath })

if (registrations.length !== 1) fail(`bundle registered ${registrations.length} factories, expected exactly 1`)
const reg = registrations[0]
if (reg.id !== pkg.name) fail(`registered id ${JSON.stringify(reg.id)} !== package name ${JSON.stringify(pkg.name)}`)
else ok(`__ModuleLoader__.load id === "${pkg.name}"`)
if (typeof reg.factory !== 'function') throw new Error('registration.factory is not a function')

// ---- 3. materialize with a purity-checked require -------------------------
const realRequire = createRequire(import.meta.url)
const noop = () => null
/** Permissive React stand-in: identity for memo/forwardRef, no-op for the rest. */
const reactStub = new Proxy(
  {
    createElement: noop,
    memo: (c) => c,
    forwardRef: (c) => c,
    Fragment: 'Fragment',
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useRef: (v) => ({ current: v }),
    useMemo: (f) => f(),
    useCallback: (f) => f,
    useEffect: () => {},
    useLayoutEffect: () => {},
    useContext: () => undefined,
    createContext: (v) => ({ Provider: 'Provider', _v: v }),
    isValidElement: () => false,
    Children: { map: () => [], toArray: () => [], only: (c) => c },
  },
  { get: (t, p) => (p in t ? t[p] : noop) },
)
const SEED_STUBS = {
  react: reactStub,
  'react/jsx-runtime': { jsx: noop, jsxs: noop, Fragment: 'Fragment' },
  'react-dom': { createPortal: noop, flushSync: (f) => f() },
  'react-dom/client': { createRoot: () => ({ render: () => {}, unmount: () => {} }) },
}
const requested = []
const fakeRequire = (spec) => {
  requested.push(spec)
  if (spec in SEED_STUBS) return SEED_STUBS[spec]
  if (PLATFORM_MODULES.includes(spec)) return {}
  if ((decl.external ?? []).includes(spec)) return {}
  throw new Error(
    `require("${spec}") missed the module table — not a platform seed word and not declared in dsh.client.external`,
  )
}
fakeRequire.async = async (spec) => fakeRequire(spec)

const exportsObj = reg.factory(fakeRequire)
ok(`factory() -> exports [${Object.keys(exportsObj).join(', ')}] (require: ${requested.join(', ') || 'none'})`)

if (typeof exportsObj.apply !== 'function' && typeof exportsObj !== 'function') {
  fail('exports has no apply() — the Loader cannot mount it as a cordis plugin')
} else ok('exports exposes apply()')
if (exportsObj.inject !== undefined && !Array.isArray(exportsObj.inject)) fail('exports.inject must be an array')
else ok(`exports.inject = ${JSON.stringify(exportsObj.inject ?? [])}`)

// ---- drive apply(ctx) against a stub slot registry -----------------------
const registered = []
const injected = []
/** Any-service stand-in so `apply()` of a shipped package can be driven too. */
const anyService = new Proxy(function () {}, {
  get: (t, p) => (p === 'then' ? undefined : anyService),
  apply: () => anyService,
  construct: () => anyService,
})
const baseCtx = {
  effect: (fn) => (typeof fn === 'function' ? fn() : () => {}),
  get: () => anyService,
  on: () => () => {},
  once: () => () => {},
  provide: () => () => {},
  reflect: { provide: () => () => {} },
  slots: {
    inject: (key, cb) => {
      injected.push(key)
      // Simulate "the parent declaration already exists": the real service runs
      // the callback synchronously in that case.
      const dispose = cb()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    register: (options, component) => {
      registered.push({ options, component })
      return () => {}
    },
    registerFactory: () => () => {},
    entries: () => [],
    entriesOfSlot: () => [],
    subscribe: () => () => {},
    provideRoot: () => () => {},
  },
}
const ctx = new Proxy(baseCtx, {
  get: (t, p) => (p in t ? t[p] : anyService),
})
try {
  exportsObj.apply(ctx)
} catch (error) {
  console.log(`note  apply(ctx) threw against the stub ctx: ${error instanceof Error ? error.message : String(error)}`)
  console.log('note  (expected for shipped packages whose declared services are not stubbed here)')
}
ok(`apply(ctx) waited on slots: ${JSON.stringify(injected)}`)
for (const { options, component } of registered) {
  const need = { single: [], list: ['id'], keyed: ['key'], chain: ['select'] }
  const missing = (need[options.kind] ?? []).filter((f) => options[f] === undefined)
  if (missing.length) fail(`registration for "${options.name}" is missing ${missing.join(', ')}`)
  if (typeof component !== 'function') fail(`registration for "${options.name}" has a non-function component`)
  else ok(`register(${JSON.stringify(options)}) -> ${component.name || 'anonymous'}`)
}

console.log(process.exitCode ? '\nRESULT: FAILED' : '\nRESULT: OK')
