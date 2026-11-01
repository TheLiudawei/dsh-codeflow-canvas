/**
 * 导入与扫描检查：中文/空格/NFD 文件名在一整条确定性流水线上的表现。
 *
 * 导入不调用模型，全部是本地扫描 + 图组装，因此可以被精确断言。macOS 的
 * 特殊性在于文件名：Finder 存 NFD、Node 的 `normalize` 常产出 NFC、APFS
 * 大小写不敏感；同一棵源码树可能因"用哪台机器、从哪个入口导入"而呈现
 * 不同的相对路径字符串。这里验证三件事：
 *
 *   1. 该跳过的目录（node_modules / .git / .undo / dist）绝不进图；
 *   2. 同一目录连续导入两次，除时间戳外字节一致；
 *   3. 通过真实 HTTP `/api/import` 的端到端导入能在中文项目名下产出任务
 *      图、模块图、features.json 与耦合结论。
 *
 * @module tests/mac/checks/import
 */

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import { buildProjectFixture, FIXTURE } from '../lib/fixtures.mjs'
import { createHost } from '../lib/harness.mjs'

/** 去掉时间戳后的可比较图（导入是确定性的，时间戳不是）。 */
function stableGraph(graph) {
  const copy = JSON.parse(JSON.stringify(graph))
  if (copy.meta !== null && typeof copy.meta === 'object') {
    delete copy.meta.createdAt
    delete copy.meta.updatedAt
  }
  return copy
}

/** 去掉生成时间后的功能索引。 */
function stableFeatures(index) {
  const copy = JSON.parse(JSON.stringify(index))
  delete copy.generatedAt
  delete copy.recognizedInMs
  return copy
}

/**
 * 运行导入检查。
 *
 * @param ctx - 套件上下文。
 */
export async function runImportChecks(ctx) {
  const { pluginRoot, runner, env } = ctx
  runner.group('确定性导入与扫描（中文路径）')

  const area = await ctx.temp('import-')
  const root = path.join(area, '项目 甲')
  await buildProjectFixture(root)

  const importer = await ctx.load('lib/importer.js')
  const analyst = await ctx.load('lib/analyst.js')
  const features = await ctx.load('lib/features.js')

  let tasks
  await runner.check('IMP-01', '导入：节点、扫描结果与项目名都来自夹具，而不是空图', async () => {
    const result = await importer.importProject({ path: root })
    tasks = result
    const graph = result.graph
    if (graph.format !== 'codeflow/1') throw new Error(`format=${graph.format}`)
    if (graph.nodes.length < 3) throw new Error(`只生成了 ${graph.nodes.length} 个节点`)
    if (!graph.nodes.some((node) => node.type === 'scan' && node.status === 'done')) throw new Error('没有已完成的 scan 节点')
    if (!graph.nodes.some((node) => node.type === 'comments')) throw new Error('没有 comments 节点')
    if (!graph.nodes.some((node) => node.type === 'deliver')) throw new Error('没有 deliver 节点')
    if (graph.project.name !== '项目-甲') throw new Error(`项目名=${graph.project.name}`)
    if (path.normalize(graph.meta.importedFrom) !== path.normalize(root)) throw new Error(`importedFrom=${graph.meta.importedFrom}`)
    if (!(result.stats.files >= 6)) throw new Error(`统计文件数=${result.stats.files}`)
    return `${graph.nodes.length} 节点 · ${result.stats.files} 文件 · ${result.stats.markers} 标记`
  })

  await runner.check('IMP-02', '跳过清单生效：依赖/构建/版本库/撤销目录的诱饵不进图', async () => {
    if (tasks === undefined) throw new Error('导入失败（见 IMP-01）')
    const text = JSON.stringify(tasks.graph)
    const leaks = [
      ['node_modules', '依赖目录'],
      ['依赖目录里的诱饵', '依赖目录里的 TODO'],
      ['构建产物诱饵', 'dist 里的 TODO'],
      ['.git/config', '版本库元数据'],
      ['.undo/', '撤销快照目录'],
      ['.DS_Store', 'Finder 元数据'],
    ].filter(([needle]) => text.includes(needle))
    if (leaks.length > 0) throw new Error(`未被跳过：${leaks.map(([needle, label]) => `${label}（${needle}）`).join('、')}`)
    return '诱饵未进入图'
  })

  await runner.check('IMP-03', '同一目录连续导入两次：除时间戳外完全一致', async () => {
    const again = await importer.importProject({ path: root })
    const left = JSON.stringify(stableGraph(tasks.graph))
    const right = JSON.stringify(stableGraph(again.graph))
    if (left !== right) {
      // 给出第一个差异位置，用户回传时能定位。
      let index = 0
      while (index < left.length && index < right.length && left[index] === right[index]) index += 1
      throw new Error(`两次导入不一致，首个差异在偏移 ${index}：…${left.slice(index, index + 80)} / …${right.slice(index, index + 80)}`)
    }
    if (again.stats.files !== tasks.stats.files) throw new Error('两次统计的文件数不一致')
    return `字节一致（${left.length} 字节，忽略 createdAt/updatedAt）`
  })

  await runner.check('IMP-04', 'NFD 根路径（Finder 拼写）导入结果与 NFC 一致', async () => {
    if (!env.filesystem.unicodeNormalizationInsensitive) {
      return { skip: '当前文件系统不按 Unicode 规范化查找（非 APFS）' }
    }
    const nfdRoot = root.normalize('NFD')
    if (nfdRoot === root) return { skip: '当前运行时没有改变规范化形式' }
    const result = await importer.importProject({ path: nfdRoot })
    if (result.graph.project.name !== tasks.graph.project.name) {
      throw new Error(`项目名 ${result.graph.project.name} ≠ ${tasks.graph.project.name}`)
    }
    if (result.graph.nodes.length !== tasks.graph.nodes.length) {
      throw new Error(`节点数 ${result.graph.nodes.length} ≠ ${tasks.graph.nodes.length}`)
    }
    return `NFD 根仍得到 ${result.graph.nodes.length} 节点`
  })

  let modules
  await runner.check('IMP-05', '模块结构图：有界、id 唯一、路径都在源码根内', async () => {
    const result = await analyst.analyzeModules({ path: root })
    modules = result
    const graph = result.graph
    if (graph.meta.strategy !== 'modules') throw new Error(`strategy=${graph.meta.strategy}`)
    const ids = new Set()
    const duplicates = []
    for (const node of graph.nodes) {
      if (ids.has(node.id)) duplicates.push(node.id)
      ids.add(node.id)
    }
    if (duplicates.length > 0) throw new Error(`重复节点 id：${duplicates.join(', ')}`)
    const moduleNodes = graph.nodes.filter((node) => node.type === 'module' && node.params?.path !== undefined)
    if (moduleNodes.length === 0) throw new Error('没有 module 节点')
    if (moduleNodes.length > 36) throw new Error(`module 节点 ${moduleNodes.length} 个，超过上限 36`)
    const outside = moduleNodes.filter((node) => {
      const rel = path.relative(root, node.params.path)
      return rel.startsWith('..') || path.isAbsolute(rel)
    })
    if (outside.length > 0) throw new Error(`有 ${outside.length} 个节点的路径在源码根之外`)
    if (!moduleNodes.some((node) => /用户模块/.test(node.params.path))) {
      throw new Error('中文文件名没有出现在模块节点里')
    }
    return `${moduleNodes.length} 个模块节点 / ${graph.nodes.length} 个总节点`
  })

  await runner.check('IMP-06', '模块结构图连续分析两次一致', async () => {
    const again = await analyst.analyzeModules({ path: root })
    const left = JSON.stringify(stableGraph(modules.graph))
    const right = JSON.stringify(stableGraph(again.graph))
    if (left !== right) throw new Error('两次模块分析不一致')
    return '字节一致（忽略时间戳）'
  })

  await runner.check('IMP-07', '功能索引：中文文件可被识别且两次构建一致', async () => {
    const first = await features.buildFeatureIndex({ root, graph: modules.graph })
    if (!Array.isArray(first.features)) throw new Error('features 不是数组')
    if (first.unavailable !== undefined) throw new Error(`功能索引不可用：${first.unavailable}`)
    const second = await features.buildFeatureIndex({ root, graph: modules.graph })
    if (JSON.stringify(stableFeatures(first)) !== JSON.stringify(stableFeatures(second))) {
      throw new Error('两次功能索引构建不一致')
    }
    const files = first.features.flatMap((feature) => feature.files ?? [])
    if (files.length > 0 && !files.some((rel) => rel.normalize('NFC').includes('用户模块'))) {
      return { warn: `识别到 ${first.features.length} 个功能，但没有一个包含中文用户模块（词典未命中，不一定是缺陷）` }
    }
    return `${first.features.length} 个功能 / ${files.length} 个文件归属`
  })

  await runner.check('IMP-08', 'HTTP /api/import 端到端：中文项目名 → 双图 + features.json + 耦合', async () => {
    const workspace = await ctx.temp('import-http-')
    const host = await createHost({ pluginRoot, workspace })
    try {
      const res = await host.request('POST', '/codeflow/api/import', { path: root })
      if (res.status !== 200 || res.json?.ok !== true) {
        throw new Error(`状态码 ${res.status}：${res.body.slice(0, 300)}`)
      }
      const payload = res.json
      if (payload.project !== '项目-甲') throw new Error(`project=${payload.project}`)
      if (payload.persisted !== true) throw new Error('tasks 图没有落盘')
      if (payload.modulesAvailable !== true) throw new Error(`模块图不可用：${payload.warning}`)
      if (payload.graph?.nodes?.length < 3) throw new Error('返回的任务图节点过少')
      if (payload.coupling?.overall === null || payload.coupling?.overall === undefined) {
        throw new Error('自动耦合没有产出 overall')
      }
      if (!['low', 'medium', 'high'].includes(payload.coupling.overall.level)) {
        throw new Error(`耦合等级异常：${payload.coupling.overall.level}`)
      }
      const dir = path.join(workspace, 'CodeFlow', 'flow-projects', '项目-甲')
      for (const file of ['workflow.json', 'workflow.modules.json', 'features.json']) {
        const info = await stat(path.join(dir, file)).catch(() => undefined)
        if (info === undefined) throw new Error(`缺少 ${file}`)
      }
      const featureIndex = JSON.parse(await readFile(path.join(dir, 'features.json'), 'utf8'))
      if (!Array.isArray(featureIndex.features)) throw new Error('features.json 形状不对')

      // 再跑一次耦合：结果应稳定（at 时间戳除外）。
      const coupled = await host.request('POST', '/codeflow/api/coupling', { project: payload.project })
      if (coupled.status !== 200) throw new Error(`耦合接口返回 ${coupled.status}`)
      if (coupled.json?.overall === null || coupled.json?.overall === undefined) throw new Error('耦合接口没有 overall')
      const scoreOf = (node) => `${node.id}:${node.level}:${node.score}`
      const before = (payload.graph?.nodes ?? [])
        .filter((node) => node.coupling !== undefined)
        .map(scoreOf)
        .sort()
      const after = (coupled.json.updated ?? [])
        .map((entry) => `${entry.id}:${entry.level}:${entry.score}`)
        .sort()
      if (before.length > 0 && JSON.stringify(before) !== JSON.stringify(after)) {
        throw new Error('同一源码两次耦合分析的分数不一致')
      }
      return `${payload.graph.nodes.length} 节点 · ${payload.coupling.overall.level}（${payload.coupling.overall.score}） · features ${featureIndex.features.length}`
    } finally {
      host.dispose()
    }
  })

  await runner.check('IMP-09', 'CLI 导入（Electron-as-node）写出两个视图文件', async () => {
    const { spawnSync } = await import('node:child_process')
    const out = await ctx.temp('import-cli-')
    const importerFile = path.join(pluginRoot, 'lib', 'importer.js')
    const result = spawnSync(process.execPath, [importerFile, root, '--out', out], {
      encoding: 'utf8',
      timeout: 120000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
    })
    if (result.status !== 0) {
      throw new Error(`CLI 退出码 ${result.status}：${String(result.stderr ?? '').trim().slice(-400)}`)
    }
    const dir = path.join(out, 'CodeFlow', 'flow-projects', '项目-甲')
    for (const file of ['workflow.json', 'workflow.modules.json']) {
      const info = await stat(path.join(dir, file)).catch(() => undefined)
      if (info === undefined) throw new Error(`CLI 没有写出 ${file}`)
    }
    return 'workflow.json + workflow.modules.json 均已写出'
  })

  await runner.check('IMP-10', 'CLI --json 输出可解析的 JSON（并记录是否落模块图）', async () => {
    const { spawnSync } = await import('node:child_process')
    const out = await ctx.temp('import-cli-json-')
    const importerFile = path.join(pluginRoot, 'lib', 'importer.js')
    const result = spawnSync(process.execPath, [importerFile, root, '--out', out, '--json'], {
      encoding: 'utf8',
      timeout: 120000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
    })
    if (result.status !== 0) {
      throw new Error(`CLI 退出码 ${result.status}：${String(result.stderr ?? '').trim().slice(-400)}`)
    }
    let parsed
    try {
      parsed = JSON.parse(result.stdout)
    } catch {
      throw new Error(`CLI 输出不是 JSON：${result.stdout.slice(0, 200)}`)
    }
    if (!Array.isArray(parsed.tasks?.nodes)) throw new Error('CLI 输出缺少 tasks 图')
    if (!Array.isArray(parsed.modules?.nodes)) throw new Error('CLI 输出缺少 modules 图')
    const modulesFile = path.join(out, 'CodeFlow', 'flow-projects', '项目-甲', 'workflow.modules.json')
    const info = await stat(modulesFile).catch(() => undefined)
    if (info === undefined) {
      return { warn: '--json 模式下只写了 workflow.json，没有落 workflow.modules.json；GUI 导入不受影响，但脚本化导入会丢模块视图' }
    }
    return `${parsed.tasks.nodes.length} 任务节点 · ${parsed.modules.nodes.length} 模块节点`
  })
}
