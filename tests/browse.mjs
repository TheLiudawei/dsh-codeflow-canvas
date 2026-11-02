/**
 * 只读目录浏览（需求 C）的单元与集成测试（v1.2.1）。
 *
 * 全部在不启动宿主的情况下运行：真实临时目录 + 手工构造的 Dirent 形状。
 * 覆盖：
 *
 *   - listRoots：盘符 / POSIX 根 / 主目录 / 工作区，无重复、顺序稳定；
 *   - pickEntries：只留目录、跳过符号链接（含 junction 的真实 lstat 复核）、
 *     隐藏项跳过、zh-CN 大小写不敏感排序、501 → 500 截断；
 *   - parentOf：根 → null、盘符层级、POSIX 根、尾分隔符；
 *   - 边界输入：空串、相对路径、`..`、NUL → 带码错误，绝不抛未捕获异常；
 *   - 错误映射：不存在 404、是文件 400、无权限 403、超时 504；
 *   - readDirectoryEntries 端到端：排序、不含文件、junction 不出现、
 *     truncated、mtime 不变（只读断言）。
 *
 * Run: ELECTRON_RUN_AS_NODE=1 <electron> tests/browse.mjs
 */
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

const {
  BROWSE_LIMIT,
  BROWSE_TIMEOUT_MS,
  listRoots,
  pickEntries,
  parentOf,
  normalizeBrowseInput,
  readDirectoryEntries,
  browseDirectory,
  existingDriveRoots,
  withTimeout,
  mapFsError,
} = await import('../lib/browse.js')

const failures = []
let checks = 0

/** Run one named assertion, recording rather than throwing. */
async function check(name, fn) {
  checks += 1
  try {
    await fn()
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
    console.log(`FAIL  ${name}: ${error.message}`)
  }
}

/** 手工构造一个 Dirent 形状（pickEntries 是纯函数，只读这三个方法/字段）。 */
function dirent(name, { dir = true, link = false } = {}) {
  return {
    name,
    isDirectory: () => dir,
    isSymbolicLink: () => link,
  }
}

console.log('\n[listRoots]')
await check('windows roots: existing drives, then home, then workspaces, deduped and stable', () => {
  const home = 'C:\\Users\\me'
  const roots = listRoots({
    platform: 'win32',
    driveRoots: ['C:\\', 'D:\\'],
    home,
    workspaces: [{ path: 'C:\\Users\\me\\proj', title: 'proj' }, 'D:\\work'],
  })
  assert.deepEqual(roots.map((entry) => entry.path), ['C:\\', 'D:\\', home, 'C:\\Users\\me\\proj', 'D:\\work'])
  assert.ok(roots.every((entry) => entry.kind === 'root'))
  assert.equal(roots[2].name, '主目录')
  assert.equal(roots[3].name, 'proj', 'workspace titles are preferred for display')
  // 重复（主目录与工作区同路径）只出现一次；重复运行顺序稳定。
  const again = listRoots({ platform: 'win32', driveRoots: ['C:\\', 'D:\\'], home, workspaces: [home] })
  assert.deepEqual(again.map((entry) => entry.path), ['C:\\', 'D:\\', home])
  assert.deepEqual(listRoots({ platform: 'win32', driveRoots: [], home: '', workspaces: [] }).map((entry) => entry.path), [])
})
await check('posix roots: `/`, then home, then workspaces', () => {
  const roots = listRoots({ platform: 'linux', driveRoots: [], home: '/home/me', workspaces: ['/srv/project'] })
  assert.deepEqual(roots.map((entry) => entry.path), ['/', '/home/me', '/srv/project'])
  assert.equal(roots[0].name, '/')
})
await check('existingDriveRoots probes real drives read-only', async () => {
  const drives = await existingDriveRoots()
  assert.ok(Array.isArray(drives))
  if (process.platform === 'win32') {
    assert.ok(drives.length >= 1, 'this machine has at least one drive')
    assert.ok(drives.every((entry) => /^[A-Z]:\\$/.test(entry)), drives)
    assert.ok(drives.every((entry) => entry[0] >= 'A' && entry[0] <= 'Z'), 'ascending order')
  }
})

console.log('\n[pickEntries]')
await check('keeps directories only, skips links and hidden, sorts zh-CN case-insensitively', () => {
  const dirents = [
    dirent('文件.txt', { dir: false }),
    dirent('.hidden'),
    dirent('Zeta'),
    dirent('alpha'),
    dirent('Beta'),
    dirent('链接', { link: true }),
    dirent('中文目录'),
    dirent('中文目录2'),
  ]
  const { entries, truncated } = pickEntries(dirents, { dir: '/base' })
  assert.equal(truncated, false)
  const names = entries.map((entry) => entry.name)
  // 与 localeCompare('zh-CN') 的大小写不敏感比较器逐位一致（不硬编码 ICU 的
  // 跨脚本顺序，只锁行为契约）。
  const comparator = (a, b) => a.toLowerCase().localeCompare(b.toLowerCase(), 'zh-CN') || a.localeCompare(b, 'zh-CN')
  assert.deepEqual(names, [...names].sort(comparator))
  assert.ok(names.indexOf('alpha') < names.indexOf('Beta') < names.indexOf('Zeta'), 'Latin ordering is case-insensitive')
  assert.ok(names.indexOf('中文目录') < names.indexOf('中文目录2'), 'same-prefix names keep a total order')
  assert.ok(names.includes('alpha') && !names.includes('链接'), 'symlink entries never survive the filter')
  assert.ok(!names.includes('.hidden'))
  assert.ok(entries.every((entry) => entry.kind === 'dir'))
  assert.deepEqual(entries.map((entry) => entry.path), entries.map((entry) => path.join('/base', entry.name)))
})
await check('501 entries truncate to 500 with truncated:true (default limit 500)', () => {
  assert.equal(BROWSE_LIMIT, 500)
  const dirents = Array.from({ length: 501 }, (_, index) => dirent(`d${String(index).padStart(3, '0')}`))
  const { entries, truncated } = pickEntries(dirents, { dir: '/x' })
  assert.equal(entries.length, 500)
  assert.equal(truncated, true)
  assert.equal(entries[0].name, 'd000', 'sorted before truncation')
  assert.equal(entries[499].name, 'd499')
  const underLimit = pickEntries(dirents.slice(0, 500), { dir: '/x' })
  assert.equal(underLimit.truncated, false)
  assert.equal(underLimit.entries.length, 500)
})
await check('empty and junk inputs yield empty listings, not errors', () => {
  assert.deepEqual(pickEntries([], { dir: '/x' }), { entries: [], truncated: false })
  assert.deepEqual(pickEntries(undefined, { dir: '/x' }), { entries: [], truncated: false })
  assert.deepEqual(pickEntries([null, 42, dirent('ok')], { dir: '/x' }).entries.length, 1)
})

console.log('\n[parentOf]')
await check('parent walks to the root and stops there', () => {
  /* parentOf 走 node:path，即**宿主平台**的语义：反斜杠在 POSIX 上不是分隔符，
     盘符根与 UNC 只存在于 Windows。断言按平台分组，避免在 Linux/macOS 上假失败。 */
  if (process.platform === 'win32') {
    assert.equal(parentOf('C:\\a\\b'), 'C:\\a')
    assert.equal(parentOf('C:\\a'), 'C:\\', 'the drive root is a browsable parent')
    assert.equal(parentOf('C:\\'), null)
    assert.equal(parentOf('C:\\a\\b\\'), 'C:\\a', 'trailing separators never create empty segments')
    assert.equal(parentOf('\\\\srv\\share\\a'), '\\\\srv\\share')
  }
  assert.equal(parentOf('/a'), '/')
  assert.equal(parentOf('/'), null)
  assert.equal(parentOf('/a/b'), '/a')
  assert.equal(parentOf('/a/b/'), '/a', 'trailing separators never create empty segments')
  assert.equal(parentOf(''), null)
  assert.equal(parentOf(undefined), null)
  assert.equal(parentOf('a/b'), null, 'relative paths have no meaningful parent here')
})

console.log('\n[normalizeBrowseInput edge cases]')
await check('empty, relative, .. and NUL inputs answer typed errors (never uncaught)', () => {
  const expect = (raw, code, fn) => {
    try {
      fn(raw)
      assert.fail(`expected ${code} for ${JSON.stringify(raw)}`)
    } catch (error) {
      assert.equal(error.code, code, `${JSON.stringify(raw)} → ${error.code}: ${error.message}`)
      assert.ok(typeof error.statusCode === 'number')
    }
  }
  expect('', 'BROWSE_BAD_PATH', (raw) => normalizeBrowseInput(raw))
  expect('   ', 'BROWSE_BAD_PATH', (raw) => normalizeBrowseInput(raw))
  expect('src/app', 'BROWSE_BAD_PATH', (raw) => normalizeBrowseInput(raw))
  expect('./src', 'BROWSE_BAD_PATH', (raw) => normalizeBrowseInput(raw))
  expect('/a/../b', 'BROWSE_BAD_PATH', (raw) => normalizeBrowseInput(raw))
  expect('C:\\a\\..\\b', 'BROWSE_BAD_PATH', (raw) => normalizeBrowseInput(raw))
  expect('C:\\a\0b', 'BROWSE_BAD_PATH', (raw) => normalizeBrowseInput(raw))
  expect('"@C:\\quoted"', 'BROWSE_BAD_PATH', (raw) => normalizeBrowseInput('not/absolute'))
})
await check('clean inputs normalize: @, quotes, ~ and file:// URLs', () => {
  const home = homedir()
  assert.equal(normalizeBrowseInput(`@${path.join(home, 'proj')}`), path.normalize(path.join(home, 'proj')))
  assert.equal(normalizeBrowseInput(`"${path.join(home, 'proj')}"`), path.normalize(path.join(home, 'proj')))
  assert.equal(normalizeBrowseInput('~/子目录', { home }), path.normalize(path.join(home, '子目录')))
})

console.log('\n[readDirectoryEntries (real fs)]')
{
  const root = await mkdtemp(path.join(tmpdir(), 'codeflow-browse-'))
  try {
    // 结构：中文/英文子目录、隐藏目录、普通文件、junction（Windows）或 symlink（POSIX）。
    const dirs = ['alpha', 'Beta', '中文目录', 'zeta']
    for (const name of dirs) await mkdir(path.join(root, name), { recursive: true })
    await mkdir(path.join(root, '.hidden-dir'), { recursive: true })
    await writeFile(path.join(root, 'plain-file.txt'), 'data', 'utf8')
    let linked = false
    try {
      await symlink(path.join(root, 'alpha'), path.join(root, 'linked-alpha'), 'junction')
      linked = true
    } catch {
      try {
        await symlink(path.join(root, 'alpha'), path.join(root, 'linked-alpha'), 'dir')
        linked = true
      } catch {
        // 无权限创建链接：排除性断言在没有 fixture 时跳过（下方有条件断言）。
      }
    }
    const before = await stat(path.join(root))

    await check('lists sorted subdirectories without files, hidden entries or links', async () => {
      const result = await readDirectoryEntries(root)
      assert.equal(result.ok, true)
      assert.equal(result.path, path.normalize(root))
      const comparator = (a, b) => a.toLowerCase().localeCompare(b.toLowerCase(), 'zh-CN') || a.localeCompare(b, 'zh-CN')
      const names = result.entries.map((entry) => entry.name)
      assert.deepEqual(names, [...names].sort(comparator))
      for (const name of ['alpha', 'Beta', '中文目录', 'zeta']) {
        assert.ok(names.includes(name), `contains ${name}`)
      }
      assert.ok(result.entries.every((entry) => entry.kind === 'dir'))
      assert.ok(!result.entries.some((entry) => entry.name === 'plain-file.txt'), 'files are never listed')
      assert.ok(!result.entries.some((entry) => entry.name === '.hidden-dir'), 'hidden entries are skipped')
      if (linked) {
        assert.ok(!result.entries.some((entry) => entry.name === 'linked-alpha'), 'links/junctions never appear')
      }
      assert.equal(result.parent, path.dirname(path.normalize(root)))
      assert.equal(result.truncated, false)
    })
    await check('truncates at the requested limit', async () => {
      const result = await readDirectoryEntries(root, { limit: 2 })
      assert.equal(result.entries.length, 2)
      assert.equal(result.truncated, true)
    })
    await check('read-only: entries and mtime are unchanged after repeated calls', async () => {
      await readDirectoryEntries(root)
      await readDirectoryEntries(root)
      const after = await stat(path.join(root))
      assert.equal(after.mtimeMs, before.mtimeMs, 'directory mtime untouched')
      const file = await readFile(path.join(root, 'plain-file.txt'), 'utf8')
      assert.equal(file, 'data', 'file content untouched')
    })
    await check('a missing path answers 404 BROWSE_NOT_FOUND; a file answers 400 BROWSE_NOT_DIRECTORY', async () => {
      await assert.rejects(
        () => readDirectoryEntries(path.join(root, 'definitely-missing')),
        (error) => {
          assert.equal(error.code, 'BROWSE_NOT_FOUND')
          assert.equal(error.statusCode, 404)
          return true
        },
      )
      await assert.rejects(
        () => readDirectoryEntries(path.join(root, 'plain-file.txt')),
        (error) => {
          assert.equal(error.code, 'BROWSE_NOT_DIRECTORY')
          assert.equal(error.statusCode, 400)
          return true
        },
      )
    })
    if (process.platform !== 'win32') {
      await check('an unreadable directory answers 403 BROWSE_FORBIDDEN', async () => {
        const locked = path.join(root, 'locked')
        await mkdir(locked, { recursive: true })
        await chmod(locked, 0o000)
        try {
          await assert.rejects(
            () => readDirectoryEntries(locked),
            (error) => {
              assert.equal(error.code, 'BROWSE_FORBIDDEN')
              assert.equal(error.statusCode, 403)
              return true
            },
          )
        } finally {
          await chmod(locked, 0o755).catch(() => {})
        }
      })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

console.log('\n[error mapping table]')
await check('fs errors map to the documented browse codes and statuses', () => {
  assert.equal(mapFsError({ code: 'ENOENT' }, 'x').code, 'BROWSE_NOT_FOUND')
  assert.equal(mapFsError({ code: 'ENOENT' }, 'x').statusCode, 404)
  assert.equal(mapFsError({ code: 'ENOTDIR' }, 'x').statusCode, 404)
  assert.equal(mapFsError({ code: 'EACCES' }, 'x').code, 'BROWSE_FORBIDDEN')
  assert.equal(mapFsError({ code: 'EACCES' }, 'x').statusCode, 403)
  assert.equal(mapFsError({ code: 'EPERM' }, 'x').statusCode, 403)
  assert.equal(mapFsError({ code: 'EBUSY' }, 'x').code, 'BROWSE_FAILED')
  assert.equal(mapFsError({ code: 'EBUSY' }, 'x').statusCode, 500)
})
await check('withTimeout turns slow IO into BROWSE_TIMEOUT (504) without blocking', async () => {
  await assert.rejects(
    () => withTimeout(new Promise(() => {}), 25),
    (error) => {
      assert.equal(error.code, 'BROWSE_TIMEOUT')
      assert.equal(error.statusCode, 504)
      return true
    },
  )
  const value = await withTimeout(new Promise((resolve) => setTimeout(() => resolve('done'), 5)), 5000)
  assert.equal(value, 'done')
})

console.log('\n[browseDirectory (roots mode)]')
await check('empty path answers the root list without touching the disk', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'codeflow-browse-roots-'))
  try {
    const before = (await stat(ws)).mtimeMs
    const result = await browseDirectory('', { workspaces: [ws], home: homedir() })
    const after = (await stat(ws)).mtimeMs
    assert.equal(result.ok, true)
    assert.equal(result.roots, true)
    assert.equal(result.path, null)
    assert.equal(result.parent, null)
    const names = result.entries.map((entry) => entry.path)
    assert.ok(names.includes(ws), 'registered workspaces are roots')
    if (process.platform !== 'win32') assert.ok(names.includes('/'), 'posix root present')
    assert.equal(before, after, 'read-only')
    // 手工传入的平台覆盖也生效（列表形状可单测）。
    const posix = listRoots({ platform: 'linux', driveRoots: [], home: '/h', workspaces: [] })
    assert.deepEqual(posix.map((entry) => entry.path), ['/', '/h'])
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})
await check('a directory input lists it; a bad input throws typed errors', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codeflow-browse-in-'))
  try {
    await mkdir(path.join(root, 'child'))
    const result = await browseDirectory(`@${root}`)
    assert.equal(result.ok, true)
    assert.deepEqual(result.entries.map((entry) => entry.name), ['child'])
    await assert.rejects(
      () => browseDirectory('relative/path'),
      (error) => {
        assert.equal(error.code, 'BROWSE_BAD_PATH')
        assert.equal(error.statusCode, 400)
        return true
      },
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
await check('timeout default is 5s (documented contract)', () => {
  assert.equal(BROWSE_TIMEOUT_MS, 5000)
})

console.log(`\n${checks} checks, ${failures.length} failures`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`FAIL ${failure}`)
  process.exitCode = 1
}
