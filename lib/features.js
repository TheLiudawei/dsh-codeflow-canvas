/**
 * 功能归属识别（v1.1）：把「功能 → 文件 → 画布节点」的映射做成一个纯本地、
 * 确定性的索引，落在项目目录的 `features.json`（与 workflow.json 同目录）。
 *
 * 设计要点（与需求契约一一对应）：
 *
 *   - **零模型调用**：识别全部是本地确定性计算（design.md 解析、入口信号、
 *     顶层符号、目录/文件名词典、节点文字），不访问网络、不调用任何模型。
 *   - **持久键是 files**（相对源码根、`/` 分隔）；`nodes` 只是本次图的缓存，
 *     重建时按 files 重新映射到节点 id（图重新导入后 id 会变）。
 *   - **manual 段最高优先级**且任何重建都原样保留；重建只重写
 *     `features`/`unmapped`/`generatedAt`/`source`。
 *   - **宽容解析**：坏字段丢弃、最多 `console.warn` 一次，绝不抛错让菜单崩。
 *   - **诚实**：完全无信号 → `features: []`，不做目录硬聚类。
 *
 * 索引由模块图的 `module` 节点（`params.path` 绝对路径）+ 项目根目录推导；
 * `symbol` 子节点允许存在，但归属只登记在文件级（子节点随父文件继承）。
 *
 * 本文件是子包的聚合入口，各职责分片在 `lib/features/`：
 *
 *   constants.js   共享常量（上限 / 信号权重 / 通用名过滤）
 *   dictionary.js  领域词典与归一查找
 *   index-file.js  features.json 的形状、宽容 IO、路径/名称清洗
 *   detect.js      信号收集 + 识别主流程 + buildFeatureIndex
 *   apply.js       manual 段的应用（生效功能表）
 *   map.js         功能 → 节点 id 映射
 *   ops.js         写操作（label/rename/merge/dissolve/rebuild/write）
 *
 * 本文件保留 summarize 并全量 re-export 子包的公共符号——tests 与
 * routes/features-tool 的既有导入路径（`lib/features.js`）原样可用。
 *
 * @module dsh-codeflow-canvas/features
 */
import { LOW_CONFIDENCE } from './features/constants.js'

/* ------------------------------------------------------------ 聚合导出 --- */

export { MAX_FEATURES, MAX_FILES_PER_FEATURE, LOW_CONFIDENCE } from './features/constants.js'
export { BASE_DICTIONARY, buildDictionary, wordsOf, lookupDictionary } from './features/dictionary.js'
export {
  FEATURES_FILE,
  cleanRel,
  cleanFeatureName,
  featureIdOf,
  emptyIndex,
  emptyManual,
  sanitizeManual,
  sanitizeIndex,
  readFeatureIndex,
  writeFeatureIndex,
  computeStale,
  relOf,
} from './features/index-file.js'
export { parseDesignDoc, buildFeatureIndex } from './features/detect.js'
export { applyManual, effectiveFeatures, originalNameOf } from './features/apply.js'
export { mapNodes, graphRootOf } from './features/map.js'
export { featureOp } from './features/ops.js'

/**
 * ≤80 字的一行汇总，例如 `识别 8 个功能 / 24 个模块（3 个低置信）`。
 * 优先用已映射的节点数；没有节点缓存时退回文件数。
 */
export function summarize(index) {
  const features = Array.isArray(index?.features) ? index.features : []
  const low = features.filter((feature) => (Number(feature?.confidence) || 0) < LOW_CONFIDENCE).length
  const nodes = new Set()
  let files = 0
  for (const feature of features) {
    files += Array.isArray(feature?.files) ? feature.files.length : 0
    for (const nodeId of Array.isArray(feature?.nodes) ? feature.nodes : []) nodes.add(nodeId)
  }
  const modules = nodes.size > 0 ? nodes.size : files
  return `识别 ${features.length} 个功能 / ${modules} 个模块${low > 0 ? `（${low} 个低置信）` : ''}`
}
