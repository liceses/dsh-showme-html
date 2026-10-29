/**
 * 包清单（package.json）的门禁。
 *
 * 这一份是给**宿主**读的，不是给人读的：`engines.dsh` 决定 DSH 装不装你，
 * `dsh.manifestVersion` / `dsh.bundle.patch` / `dsh.client` 决定装上去之后怎么挂。
 * 它们没有类型检查、没有运行时兜底 —— 写错的表现是「安装被拒」或「浏览器半区凭空消失」，
 * 两种都很难从日志反推到某一行的笔误。所以在这里钉死。
 *
 * 跑法：`node test/manifest.test.mjs`
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let checks = 0
/**
 * 断言包装。
 * @param label - 用例名。
 * @param fn - 断言体。
 */
function check(label, fn) {
  checks += 1
  try {
    fn()
    console.log(`  ok   ${label}`)
  } catch (error) {
    console.error(`  FAIL ${label}`)
    throw error
  }
}

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const changelog = await readFile(join(root, 'CHANGELOG.md'), 'utf8')

console.log('\n[清单] package.json')

/**
 * 声明的 DSH 兼容范围。
 *
 * 为什么是**两个版本线**：`^0.1.7-rc.1` 是移植时的宿主，`^0.2.1-rc.1` 是 2026-10-29 实测通过的宿主。
 * 为什么不能只写 `^0.2.0-rc.1`：DSH 用 `semver.satisfies(v, range, { includePrerelease: true })` 校验，
 * 而 `0.2.1-rc.2` 落在 `^0.2.0-rc.1` 里；但别的工具（不带 includePrerelease）会判 false ——
 * 两条线都写成显式 prerelease 起点，两种校验下都为真。改这一行之前，先把两个宿主都跑一遍。
 */
const EXPECTED_ENGINES_DSH = '^0.1.7-rc.1 || ^0.2.1-rc.1'

check('engines.dsh 就是实测过的那条范围（改动必须同步 CHANGELOG 与 README）', () =>
  assert.equal(pkg.engines?.dsh, EXPECTED_ENGINES_DSH),
)

check('dsh.manifestVersion = 1', () => assert.equal(pkg.dsh?.manifestVersion, 1))

check('dsh.bundle.patch 指向本次仓库里的补丁文件', () => {
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
})

check('dsh.client 声明了 platform: web 且 inject 为空（附加能力不拖核心功能）', () => {
  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.deepEqual(pkg.dsh?.client?.inject, [])
})

check('main / exports 指向真实入口（浏览器半区那个入口也要在）', () => {
  assert.equal(pkg.main, './lib/index.js')
  assert.equal(pkg.exports?.['.'], './lib/index.js')
  assert.equal(pkg.exports?.['./client'], './lib/client.js')
})

check('files 至少带着运行时要用的那几样', () => {
  for (const entry of ['lib', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md']) {
    assert.ok(pkg.files?.includes(entry), `files 里少了 ${entry}`)
  }
})

console.log('\n[版本] package.json vs CHANGELOG.md')

check('CHANGELOG 的顶部条目就是当前包版本', () => {
  const firstHeading = changelog.split('\n').find((line) => line.startsWith('## '))
  assert.ok(firstHeading, 'CHANGELOG.md 里没有 "## <version>" 条目')
  const declared = firstHeading.replace(/^##\s+/, '').split(/\s|—/)[0].trim()
  assert.equal(declared, pkg.version, `CHANGELOG 顶部是 ${declared}，package.json 是 ${pkg.version}`)
})

console.log(`\n全部通过：${checks} 项断言。\n`)
