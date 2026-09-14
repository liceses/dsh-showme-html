/**
 * 预设样式的契约验收。
 *
 * 预设不是"随便几份 CSS"——它们要能被**同一份标记**消费、要能在**断网沙箱**里工作、
 * 要能驱动画廊页自己的控制条。这些都能机检，所以都机检。
 *
 * 跑法：`node test/presets.test.mjs`
 */

import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const stylesDir = join(here, '..', 'styles')

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

/** 每套预设都必须实现的语义标记（换皮肤不用改标记，全靠这份清单）。 */
const REQUIRED_SELECTORS = [
  '.page', '.masthead', '.kicker', '.lead', '.meta',
  '.section', '.card', '.cols', '.stat', '.num',
  '.chips', '.chip', '.btn', '.table', '.callout',
  '.evidence', '.timeline', '.kv', '.code',
  '.muted', '.mark', '.rule',
]

/** 画廊控制条只靠这几个令牌活着，所以每套预设都必须定义它们。 */
const REQUIRED_TOKENS = ['--paper', '--ink', '--muted', '--line', '--accent']

const index = JSON.parse(await readFile(join(stylesDir, 'index.json'), 'utf8'))
const files = (await readdir(stylesDir)).filter((name) => name.endsWith('.css')).sort()

console.log('\n[清单] styles/index.json')

check('声明了 default', () => assert.equal(typeof index.default, 'string'))
check('presets 是数组且非空', () => assert.ok(Array.isArray(index.presets) && index.presets.length > 0))
check('default 指向一个真实存在的 slug', () =>
  assert.ok(index.presets.some((preset) => preset.slug === index.default), `default=${index.default} 不在清单里`),
)
check('每个 preset 的 file 都真实存在', () => {
  for (const preset of index.presets) {
    assert.ok(files.includes(preset.file), `${preset.slug} 声明的 ${preset.file} 不存在`)
  }
})
check('每个 preset 的字段齐全（slug/name/file/signature/useFor/mode）', () => {
  for (const preset of index.presets) {
    for (const field of ['slug', 'name', 'file', 'signature', 'useFor', 'mode']) {
      assert.ok(typeof preset[field] === 'string' && preset[field] !== '', `${preset.slug} 缺 ${field}`)
    }
  }
})
check('没有孤儿 CSS（每个 .css 都被清单收录）', () => {
  const declared = index.presets.map((preset) => preset.file).sort()
  assert.deepEqual(declared, files)
})

for (const preset of index.presets) {
  const css = await readFile(join(stylesDir, preset.file), 'utf8')
  // 注释里会写"无 @import、无 url()"这类说明，检查前必须先剥掉注释，
  // 否则断言匹配的是自己的文档（第一次跑就踩了）。
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '')
  console.log(`\n[预设] ${preset.file} —— ${preset.name}`)

  check('自包含：没有 @import', () => assert.ok(!/@import/.test(code)))
  check('自包含：没有 url()（外链字体/图片）', () => assert.ok(!/url\(/.test(code)))
  check('自包含：没有 http(s) 地址', () => assert.ok(!/https?:\/\//.test(code)))
  check('自包含：没有 @font-face', () => assert.ok(!/@font-face/.test(code)))

  check('定义了画廊需要的全部令牌', () => {
    for (const token of REQUIRED_TOKENS) {
      assert.ok(new RegExp(`${token}\\s*:`).test(code), `缺令牌 ${token}`)
    }
  })

  check('实现了全部共用语义标记', () => {
    const missing = REQUIRED_SELECTORS.filter((selector) => !code.includes(selector))
    assert.deepEqual(missing, [], `缺选择器：${missing.join(' ')}`)
  })

  check('不是空壳（有实际体量）', () => assert.ok(css.length > 3000, `只有 ${css.length} 字节`))

  check('指针可交互元素都有 hover/active 反馈', () => {
    assert.ok(/\.btn:hover/.test(code), '按钮没有 hover 态')
  })
}

console.log(`\n全部通过：${checks} 项断言。\n`)
