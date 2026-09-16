/**
 * 模板内核的验收：把 `templates/core.js` 放进一个最小 DOM 桩里，喂三种形状的数据，
 * 检查它渲染出来的 HTML 与交互行为。
 *
 * 重点验三件"模型以前老做错"的事：
 *   ① 控件长在条目自己的卡片里（不是堆在末尾）—— skill §3.2
 *   ② 每次变化都 postMessage（默认通道）—— skill §4.1
 *   ③ 组句格式 <id> <判定词>[：备注] —— skill §3.1
 *
 * 跑法：`node test/templates.test.mjs`
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(join(here, '..', 'templates', 'core.js'), 'utf8')

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

/**
 * 造一个元素桩。
 * @param id - 元素 id。
 */
function makeElement(id) {
  return {
    id,
    innerHTML: '',
    value: '',
    textContent: '',
    handlers: {},
    attributes: {},
    addEventListener(type, handler) { this.handlers[type] = handler },
    getAttribute(name) { return name in this.attributes ? this.attributes[name] : null },
    setAttribute(name, value) { this.attributes[name] = String(value) },
    focus() {},
    select() {},
  }
}

/**
 * 在最小 DOM 桩上跑一次内核，返回渲染结果与消息记录。
 *
 * 注意：`script.src = x` 在真实浏览器里是**异步**触发 load/error 的，
 * 而内核正是先赋 src、再赋 onload —— 桩必须同样异步，否则回调打不到。
 *
 * @param shape - review / pick / report。
 * @param data - 数据文件内容（null 表示"数据文件不存在"）。
 * @param pageName - 页面文件名。
 */
async function run(shape, data, pageName = 'demo.html') {
  const elements = new Map()
  const messages = []
  const appended = []

  const document = {
    title: '',
    readyState: 'complete',
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id))
      return elements.get(id)
    },
    createElement(tag) {
      const element = makeElement(`<${tag}>`)
      // 内核只动态创建 <script>（加载数据）和 <style>
      Object.defineProperty(element, 'src', {
        set(value) {
          element.attributes.src = value
          queueMicrotask(() => {
            if (data === null) {
              if (element.onerror) element.onerror()
            } else {
              window.SHOWME = data
              if (element.onload) element.onload()
            }
          })
        },
        get() { return element.attributes.src },
      })
      return element
    },
    querySelectorAll: () => [],
    addEventListener: () => {},
    head: { appendChild: (element) => appended.push(element) },
  }

  const window = {
    parent: { postMessage: (message) => messages.push(message) },
    SHOWME_SHAPE: shape,
  }
  const location = { pathname: `/api/showme/raw/sid/.dsh/showme/${pageName}` }

  const context = vm.createContext({ window, document, location, navigator: {}, console, Object, Array, String })
  new vm.Script(source, { filename: 'core.js' }).runInContext(context)
  await new Promise((resolve) => setTimeout(resolve, 0))

  return {
    head: elements.get('sm-masthead'),
    content: elements.get('sm-content'),
    receipt: elements.get('sm-receipt'),
    out: elements.get('sm-out'),
    words: elements.get('sm-words'),
    messages,
    document,
  }
}

/** 从渲染出的 HTML 里切出某一个条目的片段。 */
function sliceItem(html, id) {
  const start = html.indexOf(`data-item="${id}"`)
  if (start === -1) return ''
  const next = html.indexOf('data-item="', start + 1)
  return html.slice(start, next === -1 ? undefined : next)
}

console.log('\n[形状] review —— 逐项表态')

const reviewResult = await run('review', {
  skin: 'swiss',
  kicker: '设计评审',
  title: '三个变体，挑一个',
  lead: '看看要不要改',
  meta: ['四套预设'],
  sections: [
    {
      heading: '候选',
      items: [
        { id: 'hero-v3', title: '第 3 版', desc: '蓝底', image: 'stills/a.png', caption: '图 1' },
        { id: 'hero-v4', title: '第 4 版', desc: '灰底' },
      ],
    },
  ],
})

check('报头渲染出来了', () => {
  assert.match(reviewResult.head.innerHTML, /三个变体，挑一个/)
  assert.match(reviewResult.head.innerHTML, /class="kicker"/)
})
check('数据里的 skin 改了 <link>', () => {
  assert.match(reviewResult.document.title, /三个变体/)
})
check('两个条目都渲染了', () => {
  assert.match(reviewResult.content.innerHTML, /data-item="hero-v3"/)
  assert.match(reviewResult.content.innerHTML, /data-item="hero-v4"/)
})
check('① 控件长在条目自己的卡片里（skill §3.2）', () => {
  const one = sliceItem(reviewResult.content.innerHTML, 'hero-v3')
  assert.match(one, /data-id="hero-v3"/, '条目里没有它的判定控件')
  assert.match(one, /class="sm-note"/, '条目里没有备注输入')
  assert.match(one, /stills\/a\.png/, '条目里没有它的图')
})
check('图有 max-height（避免整屏高图导致图与控件不同屏）', () =>
  assert.match(source, /\.sm-img\{[^}]*max-height:60vh/),
)
check('默认判动词是同意/要改/不要', () => {
  const one = sliceItem(reviewResult.content.innerHTML, 'hero-v3')
  for (const word of ['同意', '要改', '不要']) assert.ok(one.includes(word), `缺判定词 ${word}`)
})
check('收尾区有可选中复制的兜底 textarea', () => {
  assert.match(reviewResult.receipt.innerHTML, /<textarea id="sm-out" readonly/)
})
check('词表列了出来（skill §3.1）', () => {
  const words = reviewResult.words.innerHTML
  assert.ok(words.includes('同意') && words.includes('要改'))
})

console.log('\n[交互] 判定 → 组句 → postMessage')

// 模拟点一次「同意」
const content = reviewResult.content
content.handlers.click({
  target: {
    className: 'sm-btn',
    getAttribute: (name) => (name === 'data-id' ? 'hero-v3' : name === 'data-w' ? '同意' : null),
  },
})

check('② 组句格式是 <id> <判定词>（skill §3.1）', () =>
  assert.equal(reviewResult.out.value, 'hero-v3 同意'),
)
check('② 每次变化都 postMessage 给卡片（skill §4.1）', () => {
  const last = reviewResult.messages[reviewResult.messages.length - 1]
  assert.ok(last !== undefined, '一次 postMessage 都没发')
  assert.equal(last.type, 'dsh-showme-feedback')
  assert.equal(last.text, 'hero-v3 同意')
})
check('条目上打了已表态的标记', () =>
  assert.match(reviewResult.content.innerHTML, /data-item="hero-v3" data-done="0"/),
)

// 再点一次同一个词 → 取消
content.handlers.click({
  target: {
    className: 'sm-btn',
    getAttribute: (name) => (name === 'data-id' ? 'hero-v3' : name === 'data-w' ? '同意' : null),
  },
})
check('再点一次同一个判定词 = 取消', () => assert.equal(reviewResult.out.value, ''))

console.log('\n[形状] pick —— 从候选里挑')

const pickResult = await run('pick', {
  mode: 'single',
  question: '封面用哪一张',
  heading: '候选',
  candidates: [{ id: 'cover-a', title: 'A' }, { id: 'cover-b', title: 'B' }],
})

check('默认判动词是「选这个」', () => assert.match(pickResult.content.innerHTML, /选这个/))
check('单选模式标在按钮上', () => assert.match(pickResult.content.innerHTML, /data-mode="single"/))
check('控件同样长在候选卡片里', () => {
  const one = sliceItem(pickResult.content.innerHTML, 'cover-a')
  assert.match(one, /data-id="cover-a"/)
})

const pickContent = pickResult.content
pickContent.handlers.click({
  target: { className: 'sm-btn', getAttribute: (n) => (n === 'data-id' ? 'cover-a' : n === 'data-w' ? '选这个' : n === 'data-mode' ? 'single' : null) },
})
pickContent.handlers.click({
  target: { className: 'sm-btn', getAttribute: (n) => (n === 'data-id' ? 'cover-b' : n === 'data-w' ? '选这个' : n === 'data-mode' ? 'single' : null) },
})
check('单选：后选的顶掉先选的', () => assert.equal(pickResult.out.value, 'cover-b 选这个'))

console.log('\n[形状] report —— 图文汇报')

const reportResult = await run('report', {
  title: '架构说明',
  sections: [
    { heading: '数据流', blocks: [
      { type: 'text', text: '一段说明' },
      { type: 'image', src: 'stills/arch.svg', caption: '图 1' },
      { type: 'table', head: ['列'], rows: [['值']] },
      { type: 'callout', label: '结论', text: '所以这样' },
      { type: 'timeline', items: [{ title: '第一步', text: '做什么' }] },
      { type: 'kv', pairs: [['键', '值']] },
      { type: 'code', text: 'const a = 1' },
      { type: 'chips', items: ['甲', { text: '乙', accent: true }] },
      { type: 'stat', num: '42', text: '个' },
    ] },
    { heading: '不用回执的一节', sectionReceipt: false, blocks: [{ type: 'text', text: 'x' }] },
  ],
})

check('通用块都渲染了', () => {
  const html = reportResult.content.innerHTML
  for (const marker of ['<p>一段说明</p>', 'stills/arch.svg', '<table class="table">', 'class="callout"',
    '<ol class="timeline">', '<dl class="kv">', '<pre class="code">', 'class="chip accent"', 'class="stat"']) {
    assert.ok(html.includes(marker), `缺块：${marker}`)
  }
})
check('小节带一个轻回执（默认开）', () => {
  assert.match(reportResult.content.innerHTML, /data-item="sec-数据流"/)
  assert.match(reportResult.content.innerHTML, /没意见/)
})
check('sectionReceipt:false 的小节不带回执', () => {
  assert.ok(!/data-item="sec-不用回执的一节"/.test(reportResult.content.innerHTML))
})

console.log('\n[失败态] 数据文件不在时')

const missing = await run('review', null)
check('给出"没找到数据文件"与文件名', () => {
  assert.match(missing.content.innerHTML, /没找到数据文件/)
  assert.match(missing.content.innerHTML, /demo\.data\.js/)
})
check('说明里给出了怎么办', () => {
  assert.match(missing.content.innerHTML, /同名同目录/)
})

console.log('\n[约束] 沙箱里不能用的东西')

// 必须剥掉注释再查：头注释里写着"不依赖 localStorage"，否则匹配到的是自己的文档。
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

check('没有依赖 localStorage', () => assert.ok(!/localStorage/.test(code)))
check('没有 CDN / 外链字体 / url()', () => {
  assert.ok(!/https?:\/\//.test(code), '提到了外部地址')
  assert.ok(!/url\(/.test(code), '有 url()')
  assert.ok(!/@import/.test(code), '有 @import')
})

console.log(`\n全部通过：${checks} 项断言。\n`)
