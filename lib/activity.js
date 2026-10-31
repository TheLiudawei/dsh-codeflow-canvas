/**
 * The Activity Hub: a memory-only view of what the canvas session is doing
 * right now — reasoning stream, tool calls, steps, progress, and (v0.6.0) the
 * project files real write-tools are editing — for the panel's poller.
 *
 * Sources (verified against DSH 0.2.1-rc.5):
 *
 *   ctx.on('session/event', (session, event) => …)
 *     event = { type, seq, data, … }; `session.id` addresses the session.
 *     Used here: turn/start, turn/end, step/start, tool/call
 *     { turn, step, callId, name, arguments }, tool/result
 *     { turn, step, message, error?, meta? }, assistant/message
 *     { turn, step, message }, deliverables/presented
 *     { turn, callId, files }.
 *
 *   ctx.on('agent/assistant-stream', ({ agent, frame }) => …)
 *     frame = { type: 'start'|'chunk'|'end', attemptId, revision, turn, step,
 *     index, chunk?, outcome? } with chunk.type 'reasoning-delta' | 'text-delta'
 *     | 'tool-call-delta' carrying `.text` / `.argumentsDelta`.
 *
 * Everything is filtered to sessions currently bound to a canvas project;
 * nothing from any other conversation is ever buffered. Buffers are bounded
 * (500 entries / 256 KiB per project, 4 KiB text per entry), reasoning deltas
 * of one attempt merge into a single growing entry, and eviction raises a
 * `reset` flag so the client knows to clear and refetch. Nothing here is ever
 * persisted — not to workflow.json, not to logs.
 *
 * Runs are view-aware (v0.6.0): `beginRun`/`noteProgress` record whether the
 * run targets the task pipeline or the module graph, and every graph lookup
 * (current node, progress, end-of-turn cleanup) reads that view only — a user
 * switching the panel to the other view mid-run never disturbs the running
 * graph.
 *
 * File-edit tracking (v0.6.0) is derived **only** from real write-tool calls:
 * `tool/call` of an allowlisted tool with resolvable path arguments opens an
 * in-memory edit record, `tool/result` closes it, `turn/end` finalizes
 * stragglers. Reasoning text, node titles and read-only tools never produce
 * edits. The edit table is bounded (100 records/project, 20 paths/call) and
 * matches edited paths to module/task nodes host-side, so the panel is a pure
 * renderer of facts.
 *
 * The degradation ladder lives on the client; this hub only records what it
 * really saw: reasoning entries when `reasoning-delta` frames arrive, durable
 * tool/step/text entries from `session/event` otherwise. Nothing is invented —
 * no percentages, no remaining-time estimates, no synthesized reasoning.
 *
 * @module dsh-codeflow-canvas/activity
 */
import path from 'node:path'

import { normalizeView, projectDirPath, projectKeyOf } from './store.js'

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
 * Tools whose *successful call means a file is being written*. This is the
 * highlight allowlist: intentionally narrow, matched on the tool name only.
 * Anything not listed here (read/grep/glob/inspect/present/…) can never create
 * an edit record, no matter what its arguments contain.
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

/** Node statuses that may be patched automatically when a turn ends. */
function nowOf() {
  return Date.now()
}

/**
 * Tool-call arguments arrive as an object in most hosts, but some serialize
 * them as a JSON string. Normalize to an object so path extraction works for
 * both shapes; anything unparseable comes back unchanged (and yields no paths).
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
        // Not JSON — fall through and let extraction treat it as opaque.
      }
    }
  }
  return args
}

/**
 * Whether one tool call may edit project files. Deliberately conservative:
 * the cost of a missed highlight is one dim module, the cost of a wrong one is
 * a lie on the canvas.
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
  // A bare word without separator or extension is usually not a path.
  return text.includes('/') || text.includes('\\') || text.includes('.') || /^[a-zA-Z]:/.test(text)
}

/** Normalize one raw path value to `/` separators; returns `undefined` for junk. */
function normalizeRawPath(value) {
  if (!plausiblePath(value)) return undefined
  let text = String(value).trim().replace(/^file:\/\//i, '')
  if (text.startsWith('file:')) return undefined
  text = text.split('\\').join('/')
  // Trim an `a/`/`b/` diff prefix that slipped through the marker regexes.
  text = text.replace(/^[ab]\//, '')
  return text.length > 0 ? text : undefined
}

/**
 * Extract candidate file paths from one write-tool call's arguments, per the
 * highlight contract: single-value keys first, then array keys, then patch
 * markers inside string arguments. Order is priority order; the result is
 * capped at {@link MAX_PATHS_PER_CALL}.
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

/** Containment test with `/` separators, case-folding on Windows. */
function insidePath(root, target) {
  const rel = path.relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

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
 * Create the Activity Hub.
 *
 * @param options.store - canvas store (source of bindings and graph state).
 * @param options.logger - Cordis logger.
 * @returns the hub handle; register it with `ctx.effect` via `attach(ctx)`.
 */
export function createActivityHub({ store, logger }) {
  /** Host-side hooks the plugin entry fills in (node updates, undo bookkeeping). */
  const options = { onPresented: undefined, onTurnEnd: undefined }

  /**
   * @type {Map<string, {
   *   sessionId?: string, running: boolean, action?: string, nodeId?: string,
   *   view?: 'tasks'|'modules',
   *   startedAt?: number, updatedAt: number, seq: number, entries: object[],
   *   bytes: number, evicted: number, reset: boolean, lastEventAt: number,
   *   idleWarned: boolean, attempts: Map<string, {reasoning?: object, text?: object}>,
   *   pendingTools: Map<string, {entry: object, at: number}>,
   *   pendingEdits: Map<string, string[]>,
   *   edits: Map<string, object>,
   *   unmatchedNoted: boolean,
   *   percent?: { nodeId: string, percent: number },
   *   presented?: string[],
   * }>}
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
        // Latest run problem (v1.0 A3.4): "the turn ended but the node was
        // never executed". Memory-only, newest only; cleared by beginRun.
        issue: undefined,
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
   * The node activity should attach to: the explicit run target wins, then
   * the progress tool's current node, then any node the *run view's* graph
   * marks running; otherwise the entry stays project-level (nodeId undefined).
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
    // Keep the attempt table bounded: live streams never hold more than a
    // handful of concurrent attempts, but drop finished ones opportunistically.
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
   * The roots an edited path must live inside (project source + project dir).
   * v1.0: the project's resolved durable directory (`state.dir`, from
   * `lib/paths.js`) wins; the default-root spelling is only the fallback.
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
      if (path.isAbsolute(text) || /^[a-zA-Z]:[\\/]/.test(text) || text.startsWith('\\\\')) {
        abs = path.normalize(text)
      } else {
        const root = roots.find((candidate) => typeof candidate === 'string' && candidate.length > 0)
        if (root === undefined) continue
        abs = path.join(root, ...text.split('/'))
      }
      if (typeof abs !== 'string' || abs.length === 0) continue
      if (!roots.some((root) => insidePath(root, abs))) continue
      out.push(abs)
    }
    return out
  }

  /**
   * Match one edited file to nodes, host-side (the single source of truth):
   * module graph → the file-level `module` node with the same `params.path`
   * (symbol children never become the primary highlight); task graph → nodes
   * whose artifacts or instruction reference the relative path.
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
      // Paths we cannot place inside the project are ignored silently: no
      // records, no error spam (the highlight contract, B5).
      return
    }
    const targets = []
    for (const abs of resolved) {
      const key = foldPath(abs)
      let record = state.edits.get(key)
      const relRoot = roots.find((root) => insidePath(root, abs))
      const rel = relRoot !== undefined ? path.relative(relRoot, abs).split(path.sep).join('/') : undefined
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
        // Bound the table: drop the oldest finished record first, then oldest.
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
        // Real write tools only: reasoning text, node titles and read-only
        // tools can never manufacture an edit record.
        if (isWriteTool(data?.name) && state.running) {
          try {
            trackToolEdits(project, state, data?.callId, data?.name, data?.arguments, nodeId)
          } catch (error) {
            logger?.warn?.(`codeflow: edit tracking failed: ${String(error)}`)
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
        // Everything else (compaction, approvals, titles…) is noise for the
        // canvas; ignoring it is what keeps the buffer relevant.
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
        // tool-call-delta frames are redundant with the durable tool/call
        // events and are skipped on purpose.
      }
      return
    }
    if (frame.type === 'end') {
      if (typeof frame.attemptId === 'string') closeAttempt(state, frame.attemptId)
    }
  }

  /**
   * Record a `codeflow_canvas` progress call. `status` mirrors the node
   * whitelist; `step`/`percent` live only here (memory), never in the graph.
   * `view` pins which graph the run is working on.
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
      // A terminal node retires its percent; RUN_ALL moves on to the next node.
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
   * Record a run problem the host noticed (v1.0 A3.4): the run's turn ended
   * but the target node was never executed, so the canvas can offer a retry
   * instead of a silent pending. Newest only, memory-only; the next `beginRun`
   * (a retry is one) clears it.
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
    // A new run supersedes the previous edit window's marks.
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
    // Lazy idle watch: a run with no events for 15 minutes is reported as
    // possibly interrupted — a warning, never a fabricated completion.
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
   * Subscribe to the host event bus. Must be called inside the plugin fiber
   * so the listeners are disposed with it (`ctx.effect`).
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
