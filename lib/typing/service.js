/**
 * 任务节点自动识别的编排层（v1.5.0）：回合结束（或「自动识别」请求）时，
 * 读 store / undo / activity 组装**本节点自己的证据**，交给 classify.js 的
 * 唯一规则表判定，再一次性把 `type` 与 `meta.cf.typeAuto` 写回整图。
 *
 * 硬约束（任务书 §6）：
 *   - **零 LLM**：纯 Node 脚本；不产生任何额外 agent 回合、工具或 token；
 *   - **依赖注入**：本模块不 import store/undo/activity 的实现——全部由
 *     lib/index.js 装配注入（测试用假对象即可跑）；
 *   - **归属从严**：own =（节点 `artifacts` 路径 ∪ 该节点的写文件工具路径）
 *     ∩ 本次 diff；**不做**「只有一个节点就把全部 diff 给它」的兜底；
 *     归属不到的文件不猜，节点保持 `task`；
 *   - **幂等**：`type` 与 `typeAuto.reason` 都没变时不写、不 bump rev；
 *   - **失败静默降级**：任何异常只 `logger?.warn`，绝不向回合结束路径抛出，
 *     绝不把节点置 failed。
 *
 * 分层：L2 编排（只允许向下依赖 L1 的 classify.js 与 graph-format 的视图工具）。
 *
 * @module dsh-codeflow-canvas/typing/service
 */
import { normalizeView } from '../graph-format.js'
import { classifyChange } from './classify.js'

/** typeAuto 序列化上限（任务书 §4.1）；超限时先裁 sample。 */
const TYPE_AUTO_MAX_BYTES = 400
/** 样例路径上限：条数与单条长度（路径是项目内相对路径，不含源码）。 */
const TYPE_AUTO_SAMPLE_MAX = 3
const TYPE_AUTO_SAMPLE_PATH_MAX = 200

/**
 * 控制字符类（C0 全段 + DEL）——用码位在运行时构造，源码里不写原始控制字节
 * （字段卫生：`typeAuto` 不含控制字符是任务书 §4.1 的硬要求）。
 */
const CONTROL_CHARS_RE = new RegExp(
  '[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + String.fromCharCode(127) + ']',
  'g',
)

/** 折叠路径大小写（Windows 文件系统不区分大小写；比较用）。 */
function foldPath(value) {
  return String(value ?? '').split('\\').join('/').toLowerCase()
}

/**
 * artifacts / 指令路径是否指向 `rel`（段感知后缀匹配——导入项目的 artifacts
 * 可能是绝对路径，而 diff 键是快照根的相对路径）。
 */
function referencesPath(haystack, rel) {
  const a = foldPath(haystack)
  const b = foldPath(rel)
  if (a.length === 0 || b.length === 0) return false
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`)
}

/** 去控制字符并钳制长度（字段卫生：sample 只放干净的项目内相对路径）。 */
function cleanSamplePath(value) {
  return String(value ?? '')
    .replace(CONTROL_CHARS_RE, '')
    .slice(0, TYPE_AUTO_SAMPLE_PATH_MAX)
}

/** 组装 typeAuto 并保证序列化 ≤ 上限；裁不动时丢弃 sample。 */
function buildTypeAuto({ type, reason, counts, sample, at }) {
  const paths = (Array.isArray(sample) ? sample : [])
    .map(cleanSamplePath)
    .filter((value) => value.length > 0)
    .slice(0, TYPE_AUTO_SAMPLE_MAX)
  let auto = { v: 1, type, by: 'host', at, reason, counts, sample: paths }
  while (JSON.stringify(auto).length > TYPE_AUTO_MAX_BYTES && paths.length > 0) {
    paths.pop()
    auto = { v: 1, type, by: 'host', at, reason, counts, sample: paths }
  }
  return auto
}

/**
 * 创建识别服务。
 *
 * @param options.store - 画布 store（图读取与整图写入）。
 * @param options.undo - 撤销管理器（`dryRun` 取本次 diff、`listRuns` 取运行历史）。
 * @param options.activity - 活动中心（`evidenceOf` 取内存证据）。
 * @param options.logger - logger（只 warn）。
 * @param options.now - 时间源（测试注入）。
 * @returns `{ afterTurn(project, run), reidentify(project, {view, nodeId}) }`。
 */
export function createTypingService({ store, undo, activity, logger, now = Date.now }) {
  /** 该节点在证据表里的写文件相对路径（去重）。 */
  function writeRelsOf(evidence, nodeId) {
    const rels = []
    const seen = new Set()
    for (const entry of Array.isArray(evidence?.writes) ? evidence.writes : []) {
      if (entry?.nodeId !== nodeId || typeof entry.rel !== 'string' || entry.rel.length === 0) continue
      const key = foldPath(entry.rel)
      if (seen.has(key)) continue
      seen.add(key)
      rels.push(entry.rel)
    }
    return rels
  }

  /** 该节点发起的命令证据 → classify 的 tools 形状。 */
  function commandToolsOf(evidence, nodeId) {
    const tools = []
    for (const entry of Array.isArray(evidence?.commands) ? evidence.commands : []) {
      if (entry?.nodeId !== nodeId) continue
      tools.push({ kind: entry.isTest === true ? 'test' : 'shell', cmd: String(entry.cmd ?? '') })
    }
    return tools
  }

  /**
   * 归属：own =（artifacts ∪ 写文件路径）∩ diff。不猜、不兜底——交集为空
   * 就是空（宁缺毋滥）。
   */
  function ownFilesOf(node, diffFiles, writeRels) {
    if (diffFiles === null || diffFiles === undefined) return null
    const claim = (rel) => {
      for (const anchor of writeRels) if (referencesPath(anchor, rel)) return true
      if (Array.isArray(node?.artifacts)) {
        for (const artifact of node.artifacts) {
          if (artifact !== null && typeof artifact === 'object' && referencesPath(artifact.path, rel)) return true
        }
      }
      return false
    }
    const pick = (list) => (Array.isArray(list) ? list.filter(claim) : [])
    return {
      added: pick(diffFiles.added),
      modified: pick(diffFiles.modified),
      deleted: pick(diffFiles.deleted),
    }
  }

  /** 读当前 tasks 图（不存在时返回 undefined）。 */
  function tasksGraphOf(project) {
    return store.get(project, 'tasks')?.graph
  }

  /** 是否是可识别的目标节点（done + 任务结构标记 + 未锁定）。 */
  function isTypable(node) {
    return node !== undefined && node !== null
      && node.status === 'done'
      && node?.meta?.cf?.task === true
      && node?.meta?.cf?.typeLocked !== true
  }

  /** 一次性整图写回（只改目标节点的 type 与 meta.cf.typeAuto；rev 由 store 自增）。 */
  async function writeTypeUpdates(project, updates) {
    const graph = tasksGraphOf(project)
    if (graph === undefined) return 0
    const touched = new Map(updates.map((update) => [update.node.id, update]))
    const next = {
      ...graph,
      nodes: graph.nodes.map((node) => {
        const update = touched.get(node.id)
        if (update === undefined) return node
        const cf = { ...(node.meta?.cf ?? {}) }
        cf.typeAuto = update.typeAuto
        return { ...node, type: update.typeAuto.type, meta: { ...(node.meta ?? {}), cf } }
      }),
    }
    await store.write(next, { persist: 'now', view: 'tasks' })
    return touched.size
  }

  /**
   * 对一个候选节点做识别（不落盘）。返回 null（无判定 / 幂等跳过）或
   * `{ node, typeAuto }`。
   */
  function decideForNode(node, diffFiles, evidence, at) {
    const writeRels = writeRelsOf(evidence, node.id)
    const own = ownFilesOf(node, diffFiles, writeRels)
    const tools = commandToolsOf(evidence, node.id)
    const verdict = classifyChange({ files: own, tools })
    if (verdict === null) return null
    // 幂等：type 与 reason 都没变时不写、不 bump rev。
    const previous = node.meta?.cf?.typeAuto
    if (node.type === verdict.type && previous?.reason === verdict.reason) return null
    const counts = {
      added: own?.added?.length ?? 0,
      modified: own?.modified?.length ?? 0,
      deleted: own?.deleted?.length ?? 0,
    }
    const sample = [...(own?.added ?? []), ...(own?.modified ?? []), ...(own?.deleted ?? [])]
    const typeAuto = buildTypeAuto({ type: verdict.type, reason: verdict.reason, counts, sample, at })
    return { node, typeAuto }
  }

  /** 取本次运行的 diff；失败/不可撤销时返回 null（只保留命令证据）。 */
  async function diffOfRun(project, runId) {
    if (typeof runId !== 'string' || runId.length === 0) return null
    try {
      const dry = await undo.dryRun(project, runId)
      if (dry?.ok === true && dry.files !== null && typeof dry.files === 'object') return dry.files
      return null
    } catch (error) {
      logger?.warn?.(`codeflow: typing diff unavailable: ${String(error)}`)
      return null
    }
  }

  /** 活动中心的内存证据（不可用时返回空集，绝不抛出）。 */
  function evidenceOfProject(project) {
    if (activity === undefined || typeof activity.evidenceOf !== 'function') {
      return { writes: [], commands: [] }
    }
    try {
      const evidence = activity.evidenceOf(project)
      if (evidence !== null && typeof evidence === 'object') {
        return { writes: evidence.writes ?? [], commands: evidence.commands ?? [] }
      }
      return { writes: [], commands: [] }
    } catch (error) {
      logger?.warn?.(`codeflow: typing evidence unavailable: ${String(error)}`)
      return { writes: [], commands: [] }
    }
  }

  /**
   * 回合结束识别（RUN_NODE / RUN_ALL）。任何异常都只 warn——绝不抛回
   * 回合结束路径（调用方 fire-and-forget）。
   *
   * @returns `{ changed: number }` 实际写入的节点数。
   */
  async function afterTurn(project, run) {
    try {
      const view = normalizeView(run?.view) ?? 'tasks'
      if (view !== 'tasks') return { changed: 0 }
      if (run?.action !== 'RUN_NODE' && run?.action !== 'RUN_ALL') return { changed: 0 }
      if (typeof run?.runId !== 'string') return { changed: 0 }

      const graph = tasksGraphOf(project)
      const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
      const ids = run.action === 'RUN_NODE'
        ? [typeof run.nodeId === 'string' ? run.nodeId : null]
        : (Array.isArray(run.order) ? run.order : [])
      const candidates = ids
        .map((id) => nodes.find((node) => node.id === id))
        .filter((node) => isTypable(node))
      if (candidates.length === 0) return { changed: 0 }

      // 证据是纯内存读取，先取；dryRun 要走两次 walkTree，后取。beginRun
      // 清空语义由调用顺序保证：afterTurn 先于下一次 beginRun。
      const evidence = evidenceOfProject(project)
      const diffFiles = await diffOfRun(project, run.runId)

      const at = new Date(now()).toISOString()
      const updates = []
      for (const node of candidates) {
        const decided = decideForNode(node, diffFiles, evidence, at)
        if (decided !== null) updates.push(decided)
      }
      if (updates.length === 0) return { changed: 0 }
      const changed = await writeTypeUpdates(project, updates)
      if (changed > 0) {
        logger?.event?.('typing.applied', {
          level: 'info',
          data: { project: String(project), nodes: changed, types: updates.map((u) => u.typeAuto.type).join(',') },
        })
      }
      return { changed }
    } catch (error) {
      logger?.warn?.(`codeflow: auto-typing failed: ${String(error)}`)
      return { changed: 0 }
    }
  }

  /**
   * 「自动识别」按钮：只允许「最近一次运行就是该节点」的情况——否则返回
   * `applied:false`（画布提示「下次运行后自动识别」）。不为此新写快照查询。
   */
  async function reidentify(project, { view, nodeId } = {}) {
    try {
      if (typeof nodeId !== 'string' || nodeId.length === 0) return { applied: false }
      if (typeof undo?.listRuns !== 'function') return { applied: false }
      const runs = await undo.listRuns(project)
      const latest = Array.isArray(runs?.runs) ? runs.runs[0] : undefined
      if (latest === undefined || latest.nodeId !== nodeId) return { applied: false }
      if (normalizeView(latest.view) !== 'tasks') return { applied: false }
      if (typeof view === 'string' && normalizeView(view) !== 'tasks') return { applied: false }

      const graph = tasksGraphOf(project)
      const node = Array.isArray(graph?.nodes)
        ? graph.nodes.find((entry) => entry.id === nodeId)
        : undefined
      if (node === undefined || node === null) return { applied: false }
      if (node?.meta?.cf?.task !== true) return { applied: false }
      // 识别只对真实执行完成（done）的节点生效。
      if (node?.status !== 'done') return { applied: false }
      // 锁还在（画布没清成）就拒绝：绝不覆盖手动决定。
      if (node?.meta?.cf?.typeLocked === true) return { applied: false }

      const evidence = evidenceOfProject(project)
      const diffFiles = await diffOfRun(project, latest.runId)
      const at = new Date(now()).toISOString()
      const decided = decideForNode(node, diffFiles, evidence, at)
      if (decided === null) return { applied: false }
      await writeTypeUpdates(project, [decided])
      return { applied: true, type: decided.typeAuto.type, reason: decided.typeAuto.reason }
    } catch (error) {
      logger?.warn?.(`codeflow: reidentify failed: ${String(error)}`)
      return { applied: false }
    }
  }

  return { afterTurn, reidentify }
}
