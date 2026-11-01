/**
 * B1 工作区解析链与 A2 工作区校验的单元与集成测试（v1.2.1，Issue #1）。
 *
 * 全部在不启动宿主的情况下运行：注册表/agents/store 用最小 mock，文件系统
 * 用真实临时目录。覆盖：
 *
 *   - pickWorkspace 优先级（binding → project-dir → session → NO_WORKSPACE）；
 *   - binding 失效（目录被删 / 已从注册表移除）时的降级；
 *   - 最长前缀与 Windows 规范化（分隔符 / 大小写 / 尾斜杠 / `..`）；
 *   - WORKSPACE_NOT_REGISTERED 候选清单完整且顺序稳定；
 *   - 回归：两个工作区、无绑定无会话 → 必须报错，不能选第一个；
 *   - validateWorkspaceChoice 的全部错误码与通过路径；
 *   - resolveProjectWorkspace 的日志形状与退化模式；
 *   - collectWorkspaces 的只读契约（调用前后不出现 CodeFlow/）。
 *
 * Run: ELECTRON_RUN_AS_NODE=1 <electron> tests/workspace.mjs
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

const {
  normalizeForCompare,
  isRegistered,
  longestRegisteredOf,
  sortCandidatePaths,
  pickWorkspace,
  resolveProjectWorkspace,
  validateWorkspaceChoice,
  collectWorkspaces,
  registeredWorkspacesOf,
} = await import('../lib/workspace-binding.js')

const failures = []
let checks = 0

/** Run one named assertion, recording rather than throwing. */
async function check(name, fn) {
  checks += 1
  try {
    await fn()
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
    console.log(`FAIL  ${name}: ${error.message}`)
  }
}

/** 宽容的 mock 上下文：serviceOf 读 `ctx.get(name)`。 */
function fakeContext(services = {}) {
  return {
    get(name) {
      return Object.hasOwn(services, name) ? services[name] : undefined
    },
  }
}

/** 最小 store mock：只暴露 B1 链读的三个入口。 */
function fakeStore(states = {}, anyCwd) {
  return {
    get(project) {
      return states[String(project)] ?? { cwd: undefined, dir: undefined, sessionId: undefined }
    },
    anyCwd() {
      return anyCwd
    },
  }
}

/** registry mock：list() 返回 `{id,path,title}` 实体数组（宿主的真实形状）。 */
function registry(entries) {
  return { list: () => entries.map((entry) => (typeof entry === 'string' ? { path: entry } : entry)) }
}

/** 一个 registry mock，其 list() 抛错（WORKSPACE_LIST_FAILED 路径）。 */
function brokenRegistry() {
  return { list: () => { throw new Error('storage domain is closed\n    at WorkspaceRegistry.list') } }
}

async function makeWorkspaceDir(prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  await mkdir(path.join(dir, 'inner'), { recursive: true })
  return dir
}

console.log('\n[normalizeForCompare]')
await check('separators, case, trailing slashes and .. are folded', () => {
  assert.equal(normalizeForCompare('C:\\A\\B\\'), normalizeForCompare('c:/a/b'))
  assert.equal(normalizeForCompare('C:\\A\\..\\B'), normalizeForCompare('C:/B'))
  assert.equal(normalizeForCompare('\\\\Server\\Share\\'), '//server/share')
  assert.equal(normalizeForCompare('/A/B/'), normalizeForCompare('/a/b'), 'POSIX folds separators but keeps case')
  assert.equal(normalizeForCompare(''), '')
  assert.equal(normalizeForCompare(undefined), '')
  assert.equal(normalizeForCompare('/a//b'), normalizeForCompare('/a/b'))
})

console.log('\n[isRegistered / longestRegisteredOf / sortCandidatePaths]')
await check('registration compare is exact after normalization', () => {
  assert.equal(isRegistered(['C:\\ws-a'], 'c:/ws-a'), true)
  assert.equal(isRegistered([{ path: 'C:\\ws-a' }], 'c:/ws-a/'), true)
  assert.equal(isRegistered(['C:\\ws-a'], 'C:\\ws-a\\inner'), false, 'containment is not registration')
  assert.equal(isRegistered([], 'C:\\ws-a'), false)
  assert.equal(isRegistered(['C:\\ws-a'], ''), false)
})
await check('longest prefix wins when nested workspaces are both registered', () => {
  const registered = ['C:\\ws', 'C:\\ws\\nested']
  assert.equal(longestRegisteredOf(registered, 'C:\\ws\\nested\\project'), 'C:\\ws\\nested')
  assert.equal(longestRegisteredOf(registered, 'C:\\ws\\other'), 'C:\\ws')
  assert.equal(longestRegisteredOf(registered, 'C:\\ws'), 'C:\\ws', 'the root itself counts as inside')
  assert.equal(longestRegisteredOf(registered, 'C:\\elsewhere'), undefined)
  assert.equal(longestRegisteredOf(registered, 'C:\\wsn'), undefined, 'prefix must end at a segment boundary')
})
await check('candidates sort stably by normalized path', () => {
  const sorted = sortCandidatePaths(['C:\\b-ws', 'C:\\A-ws', 'C:\\a-ws-2'])
  assert.deepEqual(sorted.map((entry) => normalizeForCompare(entry)), [
    normalizeForCompare('C:\\A-ws'),
    normalizeForCompare('C:\\a-ws-2'),
    normalizeForCompare('C:\\b-ws'),
  ])
})

console.log('\n[pickWorkspace (B1 chain)]')
const A = 'C:\\ws-a'
const B = 'C:\\ws-b'
const NESTED = 'C:\\ws-a\\nested'
await check('priority is binding → project-dir → session', () => {
  assert.deepEqual(
    pickWorkspace({
      bound: A, projectDir: `${B}\\CodeFlow\\flow-projects\\p`, sessionCwd: B,
      registered: [A, B], registryAvailable: true,
    }),
    { workspace: A, source: 'binding' },
  )
  assert.deepEqual(
    pickWorkspace({
      bound: undefined, projectDir: `${B}\\CodeFlow\\flow-projects\\p`, sessionCwd: A,
      registered: [A, B], registryAvailable: true,
    }),
    { workspace: B, source: 'project-dir' },
  )
  assert.deepEqual(
    pickWorkspace({
      bound: undefined, projectDir: undefined, sessionCwd: A,
      registered: [A, B], registryAvailable: true,
    }),
    { workspace: A, source: 'session' },
  )
})
await check('a binding that is no longer registered falls through to project-dir, not an error', () => {
  // 已从 DSH 移除（不在注册表里）：binding 档必须失效并落到 project-dir。
  assert.deepEqual(
    pickWorkspace({
      bound: 'C:\\removed-ws', projectDir: `${A}\\CodeFlow\\flow-projects\\p`, sessionCwd: undefined,
      registered: [A, B], registryAvailable: true,
    }),
    { workspace: A, source: 'project-dir' },
  )
})
await check('registry-missing degradation keeps the chain without guessing', () => {
  assert.deepEqual(
    pickWorkspace({ bound: A, registered: [], registryAvailable: false }),
    { workspace: A, source: 'binding' },
  )
  assert.deepEqual(
    pickWorkspace({ bound: undefined, sessionCwd: B, registered: [], registryAvailable: false }),
    { workspace: B, source: 'session' },
  )
  assert.deepEqual(
    pickWorkspace({ registered: [], registryAvailable: false }),
    { code: 'NO_WORKSPACE', candidates: [] },
  )
})
await check('REGRESSION: two registered workspaces and no binding/session must fail, never pick the first', () => {
  const result = pickWorkspace({ bound: undefined, projectDir: undefined, sessionCwd: undefined, registered: [A, B], registryAvailable: true })
  assert.equal(result.code, 'NO_WORKSPACE')
  assert.ok(Array.isArray(result.candidates))
  // 候选清单里两个工作区都在，但没有一个被"选"出来。
  assert.equal(result.workspace, undefined)
})
await check('binding returns the registered canonical spelling, not the caller spelling', () => {
  const result = pickWorkspace({ bound: 'c:/ws-a/', registered: [{ path: 'C:\\ws-a' }], registryAvailable: true })
  assert.deepEqual(result, { workspace: 'C:\\ws-a', source: 'binding' })
})

console.log('\n[validateWorkspaceChoice]')
{
  const realWs = await makeWorkspaceDir('codeflow-ws-reg-')
  const unregistered = await makeWorkspaceDir('codeflow-ws-free-')
  try {
    await check('empty input answers WORKSPACE_REQUIRED', async () => {
      const result = await validateWorkspaceChoice(fakeContext(), '')
      assert.equal(result.ok, false)
      assert.equal(result.code, 'WORKSPACE_REQUIRED')
      assert.ok(result.message.includes('请先选择'), result.message)
    })
    await check('a directory outside the registry answers WORKSPACE_NOT_REGISTERED with the full candidate list', async () => {
      const ctx = fakeContext({ workspaceRegistry: registry([realWs, path.join(realWs, 'inner')]) })
      const result = await validateWorkspaceChoice(ctx, unregistered)
      assert.equal(result.ok, false)
      assert.equal(result.code, 'WORKSPACE_NOT_REGISTERED')
      assert.ok(result.message.includes(unregistered), 'names the rejected directory')
      assert.ok(result.message.includes('请先在 DSH 左侧栏把它添加为工作区'), 'gives the next step')
      const candidates = sortCandidatePaths([realWs, path.join(realWs, 'inner')])
      for (const candidate of candidates) {
        assert.ok(result.message.includes(candidate), `lists candidate ${candidate}`)
      }
      // 顺序稳定（按路径排序）且完整。
      const index = result.message.indexOf(candidates[0])
      assert.ok(index >= 0 && index < result.message.indexOf(candidates[1]), 'candidates appear in sorted order')
    })
    await check('a registered workspace passes with the canonical spelling (case, separators, trailing slash)', async () => {
      const ctx = fakeContext({ workspaceRegistry: registry([{ id: 'ws-1', path: realWs, title: 'Main' }]) })
      const variant = process.platform === 'win32'
        ? realWs.split('\\').join('/').toLowerCase() + '/'
        : realWs + '/'
      const result = await validateWorkspaceChoice(ctx, variant)
      assert.equal(result.ok, true, JSON.stringify(result))
      assert.equal(result.workspace, realWs, 'returns the registered spelling')
      assert.equal(result.workspaceId, 'ws-1')
    })
    await check('a missing or file path answers WORKSPACE_MISSING', async () => {
      const ctx = fakeContext({ workspaceRegistry: registry([realWs]) })
      const missing = await validateWorkspaceChoice(ctx, path.join(unregistered, 'definitely-missing'))
      assert.equal(missing.code, 'WORKSPACE_MISSING')
      const file = path.join(unregistered, 'plain.txt')
      await writeFile(file, 'x', 'utf8')
      const notDir = await validateWorkspaceChoice(ctx, file)
      assert.equal(notDir.code, 'WORKSPACE_MISSING')
      assert.ok(notDir.message.includes('不是目录') || notDir.message.includes('不存在'), notDir.message)
    })
    await check('the plugin package directory is refused (WORKSPACE_IN_PLUGIN_DIR)', async () => {
      const { pluginRoot } = await import('../lib/codeflow-config.js')
      const ctx = fakeContext({ workspaceRegistry: registry([pluginRoot()]) })
      const result = await validateWorkspaceChoice(ctx, pluginRoot())
      assert.equal(result.code, 'WORKSPACE_IN_PLUGIN_DIR', JSON.stringify(result))
      const nested = await validateWorkspaceChoice(ctx, path.join(pluginRoot(), 'lib'))
      assert.equal(nested.code, 'WORKSPACE_IN_PLUGIN_DIR')
    })
    await check('a host without the registry answers NO_WORKSPACE_SERVICE (never a downgrade registration)', async () => {
      const result = await validateWorkspaceChoice(fakeContext(), realWs)
      assert.equal(result.ok, false)
      assert.equal(result.code, 'NO_WORKSPACE_SERVICE')
    })
    await check('a throwing registry answers WORKSPACE_LIST_FAILED with the host error first line', async () => {
      const result = await validateWorkspaceChoice(fakeContext({ workspaceRegistry: brokenRegistry() }), realWs)
      assert.equal(result.code, 'WORKSPACE_LIST_FAILED')
      assert.ok(result.message.includes('storage domain is closed'), result.message)
      assert.ok(!result.message.includes('at WorkspaceRegistry'), 'no stack lines leak into the message')
    })
  } finally {
    await rm(realWs, { recursive: true, force: true })
    await rm(unregistered, { recursive: true, force: true })
  }
}

console.log('\n[resolveProjectWorkspace]')
{
  const ws = await makeWorkspaceDir('codeflow-resolve-')
  const projectDir = path.join(ws, 'CodeFlow', 'flow-projects', 'demo')
  await mkdir(projectDir, { recursive: true })
  try {
    await check('binding wins and logs the resolved source', async () => {
      const logs = []
      const logger = { info: (line) => logs.push(line), warn: (line) => logs.push(line) }
      const store = fakeStore({ demo: { cwd: ws, dir: projectDir, sessionId: undefined } })
      const result = await resolveProjectWorkspace(fakeContext({ workspaceRegistry: registry([ws]) }), store, 'demo', { logger })
      assert.equal(result.workspace, ws)
      assert.equal(result.source, 'binding')
      assert.ok(logs.some((line) => line.includes('workspace resolved project=demo source=binding')), logs)
    })
    await check('project-dir falls back with the longest prefix when binding is gone', async () => {
      const nestedWs = path.join(ws, 'nested')
      await mkdir(nestedWs, { recursive: true })
      const store = fakeStore({ demo: { cwd: path.join(ws, 'gone'), dir: projectDir, sessionId: undefined } })
      const result = await resolveProjectWorkspace(
        fakeContext({ workspaceRegistry: registry([ws, nestedWs]) }), store, 'demo',
      )
      // 项目目录在 ws（不是 nestedWs）之下 → 最长前缀命中的是 ws。
      assert.equal(result.workspace, ws)
      assert.equal(result.source, 'project-dir')
      await rm(nestedWs, { recursive: true, force: true })
    })
    await check('session cwd anchors the resolution through the bound session first', async () => {
      const agents = {
        get(id) {
          return id === 'sess-1' ? { session: { header: { cwd: ws } } } : undefined
        },
        roots: () => [],
      }
      const store = fakeStore({ demo: { cwd: undefined, dir: undefined, sessionId: 'sess-1' } })
      const result = await resolveProjectWorkspace(
        fakeContext({ workspaceRegistry: registry([ws]), agents, workingDirectory: { get: () => ws } }), store, 'demo',
      )
      assert.equal(result.workspace, ws)
      assert.equal(result.source, 'session')
    })
    await check('NO_WORKSPACE carries the candidates and an actionable message', async () => {
      const other = await makeWorkspaceDir('codeflow-resolve-other-')
      try {
        const store = fakeStore({ demo: { cwd: undefined, dir: undefined, sessionId: undefined } })
        const result = await resolveProjectWorkspace(
          fakeContext({ workspaceRegistry: registry([ws, other]) }), store, 'demo',
        )
        assert.equal(result.code, 'NO_WORKSPACE')
        assert.ok(result.message.includes('demo'), result.message)
        assert.ok(result.message.includes('请先在 DSH 左侧栏添加工作区'), result.message)
        for (const candidate of sortCandidatePaths([ws, other])) {
          assert.ok(result.candidates.includes(candidate), `candidate ${candidate}`)
          assert.ok(result.message.includes(candidate), `message lists ${candidate}`)
        }
      } finally {
        await rm(other, { recursive: true, force: true })
      }
    })
    await check('without a registry the chain degrades to existence checks (6.4 compatibility)', async () => {
      const store = fakeStore({ demo: { cwd: undefined, dir: undefined, sessionId: undefined } })
      const agents = { roots: () => [{ session: { header: { cwd: ws } } }] }
      const result = await resolveProjectWorkspace(fakeContext({ agents }), store, 'demo')
      assert.equal(result.workspace, ws, 'the live session cwd anchors a host without a registry')
      assert.equal(result.source, 'session')
      const none = await resolveProjectWorkspace(fakeContext(), store, 'demo')
      assert.equal(none.code, 'NO_WORKSPACE')
    })
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
}

console.log('\n[collectWorkspaces (A1, read-only)]')
{
  const wsA = await makeWorkspaceDir('codeflow-list-a-')
  const wsB = await makeWorkspaceDir('codeflow-list-b-')
  try {
    await check('lists registered workspaces with their own config roots and preview dirs', async () => {
      // 只写 B 的配置（A 保持无配置 = 默认根），验证 per-workspace 读取。
      const { writeConfig } = await import('../lib/codeflow-config.js')
      const customRoot = path.join(wsB, 'Custom')
      await writeConfig(wsB, { root: customRoot, knownRoots: [], projects: {} })
      const ctx = fakeContext({ workspaceRegistry: registry([
        { id: 'a', path: wsA, title: 'Alpha' },
        { id: 'b', path: wsB, title: 'Beta' },
      ]) })
      const payload = await collectWorkspaces({ ctx, store: fakeStore({}, wsA), projectName: 'demo' })
      assert.equal(payload.ok, true)
      assert.equal(payload.workspaces.length, 2)
      const a = payload.workspaces.find((entry) => entry.path === wsA)
      const b = payload.workspaces.find((entry) => entry.path === wsB)
      assert.equal(a.name, path.basename(wsA))
      assert.equal(a.defaultRoot, path.join(wsA, 'CodeFlow'))
      assert.equal(a.root, a.defaultRoot, 'no config → default root')
      assert.equal(a.customRoot, null)
      assert.equal(a.exists, true)
      assert.equal(a.title, 'Alpha')
      assert.equal(normalizeForCompare(a.projectDir), normalizeForCompare(path.join(wsA, 'CodeFlow', 'flow-projects', 'demo')))
      assert.equal(b.root, customRoot, 'B reads its own config.json')
      assert.equal(b.customRoot, customRoot)
      assert.equal(normalizeForCompare(b.projectDir), normalizeForCompare(path.join(customRoot, 'flow-projects', 'demo')))
      assert.equal(payload.current, wsA, 'current comes from the store binding')
    })
    await check('a host without the registry answers NO_WORKSPACE_SERVICE', async () => {
      const payload = await collectWorkspaces({ ctx: fakeContext(), store: fakeStore({}) })
      assert.equal(payload.ok, false)
      assert.equal(payload.code, 'NO_WORKSPACE_SERVICE')
    })
    await check('a throwing registry answers WORKSPACE_LIST_FAILED', async () => {
      const payload = await collectWorkspaces({ ctx: fakeContext({ workspaceRegistry: brokenRegistry() }), store: fakeStore({}) })
      assert.equal(payload.code, 'WORKSPACE_LIST_FAILED')
      assert.ok(payload.message.includes('storage domain is closed'), payload.message)
    })
    await check('read-only: listing never creates CodeFlow/ in any workspace', async () => {
      // 只读断言：列出前后各自目录的条目快照必须一致（写出配置用的是原生 fs，
      // 它自己建的 CodeFlow 不算插件的副作用）。
      const { writeConfig } = await import('../lib/codeflow-config.js')
      await writeConfig(wsB, { root: null, knownRoots: [], projects: {} })
      const ctx = fakeContext({ workspaceRegistry: registry([wsA, wsB]) })
      const snapshotOf = async (dir) => (await readdir(dir)).slice().sort()
      const beforeA = await snapshotOf(wsA)
      const beforeB = await snapshotOf(wsB)
      await collectWorkspaces({ ctx, store: fakeStore({}), projectName: 'demo' })
      const afterA = await snapshotOf(wsA)
      const afterB = await snapshotOf(wsB)
      assert.deepEqual(afterA, beforeA, 'workspace A untouched (no CodeFlow/ appeared)')
      assert.deepEqual(afterB, beforeB, 'workspace B untouched (nothing new appeared)')
      assert.deepEqual(beforeA.filter((name) => name === 'CodeFlow'), [], 'A starts clean')
    })
    await check('registeredWorkspacesOf tolerates missing/empty/string entries', () => {
      assert.deepEqual(registeredWorkspacesOf(fakeContext()), { available: false, workspaces: [] })
      const shaped = registeredWorkspacesOf(fakeContext({ workspaceRegistry: { list: () => [undefined, 'C:\\ws', { path: 'D:\\ws' }, { nope: 1 }] } }))
      assert.equal(shaped.available, true)
      assert.deepEqual(shaped.workspaces, [{ path: 'C:\\ws' }, { path: 'D:\\ws' }])
    })
  } finally {
    await rm(wsA, { recursive: true, force: true })
    await rm(wsB, { recursive: true, force: true })
  }
}

console.log('\n[home/unc normalization sanity]')
await check('paths under the home directory and UNC shapes compare stably', () => {
  const home = homedir()
  assert.equal(normalizeForCompare(path.join(home, 'x')), normalizeForCompare(`${home.split('\\').join('/')}/x`))
  assert.equal(isRegistered(['\\\\srv\\share'], '//SRV/share'), process.platform === 'win32')
})

console.log(`\n${checks} checks, ${failures.length} failures`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`FAIL ${failure}`)
  process.exitCode = 1
}
