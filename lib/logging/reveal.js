/**
 * 「打开日志所在目录」的适配器（v1.3.0，需求四）。
 *
 * 优先用宿主能力（`shell.showItemInFolder` / `shell.openPath`——由 index.js
 * 从 DSH ctx 探测并注入）；没有宿主能力时用 `explorer /select`（Windows）/
 * `open -R`（macOS）/ `xdg-open`（Linux），`spawn` 必须注入以便单测不真开窗。
 * 两者都不可用 → `{ ok:false, code:501 }`，UI 明确提示（复制路径兜底）。
 *
 * 安全面：只接受插件自己的日志文件路径（由 index.js 绑定 `fileLogger.path`
 * 后整体注入），**不接受请求方给的任意路径**。
 *
 * 依赖方向：L0——`node:child_process`（spawn 由调用方注入）与 `node:path`。
 *
 * @module dsh-codeflow-canvas/logging/reveal
 */
import path from 'node:path'

/**
 * 创建 reveal 能力。
 *
 * @param options.hostShell - 宿主 shell 形状（可选）：
 *   `{ showItemInFolder?(path), openPath?(path) }`。
 * @param options.spawn - `child_process.spawn` 形状（无 hostShell 时用）。
 * @param options.allowedFile - 允许揭示的日志文件绝对路径（固定绑定）。
 * @returns `revealTarget(kind)` → `{ ok, kind, path?, dir?, code? }`；
 *   kind: `'item'`（选中文件）| `'dir'`（打开目录）。
 */
export function createReveal(options = {}) {
  const hostShell = options.hostShell && typeof options.hostShell === 'object' ? options.hostShell : undefined
  const spawn = typeof options.spawn === 'function' ? options.spawn : undefined
  const allowedFile = typeof options.allowedFile === 'string' && options.allowedFile.length > 0 ? options.allowedFile : undefined

  return async function revealTarget(kind = 'item') {
    if (allowedFile === undefined) {
      return { ok: false, code: 501, error: '文件日志未启用，没有可打开的日志位置。' }
    }
    const target = kind === 'dir' ? path.dirname(allowedFile) : allowedFile
    if (hostShell && typeof hostShell.showItemInFolder === 'function' && kind === 'item') {
      try {
        hostShell.showItemInFolder(allowedFile)
        return { ok: true, kind, path: allowedFile }
      } catch { /* 落到 spawn 兜底 */ }
    }
    if (hostShell && typeof hostShell.openPath === 'function' && kind === 'dir') {
      try {
        const result = await hostShell.openPath(path.dirname(allowedFile))
        if (result === '' || result === undefined || result === null) {
          return { ok: true, kind, dir: path.dirname(allowedFile) }
        }
      } catch { /* 落到 spawn 兜底 */ }
    }
    if (spawn === undefined) {
      return { ok: false, code: 501, error: '当前宿主不支持打开目录；请复制路径手动查看。' }
    }
    try {
      let argv
      if (process.platform === 'win32') {
        argv = ['explorer', kind === 'dir' ? path.dirname(allowedFile) : `/select,${allowedFile}`]
      } else if (process.platform === 'darwin') {
        argv = kind === 'dir' ? ['open', path.dirname(allowedFile)] : ['open', '-R', allowedFile]
      } else {
        argv = ['xdg-open', path.dirname(allowedFile)]
      }
      const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore', windowsHide: true })
      child.on?.('error', () => {})
      child.unref?.()
      return { ok: true, kind, ...(kind === 'dir' ? { dir: path.dirname(allowedFile) } : { path: allowedFile }) }
    } catch (error) {
      return { ok: false, code: 501, error: `打开目录失败：${String(error?.message ?? error)}` }
    }
  }
}
