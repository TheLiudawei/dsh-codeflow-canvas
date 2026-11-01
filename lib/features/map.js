/**
 * 功能 → 画布节点的映射层：把生效功能表落到一张图上。
 *
 * - modules 图（module 节点，params.path 绝对路径）：按文件 rel 归属；
 *   `symbol` 子节点与父文件同 path，自然继承——「父文件命中即算命中」。
 * - tasks 图：依次用 `artifacts[].path` → `params.dir` → `detail` 中出现
 *   该功能文件路径匹配。
 * - manual.labels 的节点 id 键在这里直接生效；excluded 键强制摘除。
 *
 * 依赖方向：features/{apply,index-file} ← 本模块 ← detect.js（构建收尾映射）、
 * ops.js（写后重映射）与聚合入口。
 *
 * @module dsh-codeflow-canvas/features/map
 */
import { effectiveFeatures } from './apply.js'
import { cleanFeatureName, cleanRel, emptyManual, relOf } from './index-file.js'

/**
 * 把生效功能表映射到一张图上，得到每个功能的节点 id 与未归属清单。
 *
 * @param indexOrFeatures - 完整索引（内含 manual，会先过 effectiveFeatures）
 *   或已生效的 feature 数组（manual 改从 `options.manual` 取）。
 * @param graph - 目标图（tasks 或 modules 视图）。
 * @param options - `{ root, manual }`：源码根与 manual 段（数组形态时用）。
 * @returns `{ features, unmapped, nodeNames }`。
 */
export function mapNodes(indexOrFeatures, graph, options = {}) {
  const isIndex = indexOrFeatures !== null && typeof indexOrFeatures === 'object' && !Array.isArray(indexOrFeatures)
    && Array.isArray(indexOrFeatures.features)
  const features = isIndex ? effectiveFeatures(indexOrFeatures) : (indexOrFeatures ?? [])
  const manual = (isIndex ? indexOrFeatures.manual : options.manual) ?? emptyManual()
  const root = options.root ?? graphRootOf(graph) ?? ''

  const fileOwners = new Map()
  for (const feature of features) {
    for (const rel of feature.files) {
      if (!fileOwners.has(rel)) fileOwners.set(rel, new Set())
      fileOwners.get(rel).add(feature.name)
    }
  }

  const nodeNames = new Map()
  const unmapped = []
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  const isModulesView = graph?.meta?.strategy === 'modules' || nodes.some((node) => node?.type === 'module')

  const namesWithLabels = (nodeId, autoNames) => {
    const names = new Set(autoNames)
    const labels = manual.labels?.[nodeId]
    if (Array.isArray(labels)) for (const name of labels) if (cleanFeatureName(name)) names.add(cleanFeatureName(name))
    const excluded = manual.excluded?.[nodeId]
    if (Array.isArray(excluded)) for (const name of excluded) names.delete(cleanFeatureName(name))
    return names
  }

  if (isModulesView) {
    for (const node of nodes) {
      if (node === null || typeof node !== 'object' || node.type !== 'module') continue
      const rel = relOf(node.params?.path, root)
      const names = namesWithLabels(node.id, rel ? (fileOwners.get(rel) ?? new Set()) : new Set())
      if (names.size > 0) nodeNames.set(node.id, names)
      else if (!node.params?.symbol) unmapped.push(node.id)
    }
  } else {
    for (const node of nodes) {
      if (node === null || typeof node !== 'object') continue
      const names = namesWithLabels(node.id, taskNodeNames(node, features, root))
      if (names.size > 0) nodeNames.set(node.id, names)
    }
  }

  const mapped = features.map((feature) => {
    const owned = []
    for (const [nodeId, names] of nodeNames) {
      if (names.has(feature.name)) owned.push(nodeId)
    }
    return { ...feature, files: [...feature.files], nodes: owned }
  })
  return { features: mapped, unmapped, nodeNames }
}

/** tasks 视图匹配：artifacts[].path → params.dir → detail。 */
function taskNodeNames(node, features, root) {
  const names = new Set()
  if (features.length === 0) return names
  const artifactPaths = (Array.isArray(node.artifacts) ? node.artifacts : [])
    .map((artifact) => cleanRel(artifact?.path))
    .filter(Boolean)
  const dir = cleanRel(node.params?.dir).replace(/\/+$/g, '')
  const detail = typeof node.detail === 'string' ? node.detail : ''
  for (const feature of features) {
    for (const rel of feature.files) {
      if (artifactPaths.some((artifactPath) => {
        const relFromRoot = relOf(artifactPath, root)
        return relFromRoot === rel || artifactPath === rel || artifactPath.endsWith(`/${rel}`)
      })) {
        names.add(feature.name)
        break
      }
      if (dir.length > 0 && (rel === dir || rel.startsWith(`${dir}/`))) {
        names.add(feature.name)
        break
      }
      if (detail.length > 0 && detail.includes(rel)) {
        names.add(feature.name)
        break
      }
    }
  }
  return names
}

/** 图的源码根：`meta.importedFrom`（导入项目）为绝对路径。 */
export function graphRootOf(graph) {
  const root = graph?.meta?.importedFrom
  return typeof root === 'string' && root.length > 0 ? root : undefined
}
