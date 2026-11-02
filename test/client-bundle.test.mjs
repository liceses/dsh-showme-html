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
/**
 * 去掉注释后的源码。
 *
 * 静态门禁只该盯**代码**：本文件的注释里就写着「不注册 documentPreviews」
 * 「框架的 dsh-resource 地址」这类反例说明，拿原文件去断言会咬到自己。
 * @param text - 源码。
 * @returns 去掉块注释与行注释的文本。
 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}
const code = stripComments(source)

/** 断言计数。 */
let checks = 0
/** 异步用例（在文件末尾统一 await 收口）。 */
const asyncChecks = []
/**
 * 断言包装。用例体返回 thenable 时按异步用例登记，最后统一收口。
 * @param label - 用例名。
 * @param fn - 断言体。
 */
function check(label, fn) {
  checks += 1
  let result
  try {
    result = fn()
  } catch (error) {
    console.error(`  FAIL ${label}`)
    throw error
  }
  if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
    asyncChecks.push(
      result.then(
        () => console.log(`  ok   ${label}`),
        (error) => {
          console.error(`  FAIL ${label}`)
          throw error
        },
      ),
    )
    return
  }
  console.log(`  ok   ${label}`)
}

// ── 假 react：createElement 造普通对象树；hooks 返回可用但惰性的值 ──
// `useEffect` 只**收集**回调，不自动执行：同一份假 react 要同时服务「卡片」
// 与「全屏浮层」两组用例，自动跑副作用会把卡片的观察器也拉起来。
// 需要副作用真的跑一次的用例，自己调 runEffects()。
const pendingEffects = []
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: (fn) => {
    pendingEffects.push(fn)
  },
  useRef: () => ({ current: null }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}
const jsxRuntime = { jsx: React.createElement, jsxs: React.createElement, Fragment: 'Fragment' }

/**
 * 把挂起的副作用跑一遍，返回它们的清理函数。
 * @returns 清理函数数组。
 */
function runEffects() {
  const cleanups = []
  while (pendingEffects.length > 0) {
    const effect = pendingEffects.shift()
    const cleanup = effect()
    if (typeof cleanup === 'function') cleanups.push(cleanup)
  }
  return cleanups
}

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
/** 记录挂到 window / document 上的键盘监听（用来验证 Esc 通道）。 */
const keyListeners = { window: [], document: [] }
/** 记录挂到 window / document 上的 message 监听（顶层回执转发点在这里）。 */
const messageListeners = []
/** 记录 window.focus() 有没有被调用。 */
const focusCalls = { count: 0 }

/** 造一个记录型 event target。 */
function recordingTarget(bucket) {
  return {
    addEventListener: (type, fn, capture) => {
      if (type === 'keydown') bucket.push({ fn, capture })
      if (type === 'message') messageListeners.push(fn)
    },
    removeEventListener: (type, fn, capture) => {
      if (type === 'message') {
        const at = messageListeners.indexOf(fn)
        if (at >= 0) messageListeners.splice(at, 1)
        return
      }
      if (type !== 'keydown') return
      const at = bucket.findIndex((entry) => entry.fn === fn && entry.capture === capture)
      if (at >= 0) bucket.splice(at, 1)
    },
  }
}

/** 记录 window.open 的调用（P1 的兜底通道）。 */
const windowOpens = []

const windowTarget = recordingTarget(keyListeners.window)
const documentTarget = recordingTarget(keyListeners.document)

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
  addEventListener: windowTarget.addEventListener,
  removeEventListener: windowTarget.removeEventListener,
  // 浏览器里一定有这两个；"侧栏打开"要把镜像地址绝对化，靠的就是它们。
  location: { href: 'http://localhost/session/s' },
  focus: () => {
    focusCalls.count += 1
  },
  open: (url, target, features) => {
    windowOpens.push({ url, target, features })
    return null
  },
}

/** 记录注入的样式。 */
const styles = []
/**
 * 文档里"当前渲染着的 iframe"。回执来源核对要靠父文档读自己的 `src` 属性，
 * 所以桩里要有 `querySelectorAll('iframe')`；用例自己往里塞 frame。
 */
const documentFrames = []
const fakeDocument = {
  createElement: () => ({ dataset: {}, textContent: '', remove: () => {} }),
  head: { appendChild: (element) => styles.push(element) },
  querySelectorAll: (selector) => (selector === 'iframe' ? documentFrames : []),
  addEventListener: documentTarget.addEventListener,
  removeEventListener: documentTarget.removeEventListener,
}

/** 记录 bundle 发出的 HTTP 调用（草稿 / 反馈 / mermaid 回执 / 偏好 / HEAD）。 */
const fetchCalls = []
async function fakeFetch(url, options) {
  fetchCalls.push({ url, options })
  // 让"页面不存在"这条路径可测：URL 里带 missing 就回 404。
  if (typeof url === 'string' && url.includes('missing')) {
    return { ok: false, status: 404, json: async () => ({ ok: false }) }
  }
  return { ok: true, json: async () => ({ ok: true, draft: null, prefs: {} }) }
}

const context = vm.createContext({ window: fakeWindow, document: fakeDocument, console, URL, fetch: fakeFetch })
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
/** 记录 `ctx.inject([服务...])`（可选能力的接线，与槽位注入不是一回事）。 */
const serviceInjections = []
/** 记录右栏导航调用。 */
const openTabCalls = []
/** 记录 `uiConversation.events.register()` 收到的 Chat 行定义。 */
const chatRowRegistrations = []
/** 右栏导航入口：默认可用；用例可以临时拿掉它验证兜底。 */
const fakeSidebarRight = {
  openTab: (kind, options) => {
    openTabCalls.push({ kind, options })
  },
}
const fakeCtx = {
  effect: (fn) => {
    const disposer = fn()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  inject: (deps, callback) => {
    serviceInjections.push(deps)
    // 按服务名给对应能力：缺哪个就是"旧宿主没有这个服务"的现场。
    const scope = { effect: fakeCtx.effect, slots: fakeCtx.slots, sidebarRightTabs: fakeSidebarTabs, sidebarRight: fakeSidebarRight }
    if (deps.includes('uiConversation')) {
      scope.uiConversation = {
        events: {
          register: (definition) => {
            chatRowRegistrations.push(definition)
            return () => {}
          },
        },
      }
    }
    callback(scope)
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
/** 记录 tab 类型注册。 */
const tabTypeRegistrations = []
const fakeSidebarTabs = {
  register: (definition) => {
    tabTypeRegistrations.push(definition)
    return () => {}
  },
  get: () => undefined,
}

plugin.apply(fakeCtx)

console.log('\n[槽位注册]')

check('注册了插件样式', () => {
  assert.ok(styles.length >= 1)
  assert.equal(styles[0].dataset.plugin, 'dsh-showme-html')
})
check('注册的槽位都对（设置进了插件页，不再占原生设置弹窗）', () =>
  assert.deepEqual(injections, [
    'tool.call.toolview',
    'plugins.detail.section',
    'conversation.plan-review.actions',
    'shell.overlay',
    'conversation.input.left',
    'conversation.chat.node',
    'sidebar.right.pane.tab',
  ]),
)
check('右栏那两个服务是按「可选能力」接的，不在 exports.inject 里', () => {
  assert.deepEqual(plain(serviceInjections), [['uiConversation'], ['sidebarRightTabs', 'sidebarRight']])
  assert.deepEqual(plain(plugin.inject), ['slots'], '插件本体不该硬依赖右栏服务')
})
check('注册了右栏的**页类型**：自己的 kind，且不认领任何后缀', () => {
  assert.equal(tabTypeRegistrations.length, 1)
  const definition = tabTypeRegistrations[0]
  assert.equal(definition.id, internals.SIDEBAR_ID)
  assert.equal(definition.kind, internals.SIDEBAR_KIND)
  assert.equal(definition.multiple, true)
  assert.equal(definition.priority, 'builtin')
  assert.equal(typeof definition.title, 'function')
  // 页类型不认领地址：没有 patterns / canOpen，才不会跟原生文档预览抢文件
  assert.equal(definition.patterns, undefined)
  assert.equal(definition.canOpen, undefined)
})
check('正文注册在 sidebar.right.pane.tab，key = 实现 id', () => {
  const body = registrations.find((entry) => entry.registration.name === 'sidebar.right.pane.tab')
  assert.ok(body !== undefined, '没有注册 sidebar.right.pane.tab')
  assert.equal(body.registration.key, internals.SIDEBAR_ID)
  assert.equal(typeof body.component, 'function')
})
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

// 卡片本体：直接拿 `internals.ToolCard`（注册进 tool.call.toolview 的是 `ShowmeToolRow`，
// 它在新宿主上会退化成一行摘要 —— 摘要另有专测见文末"Chat 行"一节）。
const card = internals.ToolCard

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

// ── P0 边界：原生预览是 html 的默认归宿，本插件不许认领后缀 ──
// 计划文档里 P0 原本想要"运行时读 documentPreviews 注册表自检"。2026-09-26 在
// app.asar 里核实：这个服务只暴露 register()，**没有**任何读取面（注册表是闭包里的
// Map），所以运行时自检写不出来。改用静态门禁 + 行为门禁盯着这条边界。
console.log('\n[P0 边界] 不认领任何后缀')

check('客户端不注册、也不查询原生文档预览服务（所以不会抢 .html）', () => {
  // 断言的是**调用**而不是那个词（并按上面的 code 去掉注释）。
  assert.doesNotMatch(
    code,
    /documentPreviews\s*\.\s*register/,
    '有人开始注册原生文档预览了 —— 那会把 .html 的默认归宿从原生 builtin 上抢走。' +
      '真要做 P3，先在这里说清"只覆盖显式认领、且保住 builtin 默认"，再改这条断言。',
  )
  assert.doesNotMatch(code, /ctx\.get\(\s*['"]documentPreviews['"]\s*\)/)
})

check('自己不拼任何 dsh-resource:// 地址（那是框架的东西）', () => {
  assert.doesNotMatch(
    code,
    /dsh-resource:\/\//,
    '地址语法（dsh-resource://file/session/<sessionId>/<path>）属于框架，插件自己拼迟早拼错。',
  )
})

check('右栏 tab 类型是「页类型」：没有 patterns / canOpen，不认领文件地址', () => {
  const definition = tabTypeRegistrations[0]
  assert.equal(definition.patterns, undefined, '一旦给了 patterns，就会跟原生文档预览抢文件')
  assert.equal(definition.canOpen, undefined)
})

check('插件本体只硬依赖 slots（右栏服务缺失时卡片照旧可用）', () =>
  assert.deepEqual(plain(plugin.inject), ['slots']),
)

// ── P1「侧栏打开」：送进右栏我们自己的页类型；失败兜底到新标签页 ──
// ⚠️ 现场教训（2026-09-26）：这一版**不再**把文件丢给原生文档预览。
// 原生文档预览把 HTML 塞进 blob iframe、只打包相对 .js/.css，于是相对图片、
// 下级页、以及"按自己文件名推导数据文件"全废 —— 用户看到的就是
// "没找到数据文件：<blob uuid>.data.js"。右栏 Browser tab 也不行：
// 它的地址校验明确拒绝 **DSH 应用自身 origin**，而镜像路由正在那个 origin 上。
// 所以正解是自己注册页类型，正文渲染我们自己的镜像地址。
console.log('\n[P1 侧栏打开] 送进右栏页类型，失败有兜底')

const openInSidebar = internals.openInSidebar

check('右栏可用：openTab(kind, { params: { url, title } })，不动新标签页', () => {
  windowOpens.length = 0
  openTabCalls.length = 0
  const how = openInSidebar('http://x/api/showme/raw/s/.dsh/showme/x.html', '评审')
  assert.equal(how, 'sidebar')
  assert.deepEqual(plain(openTabCalls), [
    {
      kind: 'showme-page',
      options: { params: { url: 'http://x/api/showme/raw/s/.dsh/showme/x.html', title: '评审' } },
    },
  ])
  assert.equal(windowOpens.length, 0)
})

check('openTab 抛错（类型没注册上）：兜底到新标签页', () => {
  windowOpens.length = 0
  const saved = fakeSidebarRight.openTab
  fakeSidebarRight.openTab = () => {
    throw new Error('unregistered kind')
  }
  try {
    assert.equal(openInSidebar('/u', 'T'), 'window')
    assert.equal(windowOpens.length, 1)
  } finally {
    fakeSidebarRight.openTab = saved
  }
})

check('地址为空：返回 none，不抛', () => {
  windowOpens.length = 0
  assert.equal(openInSidebar('', 'T'), 'none')
  assert.equal(openInSidebar(undefined, 'T'), 'none')
  assert.equal(windowOpens.length, 0)
})

check('连新标签页都开不了：返回 none，不抛', () => {
  const savedSidebar = fakeSidebarRight.openTab
  const savedOpen = fakeWindow.open
  fakeSidebarRight.openTab = undefined
  delete fakeWindow.open
  try {
    assert.equal(openInSidebar('/u', 'T'), 'none')
  } finally {
    fakeSidebarRight.openTab = savedSidebar
    fakeWindow.open = savedOpen
  }
})

check('卡片头部长出「侧栏打开」，点它把**绝对**地址交给右栏', () => {
  openTabCalls.length = 0
  const tree = card({
    block: {
      kind: 'tool-result',
      call: { name: 'show_html', argsRaw: '{"path":".dsh/showme/x.html","title":"评审"}' },
      isError: false,
      meta: { bytes: 10, url: '/api/showme/raw/host/.dsh/showme/x.html' },
      content: [],
    },
    sessionId: 's',
    openFile: () => {},
  })
  const button = findElement(tree, (element) => element.type === 'button' && textOf(element) === '侧栏打开')
  assert.ok(button !== null, '头部没有「侧栏打开」按钮')
  const head = findElement(tree, (element) => element.props?.className === 'dsh-showme-head')
  assert.ok(findElement(head, (element) => element === button) !== null, '按钮不在头部')

  button.props.onClick()
  assert.equal(openTabCalls.length, 1)
  assert.equal(openTabCalls[0].kind, internals.SIDEBAR_KIND)
  assert.match(openTabCalls[0].options.params.url, /^http:\/\/localhost\/api\/showme\/raw\/host\//)
  assert.equal(openTabCalls[0].options.params.title, '评审')
})

check('右栏正文：按 tab 参数里的地址渲染 iframe；没参数时给一句话', () => {
  const body = registrations.find((entry) => entry.registration.name === 'sidebar.right.pane.tab').component
  const tree = body({
    useTabInfo: () => ({
      tab: { navigation: { params: { url: '/api/showme/raw/s/.dsh/showme/x.html', title: '评审' } } },
    }),
  })
  const iframe = findElement(tree, (element) => element.type === 'iframe')
  assert.ok(iframe !== null, '右栏正文没有 iframe')
  assert.equal(iframe.props.src, '/api/showme/raw/s/.dsh/showme/x.html')
  assert.equal(iframe.props.title, '评审')
  assert.match(String(iframe.props.sandbox), /allow-scripts/)

  const empty = body({ useTabInfo: () => ({ tab: { navigation: { params: {} } } }) })
  assert.match(textOf(empty), /没有页面地址/)
})

// ── 全屏浮层的退出通道：2026-09-26 现场回归 ──
// dsh Desktop 主窗口在 Windows 上是 titleBarStyle:'hidden' + titleBarOverlay:{height:40}：
// 右上角 40px 是**原生**窗口按钮，画在网页之上，z-index 盖不过去。
// 旧版把「退出全屏」放在头部右侧（margin-left:auto）→ 点不到；
// 而焦点进了 iframe 之后 Esc 也过不来 → 用户只能重启 dsh。
console.log('\n[全屏浮层] 退出通道不能被原生标题栏挡住')

const css = styles[0].textContent
const fullscreen = internals.FullscreenHost

/** 进入全屏并返回渲染出的对象树。 */
function renderFullscreen() {
  internals.setFullscreen({
    title: '评审',
    workspacePath: '.dsh/showme/x.html',
    url: '/api/showme/raw/s/.dsh/showme/x.html',
  })
  return fullscreen({})
}

check('浮层是画面内固定层，且明确接收指针事件', () => {
  const tree = renderFullscreen()
  assert.equal(tree.props.className, 'dsh-showme-fullscreen')
  assert.match(css, /\.dsh-showme-fullscreen\s*\{[^}]*position:\s*fixed/)
  assert.match(css, /\.dsh-showme-fullscreen\s*\{[^}]*pointer-events:\s*auto/)
})

check('退出按钮在**底部**条里，顶部头栏已被删掉', () => {
  const tree = renderFullscreen()
  const bar = findElement(tree, (element) => element.props?.className === 'dsh-showme-fullscreenBar')
  assert.ok(bar !== null, '没有底部控件条')
  const exit = findElement(bar, (element) => element.type === 'button' && /退出全屏/.test(textOf(element)))
  assert.ok(exit !== null, '底部条里没有退出按钮')
  assert.equal(
    findElement(tree, (element) => /fullscreenHead/.test(String(element.props?.className ?? ''))),
    null,
    '顶部头栏又回来了（它会被原生窗口按钮挡住）',
  )
  assert.doesNotMatch(css, /fullscreenHead/)
})

check('底部条是贴底（border-top）而不是贴顶（border-bottom）', () => {
  const rule = css.match(/\.dsh-showme-fullscreenBar\s*\{([^}]*)\}/)
  assert.ok(rule !== null, '没有 .dsh-showme-fullscreenBar 规则')
  assert.match(rule[1], /border-top:/)
  assert.doesNotMatch(rule[1], /border-bottom:/)
})

check('退出按钮仍然写着 Esc 提示', () =>
  assert.match(textOf(renderFullscreen()), /退出全屏 \(Esc\)/),
)

check('Esc 在 window 与 document 两处捕获阶段监听，退出后清理干净', () => {
  pendingEffects.length = 0
  const tree = renderFullscreen()
  const cleanups = runEffects()
  assert.equal(tree.props.className, 'dsh-showme-fullscreen')
  assert.equal(keyListeners.window.length, 1)
  assert.equal(keyListeners.document.length, 1)
  assert.equal(keyListeners.window[0].capture, true)
  assert.equal(keyListeners.document[0].capture, true)
  assert.equal(focusCalls.count, 1, '打开时应该把焦点抢回父文档（否则 Esc 收不到）')

  keyListeners.window[0].fn({ key: 'a', stopPropagation: () => {} })
  assert.notEqual(internals.getFullscreen(), null, '非 Esc 键不该关掉全屏')
  keyListeners.window[0].fn({ key: 'Escape', stopPropagation: () => {} })
  assert.equal(internals.getFullscreen(), null)

  for (const cleanup of cleanups) cleanup()
  assert.equal(keyListeners.window.length, 0)
  assert.equal(keyListeners.document.length, 0)
})

check('没进全屏时：不渲染、不监听', () => {
  pendingEffects.length = 0
  assert.equal(internals.getFullscreen(), null)
  assert.equal(fullscreen({}), null)
  assert.equal(runEffects().length, 0)
  assert.equal(keyListeners.window.length, 0)
})

// ══════════════ Chat 行（让页面不被「工作步骤」折叠吃掉）══════════════

console.log('\n[Chat 行]')

check('注册了 Chat 行定义：kind 走 conversation.chat.node，target 是 chat', () => {
  assert.equal(chatRowRegistrations.length, 1)
  const definition = chatRowRegistrations[0]
  assert.equal(definition.kind, internals.SHOWME_KIND)
  assert.equal(definition.target, 'chat')
  assert.equal(typeof definition.buildViewNode, 'function')
})

check('渲染器按 kind 注册进 conversation.chat.node', () => {
  const node = registrations.find((entry) => entry.registration.name === 'conversation.chat.node')
  assert.ok(node !== undefined, '没有注册 conversation.chat.node')
  assert.equal(node.registration.key, internals.SHOWME_KIND)
  assert.equal(node.component, internals.ShowmePageNode)
})

check('工具行注册的是摘要组件（不是整张卡片）', () => {
  const row = registrations.find((entry) => entry.registration.name === 'tool.call.toolview')
  assert.equal(row.component, internals.ShowmeToolRow)
})

// 定义必须**只**认 show_html：抢了别的工具的行，就等于把它们的输出也搬出过程组。
const chatRow = chatRowRegistrations[0]
const callEvent = (name, callId = 'c1') => ({ type: 'tool/call', seq: 10, data: { name, callId, arguments: '{}' } })
const resultEvent = (name, callId = 'c1') => ({
  type: 'tool/result',
  seq: 11,
  data: {
    message: { source: { name, callId }, content: [{ type: 'text', text: 'ok' }], isError: false },
    meta: { bytes: 42, url: '/api/showme/raw/session-abc/.dsh/showme/x.html' },
  },
})

check('只认 show_html 的 tool/call 与 tool/result', () => {
  assert.ok(chatRow.match(callEvent('show_html')) !== null)
  assert.ok(chatRow.match(resultEvent('show_html')) !== null)
  assert.equal(chatRow.match(callEvent('bash')), null)
  assert.equal(chatRow.match(resultEvent('bash')), null)
})

check('按 callId 归并：call 是 start，result 是 update', () => {
  assert.deepEqual(plain(chatRow.match(callEvent('show_html', 'c9'))), { id: 'c9', role: 'start' })
  assert.deepEqual(plain(chatRow.match(resultEvent('show_html', 'c9'))), { id: 'c9', role: 'update' })
})

// ★ 这一条是整个方案的地基：groupTree 一旦不是 turn（或更外层），卡片会掉回过程组被折叠。
const rowState = chatRow.start({}, { event: resultEvent('show_html'), id: 'c1', role: 'start' })
const chatRowNode = chatRow.buildViewNode({
  state: rowState,
  key: 'k1',
  id: 'c1',
  start: { location: { kind: 'turn' } },
})
check('节点声明 groupTree = turn（深度 2 ≤ process 3 → 不进过程组）', () => {
  assert.equal(chatRowNode.groupTree, 'turn')
})
check('节点字段齐全：key/kind/id/target/anchorSeq/visibility', () => {
  assert.equal(chatRowNode.key, 'k1')
  assert.equal(chatRowNode.id, 'c1')
  assert.equal(chatRowNode.kind, internals.SHOWME_KIND)
  assert.equal(chatRowNode.target, 'chat')
  assert.equal(chatRowNode.anchorSeq, 11, '落在结果事件的位置，不推到轮次末尾')
  assert.equal(chatRowNode.visibility, 'visible')
  assert.deepEqual(plain(chatRowNode.location), { kind: 'turn' })
})

check('节点数据 = 卡片要的东西（含 meta 里的字节数与地址）', () => {
  assert.equal(chatRowNode.data.path, '')
  assert.equal(chatRowNode.data.bytes, 42)
  assert.equal(chatRowNode.data.url, '/api/showme/raw/session-abc/.dsh/showme/x.html')
  assert.equal(chatRowNode.data.sessionId, 'session-abc', '会话 id 从地址里解，节点视图拿不到 props.sessionId')
})

check('tool/call 阶段也能建行（参数已到，结果还没到）', () => {
  const early = chatRow.start({}, {
    event: {
      type: 'tool/call',
      seq: 5,
      data: {
        name: 'show_html',
        callId: 'c2',
        arguments: '{"path":".dsh/showme/a.html","title":"甲"}',
      },
    },
    id: 'c2',
    role: 'start',
  })
  assert.equal(early.path, '.dsh/showme/a.html')
  assert.equal(early.title, '甲')
  assert.equal(early.settled, false)
  const earlyNode = chatRow.buildViewNode({ state: early, key: 'k2', id: 'c2', start: { location: { kind: 'turn' } } })
  assert.equal(earlyNode.data.title, '甲')
})

check('sessionIdFromUrl：各种形态都不炸', () => {
  assert.equal(internals.sessionIdFromUrl('/api/showme/raw/session-a/b/c.html'), 'session-a')
  assert.equal(internals.sessionIdFromUrl('/api/showme/raw/session-a/b/c.html?v=3'), 'session-a')
  assert.equal(internals.sessionIdFromUrl(''), '')
  assert.equal(internals.sessionIdFromUrl('http://x/other'), '')
})

// 摘要行：新宿主上工具行只剩一行（不再内嵌 iframe）
const rowTree = internals.ShowmeToolRow({
  block: {
    kind: 'tool-result',
    call: { name: 'show_html', argsRaw: '{"path":".dsh/showme/x.html","title":"评审"}' },
    meta: { bytes: 2048, url: '/api/showme/raw/session-abc/.dsh/showme/x.html' },
    content: [{ type: 'text', text: 'ok' }],
    isError: false,
  },
  sessionId: 's',
  openFile: () => {},
})
check('工具行摘要：标题 + 体积 + "页面在下方"，且没有 iframe', () => {
  const text = textOf(rowTree)
  assert.match(text, /评审/)
  assert.match(text, /2\.0 KB/)
  assert.match(text, /页面在下方/)
  assert.equal(findElement(rowTree, (node) => node.type === 'iframe'), null, '整页 iframe 应该在 Chat 行里，不在工具行')
})

// 注意：这个假 React 不会渲染函数组件（`h(Comp, props)` 只会产出元素），
// 所以「渲染器把 node.data 转成卡片」这一步分两段断言：元素指向 ToolCard，
// 再把同一份 source 喂给卡片本体看内容。
const pageNodeElement = internals.ShowmePageNode({
  node: {
    data: {
      path: '.dsh/showme/x.html',
      title: '评审',
      note: '',
      bytes: 1024,
      url: '/api/showme/raw/session-abc/.dsh/showme/x.html',
      sessionId: 'session-abc',
      settled: true,
      failed: false,
      failureText: '',
    },
  },
  openFile: () => {},
})
check('Chat 行渲染器：把 node.data 原样交给卡片本体', () => {
  assert.equal(pageNodeElement.type, internals.ToolCard)
  assert.equal(pageNodeElement.props.source.title, '评审')
  assert.equal(pageNodeElement.props.source.sessionId, 'session-abc')
})

const pageNodeTree = internals.ToolCard({ source: pageNodeElement.props.source, openFile: () => {} })
check('Chat 行出来的卡片：标题 / 体积 / 路径 / 四个动作都在', () => {
  const text = textOf(pageNodeTree)
  assert.match(text, /评审/)
  assert.match(text, /1\.0 KB/)
  assert.match(text, /\.dsh\/showme\/x\.html/)
  assert.ok(findElement(pageNodeTree, (node) => node.props?.className === 'dsh-showme-stage') !== null)
  assert.match(text, /全屏/)
  assert.match(text, /浏览器打开/)
})

check('rawUrl：空会话 id 不产出坏地址（否则路由回 "expected /raw/<sessionId>/..."）', () => {
  assert.equal(internals.rawUrl('', '.dsh/showme/x.html'), '')
  assert.equal(internals.rawUrl('session-a', '.dsh/showme/x.html'), '/api/showme/raw/session-a/.dsh/showme/x.html')
})

// 节点视图拿不到 props.sessionId，而 `meta.url` 在客户端的会话事件里不保证有 ——
// 兜底必须是"输入框座位记下的当前会话"，否则会拼出 `/api/showme/raw//<path>`
// （现场报错原文：{"ok":false,"error":"expected /raw/<sessionId>/<workspace-relative path>"}）。
const noUrlSource = {
  path: '.dsh/showme/x.html',
  title: '评审',
  note: '',
  url: '',
  sessionId: '',
  settled: true,
  failed: false,
  failureText: '',
}

check('节点行缺地址时：用输入框座位的会话 id 兜底拼出镜像地址', () => {
  internals.inputRefs.sessionId = 'session-from-composer'
  assert.equal(
    internals.resolveCardUrl(noUrlSource),
    '/api/showme/raw/session-from-composer/.dsh/showme/x.html',
  )
})

check('两处都拿不到会话 id：给空地址（卡片会显示"拿不到地址"而不是坏 iframe）', () => {
  internals.inputRefs.sessionId = ''
  assert.equal(internals.resolveCardUrl(noUrlSource), '')
})

const noAddress = internals.ToolCard({ source: noUrlSource, openFile: () => {} })
check('没有地址时：画面里是那句能行动的话，不是 iframe', () => {
  const text = textOf(noAddress)
  assert.match(text, /拿不到这一页的地址/)
  assert.equal(findElement(noAddress, (node) => node.type === 'iframe'), null)
})

check('Chat 行渲染器：把标准 props 里的 sessionId 转交给卡片', () => {
  const element = internals.ShowmePageNode({
    node: { data: { path: '.dsh/showme/x.html', title: '甲', note: '', url: '', sessionId: '', settled: true, failed: false, failureText: '' } },
    sessionId: 'session-from-slot',
    openFile: () => {},
  })
  assert.equal(element.props.sessionId, 'session-from-slot')
})

check('Chat 行渲染器：没有 data 时不渲染（不白屏、不抛）', () => {
  assert.equal(internals.ShowmePageNode({ node: {} }), null)
  assert.equal(internals.ShowmePageNode({}), null)
})

check('缺少 uiConversation 的宿主：不注册 Chat 行（旧宿主照旧内嵌卡片）', () => {
  const before = chatRowRegistrations.length
  let injectedWithoutService = 0
  const bare = {
    effect: (fn) => {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    // cordis 的真实语义：依赖的服务一个都没有时，回调**根本不会被调用**。
    inject: () => {
      injectedWithoutService += 1
    },
    slots: { inject: (_name, callback) => callback(), register: () => () => {} },
  }
  plugin.apply(bare)
  assert.ok(injectedWithoutService >= 1, '应该尝试注入过（只是服务不在）')
  assert.equal(chatRowRegistrations.length, before, '没有 uiConversation 时不该注册 Chat 行')
})

console.log('\n[草稿] 刷新 / 切会话不丢的接线')

check('从镜像地址解出草稿身份（解不出就给 null）', () => {
  assert.deepEqual(
    plain(internals.draftIdentityFromUrl('http://h/api/showme/raw/session-abc/.dsh/showme/a.html')),
    { sessionId: 'session-abc', page: '.dsh/showme/a.html' },
  )
  assert.equal(internals.draftIdentityFromUrl('blob:http://h/94d45dc1'), null)
  assert.equal(internals.draftIdentityFromUrl(''), null)
})

check('草稿载荷只留非空字符串', () => {
  const payload = plain(
    internals.draftPayloadOf({ state: { verdicts: { a: '同意', b: '' }, notes: { c: '长备注', d: 3 } } }),
  )
  assert.deepEqual(payload, { verdicts: { a: '同意' }, notes: { c: '长备注' } })
})

check('页面变化 → 卡片代发 POST /api/showme/draft', async () => {
  internals.relayDraft(
    { sessionId: 's1', page: '.dsh/showme/a.html' },
    { state: { verdicts: { a: '同意' }, notes: { a: '数字太小' } } },
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  const call = fetchCalls
    .filter((entry) => entry.url === '/api/showme/draft')
    .filter((entry) => JSON.parse(entry.options.body).page === '.dsh/showme/a.html')
    .pop()
  assert.ok(call !== undefined, '没有发草稿请求')
  assert.equal(call.options.method, 'POST')
  const body = JSON.parse(call.options.body)
  assert.equal(body.sessionId, 's1')
  assert.equal(body.page, '.dsh/showme/a.html')
  assert.deepEqual(body.verdicts, { a: '同意' })
  assert.deepEqual(body.notes, { a: '数字太小' })
})

check('清空 → 同一个路由发 clear', async () => {
  internals.relayDraft({ sessionId: 's1', page: 'p.html' }, { clear: true })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const body = JSON.parse(fetchCalls.filter((entry) => entry.url === '/api/showme/draft').pop().options.body)
  assert.equal(body.clear, true)
})

check('页面 ready → 卡片读草稿（GET 带 session 与 page）', async () => {
  const draft = await internals.fetchDraft({ sessionId: 's 1', page: 'a b.html' })
  assert.equal(draft, null)
  const call = fetchCalls.filter((entry) => entry.url.startsWith('/api/showme/draft?')).pop()
  assert.equal(call.url, '/api/showme/draft?session=s%201&page=a%20b.html')
})

check('两个宿主都挂上了草稿通道（卡片 + 右栏正文）', () => {
  const hits = code.match(/useDraftBridge\(url\)/g) ?? []
  assert.ok(hits.length >= 2, `只找到 ${hits.length} 处，卡片与右栏正文都该挂`)
  assert.match(code, /DRAFT_RESTORE_TYPE/)
  assert.match(code, /source\?\.postMessage\(\{ type: DRAFT_RESTORE_TYPE/, '没有把草稿灌回页面')
})

check('页面交回的反馈由卡片补发到 /feedback（页面自己 POST 会被跨域拦掉）', async () => {
  internals.relayFeedback({ sessionId: 's1', page: 'p.html' }, 'a 同意')
  await new Promise((resolve) => setTimeout(resolve, 0))
  const call = fetchCalls.filter((entry) => entry.url === '/api/showme/feedback').pop()
  assert.ok(call !== undefined, '没有补发反馈')
  assert.equal(JSON.parse(call.options.body).text, 'a 同意')
})

console.log('\n[回执来源核对]')

/** 一个"我们自己的"展示页 iframe 桩。 */
const pageFrame = {
  contentWindow: { id: 'frame-a' },
  getAttribute: (name) => (name === 'src' ? '/api/showme/raw/s1/a/review.html?v=7' : null),
}
const otherPageFrame = {
  contentWindow: { id: 'frame-b' },
  getAttribute: (name) => (name === 'src' ? '/api/showme/raw/s1/b/review.html?v=7' : null),
}
const strangerFrame = {
  contentWindow: { id: 'frame-c' },
  getAttribute: (name) => (name === 'src' ? 'https://example.com/embed.html' : null),
}
documentFrames.push(pageFrame, otherPageFrame, strangerFrame)

check('能从 iframe 的 src 认出这一页（忽略 ?v= 防抖参数）', () => {
  assert.deepEqual(plain(internals.frameIdentity(pageFrame.contentWindow)), {
    sessionId: 's1',
    page: 'a/review.html',
  })
  assert.deepEqual(plain(internals.frameIdentity(otherPageFrame.contentWindow)), {
    sessionId: 's1',
    page: 'b/review.html',
  })
})

check('不是本插件的 frame → null（没有 contentWindow 也不炸）', () => {
  assert.equal(internals.frameIdentity(strangerFrame.contentWindow), null)
  assert.equal(internals.frameIdentity(null), null)
  assert.equal(internals.frameIdentity({ id: 'not-a-frame' }), null)
})

check('回执自洽才放行：来源页与正文里的 sessionId / page 都要对上', () => {
  const ok = internals.acceptMermaidReceipt({
    data: { type: internals.MERMAID_TYPE, sessionId: 's1', page: 'a/review.html', diagrams: [] },
    source: pageFrame.contentWindow,
  })
  assert.equal(ok?.page, 'a/review.html')

  assert.equal(
    internals.acceptMermaidReceipt({
      data: { type: internals.MERMAID_TYPE, sessionId: 's1', page: 'b/review.html', diagrams: [] },
      source: pageFrame.contentWindow,
    }),
    null,
    '页面冒充另一页时必须拒绝',
  )
  assert.equal(
    internals.acceptMermaidReceipt({
      data: { type: internals.MERMAID_TYPE, sessionId: 's1', page: 'a/review.html', diagrams: [] },
      source: strangerFrame.contentWindow,
    }),
    null,
    '别的插件的 iframe 不该能写文件',
  )
  assert.equal(
    internals.acceptMermaidReceipt({
      data: { type: 'something-else', sessionId: 's1', page: 'a/review.html' },
      source: pageFrame.contentWindow,
    }),
    null,
  )
})

check('顶层监听：只转发被承认的那一条', async () => {
  const count = () => fetchCalls.filter((entry) => entry.url === '/api/showme/mermaid').length
  assert.ok(messageListeners.length >= 1, '顶层没有挂 message 监听')
  const dispatch = (event) => {
    for (const listener of messageListeners) listener(event)
  }

  // 本文件 apply 过两次（第二次是"缺服务"的宿主编排），所以顶层监听可能不止一条；
  // 这里断言的是"转发会发生 / 不该发生的不会再发生"，而不是条数。
  const before = count()
  dispatch({
    data: { type: internals.MERMAID_TYPE, sessionId: 's1', page: 'a/review.html', ok: true, diagrams: [] },
    source: pageFrame.contentWindow,
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const afterPositive = count()
  assert.ok(afterPositive > before, '被承认的回执应该发出去')

  // 来源不属于本插件 / 正文冒充别的页面：两条都不该再发请求。
  dispatch({
    data: { type: internals.MERMAID_TYPE, sessionId: 's1', page: 'a/review.html', ok: true, diagrams: [] },
    source: strangerFrame.contentWindow,
  })
  dispatch({
    data: { type: internals.MERMAID_TYPE, sessionId: 's1', page: 'b/review.html', ok: true, diagrams: [] },
    source: pageFrame.contentWindow,
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(count(), afterPositive)
})

console.log('\n[设置页 / 计划页]')

check('偏好：读走 GET /api/showme/prefs', async () => {
  await internals.fetchPrefs()
  assert.ok(fetchCalls.some((entry) => entry.url === '/api/showme/prefs' && entry.options?.method === undefined))
})
check('偏好：写走 POST，提交的是改动的那几项', async () => {
  await internals.savePrefs({ planPage: 'require' })
  const call = fetchCalls.filter((entry) => entry.url === '/api/showme/prefs' && entry.options?.method === 'POST').pop()
  assert.ok(call !== undefined, '没有发写请求')
  assert.deepEqual(JSON.parse(call.options.body), { planPage: 'require' })
})

check('设置进了插件页：只认自己那条组合包，别人的页返回 null', () => {
  const Section = internals.ShowmeSettingsSection
  assert.equal(typeof Section, 'function', '没有导出 ShowmeSettingsSection')
  assert.equal(Section({ subject: { kind: 'row', pkg: { name: 'dsh-showme-html' } } }), null, '行页不该出区块')
  assert.equal(Section({ subject: { kind: 'item', id: 'x' } }), null, '官方插件页不该出区块')
  assert.equal(Section({ subject: { kind: 'bundle', pkg: { name: 'other-plugin' } } }), null, '别人的组合包不该出区块')
  assert.equal(Section({}), null, '没有 subject 时要安静')
})
check('自己的组合包页：区块外壳 + 标题「展示页 · 设置」+ 复用控件组', () => {
  const tree = internals.ShowmeSettingsSection({ subject: { kind: 'bundle', pkg: { name: 'dsh-showme-html' } } })
  assert.ok(tree !== null && tree.type === 'section', '区块根节点应当是 section')
  assert.equal(tree.props.className, 'dsh-showme-pluginSection')
  const kids = tree.children.filter(Boolean)
  const body = kids[kids.length - 1]
  assert.equal(body.type, internals.ShowmeSettings, '正文应当复用 ShowmeSettings（控件组）')
  const text = JSON.stringify(tree)
  assert.ok(text.includes('展示页 · 设置'), '区块标题丢了')
  assert.ok(text.includes('prefs.json'), '落点说明丢了')
})
check('原生设置弹窗那一栏已经不再注册', () => {
  assert.equal(injections.includes('settings.section'), false, 'settings.section 又回来了')
  assert.ok(code.includes("name: 'plugins.detail.section'"), '插件页槽位没注册')
})

check('打开前 HEAD 一下：存在才开', async () => {
  assert.equal(await internals.pageExists('/api/showme/raw/s/p.html'), true)
  assert.equal(await internals.pageExists('/api/showme/raw/s/missing.html'), false)
})
check('路径不存在时不打开（返回 missing）', async () => {
  assert.equal(await internals.openShowmePage('s', 'missing.html'), 'missing')
})

check('计划页标记行能解析出来', () => {
  const plan = '# 计划\n\n目标……\n展示页：.dsh/showme/plan.html\n'
  const match = internals.PLAN_PAGE_MARKER.exec(plan)
  assert.ok(match !== null, '没解析到展示页行')
  assert.equal(match[1], '.dsh/showme/plan.html')
})

check('评审里没有标记行 → 不渲染任何东西（不留死按钮）', () => {
  const node = internals.PlanPageAction({ review: { plan: '# 计划\n\n只有 markdown' }, requestKey: 'k', sessionId: 's' })
  assert.equal(node, null)
})
check('评审里有标记行 → 给出「打开展示页」按钮', () => {
  const node = internals.PlanPageAction({
    review: { plan: '# 计划\n\n展示页：.dsh/showme/plan.html' },
    requestKey: 'k1',
    sessionId: 's',
  })
  assert.ok(node !== null, '没有渲染按钮')
  assert.equal(node.type, 'button')
  assert.equal(typeof node.props.onClick, 'function')
})

check('设置页：拿不到偏好时给一句"读取偏好…"，不白屏', () => {
  const node = internals.ShowmeSettings({})
  assert.ok(node !== null, '设置页返回了 null')
  assert.match(JSON.stringify(node), /读取偏好/)
})

await Promise.all(asyncChecks)
console.log(`\n全部通过：${checks} 项断言。\n`)
