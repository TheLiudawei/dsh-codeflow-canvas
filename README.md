<h1 align="center">CodeFlow Canvas</h1>

<p align="center"><b>A ComfyUI-style coding workflow canvas for DSH.<br/>Every node is a real agent task; every link is a dataflow dependency.</b></p>

<p align="center">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-3da639"></a>
  <img alt="Version" src="https://img.shields.io/badge/version-1.3.0-4f46e5">
  <img alt="Platform" src="https://img.shields.io/badge/platform-DSH%20desktop-2ea043">
  <img alt="Dependencies" src="https://img.shields.io/badge/npm%20dependencies-0-brightgreen">
  <img alt="Build" src="https://img.shields.io/badge/build-none%20required-lightgrey">
</p>

<p align="center">
  <img src="docs/images/canvas-tasks.png" alt="CodeFlow canvas showing a task pipeline" width="92%">
  <br/>
  <sub>One deterministic scan of a repository produced this 8-task pipeline and its 22-module graph — zero LLM tokens.</sub>
</p>

<p align="center">
  English | <a href="README.zh-CN.md">简体中文</a>
</p>

---

You plan work in a chat, then you scroll. CodeFlow takes that plan out of the transcript and puts it on a canvas: tasks are draggable node cards, dependencies are real links, and the agent executes each node in your workspace and writes the result back to the card.

It is a DSH (DeepSeek Harness) plugin, ported from the ZCode plugin `codeflow-canvas` v0.2.2. The canvas editor is the original implementation; every piece of host wiring — sessions, tool protocol, persistence, delivery, undo — was rewritten for DSH.

> UI screenshots are in Chinese because the canvas follows your DSH locale and theme. It ships with dark and light palettes and switches live with the host.

## Why a canvas

- **A graph is reviewable, a transcript is not.** You see the plan, the order, and what is stuck, all at once.
- **Import costs nothing.** Scans, symbol extraction, coupling scores and feature mapping are all deterministic, local computation — no model call, no network, no npm dependency.
- **Nothing is faked.** A node only turns green when the agent actually ran something and reported it back; an unexecuted node is reconciled to `failed`, not left spinning.

## What changed in 1.3.0

- **Named menus replace the button row.** The toolbar is now `logo · 项目/运行/视图/帮助 menus · view tabs · 新建/导入/运行全部 · undo/save/settings icons` — `flex-wrap: nowrap`, no second row at any width. Menus collapse into a `☰` panel below 720px rendered **from the same model** (`lib/ui/menu.js` → `lib/ui/menu-html.js`, build-time static markup; `tools/patches/menu-ui.js` only delegates clicks to the existing handlers via one action-key table). Full keyboard support (arrows/Home/End/Esc) with `aria-haspopup`/`aria-expanded`/`role="menu"`.
- **The secondary node list always fits.** Its position/height are derived from the stage by a pure function (`lib/ui/fit-popover.js`, inlined at build time): the list scrolls to the last row at 480px height with 200 nodes, the search box stays visible, wheel scrolling no longer chains into the canvas, and the left category bar itself scrolls.
- **Task cards survive re-import (opt-in, off by default).** On first canvas open the panel asks once per workspace (`cards.asked` in `CodeFlow/config.json`). Enabled, re-importing the same project merges by stable card identity (`lib/cards/identity.js`): run state, result, position, renamed titles and edited params are preserved onto the freshly scanned graph; deleted tasks stay as「失效卡片」(excluded from run-all, cleanable from the 项目 menu); merge runs as a pure function (`lib/cards/merge.js`) and never blocks import. Disabled behaviour is byte-identical to 1.2.2 plus a `.bak-` backup.
- **Read-only log viewer.** 设置 → 查看工作日志（or the 帮助 menu）opens the plugin's `codeflow.log`: level filters, case-insensitive search, follow-tail (2s polling, stops on close), copy visible rows as raw JSONL, and 打开所在目录 with graceful 501 fallback to copying the path. Backed by `GET /api/log` (tail/rotated/level/q, path bound at wiring — request parameters cannot point it elsewhere) over `lib/logging/reader.js`.

## What changed in 1.2.2

- **Every canvas control is wired and audited.** A data manifest (`lib/ui/actions.js`, 73 controls) is the single source of truth; `tests/buttons.mjs` statically proves each control is registered and has a binding path, the injected `window.__CF_ACTION_MANIFEST__` powers an in-canvas click self-test (`tests/buttons/canvas-selftest.js`), and `tests/buttons/MANUAL-CHECKLIST.md` covers the rest. Fixed real defects the audit exposed: the **耦合分析** toolbar button never had a click listener (it was `disabled` and reachable only via context menus), the **session chip** was a focusable no-op button (now opens the session dialog), and the ✕ close button of the three drop dialogs (confirm / progress / conflict) was dead — dialog `close`/`cancel` is now handled by one delegated listener on `#cf-dialog`. A follow-up runtime defect surfaced the moment the button worked: the analysis success path called a misspelled helper (`fetchCouplingStale`), so the canvas toasted 耦合分析失败 after the host had already written the result — fixed, and `tests/buttons.mjs` now carries an undefined-symbol check that fails on any called-but-never-defined identifier.
- **Shell-in-shell imports land on the real project root.** All import channels (drop archive, drop folder, path import, dialog import) resolve the root through one conservative detector (`lib/import/root-detect.js`): strip the outer wrapper of an archive, then unwrap further only on unambiguous signals (project marker / shell-name / same-name). `proj/src` stays `proj`; markerless single-chain shells answer `400 SHELL_AMBIGUOUS` instead of inventing a wrong project; empty shells are rejected; multi-project parents keep the parent with a `multiProject` warning. 51 fixture×channel combinations are covered in `tests/import-shells.mjs`.
- **Work & error logging.** The plugin writes JSONL to `codeflow.log` next to the plugin source (5 MiB rotation, one `.1` backup, serial writes, fail-safe). It records the plugin lifecycle, imports (`import.start/root/done/…`), coupling runs, HTTP errors and canvas UI actions/errors — never prompts, source code, graph JSON or cookies/tokens (key-based redaction + truncation). The canvas batches its own events through `POST /codeflow/api/log` (whitelist `ui.action/ui.error/ui.selftest`, 64 KiB body cap, 50 events/s, 20 per batch). `CODEFLOW_LOG=off` disables it; `CODEFLOW_LOG_FILE` overrides the path. An architecture test (`tests/architecture.mjs`) pins the layering: logging/root-detect stay dependency-free, the import pipeline never touches `req/res`, and the static import graph has no cycles.

## What changed in 1.2.1

- **New projects require a real DSH workspace (Issue #1).** The new-project dialog carries a **workspace dropdown** fed by the read-only `GET /codeflow/api/workspaces` listing, plus a read-only preview of the final absolute path (`将创建到 …`) computed by the host. Requests without a `workspace` — or with one that is not a registered DSH workspace — answer `400` / `409` and create nothing on disk.
- **Workspace resolution is one explicit chain (Issue #2).** binding (store/sidecar) → project directory → session cwd, each matched against the workspace registry (longest prefix); anything unresolvable is a hard error with the candidate list. The old `registry.list()[0]` fallback — the "workspace wandering" culprit — is gone.
- **Canvas sessions join the workspace.** When the host exposes workspace entities, the dedicated session is created with `workspaceId` and attached to the workspace group, so it no longer shows up under「未分组」.
- **Import gained a directory-tree picker.** The import dialog has a **浏览…** button backed by the read-only `GET /codeflow/api/browse` (directories only, no symlink following, 500-entry cap, 5 s timeout). Keyboard-first: ↑/↓ select, Enter enters, Backspace goes up, Esc closes the picker first. The dialog shows both 将扫描 (source dir) and 项目文件保存在 (the workspace the graph lands in).

## Screenshots

<table>
<tr>
<td width="50%"><img src="docs/images/canvas-modules.png" alt="Module graph with coupling badges"><br/><sub><b>Module graph.</b> Every file becomes a node; each carries a 低/中/高 coupling badge (low / medium / high).</sub></td>
<td width="50%"><img src="docs/images/coupling-detail.png" alt="Coupling analysis dialog"><br/><sub><b>Coupling detail.</b> Per-module score, fan-in Ca, fan-out Ce, cycles and symbol counts — deterministic and reproducible.</sub></td>
</tr>
<tr>
<td width="100%" colspan="2"><img src="docs/images/module-nav.png" alt="Searchable module navigation"><br/><sub><b>Navigation.</b> Click a module category to open a searchable two-level list; ↑/↓/Enter to jump and zoom to a node.</sub></td>
</tr>
</table>

## Key capabilities

- **Dual views, one import.** A single scan produces both a **task pipeline** (`workflow.json`) and a **module graph** (`workflow.modules.json`). Switch with the toolbar segmented control — no rescan, no re-analysis, no agent wake-up. Nodes, coordinates, run states and `rev` are fully independent per view.
- **Coupling analysis (v1.2).** Score each file-level module for internal and external coupling: `score = round(0.6 × intra + 0.4 × inter)`, graded at fixed thresholds of 30 and 60. The canvas shows a per-node badge and an overall 「屎山程度」(codebase messiness) card with a full per-module table. All constants are exported and unit-tested; the same source scores byte-identically twice.
- **Feature index (v1.1).** Builds a deterministic `feature → file → node` map in `features.json` next to the graph: design-doc parsing, entry signals, top-level symbols, directory/file dictionaries. Zero model calls; a `manual` section always wins and survives rebuilds.
- **Drag-and-drop import (v1.2).** Drop a folder or an archive on the canvas. Folders upload recursively through a staging area and land via a single rename; `zip` / `tar` / `tar.gz` are parsed in pure Node, `7z` / `rar` fall back to system tools.
- **Real execution, visible while it runs.** Node cards show the current action, a reasoning excerpt, step count and elapsed time; a collapsible monitor tracks the run. When the model provides no reasoning stream, it degrades to a step summary — never invented.
- **Un-executed means failed.** Run requests are self-contained (target node, upstream results, working directory, acceptance criterion). If a turn ends without the agent reporting progress, the host marks the node `failed` and offers one-click retry.
- **Native delivery.** A `deliver` node collects upstream artifacts, writes `docs/DELIVERY.md` and calls DSH's native `present`, so deliverables show up as real cards in the session — not as a list inside the canvas.
- **Per-run undo.** The project tree is snapshotted before each run. Undo a whole run (files + node states), strictly LIFO, surviving restarts; the current state is backed up first.
- **Dedicated session per project.** Each project owns one persistent session (`CodeFlow · <project>`); canvas runs go only there, and DSH's active session is never hijacked.
- **Edits highlight modules.** When the agent really writes a file (from `edit`/`write`/`apply_patch` tool arguments — never guessed from prose), the matching module pulses and the card gets a badge.
- **16 node types, typed ports.** Links are validated by port type (`text` / `json` / `code` / `report` / `file` / `any`); editing parameters resets downstream nodes.
- **Zero build, zero dependencies.** `package.json` has no runtime dependencies. Host half is plain ESM; the browser half is a hand-written `__ModuleLoader__` bundle.

## Get started

```bash
# Install from a local directory — no build step
dsh plugin --profile desktop add link:<absolute path to this checkout>
```

Or install the local directory from **Settings → Plugins**, then **restart DSH** (the host half does not hot-reload) and refresh the page.

Verify it is live:

```bash
curl -i http://127.0.0.1:<port>/codeflow/canvas   # expect 200 + HTML
```

A 404 with no `codeflow` entry under `profiles/<profile>` means the plugin was not installed into that profile — re-run the install command above and restart.

**Requirements:** DSH desktop with a `sessionController` (for runs). Without it the canvas still edits, imports and saves, but running a node reports a clear error instead of binding a random session.

## Usage

| Entry | What it does |
| --- | --- |
| `/flow` | Open the canvas (loads the most recent project); with an argument, create a project from that requirement |
| `/flow-new [requirement]` | Create a project directly |
| `/flow-import <path>` | Import a project: the host scans it and produces both graphs in seconds, bypassing the agent. Accepts `@`-picked paths, `~`, quotes and `file://` |
| `codeflow_canvas` tool | The agent's write-back channel: `load` (re-read a view's graph from disk — preferred), `render` (fallback), `read`, `save`, `progress` (dedicated session only). `view: "tasks" \| "modules"` selects the view |
| Skill `codeflow-canvas` | The agent's orchestration contract (create / run / write back / deliver); `/flow*` attaches it automatically |
| `node lib/importer.js <path>` | Standalone CLI import — both graphs, no DSH running |

### Run a node

Right-click a node → **Run**, or **Run all** in the toolbar. The host snapshots the project, hands a self-contained `[CodeFlow:RUN_NODE]` message to the project's dedicated session, and flips the node to `running` immediately. The agent executes and reports progress; the card updates as it goes.

## How it works

```
Browser (panel iframe)
  ├── GET  /codeflow/canvas          host assembles the fragment + __CF_BOOT__
  ├── GET  /codeflow/api/state       poll; a newer rev replaces the graph of that view
  ├── POST /codeflow/api/state       autosave (expectedRev conflict detection → 409)
  ├── POST /codeflow/api/view        switch active view (no rev bump, no scan)
  ├── POST /codeflow/api/save        persist both views (507 + ok:false on failure)
  ├── POST /codeflow/api/import      deterministic scan → task pipeline + module graph
  ├── POST /codeflow/api/action      run / create → snapshot, then deliver [CodeFlow:*]
  ├── POST /codeflow/api/session     create or rebind the project's dedicated session
  ├── GET  /codeflow/api/workspaces  registered workspace list (read-only; feeds the new-project dropdown)
  ├── GET  /codeflow/api/browse      read-only directory listing for the import picker (dirs only, no links)
  ├── GET  /codeflow/api/activity    reasoning stream, steps, progress, file edits (memory only)
  ├── GET/POST /codeflow/api/undo    run history / restore (LIFO, shared across views)
  └── GET/POST /codeflow/api/config  project root: global root + per-project override
                                        ↓
          agent executes per the skill → codeflow_canvas (progress / load / render)
                                        ↓
  store.js (per-view rev) + paths.js (the only place project paths are assembled)
  sessions.js (bindings) + activity.js (in-memory traces) + undo.js (.undo/ snapshots)
```

Design constraints worth knowing:

1. **The canvas runs in an iframe.** It binds `keydown` (Delete, Space) and pointer events on `window`; inside the host document it would steal keystrokes from the input box.
2. **The host owns `rev`, per view.** Writing one view never bumps the other, so editing a task graph is not interrupted by a background module update.
3. **Whole graphs never travel through tool arguments.** The agent edits the graph file and calls `load`; oversized nested JSON in tool calls trips `tool input is invalid JSON` and kills the turn.
4. **Trace data lives in memory.** Ring buffers per project (≤500 entries / 256 KB), never persisted, never logged.
5. **Undo only touches the snapshot scope.** `node_modules`, `dist`, `.git` and friends can never be reverted by accident.
6. **One writer per binding.** `sessions.js` is the only component that creates or rebinds project sessions.

## Project layout

Projects live under `<workspace>/CodeFlow/flow-projects/<project>/` (`workflow.json`, `workflow.modules.json`, `view.json`, `features.json`, `session.json`). The workspace itself is never created by the plugin: **new projects pick one of DSH's registered workspaces** and the canvas session is attached to it (when the host exposes workspace entities). The root is configurable — toolbar **⚙ Settings** sets a global root and optional per-project overrides, stored in `<workspace>/CodeFlow/config.json` so it stays discoverable per workspace. Legacy `<workspace>/flow-projects/` data migrates on first resolve; conflicts are never overwritten and failures keep the old directory. Workspace resolution follows one explicit chain — **binding → project directory → session cwd**, all matched against the registry (longest prefix) — and a project whose workspace cannot be resolved reports an actionable error with the candidate list instead of silently landing somewhere else.

```
lib/core/                 fsio / path / text primitives (atomic write, tolerant JSON, bounded reads)
lib/scan/                 walk / comments / symbols — the shared scanning layer
lib/features/             six slices behind features.js (detect, dictionary, index-file, apply, map, ops)
lib/http/                 respond / context / canvas / state / import / features / project / workspace / browse routes
lib/paths.js              the single place that assembles project paths
lib/workspace-binding.js  workspace resolution (B1 chain) + registry adapter (the only registry reader)
lib/browse.js             read-only directory listing (pure functions + fs adapter)
lib/store.js              dual-view graph state, per-view rev, sanitizing
lib/coupling.js           coupling algorithm (constants exported for tests)
lib/importer.js           deterministic import (task pipeline) + CLI
lib/analyst.js            structure analysis (module graph)
lib/routes.js             thin router assembly
lib/index.js              plugin entry — pure assembly
assets/canvas/            canvas.html (generated by tools/port-canvas.mjs — do not hand-edit)
assets/skill/             skill docs + four references
tests/                    validate / regression / e2e / undo / coupling / features / drop-import / workspace / browse / contrast
```

## Development

```bash
# Self-checks (DSH does not need to be running)
ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" tests/validate.mjs
ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" tests/regression.mjs
ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" tests/e2e.mjs
ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" tests/undo.mjs
ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" tests/coupling.mjs
ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" tests/features.mjs
ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" tests/drop-import.mjs
ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" tests/workspace.mjs
ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" tests/browse.mjs

# Regenerate the canvas after editing the port script (never hand-edit the output)
ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" tools/port-canvas.mjs

# Loading-contract check for the client bundle
ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" tools/verify-client-bundle.mjs .
```

Changing `lib/*.js` requires a DSH restart; changing `lib/client.js` requires a page refresh.

## Differences from the ZCode version

| ZCode v0.2.2 | This plugin |
| --- | --- |
| `::visualize{}` Gen UI embedded in the conversation | Native sidebar panel (iframe) |
| Agent generates the canvas HTML | Host assembles the document; the agent only submits the graph |
| `window.zcode.sendFollowUpMessage` | `POST /codeflow/api/action` → dedicated session |
| `setWidgetState` (16 KiB cap) | Host state + disk, no cap |
| `widgetState.rev` comparison | Host owns `rev`, per view |
| Markdown command files | Real commands via `ctx.commands.register` |
| `.zcode-plugin/plugin.json` | `package.json` + `cordis.patch.yml` |
| Dark only | Dark + light palettes following DSH |
| — | Dedicated sessions, live traces, native delivery, run undo, coupling, feature index, drag-and-drop import |

## Known limitations

- **New projects require a registered workspace.** A directory DSH has not registered cannot host a new project — the plugin refuses with the candidate list (no silent downgrade registration, no writes into DSH's workspace records); add it in DSH's sidebar first.
- **Import needs a resolvable workspace for the graph files.** The source directory can be anywhere on disk, but the graph lands under the current workspace; with nothing bound yet (fresh install, no project) import reports what to do instead of guessing a location.
- **The browse picker lists directories only.** No files, no sizes, no contents; symlinks and junctions are never followed or listed; 500 entries per level and a 5 s timeout guard slow or disconnected network shares. Windows reparse tags beyond symlinks/junctions are not enumerable without native code.
- **Edit highlighting trusts only real write tools.** Writes through `shell` redirection or indirect scripts are out of scope and not guessed at.
- **Only files in a graph are highlighted.** A file outside the module graph gets a one-time notice instead of a fabricated highlight.
- **Edit records are memory-only.** Markers disappear on host restart; they never enter `workflow.json` or logs.
- **Undo covers the project root only.** Writes outside it, and excluded directories, are not restored. Because undo is strictly LIFO, a newest run without a snapshot blocks undoing older ones.
- **`.undo/` holds source copies** (≤10 runs / 1 GB, local only, never exposed by any route). Delete the project directory to clear it.
- **Switching views needs both graphs.** If module analysis fails (almost no source), import produces the task pipeline alone and the switcher hides — task nodes are never passed off as modules.
- **Graph sync is polling** (~1.8 s; traces ~0.85 s while running and visible), not streaming.
- `shell` nodes can run arbitrary commands; the skill asks the agent to confirm first, nothing more.

## License

[MIT](LICENSE) © TheLiudawei
