/**
 * 功能归属识别的共享常量：上限、信号置信度权重、通用名过滤。
 *
 * 全部是纯常量；detect / apply / map / ops / 聚合入口统一从这里取，
 * 保证「12 个功能 / 30 个文件 / 0.5 低置信线」这些契约只有一个定义点。
 *
 * 依赖方向：无 import（第 2 层叶子）。
 *
 * @module dsh-codeflow-canvas/features/constants
 */

/** 上限：12 个功能、每功能 30 个文件（超出截断并在 evidence 追加「已截断 N 个」）。 */
export const MAX_FEATURES = 12
export const MAX_FILES_PER_FEATURE = 30

/** 置信度权重（命中信号类型的加权均值）；低于阈值的组带「低置信」。 */
export const WEIGHT = { manual: 1.0, design: 0.9, entry: 0.8, symbol: 0.6, dir: 0.5, text: 0.35 }
export const LOW_CONFIDENCE = 0.5

/** 每条 evidence / aliases 的展示上限。 */
export const MAX_EVIDENCE = 6
export const MAX_ALIASES = 8

/** 入口信号里不值得当功能名的段（路由前缀、通用入口名）。 */
export const GENERIC_NAMES = /^(api|apis|v\d+|index|main|app|www|admin|internal|src|lib|core|common|utils?|helpers?|server|client)$/i
