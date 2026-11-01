/**
 * 文本助手：截断、首句提取、错误消息归一与"只警告一次"。
 *
 * 都是几行的纯函数，但被十几个模块重复手写——尤其 `errorMessage` 的
 * `String(error?.message ?? error)` 惯用法在全库出现了 40+ 次。统一到这里
 * 之后，错误呈现方式只有一个定义点。
 *
 * 依赖方向：本模块是第 0 层基础件，零 import。
 *
 * @module dsh-codeflow-canvas/core/text
 */

/**
 * 截断文本到 `limit` 字符，超长时以省略号结尾（占最后一个字符位）。
 * 节点 result/detail、上游结果采样等字段的统一限长器。
 *
 * @param text - 任意输入（非字符串先转字符串）。
 * @param limit - 最大字符数。
 */
export function clip(text, limit) {
  const value = String(text ?? '')
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
}

/**
 * 取注释块的第一句话：第一个句子结束符（中英文句号/叹号/问号）之前的内容；
 * 没有结束符时取整行。导入生成的任务节点标题用它保持简短可读。
 *
 * @param text - 注释文本（可多行，只看第一行）。
 */
export function firstSentence(text) {
  const line = String(text ?? '').trim().split('\n')[0] ?? ''
  const at = line.search(/[。．！？!?.](\s|$)/)
  return (at > 0 ? line.slice(0, at + 1) : line).trim()
}

/**
 * 把任意抛出的值归一成一条可读消息：Error 取 `message`，其余直接字符串化。
 * 全库日志与错误响应的统一出口，替代手写的 `String(error?.message ?? error)`。
 *
 * @param error - catch 到的任意值。
 */
export function errorMessage(error) {
  return String(error?.message ?? error)
}

/**
 * 造一个"同一把键只警告一次"的函数（进程内）。
 *
 * 使用方各自持有一把键域：paths.js 按工作区键、features.js 按文件键。
 * 警告统一走 `log.warn`，并带 `codeflow: ` 前缀，便于在宿主日志里过滤。
 *
 * @param log - 宿主 logger（需要有 `warn`；缺省 `console`）。
 * @returns `(key, message) => void`，同一 `key` 只会真正记录第一次。
 */
export function createWarnOnce(log = console) {
  const seen = new Set()
  return (key, message) => {
    if (seen.has(key)) return
    seen.add(key)
    log?.warn?.(`codeflow: ${message}`)
  }
}
