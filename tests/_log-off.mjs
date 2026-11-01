/**
 * 测试入口的日志开关（v1.2.2，任务书 §8.5.10）。
 *
 * 只做副作用：在**第一次 import 插件 / 调用 apply() 之前**把文件日志关掉，
 * 保证测试不污染仓库根（`codeflow.log` 不应出现在插件目录）。会启动插件的
 * 测试（validate / regression / features / logging）在首行 import 本文件；
 * 用户/CI 直接 `node tests/xxx.mjs` 时同样生效，不依赖命令行环境变量。
 */
process.env.CODEFLOW_LOG = process.env.CODEFLOW_LOG ?? 'off'
