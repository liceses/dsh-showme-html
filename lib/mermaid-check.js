/**
 * 页面里 mermaid 源码的**语法预检**（Node 侧，同步）。
 *
 * 为什么要在宿主里跑：`show_html` 想"页面不通过就直接失败"，就必须在**返回之前**
 * 知道图有没有写错。浏览器那边要等卡片渲染完才知道，太晚了 —— 工具调用那时已经返回。
 *
 * 怎么做到的：把 `vendor/mermaid.min.js` 喂进 `node:vm`，让 mermaid 自己的 parser
 * 跑起来。唯一卡点是 `Z1=Rsr()`（`createDOMPurify()` 的返回值）：没有真 DOM 时
 * dompurify 会退化成空壳，流程图一解析就抛 `TypeError: Z1.addHook is not a function`。
 * 所以**只在内存里**把这一处换成 stub（见 `vendor/README.md`），磁盘文件不动 ——
 * 浏览器拿到的仍是原版。
 *
 * 代价：首次加载 ~150 ms（每进程一次），之后每块 5–50 ms。
 *
 * 它只做语法解析：不渲染、不净化、不产生 HTML。所以把 DOMPurify 换成 no-op 是安全的。
 */

import { readFileSync } from 'node:fs'
import vm from 'node:vm'

/** vendored bundle（浏览器用同一份）。 */
const BUNDLE_URL = new URL('../vendor/mermaid.min.js', import.meta.url)

/**
 * 补丁点：`createDOMPurify()` 的返回。
 *
 * 依赖打包产物形态 —— 升级 mermaid 时 `test/mermaid.test.mjs` 会先红
 * （断言这串在文件里正好命中 1 次），别默默放行。
 */
export const DOMPURIFY_PATCH_FROM = 'Z1=Rsr()'
export const DOMPURIFY_PATCH_TO =
  'Z1={addHook(){},removeHook(){},removeHooks(){},removeAllHooks(){},' +
  'sanitize:t=>t,setConfig(){},clearConfig(){},isSupported:!1,version:"3",removed:[]}'

/** 认领 mermaid 源码的标记：`class` 里有 `mermaid`，或带 `data-mermaid`。 */
const MARKER = /class\s*=\s*(?:"[^"]*\bmermaid\b[^"]*"|'[^']*\bmermaid\b[^']*')|data-mermaid\b/i

/** 找开标签，用来定位"这个元素到哪结束"。 */
const OPEN_TAG = /<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g

/** 空元素 / 自闭合，不该去找闭合标签。 */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

/** 页面里常见的实体（`<pre>` 里写 `<` 必须转义，否则 HTML 自己就坏了）。 */
const ENTITIES = new Map([
  ['lt', '<'], ['gt', '>'], ['amp', '&'], ['quot', '"'], ['apos', "'"], ['nbsp', ' '],
])

/**
 * 反转义 HTML 实体。
 * @param text - 元素里的原始文本。
 * @returns 还原成 mermaid 源码。
 */
function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return ENTITIES.get(body.toLowerCase()) ?? whole
  })
}

/**
 * 抽出页面里所有 mermaid 块。
 *
 * 支持的写法：
 * - `<pre class="mermaid">…</pre>`
 * - `<div class="mermaid">…</div>`
 * - `<code class="language-mermaid">…</code>`
 * - `<pre data-mermaid>…</pre>`
 *
 * @param html - 页面源码。
 * @returns `[{ index, tag, raw, source }]`，`index` 从 1 开始。
 */
export function extractMermaidBlocks(html) {
  const blocks = []
  if (typeof html !== 'string' || html.length === 0) return blocks

  OPEN_TAG.lastIndex = 0
  let match
  while ((match = OPEN_TAG.exec(html)) !== null) {
    const [whole, tag, attrs] = match
    if (!MARKER.test(attrs)) continue
    const selfClosing = whole.endsWith('/>') || VOID_TAGS.has(tag.toLowerCase())
    if (selfClosing) continue

    const bodyStart = match.index + whole.length
    const closeAt = html.toLowerCase().indexOf(`</${tag.toLowerCase()}>`, bodyStart)
    if (closeAt < 0) continue

    const raw = html.slice(bodyStart, closeAt)
    blocks.push({
      index: blocks.length + 1,
      tag: tag.toLowerCase(),
      raw,
      source: decodeEntities(raw).trim(),
    })
    OPEN_TAG.lastIndex = closeAt
  }

  return blocks
}

/**
 * 判断页面里有没有 mermaid 块（路由注入用的便宜版本）。
 * @param html - 页面源码。
 * @returns 有则 true。
 */
export function hasMermaidBlocks(html) {
  return extractMermaidBlocks(html).length > 0
}

/**
 * 造一个"够 mermaid 解析用"的假 DOM。
 *
 * 只满足 parser 会碰到的几个面：元素工厂、`documentElement/body/head`、
 * `querySelector` 一律 miss。真渲染用的 DOM 在浏览器那边，这里不做。
 */
function makeElement() {
  return {
    nodeType: 1,
    style: {},
    innerHTML: '',
    outerHTML: '',
    textContent: '',
    childNodes: [],
    children: [],
    firstChild: null,
    nextSibling: null,
    classList: { add() {}, remove() {}, contains: () => false },
    setAttribute() {},
    getAttribute() { return null },
    hasAttribute() { return false },
    removeAttribute() {},
    appendChild() {},
    removeChild() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0 }),
  }
}

function makeDocument() {
  const element = makeElement
  return {
    nodeType: 9,
    createElement: element,
    createElementNS: element,
    createTextNode: element,
    createDocumentFragment: element,
    documentElement: element(),
    body: element(),
    head: element(),
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    addEventListener() {},
    removeEventListener() {},
  }
}

/** 加载结果缓存：成功存 `{ mermaid }`，失败存 `{ reason }`（不重试，免得每次调用都白等）。 */
let loading

/**
 * 懒加载 mermaid 解析器（每进程一次）。
 * @returns `{ mermaid } | { reason }`。
 */
async function loadMermaid() {
  if (loading) return loading

  loading = (async () => {
    let source
    try {
      source = readFileSync(BUNDLE_URL, 'utf8')
    } catch (error) {
      return { reason: `读不到 vendor/mermaid.min.js：${error.message}` }
    }

    const hits = source.split(DOMPURIFY_PATCH_FROM).length - 1
    if (hits !== 1) {
      // fail-open：校验器坏了不该挡住页面交付，但要把原因说清楚。
      return { reason: `补丁点在 mermaid.min.js 里命中 ${hits} 次（应为 1）—— 版本变了？` }
    }
    const patched = source.replace(DOMPURIFY_PATCH_FROM, DOMPURIFY_PATCH_TO)

    const sandbox = {
      setTimeout, clearTimeout, setInterval, clearInterval,
      URL, TextEncoder, TextDecoder, structuredClone, performance,
      Promise, Math, Date, JSON, RegExp, Map, Set, WeakMap, WeakSet,
      Array, Object, String, Number, Boolean, Error, TypeError, RangeError,
      Symbol, parseInt, parseFloat, isNaN, isFinite,
      encodeURIComponent, decodeURIComponent,
      atob: (value) => Buffer.from(value, 'base64').toString('binary'),
      btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
      // mermaid 在失败路径上会 console.error，宿主里不该污染工具输出。
      console: { log() {}, warn() {}, error() {}, info() {}, debug() {}, trace() {} },
    }
    sandbox.globalThis = sandbox
    sandbox.self = sandbox
    sandbox.window = sandbox
    sandbox.document = makeDocument()
    sandbox.navigator = { userAgent: 'node' }
    sandbox.location = { href: 'http://localhost/', origin: 'http://localhost' }
    sandbox.addEventListener = () => {}
    sandbox.removeEventListener = () => {}

    try {
      vm.createContext(sandbox)
      vm.runInContext(patched, sandbox, { filename: 'mermaid.min.js', timeout: 20_000 })
    } catch (error) {
      return { reason: `mermaid 在 vm 里加载失败：${error.message}` }
    }

    const mermaid = sandbox.mermaid
    if (!mermaid || typeof mermaid.parse !== 'function') {
      return { reason: 'mermaid 加载后没有 parse()' }
    }
    return { mermaid }
  })()

  return loading
}

/**
 * 猜一下这块是什么图（失败时也想知道是哪类写法出的错）。
 * @param mermaid - 已加载的 mermaid。
 * @param source - mermaid 源码。
 * @returns 图类型名，猜不到则 null。
 */
function guessType(mermaid, source) {
  try {
    if (typeof mermaid.detectType === 'function') {
      const type = mermaid.detectType(source)
      if (typeof type === 'string' && type) return type
    }
  } catch {
    // detectType 自己也会抛（认不出类型），当成"不知道"。
  }
  return null
}

/**
 * 预检页面里所有 mermaid 块。
 *
 * @param html - 页面源码。
 * @returns `{ checked, count, types, errors, reason? }`：
 *   - `checked:false` → 校验器没跑起来（fail-open），`reason` 说明原因；
 *   - `errors` 为空 → 全部通过。
 */
export async function checkMermaidBlocks(html) {
  const blocks = extractMermaidBlocks(html)
  if (blocks.length === 0) {
    return { checked: true, count: 0, types: [], errors: [] }
  }

  const loaded = await loadMermaid()
  if (!loaded.mermaid) {
    return { checked: false, count: blocks.length, types: [], errors: [], reason: loaded.reason }
  }

  const { mermaid } = loaded
  const types = []
  const errors = []

  for (const block of blocks) {
    try {
      const result = await mermaid.parse(block.source, {})
      const type = result?.diagramType ?? guessType(mermaid, block.source)
      types.push(type ?? null)
    } catch (error) {
      const message = String(error?.message ?? error).trim()
      types.push(guessType(mermaid, block.source))
      errors.push({
        index: block.index,
        type: guessType(mermaid, block.source),
        source: block.source,
        error: message,
      })
    }
  }

  return { checked: true, count: blocks.length, types, errors }
}

/**
 * 把预检结果拼成给 agent 看的报错文本。
 * @param result - `checkMermaidBlocks` 的返回值。
 * @param pageName - 页面文件名（写进抬头）。
 * @returns 多行中文说明，带 mermaid 原文报错。
 */
export function formatMermaidErrors(result, pageName) {
  const lines = [
    `页面 ${pageName} 里的 mermaid 有 ${result.errors.length} 处写错了，页面未通过：`,
  ]
  for (const item of result.errors) {
    const type = item.type ? `（${item.type}）` : ''
    lines.push('', `  第 ${item.index} 个图${type}：`, ...indent(item.error, '    '))
  }
  lines.push('', '改好再调一次 show_html —— 图没通过校验时页面不会展示。')
  return lines.join('\n')
}

/**
 * 给每行加前缀（保留 mermaid 报错里用 `^` 指着哪一列的排版）。
 * @param text - 原始文本。
 * @param prefix - 前缀。
 * @returns 加好前缀的文本。
 */
function indent(text, prefix) {
  return String(text).split('\n').map((line) => prefix + line)
}
