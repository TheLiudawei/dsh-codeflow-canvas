/**
 * 活动中心：画布专用会话此刻正在做什么的纯内存视图——推理流、工具调用、
 * 步骤、进度，以及（v0.6.0）真实写文件工具正在编辑的项目文件——供面板轮询。
 *
 * 事件源（已对照 DSH 0.2.1-rc.5 验证）：
 *
 *   ctx.on('session/event', (session, event) => …)
 *     event = { type, seq, data, … }；`session.id` 定位会话。
 *     本模块使用：turn/start、turn/end、step/start、tool/call
 *     { turn, step, callId, name, arguments }、tool/result
 *     { turn, step, message, error?, meta? }、assistant/message
 *     { turn, step, message }、deliverables/presented
 *     { turn, callId, files }。
 *
 *   ctx.on('agent/assistant-stream', ({ agent, frame }) => …)
 *     frame = { type: 'start'|'chunk'|'end', attemptId, revision, turn, step,
 *     index, chunk?, outcome? }，chunk.type 为 'reasoning-delta' | 'text-delta'
 *     | 'tool-call-delta'，携带 `.text` / `.argumentsDelta`。
 *
 * 一切都按"当前绑定到画布项目的会话"过滤；其它会话的内容绝不进入缓冲。
 * 缓冲有界（每项目 500 条 / 256 KiB，每条文本 ≤4 KiB），同一次尝试的推理
 * 增量合并进同一条持续增长的条目，逐出时置 `reset` 标志让客户端清空重取。
 * 这里的一切都不落盘——不进 workflow.json，不进日志。
 *
 * 运行是视图感知的（v0.6.0）：`beginRun`/`noteProgress` 记录运行目标是任务
 * 流水线还是模块结构图，所有图查找（当前节点、进度、回合收尾）只读那个
 * 视图——用户在运行中途把面板切到另一视图，绝不干扰运行中的图。
 *
 * 文件编辑追踪（v0.6.0）**只**来自真实的写文件工具调用：白名单工具的
 * `tool/call` 且路径参数可解析才打开一条内存编辑记录，`tool/result` 关闭它，
 * `turn/end` 收尾滞留项。推理文本、节点标题与只读工具永不产生编辑。编辑表
 * 有界（每项目 100 条、每次调用 20 条路径），编辑路径到模块/任务节点的匹配
 * 在宿主侧完成——面板只是事实的纯渲染者。
 *
 * 降级阶梯放在客户端；本中心只如实记录看到的东西：`reasoning-delta` 帧到达
 * 时记推理条目，否则记 `session/event` 的持久工具/步骤/文本条目。任何东西
 * 都不虚构——没有百分比、没有剩余时间估计、没有合成的推理。
 *
 * @module dsh-codeflow-canvas/activity
 */
import path from 'node:path'

import { normalizeView } from './graph-format.js'
import { isAbsolutePath, pathContains, projectDirPath, projectKeyOf } from './core/path.js'
import { isTestCommand } from './typing/classify.js'

/** Per-project entry cap. */
const MAX_ENTRIES = 500

/** Per-project buffer cap, in approximate serialized bytes. */
const MAX_BYTES = 256 * 1024

/** Per-entry text cap; longer text is cut and marked. */
const MAX_TEXT = 4096

/** Minutes of silence before a run is reported as possibly interrupted. */
const IDLE_MINUTES = 15

/** A tool whose arguments may be surfaced as a truncated summary. */
const SHELLISH_TOOL = /bash|pwsh|shell|terminal|command/i

/**
 * "调用成功即意味着正在写文件"的工具。这是高亮白名单：刻意收窄，只按工具
 * 名匹配。不在名单里的任何工具（read/grep/glob/inspect/present/…）无论参数
 * 里有什么，都绝不可能产生编辑记录。
 */
const WRITE_TOOL_RE = /^(edit|write|file_write|write_file|create_file|save_file|apply_patch|applypatch|ops_replace|multi_edit|multiedit|str_replace|replace_in_file|search_replace|insert_content|notebook_edit)/i

/** Read-only/presentation tools are excluded even if a name pattern overlaps. */
const READ_ONLY_TOOL_RE = /^(read|grep|glob|list|ops_inspect|present|deliver|codeflow_canvas)/i

/** Single-value argument keys that may carry one target path. */
const SINGLE_PATH_KEYS = ['file_path', 'path', 'file', 'filename', 'target_file']

/** Array-valued argument keys that may carry several target paths. */
const ARRAY_PATH_KEYS = ['files', 'paths']

/** Per-call and per-project bounds for the edit table. */
const MAX_PATHS_PER_CALL = 20
const MAX_EDIT_RECORDS = 100

/**
 * 类型识别证据（v1.5.0）的内存上限：写文件路径 ≤200 条、命令 ≤100 条。
 * 证据只活在内存（`state.evidence`），`beginRun` 清空、`clear` 丢弃，
 * `evidenceOf` 返回拷贝——绝不落盘、不进日志、不进 workflow.json。
 */
const MAX_WRITE_EVIDENCE = 200
const MAX_COMMAND_EVIDENCE = 100
const MAX_COMMAND_TEXT = 300

/** Node statuses that may be patched automatically when a turn ends. */
function nowOf() {
  return Date.now()
}

/**
 * 工具调用参数在多数宿主里是对象，但有的宿主把它序列化成 JSON 字符串。
 * 这里归一成对象，让路径提取对两种形状都生效；解析不了的按原样返回
 * （也就抽不出路径）。
 */
function normalizeToolArguments(args) {
  if (args !== null && typeof args === 'object') return args
  if (typeof args === 'string') {
    const text = args.trim()
    if (text.startsWith('{') && text.length <= 200_000) {
      try {
        const parsed = JSON.parse(text)
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
      } catch {
        // 不是 JSON——按原样放行，让提取层把它当作不透明文本。
      }
    }
  }
  return args
}

/**
 * 判断一次工具调用是否可能编辑项目文件。刻意保守：漏掉一次高亮的代价是
 * 一个模块不亮，错亮一次的代价是画布上出现一句谎言。
 */
export function isWriteTool(name) {
  const label = String(name ?? '').toLowerCase()
  if (label.length === 0) return false
  if (READ_ONLY_TOOL_RE.test(label)) return false
  return WRITE_TOOL_RE.test(label)
}

/** A value that plausibly is a filesystem path (not a URL, not prose). */
function plausiblePath(value) {
  if (typeof value !== 'string') return false
  const text = value.trim()
  if (text.length === 0 || text.length > 1024) return false
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return false // URL / file:// handled later
  if (/[\n\r\u0000]/.test(text)) return false
  if (text.startsWith('"') || text.startsWith("'")) return false
  // 没有分隔符也没有扩展名的裸词通常不是路径。
  return text.includes('/') || text.includes('\\') || text.includes('.') || /^[a-zA-Z]:/.test(text)
}

/** Normalize one raw path value to `/` separators; returns `undefined` for junk. */
function normalizeRawPath(value) {
  if (!plausiblePath(value)) return undefined
  let text = String(value).trim().replace(/^file:\/\//i, '')
  if (text.startsWith('file:')) return undefined
  text = text.split('\\').join('/')
  // 剥掉从标记正则里漏进来的 `a/`、`b/` diff 前缀。
  text = text.replace(/^[ab]\//, '')
  return text.length > 0 ? text : undefined
}

/**
 * 按高亮契约从一次写工具调用的参数里抽取候选文件路径：先单值键，再数组键，
 * 最后是字符串参数里的补丁标记。顺序即优先级；结果封顶
 * {@link MAX_PATHS_PER_CALL}。
 */
export function extractEditPaths(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return []
  const out = []
  const seen = new Set()
  const push = (value) => {
    const normalized = normalizeRawPath(value)
    if (normalized === undefined || seen.has(normalized.toLowerCase())) return
    seen.add(normalized.toLowerCase())
    out.push(normalized)
  }
  for (const key of SINGLE_PATH_KEYS) {
    if (typeof args[key] === 'string') push(args[key])
  }
  for (const key of ARRAY_PATH_KEYS) {
    if (Array.isArray(args[key])) args[key].forEach(push)
  }
  if (Array.isArray(args.edits)) {
    for (const edit of args.edits) {
      if (edit === null || typeof edit !== 'object' || Array.isArray(edit)) continue
      if (typeof edit.path === 'string') push(edit.path)
      if (typeof edit.file_path === 'string') push(edit.file_path)
    }
  }
  for (const value of Object.values(args)) {
    if (typeof value !== 'string' || value.length > 200_000) continue
    for (const match of value.matchAll(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+?)\s*$/gm)) push(match[1])
    for (const match of value.matchAll(/^(?:\+\+\+|---) (?:[ab]\/)?(.+?)\s*$/gm)) push(match[1])
  }
  return out.slice(0, MAX_PATHS_PER_CALL)
}

/** Windows filesystems compare paths case-insensitively. */
const CASE_FOLD = process.platform === 'win32'

function foldPath(value) {
  const text = String(value ?? '').split('\\').join('/')
  return CASE_FOLD ? text.toLowerCase() : text
}

/* 包含性判断统一取自 lib/core/path.js 的 pathContains——原来这里的 insidePath
 * 与 undo.js 的 contained 是逐字相同的两份实现。 */

/** `a` and `b` name the same file. */
function samePath(a, b) {
  return foldPath(a) === foldPath(b)
}

/** Does an artifacts/instruction path reference `rel`? Segment-aware suffix match. */
function referencesPath(haystack, rel) {
  const a = foldPath(haystack)
  const b = foldPath(rel)
  if (a.length === 0 || b.length === 0) return false
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`)
}

/**
 * 创建活动中心。
 *
 * @param options.store - 画布 store（绑定与图状态的来源）。
 * @param options.logger - Cordis logger。
 * @returns hub 句柄；经 `attach(ctx)` 在插件 fiber 里订阅。
 */
export function createActivityHub({ store, logger }) {
  /** Host-side hooks the plugin entry fills in (node updates, undo bookkeeping). */
  const options = { onPresented: undefined, onTurnEnd: undefined }

  /**
   * 每会话的活动状态（@type 见下）：
   *   sessionId?    绑定的画布会话 id
   *   running       会话是否有进行中的运行；action?/nodeId? 记运行类型与目标
   *   view?         运行作用的视图（tasks/modules）
   *   startedAt?/updatedAt/seq/entries   运行起点、最近更新、事件序号与环形缓冲
   *   bytes/evicted/reset               缓冲字节数、逐出计数与"客户端应清空重取"标志
   *   lastEventAt/idleWarned            最近事件时间与是否已报过"可能中断"
   *   attempts                          attemptId → {reasoning?, text?}（流式合并）
   *   pendingTools                      callId → {entry, at}（等待 tool/result 的调用）
   *   pendingEdits                      callId → 候选路径（等待结果落定的编辑）
   *   edits                             编辑记录表（bounded）
   *   unmatchedNoted                    "编辑了结构图之外的文件"是否已提示过一次
   *   percent?/presented?               显式百分比与真正提交的交付路径
   * @type {Map<string, Object>}
   */
  const projects = new Map()

  function stateOf(project) {
    const key = projectKeyOf(project)
    let state = projects.get(key)
    if (state === undefined) {
      state = {
        running: false,
        updatedAt: 0,
        seq: 0,
        entries: [],
        bytes: 0,
        evicted: 0,
        reset: false,
        lastEventAt: 0,
        idleWarned: false,
        attempts: new Map(),
        pendingTools: new Map(),
        pendingEdits: new Map(),
        edits: new Map(),
        unmatchedNoted: false,
        // 最近一次运行的问题（v1.0 A3.4）："回合结束了，但节点从未被执行"。
        // 只在内存、只留最新一条；beginRun 会清掉它。
        issue: undefined,
        // 类型识别证据（v1.5.0）：{writes:[{nodeId,rel,tool,at}], commands:[{nodeId,cmd,isTest,at}]}。
        // 纯内存、有界；beginRun 清空、clear 丢弃；service 经 evidenceOf 读拷贝。
        evidence: { writes: [], commands: [] },
      }
      projects.set(key, state)
    }
    return state
  }

  /** Which canvas project (if any) is bound to this session id. */
  function projectOfSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
    for (const key of store.keys()) {
      if (store.get(key)?.sessionId === sessionId) return key
    }
    return undefined
  }

  /** The view the current run targets (activity is scoped to one view). */
  function currentViewOf(project) {
    const state = projects.get(projectKeyOf(project))
    return normalizeView(state?.view) ?? 'tasks'
  }

  /** The graph of the current run's view — never the panel's active view. */
  function currentGraphOf(project, state) {
    return store.get(project, normalizeView(state?.view) ?? 'tasks')?.graph
  }

  /**
   * 活动应挂到哪个节点：显式的运行目标优先，其次 progress 工具的当前节点，
   * 再次**运行视图**图里标记为 running 的任何节点；都没有时条目保持项目级
   * （nodeId 为 undefined）。
   */
  function currentNodeOf(project, state) {
    if (state.nodeId !== undefined) return state.nodeId
    const graph = currentGraphOf(project, state)
    const running = graph?.nodes?.filter((node) => node.status === 'running') ?? []
    if (running.length === 1) return running[0].id
    return undefined
  }

  /** Append one entry, evicting oldest beyond the caps. */
  function push(state, entry) {
    state.entries.push(entry)
    state.bytes += JSON.stringify(entry).length + 24
    state.seq += 1
    entry.seq = state.seq
    while (state.entries.length > MAX_ENTRIES || state.bytes > MAX_BYTES) {
      const dropped = state.entries.shift()
      if (dropped === undefined) break
      state.bytes -= JSON.stringify(dropped).length + 24
      state.evicted += 1
      state.reset = true
    }
    state.lastEventAt = nowOf()
    state.updatedAt = state.lastEventAt
    state.idleWarned = false
    return entry
  }

  /** Create (or extend) the open reasoning/text entry for one attempt. */
  function appendStreamText(state, attemptId, kind, text, nodeId) {
    if (typeof text !== 'string' || text.length === 0) return
    const live = state.attempts.get(attemptId)?.[kind]
    if (live !== undefined && live.truncated !== true && (live.nodeId ?? undefined) === (nodeId ?? undefined)) {
      const total = live.text + text
      const clamped = clamp(total)
      live.text = clamped.text
      live.truncated = clamped.truncated
      live.time = nowOf()
      state.updatedAt = live.time
      state.lastEventAt = live.time
      return
    }
    const clamped = clamp(text)
    const entry = push(state, {
      seq: 0,
      time: nowOf(),
      nodeId,
      kind,
      text: clamped.text,
      ...(clamped.truncated ? { truncated: true } : {}),
    })
    let bucket = state.attempts.get(attemptId)
    if (bucket === undefined) {
      bucket = {}
      state.attempts.set(attemptId, bucket)
    }
    bucket[kind] = entry
    // 尝试表保持有界：活跃流并发的尝试屈指可数，结束的趁机清掉。
    if (state.attempts.size > 32) {
      const firstKey = state.attempts.keys().next().value
      state.attempts.delete(firstKey)
    }
  }

  function closeAttempt(state, attemptId) {
    const bucket = state.attempts.get(attemptId)
    if (bucket === undefined) return
    delete bucket.reasoning
    delete bucket.text
    if (Object.keys(bucket).length === 0) state.attempts.delete(attemptId)
  }

  /* ------------------------------------------------------- edit tracking --- */

  /**
   * 被编辑路径必须落在其中的根（项目源码 + 项目目录）。v1.0：项目已解析的
   * 持久目录（`state.dir`，来自 `lib/paths.js`）优先；默认根拼写只是回退。
   */
  function projectRootsOf(project, state) {
    const roots = []
    for (const viewName of ['tasks', 'modules']) {
      const importedFrom = store.get(project, viewName)?.graph?.meta?.importedFrom
      if (typeof importedFrom === 'string' && importedFrom.length > 0) {
        roots.push(path.normalize(importedFrom))
        break
      }
    }
    const current = store.get(project)
    if (typeof current?.dir === 'string' && current.dir.length > 0) {
      roots.push(current.dir)
      return roots
    }
    const cwd = current?.cwd
    if (typeof cwd === 'string' && cwd.length > 0) {
      roots.push(projectDirPath(cwd, projectKeyOf(project)))
    }
    return roots
  }

  /** Resolve raw paths to absolute paths inside one of the project roots. */
  function resolveEditPaths(rawPaths, roots) {
    const out = []
    for (const raw of rawPaths) {
      const text = String(raw)
      let abs
      if (isAbsolutePath(text)) {
        abs = path.normalize(text)
      } else {
        const root = roots.find((candidate) => typeof candidate === 'string' && candidate.length > 0)
        if (root === undefined) continue
        abs = path.join(root, ...text.split('/'))
      }
      if (typeof abs !== 'string' || abs.length === 0) continue
      if (!roots.some((root) => pathContains(root, abs))) continue
      out.push(abs)
    }
    return out
  }

  /**
   * 宿主侧把一个被编辑文件匹配到节点（唯一事实来源）：模块图 → 与该文件
   * `params.path` 相同的文件级 `module` 节点（symbol 子节点绝不作为主高亮）；
   * 任务图 → artifacts 或 instruction 引用了该相对路径的节点。
   */
  function matchNodesForPath(project, abs, rel) {
    const nodeIds = { tasks: [], modules: [] }
    const modulesGraph = store.get(project, 'modules')?.graph
    if (modulesGraph?.nodes?.length) {
      for (const node of modulesGraph.nodes) {
        if (node.type !== 'module') continue
        const nodePath = node.params?.path
        if (typeof nodePath !== 'string' || nodePath.length === 0) continue
        if (!samePath(nodePath, abs)) continue
        const symbol = node.params?.symbol
        if (symbol === undefined || symbol === '') nodeIds.modules.push(node.id)
      }
    }
    const tasksGraph = store.get(project, 'tasks')?.graph
    if (tasksGraph?.nodes?.length && typeof rel === 'string' && rel.length > 0) {
      for (const node of tasksGraph.nodes) {
        let hit = Array.isArray(node.artifacts) && node.artifacts.some((artifact) => referencesPath(artifact?.path, rel))
        if (!hit && typeof node.params?.instruction === 'string') {
          hit = foldPath(node.params.instruction).includes(foldPath(rel))
        }
        if (hit) nodeIds.tasks.push(node.id)
      }
    }
    return nodeIds
  }

  /** Record write-tool targets as in-memory edits (never into workflow.json). */
  function trackToolEdits(project, state, callId, toolName, rawArguments, nodeId) {

    const args = normalizeToolArguments(rawArguments)
    const rawPaths = extractEditPaths(args)
    if (rawPaths.length === 0) return
    const roots = projectRootsOf(project, state)
    const resolved = resolveEditPaths(rawPaths, roots)
    if (resolved.length === 0) {
      // 放不进项目内的路径安静忽略：不记记录、不刷错误（高亮契约，B5）。
      return
    }
    const targets = []
    for (const abs of resolved) {
      const key = foldPath(abs)
      let record = state.edits.get(key)
      const relRoot = roots.find((root) => pathContains(root, abs))
      const rel = relRoot !== undefined ? path.relative(relRoot, abs).split(path.sep).join('/') : undefined
      // v1.5.0：给类型识别记一条证据——是哪个节点发起的这次写（rel 已是
      // 项目内相对路径；编辑记录本身仍按路径匹配 nodeIds，两者互不影响）。
      if (typeof rel === 'string' && rel.length > 0) {
        state.evidence.writes.push({ nodeId: nodeId ?? null, rel, tool: toolName, at: nowOf() })
        if (state.evidence.writes.length > MAX_WRITE_EVIDENCE) {
          state.evidence.writes.splice(0, state.evidence.writes.length - MAX_WRITE_EVIDENCE)
        }
      }
      if (record === undefined) {
        record = {
          path: abs,
          rel,
          nodeIds: { tasks: [], modules: [] },
          state: 'editing',
          tool: toolName,
          callId,
          at: nowOf(),
        }
        state.edits.set(key, record)
        // 表格限界：先丢最老的已完成记录，再丢最老的。
        if (state.edits.size > MAX_EDIT_RECORDS) {
          let oldestKey
          let oldestAt = Infinity
          for (const [existingKey, existing] of state.edits) {
            const score = existing.state === 'editing' ? existing.at + 86_400_000 : existing.at
            if (score < oldestAt) {
              oldestAt = score
              oldestKey = existingKey
            }
          }
          if (oldestKey !== undefined) state.edits.delete(oldestKey)
        }
      } else {
        record.state = 'editing'
        record.tool = toolName
        record.callId = callId
        record.at = nowOf()
        if (rel !== undefined) record.rel = rel
      }
      const matched = matchNodesForPath(project, abs, record.rel)
      record.nodeIds.tasks = [...new Set([...record.nodeIds.tasks, ...matched.tasks])]
      record.nodeIds.modules = [...new Set([...record.nodeIds.modules, ...matched.modules])]
      targets.push(key)

      if (matched.tasks.length === 0 && matched.modules.length === 0 && !state.unmatchedNoted) {
        state.unmatchedNoted = true
        push(state, { seq: 0, time: nowOf(), nodeId, kind: 'status', text: '修改了未纳入结构图的文件' })
      }
    }
    if (typeof callId === 'string' && callId.length > 0) {
      state.pendingEdits.set(callId, targets)
      if (state.pendingEdits.size > 128) {
        const first = state.pendingEdits.keys().next().value
        state.pendingEdits.delete(first)
      }
    }
  }

  /** Close the edits of one tool call according to its result. */
  function settleToolEdits(state, callId, isError) {
    if (typeof callId !== 'string') return
    const targets = state.pendingEdits.get(callId)
    if (targets === undefined) return
    state.pendingEdits.delete(callId)
    for (const key of targets) {
      const record = state.edits.get(key)
      if (record === undefined || record.state !== 'editing') continue
      record.state = isError === true ? 'error' : 'done'
      record.at = nowOf()
    }
  }

  /**
   * v1.5.0：给类型识别记一条命令证据（shell 类工具，复用 SHELLISH_TOOL 判定；
   * 命令参数兼容 `cmd` / `command` 两种键名）。`isTest` 由 classify.js 导出的
   * 唯一正则计算——活动层不写第二套测试命令判定。
   */
  function trackShellCommand(state, toolName, rawArguments, nodeId) {
    if (!SHELLISH_TOOL.test(String(toolName ?? ''))) return
    const args = normalizeToolArguments(rawArguments)
    const cmd = typeof args?.cmd === 'string' && args.cmd.length > 0
      ? args.cmd
      : (typeof args?.command === 'string' && args.command.length > 0 ? args.command : undefined)
    if (cmd === undefined) return
    state.evidence.commands.push({
      nodeId: nodeId ?? null,
      cmd: cmd.slice(0, MAX_COMMAND_TEXT),
      isTest: isTestCommand(cmd),
      at: nowOf(),
    })
    if (state.evidence.commands.length > MAX_COMMAND_EVIDENCE) {
      state.evidence.commands.splice(0, state.evidence.commands.length - MAX_COMMAND_EVIDENCE)
    }
  }

  /** Finalize edits still open when the turn ends (their result never arrived). */
  function finalizeEdits(state) {
    for (const record of state.edits.values()) {
      if (record.state !== 'editing') continue
      record.state = 'done'
      record.at = nowOf()
    }
    state.pendingEdits.clear()
  }

  /** The read model's edit list, newest first. */
  function editsOf(state) {
    return [...state.edits.values()]
      .sort((left, right) => right.at - left.at)
      .slice(0, MAX_EDIT_RECORDS)
      .map((record) => ({
        path: record.path,
        rel: record.rel ?? null,
        nodeIds: { tasks: [...record.nodeIds.tasks], modules: [...record.nodeIds.modules] },
        state: record.state,
        tool: record.tool ?? null,
        at: record.at,
      }))
  }

  /* --------------------------------------------------------- event wiring --- */

  /** Handle one durable session event. */
  function onSessionEvent(session, event) {
    if (session === undefined || event === undefined || event === null) return

    const sessionId = typeof session.id === 'string' ? session.id : session?.header?.id
    const project = projectOfSession(sessionId)
    if (project === undefined) return
    const state = stateOf(project)
    if (state.sessionId === undefined) state.sessionId = sessionId
    const data = event?.data
    const nodeId = currentNodeOf(project, state)

    switch (event.type) {
      case 'turn/start': {
        state.running = true
        push(state, { seq: 0, time: nowOf(), nodeId, kind: 'status', text: '回合开始' })
        break
      }
      case 'step/start': {
        push(state, { seq: 0, time: nowOf(), nodeId, kind: 'step', text: `第 ${data?.step ?? '?'} 步` })
        break
      }
      case 'tool/call': {
        const entry = push(state, {
          seq: 0,
          time: nowOf(),
          nodeId,
          kind: 'tool',
          text: toolSummary(data?.name, data?.arguments),
          name: typeof data?.name === 'string' ? data.name : undefined,
          status: 'running',
        })
        if (typeof data?.callId === 'string') {
          state.pendingTools.set(data.callId, { entry, at: nowOf() })
          if (state.pendingTools.size > 64) {
            const first = state.pendingTools.keys().next().value
            state.pendingTools.delete(first)
          }
        }
        // 只认真实的写文件工具：推理文本、节点标题与只读工具永远造不出
        // 编辑记录。
        if (isWriteTool(data?.name) && state.running) {
          try {
            trackToolEdits(project, state, data?.callId, data?.name, data?.arguments, nodeId)
          } catch (error) {
            logger?.warn?.(`codeflow: edit tracking failed: ${String(error)}`)
          }
        }
        // v1.5.0：shell 类工具同时给类型识别记一条命令证据（有界、纯内存）。
        if (state.running) {
          try {
            trackShellCommand(state, data?.name, data?.arguments, nodeId)
          } catch (error) {
            logger?.warn?.(`codeflow: command evidence failed: ${String(error)}`)
          }
        }
        break
      }
      case 'tool/result': {
        const callId = data?.message?.callId
        const pending = typeof callId === 'string' ? state.pendingTools.get(callId) : undefined
        const isError = data?.message?.isError === true || data?.error !== undefined
        if (pending !== undefined) {
          state.pendingTools.delete(callId)
          pending.entry.status = isError ? 'error' : 'ok'
          pending.entry.ms = Math.max(0, nowOf() - pending.at)
        }
        settleToolEdits(state, callId, isError)
        break
      }
      case 'assistant/message': {
        const text = messageText(data?.message)
        if (text.length > 0) {
          const clamped = clamp(text)
          push(state, {
            seq: 0,
            time: nowOf(),
            nodeId,
            kind: 'text',
            text: clamped.text,
            ...(clamped.truncated ? { truncated: true } : {}),
          })
        }
        break
      }
      case 'deliverables/presented': {
        const files = Array.isArray(data?.files)
          ? data.files
            .map((file) => (file !== null && typeof file === 'object' && typeof file.path === 'string' ? file.path : undefined))
            .filter((filePath) => filePath !== undefined)
          : []
        if (files.length > 0) {
          state.presented = [...new Set([...(state.presented ?? []), ...files])]
          push(state, { seq: 0, time: nowOf(), nodeId, kind: 'status', text: `已提交 ${files.length} 个交付卡片` })
          if (typeof options.onPresented === 'function') {
            try {
              options.onPresented(project, files)
            } catch (error) {
              logger?.warn?.(`codeflow: onPresented failed: ${String(error)}`)
            }
          }
        }
        break
      }
      case 'turn/end': {
        state.running = false
        state.attempts.clear()
        state.pendingTools.clear()
        push(state, { seq: 0, time: nowOf(), nodeId, kind: 'status', text: '回合结束' })
        finalizeEdits(state)
        finishTurn(project, state)
        break
      }
      default:
        // 其余一切（压缩、审批、改名…）对画布都是噪音；忽略它们才能让
        // 缓冲保持有用。
        break
    }
  }

  /**
   * A finished turn means no further node results can arrive: any node still
   * marked running would spin forever on the canvas, so it is failed with an
   * actionable reason (never invented success). Only the run's view is
   * touched — the other view's running nodes (if any) belong to its own run.
   *
   * v1.0（A3.4）：宿主对账（`options.onTurnEnd`）先于滞留兜底执行——它把
   * "从未执行"的运行目标置为 failed 并记录 issue；随后的滞留兜底只接手
   * 对账没处理的真正 running 节点（agent 动过手但回合中断的那种）。
   */
  function finishTurn(project, state) {
    const viewName = normalizeView(state.view) ?? 'tasks'
    if (typeof options.onTurnEnd === 'function') {
      try {
        options.onTurnEnd(project)
      } catch (error) {
        logger?.warn?.(`codeflow: onTurnEnd failed: ${String(error)}`)
      }
    }
    const graph = store.get(project, viewName)?.graph
    const stragglers = graph?.nodes?.filter((node) => node.status === 'running') ?? []
    for (const node of stragglers) {
      const detail = '执行回合结束但未收到节点结果'.slice(0, 200)
      store.patchNode(project, node.id, {
        status: 'failed',
        result: '回合结束，未收到结果',
        detail: node.detail ? `${detail}；${node.detail}`.slice(0, 2000) : detail,
      }, { view: viewName })
      push(state, { seq: 0, time: nowOf(), nodeId: node.id, kind: 'status', text: '节点未回填结果，已标记为失败' })
    }
  }

  /** Handle one assistant stream frame. */
  function onAssistantStream(payload) {
    const agent = payload?.agent
    const frame = payload?.frame
    if (frame === undefined || frame === null) return
    const sessionId = typeof agent?.id === 'string' ? agent.id : undefined
    const project = projectOfSession(sessionId)
    if (project === undefined) return
    const state = stateOf(project)
    if (state.sessionId === undefined) state.sessionId = sessionId

    if (frame.type === 'start') {
      state.running = true
      if (typeof frame.attemptId === 'string') {
        let bucket = state.attempts.get(frame.attemptId)
        if (bucket === undefined) {
          bucket = {}
          state.attempts.set(frame.attemptId, bucket)
        }
        bucket.nodeId = currentNodeOf(project, state)
      }
      state.lastEventAt = nowOf()
      state.updatedAt = state.lastEventAt
      state.idleWarned = false
      return
    }
    if (frame.type === 'chunk') {
      const attemptId = typeof frame.attemptId === 'string' ? frame.attemptId : 'live'
      const bucket = state.attempts.get(attemptId)
      const nodeId = bucket?.nodeId ?? currentNodeOf(project, state)
      const chunk = frame.chunk
      if (chunk !== null && typeof chunk === 'object') {
        if (chunk.type === 'reasoning-delta') appendStreamText(state, attemptId, 'reasoning', chunk.text, nodeId)
        else if (chunk.type === 'text-delta') appendStreamText(state, attemptId, 'text', chunk.text, nodeId)
        // tool-call-delta 帧与持久的 tool/call 事件重复，刻意跳过。
      }
      return
    }
    if (frame.type === 'end') {
      if (typeof frame.attemptId === 'string') closeAttempt(state, frame.attemptId)
    }
  }

  /**
   * 记录一次 `codeflow_canvas` 的 progress 调用。`status` 镜像节点状态白名单；
   * `step`/`percent` 只活在这里（内存），绝不进图。`view` 钉住本次运行作用的
   * 是哪张图。
   */
  function noteProgress(project, patch = {}) {
    const state = stateOf(project)
    const runView = normalizeView(patch.view)
    if (runView !== undefined) state.view = runView
    const nodeId = typeof patch.nodeId === 'string' ? patch.nodeId : state.nodeId
    if (typeof patch.nodeId === 'string') state.nodeId = patch.nodeId
    if (patch.status === 'running') {
      state.running = true
      if (state.startedAt === undefined || state.nodeId !== nodeId) state.startedAt = nowOf()
    }
    if (patch.status === 'done' || patch.status === 'failed' || patch.status === 'skipped') {
      // 节点到达终态就撤掉它的百分比；RUN_ALL 继续推进下一个节点。
      state.percent = undefined
    }
    if (typeof patch.step === 'string' && patch.step.trim().length > 0) {
      push(state, { seq: 0, time: nowOf(), nodeId, kind: 'step', text: patch.step.trim().slice(0, MAX_TEXT) })
    }
    if (typeof patch.percent === 'number' && Number.isFinite(patch.percent) && nodeId !== undefined) {
      const percent = Math.max(0, Math.min(100, Math.round(patch.percent)))
      state.percent = { nodeId, percent }
    }
    state.lastEventAt = nowOf()
    state.updatedAt = state.lastEventAt
    state.idleWarned = false
  }

  /**
   * 记录宿主发现的一次运行问题（v1.0 A3.4）：运行的回合结束了，但目标节点
   * 从未被执行——画布因此能给出「重试」，而不是一个安静的 pending。只留
   * 最新一条、只在内存；下一次 `beginRun`（重试也是一次）会清掉它。
   */
  function noteIssue(project, issue = {}) {
    const state = stateOf(project)
    state.issue = {
      at: typeof issue.at === 'number' ? issue.at : nowOf(),
      nodeId: typeof issue.nodeId === 'string' ? issue.nodeId : null,
      text: String(issue.text ?? '').slice(0, 500),
      retry: issue.retry === true,
    }
    push(state, { seq: 0, time: nowOf(), nodeId: state.issue.nodeId ?? undefined, kind: 'status', text: state.issue.text })
    return state.issue
  }

  /** Mark the beginning of a canvas-initiated run. */
  function beginRun(project, { action, nodeId, sessionId, view } = {}) {
    const state = stateOf(project)
    state.running = true
    state.action = typeof action === 'string' ? action : undefined
    state.nodeId = typeof nodeId === 'string' ? nodeId : undefined
    state.view = normalizeView(view) ?? 'tasks'
    state.startedAt = nowOf()
    state.percent = undefined
    state.idleWarned = false
    // A new run (a click on 运行/重试) supersedes any stale issue banner.
    state.issue = undefined
    // v1.5.0：证据是「本次运行」语义——新一次运行从空证据开始。
    state.evidence = { writes: [], commands: [] }
    // 新的运行取代上一个编辑窗口的标记。
    finalizeEdits(state)
    for (const record of state.edits.values()) {
      if (record.state !== 'editing') continue
      record.state = 'done'
      record.at = nowOf() - 20_000 // previous run's marks age out quickly
    }
    if (sessionId !== undefined) state.sessionId = sessionId
    state.lastEventAt = state.startedAt
    state.updatedAt = state.startedAt
    push(state, {
      seq: 0,
      time: state.startedAt,
      nodeId: state.nodeId,
      kind: 'status',
      text: action === 'RUN_ALL' ? '开始运行全部节点' : '开始运行节点',
    })
  }

  /** Clear one project's buffer (undo, new session, explicit reset). */
  function clear(project) {
    const key = projectKeyOf(project)
    const state = projects.get(key)
    if (state === undefined) return
    state.entries = []
    state.bytes = 0
    state.evicted += 1
    state.reset = true
    state.running = false
    state.nodeId = undefined
    state.startedAt = undefined
    state.percent = undefined
    state.presented = undefined
    state.issue = undefined
    state.edits.clear()
    state.pendingEdits.clear()
    state.unmatchedNoted = false
    state.attempts.clear()
    state.pendingTools.clear()
    state.evidence = { writes: [], commands: [] }
    state.updatedAt = nowOf()
  }

  /** Drop one project's activity entirely (dispose / project removal). */
  function drop(project) {
    projects.delete(projectKeyOf(project))
  }

  /** Whether any project still has live activity. */
  function hasLive() {
    return projects.size > 0
  }

  /**
   * v1.5.0：类型识别证据的只读查询（深拷贝普通数组）。识别服务（lib/typing/
   * service.js）只经这里取证据——**不得**访问活动中心的内部 Map。绝不把证据
   * 塞进 entries（UI 读模型）或任何持久化结构。
   */
  function evidenceOf(project) {
    const state = projects.get(projectKeyOf(project))
    const writes = Array.isArray(state?.evidence?.writes) ? state.evidence.writes : []
    const commands = Array.isArray(state?.evidence?.commands) ? state.evidence.commands : []
    return {
      writes: writes.map((entry) => ({ ...entry })),
      commands: commands.map((entry) => ({ ...entry })),
    }
  }

  /** The read model the panel polls. */
  function activity(project, { after, nodeId } = {}) {
    const key = projectKeyOf(project)
    const state = projects.get(key)
    if (state === undefined) {
      return {
        ok: true,
        project: key,
        sessionId: store.get(key)?.sessionId ?? null,
        running: false,
        action: null,
        nodeId: null,
        view: 'tasks',
        startedAt: null,
        updatedAt: null,
        seq: 0,
        reset: false,
        entries: [],
        edits: [],
        progress: null,
        issue: null,
      }
    }
    // 惰性空闲监视：15 分钟没有任何事件的运行被上报为"可能已中断"——
    // 是警告，绝不是虚构的完成。
    if (state.running && state.lastEventAt > 0 && nowOf() - state.lastEventAt > IDLE_MINUTES * 60_000 && !state.idleWarned) {
      state.idleWarned = true
      state.running = false
      push(state, { seq: 0, time: nowOf(), nodeId: state.nodeId, kind: 'status', text: '执行可能已中断：超过 15 分钟没有收到任何事件' })
    }
    const afterSeq = Number.isFinite(Number(after)) ? Number(after) : 0
    const entries = state.entries
      .filter((entry) => entry.seq > afterSeq)
      .filter((entry) => nodeId === undefined || nodeId === null || entry.nodeId === undefined || entry.nodeId === nodeId)
    const wantsReset = state.reset && afterSeq === 0
    if (afterSeq === 0) state.reset = false
    return {
      ok: true,
      project: key,
      sessionId: state.sessionId ?? store.get(key)?.sessionId ?? null,
      running: state.running,
      action: state.action ?? null,
      nodeId: state.nodeId ?? null,
      view: normalizeView(state.view) ?? 'tasks',
      startedAt: state.startedAt ?? null,
      updatedAt: state.updatedAt > 0 ? state.updatedAt : null,
      seq: state.seq,
      reset: wantsReset,
      entries,
      edits: editsOf(state),
      progress: progressOf(project, state),
      issue: state.issue ?? null,
    }
  }

  /** Overall progress, computed from the run view's graph — never estimated. */
  function progressOf(project, state) {
    const graph = currentGraphOf(project, state)
    if (graph === undefined || !Array.isArray(graph.nodes) || graph.nodes.length === 0) return null
    const nodes = graph.nodes
    const done = nodes.filter((node) => node.status === 'done').length
    const failed = nodes.filter((node) => node.status === 'failed').length
    const current = currentNodeOf(project, state) ?? null
    const nodeSteps = current === undefined || current === null
      ? 0
      : state.entries.filter((entry) => entry.nodeId === current && (entry.kind === 'tool' || entry.kind === 'step')).length
    const percent = state.percent !== undefined && (state.percent.nodeId === current || current === null)
      ? state.percent.percent
      : null
    return {
      done,
      failed,
      total: nodes.length,
      current,
      steps: nodeSteps,
      elapsedMs: state.startedAt !== undefined ? Math.max(0, nowOf() - state.startedAt) : null,
      percent,
    }
  }

  /**
   * 订阅宿主事件总线。必须在插件 fiber 内调用，监听器才随插件一起销毁
   * （`ctx.effect`）。
   */
  function attach(ctxInstance) {
    ctxInstance.effect(() => ctxInstance.on('session/event', onSessionEvent), 'codeflow: session events')
    ctxInstance.effect(() => ctxInstance.on('agent/assistant-stream', onAssistantStream), 'codeflow: assistant stream')
  }

  return {
    attach,
    beginRun,
    noteProgress,
    noteIssue,
    clear,
    drop,
    hasLive,
    activity,
    evidenceOf,
    currentViewOf,
    options,
  }
}

/** Safe (short, single-line, secret-tolerant) summary of one tool call. */
function toolSummary(name, args) {
  const label = typeof name === 'string' && name.length > 0 ? name : 'tool'
  if (args === null || typeof args !== 'object') return label
  const cmd = typeof args.cmd === 'string' ? args.cmd
    : typeof args.command === 'string' ? args.command
    : undefined
  if (cmd !== undefined && SHELLISH_TOOL.test(label)) {
    const oneLine = cmd.replace(/\s+/g, ' ').trim()
    return `${label}: ${oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine}`
  }
  return label
}

/** Truncate one text to the entry cap, marking the cut. */
function clamp(text) {
  if (text.length <= MAX_TEXT) return { text, truncated: false }
  return { text: `${text.slice(0, MAX_TEXT)}…（已截断）`, truncated: true }
}

/** Pull the text out of an assistant message content list. */
function messageText(message) {
  const blocks = message?.content
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim()
}
