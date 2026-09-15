/**
 * 浏览器半区的离线验收：不启动 GUI，用 `node:vm` 把这个 closure-factory 脚本
 * 当作浏览器脚本加载（假的 `window.__ModuleLoader__` + 假的 `react` + 假的 DOM），
 * 然后验证：模块能装载、三处槽位注册正确、以及卡片/输入框那些**纯逻辑**没写错。
 *
 * 跑法：`node test/client-bundle.test.mjs`。
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(join(here, '..', 'lib', 'client.js'), 'utf8')

/** 断言计数。 */
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

// ── 假 react：createElement 造普通对象树；hooks 返回可用但惰性的值 ──
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}
const jsxRuntime = { jsx: React.createElement, jsxs: React.createElement, Fragment: 'Fragment' }

/**
 * 跨 realm 归一化：`vm` 里造出来的对象/数组带着另一个 realm 的原型，
 * `deepStrictEqual` 会因为原型不同而失败。结构比较前先过一遍 JSON。
 * @param value - vm 侧的值。
 */
function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

/** 记录加载器交出去的模块。 */
const loaded = { id: null, exports: null }
const fakeWindow = {
  __ModuleLoader__: {
    load: ({ id, factory }) => {
      loaded.id = id
      loaded.exports = factory((specifier) => {
        if (specifier === 'react') return React
        if (specifier === 'react/jsx-runtime') return jsxRuntime
        throw new Error(`unexpected require: ${specifier}`)
      })
    },
  },
  addEventListener: () => {},
  removeEventListener: () => {},
}

/** 记录注入的样式。 */
const styles = []
const fakeDocument = {
  createElement: () => ({ dataset: {}, textContent: '', remove: () => {} }),
  head: { appendChild: (element) => styles.push(element) },
}

const context = vm.createContext({ window: fakeWindow, document: fakeDocument, console })
new vm.Script(source, { filename: 'lib/client.js' }).runInContext(context)

console.log('\n[装载]')

check('加载器收到正确的包 id', () => assert.equal(loaded.id, 'dsh-showme-html'))
check('导出 apply 与 inject', () => {
  assert.equal(typeof loaded.exports.apply, 'function')
  assert.deepEqual(plain(loaded.exports.inject), ['slots'])
})

const plugin = loaded.exports
const internals = plugin.__internals

/** 记录槽位注册。 */
const injections = []
const registrations = []
const fakeCtx = {
  effect: (fn) => {
    const disposer = fn()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  slots: {
    inject: (name, callback) => {
      injections.push(name)
      callback()
    },
    register: (registration, component) => {
      registrations.push({ registration, component })
      return () => {}
    },
  },
}

plugin.apply(fakeCtx)

console.log('\n[槽位注册]')

check('注册了插件样式', () => {
  assert.ok(styles.length >= 1)
  assert.equal(styles[0].dataset.plugin, 'dsh-showme-html')
})
check('三处 inject 的目标槽位都对', () =>
  assert.deepEqual(injections, ['tool.call.toolview', 'shell.overlay', 'conversation.input.left']),
)
check('工具卡片绑在 show_html 这个 key 上', () => {
  const card = registrations.find((entry) => entry.registration.name === 'tool.call.toolview')
  assert.ok(card !== undefined, '没有注册 tool.call.toolview')
  assert.equal(card.registration.key, 'show_html')
  assert.equal(typeof card.component, 'function')
})
check('全屏浮层注册在 shell.overlay 且带 id', () => {
  const overlay = registrations.find((entry) => entry.registration.name === 'shell.overlay')
  assert.ok(overlay !== undefined, '没有注册 shell.overlay')
  assert.equal(overlay.registration.id, 'dsh-showme-html-fullscreen')
})
check('输入镜像座位注册在 conversation.input.left', () => {
  const input = registrations.find((entry) => entry.registration.name === 'conversation.input.left')
  assert.ok(input !== undefined, '没有注册 conversation.input.left')
  assert.equal(input.registration.id, 'dsh-showme-html-input')
})

// ── 输入面镜像：真契约是 ownerProps: []，草稿只能走 useInput 标准 prop ──
// 早期版本读 `props.input?.draft`（那个属性不存在）→ draft 永远空串 →
// 「填入输入框」变成替换草稿而不是追加。这一组就是那次现场回归。
console.log('\n[输入面镜像] 草稿从哪来')

const capture = registrations.find((entry) => entry.registration.name === 'conversation.input.left').component

/** 造一份该座位的标准 props。 */
function captureProps(draft, extra = {}) {
  let called = false
  const props = {
    sessionId: 'sess-9',
    inputActions: { setDraft: () => {} },
    useInput: (selector) => {
      called = true
      return selector({ draft })
    },
    ...extra,
  }
  return { props, wasCalled: () => called }
}

check('用 useInput 选择器读草稿', () => {
  internals.inputRefs.draft = ''
  const { props, wasCalled } = captureProps('我正在写别的')
  capture(props)
  assert.ok(wasCalled(), '没有调用 useInput')
  assert.equal(internals.inputRefs.draft, '我正在写别的')
  assert.equal(internals.inputRefs.sessionId, 'sess-9')
})

check('不再从 props.input 取值（真实契约里没有这个属性）', () => {
  internals.inputRefs.draft = ''
  const { props } = captureProps('', { input: { draft: '旧写法的值' } })
  capture(props)
  assert.equal(internals.inputRefs.draft, '', '不该读 props.input.draft')
})

check('缺 useInput 时草稿退化为空串而不是崩掉', () => {
  internals.inputRefs.draft = ''
  capture({ sessionId: 's', inputActions: null, useInput: () => undefined })
  assert.equal(internals.inputRefs.draft, '')
  assert.equal(internals.inputRefs.actions, null)
})

check('接上真草稿之后，「填入」是追加而不是替换（端到端）', () => {
  let written = null
  const { props } = captureProps('我先前写的话')
  props.inputActions = { setDraft: (text) => { written = text } }
  capture(props)
  internals.insertIntoComposer('pain-a 同意', null)
  assert.equal(written, '我先前写的话\npain-a 同意')
})

console.log('\n[纯逻辑] 镜像路由地址')

check('常规路径逐段编码、保留目录结构', () =>
  assert.equal(
    internals.rawUrl('sess-1', '.dsh/showme/review.html'),
    '/api/showme/raw/sess-1/.dsh/showme/review.html',
  ),
)
check('空格与中文被编码', () =>
  assert.equal(
    internals.rawUrl('s', '.dsh/showme/a b/图 1.png'),
    '/api/showme/raw/s/.dsh/showme/a%20b/%E5%9B%BE%201.png',
  ),
)
check('反斜杠被归一化（Windows 路径）', () =>
  assert.equal(internals.rawUrl('s', '.dsh\\showme\\a.html'), '/api/showme/raw/s/.dsh/showme/a.html'),
)
check('前导斜杠被吃掉，不产生空段', () =>
  assert.equal(internals.rawUrl('s', '/a/b.html'), '/api/showme/raw/s/a/b.html'),
)
check('sessionId 也被编码', () =>
  assert.equal(internals.rawUrl('a/b', 'x.html'), '/api/showme/raw/a%2Fb/x.html'),
)

console.log('\n[纯逻辑] 工具调用块解析')

check('running 形态：直接读 argsRaw', () => {
  const args = internals.readArgs({ callId: 'c1', name: 'show_html', argsRaw: '{"path":"a.html"}' })
  assert.deepEqual(plain(args), { path: 'a.html' })
})
check('settled 形态：从 block.call 读', () => {
  const args = internals.readArgs({ kind: 'tool-result', call: { name: 'show_html', argsRaw: '{"path":"b.html"}' } })
  assert.deepEqual(plain(args), { path: 'b.html' })
})
check('argsRaw 缺失或坏 JSON 都返回 null，不抛', () => {
  assert.equal(internals.readArgs({ kind: 'tool-result', call: null }), null)
  assert.equal(internals.readArgs({ kind: 'tool-result', call: { argsRaw: '{oops' } }), null)
  assert.equal(internals.readArgs(undefined), null)
})
check('结果文本只取 text 块', () =>
  assert.equal(
    internals.resultText({ content: [{ type: 'text', text: 'boom' }, { type: 'image' }] }),
    'boom',
  ),
)
check('basename 兼容两种分隔符', () => {
  assert.equal(internals.basename('.dsh/showme/a.html'), 'a.html')
  assert.equal(internals.basename('.dsh\\showme\\b.html'), 'b.html')
})

console.log('\n[纯逻辑] 反馈填进输入框')

check('空草稿：直接填', () => {
  internals.inputRefs.draft = ''
  internals.inputRefs.actions = { setDraft: (text) => { internals.inputRefs.draft = text } }
  assert.equal(internals.insertIntoComposer('f1 OK', null), true)
  assert.equal(internals.inputRefs.draft, 'f1 OK')
})
check('已有草稿：换行追加，不覆盖', () => {
  internals.inputRefs.draft = '我正在写别的'
  internals.inputRefs.actions = { setDraft: (text) => { internals.inputRefs.draft = text } }
  internals.insertIntoComposer('f1 OK', null)
  assert.equal(internals.inputRefs.draft, '我正在写别的\nf1 OK')
})
check('草稿以换行结尾：不再插空行', () => {
  internals.inputRefs.draft = '上文\n'
  internals.inputRefs.actions = { setDraft: (text) => { internals.inputRefs.draft = text } }
  internals.insertIntoComposer('f1 OK', null)
  assert.equal(internals.inputRefs.draft, '上文\nf1 OK')
})
check('没有输入面时回退到卡片自带的 actions', () => {
  internals.inputRefs.actions = null
  internals.inputRefs.draft = ''
  let written = null
  assert.equal(internals.insertIntoComposer('f2 要改', { setDraft: (text) => { written = text } }), true)
  assert.equal(written, 'f2 要改')
})
check('两处都没有：返回 false 而不是抛', () => {
  internals.inputRefs.actions = null
  assert.equal(internals.insertIntoComposer('x', undefined), false)
})

console.log('\n[卡片] 早退与错误态')

const card = registrations.find((entry) => entry.registration.name === 'tool.call.toolview').component

/** 在对象树里按深度优先找一个满足条件的元素。 */
function findElement(node, predicate) {
  if (node === null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElement(child, predicate)
      if (hit !== null) return hit
    }
    return null
  }
  if (predicate(node)) return node
  return findElement(node.children, predicate)
}

/** 把对象树里所有文本拼起来，便于断言"给用户看到的字"。 */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.children)
}

const noPathTree = card({ block: { kind: 'tool-result', call: { argsRaw: '{}' } }, sessionId: 's', openFile: () => {} })
check('缺少 path：给一句可行动的话，不白屏', () => {
  const text = textOf(noPathTree)
  assert.match(text, /没有带上有效的页面路径/)
})

const failedTree = card({
  block: {
    kind: 'tool-result',
    call: { name: 'show_html', argsRaw: '{"path":".dsh/showme/x.html","title":"评审"}' },
    isError: true,
    content: [{ type: 'text', text: 'show_html cannot find .dsh/showme/x.html in the workspace.' }],
  },
  sessionId: 's',
  openFile: () => {},
})
check('展示失败：把宿主的错误原文显示出来', () => {
  const text = textOf(failedTree)
  assert.match(text, /cannot find/)
  assert.match(text, /\.dsh\/showme\/x\.html/)
})

const okTree = card({
  block: {
    kind: 'tool-result',
    call: { name: 'show_html', argsRaw: '{"path":".dsh/showme/x.html","title":"评审","note":"挑一个"}' },
    isError: false,
    meta: { bytes: 2048 },
    content: [{ type: 'text', text: 'Already shown' }],
  },
  sessionId: 'sess-7',
  openFile: () => {},
})
check('正常态：头部有标题、体积、注释', () => {
  const text = textOf(okTree)
  assert.match(text, /评审/)
  assert.match(text, /2\.0 KB/)
  assert.match(text, /挑一个/)
})
check('正常态：先渲染占位（非可见不挂 iframe）', () => {
  const iframe = findElement(okTree, (element) => element.type === 'iframe')
  assert.equal(iframe, null)
  assert.match(textOf(okTree), /滚动到这里时载入页面/)
})
check('正常态：没有 meta.url 时回退到用 sessionId 自己拼', () => {
  const anchor = findElement(okTree, (element) => element.type === 'a' && element.props.className === 'dsh-showme-btn')
  assert.ok(anchor !== null, '没有找到"浏览器打开"链接')
  assert.equal(anchor.props.href, '/api/showme/raw/sess-7/.dsh/showme/x.html')
  assert.equal(anchor.props.target, '_blank')
  assert.equal(anchor.props.rel, 'noreferrer')
})

// 宿主算好的地址优先：即使客户端拿到的 sessionId 和宿主 session id 不是同一个字符串。
const hostUrlTree = card({
  block: {
    kind: 'tool-result',
    call: { name: 'show_html', argsRaw: '{"path":".dsh/showme/x.html"}' },
    isError: false,
    meta: { bytes: 10, url: '/api/showme/raw/host-side-id/.dsh/showme/x.html' },
    content: [],
  },
  sessionId: 'client-side-id',
  openFile: () => {},
})
check('有 meta.url 时优先用宿主算的地址', () => {
  const anchor = findElement(hostUrlTree, (element) => element.type === 'a' && element.props.className === 'dsh-showme-btn')
  assert.equal(anchor.props.href, '/api/showme/raw/host-side-id/.dsh/showme/x.html')
})
check('反馈类型常量与文档一致', () => assert.equal(internals.FEEDBACK_TYPE, 'dsh-showme-feedback'))

console.log(`\n全部通过：${checks} 项断言。\n`)
