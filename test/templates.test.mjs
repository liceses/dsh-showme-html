/**
 * 模板内核的验收：把 `templates/core.js` 放进一个最小 DOM 桩里，喂三种形状的数据，
 * 检查它渲染出来的 HTML 与交互行为。
 *
 * 重点验三件"模型以前老做错"的事：
 *   ① 控件和它指的对象在**同一块**里（带图才算卡，纯文字走行）—— skill §3.2
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
const softCss = await readFile(join(here, '..', 'styles', 'soft.css'), 'utf8')

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
 * @param options - `{ host }`：`'mirror'`（默认，镜像路由，地址里有文件名）、
 *   `'blob'`（原生文档预览那种 blob iframe，地址里只有 uuid）、
 *   `'static'`（数据由页面静态引入，内核不该再去取数据文件）。
 */
async function run(shape, data, pageName = 'demo.html', options = {}) {
  const elements = new Map()
  const messages = []
  const appended = []
  const host = options.host ?? 'mirror'
  const mirrorUrl = `http://127.0.0.1:19387/api/showme/raw/sid/.dsh/showme/${pageName}`
  const blobUrl = 'blob:http://127.0.0.1:19387/94d45dc1-3935-4e40-b3fc-57931b1d5350'
  const url = host === 'blob' ? blobUrl : mirrorUrl

  const document = {
    title: '',
    readyState: 'complete',
    // 真 document 一定有 baseURI；没有 <base> 时它就等于 location.href。
    baseURI: url,
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
    visibilityState: 'visible',
    addEventListener: () => {},
    head: { appendChild: (element) => appended.push(element) },
  }

  // 草稿通道要用：message 事件与 pagehide 得能被测试"发"进来。
  const listeners = new Map()
  const window = {
    parent: null,
    SHOWME_SHAPE: shape,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(handler)
    },
    removeEventListener(type, handler) {
      const list = listeners.get(type) ?? []
      const at = list.indexOf(handler)
      if (at >= 0) list.splice(at, 1)
    },
  }
  // 不在卡片里（浏览器直开）：window.parent === window。
  window.parent = options.standalone === true ? window : { postMessage: (message) => messages.push(message) }
  // 静态引入那条路：数据在 core.js 跑之前就已经在 window 上了。
  if (host === 'static') window.SHOWME = data

  const location = {
    href: url,
    protocol: host === 'blob' ? 'blob:' : 'http:',
    pathname: host === 'blob' ? '/94d45dc1-3935-4e40-b3fc-57931b1d5350' : `/api/showme/raw/sid/.dsh/showme/${pageName}`,
  }

  const context = vm.createContext({
    window, document, location, navigator: {}, console, Object, Array, String, setTimeout, clearTimeout,
  })
  new vm.Script(source, { filename: 'core.js' }).runInContext(context)
  await new Promise((resolve) => setTimeout(resolve, 0))

  /** 往页面里发一个事件（草稿通道靠它）。 */
  function emit(type, event) {
    for (const handler of listeners.get(type) ?? []) handler(event)
  }

  return {
    head: elements.get('sm-masthead'),
    content: elements.get('sm-content'),
    receipt: elements.get('sm-receipt'),
    out: elements.get('sm-out'),
    words: elements.get('sm-words'),
    emit,
    banner: () => elements.get('sm-banner')?.innerHTML ?? '',
    messages,
    document,
    appended,
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
check('图有高度上限（避免整屏高图把控件挤出视野）', () =>
  assert.match(source, /\.sm-img\{[^}]*max-height:360px/),
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

console.log('\n[密度] 纯文字走行，带图才发卡')

// 为什么值得几条测试：纯文字条目也一人一张卡时，整屏是"一模一样的卡片"，
// 没有焦点也没有分组（相似性原则被用反了）。规则：只有带图才发卡。
check('带图的条目渲染成卡片', () => {
  const html = reviewResult.content.innerHTML
  assert.match(html, /class="card sm-item" data-item="hero-v3"/, '带图的条目没成卡')
})
check('纯文字条目渲染成行，不再单独发卡', () => {
  const html = reviewResult.content.innerHTML
  assert.match(html, /class="sm-line" data-item="hero-v4"/, '纯文字条目没走行式布局')
  assert.doesNotMatch(html, /class="card sm-item" data-item="hero-v4"/, '纯文字条目又发了一张卡')
  assert.match(sliceItem(html, 'hero-v4'), /class="sm-note" data-id="hero-v4"/, '行里没有备注输入')
})
check('纯文字条目收进同一块面板', () =>
  assert.match(reviewResult.content.innerHTML, /class="sm-list"/),
)
check('判定按钮包在分段控件里（希克：三个固定选项）', () => {
  const one = sliceItem(reviewResult.content.innerHTML, 'hero-v3')
  assert.match(one, /class="sm-seg" role="group"/, '按钮没有分段控件包裹')
  assert.match(one, /aria-label="hero-v3 的判定"/, '分段控件没有可读的组名')
})

const mixed = await run('review', {
  title: '混排',
  sections: [{ heading: 'h', items: [
    { id: 'a-text', title: '甲', desc: '纯文字' },
    { id: 'b-img', title: '乙', image: 'stills/b.png' },
    { id: 'c-text', title: '丙' },
  ] }],
})
check('混排：卡片组排在前，文字行保持原顺序', () => {
  const html = mixed.content.innerHTML
  const card = html.indexOf('data-item="b-img"')
  const firstLine = html.indexOf('data-item="a-text"')
  const secondLine = html.indexOf('data-item="c-text"')
  assert.ok(card !== -1 && firstLine !== -1 && secondLine !== -1, '有条目没渲染')
  assert.ok(card < firstLine, '卡片组没有排在前面')
  assert.ok(firstLine < secondLine, '文字行没有保持原顺序')
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
check('回执区有进度提示，选完就往上走（目标梯度）', () => {
  assert.match(reviewResult.receipt.innerHTML, /id="sm-progress"/, '回执区没有进度元素')
  assert.equal(reviewResult.document.getElementById('sm-progress').textContent, '已表态 1 / 2')
})

console.log('\n[渲染回执] 页面告诉卡片"我出来了/我挂了"')

check('渲染成功：发一条 ok:true 的 dsh-showme-rendered', () => {
  const messages = reviewResult.messages.filter((message) => message.type === 'dsh-showme-rendered')
  assert.ok(messages.length >= 1, '一条渲染回执都没发')
  const last = messages[messages.length - 1]
  assert.equal(last.ok, true)
  assert.ok(last.ids >= 2, `可点名项数不对：${last.ids}`)
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
check('渲染失败：回执是 ok:false（卡片能据此报"渲染失败"）', () => {
  const messages = missing.messages.filter((message) => message.type === 'dsh-showme-rendered')
  assert.ok(messages.length >= 1, '失败时没有回执')
  const last = messages[messages.length - 1]
  assert.equal(last.ok, false)
  assert.equal(last.failed, true)
})

// ── 两条"宿主给不出文件名"与"静态引入"的现场回归（2026-09-26）──
// 现场：点「原生预览」把页面交给原生文档预览后，报"没找到数据文件：<blob uuid>.data.js"。
// 原因：原生文档预览把 HTML 塞进 blob iframe，地址里没有文件名。
// 内核不该把这件事说成"页面写错了"，而且静态引入的数据必须能直接吃。
console.log('\n[宿主差异] blob 宿主 vs 静态引入')

const blobHost = await run('review', null, 'demo.html', { host: 'blob' })
check('blob 宿主里不再甩锅给作者：说明是宿主给不了文件名', () => {
  const html = blobHost.content.innerHTML
  assert.match(html, /原生文档预览/)
  assert.match(html, /blob/)
  assert.match(html, /侧栏打开|浏览器打开/)
})
check('blob 宿主里不再吩咐作者去 write 那个 uuid 名字的数据文件', () => {
  assert.doesNotMatch(blobHost.content.innerHTML, /把数据写到/)
  assert.doesNotMatch(blobHost.content.innerHTML, /同名同目录/)
})

const staticHost = await run('review', { skin: 'soft', title: '静态引入', sections: [] }, 'demo.html', { host: 'static' })
check('数据静态引入时：不再去取数据文件（只注入了样式）', () => {
  const scripts = staticHost.appended.filter((element) => element.attributes?.src !== undefined)
  assert.equal(scripts.length, 0, '静态引入时内核还在动态取数据文件')
})
check('数据静态引入时：照样渲染出标题', () =>
  assert.match(staticHost.head.innerHTML, /静态引入/),
)

console.log('\n[文档] README 必须覆盖内核真正认的东西')

// 为什么值得一条测试：这份 README 是模型**唯一该读**的接口文档。
// 内核加了块类型而 README 没跟上，模型就会去读内核 —— 那正是要防的事
// （实测：有会话为了搞清"认哪些块类型"把 20KB 内核通读了一遍）。
const readme = await readFile(join(here, '..', 'templates', 'README.md'), 'utf8')
const implemented = [...new Set([...source.matchAll(/case '([a-z]+)':/g)].map((match) => match[1]))]

check('从内核源码里抽到了块类型', () => {
  assert.ok(implemented.length >= 8, `只抽到 ${implemented.length} 种：${implemented.join(' ')}`)
})
check('README 写全了每一种块类型（含示例）', () => {
  const missing = implemented.filter((type) => !readme.includes(`type: '${type}'`))
  assert.deepEqual(missing, [], `README 没写：${missing.join(' ')}`)
})
check('README 覆盖三个形状', () => {
  for (const shape of ['review', 'pick', 'report']) {
    assert.ok(readme.includes(`## \`${shape}\` 形状`), `README 没写 ${shape} 形状`)
  }
})
check('README 明确劝退读内核', () => assert.match(readme, /不是 `core\.js`/))
check('README 说了数据文件必须和页面同名', () => assert.match(readme, /必须和页面同名/))
check('内核头部也指向 README', () => assert.match(source, /别读这个文件/))

console.log('\n[草稿] 刷新 / 切会话不丢')

// 页面 boot 完要先给卡片打个招呼：卡片收到 ready 才去读草稿灌回来。
check('boot 时向卡片要一次草稿', () => {
  assert.ok(
    reviewResult.messages.some((message) => message.type === 'dsh-showme-draft-ready'),
    '没有发 ready，卡片不会回灌草稿',
  )
})

// 卡片把上次的状态灌回来（其中 ghost 这一页已经没有这个 id 了）。
reviewResult.emit('message', {
  data: {
    type: 'dsh-showme-draft-restore',
    state: {
      updatedAt: '2026-10-31T15:12:00.000Z',
      verdicts: { 'hero-v3': '同意', ghost: '不要' },
      notes: { 'hero-v4': '图太小' },
    },
  },
})

check('恢复：判定套回页面、组句重新算出来', () => {
  assert.equal(reviewResult.out.value, 'hero-v3 同意')
})
check('恢复：横幅写明时间与条数，并说明有对不上的 id', () => {
  const banner = reviewResult.banner()
  assert.match(banner, /已恢复/, '没有恢复横幅')
  assert.match(banner, /1 条/, '横幅没写恢复了几条')
  assert.match(banner, /这页已没有/, '没说清有对不上的 id')
})

// 改一条判定 → 400ms 后应该有一帧草稿发出去（含判定与备注）。
reviewResult.content.handlers.click({
  target: {
    className: 'sm-btn',
    getAttribute: (name) => (name === 'data-id' ? 'hero-v4' : name === 'data-w' ? '要改' : null),
  },
})
await new Promise((resolve) => setTimeout(resolve, 600))
const drafts = reviewResult.messages.filter((message) => message.type === 'dsh-showme-draft')

check('变化后把草稿 postMessage 给卡片（判定与备注都在）', () => {
  const last = drafts[drafts.length - 1]
  assert.ok(last !== undefined, '一帧草稿都没发')
  assert.equal(last.state.verdicts['hero-v4'], '要改')
  assert.equal(last.state.verdicts['hero-v3'], '同意')
  assert.equal(last.state.notes['hero-v4'], '图太小')
})

reviewResult.content.handlers.click({
  target: { id: 'sm-draft-clear', className: 'sm-draftClear', getAttribute: () => null },
})
await new Promise((resolve) => setTimeout(resolve, 20))
check('清空：页内清掉，并让卡片把草稿删掉', () => {
  assert.equal(reviewResult.out.value, '')
  const last = reviewResult.messages[reviewResult.messages.length - 1]
  assert.equal(last.type, 'dsh-showme-draft')
  assert.equal(last.clear, true)
})

const stranger = await run('review', {
  title: '换过一版',
  sections: [{ heading: 'h', items: [{ id: 'fresh', title: '新条目' }] }],
})
stranger.emit('message', {
  data: { type: 'dsh-showme-draft-restore', state: { verdicts: { ghost: '同意' }, notes: {} } },
})
check('草稿里的 id 一个都对不上：不套用、也不弹横幅', () => {
  assert.equal(stranger.out.value, '')
  assert.equal(stranger.banner(), '')
})

const standalone = await run('review', { title: '浏览器直开', sections: [] }, 'demo.html', { standalone: true })
check('不在卡片里（浏览器直开）：不发 ready、也不发草稿', () => {
  assert.ok(!standalone.messages.some((message) => message.type === 'dsh-showme-draft-ready'))
  assert.ok(!standalone.messages.some((message) => message.type === 'dsh-showme-draft'))
})

console.log('\n[doc] 纯文档形状：没有判定控件')

const docResult = await run('doc', {
  title: '一篇说明',
  sections: [{ heading: '一', intro: '引言**加重**', blocks: [{ type: 'text', text: '正文' }] }],
})
check('doc 页没有任何判定按钮', () => assert.ok(!docResult.content.innerHTML.includes('sm-btn')))
check('doc 页没有回执 textarea，只有「复制全文」', () => {
  assert.ok(!docResult.receipt.innerHTML.includes('id="sm-out"'), 'doc 页还在渲染回执输入框')
  assert.match(docResult.receipt.innerHTML, /sm-copy-doc/)
})
check('doc 页的行内 markdown 照常渲染', () => assert.match(docResult.content.innerHTML, /<strong>加重<\/strong>/))

console.log('\n[markdown] 行内渲染，结构交给块类型')

// 为什么值得测：数据里的 `**粗**` 以前会原样显示成星号。模板只认四种行内写法，
// 块级 md 一律不认（那部分由宿主的 show_html 预检报错指路）。
const mdReport = await run('report', {
  title: 'markdown 行内',
  sections: [{
    heading: 'h',
    blocks: [
      { type: 'text', text: '这是**粗体**与`代码`，还有[链接](https://e.com)。' },
      { type: 'text', text: '第一行\n第二行' },
      { type: 'text', text: '净增 3 * 2 = 6；a | b；5 > 3' },
      { type: 'text', text: '**<b>x</b>**' },
      { type: 'text', text: '[坏](javascript:alert(1))' },
      { type: 'text', plain: true, text: '**不该变粗**' },
      { type: 'table', head: ['列'], rows: [['**粗**']] },
    ],
  }],
})
const mdHtml = mdReport.content.innerHTML

check('**粗体** 渲染成 strong，页面上不再有星号', () => {
  assert.match(mdHtml, /<strong>粗体<\/strong>/)
  assert.ok(!mdHtml.includes('**粗体**'), '星号还在')
})
check('`代码` 渲染成 code', () => assert.match(mdHtml, /<code>代码<\/code>/))
check('链接带上 target 与 rel', () =>
  assert.match(mdHtml, /<a href="https:\/\/e\.com" target="_blank" rel="noopener noreferrer">链接<\/a>/),
)
check('换行渲染成 br', () => assert.match(mdHtml, /第一行<br>第二行/))
check('正文里的单个 * / | / > 不被误伤', () => {
  assert.match(mdHtml, /净增 3 \* 2 = 6；a \| b；5 &gt; 3/)
  assert.ok(!/<strong>净增/.test(mdHtml))
})
check('强调里夹 HTML 也不会变成节点', () => {
  assert.match(mdHtml, /<strong>&lt;b&gt;x&lt;\/b&gt;<\/strong>/)
  assert.ok(!mdHtml.includes('<b>x</b>'), '数据里的 <b> 被当成标签了')
})
check('javascript: 链接不渲染成 a', () => {
  assert.match(mdHtml, /\[坏\]\(javascript:alert\(1\)\)/)
  assert.ok(!/href="javascript/i.test(mdHtml), '危险 scheme 进了 href')
})
check('plain: true 的块保持原文', () => assert.match(mdHtml, /\*\*不该变粗\*\*/))
check('表格单元格也走行内渲染', () => assert.match(mdHtml, /<td><strong>粗<\/strong><\/td>/))

console.log('\n[皮肤] 节奏与分组（横屏用满宽度、去掉重复分隔线）')

check('soft 皮肤：小节标题不再画出那条下边框', () =>
  assert.doesNotMatch(softCss, /\.section > h2 \{[^}]*border-bottom/, '小节标题还带着下边框'),
)
check('soft 皮肤：小节间距收紧到 44px', () =>
  assert.match(softCss, /\.section \{ margin-top: 44px; \}/, '小节间距还是老值'),
)
check('soft 皮肤：横屏量宽放到 1120px', () =>
  assert.match(softCss, /--measure: 1120px;/, '还有 900px 的窄量宽'),
)
check('控件补了键盘焦点环（现在只有备注输入改边框）', () =>
  assert.match(source, /\.sm-btn:focus-visible,.sm-note:focus-visible\{outline:2px/, '没有 focus-visible 规则'),
)
check('窄屏：文字行折成一列、分段控件铺满', () => {
  assert.match(source, /@media \(max-width:760px\)\{\.sm-line\{grid-template-columns:1fr/, '窄屏没有把行折成一列')
  assert.match(source, /\.sm-btn\{flex:1\}/, '窄屏没有把按钮等分铺满')
})
check('横屏：报头走两栏（标题在左、元信息在右）', () =>
  assert.match(source, /@media \(min-width:900px\)\{\.masthead\{display:grid/, '报头没有两栏规则'),
)
check('已表态的条目描述降权（减弱占用的注意力）', () =>
  assert.match(source, /data-done="1"\] \.sm-desc\{opacity/, '没有「已完成」的降权样式'),
)

console.log('\n[散文兜底] 长描述折不塌行')

// 控件贴第一行：行是网格，垂直居中会让按钮飘到段落中间（用户截图里的症状）。
check('行内控件贴顶对齐，不再垂直居中', () => {
  assert.match(source, /\.sm-line\{display:grid;grid-template-columns:minmax\(0,1fr\) 296px;gap:18px;align-items:start/, '.sm-line 还是 center 对齐')
})
check('长描述默认折三行、带展开按钮样式', () => {
  assert.match(source, /\.sm-desc\.sm-clamped\{display:-webkit-box;-webkit-line-clamp:3/, '没有三行折行规则')
  assert.match(source, /\.sm-more\{cursor:pointer/, '没有「展开」按钮样式')
})
check('只有长于 90 字才折行、才渲染展开', () => {
  assert.match(source, /String\(item\.desc\)\.length > 90 \? ' sm-clamped'/, '折行条件不是按长度')
  assert.match(source, /length > 90 \? '<button class="sm-more"/, '展开按钮没有按长度门控')
})
check('「展开」只改展示，不碰回执状态', () => {
  const at = source.indexOf("closestByClass(target, 'sm-more')")
  assert.ok(at !== -1, '没有「展开」的处理分支')
  const body = source.slice(at, at + 500)
  assert.ok(!/toggle\(/.test(body), '「展开」调用了 toggle')
  assert.ok(!/state\[/.test(body), '「展开」动到了回执状态')
  assert.match(body, /classList\.remove\('sm-clamped'\)/, '「展开」没有去掉折行')
})
check('点击用就近上溯找按钮（按钮里嵌了 span，直接看 target 会点不动）', () => {
  assert.match(source, /function closestByClass\(node, name\)/, '没有 closestByClass')
  assert.match(source, /var button = closestByClass\(target, 'sm-btn'\)/, '判定按钮没走就近上溯')
  assert.match(source, /button\.getAttribute\('data-w'\)/, '上溯之后没把按钮当事件源')
})
console.log('\n[选项集] 条目内 A/B 挑一条')

// 复用 .sm-btn + data-id/data-w，判定在 state[id] 里只存一个词 → 互斥天然成立，
// toggle / 刷新 / 草稿通道零改动。这条守住「别自己另起一套状态」。
check('选项是 radiogroup，每个选项是 radio', () => {
  assert.match(source, /<div class="sm-opts" role="radiogroup" aria-label="/, '没有 radiogroup')
  assert.match(source, /class="sm-btn sm-opt" type="button" role="radio" aria-checked="false"/, '选项不是 radio')
})
check('选项复用判定机制：data-id + data-w，且不带 data-mode', () => {
  const at = source.indexOf('function optionsHtml')
  assert.ok(at !== -1, '没有 optionsHtml')
  const body = source.slice(at, at + 1600)
  assert.match(body, /data-id="/, '选项没有 data-id')
  assert.match(body, /data-w="/, '选项没有 data-w')
  assert.ok(!/data-mode/.test(body), '选项带了 data-mode（那是 pick 的跨条目单选）')
})
check('选项也带备注框（判定了还能补一句）', () => {
  const at = source.indexOf('function optionsHtml')
  const body = source.slice(at, at + 1800)
  assert.match(body, /class="sm-note" data-id="/, '选项之后没有备注框')
})
check('aria-checked 跟着状态刷新（radio 的无障碍语义）', () => {
  const at = source.indexOf('function refreshPressed')
  const body = source.slice(at, at + 700)
  assert.match(body, /indexOf\('sm-opt'\) !== -1/, '没有针对选项的分支')
  assert.match(body, /aria-checked/, '没有刷新 aria-checked')
})
check('只有带 options 的条目才用选项集，其余仍走页级判定', () => {
  assert.match(source, /hasOptions\(item\) \? optionsHtml\(item\) : controlHtml\(id, words, mode\)/, '分发不对')
  assert.match(source, /Array\.isArray\(item\.options\) && item\.options\.length > 0/, 'hasOptions 判据不对')
})
check('回执词表并进选项词（页级词不能冒充能填的词）', () => {
  assert.match(source, /optionWords\.push\(value\)/, '没有收集选项词')
  assert.match(source, /function wordsForChips/, '没有 wordsForChips')
  assert.match(source, /wordsForChips\(\)\.map/, 'chips 没用合并后的词表')
})
check('两张选项卡并排、选中靠边框与光晕（不靠换底色）', () => {
  assert.match(source, /\.sm-opts\{display:grid;grid-template-columns:1fr 1fr/, '选项不是两列网格')
  assert.match(source, /\.sm-btn\.sm-opt\[aria-pressed="true"\]\{[^}]*border-color:var\(--accent/, '选中态没有描边')
  assert.match(source, /@media \(max-width:820px\)\{\.sm-opts\{grid-template-columns:1fr\}\}/, '窄屏没有回一列')
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
