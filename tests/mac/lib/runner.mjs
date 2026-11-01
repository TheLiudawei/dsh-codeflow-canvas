/**
 * macOS 现场诊断套件的检查运行器。
 *
 * 与仓库其它测试不同，这套套件是**发给用户在他们机器上跑**的：它不能在
 * 第一项失败时中止，而要把每一项的真实结果、平台信息和复现细节一起带回
 * 来。因此这里的 `check()` 只记录、不抛出；`fail` 只表示"插件在这一项上
 * 的表现与预期不符"，套件本身仍会跑完。
 *
 * 三个状态层级：
 *
 *   ok    通过。
 *   fail  可复现的产品缺陷（报告里是第一优先级）。
 *   warn  与平台/环境相关、但不足以判定为缺陷的观察（例如 Rosetta、
 *         Gatekeeper 隔离属性、macOS 上缺失的 7z/rar 解压器）。
 *   skip  前置条件不满足（例如非 macOS 上跳过仅 Darwin 的探测）。
 *   info  纯信息，不参与通过/失败统计。
 *
 * @module tests/mac/lib/runner
 */

/** 状态在终端里的短标记。 */
const MARK = {
  ok: 'ok  ',
  fail: 'FAIL',
  warn: 'WARN',
  skip: 'skip',
  info: 'info',
}

/** 给终端输出用的颜色；`NO_COLOR` 或非 TTY 时关闭。 */
function painter() {
  const enabled = process.stdout.isTTY === true && process.env.NO_COLOR === undefined
  const wrap = (code) => (text) => (enabled ? `\u001b[${code}m${text}\u001b[0m` : String(text))
  return {
    ok: wrap('32'),
    fail: wrap('31'),
    warn: wrap('33'),
    skip: wrap('90'),
    info: wrap('36'),
    dim: wrap('90'),
    bold: wrap('1'),
  }
}

/** 把任意值压成一行，避免一条超长日志淹掉终端。 */
function oneLine(value, limit = 220) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/**
 * 创建运行器。
 *
 * @param options.filter - 只运行 id 以该前缀开头的检查（便于用户复跑单组）。
 * @param options.quiet - 减少终端输出（报告仍完整）。
 */
export function createRunner({ filter, quiet = false } = {}) {
  const paint = painter()
  const groups = []
  const notes = []
  const counts = { ok: 0, fail: 0, warn: 0, skip: 0 }
  /** 已经打印过标题的组：过滤运行时不留下空标题。 */
  const printedGroups = new WeakSet()
  let current
  let startedAt = Date.now()

  /** 当前组；没有显式分组时归入「未分组」。 */
  function ensureGroup() {
    if (current === undefined) group('未分组')
    return current
  }

  /**
   * 开一个检查组。组标题直接进报告，写成用户能看懂的中文。
   * 标题延迟到第一条结果时打印——`--filter PATH` 时不会留下一串空组。
   */
  function group(title) {
    current = { title, entries: [] }
    groups.push(current)
    return current
  }

  /** 打印组标题（每个组一次）。 */
  function printGroupHeader() {
    if (printedGroups.has(current)) return
    printedGroups.add(current)
    if (!quiet) console.log(`\n${paint.bold('── ' + current.title + ' ──')}`)
  }

  /** 当前过滤是否放行某个 id。 */
  function allowed(id) {
    return filter === undefined || filter.length === 0 || String(id).startsWith(filter)
  }

  /** 记录一条结果并打印。 */
  function record(entry) {
    ensureGroup()
    printGroupHeader()
    current.entries.push(entry)
    if (entry.status in counts) counts[entry.status] += 1
    if (quiet && entry.status === 'ok') return entry
    const mark = entry.status === 'fail' ? paint.fail(MARK.fail)
      : entry.status === 'warn' ? paint.warn(MARK.warn)
        : entry.status === 'skip' ? paint.skip(MARK.skip)
          : entry.status === 'info' ? paint.info(MARK.info)
            : paint.ok(MARK.ok)
    const detail = entry.detail !== undefined && entry.detail !== '' ? ` — ${oneLine(entry.detail)}` : ''
    console.log(`  ${mark}  ${paint.dim(entry.id)}  ${entry.title}${detail}`)
    if (entry.status === 'fail' && entry.error !== undefined && !quiet) {
      const first = String(entry.error.stack ?? entry.error.message ?? entry.error).split('\n').slice(0, 2).join('\n    ')
      console.log(`    ${paint.dim(first)}`)
    }
    return entry
  }

  /**
   * 运行一项检查。
   *
   * `fn` 可以返回：
   *   - `undefined` / 字符串：通过（字符串作为说明）；
   *   - `{ detail }`：通过并附说明；
   *   - `{ warn }`：降级为 warn；
   *   - `{ skip }`：跳过。
   * 抛出异常 = 失败。异常里的 `skip` 标记同样会被识别。
   *
   * @returns 是否通过（warn/skip 也算没有失败）。
   */
  async function check(id, title, fn) {
    if (!allowed(id)) return true
    const started = Date.now()
    try {
      const value = await fn()
      const elapsed = Date.now() - started
      if (value !== null && typeof value === 'object' && typeof value.skip === 'string') {
        record({ id, title, status: 'skip', detail: value.skip, durationMs: elapsed })
        return true
      }
      if (value !== null && typeof value === 'object' && typeof value.warn === 'string') {
        record({ id, title, status: 'warn', detail: value.warn, durationMs: elapsed })
        return true
      }
      const detail = typeof value === 'string' ? value : value?.detail
      record({ id, title, status: 'ok', detail, durationMs: elapsed })
      return true
    } catch (error) {
      record({
        id,
        title,
        status: 'fail',
        detail: error?.message ?? String(error),
        error: { message: String(error?.message ?? error), stack: String(error?.stack ?? '') },
        durationMs: Date.now() - started,
      })
      return false
    }
  }

  /** 直接记录一条 warn（不执行断言）。 */
  function warn(id, title, detail) {
    if (!allowed(id)) return
    record({ id, title, status: 'warn', detail })
  }

  /** 直接记录一条 skip。 */
  function skip(id, title, reason) {
    if (!allowed(id)) return
    record({ id, title, status: 'skip', detail: reason })
  }

  /** 纯信息；不计入统计。 */
  function info(id, title, detail) {
    if (!allowed(id)) return
    record({ id, title, status: 'info', detail })
  }

  /** 一段不占检查项的观察（例如 Mac 风险扫描的行号清单）。 */
  function note(title, lines) {
    notes.push({ title, lines: Array.isArray(lines) ? lines : [lines] })
  }

  /** 汇总；`verdict` 只看 fail。 */
  function summary() {
    const total = counts.ok + counts.fail + counts.warn + counts.skip
    return {
      ...counts,
      total,
      verdict: counts.fail === 0 ? 'PASS' : 'FAIL',
      durationMs: Date.now() - startedAt,
    }
  }

  return {
    group,
    check,
    warn,
    skip,
    info,
    note,
    summary,
    groups,
    notes,
    counts,
    /** 开始计时（main 在建好工作区后调用，排除启动开销）。 */
    start() { startedAt = Date.now() },
  }
}
