# dsh-codeflow-canvas

A ComfyUI-style coding workflow canvas for DSH (DeepSeek Harness).
**Every node is an agent-executable coding task; every link is a dependency / dataflow.**
You orchestrate on the canvas, the agent executes for real in the workspace and writes results back.

English | [简体中文](README.zh-CN.md)

This package is a port of the ZCode plugin `codeflow-canvas` v0.2.2 (**v0.6.0**): the canvas
editor itself carries over from the original implementation, while all host wiring was rewritten
for DSH. v0.5.0 added: **native delivery cards (present), a dedicated session per project,
real-time execution traces (reasoning stream / steps / progress), and per-run undo snapshots**.
v0.5.1 fixed: whole-graph write-back now **prefers "edit the graph file + `codeflow_canvas`
`mode:\"load\"`"** — the full graph JSON no longer travels through tool arguments (very long
nested JSON would trip the model tool call into `tool input is invalid JSON` → a whole-turn
`MALFORMED_RESPONSE`, and that error is not in the host's default retry code list).
v0.6.0 added: **dual views (one import produces both the task pipeline and the module graph,
switchable from the toolbar at any time), module highlighting when the agent edits code
(based on real file-write tool calls), and a searchable two-level navigation list**.
v1.0.1 fixes and upgrades: **test runs execute for real (self-contained run requests +
end-of-turn reconciliation + one-click retry), the canvas fills the panel on all four sides,
and projects move under `<workspace>/CodeFlow/` (configurable root, automatic legacy migration)**.
v1.2.0 added: **module coupling analysis (per-file low/medium/high labels, an overall
"tech-debt level" card, computed entirely host-side with zero tokens) and drag-and-drop
import (drop a folder or archive onto the canvas; zip/tar parsed in pure Node, 7z/rar via
system tools with a graceful fallback)**.

## What it looks like

A **CodeFlow (⬡)** icon appears in the sidebar; clicking it opens a full-screen canvas:

- **Dual views**: one import produces both the task pipeline (`workflow.json`) and the module
  graph (`workflow.modules.json`). A toolbar segmented control `[ Task pipeline 12 ] [ Module graph 28 ]`
  switches views at any time — no rescan, no re-analysis, no agent wake-up. Nodes, coordinates,
  run states and `rev` are fully independent per view; single-view projects hide the switcher.
- **Edit highlighting**: when the agent really edits a file (paths are extracted from the
  arguments of file-write tool calls — `edit`/`write`/`ops_replace`/`apply_patch` etc. — never
  guessed from conversation text), the module view highlights the corresponding file-level module
  (editing = amber pulse, done = 15-second static marker); related tasks in the task view get a
  dashed marker, and the activity row shows "edited src/foo.ts".
- **Right-click empty canvas**: new project (agent generates initial code + pipeline from a
  requirement), import project (one scan, both graphs), add node (16 kinds, searchable), tidy
  layout, fit view, run all, undo run, save, clear, help.
- **Node interaction**: drag, link (port type checking: text/json/code/report/file/any),
  right-click run/rerun/details/duplicate/rename/delete, parameter editing (changes auto-reset
  downstream), double-click for details, Delete removes selection.
- **Visible execution**: while running, each node card shows one line of "current action /
  reasoning excerpt + step count + elapsed time"; a collapsible execution monitor appears
  top-right (overall N/M, current node, latest reasoning line); the details dialog has the full
  "execution trace" (reasoning stream + tool timeline). When real reasoning is unavailable it
  degrades to a step summary — **never fabricated**.
- **Native delivery**: at runtime the `deliver` node collects real upstream outputs, writes
  `docs/DELIVERY.md`, and calls DSH's native `present` tool — delivery cards appear in the
  session; clicking a card previews it in the sidebar, with native controls to open with the
  default app / reveal in folder. The canvas only lists deliverables and does not embed a previewer.
- **Dedicated sessions**: each project gets one persistently bound canvas session (titled
  `CodeFlow · <project>`); canvas runs only go to that session. The status bar shows the entry
  point; click to open / copy ID / create new. DSH's current session is never switched automatically.
- **Undo run**: the project source tree is automatically snapshotted before each run; the toolbar
  "undo run" reverts an entire run (files + node states). Current state is backed up before
  undoing, undo survives DSH restarts, and it is strictly LIFO.
- **Module navigation**: a row of module tabs on the left (input/plan/build/execute/QA/output)
  with live counts. With ≥2 nodes in a category, clicking opens a **searchable two-level
  flyout** (filter by module name/path, ↑/↓/Enter keyboard navigation, zoom-to-fit and highlight
  on selection); with exactly 1 node it jumps directly.
- **Persistence**: canvas edits auto-save to `<workspace>/CodeFlow/flow-projects/<project>/workflow.json`
  (task pipeline) and `workflow.modules.json` (module graph); the active view is remembered in
  `view.json`, restoring the last view and zoom after restart. The project root is configurable
  (toolbar ⚙ settings → global root + per-project override) and legacy `flow-projects/` data
  migrates into the new root automatically on first start.
- **Dark/light**: follows DSH's current theme (switching syncs the canvas instantly — no reload,
  no view loss).

## Install

```bash
# Local directory install (no build step)
dsh plugin --profile desktop add link:<absolute path to this directory>
```

Or install the local directory in "Settings → Plugins". After installing, **restart DSH**
(the Host side does not hot-reload) and refresh the page.

> How to verify it activated? `curl http://127.0.0.1:<port>/codeflow/canvas` should return
> HTML with status 200; a 404 plus no `codeflow` hits under `grep -r codeflow profiles/<profile>`
> means the plugin did not install into that profile — rerun the `dsh plugin --profile <name>
> add link:<path>` above and restart (field report B1 was exactly this, not a code bug).

`package.json` has no `@deepseek-ai/*` dependencies and no build: `lib/index.js` is plain ESM,
and `lib/client.js` is a hand-written `__ModuleLoader__` bundle (following the official
`templates/decoration` format).

## Usage

| Entry | Purpose |
| --- | --- |
| `/flow` | Open the canvas (auto-loads the most recent project); with an argument, creates a project from that requirement |
| `/flow-new [requirement]` | Create a new project directly |
| `/flow-import <path>` | Import a project: **the host scans directly, producing the task pipeline and module graph in one pass, without going through the agent (zero tokens, seconds)**; paths support `@` picker, `~`, quotes and `file://`; `--modules` is a compatibility alias only |
| `codeflow_canvas` tool | The agent uses it to **write the graph back (`load`: re-read the view's graph file from disk — preferred)**, push a graph (`render`, fallback, replaces only the target view), read the graph (`read`), persist (`save`, both views), and **report progress (`progress`, callable only from the project's dedicated session)**; the `view:"tasks"\|"modules"` argument selects the view |
| Skill `codeflow-canvas` | The agent's orchestration brain (new/run/write-back/delivery semantics); `/flow*` commands attach it automatically |
| `node lib/importer.js <path>` | Standalone CLI import: produces `workflow.json` + `workflow.modules.json` in one pass, no DSH needed |

## Architecture

```
Browser (panel iframe)
  ├── GET  /codeflow/canvas        ← host assembles: canvas fragment + __CF_BOOT__ (active view graph, activeView, both-view availability)
  ├── GET  /codeflow/api/state     ← polling (?view= selects the view); a bigger rev refreshes the whole graph
  ├── POST /codeflow/api/state     ← edits auto-stage (persisted per view; response carries persisted/error; expectedRev conflict detection)
  ├── POST /codeflow/api/view      ← switch active view (writes view.json; no rev bump, no scan, no agent wake-up)
  ├── POST /codeflow/api/save      ← "Save" button: host persists directly (both views), no agent involved (failure: 507 + ok:false)
  ├── POST /codeflow/api/import    ← "Import project": deterministic host scan (lib/duo.js produces both graphs in one pass)
  ├── POST /codeflow/api/coupling  ← v1.2 coupling analysis: node coupling + the overall verdict, written to both graphs (zero LLM)
  ├── GET  /codeflow/api/coupling  ← v1.2 staleness probe (mtime check, 10s cache, ≤300 files)
  ├── POST /codeflow/api/drop/*    ← v1.2 drag-and-drop import: begin/file/finalize/abort upload channel + in-place path channel
  ├── POST /codeflow/api/action    ← run/new: snapshot (RUN_*, per view) → deliver [CodeFlow:*] to the dedicated session (with view+graphPath)
  ├── POST /codeflow/api/session   ← create/rebuild the project's dedicated session
  ├── GET  /codeflow/api/activity  ← live reasoning stream / steps / progress / file-edit records (in-memory only, 700–1000ms incremental pulls)
  ├── GET  /codeflow/api/undo      ← run history (newest first, tagged with view)
  ├── GET/POST /codeflow/api/config ← v1.0: project root settings (global root + per-project override)
  └── POST /codeflow/api/undo      ← dryRun precheck / full restore (LIFO, shared across views)
                                        ↓
             agent executes per the skill → calls codeflow_canvas (render/progress, with view)
                                        ↓
   store (per-view independent rev holder)
     + CodeFlow/flow-projects/*/workflow.json + workflow.modules.json + view.json
     + sessions.js (dedicated session binding)
   activity.js (in-memory trace buffer + edit table) + undo.js (.undo/ snapshots and restore)
```

Key design decisions:

1. **The canvas runs in an iframe.** The canvas attaches `keydown` (Delete removes nodes,
   Space pans) and pointer listeners on `window`; inside the host document it would steal
   keystrokes from the input box. The iframe also lets it reuse the original implementation 100%.
2. **The canvas is no longer generated by the agent.** The agent only submits graph JSON and
   progress; the host assembles the document and persists it.
3. **`rev` belongs to the host, per view.** Both the panel and the agent write the same state;
   each time the host accepts a write it increments `rev` **on the target view**. The panel only
   adopts new versions when it did not participate in the write, avoiding mutual overwrite.
   Incremental updates for a running node go through `store.patchNode` (single node, whitelisted
   fields, per view); whole-graph write-back uses "agent edits the graph file + `mode:\"load\"`" —
   neither needs to shove a whole graph into tool arguments (`render` is only a fallback).
   Writing one view never bumps another view's `rev`, so editing in the task graph is never
   interrupted by background updates of the module graph.
4. **No whole graph in messages.** `[CodeFlow:*]` carries `view` and `graphPath` (pointing at the
   view's graph file); the agent reads the file for exact state, so large graphs never pollute
   the conversation.
5. **Routes pass the host's security gate.** `/codeflow` can inject prompts into sessions, so —
   like other GUI routes — it requires a host-signed browser cookie
   (`connection.requestRejection`); the same-origin iframe carries that cookie naturally.
6. **Exactly one writer for session binding.** `lib/sessions.js` is the sole binding manager:
   the tool's render no longer grabs bindings, `/flow` run in any session never rewrites a
   project's dedicated session, and minimal host combos without a `sessionController` degrade
   explicitly — never falling back to "whatever session is newest".
7. **Trace data lives only in memory.** Reasoning streams, tool calls and percentages go only to
   `lib/activity.js`'s ring buffer (≤500 entries / 256 KB per project, ≤4 KB per entry), never to
   disk or logs; nodes still `running` at `turn/end` are marked `failed` by the host so the
   canvas never spins forever.
8. **Undo is per run.** `lib/undo.js` snapshots the project source tree before delivery; restore
   backs up current state first and only touches the snapshot candidate scope — changes inside
   `node_modules`/`dist`/`.git` can never be mistakenly reverted.

## The two v1.2.0 upgrades (all zero-LLM, zero npm dependencies, offline-capable)

### A. Module coupling analysis (「屎山程度」 tech-debt verdict)

- **Entries**: right-click a file-level module node →「分析耦合」(that file only); right-click the
  empty canvas →「分析全部耦合」; the toolbar「耦合分析」button (clicking it on the task view still
  works — the host always analyzes the module graph, then refreshes the current view's card); and
  one automatic full run after every import.
- **Node badge**: a small pill left of the status badge reading「耦合 · 低|中|高」(green `#22c55e` /
  yellow `#eab308` / red `#ef4444`; darker text shades on the light theme) plus a 3px colour edge on
  the card — node size and port positions untouched.
- **Top-left card**: 「屎山程度 · 中」(big label + colour dot) plus 「模块 12 · 平均 42 · 环 2」;
  partial runs append 「已分析 3/12」, staleness appends 「可能过期」 (whole card desaturated).
  Clicking opens the details dialog: the overall verdict, a module table sorted by score (module /
  level / score / fan-in Ca / fan-out Ce / cycles / intra refs & symbols), the scanned root, the
  analysis time, the restricted-file count and a 「重新分析」 button.
- **Algorithm** (constants exported from the top of `lib/coupling.js`): `score = round(0.6×intra +
  0.4×inter)` where intra comes from the in-file symbol cross-reference graph (edges / density /
  max fan-out / symbol cycles) and inter from the module dependency graph (fan-in/out, transitive
  closure, depth on the SCC-condensed DAG, being in a cycle, external packages), saturated by
  `sat(x,max)=min(1, log1p(x)/log1p(max))`; level thresholds fixed at 30/60. The overall verdict is
  a line-weighted mean plus `min(15, 3×cyclic files)`. The same tree always yields byte-identical
  scores (timestamps never feed the score).
- **Persistence**: node-level `node.coupling` only on the modules graph; the verdict mirrors to
  `meta.coupling` — full on the modules graph, exactly one key on the tasks graph
  (`source:"modules"`). The host whitelist-cleans (unknown keys dropped, numbers clamped, ≤800
  bytes) and pre-1.2 graphs stay byte-identical.
- **Staleness never lands on disk**: `GET /api/coupling` stats each analyzed file (10s cache, ≤300
  files); a newer mtime or a module-count drift greys the badge (dashed) and tags the card — never
  auto-recomputed, the dialog offers 「重新分析」.
- **Failure semantics**: no modules graph → 400 + an actionable Chinese message (button disabled);
  a deleted source file clears that node's label and counts as skipped (overall partial);
  unparsable languages degrade to a line/byte-based weak verdict marked 「解析受限」 — never
  fabricated precision.

### B. Drag-and-drop import (folders / archives)

- **Interaction**: dropping onto the canvas shows a full-screen dashed overlay
  「松开导入项目（文件夹 / zip / tar / tar.gz / 7z / rar）」 → local pre-check on release
  (type/count/size; invalid → toast only) → confirm dialog (type/name/count/size, target hint,
  editable project name, recursion depth, comment-tasks and add-tests toggles, remember option) →
  progress dialog (prepare → upload N/M · bytes → extract → analyze, cancellable) → the new project
  opens on the task view with automatic coupling and a summary toast. Multiple dropped items: only
  the first is processed.
- **Two channels**: the canvas iframe cannot read dropped paths, so the **upload channel is the
  primary path** — folders are read via `webkitGetAsEntry()` and POSTed file-by-file into the
  staging tree `CodeFlow/imports/.staging/<token>/`, then renamed into place on finalize; archives
  upload the blob and extract into `imports/<package>/` (the staged copy is deleted right after).
  When the host bridge exposes `getPathForFile` (feature-detected on
  `window.__DSH_ELECTRON__` / `dsh` / `electron` / `webUtils`), `POST /api/drop/path` imports
  folders in place and extracts archives in place (no copies).
- **Extraction**: zip/tar/tar.gz parsed in pure Node (EOCD → central directory → local headers;
  512-byte headers, ustar/pax/GNU longname; gz streamed with a 500 MB fuse); 7z/rar are detected by
  magic and delegated to `System32\tar.exe` (bsdtar) → 7-Zip → WinRAR/UnRAR (`execFile`, 120s
  timeout; none available → a Chinese message asking for a manual extraction). File-name decoding:
  UTF-8 flag → strict UTF-8 → GBK fallback. After extraction a lone root directory becomes the
  project root (去壳).
- **Safety & caps**: zip-slip / absolute paths / `..` / NUL / symlinks are refused (external-tool
  output is re-verified afterwards); ≤1000 files, ≤500 MB extracted, ≤64 MB per file, ≤500 MB
  archive, ≤400-char paths, ≤32 levels — violations answer 413/400 with a Chinese reason and clean
  the staging tree; staging sweeps every 30 minutes for trees older than 6h; the sweeper stops on
  plugin dispose.
- **Conflicts**: an existing `imports/<package>` directory or project name answers
  `409 {code:"conflict", target, current}` and the canvas offers 覆盖 / 改名 / 取消; overwrite backs
  the old graph files up as `.bak-<timestamp>` first, rename appends `-2`/`-3` to both names.
- **Wiring**: finalize reuses the existing chain — `importProjectDual` produces both graphs → the
  v1.1 feature index → v1.2 automatic coupling → durable session binding (no message delivery) →
  a response shaped like `/api/import`. The scan budget grows to **1000 files** (defaults stay
  200/4 — behaviour unchanged).

## The v1.0.1 fixes and upgrade


### A. 「测试运行」空转 → 真实执行、明确失败、一键重试

Field report: clicking 测试运行 sent `[CodeFlow:RUN_NODE]` to the dedicated session, the agent
replied with a few sentences, but never executed the tests and the node stayed `pending` forever —
"no reaction". Four layers fix it:

1. **Self-contained run requests** — `RUN_NODE` now carries `node` (`type`/`title`/`params`,
   `cmd` included), `upstream` (direct upstreams with their `result`, clipped to 120 chars),
   `cwd` (the directory commands must run in: an imported project's source tree, else the project
   directory) and `expect` (one-line acceptance criterion) for `testrun`/`shell`; `RUN_ALL`
   carries `order` (topo order of the `pending/failed` nodes). The first line is still a
   single-line JSON; after it the host appends a three-line 「本次执行要求」 footer: you must
   really execute this time ("ran it earlier in this session" does not count), you must fill back
   via `progress` before the turn ends, and an un-executed node will be marked failed by the host.
   `references/protocol.md` documents the new parsing rule (JSON = first line after the prefix).
2. **Hardened skill semantics** — `SKILL.md` and `references/node-types.md` spell out the
   `testrun` contract: run in the project root, record the real command/exit code/output tail,
   `result` only from real output, missing runtime → `failed` with an actionable reason, and
   never mark `done` without executing (especially "it passed earlier"). NEW-phase self-tests do
   not count as a `testrun` execution.
3. **Optimistic `running`** — the moment the prompt is queued, the target node (RUN_NODE) or the
   first pending node (RUN_ALL) flips to `running`, so the click is visible within one poll
   cycle; a failed delivery rolls the status back.
4. **Turn-end reconciliation + retry** — if a run's turn ends without any `progress` for its
   target (the exact field-report signature), the host marks the node `failed` with
   `agent 未执行该节点`, records an in-memory `issue`, and the canvas shows a banner with a
   one-click 重试 (re-delivers with `rerun=true`). A new run clears the issue. Silent
   forever-`pending` is no longer a possible outcome.

### B. Canvas fills the panel edge-to-edge

The generated `canvas.html` used to start with `-->-->` (the port script's `replaceRange` keeps
the end marker, and the header replacement carried its own `-->`), which the browser rendered as
a one-line text node — the ~22px gap and the "arrow" in the field screenshot. The port script no
longer duplicates the terminator and self-checks the output before writing; the embedded shell
(`lib/canvas-page.js`) strips the canvas root's 1px border + 14px radius so the canvas fills the
panel on all four sides (standalone preview keeps the card look); the toolbar wraps at narrow
widths.

### C. Projects move into `<workspace>/CodeFlow/`, configurable

- New layout: `<根>/flow-projects/<项目名>/` with the default root `<工作区>/CodeFlow`.
  `workflow.json`, `workflow.modules.json`, `session.json`, `view.json` and `.undo/` all live in
  the project directory as before.
- `lib/paths.js` is the single place that assembles those paths. Global custom root (any absolute
  path) + per-project override (`projects[<key>].dir` points at the project directory itself);
  the config lives at `<工作区>/CodeFlow/config.json` even when the root is moved elsewhere. A
  corrupt config falls back to the default root with a one-time warning — it never loses projects
  (`knownRoots` + the legacy location + overrides stay scannable).
- **Automatic one-time migration**: on the first workspace resolution the plugin moves
  `<workspace>/flow-projects/*` into `<根>/flow-projects/` (whole directory, `.undo/` included;
  `rename` first, recursive copy + verify + delete as fallback; conflicts are never overwritten
  and keep the legacy copy; failures keep the legacy copy and name the reason; a running project
  is deferred to the next start). The summary lands in `<工作区>/CodeFlow/migration.json` and a
  one-time canvas banner.
- **Settings UI**: the toolbar gains a ⚙ 设置 button (hosted mode only) — readonly workspace +
  default root, editable global root and per-project directory (both with 恢复默认), validation
  (absolute paths only, no files, no plugin-package paths, mkdir + write-probe required) with the
  Chinese error surfaced verbatim in the dialog; `GET/POST /codeflow/api/config` behind the same
  fence as the other routes. The status bar's 已暂存 tooltip shows the project's absolute path.

## The three v0.6.0 upgrades

### A. One import, two graphs + view switching

- The panel's "Import project" dialog no longer has a "generation method" dropdown: one
  deterministic scan **produces both the task pipeline** (`workflow.json`) **and the module
  graph** (`workflow.modules.json`), same project name, same `meta.importedFrom`.
- The toolbar segmented control `[ Task pipeline 12 ] [ Module graph 28 ]` (`role="tablist"`,
  arrow-key support) shows only when both views are available. Switching = flush the write
  queue → fetch the target view → replace the whole graph + restore viewport, done in ~100 ms —
  **no rescan, no re-analysis, no agent wake-up**.
- Each view is a fully independent `codeflow/1` graph: nodes, links, coordinates, run states and
  `rev` do not affect each other; autosave / the save button / agent write-back act only on the
  target view. The active view persists in `view.json` (not part of rev); restart restores the
  last view and zoom.
- Old projects read with zero migration: a lone `workflow.json` belongs to the view implied by
  its `meta.strategy`; for old module projects, `workflow.json` maps in memory to the module
  view's storage file (never renamed or copied); corruption quarantine is per file — a broken
  module graph does not affect the task graph.
- `/flow-import` and the CLI (`node lib/importer.js`) both do the dual generation; `--modules`
  is a compatibility alias only.

### B. Highlight the module when the agent edits code

- The host Activity Hub extracts paths from **real file-write tool calls** (`tool/call` with
  `edit`/`write`/`ops_replace`/`apply_patch`/`multi_edit`/`str_replace_editor`…), handling
  single-value keys / array keys / patch markers, normalizing Windows separators and case.
  Relative paths resolve against `meta.importedFrom`; only files inside the project are recorded.
- Path → node matching happens in the host (single source of truth): the module graph exactly
  matches **file-level** nodes by `params.path`; the task graph matches related tasks by
  `artifacts[].path` / `params.instruction`. No fabricated highlights when nothing matches.
- Canvas presentation: module view "editing" = amber pulse + card badge (with
  `prefers-reduced-motion`, only a static border), then a 15-second "edited" static marker;
  task view related tasks get a dashed border and the activity row shows "edited src/foo.ts";
  sidebar category buttons show a small dot; the view-switch button shows a dot when an inactive
  view has edit activity.
- The edit table is memory-only (≤100 entries/project, ≤20 paths per call), never on disk, never
  in logs; a failed `tool/result` is marked `error`, never dressed up as success.

### C. Two-level navigation list + search

- Category clicks: 0 nodes → disabled; **1 node → jump directly** (no flyout); ≥2 → two-level flyout.
- The flyout: a search box at the top (focused on open, case-insensitive, title matches ranked
  before path matches), type color dot + title + secondary text (module relative path / task
  status summary) + edit-state tag; sorted by title in `zh-CN` collation; max height 60vh.
- Keyboard: ↑/↓ to move, Enter to select, Esc to close; closes on outside click, re-clicking the
  same category, switching views, or starting a pan/zoom drag.
- On selection: zoom-to-fit the node (≈1.0–1.2×, animated), highlight ≈1.8 s while other nodes
  dim, and set it selected; focus returns to the trigger button. Both themes are supported
  (light rules carry the `html[data-cf-theme="light"]` prefix).

## The v0.5.2 fixes (one-to-one against field reports B2–B9)

Where each problem found in field testing (v0.4.2/v0.5.1) landed in this version:

- **B2 autosave write failures were silent**: `POST /api/state` now persists to disk before
  answering, and the response always carries `persisted`/`error`; the client status bar shows
  "stage failed (not persisted)" with a throttled toast.
- **B3 /api/save still 200 on failure**: persist failures now answer **507 + `ok:false`**
  (`persisted:false`, `error` preserved).
- **B4 broken files treated as empty canvases** (the worst one): when `store.load` hits a
  `workflow.json` that fails to parse or is not `codeflow/1`, it first **quarantines** the file
  as `workflow.json.bad-<timestamp>` (bytes preserved) and returns `degraded`, visible across
  the boot page, `GET /api/state` and the `codeflow_canvas` tool. There is also a backstop:
  projects **never loaded before** validate the existing file before their first write, also
  quarantining a broken original first — no path can silently overwrite a broken file anymore.
- **B5 later writes clobbered earlier ones**: `store.write` supports `expectedRev`; a mismatch
  throws 409 (with `currentRev`). Autosave / save / run gestures all carry it; the client
  serializes writes (write queue) and reads `expectedRev` only when actually sending, so "save
  button + pending autosave" no longer trade 409s. Agent write-back and undo are unaffected.
- **B6 oversize 500 → 413**; **B7 invalid graph 500 → 400**: error objects carry `statusCode`,
  applied uniformly at the route boundary.
- **B8 non-atomic writes + unref debounce**: persistence is now **temp file → fsync → rename**
  (falling back to direct write on failure), disk writes for the same project are **serialized**
  (renames can no longer land out of order), `unref()` is gone, and plugin dispose calls
  `flushAll()` as a backstop — the last write before exit no longer disappears.
- **B9 two "untitled" buckets**: added `projectKeyOf`/`projectDirOf` — empty names, whitespace,
  `..`, and the literal `untitled` all land in the single `__untitled__` bucket (the on-disk
  directory remains `CodeFlow/flow-projects/untitled/` for compatibility); sidecar, undo root and activity
  buffer all use the same mapping — no more two memory buckets sharing one directory and
  overwriting each other.
- **B10 sporadic fetch failed (watch item)**: all client requests carry a 15 s timeout; the
  "host connection lost" banner appears only after 3 consecutive polling failures, so a single
  hiccup doesn't nag. The fix also located a server-side issue that really caused it: answering
  413-class errors **before draining the request body** poisons keep-alive connections — the
  next request on the same socket dies with ECONNRESET (status=0). Bodies are now drained
  before answering.
- **Found during the fix (only real HTTP concurrency exposes it)**: `store.write`/`store.flush`
  read `state.rev`/`state.graph` to build the response *after* awaiting persistence, so N
  concurrent writes all reported the final rev and could even carry someone else's graph. They
  now snapshot before the await; regression cases in `tests/regression.mjs` (overlapping writes
  each answer their own rev) and `tests/e2e.mjs` (10 concurrent autosaves with revs 1..10 in
  order).
- Related fixes: the import CLI (`node lib/importer.js`) also writes atomically now;
  `tests/validate.mjs`'s fake agent default cwd no longer points at `/work/space` (no more test
  projects scattered at the drive root); added `tests/regression.mjs` (21 cases — B2–B9 each
  have a regression case).

## The four v0.5.0 upgrades

### A. Delivery via DSH's native `present`

- Nodes gained an optional `artifacts` field (`[{path, label?, kind?}]`, ≤50 entries, sanitized
  by the host; see `assets/skill/.../references/workflow-schema.md`).
- At runtime the `deliver` node: collects upstream `artifacts` through the transitive closure
  (or scans the project directory by rule when absent) → validates each "exists and is a regular
  file" (drops directories/symlinks/missing/sensitive files) → writes `docs/DELIVERY.md` (with
  the deliverable list) → calls native `present` (≤8 per call, `DELIVERY.md` always first) →
  writes back `result/detail/artifacts/presented`.
- The host listens for `deliverables/presented` events and merges actually-submitted paths back
  into the deliver node's `presented`.
- Canvas presentation: card badge `N deliverables · M cards submitted`, a read-only "deliverables"
  list in the details dialog, and a toast after success pointing you to the session. **No**
  in-canvas previewer; preview and "reveal in folder" are all native cards.

### B. One dedicated session per project

- Creation triggers: first open of an existing project (boot), after NEW succeeds, after IMPORT
  succeeds, and as a fallback on first run; in-flight promises are deduplicated.
- Persistent binding: a `session.json` sidecar inside the project directory (temp file + atomic
  rename; corrupt/version-mismatch counts as unbound); cold sessions adopt it directly
  (`sessionController.prompt` restores).
- Delivery: `sessionController.prompt({requestId, sessionId, mode:'queue', content}, signal)`;
  `session/not-found`/`archived` → rebuild once and retry once; `session/writer-held` → never
  steal, report "the session is held by another writer".
- After creation DSH's **current session is not switched**; the canvas only shows the entry
  point. Without a stable public session-navigation API, "open session" degrades to copying the
  session ID (the client feature-detects `uiWorkspace.openSession`; see "Known limitations").
- Projects A and B have fully independent sessions; concurrent opens/runs create it only once.

### C. Live reasoning trace + task progress

- The host subscribes to `session/event` (turn/step/tool/assistant/deliverables durable events)
  and `agent/assistant-stream` (`reasoning-delta`/`text-delta` frames), only for sessions bound
  to canvas projects.
- Degradation ladder: ① real reasoning stream available → reasoning stream; ② durable events
  only → steps and prose, headed "reasoning unavailable; execution steps below"; ③ no events at
  all → "the host provides no live trace". Reasoning/percentages are never fabricated.
- `codeflow_canvas` gained `mode:"progress"`: incremental per-node status/steps/percent/artifacts
  reporting, **callable only from the project's dedicated session**; percent is shown only when
  the agent explicitly provides it, otherwise an indeterminate animation.
- Panel: a one-line activity summary on node cards (no layout change), an "execution trace"
  section in the details dialog (auto-following reasoning stream + jump to bottom + tool
  timeline), a collapsible execution monitor top-right (collapsed state in localStorage), and
  auto-collapse to a summary when the run ends.

### D. Undo the agent's file changes (per-run snapshots)

- One `RUN_NODE`/`RUN_ALL` = one run. Before delivery the project root is snapshotted
  (new projects = `CodeFlow/flow-projects/<project>/` by default, configurable; imported projects = `meta.importedFrom`),
  excluding `.undo`/`.git`/`node_modules`/`venv`/`__pycache__`/`dist`/`build`/`target`/`coverage`/
  `.next`/`.cache` and `workflow.json`/`session.json`; symlinks are skipped and recorded
  (`partial:true`); the cap is 5000 files / 512 MB — beyond that an `undoable:false` record is
  **kept** (so an older run can't be un-undone past it).
- `GET /api/undo` lists history newest-first; `POST /api/undo` supports `dryRun` prechecks
  (comparing only the snapshot candidate scope) and restore: first back up to
  `.undo/<runId>/current-<ts>/` (abort if backup fails), then delete files created outside the
  snapshot scope, copy back `before/`, restore node execution fields from `beforeNodes`
  (`pos`/`params`/`links`/`title` are never touched), and clear activity.
- Strict LIFO: only the newest un-undoned run with a complete snapshot can be undone; a failed
  restore keeps the backup and marks the record `undo-failed`.
- Disk quota: keep the last 10 runs or 1 GB (oldest first, never deleting the newest undoable
  record); startup/lazy reconcile cleans orphan directories and marks records without
  `finishedAt` as `interrupted` (still undoable).
- **Scope limits**: writes outside the project root (shell redirection, absolute paths elsewhere)
  are not in the snapshot and cannot be restored; the UI and skill docs both say so. `.undo/`
  never enters delivery/import/logs and is not exposed via any HTTP route.

## Directory

Refactored into strict layers (dependencies point one way only, top depends on bottom):

```
── Layer 0 · lib/core/          foundation utilities (import node:* only)
  core/fsio.js        atomic write (temp→fsync→rename), tolerant JSON reads,
                      bounded line reads — the single implementations
  core/path.js        project naming contract (safeProjectName/projectKeyOf/
                      projectDirOf/freeName), path helpers (containment, rel,
                      stem), directory constants (CodeFlow / flow-projects)
  core/text.js        clip / firstSentence / errorMessage / warn-once factory

── Layer 1 · lib/scan/          deterministic source scanning (imports core only)
  scan/walk.js        skip lists, language table (LANG_EXTS/EXT_LANG), bounded
                      walk, looksLikeTest, languageStats
  scan/comments.js    per-family comment grammars, task markers (TODO/FIXME…)
  scan/symbols.js     top-level symbol extraction, import specifiers, import
                      resolution (shared by analyst / features / coupling)

── Layer 2 · graph format, config, migration, features
  lib/graph-format.js  `codeflow/1` envelope constants + pure normalizers
                       (normalizeGraph/artifacts/presented/coupling, view keys)
  lib/codeflow-config.js  CodeFlow config.json shape, tolerant IO, settings
                          validation (the config layer)
  lib/migration.js     one-time legacy project migration (idempotent, never
                       loses data) + project-directory recognition
  lib/features/        feature-index subpackage: constants / dictionary /
                       index-file / detect / apply / map / ops
  lib/features.js      the package's aggregate entry (all public symbols
                       re-exported; historical import path preserved)

── Layer 3 · deterministic import & analysis
  lib/importer.js     task-pipeline generation + CLI (scan layer imported)
  lib/analyst.js      module-graph generation (role inference + assembly)
  lib/duo.js          dual import orchestration + persistDualResult (the shared
                      landing sequence for HTTP import / drop / /flow-import)
  lib/coupling.js     v1.2 coupling engine (inter/intra metrics, SCC, scoring,
                      staleness probe)

── Layer 4 · host state & execution
  lib/store.js        the single graph writer: dual-view rev holder, persistence
                      pipeline, corruption quarantine, project list
  lib/sessions.js     canvas dedicated-session manager (binding/sidecar/delivery)
  lib/undo.js         run snapshot/restore (LIFO, view-aware manifests)
  lib/activity.js     Activity Hub: event subscription, reasoning/tool/step
                      buffer, progress, file-edit tracking (memory only)
  lib/tool.js         codeflow_canvas tool (render/load/read/save/progress)
  lib/features-tool.js  codeflow_features tool
  lib/commands.js     /flow, /flow-new (agent-executed); /flow-import (host-side)
  lib/workspace.js    path sanitizing (@, ~, quotes, file://) and session
                      working-directory repair
  lib/archive.js      v1.2 pure-Node zip/tar extraction, 7z/rar external tools
  lib/drop-import.js  v1.2 drop-import staging (begin/file/finalize/abort)
  lib/starter.js      deterministic skeleton graph for 新建项目
  lib/gestures.js     the [CodeFlow:*] protocol: gesture → prompt delivery,
                      run requirements, optimistic running, topo order

── Layer 5 · HTTP & entry
  lib/routes.js       createRouter: context assembly + table dispatch + error
                      boundary (the 13-dep signature is unchanged)
  lib/http/           route groups: respond (transport primitives) / context
                      (shared helpers) / canvas / state / import / features /
                      project
  lib/index.js        plugin entry: pure assembly (skill/commands/tools/HTTP/
                      sessions/activity/undo wiring + end-of-turn reconciliation)
  lib/skill.js        skill provider (inline rank, no cross-package dependency)
  lib/message.js      createUserMessage/textContent shims
  lib/canvas-page.js  wraps the canvas fragment into a full document + boot data
  lib/client.js       browser side: sidebar icon + main panel (out of refactor scope)
  lib/paths.js        resolution facade: effective root / project dir / layout /
                      project list (config & migration live in their own layers,
                      re-exported here for compatibility)

assets/canvas/canvas.html      The canvas itself (generated by tools/port-canvas.mjs — do not hand-edit)
assets/skill/codeflow-canvas/  Skill docs + four references
tools/port-canvas.mjs          Reproducible port script (asserts every change point)
tools/theme-light.css          Light theme overlay (appended into the canvas stylesheet at generation time)
tools/upstream/                Upstream v0.2.2 canvas fragment originals
tools/verify-client-bundle.mjs 10-point loading-contract check for the client bundle
tests/validate.mjs             Structure + behavior self-check (sessions/activity/progress/undo/dual views/edit tracking/canvas assets/XSS)
tests/regression.mjs           Per-fix regressions for v0.5.2 (B2–B9)
tests/e2e.mjs                  Real http server + real fetch scenarios (dual import/switching/restart/old projects/corruption quarantine)
tests/undo.mjs                 Undo snapshot/restore/LIFO/cross-view
tests/coupling.mjs             v1.2 coupling engine + persistence
tests/drop-import.mjs          v1.2 extraction/staging/caps/conflicts
tests/features.mjs             v1.1 feature index
tests/contrast.mjs             WCAG AA contrast audit for the light palette (called by the self-check)
```

The refactor is behavior-preserving: every historical module path still exports
its original symbols (moved code is re-exported), all HTTP routes / tool
schemas / file formats / the `[CodeFlow:*]` protocol are unchanged, and all
285+ self-checks pass without a single test modification.


## Development

```bash
# Self-checks (DSH does not need to be running)
ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" tests/validate.mjs   # 174 checks: registration/routes/tools/skill/dual views/edit tracking/assets/coupling/drop
ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" tests/regression.mjs # 27 checks: per-fix regressions for v0.5.2 (B2–B9)
ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" tests/e2e.mjs        # 25 scenarios: real http server + real fetch (incl. v1.2 coupling & drop)
ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" tests/undo.mjs       # 16 checks: snapshot/restore/LIFO/cross-view
tests/coupling.mjs   # 19 checks: the coupling engine and its persistence
tests/drop-import.mjs # 24 checks: extraction/staging/caps/conflicts
# macOS:
# ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" tests/validate.mjs

# After changing the canvas fragment: regenerate assets/canvas/canvas.html
# (edit the inline script in port-canvas.mjs — never hand-edit the generated file)
ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" tools/port-canvas.mjs

# Loading-contract check for the client bundle
ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" tools/verify-client-bundle.mjs .
```

After changing `lib/*.js` (Host side) restart DSH; after changing `lib/client.js` refresh the
page; after changing `tools/port-canvas.mjs` / `tools/upstream/*` regenerate the canvas.

## Differences from the ZCode version

| ZCode v0.2.2 | This version |
| --- | --- |
| `::visualize{path,mode,wide}` Gen UI embedded in the conversation | Native sidebar panel (iframe) |
| Agent generates the canvas HTML (copy template + replace placeholder) | Host assembles the document; agent only submits the graph |
| `window.zcode.sendFollowUpMessage` | `POST /codeflow/api/action` → dedicated session `sessionController.prompt` |
| `window.zcode.setWidgetState` (16 KiB cap) | Host in-memory state + persistence, no cap |
| `widgetState.rev` comparison | Host owns `rev`; panel polls and adopts |
| `/flow` etc. as markdown command files | Real commands registered via `ctx.commands.register` |
| `.zcode-plugin/plugin.json` + `marketplace.json` | `package.json` + `cordis.patch.yml` |
| Icons depend on the host's lucide | Inline SVG (18 icons, same selectors) |
| Fixed 780px height | Fills the panel |
| Dark only | Dark/light palettes following the DSH theme |
| — (none) | Dedicated sessions, live traces, native delivery, run undo (v0.5.0) |

Kept unchanged: the node type library, linking rules, module navigation, menus/dialogs, the
`codeflow/1` graph format, the `[CodeFlow:*]` protocol prefix, and execution semantics and
result-writing conventions.

## Theming

The canvas follows **DSH's current theme**, not the OS directly:

- With DSH's theme preference on `system` (default), changing the OS dark/light mode syncs the canvas;
- Manually picking dark/light in DSH changes the canvas too, so it never clashes with the surrounding UI.

The implementation lives in two places, because colors have two sources:

| Source | Carried by | How it switches |
| --- | --- | --- |
| CSS rules (surfaces/borders/text/menus/dialogs/toasts/monitor/trace area) | `tools/theme-light.css` appended to the end of the stylesheet; selectors always carry the `html[data-cf-theme="light"]` prefix | Panel pushes `postMessage` → canvas flips the attribute on `<html>` |
| Inline `style` (status badges, details dialog, minimap) | The canvas's `PALETTE.dark / PALETTE.light` | Same, then a `renderAll()` pass after the flip |

No first-frame flash: the panel puts the theme into the iframe's `?theme=` parameter, and the
host writes the attribute directly onto `<html>`. Later switches send only change messages and
**never reload the iframe**, so viewport zoom, selection and uncommitted edits all survive.

## macOS import/new-project issues

For these two error classes, the v0.4.2 handling:

1. **`目录不存在：/Users/.../@/Users/...` (directory does not exist)** — when picking a path with
   `@` in DSH's input box, the `@` arrives as part of the command argument; appended after the
   workspace it becomes `<workspace>/@/Users/...`. Commands now sanitize `@`, `~`, quotes,
   `file://` and extra whitespace before resolving absolute/relative paths; the canvas's
   "Import project" dialog supports the same. On macOS a per-segment case/Unicode-normalization
   match also runs, so inputs where "the directory is clearly there but `realpath` can't find it"
   still work.
2. **`working-directory: directory does not exist: "…"` (fails every agent turn)** — this is the
   DSH session's own working directory going stale, not the canvas failing to write files. Before
   delivering any canvas message or running `/flow*`, the plugin calls the host's
   `ctx.workingDirectory.ensure/set` to validate; if neither the current directory nor the
   original project directory is usable it tries, in order: canonical `realpath` → parent
   directory → a workspace already registered in DSH → the startup/home directory, and commits
   the result back to the session. If it still fails, you get an actionable error instead of the
   turn silently dying inside DSH. If a path mixes scripts and DSH still has the known bug, the
   quickest fix is moving the project to an ASCII-only path and restarting DSH.

"New project" on the canvas also no longer depends on "have the agent render once first": the
host writes a skeleton graph (`meta.starter: true`) and persists it, then tries to hand
`[CodeFlow:NEW]` to the project's dedicated session; without an available session/creation
failure the project is still created — nodes just need to be run later, with an actionable hint
on the canvas.

## Known limitations & degradation paths

- **Coupling only covers the languages the scanner knows**: only language families with a symbol
  extractor get intra metrics; other extensions (`.vue`, custom suffixes…) degrade to a
  line/byte-based weak verdict (`parsed:false`, flagged 「解析受限」 in the details). The analysis
  covers the module graph's file-level nodes (≤36), not all 1000 scanned files.
- **The staleness probe caches for 10 seconds** (key: project + analysis time + node count): right
  after editing a source file `GET /api/coupling` may still report "fresh" for up to 10s;
  re-analyzing once (a new analysis time) refreshes immediately.
- **Drag-import copies when no real path is available**: DSH does not currently expose
  `getPathForFile` to the iframe, so folder imports are copied to `CodeFlow/imports/<name>/`
  (not in-place); once the host exposes the bridge, archives/folders switch to the in-place
  channel automatically. Standalone mode (opening canvas.html directly) disables dropping.
- **Drop-import caps**: 1000 files, 500 MB extracted, 64 MB per file, 400-char paths, 32 levels;
  zip64 / encrypted archives / symlink entries are refused outright. 7z/rar depend on local tools
  (System32 bsdtar / 7-Zip / WinRAR); with none available the canvas asks for a manual extraction.
  External-tool output is re-verified for count/size, but the tool itself cannot be prevented from
  zip-slipping — inspect untrusted archives manually first.
- **Coupling/drop writes bump the view revs too**: the canvas force-refreshes after an analysis;
  if your autosave races into a 409, the existing syncConflict flow surfaces it instead of
  swallowing it.
- **Edit highlighting only trusts real file-write tools**: the allowlist covers common names
  like `edit`/`write`/`ops_replace`/`apply_patch`/`multi_edit`/`str_replace_editor`; reasoning,
  conversation text and node titles never participate in inference. Writes via `shell`
  redirection/indirect scripts are **out of scope** (no pretending to parse them).
- **Files not in the module graph are not highlighted**: when an edited file matches no
  module/task node, a one-time "edited a file outside the structure graph" notice is shown — no
  fabricated highlights; symbol sub-nodes of the same file are never highlighted individually
  (only file-level module nodes are).
- **Edit records are memory-only**: after a host restart the "editing/edited" markers naturally
  disappear — not persisted, not reconstructed; they never enter `workflow.json` or logs.
- **Old single-view projects have no switcher**: old task projects with only `workflow.json`, or
  old module projects (where `workflow.json` *is* the module graph), all open fine, but the
  toolbar never shows a permanently-unlit tab; old module projects cannot gain a task view
  (writes are rejected) and old files are never renamed/copied automatically.
- **View switching requires both views to be available**: when module analysis fails (almost no
  source code), import produces only the task pipeline with a warning; the module view is marked
  unavailable and the switcher hides — task nodes are never dressed up as a module graph.
- **"Open session" navigation**: the desktop client exposes `uiWorkspace.openSession(sessionId)`;
  the plugin client feature-detects and calls it. When unavailable (version differences/other
  combos) it degrades to copying the session ID, and you find it in the session list by title
  (`CodeFlow · <project>`). No URL guessing, no hardcoded internal routes.
- **Missing `sessionController`** (minimal combos): the canvas still edits/imports/saves; runs
  produce a clear error. Never binds to a random session.
- **`present` unavailable**: the deliver node fills back per the failure rule
  ("deliverables generated, card submission failed"), `artifacts` are kept, and you can take
  them from the canvas list / the filesystem.
- **Reasoning unavailable**: when the model/session provides no `reasoning-delta`, the canvas
  shows the degraded step text — never blank, never an error.
- **Undo scope**: only regular files inside the project root; out-of-root writes, `.undo` itself
  and excluded directories are not guaranteed to be restored. When the newest run created no
  snapshot, older runs cannot be undone (protecting unknown changes). Undo history is one strict
  LIFO shared across views (file snapshots are project-level), but restore only rolls back node
  fields of the view that run used.
- **`.undo/` disk usage**: snapshots are source copies, at most 10 runs / 1 GB; they may contain
  copies of sensitive files, are kept local only, are never exposed via any route and never
  enter delivery/import/logs. Delete the project directory to clear them entirely.
- The light theme is a separate palette built for the canvas (its own `--cf-*` variables), not
  DSH's `--dsw-*` tokens; the color feel is close but not identical.
- When the panel and the agent modify the same project at once, last-writer-wins (per view).
- The panel shows one view of one project at a time; view switching is frontend-only (no agent).
- `shell` nodes can execute arbitrary commands; the skill docs merely ask the agent to confirm first.
- Graph sync between panel and agent is polling (~1.8s); trace data polls at ~0.85s (while
  running and the page is visible) — not streaming.

## License

[MIT](LICENSE)
