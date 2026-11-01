/**
 * HTTP 启动面检查：真实路由 + 真实 store + 真实路径解析。
 *
 * 面板 iframe 的第一帧来自 `GET /codeflow/canvas?boot=1`。这条路径上任何
 * 一环失败（工作区不可用、项目文件损坏、路径含中文、会话抛错、视图侧车
 * 丢失），用户看到的就是"画布打开是空的 / 一直白屏"。这里用假宿主把整条
 * 链路跑一遍，并刻意使用中文、空格、NFC/NFD 的项目名。
 *
 * @module tests/mac/checks/http
 */

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { bootOf, createHost, makeGraph } from '../lib/harness.mjs'

/**
 * 运行 HTTP 检查。
 *
 * @param ctx - 套件上下文。
 */
export async function runHttpChecks(ctx) {
  const { pluginRoot, runner } = ctx
  runner.group('HTTP 启动面（画布打不开 / 空白的现场）')

  const { projectKeyOf, projectDirPath } = await ctx.load('lib/store.js')

  await runner.check('WEB-01', '首次 boot：已有项目时返回 200 HTML 与完整 boot 载荷', async () => {
    const workspace = await ctx.temp('http-boot-')
    const host = await createHost({ pluginRoot, workspace })
    try {
      const name = '中文 项目'
      const key = projectKeyOf(name)
      const graph = makeGraph(name)
      const dir = projectDirPath(workspace, key)
      await host.store.write(graph, { persist: 'now', cwd: workspace, dir })
      const res = await host.request('GET', `/codeflow/canvas?boot=1&project=${encodeURIComponent(name)}`)
      if (res.status !== 200) throw new Error(`状态码 ${res.status}：${res.body.slice(0, 200)}`)
      if (!/text\/html/.test(String(res.headers['content-type']))) throw new Error(`Content-Type 是 ${res.headers['content-type']}`)
      const boot = bootOf(res.body)
      if (boot.project !== name) throw new Error(`boot.project 是 ${JSON.stringify(boot.project)}`)
      if (boot.graph.nodes.length !== graph.nodes.length) throw new Error('boot 里的节点数量与落盘图不一致')
      if (!boot.projectDir?.endsWith(path.join('CodeFlow', 'flow-projects', key))) {
        throw new Error(`projectDir 不正确：${boot.projectDir}`)
      }
      return `${graph.nodes.length} 节点 / ${key}`
    } finally {
      host.dispose()
    }
  })

  await runner.check('WEB-02', 'boot 载荷带主题，浅色/深色都落在 <html> 首帧上', async () => {
    const workspace = await ctx.temp('http-theme-')
    const host = await createHost({ pluginRoot, workspace })
    try {
      const light = await host.request('GET', '/codeflow/canvas?boot=1&theme=light')
      const dark = await host.request('GET', '/codeflow/canvas?boot=1&theme=dark')
      if (!light.body.includes('<html lang="zh-CN" data-cf-theme="light">')) throw new Error('theme=light 没有写在 html 上')
      if (!dark.body.includes('<html lang="zh-CN" data-cf-theme="dark">')) throw new Error('theme=dark 没有写在 html 上')
      if (bootOf(light.body).theme !== 'light') throw new Error('boot.theme 不是 light')
      return '浅色/深色首帧均正确'
    } finally {
      host.dispose()
    }
  })

  await runner.check('WEB-03', '没有工作区时降级为可阅读的提示，而不是 500/空白', async () => {
    const host = await createHost({ pluginRoot, workspace: undefined, resolveCwd: async () => undefined })
    try {
      const res = await host.request('GET', '/codeflow/canvas?boot=1')
      if (res.status !== 200) throw new Error(`状态码 ${res.status}`)
      const boot = bootOf(res.body)
      if (typeof boot.notice !== 'string' || !boot.notice.includes('工作区')) {
        throw new Error(`notice 为空或不可读：${JSON.stringify(boot.notice)}`)
      }
      if (boot.workspace !== null) throw new Error('没有工作区时 boot.workspace 应为 null')
      return boot.notice
    } finally {
      host.dispose()
    }
  })

  await runner.check('WEB-04', '中文 + 空格项目名：保存、落盘、回读一致', async () => {
    const workspace = await ctx.temp('http-cn-')
    const host = await createHost({ pluginRoot, workspace })
    try {
      const name = '中文 项目'
      const key = projectKeyOf(name)
      const graph = makeGraph(name, { nodes: ['n1', 'n2', 'n3'] })
      const res = await host.request('POST', '/codeflow/api/state', { graph, view: 'tasks', viewport: [12, 34, 1] })
      if (res.status !== 200 || res.json?.ok !== true) throw new Error(`保存失败：${res.status} ${res.body.slice(0, 200)}`)
      if (res.json.persisted !== true) throw new Error('persisted 不为 true')
      const file = path.join(workspace, 'CodeFlow', 'flow-projects', key, 'workflow.json')
      const info = await stat(file).catch(() => undefined)
      if (info === undefined) throw new Error(`文件不在预期位置：${file}`)
      const onDisk = JSON.parse(await readFile(file, 'utf8'))
      if (onDisk.nodes.length !== 3) throw new Error('落盘的节点数量不对')

      const state = await host.request('GET', `/codeflow/api/state?project=${encodeURIComponent(name)}`)
      if (state.status !== 200) throw new Error(`回读状态码 ${state.status}`)
      if (state.json.graph.nodes.length !== 3) throw new Error('回读的节点数量不对')
      if (JSON.stringify(state.json.viewport) !== JSON.stringify([12, 34, 1])) throw new Error('视口没有持久化')
      return `目录 ${key}`
    } finally {
      host.dispose()
    }
  })

  await runner.check('WEB-05', 'NFC 与 NFD 两种拼写指向同一个项目', async () => {
    const workspace = await ctx.temp('http-nfd-')
    const host = await createHost({ pluginRoot, workspace })
    try {
      const nfc = 'café 项目'.normalize('NFC')
      const nfd = 'café 项目'.normalize('NFD')
      if (nfc === nfd) return { skip: '当前运行时没有改变规范化形式' }
      const key = projectKeyOf(nfc)
      const graph = makeGraph(nfc, { nodes: ['n1'] })
      await host.store.write(graph, { persist: 'now', cwd: workspace, dir: projectDirPath(workspace, key) })
      const res = await host.request('GET', `/codeflow/canvas?boot=1&project=${encodeURIComponent(nfd)}`)
      if (res.status !== 200) throw new Error(`NFD 拼写 boot 状态码 ${res.status}`)
      const boot = bootOf(res.body)
      if (boot.graph.nodes.length === 0) throw new Error('NFD 拼写没有加载到 NFC 写入的项目')
      if (projectKeyOf(nfd) !== key) throw new Error('NFD 与 NFC 的项目键不一致')
      return `键 ${key}`
    } finally {
      host.dispose()
    }
  })

  await runner.check('WEB-06', '损坏的 workflow.json：隔离、降级、仍返回 200 且带说明', async () => {
    const workspace = await ctx.temp('http-bad-')
    const host = await createHost({ pluginRoot, workspace })
    try {
      const name = '损坏 项目'
      const key = projectKeyOf(name)
      const dir = projectDirPath(workspace, key)
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'workflow.json'), '{"format":"codeflow/1","nodes":[', 'utf8')
      const res = await host.request('GET', `/codeflow/canvas?boot=1&project=${encodeURIComponent(name)}`)
      if (res.status !== 200) throw new Error(`状态码 ${res.status}（损坏文件不应让画布 500）`)
      const boot = bootOf(res.body)
      if (boot.degraded === null || boot.degraded === undefined) throw new Error('boot.degraded 为空，画布不会提示损坏')
      if (!String(boot.degraded.reason ?? '').includes('JSON')) throw new Error(`degraded.reason 不具体：${JSON.stringify(boot.degraded.reason)}`)
      const entries = await readdir(dir)
      if (!entries.some((entry) => entry.startsWith('workflow.json.bad-'))) {
        throw new Error(`损坏文件没有被隔离：${entries.join(', ')}`)
      }
      return `隔离为 ${boot.degraded.quarantinedTo ?? '（记录存在）'}`
    } finally {
      host.dispose()
    }
  })

  await runner.check('WEB-07', 'HEAD 与错误方法的行为符合路由约定', async () => {
    const workspace = await ctx.temp('http-method-')
    const host = await createHost({ pluginRoot, workspace })
    try {
      const head = await host.request('HEAD', '/codeflow/canvas')
      if (head.status !== 200) throw new Error(`HEAD /canvas 返回 ${head.status}`)
      const wrong = await host.request('POST', '/codeflow/canvas')
      if (wrong.status !== 405) throw new Error(`POST /canvas 返回 ${wrong.status}，期望 405`)
      if (wrong.json?.ok !== false) throw new Error('405 响应不是 JSON ok:false')
      return 'HEAD 200 / POST 405'
    } finally {
      host.dispose()
    }
  })

  await runner.check('WEB-08', '空状态：没有项目时 API 与 boot 都返回空图而非报错', async () => {
    const workspace = await ctx.temp('http-empty-')
    const host = await createHost({ pluginRoot, workspace })
    try {
      const state = await host.request('GET', '/codeflow/api/state')
      if (state.status !== 200) throw new Error(`GET /api/state 返回 ${state.status}`)
      if (state.json?.graph !== null) throw new Error('空状态的 graph 应为 null')
      const boot = await host.request('GET', '/codeflow/canvas?boot=1')
      if (boot.status !== 200) throw new Error(`空 boot 返回 ${boot.status}`)
      if (bootOf(boot.body).graph.nodes.length !== 0) throw new Error('空 boot 的图不是空的')
      return '空状态正常'
    } finally {
      host.dispose()
    }
  })

  await runner.check('WEB-09', 'expectedRev 冲突返回 409 与当前修订号', async () => {
    const workspace = await ctx.temp('http-rev-')
    const host = await createHost({ pluginRoot, workspace })
    try {
      const name = '并发 项目'
      const graph = makeGraph(name)
      const first = await host.request('POST', '/codeflow/api/state', { graph, view: 'tasks' })
      if (first.json?.rev !== 1) throw new Error(`首次写入 rev=${first.json?.rev}`)
      const conflict = await host.request('POST', '/codeflow/api/state', {
        graph: makeGraph(name, { nodes: ['n1'] }),
        view: 'tasks',
        expectedRev: 999,
      })
      if (conflict.status !== 409) throw new Error(`冲突返回 ${conflict.status}，期望 409`)
      if (conflict.json?.currentRev !== 1) throw new Error(`currentRev=${conflict.json?.currentRev}`)
      return '409 + currentRev=1'
    } finally {
      host.dispose()
    }
  })

  await runner.check('WEB-10', '重启（新 store）后项目、视口与视图侧车都能恢复', async () => {
    const workspace = await ctx.temp('http-restart-')
    const name = '重启 项目'
    const first = await createHost({ pluginRoot, workspace })
    try {
      const graph = makeGraph(name, { nodes: ['n1', 'n2'] })
      await first.request('POST', '/codeflow/api/state', { graph, view: 'tasks', viewport: [-40, 60, 0.8] })
      // 视口与激活视图搭“保存”按钮的顺风车写入 view.json；自动保存只写图。
      const saved = await first.request('POST', '/codeflow/api/save', { project: name, view: 'tasks' })
      if (saved.status !== 200 || saved.json?.ok !== true) throw new Error(`保存失败：${saved.status} ${saved.body.slice(0, 200)}`)
    } finally {
      first.dispose()
    }
    const second = await createHost({ pluginRoot, workspace })
    try {
      const res = await second.request('GET', `/codeflow/canvas?boot=1&project=${encodeURIComponent(name)}`)
      const boot = bootOf(res.body)
      if (boot.graph.nodes.length !== 2) throw new Error(`重启后节点数 ${boot.graph.nodes.length}`)
      if (JSON.stringify(boot.viewport) !== JSON.stringify([-40, 60, 0.8])) {
        throw new Error(`重启后视口为 ${JSON.stringify(boot.viewport)}`)
      }
      return `${boot.graph.nodes.length} 节点，视口已恢复`
    } finally {
      second.dispose()
    }
  })

  await runner.check('WEB-11', '双视图：切换激活视图后 boot 指向 modules 且两个视图都可用', async () => {
    const workspace = await ctx.temp('http-views-')
    const host = await createHost({ pluginRoot, workspace })
    try {
      const name = '双视图 项目'
      const key = projectKeyOf(name)
      const dir = projectDirPath(workspace, key)
      await host.store.write(makeGraph(name), { persist: 'now', cwd: workspace, dir })
      await host.store.write(makeGraph(name, { view: 'modules' }), { persist: 'now', view: 'modules', cwd: workspace, dir })
      const switched = await host.request('POST', '/codeflow/api/view', { project: name, view: 'modules' })
      if (switched.status !== 200) throw new Error(`切换视图返回 ${switched.status}：${switched.body.slice(0, 200)}`)
      const res = await host.request('GET', `/codeflow/canvas?boot=1&project=${encodeURIComponent(name)}`)
      const boot = bootOf(res.body)
      if (boot.activeView !== 'modules') throw new Error(`activeView 是 ${boot.activeView}`)
      if (!boot.views.tasks.available || !boot.views.modules.available) throw new Error(`views 摘要不完整：${JSON.stringify(boot.views)}`)
      if (!boot.graph.nodes.some((node) => node.type === 'module')) throw new Error('boot 图不是模块图')
      return 'activeView=modules，两个视图均可用'
    } finally {
      host.dispose()
    }
  })
}
