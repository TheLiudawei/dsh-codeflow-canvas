/**
 * 项目动作路由组：用户手势 → agent、持久项目列表与根目录设置。
 *
 *   POST /api/action   画布手势交给 agent 处理（NEW / RUN_NODE / RUN_ALL /
 *                      SAVE；NEW 先落骨架图，运行类先采纳画布图再投递）
 *   GET  /api/projects 持久项目列表（配置根 + knownRoots + 旧目录；也是
 *                      懒迁移的触发点）
 *   GET  /api/config   项目根设置（生效根 / 项目实际目录 / 覆盖）
 *   POST /api/config   改根（或恢复默认）与设置/清除单项目目录覆盖
 *
 * @module dsh-codeflow-canvas/http/project-routes
 */
import path from 'node:path'

import {
  defaultRoot, ensureLayout, probeWritable, readConfig, rootOf, validateConfiguredDir, writeConfig,
} from '../paths.js'
import { buildStarterGraph } from '../starter.js'
import { sendJson, readJsonBody, statusOf } from './respond.js'
import { viewFieldsOf } from './context.js'

/**
 * NEW 的工作区校验失败 → HTTP 状态码（A4 错误码表）。
 */
function workspaceErrorStatus(code) {
  if (code === 'WORKSPACE_REQUIRED') return 400
  if (code === 'WORKSPACE_LIST_FAILED') return 500
  if (code === 'NO_WORKSPACE_SERVICE') return 503
  return 409
}

/**
 * 画布可以交给 agent 的动作。导入不在其中：它是纯机械扫描，由
 * `POST /api/import` 在宿主侧完成，面板绝不为此唤醒 agent。
 */
const AGENT_ACTIONS = new Set(['NEW', 'RUN_NODE', 'RUN_ALL', 'SAVE'])

/**
 * @param ctx - 路由上下文。
 * @returns 路由表项数组。
 */
export function createProjectRoutes(ctx) {
  const { store, logger, submit, cwdOf, cwdExOf, dirOf, workspaceReady, sessionFor, sessionFields, validateWorkspace } = ctx
  return [
    {
      method: 'POST',
      path: '/api/action',
      /**
       * 用户手势 → agent。NEW 特殊：即使连不上会话，项目也必须存在——先写
       * 持久骨架图、绑定画布会话、再交给 agent；投递失败留下的是可用项目，
       * 而不是过去那句"画布还没有绑定到会话"的死胡同。NEW 永远是任务流水线
       * 项目（模块图只来自导入）。运行类动作先采纳画布的图（画布是权威），
       * 再投递——agent 被指去的文件就是用户眼前这张图。
       */
      async handler(req, res, { project }) {
        const body = await readJsonBody(req)
        if (body === undefined || body === null || typeof body !== 'object') {
          sendJson(res, 400, { ok: false, error: 'expected a JSON body' })
          return
        }
        const action = String(body.action ?? '')
        if (!AGENT_ACTIONS.has(action)) {
          sendJson(res, 400, { ok: false, error: `unknown action "${action}"` })
          return
        }

        // ---- NEW：先校验工作区，再落地骨架，最后交给 agent ----------------
        // v1.2.1（Issue #1）：请求必须带 `body.workspace` 且它必须是已登记的
        // DSH 工作区。校验在任何副作用之前完成——没有 workspace 或它非法时
        // 不建目录、不写文件、不建会话、不落盘，直接报错（A3 不变量）。
        if (action === 'NEW') {
          if (typeof validateWorkspace !== 'function') {
            sendJson(res, 503, {
              ok: false,
              code: 'NO_WORKSPACE_SERVICE',
              error: '当前组合没有注入工作区校验能力，无法安全确定项目落点。',
            })
            return
          }
          const check = await validateWorkspace(body.workspace)
          if (check.ok !== true) {
            logger?.warn?.(`codeflow: NEW refused workspace=${JSON.stringify(body.workspace)} code=${check.code}`)
            sendJson(res, workspaceErrorStatus(check.code), { ok: false, code: check.code, error: check.message })
            return
          }
          const cwd = check.workspace
          const existingNames = new Set((await store.listProjects(cwd)).map((entry) => entry.name))
          // 内存里的项目可能还没落盘（或它的工作区解析不出来）；绝不悄悄复用
          // 它们的名字。
          for (const key of store.keys()) existingNames.add(key)
          const starter = buildStarterGraph({
            name: body.name,
            brief: body.brief,
            language: body.language,
            existingNames,
          })
          // v1.0 语义保留：默认根 `<工作区>/CodeFlow` 的骨架目录（flow-projects）
          // 在此创建；**工作区根目录本身绝不创建**（它必须是已登记的存在目录）。
          try {
            await ensureLayout(cwd)
          } catch (error) {
            sendJson(res, 409, { ok: false, code: 'WORKSPACE_ROOT_UNWRITABLE', error: String(error?.message ?? error) })
            return
          }
          const dir = await dirOf(cwd, starter.projectName)
          const written = await store.write(starter.graph, {
            persist: 'now',
            cwd,
            // v1.0：新项目落在 `<根>/flow-projects/<名>/`。
            dir,
            title: starter.projectName,
            view: 'tasks',
          })
          // A2.6：显式绑定（内存 + 写入时的 cwd/dir 已隐式绑定，这里再声明一次，
          // 幂等）；侧车 `session.json` 的 `workspace` 字段由 createAndBind 写入。
          store.bindCwd(starter.projectName, cwd, dir)
          const session = await sessionFor(starter.projectName)
          let delivered = true
          let warning
          try {
            await submit({
              action,
              body: { ...body, name: starter.projectName, project: starter.projectName },
              project: starter.projectName,
              rev: written.rev,
              view: 'tasks',
            })
          } catch (error) {
            delivered = false
            warning = `项目已创建，但 agent 未能接手：${String(error?.message ?? error)}`
            logger?.warn?.(`codeflow: cannot deliver NEW: ${String(error)}`)
          }
          // v1.2.1：「没找到工作区」不再是 warning——它现在是 400/409 错误。
          // warning 只留给真实的降级：agent 没接手 / 图没写进磁盘 / 重名改名。
          warning = [
            warning,
            session.warning,
            starter.renamed ? `项目名已被占用，改用「${starter.projectName}」` : '',
            written.persisted === false ? `图谱未能写入磁盘（${written.error ?? '未知原因'}）` : '',
          ].filter(Boolean).join('；') || undefined
          sendJson(res, 200, {
            ok: true,
            project: starter.projectName,
            view: 'tasks',
            rev: written.rev,
            graph: written.graph,
            delivered,
            // A2.8：落点三元组随响应下发（与磁盘实际一致）。
            workspace: cwd,
            workspaceSource: 'binding',
            projectDir: dir,
            ...sessionFields(starter.projectName),
            ...(written.file === undefined ? {} : { file: written.file }),
            ...(written.persisted === undefined ? {} : { persisted: written.persisted }),
            ...(warning === undefined ? {} : { warning }),
          })
          return
        }

        // ---- RUN_NODE / RUN_ALL / SAVE：先采纳画布图，再投递 ---------------
        // 过时的写者与其它写者一样被 409 拒绝（NEW 豁免：它自建项目，没有
        // 需要匹配的基准修订）。
        const cwd = await cwdOf(body.project ?? project)
        const { view, viewport } = viewFieldsOf(body)
        const written = body.graph !== undefined
          ? await store.write(body.graph, {
              persist: 'now',
              view,
              viewport,
              cwd,
              dir: await dirOf(cwd, body.project ?? body.graph?.project?.name ?? project),
              expectedRev: body.expectedRev,
            })
          : store.get(body.project ?? project)
        const runView = written?.view ?? view ?? 'tasks'
        let submitResult
        try {
          // 投递层负责解析专用会话、快照项目树（RUN_*），然后才能引用该视图
          // 持久图的工作区绝对路径。
          submitResult = await submit({ action, body, project: body.project ?? written?.key, rev: written?.rev ?? 0, view: runView })
        } catch (error) {
          logger?.warn?.(`codeflow: cannot deliver action ${action}: ${String(error)}`)
          sendJson(res, 409, { ok: false, error: String(error?.message ?? error) })
          return
        }
        const snapshot = submitResult?.snapshot
        const warnings = []
        if (snapshot !== undefined && snapshot.undoable === false) {
          warnings.push(`本次运行不可撤销：${snapshot.reason ?? '快照未创建'}`)
        } else if (snapshot !== undefined && snapshot.partial === true) {
          warnings.push('部分文件未纳入快照（符号链接或超大文件），撤销范围不完整')
        }
        sendJson(res, 200, {
          ok: true,
          // v1.0 A3.3：投递层在图写入后立刻把目标节点翻成 `running`，这会把
          // 该视图的 rev 再加一。应答 store 的**实时** rev，面板的下一次自动
          // 保存才不会跟自己的点击 409。
          rev: store.get(body.project ?? written?.key, runView)?.rev ?? written?.rev ?? 0,
          view: runView,
          sessionId: submitResult?.sessionId,
          ...(snapshot?.runId !== undefined ? { runId: snapshot.runId, undoable: snapshot.undoable === true } : {}),
          ...(written?.persisted === undefined ? {} : { persisted: written.persisted }),
          ...(warnings.length === 0 ? {} : { warning: warnings.join('；') }),
        })
      },
    },
    {
      method: 'GET',
      path: '/api/projects',
      /** 持久项目列表。一个会话的第一次列表也是懒迁移的触发点：旧
       * `<工作区>/flow-projects/` 由此一次性搬进 `<根>/flow-projects/`。 */
      async handler(req, res, { project }) {
        const cwd = await workspaceReady(project)
        const projects = cwd === undefined ? [] : await store.listProjects(cwd)
        sendJson(res, 200, {
          ok: true,
          projects,
          ...(cwd !== undefined ? { root: await rootOf(cwd).catch(() => undefined), defaultRoot: defaultRoot(cwd) } : {}),
        })
      },
    },
    {
      method: 'GET',
      path: '/api/config',
      /** 读取生效根与项目实际目录（含迁移横幅用的 lastMigration；v1.2.1 起带解析来源）。 */
      async handler(req, res, { project }) {
        const cwd = await workspaceReady(project)
        if (cwd === undefined) {
          const resolved = await cwdExOf(project)
          sendJson(res, 409, {
            ok: false,
            code: 'NO_WORKSPACE',
            error: resolved?.message
              ?? '还没有可用的 DSH 工作区，无法读取 CodeFlow 设置。请先在 DSH 左侧栏添加工作区，或新建一个项目以绑定工作区。',
          })
          return
        }
        const cfg = await readConfig(cwd)
        const projectName = project ?? undefined
        const effectiveDir = projectName !== undefined ? await dirOf(cwd, projectName) : undefined
        const source = await cwdExOf(project)
        sendJson(res, 200, {
          ok: true,
          workspace: cwd,
          ...(source?.source !== undefined ? { workspaceSource: source.source } : {}),
          defaultRoot: defaultRoot(cwd),
          root: cfg.root ?? defaultRoot(cwd),
          customRoot: cfg.root ?? null,
          project: projectName ?? null,
          projectDir: effectiveDir ?? null,
          projectOverride: projectName !== undefined ? cfg.projects?.[projectName]?.dir ?? null : undefined,
          overrides: cfg.projects ?? {},
          migrated: cfg.migratedAt ?? null,
          ...(ctx.lastMigration !== undefined ? { lastMigration: ctx.lastMigration } : {}),
        })
      },
    },
    {
      method: 'POST',
      path: '/api/config',
      /**
       * 改根（或恢复默认）与设置/清除单项目目录覆盖。校验与画布设置对话框
       * 同一契约：只收绝对路径、不收文件、不收插件包内路径，目标必须可建
       * 可写（探测文件）。
       */
      async handler(req, res, { project }) {
        const body = await readJsonBody(req)
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(res, 400, { ok: false, error: 'expected a JSON body' })
          return
        }
        const cwd = await cwdOf(body.project ?? project)
        if (cwd === undefined) {
          const resolved = await cwdExOf(body.project ?? project)
          sendJson(res, 409, {
            ok: false,
            code: 'NO_WORKSPACE',
            error: resolved?.message
              ?? '还没有可用的 DSH 工作区，无法保存 CodeFlow 设置。请先在 DSH 左侧栏添加工作区，或新建一个项目以绑定工作区。',
          })
          return
        }
        const cfg = await readConfig(cwd)
        try {
          if (body.root !== undefined) {
            if (body.root === null) {
              // 恢复默认根：旧根进 knownRoots（里面的项目仍可列出/打开）。
              if (cfg.root !== null && !cfg.knownRoots.includes(cfg.root)) cfg.knownRoots.push(cfg.root)
              cfg.root = null
            } else {
              const nextRoot = await validateConfiguredDir(body.root, { kind: '项目根目录' })
              // 根必须真能放下项目：探测它下面的 flow-projects 可建可写。
              await probeWritable(path.join(nextRoot, 'flow-projects'))
              // 改根不搬家：旧根记入 knownRoots，旧项目仍从旧位置列出。
              if (cfg.root !== null && cfg.root !== nextRoot && !cfg.knownRoots.includes(cfg.root)) {
                cfg.knownRoots.push(cfg.root)
              }
              cfg.root = nextRoot
            }
          }
          if (body.projectDir !== undefined) {
            const projectName = typeof body.project === 'string' && body.project.trim().length > 0 ? body.project.trim() : undefined
            if (projectName === undefined) {
              const error = new Error('设置项目目录时必须带上 project（项目名）。')
              error.statusCode = 400
              throw error
            }
            const key = String(projectName)
            if (body.projectDir === null) {
              delete cfg.projects[key]
            } else {
              const nextDir = await validateConfiguredDir(body.projectDir, { kind: '项目目录' })
              await probeWritable(nextDir)
              cfg.projects[key] = { dir: nextDir, updatedAt: Date.now() }
            }
          }
        } catch (error) {
          sendJson(res, statusOf(error), { ok: false, error: String(error?.message ?? error) })
          return
        }
        const saved = await writeConfig(cwd, cfg).catch((error) => {
          const failure = new Error(`配置写入失败：${String(error?.message ?? error)}`)
          failure.statusCode = 409
          throw failure
        })
        const projectName = typeof body.project === 'string' && body.project.trim().length > 0 ? body.project.trim() : undefined
        sendJson(res, 200, {
          ok: true,
          workspace: cwd,
          defaultRoot: defaultRoot(cwd),
          root: saved.root ?? defaultRoot(cwd),
          customRoot: saved.root ?? null,
          ...(projectName !== undefined ? { project: projectName, projectDir: await dirOf(cwd, projectName) } : {}),
        })
      },
    },
  ]
}
