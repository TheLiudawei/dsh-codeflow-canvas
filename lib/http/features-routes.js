/**
 * 功能分组索引路由组（v1.1，零模型）。
 *
 *   GET  /api/features          紧凑索引（打开「方案/构建」浮层时调用；
 *                               `refresh=1` 重新识别，从不调模型）
 *   POST /api/features          manual 写操作（label/rename/merge/dissolve/
 *                               rebuild）
 *   POST /api/features/agent    向项目专用会话投递 [CodeFlow:FEATURES]——
 *                               本插件唯一的 LLM 路径，且仅显式点击触发
 *
 * 两者都只动 features.json，绝不触碰图文件与 rev。
 *
 * @module dsh-codeflow-canvas/http/features-routes
 */
import path from 'node:path'

import {
  FEATURES_FILE,
  buildFeatureIndex,
  computeStale,
  effectiveFeatures,
  emptyIndex,
  featureIdOf,
  featureOp,
  mapNodes,
  readFeatureIndex,
  relOf,
  summarize,
  writeFeatureIndex,
} from '../features.js'
import { graphRootOf } from '../features/map.js'
import { normalizeView } from '../graph-format.js'
import { sendJson, readJsonBody, statusOf } from './respond.js'

/**
 * `[CodeFlow:FEATURES]` 首行 JSON 之后的硬性要求正文（v1.1）。与 RUN_* 一样：
 * agent 必须遵守，且绝不允许它借机重扫全部代码或修改图文件。
 */
const FEATURES_AGENT_REQUIREMENTS = [
  '本次识别要求（必须遵守）：',
  '1. 只针对 candidates 列出的未归属模块做功能识别；不要重扫全部代码、不要读取无关文件；',
  '2. 结合节点标题、params.path 与你已有的项目知识判断功能归属；不确定的节点宁可不标（保持未归属），不要为了好看硬归类；',
  '3. 用 codeflow_features 工具一次性写入（op="write"），不要逐条调用、不要修改图文件、不要 bump rev；',
  '4. 写入完成后回复一行摘要（识别了几个功能、多少模块仍未归属）。',
].join('\n')

/**
 * @param ctx - 路由上下文。
 * @returns 路由表项数组。
 */
export function createFeaturesRoutes(ctx) {
  const { store, logger, deliverText, cwdOf, dirOf, ensureViewLoaded } = ctx

  /** 项目的源码根：图 meta.importedFrom，退回项目自身目录。 */
  const sourceRootOf = (graph, fallbackDir) => graphRootOf(graph) ?? fallbackDir

  /**
   * 读取（必要时自动识别一次）项目的功能索引。文件缺失 → 识别并落盘；
   * 文件损坏（`_degraded`）→ 内存兜底重建，不覆盖用户手写文件；
   * `refresh=1` → 重新识别并落盘（manual 原样保留）。识别失败不影响响应。
   */
  async function featuresIndexOf(target, dir) {
    let index = await readFeatureIndex(dir)
    let degraded = index?._degraded === true
    if (index === null || degraded) {
      const root = sourceRootOf(store.get(target, 'modules').graph, dir)
      try {
        const built = await buildFeatureIndex({ root, manual: index?.manual })
        if (index === null) {
          // 首次：落盘，之后人工编辑与「重新识别」都以文件为准。
          index = await writeFeatureIndex(dir, built).catch(() => built)
        } else {
          // 损坏：内存兜底（保留 manual），不覆盖用户手写的文件。
          index = { ...built, manual: index.manual }
        }
        degraded = false
      } catch (error) {
        logger?.warn?.(`codeflow: feature recognition failed for ${target}: ${String(error)}`)
        index = index ?? emptyIndex()
        index.unavailable = String(error?.message ?? error)
      }
    }
    return { index: index ?? emptyIndex(), degraded }
  }

  /** GET/POST 响应共用的紧凑载荷（按请求的视图映射节点）。 */
  async function featuresPayload(target, viewName, index, dir, { degraded = false, extra = {} } = {}) {
    const state = store.get(target, viewName)
    const modulesState = store.get(target, 'modules')
    const root = sourceRootOf(state.graph, dir)
    const eff = effectiveFeatures(index)
    const mapped = mapNodes(eff, state.graph, { root, manual: index.manual })
    const modulesMapped = viewName === 'tasks' && (modulesState.graph?.nodes?.length ?? 0) > 0
      ? mapNodes(eff, modulesState.graph, { root: sourceRootOf(modulesState.graph, dir), manual: index.manual })
      : null
    const stale = degraded || (await computeStale(index, dir))
    return {
      ok: true,
      project: store.get(target).key,
      view: viewName,
      available: index.unavailable === undefined,
      ...(index.unavailable !== undefined ? { reason: index.unavailable } : {}),
      generatedAt: index.generatedAt ?? null,
      source: index.source ?? null,
      stale,
      features: mapped.features.map((feature) => {
        const modulesNodes = viewName === 'modules'
          ? (feature.nodes ?? [])
          : (modulesMapped?.features.find((entry) => entry.name === feature.name)?.nodes ?? [])
        return {
          id: featureIdOf(feature.name),
          name: feature.name,
          aliases: feature.aliases ?? [],
          count: (feature.nodes ?? []).length,
          nodes: feature.nodes ?? [],
          files: feature.files ?? [],
          confidence: Math.round((feature.confidence ?? 0) * 100) / 100,
          low: (feature.confidence ?? 0) < 0.5,
          modulesCount: modulesNodes.length,
          modulesNodes,
        }
      }),
      unmappedCount: (mapped.unmapped ?? []).length,
      summary: summarize(index),
      ...extra,
    }
  }

  return [
    {
      method: 'GET',
      path: '/api/features',
      /** 功能索引读取；`refresh=1` 重算 auto 段并落盘（manual 原样保留）。 */
      async handler(req, res, { url, project }) {
        const target = project ?? store.mostRecent()
        if (target === undefined || String(target).length === 0) {
          sendJson(res, 400, { ok: false, error: 'expected a project name' })
          return
        }
        const wanted = normalizeView(url.searchParams.get('view'))
        const viewName = wanted ?? store.get(target).activeView ?? 'tasks'
        await ensureViewLoaded(target, viewName)
        await ensureViewLoaded(target, viewName === 'modules' ? 'tasks' : 'modules')
        const state = store.get(target, viewName)
        const cwd = await cwdOf(target)
        const dir = state.dir ?? (await dirOf(cwd, target))
        if (dir === undefined) {
          sendJson(res, 200, {
            ok: true, project: store.get(target).key, view: viewName, available: false,
            reason: '项目未绑定工作区，无法读取或生成 features.json',
            generatedAt: null, source: null, stale: true, features: [], unmappedCount: 0,
          })
          return
        }
        const { index, degraded } = await featuresIndexOf(target, dir)
        if (url.searchParams.get('refresh') === '1') {
          // 「重新识别」：重算 auto 段并落盘（manual 原样保留）。
          try {
            const built = await buildFeatureIndex({
              root: sourceRootOf(store.get(target, 'modules').graph, dir),
              manual: index.manual,
            })
            index = { ...built, manual: index.manual }
            await writeFeatureIndex(dir, index)
          } catch (error) {
            logger?.warn?.(`codeflow: feature recognition failed for ${target}: ${String(error)}`)
            index.unavailable = String(error?.message ?? error)
          }
        }
        sendJson(res, 200, await featuresPayload(target, viewName, index, dir, { degraded }))
      },
    },
    {
      method: 'POST',
      path: '/api/features',
      /** manual 写操作；op 校验失败 400，op 内部错误带 statusCode 原样透出。 */
      async handler(req, res, { project }) {
        const body = await readJsonBody(req)
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(res, 400, { ok: false, error: 'expected a JSON body' })
          return
        }
        const op = String(body.op ?? '')
        if (!['label', 'rename', 'merge', 'dissolve', 'rebuild'].includes(op)) {
          sendJson(res, 400, { ok: false, error: `unknown op "${op}"` })
          return
        }
        const target = body.project ?? project ?? store.mostRecent()
        if (target === undefined || String(target).length === 0) {
          sendJson(res, 400, { ok: false, error: 'expected a project name' })
          return
        }
        const viewName = normalizeView(body.view) ?? store.get(target).activeView ?? 'tasks'
        await ensureViewLoaded(target, viewName)
        await ensureViewLoaded(target, 'modules')
        const cwd = await cwdOf(target)
        const dir = store.get(target).dir ?? (await dirOf(cwd, target))
        if (dir === undefined) {
          sendJson(res, 409, { ok: false, error: '项目未绑定工作区，无法写入 features.json' })
          return
        }
        let index = await readFeatureIndex(dir)
        if (index === null) index = emptyIndex()
        const modulesGraph = store.get(target, 'modules').graph
        const root = sourceRootOf(modulesGraph, dir)
        try {
          const result = await featureOp({
            op, body, index, dir, root, graph: modulesGraph, logger,
          })
          index = result.index
        } catch (error) {
          sendJson(res, statusOf(error), { ok: false, error: String(error?.message ?? error) })
          return
        }
        sendJson(res, 200, await featuresPayload(target, viewName, index, dir, { extra: { op } }))
      },
    },
    {
      method: 'POST',
      path: '/api/features/agent',
      /**
       * 向项目专用会话投递 [CodeFlow:FEATURES]（唯一 LLM 路径；仅显式点击触发）。
       * 不做快照、不 bump rev；会话通道不可用时返回可行动错误。
       */
      async handler(req, res, { project }) {
        const body = (await readJsonBody(req)) ?? {}
        const target = body?.project ?? project ?? store.mostRecent()
        if (target === undefined || String(target).length === 0) {
          sendJson(res, 400, { ok: false, error: 'expected a project name' })
          return
        }
        if (typeof deliverText !== 'function') {
          sendJson(res, 409, { ok: false, error: '宿主未提供会话投递通道（sessionController 缺失），无法请求 agent 识别' })
          return
        }
        await ensureViewLoaded(target, 'modules')
        const state = store.get(target)
        const cwd = await cwdOf(target)
        const dir = state.dir ?? (await dirOf(cwd, target))
        if (dir === undefined) {
          sendJson(res, 409, { ok: false, error: '项目未绑定工作区，无法生成识别请求' })
          return
        }
        const { index } = await featuresIndexOf(target, dir)
        const modulesState = store.get(target, 'modules')
        const modulesGraph = modulesState.graph
        const root = sourceRootOf(modulesGraph, dir)
        const eff = effectiveFeatures(index)
        const mapped = mapNodes(eff, (modulesGraph?.nodes?.length ?? 0) > 0 ? modulesGraph : state.graph, { root, manual: index.manual })
        const pool = (modulesGraph?.nodes?.length ?? 0) > 0 ? modulesGraph.nodes : state.graph.nodes
        const candidates = (mapped.unmapped ?? []).slice(0, 40).map((nodeId) => {
          const node = pool.find((entry) => entry?.id === nodeId)
          const rel = relOf(node?.params?.path, root)
          return {
            id: nodeId,
            title: String(node?.title ?? nodeId),
            ...(rel.length > 0 ? { path: rel } : node?.params?.path ? { path: String(node.params.path) } : {}),
          }
        })
        const payload = {
          action: 'FEATURES',
          project: store.get(target).key,
          view: 'modules',
          rev: store.get(target, 'modules').rev ?? 0,
          graphPath: store.filePath(target, 'modules') ?? store.filePath(target, 'tasks') ?? '',
          featuresPath: path.join(dir, FEATURES_FILE),
          candidates,
          reason: '用户在画布上点击了「让 agent 识别」',
        }
        try {
          const sessionId = await deliverText(String(target), `[CodeFlow:FEATURES]${JSON.stringify(payload)}\n\n${FEATURES_AGENT_REQUIREMENTS}`)
          sendJson(res, 200, {
            ok: true,
            project: store.get(target).key,
            delivered: true,
            ...(sessionId !== undefined ? { sessionId } : {}),
            candidates: candidates.length,
          })
        } catch (error) {
          sendJson(res, 409, { ok: false, error: String(error?.message ?? error) })
        }
      },
    },
  ]
}
