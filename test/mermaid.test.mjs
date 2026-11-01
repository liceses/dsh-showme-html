/**
 * mermaid 相关的离线验收：**抽块 / 反转义 / 宿主侧语法预检 / 补丁点 / 引导脚本**。
 *
 * 这一份盯的是"页面为什么会因为一张图而不通过"那条链路：
 *
 *  - `extractMermaidBlocks` 认不认得出页面里的图（漏认 = 图写错了也没人拦）；
 *  - `checkMermaidBlocks` 真的能解析（它把 vendored 的 mermaid 喂进 `node:vm`，
 *    靠一处内存补丁绕开"没有真 DOM"——见 `vendor/README.md`）；
 *  - 那处补丁点在**升级 mermaid 时**还命中不命中（命中不了会先在这里红）。
 *
 * 跑法：`node test/mermaid.test.mjs`（或 `npm test`）。
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DOMPURIFY_PATCH_FROM,
  checkMermaidBlocks,
  extractMermaidBlocks,
  formatMermaidErrors,
  hasMermaidBlocks,
} from '../lib/mermaid-check.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** 断言计数，跑完打印。 */
let checks = 0
/**
 * 断言包装（带计数与逐条输出）。
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

console.log('\n[mermaid] 抽块')

check('认 <pre class="mermaid">', () => {
  const blocks = extractMermaidBlocks('<pre class="mermaid">graph TD; A-->B</pre>')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].tag, 'pre')
  assert.equal(blocks[0].source, 'graph TD; A-->B')
})

check('认 <div class="mermaid">', () => {
  assert.equal(extractMermaidBlocks('<div class="mermaid">pie\n  "a" : 1</div>').length, 1)
})

check('认 <code class="language-mermaid">', () => {
  assert.equal(extractMermaidBlocks('<code class="language-mermaid">graph TD; A-->B</code>').length, 1)
})

check('认 <pre data-mermaid>', () => {
  assert.equal(extractMermaidBlocks('<pre data-mermaid>graph TD; A-->B</pre>').length, 1)
})

check('不误认普通 pre / code', () => {
  assert.equal(hasMermaidBlocks('<pre><code>const a = 1</code></pre>'), false)
})

check('多块按出现顺序编号（从 1 开始）', () => {
  const html = [
    '<pre class="mermaid">graph TD; A-->B</pre>',
    '<div class="mermaid">sequenceDiagram\n  A->>B: hi</div>',
  ].join('\n')
  const blocks = extractMermaidBlocks(html)
  assert.deepEqual(blocks.map((block) => block.index), [1, 2])
})

check('嵌套写法只算外面那一块', () => {
  const html = '<pre class="mermaid"><code class="language-mermaid">graph TD; A-->B</code></pre>'
  assert.equal(extractMermaidBlocks(html).length, 1)
})

check('没有闭合标签的块会被跳过（不把整页当成源码）', () => {
  assert.equal(extractMermaidBlocks('<pre class="mermaid">graph TD; A-->B').length, 0)
})

check('反转义 HTML 实体（<pre> 里的 < 必须写成 &lt;）', () => {
  const blocks = extractMermaidBlocks('<pre class="mermaid">graph TD; A["&lt;b&gt;x&lt;/b&gt;"] --&gt; B</pre>')
  assert.equal(blocks[0].source, 'graph TD; A["<b>x</b>"] --> B')
})

check('数字实体也认', () => {
  const blocks = extractMermaidBlocks('<pre class="mermaid">A&#45;&#45;&gt;B</pre>')
  assert.equal(blocks[0].source, 'A-->B')
})

console.log('\n[mermaid] 语法预检')

const goodCases = [
  ['流程图', 'graph TD; A[开始] --> B{判断}; B -->|是| C[结束]', 'flowchart-v2'],
  ['时序图', 'sequenceDiagram\n  A->>B: hi', 'sequence'],
  ['类图', 'classDiagram\n  A <|-- B', 'classDiagram'],
  ['状态图', 'stateDiagram-v2\n  [*] --> A', 'stateDiagram'],
  ['ER 图', 'erDiagram\n  A ||--o{ B : has', 'er'],
  ['饼图', 'pie title X\n  "a" : 1', 'pie'],
  ['甘特图', 'gantt\n  title A\n  section S\n  task :a1, 2024-01-01, 3d', 'gantt'],
  ['脑图', 'mindmap\n  root\n    a', 'mindmap'],
]

for (const [label, source, expectedType] of goodCases) {
  const result = await checkMermaidBlocks(`<pre class="mermaid">${source}</pre>`)
  check(`${label}：解析通过且认出类型 ${expectedType}`, () => {
    assert.equal(result.checked, true)
    assert.deepEqual(result.errors, [])
    assert.equal(result.types[0], expectedType)
  })
}

const bad = await checkMermaidBlocks('<pre class="mermaid">graph TD; A--></pre>')
check('坏图：报出 Parse error 原文', () => {
  assert.equal(bad.errors.length, 1)
  assert.match(bad.errors[0].error, /Parse error on line 2/)
})
check('坏图：报错里带着指位的 ^', () => assert.match(bad.errors[0].error, /-+\^/))
check('坏图：仍然认得出是哪类图（便于定位）', () => assert.equal(bad.errors[0].type, 'flowchart-v2'))

const nonsense = await checkMermaidBlocks('<pre class="mermaid">这不是一张图</pre>')
check('认不出图类型时也有明确报错', () =>
  assert.match(nonsense.errors[0].error, /No diagram type detected/),
)

const empty = await checkMermaidBlocks('<p>没有图</p>')
check('页面里没有 mermaid → count 0，不加载解析器', () => {
  assert.equal(empty.count, 0)
  assert.deepEqual(empty.errors, [])
  assert.equal(empty.checked, true)
})

const message = formatMermaidErrors(bad, '.dsh/showme/x.html')
check('报错文本带页面名 / 序号 / 图类型 / 原文', () => {
  assert.match(message, /\.dsh\/showme\/x\.html/)
  assert.match(message, /第 1 个图（flowchart-v2）/)
  assert.match(message, /Parse error on line 2/)
  assert.match(message, /改好再调一次 show_html/)
})

console.log('\n[mermaid] vendored 产物与引导脚本')

const bundle = await readFile(join(root, 'vendor', 'mermaid.min.js'), 'utf8')
check('vendor/mermaid.min.js 在仓库里（5 MB 级）', () => assert.ok(bundle.length > 1_000_000))
check('末尾把自己挂成全局（普通脚本，不是 ESM）', () =>
  assert.match(bundle.slice(-160), /globalThis\["mermaid"\]/),
)
check(`补丁点在仓库里正好命中 1 次（升级 mermaid 时这里会先红）`, () => {
  const hits = bundle.split(DOMPURIFY_PATCH_FROM).length - 1
  assert.equal(hits, 1, `期望 1 次，实际 ${hits} 次`)
})

const boot = await readFile(join(root, 'lib', 'mermaid-boot.js'), 'utf8')
check('引导脚本：会 render 并回传回执', () => {
  assert.match(boot, /mermaid\.render/)
  assert.match(boot, /dsh-showme-mermaid/)
  assert.match(boot, /postMessage/)
})
check('引导脚本：关掉 htmlLabels（否则 PNG 导不出来）', () =>
  assert.match(boot, /htmlLabels:\s*false/),
)
check('引导脚本：防重复注入', () => assert.match(boot, /__showmeMermaidBoot/))
check('引导脚本：从同源 vendor 路由取 mermaid', () =>
  assert.match(boot, /\/api\/showme\/vendor\/mermaid\.min\.js/),
)
check('引导脚本：不自己拼 CDN 地址', () => assert.ok(!/cdn\.|unpkg|jsdelivr/i.test(boot)))

// ── collect() 的真结构验证 ───────────────────────────────────────────
// 这里踩过一次：判据写成 `parentElement.closest(sel) !== parentElement`，
// 而 `closest()` 会**连自己一起**匹配 —— 于是每个块的 parentElement 都命中了祖先链里的自己，
// 所有块被滤光，页面一片源码、也不报错（静态断言一条都看不出）。
// 所以把 collect() 抠出来，在一个只认这三种选择器的假 DOM 里真跑一遍。

/**
 * 从引导脚本源码里取出 `collect()`，装进一个假 `document` 里执行。
 * @param source - `lib/mermaid-boot.js` 全文。
 * @param nodes - 假节点数组（`document.querySelectorAll` 的返回值）。
 * @returns collect 的结果数组。
 */
function runCollect(source, nodes) {
  const body = source.match(/ {2}function collect\(\) \{[\s\S]*?\n {2}\}\n/)[0]
  const document = { querySelectorAll: () => nodes }
  // eslint-disable-next-line no-new-func —— 测的就是这段源码本身
  return new Function('document', `${body}\n  return collect`) (document)()
}

/**
 * 造一个假元素：只实现 collect 用到的两个面（`parentElement` / `closest`）。
 * `closest` 必须支持**逗号分隔的复合选择器** —— 引导脚本传的就是
 * `'.mermaid, [data-mermaid], code.language-mermaid'` 这一个串。
 * @param options - `{ tag, cls, dataMermaid, parent }`。
 * @returns 假元素。
 */
function fakeNode(options) {
  const tag = options.tag ?? 'div'
  const classes = (options.cls ?? '').split(/\s+/).filter(Boolean)
  const node = { tag, classes, dataMermaid: options.dataMermaid === true, parentElement: options.parent ?? null }
  node.matchesSelf = (selector) => {
    if (selector === '.mermaid') return classes.includes('mermaid')
    if (selector === '[data-mermaid]') return node.dataMermaid
    if (selector === 'code.language-mermaid') return tag === 'code' && classes.includes('language-mermaid')
    return false
  }
  node.closest = (selector) => {
    const parts = selector.split(',').map((one) => one.trim())
    let cursor = node
    while (cursor !== null) {
      if (parts.some((one) => cursor.matchesSelf(one))) return cursor
      cursor = cursor.parentElement
    }
    return null
  }
  return node
}

const bodyNode = fakeNode({ tag: 'body' })

check('collect：普通块没有被自己的祖先滤掉（曾经的全灭 bug）', () => {
  const outer = fakeNode({ tag: 'pre', cls: 'mermaid', parent: bodyNode })
  const got = runCollect(boot, [outer])
  assert.deepEqual(got, [outer])
})

check('collect：`<pre class="mermaid"><code class="language-mermaid">` 只取外层', () => {
  const outer = fakeNode({ tag: 'pre', cls: 'mermaid', parent: bodyNode })
  const inner = fakeNode({ tag: 'code', cls: 'language-mermaid', parent: outer })
  assert.deepEqual(runCollect(boot, [outer, inner]), [outer])
})

check('collect：同级多块全都要，`data-mermaid` 也认', () => {
  const one = fakeNode({ tag: 'pre', cls: 'mermaid', parent: bodyNode })
  const two = fakeNode({ tag: 'div', cls: 'mermaid', parent: bodyNode })
  const three = fakeNode({ tag: 'pre', dataMermaid: true, parent: bodyNode })
  assert.deepEqual(runCollect(boot, [one, two, three]), [one, two, three])
})

console.log(`\n全部通过：${checks} 项断言。\n`)
