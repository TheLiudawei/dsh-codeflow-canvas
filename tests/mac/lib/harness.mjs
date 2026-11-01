/**
 * 宿主测试脚手架：假 req/res、内存宿主、图构造器。
 *
 * DSH 不在这里运行。路由层接受一个 node:http 风格的 handler 和一组注入
 * 依赖（`resolveCwd` / `ensureSession` / `submit` …），所以可以用一个
 * 完整的假宿主把真实的 HTTP 路由、真实的 store、真实的路径解析跑起来——
 * 这正是"画布打不开 / 白屏"最先出问题的那一层。
 *
 * 所有模块从 `pluginRoot` 动态导入：套件可以用 `--plugin` 指向用户机器上
 * **已安装**的那份插件，而不是套件旁边的源码。
 *
 * @module tests/mac/lib/harness
 */

import path from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'

/** 从指定插件目录动态导入一个模块。 */
export async function loadFrom(pluginRoot, rel) {
  return import(pathToFileURL(path.join(pluginRoot, rel)).href)
}

/** 一个 node:http 风格的请求（body 为对象时 JSON 序列化，为 Buffer 时原样）。 */
export function fakeRequest(method, url, body, headers = {}) {
  const chunks = body === undefined
    ? []
    : [Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8')]
  return Object.assign(Readable.from(chunks), {
    method,
    url,
    headers: { host: '127.0.0.1:19387', ...headers },
  })
}

/** 一个记录状态、头与响应体的假响应。 */
export function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers ?? {}
    },
    end(chunk) {
      if (chunk !== undefined) this.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    },
  }
}

/** 解析画布文档里的 boot 载荷。 */
export function bootOf(html) {
  const marker = 'window.__CF_BOOT__='
  const start = html.indexOf(marker)
  if (start < 0) throw new Error('画布文档里没有 window.__CF_BOOT__')
  const end = html.indexOf(';</script>', start)
  if (end < 0) throw new Error('boot 载荷缺少结束标记')
  return JSON.parse(html.slice(start + marker.length, end))
}

/** 一个合法的图；`view` 决定节点形状（任务流水线 / 模块结构图）。 */
export function makeGraph(name, { view = 'tasks', nodes, importedFrom, rev = 0 } = {}) {
  const ids = nodes ?? (view === 'modules' ? ['m1', 'm2'] : ['n1', 'n2'])
  const head = ids.map((id, index) => {
    if (view === 'modules') {
      return {
        id,
        type: 'module',
        title: `模块 ${index + 1}`,
        pos: [index * 300, 0],
        params: { path: path.join(importedFrom ?? '/tmp/project', 'src', `模块 ${index + 1}.js`) },
        status: index === 0 ? 'done' : 'pending',
        result: index === 0 ? '入口模块' : '',
        detail: '',
        coupling: { score: 12, level: 'low', ca: 0, ce: 0, fx: 0, cycle: false, symbols: 1 },
      }
    }
    return {
      id,
      type: index === 0 ? 'requirement' : 'codegen',
      title: `节点 ${index + 1}`,
      pos: [index * 300, 0],
      params: { brief: '示例需求' },
      status: index === 0 ? 'done' : 'pending',
      result: index === 0 ? '已完成' : '',
      detail: '',
    }
  })
  return {
    format: 'codeflow/1',
    rev,
    project: { name, language: 'javascript', origin: 'new' },
    nodes: head,
    links: [],
    meta: {
      ...(importedFrom === undefined ? {} : { importedFrom }),
      ...(view === 'modules' ? { strategy: 'modules', coupling: { overall: { modules: ids.length, score: 12, level: 'low' } } } : {}),
    },
  }
}

/**
 * 创建一个假宿主。
 *
 * @param options.pluginRoot - 被测插件根。
 * @param options.workspace - `resolveCwd` 返回的工作区；`undefined` 模拟
 *   "没有可用工作区"的降级路径。
 * @param options.resolveCwd - 覆盖默认的工作区解析器。
 * @returns `{ store, handler, calls, request, dispose }`。
 */
export async function createHost({ pluginRoot, workspace, resolveCwd }) {
  const { createStore } = await loadFrom(pluginRoot, 'lib/store.js')
  const { createRouter } = await loadFrom(pluginRoot, 'lib/routes.js')

  const calls = { submits: [], sessions: [], rebinds: 0, delivered: [] }
  const logger = { warn() {}, info() {}, error() {} }
  const store = createStore(logger)
  const handler = createRouter({
    store,
    logger,
    resolveCwd: resolveCwd ?? (async () => workspace),
    submit: async (gesture) => {
      calls.submits.push(gesture)
      return { sessionId: 'sess-mac', gesture }
    },
    ensureSession: async (project, options) => {
      calls.sessions.push({ project, ...options })
      return { sessionId: 'sess-mac', created: false }
    },
    rebindSession: async (project) => {
      calls.rebinds += 1
      return { sessionId: 'sess-mac-rebound', created: true, project }
    },
    deliverText: async (project, text) => {
      calls.delivered.push({ project, text })
      return { ok: true }
    },
    sessionInfo: () => ({ sessionTitle: 'CodeFlow · 测试', sessionNew: false, sessionWarning: null }),
    activityRead: () => ({ ok: true, running: false, entries: [], edits: [], progress: null }),
    undoList: async () => ({ runs: [] }),
    undoRestore: async () => ({ ok: true, dryRun: true }),
    migrateWorkspace: async () => null,
  })

  /** 发一个请求；返回状态、头、文本与尽力解析的 JSON。 */
  async function request(method, url, body, headers) {
    const req = fakeRequest(method, url, body, headers)
    const res = fakeResponse()
    await handler(req, res)
    let json
    try {
      json = res.body.length > 0 ? JSON.parse(res.body) : undefined
    } catch {
      json = undefined
    }
    return { status: res.statusCode, headers: res.headers, body: res.body, json }
  }

  return {
    store,
    handler,
    calls,
    request,
    dispose() {
      try {
        handler.dispose()
      } catch {
        // dispose 是尽力而为；测试结束时不影响结论。
      }
    },
  }
}
