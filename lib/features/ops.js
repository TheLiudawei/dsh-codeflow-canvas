/**
 * 功能索引的写操作层：HTTP `/api/features` 与 `codeflow_features` 工具共用
 * 的一次写操作（label / rename / merge / dissolve / rebuild / write）。
 *
 * 写操作只动 `features.json` 的 manual 段（rebuild 重写 auto 段），绝不触碰
 * 图文件与 rev——这是它与画布状态写入的根本边界。
 *
 * 依赖方向：features/{constants,index-file,map,detect} ← 本模块 ← 聚合入口。
 *
 * @module dsh-codeflow-canvas/features/ops
 */
import { MAX_FEATURES, MAX_FILES_PER_FEATURE } from './constants.js'
import { buildFeatureIndex } from './detect.js'
import { FEATURES_FILE, cleanFeatureName, cleanRel, emptyIndex, emptyManual, relOf, writeFeatureIndex } from './index-file.js'
import { graphRootOf, mapNodes } from './map.js'
import { originalNameOf } from './apply.js'

/** op 校验失败抛出的错误（路由层转 400）。 */
function badRequest(message) {
  const error = new Error(message)
  error.statusCode = 400
  return error
}

/**
 * 对索引执行一次写操作。
 *
 * @returns `{ index, info }`；`info.unmatched` 仅 write 时存在（未匹配文件清单）。
 */
export async function featureOp(options = {}) {
  const op = String(options.op ?? '')
  const body = options.body ?? {}
  let index = options.index ?? emptyIndex()
  if (index._degraded === true) index = emptyIndex()
  const manual = index.manual
  const dir = options.dir
  const logger = options.logger

  if (op === 'label') {
    const key = cleanRel(body.nodeId ?? body.path)
    if (!key) throw badRequest('label 需要 nodeId 或 path')
    const name = cleanFeatureName(body.feature)
    if (!name) throw badRequest('label 需要 feature（功能名）')
    if (body.remove === true) {
      const excluded = [...new Set([...(manual.excluded[key] ?? []), name])]
      manual.excluded[key] = excluded
      const labels = (manual.labels[key] ?? []).filter((entry) => entry !== name)
      if (labels.length > 0) manual.labels[key] = labels
      else delete manual.labels[key]
    } else {
      const labels = [...new Set([...(manual.labels[key] ?? []), name])]
      manual.labels[key] = labels
      const excluded = (manual.excluded[key] ?? []).filter((entry) => entry !== name)
      if (excluded.length > 0) manual.excluded[key] = excluded
      else delete manual.excluded[key]
    }
  } else if (op === 'rename') {
    const from = cleanFeatureName(body.from)
    const to = cleanFeatureName(body.to)
    if (!from || !to) throw badRequest('rename 需要 from 与 to')
    if (from === to) throw badRequest('rename 的新旧名称相同')
    manual.renames[originalNameOf(index, from)] = to
  } else if (op === 'merge') {
    const from = cleanFeatureName(body.from)
    const to = cleanFeatureName(body.to)
    if (!from || !to) throw badRequest('merge 需要 from 与 to')
    const fromOriginal = originalNameOf(index, from)
    const toOriginal = originalNameOf(index, to)
    if (fromOriginal === toOriginal) throw badRequest('不能把功能合并到它自己')
    manual.merged[fromOriginal] = toOriginal
  } else if (op === 'dissolve') {
    const name = cleanFeatureName(body.feature)
    if (!name) throw badRequest('dissolve 需要 feature（功能名）')
    const original = originalNameOf(index, name)
    if (!manual.dissolved.includes(original)) manual.dissolved.push(original)
  } else if (op === 'rebuild') {
    const built = await buildFeatureIndex({
      root: options.root,
      designDoc: options.designDoc,
      manual,
    })
    // 重建只重写 features/unmapped/generatedAt/source；manual 原样保留。
    index.features = built.features
    index.unmapped = built.unmapped
    index.generatedAt = built.generatedAt
    index.source = built.source
    if (built.unavailable !== undefined) index.unavailable = built.unavailable
  } else if (op === 'write') {
    // codeflow_features op="write"：agent 一次性写人工归属。
    const entries = Array.isArray(body.features) ? body.features : []
    if (entries.length === 0) throw badRequest('write 需要 features 数组（[{name, files:[...]}]）')
    const mode = body.mode === 'append' ? 'append' : 'replace-manual'
    if (mode === 'replace-manual') {
      manual.labels = {}
      manual.excluded = {}
    }
    const unmatched = []
    let fileCount = 0
    const graphs = []
    for (const graph of [options.graphs?.modules, options.graphs?.tasks, options.graph]) {
      if (graph !== null && typeof graph === 'object' && Array.isArray(graph.nodes) && graph.nodes.length > 0) graphs.push(graph)
    }
    const nodeRels = new Set()
    for (const graph of graphs) {
      const root = graphRootOf(graph) ?? options.root ?? ''
      for (const node of graph.nodes) {
        const rel = relOf(node?.params?.path, root)
        if (rel) nodeRels.add(rel)
        // tasks 视图：artifacts 指到的文件也算「能找到节点」。
        for (const artifact of Array.isArray(node?.artifacts) ? node.artifacts : []) {
          const artifactRel = relOf(artifact?.path, root)
          if (artifactRel) nodeRels.add(artifactRel)
        }
      }
    }
    for (const entry of entries.slice(0, MAX_FEATURES)) {
      const name = cleanFeatureName(entry?.name)
      if (!name) continue
      const files = (Array.isArray(entry?.files) ? entry.files : []).map((file) => cleanRel(file)).filter(Boolean)
      for (const rel of files.slice(0, MAX_FILES_PER_FEATURE)) {
        fileCount += 1
        if (nodeRels.has(rel) || graphs.length === 0) {
          const labels = [...new Set([...(manual.labels[rel] ?? []), name])]
          manual.labels[rel] = labels
        } else {
          unmatched.push(`${name}: ${rel}`)
        }
      }
    }
    if (manual.dissolved === undefined) manual.dissolved = []
    const info = { unmatched, fileCount, written: entries.length }
    await persistAndRemap(options, index, dir, logger)
    return { index, info }
  } else {
    throw badRequest(`unknown op "${op}"`)
  }

  await persistAndRemap(options, index, dir, logger)
  return { index, info: undefined }
}

/** op 之后：重算模块图节点缓存（auto 视角）并原子落盘。 */
async function persistAndRemap(options, index, dir, logger) {
  const graph = options.graph ?? options.graphs?.modules
  if (graph !== null && typeof graph === 'object' && Array.isArray(graph.nodes) && graph.nodes.length > 0) {
    try {
      const mapped = mapNodes({ features: index.features, manual: emptyManual() }, graph, { root: options.root })
      index.features = mapped.features
      index.unmapped = mapped.unmapped
    } catch (error) {
      logger?.warn?.(`codeflow: features remap failed: ${String(error)}`)
    }
  }
  if (options.persist !== false && typeof dir === 'string' && dir.length > 0) {
    try {
      await writeFeatureIndex(dir, index)
    } catch (error) {
      logger?.warn?.(`codeflow: cannot write ${FEATURES_FILE}: ${String(error)}`)
    }
  }
}
