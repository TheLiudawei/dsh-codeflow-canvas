/**
 * manual 段的应用层：把用户的人工标注（labels / renames / aliases / merged /
 * dissolved / excluded）应用到 auto features 之上，得到「生效功能表」。
 *
 * manual 段优先级最高且任何重建都原样保留——持久层保存的始终是
 * auto features + manual 两段，本模块的四种应用全部是**读取时**的纯函数
 * 变换，幂等：对同一索引重复应用结果不变。
 *
 * 应用顺序（effectiveFeatures）：
 *   1. merged（合并：src 的文件并入 dst，循环到稳定，支持 A→B→C 链）
 *   2. renames（改名：持久层保持原名，展示名在这里解析）
 *   3. labels（人工归属：路径键直接生效，节点 id 键交给 mapNodes）
 *   4. dissolved（解散：按原名或展示名）
 *
 * 依赖方向：features/{constants,index-file} ← 本模块 ← map.js / 聚合入口。
 *
 * @module dsh-codeflow-canvas/features/apply
 */
import { MAX_FEATURES, WEIGHT } from './constants.js'
import { cleanFeatureName, cleanRel, emptyManual, sanitizeIndex, sanitizeManual } from './index-file.js'

/**
 * 替换索引的 manual 段（优先级最高）：输入原样清洗后保存，重建时传回即可。
 * @returns 新索引（manual 已替换，其余字段不变）。
 */
export function applyManual(index, manual) {
  const next = sanitizeIndex(index)
  next.manual = sanitizeManual(manual)
  return next
}

/**
 * 应用 manual 段（优先级最高）得到「生效功能表」。
 * @returns feature 数组，`files` 已归一为可 map 的数组形态。
 */
export function effectiveFeatures(index) {
  const manual = index?.manual ?? emptyManual()
  const features = new Map()
  for (const feature of index?.features ?? []) {
    if (!feature || typeof feature.name !== 'string' || !feature.name) continue
    features.set(feature.name, {
      name: feature.name,
      aliases: [...(feature.aliases ?? [])],
      files: new Set((feature.files ?? []).map((entry) => cleanRel(entry)).filter(Boolean)),
      evidence: [...(feature.evidence ?? [])],
      confidence: Number.isFinite(Number(feature.confidence)) ? Math.min(1, Math.max(0, Number(feature.confidence))) : 0.5,
      source: 'auto',
    })
  }
  const ensureFeature = (name) => {
    let feature = features.get(name)
    if (feature === undefined) {
      feature = {
        name,
        aliases: [...((manual.aliases ?? {})[name] ?? [])],
        files: new Set(),
        evidence: ['人工标注'],
        confidence: WEIGHT.manual,
        source: 'manual',
      }
      features.set(name, feature)
    }
    return feature
  }
  // 1. merged：src 的文件并入 dst（循环到稳定，支持 A→B→C 链）。
  const merged = manual.merged ?? {}
  for (let round = 0; round < MAX_FEATURES + 1; round += 1) {
    let changed = false
    for (const [srcRaw, dstRaw] of Object.entries(merged)) {
      const src = features.get(srcRaw)
      if (src === undefined) continue
      const dstName = cleanFeatureName(dstRaw)
      if (!dstName || dstName === srcRaw) continue
      const dst = ensureFeature(dstName)
      for (const rel of src.files) dst.files.add(rel)
      dst.evidence.push(...src.evidence.filter((entry) => !dst.evidence.includes(entry)).slice(0, 3))
      features.delete(srcRaw)
      changed = true
    }
    if (!changed) break
  }
  // 2. renames：改名（持久层保持原名，展示名在这里解析）。
  for (const feature of features.values()) {
    const renamed = cleanFeatureName((manual.renames ?? {})[feature.name] ?? '')
    if (renamed && renamed !== feature.name) feature.name = renamed
  }
  // 3. labels（路径键）：人工归属，直接生效、不再推断。
  for (const [key, names] of Object.entries(manual.labels ?? {})) {
    if (!Array.isArray(names)) continue
    if (!key.includes('/')) continue // 节点 id 键在 mapNodes 里按图应用
    const rel = cleanRel(key)
    if (!rel) continue
    for (const rawName of names) {
      const name = cleanFeatureName(rawName)
      if (!name) continue
      const feature = resolveByName(features, name) ?? ensureFeature(name)
      feature.files.add(rel)
      const evidence = `人工标注 ${rel}`
      if (!feature.evidence.includes(evidence) && feature.evidence.length < 10) feature.evidence.push(evidence)
    }
  }
  // 4. dissolved：解散（按原名或展示名）。
  const dissolved = new Set((manual.dissolved ?? []).map((name) => cleanFeatureName(name)).filter(Boolean))
  const renamedFrom = new Map(Object.entries(manual.renames ?? {}))
  for (const [original, feature] of [...features.entries()]) {
    if (dissolved.has(original) || dissolved.has(feature.name) || dissolved.has(renamedFrom.get(original) ?? '')) {
      features.delete(original)
    }
  }
  // files 归一为数组：调用方（mapNodes / 测试 / 二次应用）拿到的都是可 map 的形态。
  return [...features.values()].map((feature) => ({ ...feature, files: [...feature.files] }))
}

/** 按展示名或别名找一个 feature（labels 引用旧名时尽量对上既有功能）。 */
function resolveByName(features, name) {
  const direct = features.get(name)
  if (direct !== undefined) return direct
  for (const feature of features.values()) {
    if (feature.name === name) return feature
    if (feature.aliases.some((alias) => alias.toLowerCase() === name.toLowerCase())) return feature
  }
  return undefined
}

/** 展示名 → 持久层里的原名（rename/merge/dissolve 写 manual 时用）。 */
export function originalNameOf(index, displayName) {
  const renames = index?.manual?.renames ?? {}
  for (const [original, renamed] of Object.entries(renames)) {
    if (renamed === displayName) return original
  }
  const exists = (index?.features ?? []).some((feature) => feature?.name === displayName)
  return exists ? displayName : displayName
}
