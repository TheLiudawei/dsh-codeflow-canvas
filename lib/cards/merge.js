/**
 * 卡片合并（v1.3.0，需求三）——重新导入同一项目时，把旧任务卡片的内容
 * 合并进新扫描的图。**纯函数**：不碰 store / DOM / fs / 时钟；输入不修改；
 * 同一输入两次合并结果逐字节一致（时间戳经 `options.now` 注入）。
 *
 * 匹配顺序（只在同 `type` 内匹配）：
 *   1. `cardKeyOf` 相等（稳定标识，含 meta.cf.key 持久化过的手工 key）；
 *   2. 归一化标题相等；
 *   3. 同类型按顺序配对（只处理剩余未匹配项，避免把 A 的进度贴到 B 上）。
 *
 * 合并规则（任务书 §6.4）：
 *   - **id 与连线以新导入图为准**：保留新节点 id 与新 links；旧卡片内容
 *     附着到新节点上（不保留旧 id 再重映射 links）；
 *   - 保留自旧卡片：status（旧 running → failed + 提示）、result/detail、
 *     pos、用户/agent 改过的 title（≠ meta.cf.importedTitle）、params（若
 *     新扫描 params 与导入时哈希不同则 meta.cf.paramsDrift = true）、
 *     artifacts/presented 等可选字段、meta 自定义键（cf 由本次合并重写）；
 *   - 采用新值：type、端口定义、meta.cf.importedTitle/importedParamsHash、
 *     links、新节点 id；
 *   - 失效卡片：旧卡片无匹配 → 保留节点（meta.cf.stale = true；id 冲突时
 *     改名 `<id>-stale-<n>`；不保留旧 links；默认不参与「运行全部」）；
 *   - 顺序稳定：匹配/新增按新图顺序，失效卡片按旧图顺序追加；
 *   - 图级 `graph.meta.cards = { schema: 1, persist, updatedAt }`。
 *
 * 依赖方向：L1 领域——只 import `./identity.js`（cards 内部）。
 *
 * @module dsh-codeflow-canvas/cards/merge
 */
import { cardKeyOf, cardMetaOf, normalizeTitle, stableParamsText, hashKey } from './identity.js'

/** 图的深拷贝（图是 JSON 数据；structuredClone 在 Electron 的 Node 可用）。 */
function cloneGraph(graph) {
  if (typeof structuredClone === 'function') return structuredClone(graph)
  return JSON.parse(JSON.stringify(graph))
}

/** 节点的用户字段哈希（判断「源码侧是否变化」的基准之一）。 */
function nodeParamsHash(node) {
  return hashKey(stableParamsText(node?.params))
}

/**
 * 合并旧任务卡片到新导入的任务图。
 *
 * @param options.existingGraph - 旧任务图（内存或磁盘；可为 undefined → 原样返回新图）。
 * @param options.importedGraph - 新导入的任务图。
 * @param options.persist - 写入 meta.cards.persist 的值（默认 true）。
 * @param options.now - 时间注入（返回 ISO 字符串；默认 Date.now 的 ISO）。
 * @returns `{ graph, stats: { matched, added, keptStale, paramsDrift }, warnings }`。
 */
export function mergeCards(options = {}) {
  const { existingGraph, importedGraph } = options
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString()
  const persist = options.persist !== false
  const warnings = []
  const stats = { matched: 0, added: 0, keptStale: 0, paramsDrift: 0 }

  if (!importedGraph || !Array.isArray(importedGraph.nodes)) {
    return { graph: importedGraph, stats, warnings: [...warnings, 'imported graph missing'] }
  }
  const oldNodes = existingGraph && Array.isArray(existingGraph.nodes) ? existingGraph.nodes : []
  if (oldNodes.length === 0) {
    // 没有旧卡片：仍是导入，但补 meta.cards（首次开启持久化也标记 schema）。
    const graph = cloneGraph(importedGraph)
    graph.meta = { ...(graph.meta ?? {}), cards: { schema: 1, persist, updatedAt: now() } }
    return { graph, stats, warnings }
  }

  const graph = cloneGraph(importedGraph)
  const newNodes = Array.isArray(graph.nodes) ? graph.nodes : []
  graph.nodes = newNodes

  /* 旧节点的可匹配表（同 type 内匹配）。 */
  const oldByKey = new Map()
  const oldByTitle = new Map()
  for (const old of oldNodes) {
    if (!old || typeof old !== 'object') continue
    const type = String(old.type ?? '')
    const key = cardKeyOf(old)
    if (!oldByKey.has(key)) oldByKey.set(key, old)
    const title = normalizeTitle(old.title)
    const titleKey = `${type}\u0000${title}`
    if (!oldByTitle.has(titleKey)) oldByTitle.set(titleKey, old)
  }
  const matchedOld = new Set()

  /* 1+2：key 匹配 → 同类型标题匹配。 */
  for (const node of newNodes) {
    if (!node || typeof node !== 'object') continue
    const type = String(node.type ?? '')
    let old = null
    const key = cardKeyOf(node)
    const byKey = oldByKey.get(key)
    if (byKey && String(byKey.type ?? '') === type && !matchedOld.has(byKey)) old = byKey
    if (!old) {
      const byTitle = oldByTitle.get(`${type}\u0000${normalizeTitle(node.title)}`)
      if (byTitle && !matchedOld.has(byTitle)) old = byTitle
    }
    if (old) {
      matchedOld.add(old)
      stats.matched += 1
      applyOldToNew(node, old, { now, stats })
      continue
    }
    stats.added += 1
    node.meta = { ...(node.meta ?? {}), cf: cardMetaOf(node, { now }) }
  }

  /* 3：剩余未匹配旧节点中，同类型按顺序配对。 */
  const newByType = new Map()
  for (const node of newNodes) {
    if (!node || typeof node !== 'object') continue
    if (node.meta?.cf?.stale === true) continue
    const type = String(node.type ?? '')
    if (!newByType.has(type)) newByType.set(type, [])
    newByType.get(type).push(node)
  }
  const newMatched = new Set(newNodes.filter((node) => node?.meta?.cf && node.meta.cf.mergedAt !== undefined))
  for (const old of oldNodes) {
    if (!old || typeof old !== 'object' || matchedOld.has(old)) continue
    const type = String(old.type ?? '')
    const candidates = (newByType.get(type) ?? []).filter((node) => !newMatched.has(node) && node.meta?.cf?.mergedAt === undefined)
    if (candidates.length === 0) continue
    const node = candidates[0]
    newMatched.add(node)
    matchedOld.add(old)
    stats.matched += 1
    applyOldToNew(node, old, { now, stats })
  }

  /* 失效卡片：仍无匹配的旧节点按旧图顺序追加（不保留旧 links）。 */
  const newIds = new Set(newNodes.map((node) => node?.id).filter((id) => typeof id === 'string'))
  let staleSeq = 0
  for (const old of oldNodes) {
    if (!old || typeof old !== 'object' || matchedOld.has(old)) continue
    stats.keptStale += 1
    const stale = cloneGraph({ nodes: [old], links: [], meta: {} }).nodes[0]
    if (typeof stale.id !== 'string' || newIds.has(stale.id)) {
      const base = typeof stale.id === 'string' && stale.id.length > 0 ? stale.id : 'stale'
      let candidate
      do {
        staleSeq += 1
        candidate = `${base}-stale-${staleSeq}`
      } while (newIds.has(candidate))
      stale.id = candidate
    }
    newIds.add(stale.id)
    stale.links = undefined
    delete stale.links
    stale.status = stale.status === 'running' ? 'failed' : (stale.status ?? 'pending')
    if (old.status === 'running') {
      stale.result = [String(stale.result ?? ''), '重新导入时该卡片未完成'].filter(Boolean).join('；')
    }
    const previousCf = old.meta && typeof old.meta === 'object' && old.meta.cf && typeof old.meta.cf === 'object' ? old.meta.cf : {}
    stale.meta = {
      ...(old.meta && typeof old.meta === 'object' ? old.meta : {}),
      cf: {
        ...(previousCf.key ? { key: previousCf.key } : { key: cardKeyOf(old) }),
        ...(previousCf.importedTitle !== undefined ? { importedTitle: previousCf.importedTitle } : {}),
        ...(previousCf.importedParamsHash !== undefined ? { importedParamsHash: previousCf.importedParamsHash } : {}),
        stale: true,
        mergedAt: now(),
      },
    }
    newNodes.push(stale)
  }

  graph.meta = { ...(graph.meta ?? {}), cards: { schema: 1, persist, updatedAt: now() } }
  return { graph, stats, warnings }
}

/** 把旧卡片内容附着到新节点（新 id / 新 links / 新端口定义保持不变）。 */
function applyOldToNew(node, old, { now, stats }) {
  const previousCf = old.meta && typeof old.meta === 'object' && old.meta.cf && typeof old.meta.cf === 'object' ? old.meta.cf : {}
  // 导入快照必须取自**新扫描**（合并旧参数之前）：下一次再导入时以它为基准。
  const importedTitle = String(node.title ?? '')
  const importedParamsHash = nodeParamsHash(node)
  // status：保留；旧 running 视为中断。
  if (old.status !== undefined) {
    node.status = old.status === 'running' ? 'failed' : old.status
    if (old.status === 'running') {
      node.result = [String(old.result ?? ''), '重新导入时该卡片未完成'].filter(Boolean).join('；')
    } else if (old.result !== undefined) {
      node.result = old.result
    }
  } else if (old.result !== undefined) {
    node.result = old.result
  }
  if (old.detail !== undefined) node.detail = old.detail
  if (Array.isArray(old.pos) && old.pos.length === 2) node.pos = [...old.pos]
  // title：仅当用户/agent 改过（≠ 上次导入快照）才保留；导入快照用新扫描标题。
  if (typeof old.title === 'string' && previousCf.importedTitle !== undefined && old.title !== previousCf.importedTitle) {
    node.title = old.title
  }
  // params：保留旧值（用户的修改不丢）；新扫描参数相对上次导入发生变化 → paramsDrift。
  if (old.params !== undefined && old.params !== null && typeof old.params === 'object') {
    node.params = { ...(node.params ?? {}), ...old.params }
  }
  const drift = previousCf.importedParamsHash !== undefined
    && importedParamsHash !== previousCf.importedParamsHash
  // 可选用户字段：保留旧值。
  for (const field of ['artifacts', 'presented', 'tags', 'notes']) {
    if (old[field] !== undefined) node[field] = cloneGraph(old[field])
  }
  // meta 自定义键：保留旧值；cf 由本次合并重写（key 用新节点的稳定标识）。
  const oldMeta = old.meta && typeof old.meta === 'object' ? old.meta : {}
  const customMeta = { ...oldMeta }
  delete customMeta.cf
  node.meta = {
    ...customMeta,
    ...(node.meta ?? {}),
    cf: {
      key: cardKeyOf({ ...node, meta: undefined }),
      importedTitle,
      importedParamsHash,
      stale: false,
      mergedAt: now(),
      ...(drift ? { paramsDrift: true } : {}),
    },
  }
  if (drift) stats.paramsDrift += 1
}
