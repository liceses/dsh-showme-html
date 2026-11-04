/**
 * 宿主半区的离线验收：不需要 DSH、不需要重启 GUI，直接把 `apply()` 挂到
 * 一个假的 ctx 上，把捕获到的路由丢进真实 http server 打请求。
 *
 * 覆盖：镜像路由的正常分发、相对引用、越界 403、缺失 404、类型 415、
 * 回环围栏、反馈落盘，以及 `show_html` 工具的定义合法性与参数校验。
 *
 * 跑法：`node test/route.test.mjs`（或 `npm test`）。
 */

import assert from 'node:assert/strict'
import { request as httpRequest, createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * 找到本机 DSH 装的 `@deepseek-ai/dsh-tools`，用来借它的 JSON Schema 校验器。
 *
 * 找不到就返回 null（调用方跳过那几条断言）：**那不是本插件的代码**，
 * 不该因为别人机器上的 DSH 装在别处就让整个测试挂掉。
 * @returns 模块命名空间，或 null。
 */
async function loadHarnessTools() {
  const roots = [
    process.env.DSH_HOME === undefined ? null : join(process.env.DSH_HOME, 'profiles', 'node_modules'),
    join(homedir(), '.dsh', 'profiles', 'node_modules'),
  ].filter((root) => root !== null)
  for (const root of roots) {
    const entry = join(root, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')
    if (existsSync(entry)) return import(pathToFileURL(entry).href)
  }
  return null
}

import { apply } from '../lib/index.js'

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

const workspace = await mkdtemp(join(tmpdir(), 'showme-ws-'))
const outside = await mkdtemp(join(tmpdir(), 'showme-out-'))

/** 工作区内容：一个展示页 + 同目录资源 + 一张图（相对引用要能解析）。 */
await mkdir(join(workspace, '.dsh', 'showme'), { recursive: true })
await mkdir(join(workspace, 'stills'), { recursive: true })
const pageBody = '<h1>hi</h1>'
await writeFile(join(workspace, '.dsh', 'showme', 'review.html'), pageBody, 'utf8')
await writeFile(join(workspace, 'stills', 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
await writeFile(join(workspace, 'notes.md'), '# notes', 'utf8')
await writeFile(join(workspace, 'weird.bin'), Buffer.from([0, 1, 2, 3]))
// 名字像页面、其实是目录：用来验"必须是普通文件"。
await mkdir(join(workspace, 'decoy.html'))

/**
 * 工作区的**兄弟**文件：`../<name>` 会解析到它。
 * 穿越用例必须打真实存在的文件，否则拿到的是 404（realpath 失败）而不是 403（越界）。
 */
const escapeTargetName = `showme-escape-target-${Date.now()}.html`
await writeFile(join(tmpdir(), escapeTargetName), 'must not be readable', 'utf8')
await writeFile(join(outside, 'secret.txt'), 'must not be readable', 'utf8')

/** 指向工作区外的软链接：若建得出来，就必须被 realpath 围栏拦下。 */
let linked = false
try {
  await symlink(join(outside, 'secret.txt'), join(workspace, 'escape-link.txt'))
  linked = true
} catch {
  /* Windows 无权限时跳过这一条 */
}

/** 捕获 apply() 注册的东西。 */
const captured = { route: null, tool: null, promptSections: [] }
const services = {
  // 真实契约：`sessions.get(id)` 返回 Session，暴露的是 `header.cwd`（**没有 meta**）。
  // meta-session 是刻意留的形状容忍用例。
  // 计划页提示的门控：只有这个会话在 plan 模式里。
  planMode: { loggedActive: (session) => session === 'plan-on' },
  sessions: {
    get: (id) => {
      if (id === 'live-session') return { header: { cwd: workspace } }
      if (id === 'meta-session') return { meta: { cwd: workspace } }
      return undefined
    },
  },
  // 持久化会话的读取面。0.2.1-rc.5 的真实形状是
  // `{ session: <克隆的 header>, inheritedEventCount, events }` —— cwd 挂在 `session` 下。
  // 只认顶层 header 的写法在 rc.5 上会让路由对"本进程还没加载过"的会话回 404
  // （2026-11-01 在真实实例上踩到，诊断串 `sessions.get=miss sessionQuery=no-cwd`）。
  sessionQuery: {
    readSession: async (id) => {
      if (id === 'persisted-session') {
        return { session: { cwd: workspace }, inheritedEventCount: 0, events: [] }
      }
      throw new Error(`no such session: ${id}`)
    },
  },
}
const fakeCtx = {
  effect: (fn) => {
    const disposer = fn()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  webServer: {
    register: (route) => {
      captured.route = route
      return () => {}
    },
  },
  tools: {
    register: (definition) => {
      captured.tool = definition
      return () => {}
    },
  },
  // 计划页 / 回答形态指引都走 systemPrompt.section；这里收下定义，供用例直接求值。
  inject: (names, callback) => callback(fakeCtx),
  systemPrompt: {
    // 照宿主 SECTION_ORDERS 的两个真实值，才能断言我们两段的相对位置。
    getSectionOrder: (name) => ({ DEPLOYMENT_PERSONA_PREFIX: 0, PLAN_POLICY: 500 })[name] ?? 0,
    section: (definition) => {
      captured.promptSections.push(definition)
      return () => {}
    },
  },
  get: (key) => services[key],
}

apply(fakeCtx)

assert.ok(captured.route !== null, '镜像路由没有注册')
assert.ok(captured.tool !== null, 'show_html 工具没有注册')

const server = createServer((req, res) => captured.route.handler(req, res))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

/**
 * 用 node:http 发一次请求：**path 原样送上线路**，不像 `fetch` 那样先把 `..` 归一化。
 * 穿越用例必须走这条，否则测的是 fetch 的 URL 规范化而不是我们的围栏。
 * @param pathname - 含查询串的原始请求路径。
 * @param options - method / headers / body。
 */
function rawRequest(pathname, options = {}) {
  const { method = 'GET', headers = {}, body } = options
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
      )
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

const base = '/api/showme'
const raw = (relative) => `${base}/raw/live-session/${relative}`

console.log('\n[路由] 正常分发')

const page = await rawRequest(raw('.dsh/showme/review.html'))
check('展示页 200', () => assert.equal(page.status, 200))
check('HTML content-type', () => assert.match(page.headers['content-type'], /^text\/html/))
check('HTML 带 CSP sandbox', () => assert.match(page.headers['content-security-policy'] ?? '', /sandbox/))
check('CSP 不含 allow-same-origin', () =>
  assert.ok(!/allow-same-origin/.test(page.headers['content-security-policy'] ?? '')),
)
check('CSP 放开表单/下载/弹窗', () =>
  assert.match(page.headers['content-security-policy'] ?? '', /allow-forms.*allow-downloads/),
)
check('nosniff', () => assert.equal(page.headers['x-content-type-options'], 'nosniff'))
check('no-store', () => assert.equal(page.headers['cache-control'], 'no-store'))
check('正文正确', () => assert.equal(page.body, pageBody))

const head = await rawRequest(raw('.dsh/showme/review.html'), { method: 'HEAD' })
check('HEAD 200 且无正文', () => assert.equal(head.status, 200) && assert.equal(head.body, ''))

const image = await rawRequest(raw('stills/a.png'))
check('相对引用的图片 200', () => assert.equal(image.status, 200))
check('图片 content-type', () => assert.equal(image.headers['content-type'], 'image/png'))
check('图片不背 CSP sandbox', () => assert.equal(image.headers['content-security-policy'], undefined))

console.log('\n[路由] 安全与错误态')

// 字面的 `..` 会被 `new URL()` 在解析阶段归一化掉，根本到不了围栏，
// 结果是"不再像一条 raw 路由" → 400。真正要打的是**编码形态**。
const literalTraversal = await rawRequest(raw(`../${escapeTargetName}`))
check('字面 .. 被 URL 归一化后拒为 400', () => assert.equal(literalTraversal.status, 400))

const encodedSlash = await rawRequest(raw(`%2e%2e%2f${escapeTargetName}`))
check('编码斜杠穿越（%2f）→ 403', () => assert.equal(encodedSlash.status, 403))

// Windows 特有：`\` 也是分隔符，`%5c` 解码后必须同样被抓住。
const encodedBackslash = await rawRequest(raw(`%2e%2e%5c${escapeTargetName}`))
check('编码反斜杠穿越（%5c）→ 403', () => assert.equal(encodedBackslash.status, 403))

// 半编码：`..%2f` —— 归一化看不懂，解码后就是 `../`。
const halfEncoded = await rawRequest(raw(`..%2f${escapeTargetName}`))
check('半编码穿越（..%2f）→ 403', () => assert.equal(halfEncoded.status, 403))

const missingTraversal = await rawRequest(raw('%2e%2e%2fdefinitely-not-here.txt'))
check('穿越到不存在的位置 → 404', () => assert.equal(missingTraversal.status, 404))

if (linked) {
  const viaLink = await rawRequest(raw('escape-link.txt'))
  check('软链接逃逸 403', () => assert.equal(viaLink.status, 403))
} else {
  console.log('  skip 软链接逃逸（当前环境建不出软链接）')
}

const missing = await rawRequest(raw('.dsh/showme/nope.html'))
check('文件不存在 404', () => assert.equal(missing.status, 404))

const directory = await rawRequest(raw('stills'))
check('目录 404（不列目录）', () => assert.equal(directory.status, 404))

const unsupported = await rawRequest(raw('weird.bin'))
check('未登记类型 415', () => assert.equal(unsupported.status, 415))

const plainText = await rawRequest(raw('notes.md'))
check('登记过的 .md 走 text/plain', () =>
  assert.equal(plainText.status, 200) && assert.match(plainText.headers['content-type'], /^text\/plain/),
)

const unknownSession = await rawRequest(`${base}/raw/no-such-session/x.html`)
check('未知会话 404，且不回落到全局根', () => {
  assert.equal(unknownSession.status, 404)
  assert.match(unknownSession.body, /unknown session/)
})

// 形状容忍：有的记录只有 meta.cwd，有的只有裸 cwd。
const metaShape = await rawRequest(`${base}/raw/meta-session/.dsh/showme/review.html`)
check('meta.cwd 形态也能解析', () => assert.equal(metaShape.status, 200))

// 0.2.1-rc.5 的持久化会话形状：cwd 在 `session` 下，不是顶层 `header`。
// 这条对应 2026-11-01 在真实 rc.5 实例上发现的 bug（非活跃会话全 404）。
const persistedShape = await rawRequest(`${base}/raw/persisted-session/.dsh/showme/review.html`)
check('rc.5 的 { session: header } 形态也能解析', () => assert.equal(persistedShape.status, 200))

check('404 里带上解析到的工作区根（出错时最想知道的事）', () =>
  assert.match(missing.body, /workspace root:/),
)

const unknownRoute = await rawRequest(`${base}/nope`)
check('未知子路由 404', () => assert.equal(unknownRoute.status, 404))

const noPath = await rawRequest(`${base}/raw/live-session`)
check('缺少路径段 400', () => assert.equal(noPath.status, 400))

const badMethod = await rawRequest(raw('.dsh/showme/review.html'), { method: 'DELETE' })
check('非法方法 405', () => assert.equal(badMethod.status, 405))

// ⚠️ 三条回归，每一条都对应一次真实现场。共同点：展示页跑在 sandbox 的不透明源里，
// 它发起的一切请求都被浏览器标成 cross-site、Origin 是字面量 "null"。
// 拿 Sec-Fetch-Site 做判断的围栏，会一块一块地把自己的页面咬死。
const sandboxedImage = await rawRequest(raw('stills/a.png'), {
  headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'image' },
})
check('① 沙箱页面加载自己的图片放行（现场："数据流图裂了"）', () =>
  assert.equal(sandboxedImage.status, 200),
)

const sandboxedFrame = await rawRequest(raw('.dsh/showme/review.html'), {
  headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'iframe' },
})
check('② 嵌套页放行（cross-site + dest=iframe）', () => assert.equal(sandboxedFrame.status, 200))

const sandboxedNavigation = await rawRequest(raw('.dsh/showme/review.html'), {
  headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'document' },
})
check('③ 页内 <a href> 跳转 / 打开图片放行（现场："点图片到达错误页"）', () =>
  assert.equal(sandboxedNavigation.status, 200),
)

const opaqueOrigin = await rawRequest(raw('.dsh/showme/review.html'), {
  headers: { origin: 'null', 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'empty' },
})
check('沙箱页面自己的 fetch 放行（Origin: null）', () => assert.equal(opaqueOrigin.status, 200))

const crossSiteFetch = await rawRequest(raw('.dsh/showme/review.html'), {
  headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'empty' },
})
check('带真实 Origin 的跨站 fetch 拒（403）——真正的那条防线', () =>
  assert.equal(crossSiteFetch.status, 403),
)

const crossSiteDocument = await rawRequest(raw('.dsh/showme/review.html'), {
  headers: { origin: 'https://evil.example', 'sec-fetch-dest': 'document' },
})
check('带真实 Origin 的跨站文档导航也拒（403）', () => assert.equal(crossSiteDocument.status, 403))

const badHost = await rawRequest(raw('.dsh/showme/review.html'), { headers: { host: '10.0.0.5:3080' } })
check('非回环 Host 403（回环围栏）', () => assert.equal(badHost.status, 403))

console.log('\n[路由] 反馈落盘')

const feedbackBody = JSON.stringify({
  sessionId: 'live-session',
  text: 'f2 要改：数字太小，10000 不要写 1 万',
  page: '.dsh/showme/review.html',
})
const feedback = await rawRequest(`${base}/feedback`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(feedbackBody) },
  body: feedbackBody,
})
check('反馈 200', () => assert.equal(feedback.status, 200))
const inbox = await readFile(join(workspace, '.dsh', 'showme', 'inbox.jsonl'), 'utf8')
check('inbox.jsonl 出现该条', () => assert.match(inbox, /f2 要改/))
check('inbox.jsonl 带会话与页面', () =>
  assert.match(inbox, /live-session/) && assert.match(inbox, /review\.html/),
)

const emptyBody = JSON.stringify({ sessionId: 'live-session', text: '   ' })
const emptyFeedback = await rawRequest(`${base}/feedback`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(emptyBody) },
  body: emptyBody,
})
check('空反馈 400', () => assert.equal(emptyFeedback.status, 400))

const getFeedback = await rawRequest(`${base}/feedback`)
check('反馈只收 POST，GET 405', () => assert.equal(getFeedback.status, 405))

console.log('\n[工具] show_html 定义与执行')

const tool = captured.tool
check('工具名是 show_html', () => assert.equal(tool.name, 'show_html'))
check('description 要求先写文件', () => assert.match(tool.description, /write it first/i))
check('description 警告不要拿来贴代码', () => assert.match(tool.description, /Do NOT use it for ordinary answers/))
check('parameters 是对象根 JSON Schema', () => assert.equal(tool.parameters.type, 'object'))
check('path 必填', () => assert.deepEqual(tool.parameters.required, ['path']))
check('output.render 是函数', () => assert.equal(typeof tool.output.render, 'function'))
check('render 不回显正文', () => {
  const blocks = tool.output.render({ path: 'a.html' }, { path: 'a.html', bytes: 3 })
  assert.equal(blocks.length, 1)
  assert.match(blocks[0].text, /a\.html/)
  assert.ok(!blocks[0].text.includes('<'))
})
check('presentationMeta 带上 bytes 与宿主算好的 url', () =>
  assert.deepEqual(tool.output.presentationMeta({}, { path: 'a', bytes: 12, url: '/x' }), { bytes: 12, url: '/x' }),
)

// `register()` 只校验 output.schema，parameters 是原样交给模型适配器的
// （ToolSchema.parameters 就是一份 JSON Schema）。这里两条都验，避免手写
// schema 在请求期才炸。
//
// 用的是**本机 DSH 装的那份真包**，所以路径必须现算——写死成某个用户目录的话，
// 别人克隆下来这几条就会挂（而且会把本机路径带进公开仓库）。
const toolsPkg = await loadHarnessTools()
if (toolsPkg === null) {
  console.log('  skip @deepseek-ai/dsh-tools 不在本机 —— schema 校验器那 4 条跳过')
} else {
  check('output.schema 受支持', () => toolsPkg.assertSupportedJsonSchema(tool.output.schema))
  check('parameters 受支持', () => toolsPkg.assertSupportedJsonSchema(tool.parameters))
  check('parameters 是合法对象根', () => toolsPkg.assertObjectJsonSchema(tool.parameters))
  check('手写 parameters 与 defineTool 的编译结果同形', () => {
    const compiled = toolsPkg.parameterSchemaSpecToJsonSchema({
      path: { type: 'string', required: true },
      title: { type: 'string' },
    })
    assert.equal(compiled.type, 'object')
    assert.deepEqual(compiled.required, ['path'])
    assert.equal(compiled.properties.path.type, 'string')
  })
}

const exec = { agent: { session: { header: { cwd: workspace } } } }

const ok = await tool.execute({ path: '.dsh/showme/review.html' }, exec)
check('execute 返回 path 与 bytes', () =>
  assert.equal(ok.path, '.dsh/showme/review.html') && assert.equal(ok.bytes, Buffer.byteLength(pageBody)),
)
check('没有会话 id 时 url 为空串（不编造地址）', () => assert.equal(ok.url, ''))

// ── 回执体检：页面缺"让用户回话"的部分时，提醒随工具结果回到模型眼前 ──
console.log('\n[工具] 回执体检')

check('裸页面（没有回执）会被点名提醒', () => {
  assert.match(ok.hint, /Host check/)
  assert.match(ok.hint, /pointable ids/)
  assert.match(ok.hint, /postMessage/)
})

check('render 把提醒带给模型；没有提醒时不夹带', () => {
  const withHint = tool.output.render({}, { path: 'a.html', hint: 'HINT-X' })
  assert.match(withHint[0].text, /a\.html/)
  assert.match(withHint[0].text, /HINT-X/)
  const clean = tool.output.render({}, { path: 'a.html', hint: '' })
  assert.ok(!/Host check/.test(clean[0].text), '干净页面不该被夹带提醒')
})

const POST = '<script>parent.postMessage({type:"dsh-showme-feedback",text:""},"*")</script>'

await writeFile(
  join(workspace, '.dsh', 'showme', 'with-receipt.html'),
  `<div class="card" data-id="pain-a">x</div><textarea readonly></textarea>${POST}`,
  'utf8',
)
const withReceipt = await tool.execute({ path: '.dsh/showme/with-receipt.html' }, exec)
check('id + postMessage 都有的页面不提醒', () => assert.equal(withReceipt.hint, ''))

// 关键回归：只有"可复制文本"、没有 postMessage —— 这正是"回执还得自己抄"的那一类。
await writeFile(
  join(workspace, '.dsh', 'showme', 'copy-only.html'),
  '<div class="card" data-id="pain-a">x</div><textarea readonly></textarea>'
    + '<button>全选下面的文本</button>',
  'utf8',
)
const copyOnly = await tool.execute({ path: '.dsh/showme/copy-only.html' }, exec)
check('只给"可复制文本"、不走通道的页面会被点名', () => {
  // 认「缺的是什么」那一段，而不是整段文案——说明里本来就会提到 postMessage。
  assert.match(copyOnly.hint, /postMessage` hook-up/)
  assert.ok(!/pointable ids\s*\+/.test(copyOnly.hint), 'id 没缺，不该被算进 missing')
})

// 反向的一半：走了通道，但没有可点名的 id。
await writeFile(
  join(workspace, '.dsh', 'showme', 'no-ids.html'),
  `<textarea readonly></textarea>${POST}`,
  'utf8',
)
const noIds = await tool.execute({ path: '.dsh/showme/no-ids.html' }, exec)
check('只做了一半（有通道没有 id）仍会被提醒', () => {
  assert.match(noIds.hint, /pointable ids/)
  assert.ok(!/postMessage` hook-up/.test(noIds.hint), '通道那半边不该被点名')
})

// ── 关键回归：交互写在外链脚本里时不能误报 ─────────────────────────────
// 实测现场：模板外壳只有 548 字节，回执逻辑全在 templates/core.js 里，
// 只扫页面本体会被自己的检查咬到。
console.log('\n[工具] 外链脚本也要扫')

await writeFile(
  join(workspace, '.dsh', 'showme', 'kernel.js'),
  'var html = \'<div data-id="a">x</div>\'; '
    + 'parent.postMessage({ type: "dsh-showme-feedback", text: html }, "*");',
  'utf8',
)
await writeFile(
  join(workspace, '.dsh', 'showme', 'shell.html'),
  '<div class="page"><div id="sm-content"></div></div><script src="kernel.js"></script>',
  'utf8',
)
const shell = await tool.execute({ path: '.dsh/showme/shell.html' }, exec)
check('回执在外链脚本里时通过（模板页就是这种形状）', () => assert.equal(shell.hint, ''))

await writeFile(
  join(workspace, '.dsh', 'showme', 'kernel-empty.js'),
  'console.log("这里什么都没有")',
  'utf8',
)
await writeFile(
  join(workspace, '.dsh', 'showme', 'shell-empty.html'),
  '<div class="page"><div id="sm-content"></div></div><script src="kernel-empty.js"></script>',
  'utf8',
)
const shellEmpty = await tool.execute({ path: '.dsh/showme/shell-empty.html' }, exec)
check('外链脚本里也没有回执时，照样被点名', () => assert.match(shellEmpty.hint, /Host check/))

// ── 引用体检：页面引的相对资源必须真的存在 ──────────────────────────────
// 注意：这两个夹具都带上 POST，把回执那半边做干净，
// 这样 hint 里剩下的只可能是引用问题。
console.log('\n[工具] 引用体检')

await writeFile(
  join(workspace, '.dsh', 'showme', 'dangling.html'),
  `<div data-id="a">x</div><textarea readonly></textarea>${POST}`
    + '<img src="stills/missing.png"><link href="presets/soft.css" rel="stylesheet">',
  'utf8',
)
const dangling = await tool.execute({ path: '.dsh/showme/dangling.html' }, exec)
check('引用不存在的图片会被点名', () => assert.match(dangling.hint, /stills\/missing\.png/))
check('回执那半边做干净了（不夹带回执提醒）', () => assert.ok(!/pointable ids/.test(dangling.hint)))
check('预设引用不误报（宿主这次调用刚落地过）', () =>
  assert.ok(!/presets\/soft\.css/.test(dangling.hint), '预设不该被当成缺失资源'),
)

await mkdir(join(workspace, '.dsh', 'showme', 'stills'), { recursive: true })
await writeFile(join(workspace, '.dsh', 'showme', 'stills', 'missing.png'), 'x', 'utf8')
const fixed = await tool.execute({ path: '.dsh/showme/dangling.html' }, exec)
check('把文件补上之后就不再提醒', () => assert.equal(fixed.hint, ''))

await writeFile(
  join(workspace, '.dsh', 'showme', 'abs-refs.html'),
  `<div data-id="a">x</div><textarea readonly></textarea>${POST}`
    + '<a href="https://example.com/x.html">外链</a><a href="#top">锚点</a><img src="/api/x.png">',
  'utf8',
)
const absRefs = await tool.execute({ path: '.dsh/showme/abs-refs.html' }, exec)
check('绝对 / 协议 / 锚点引用不参与检查', () => assert.equal(absRefs.hint, ''))

// ── 预设样式落地（create-only） ──────────────────────────────────────────
console.log('\n[工具] 预设样式落地')

const presetDir = join(workspace, '.dsh', 'showme', 'presets')
const presetIndex = JSON.parse(await readFile(join(presetDir, 'index.json'), 'utf8'))
check('show_html 顺带把预设清单落到工作区', () => assert.equal(typeof presetIndex.default, 'string'))

const landed = await readdir(presetDir)
check('清单里的每一套都落地了', () => {
  for (const preset of presetIndex.presets) {
    assert.ok(landed.includes(preset.file), `缺 ${preset.file}`)
  }
})
const softOnDisk = await readFile(join(presetDir, 'soft.css'), 'utf8')
check('落地的 soft.css 有实际体量', () =>
  assert.ok(softOnDisk.length > 3000, `只有 ${softOnDisk.length} 字节`),
)

// create-only：你改过的预设不能被下一次展示覆盖
await writeFile(join(presetDir, 'soft.css'), '/* mine */', 'utf8')
await tool.execute({ path: '.dsh/showme/review.html' }, exec)
const afterRerun = await readFile(join(presetDir, 'soft.css'), 'utf8')
check('create-only：不覆盖你改过的预设', () => assert.equal(afterRerun, '/* mine */'))

// ── 新工作区的第一步：资产要在**校验之前**落地 ──────────────────────────
// 现场：agent 按 skill 去 `cp .dsh/showme/templates/review.html`，报 no such file ——
// 因为落地原来排在流程末尾，而它需要资产的那个动作排在流程开头。
// 现在的约定：随便调一次 show_html（哪怕注定失败）就能把资产催出来。
console.log('\n[工具] 失败的调用也要能把资产催出来')

const freshWorkspace = await mkdtemp(join(tmpdir(), 'showme-fresh-'))
const freshExec = { agent: { session: { header: { cwd: freshWorkspace } } } }

await assert.rejects(() => tool.execute({ path: '.dsh/showme/does-not-exist.html' }, freshExec), /cannot find/)

const freshTemplates = await readdir(join(freshWorkspace, '.dsh', 'showme', 'templates')).catch(() => [])
const freshPresets = await readdir(join(freshWorkspace, '.dsh', 'showme', 'presets')).catch(() => [])
check('调用失败了，但模板已经落地', () => {
  assert.ok(freshTemplates.includes('core.js'), 'templates/core.js 没落地')
  assert.ok(freshTemplates.includes('README.md'), 'templates/README.md 没落地')
})
check('预设也一并落地', () => assert.ok(freshPresets.includes('soft.css')))

await assert.rejects(() => tool.execute({ path: '.dsh/showme/x.md' }, freshExec), /only shows \.html/)
const afterBadExt = await readdir(join(freshWorkspace, '.dsh', 'showme', 'templates')).catch(() => [])
check('扩展名不对的调用同样能催出资产', () => assert.ok(afterBadExt.includes('core.js')))

const cases = [
  [{ path: '' }, exec, /non-empty/],
  [{ path: 'notes.md' }, exec, /only shows \.html/],
  [{ path: '.dsh/showme/nope.html' }, exec, /cannot find/],
  [{ path: `../${escapeTargetName}` }, exec, /escapes the session workspace/],
  [{ path: 'decoy.html' }, exec, /not a regular file/],
  [{ path: '.dsh/showme/review.html' }, { agent: { session: { header: {} } } }, /requires an open workspace/],
]
for (const [args, context, pattern] of cases) {
  await assert.rejects(() => tool.execute(args, context), pattern)
}
check('六种非法输入都被拒绝并给出可行动文本', () => true)

// ── mermaid：注入 / vendor / 回执 / 预检 ─────────────────────────────────
// 这一组全部在**同一个 http server 还活着**的时候跑，所以放在 server.close() 之前。
console.log('\n[mermaid] 注入与 vendor')

const goodDiagram = '<!doctype html><html><body><pre class="mermaid">graph TD; A[开始] --> B[结束]</pre></body></html>'
await writeFile(join(workspace, '.dsh', 'showme', 'diagram.html'), goodDiagram, 'utf8')

const brokenDiagram = '<!doctype html><html><body><pre class="mermaid">graph TD; A--></pre></body></html>'
await writeFile(join(workspace, '.dsh', 'showme', 'broken.html'), brokenDiagram, 'utf8')

const injected = await rawRequest(raw('.dsh/showme/diagram.html'))
check('含 mermaid 块的页面 200', () => assert.equal(injected.status, 200))
check('注入了引导脚本（防重复注入的那行在）', () =>
  assert.match(injected.body, /__showmeMermaidBoot/),
)
check('引导脚本在 </body> 之前', () => {
  const at = injected.body.lastIndexOf('__showmeMermaidBoot')
  assert.ok(at > 0 && at < injected.body.toLowerCase().lastIndexOf('</body>'))
})
check('注入后 content-length 与正文一致', () =>
  assert.equal(Number(injected.headers['content-length']), Buffer.byteLength(injected.body)),
)
check('注入没有破坏 CSP sandbox', () => assert.match(injected.headers['content-security-policy'] ?? '', /sandbox/))

const plainPage = await rawRequest(raw('.dsh/showme/review.html'))
check('不含 mermaid 的页面与磁盘逐字节相同', () => assert.equal(plainPage.body, pageBody))
check('不含 mermaid 的页面 content-length 仍是文件大小', () =>
  assert.equal(Number(plainPage.headers['content-length']), Buffer.byteLength(pageBody)),
)

const vendor = await rawRequest(`${base}/vendor/mermaid.min.js`)
check('vendor 路由 200', () => assert.equal(vendor.status, 200))
check('vendor 是普通脚本', () => assert.match(vendor.headers['content-type'], /^text\/javascript/))
check('vendor 可长期缓存', () => assert.match(vendor.headers['cache-control'] ?? '', /immutable/))
check('vendor 正文非空且是 mermaid bundle', () => assert.ok(vendor.body.length > 1_000_000))
const vendorBytes = await readFile(join(here, '..', 'vendor', 'mermaid.min.js'), 'utf8')
check('vendor 发出的字节数等于文件大小', () => assert.equal(vendor.body.length, vendorBytes.length))

const vendorHead = await rawRequest(`${base}/vendor/mermaid.min.js`, { method: 'HEAD' })
check('vendor HEAD 200 且无正文', () => assert.equal(vendorHead.status, 200) && assert.equal(vendorHead.body, ''))

const vendorMissing = await rawRequest(`${base}/vendor/nope.min.js`)
check('白名单外的 vendor 文件名 404', () => assert.equal(vendorMissing.status, 404))

const vendorTraversal = await rawRequest(`${base}/vendor/%2e%2e%2f%2e%2e%2fpackage.json`)
check('vendor 里的穿越尝试不是 200', () => assert.notEqual(vendorTraversal.status, 200))

console.log('\n[mermaid] 渲染回执')

const onePixelPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const receipt = {
  sessionId: 'live-session',
  page: '.dsh/showme/diagram.html',
  ok: true,
  diagrams: [{ index: 1, type: 'flowchart-v2', error: null, png: `data:image/png;base64,${onePixelPng.toString('base64')}` }],
}
const receiptResponse = await rawRequest(`${base}/mermaid`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(receipt),
})
check('回执 200', () => assert.equal(receiptResponse.status, 200))

const receiptBody = JSON.parse(receiptResponse.body)
const savedPngPath = receiptBody.diagrams[0]?.png ?? ''
check('回执里回报了落盘文件', () =>
  assert.match(savedPngPath, /^\.dsh\/showme\/mermaid\/[0-9a-f]{8}\/diagram\.1\.png$/),
)

const savedPng = await readFile(join(workspace, savedPngPath)).catch(() => null)
check('PNG 落盘且字节对得上', () => assert.ok(savedPng !== null) && assert.deepEqual([...savedPng], [...onePixelPng]))

const savedJsonPath = (receiptBody.files ?? []).find((file) => file.endsWith('.json')) ?? ''
const savedJson = JSON.parse(
  await readFile(join(workspace, savedJsonPath), 'utf8').catch(() => 'null'),
)
check('回执 JSON 记下了图类型与 ok', () => {
  assert.equal(savedJson.ok, true)
  assert.equal(savedJson.diagrams[0].type, 'flowchart-v2')
  assert.equal(savedJson.diagrams[0].png, savedPngPath)
})
check('JSON 与 PNG 落在同一页目录里', () => assert.equal(dirname(savedJsonPath), dirname(savedPngPath)))

const failedReceipt = await rawRequest(`${base}/mermaid`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    sessionId: 'live-session',
    page: '.dsh/showme/diagram.html',
    ok: false,
    diagrams: [{ index: 1, type: 'flowchart-v2', error: 'boom from browser', png: null }],
  }),
})
check('失败回执也 200（不是错误，是状态）', () => assert.equal(failedReceipt.status, 200))
const failedBody = JSON.parse(failedReceipt.body)
const errorsPath = (failedBody.files ?? []).find((file) => file.endsWith('.errors.txt')) ?? ''
const errorsTxt = await readFile(join(workspace, errorsPath), 'utf8').catch(() => '')
check('失败时写下 errors.txt', () => assert.match(errorsTxt, /boom from browser/))

const unknownReceipt = await rawRequest(`${base}/mermaid`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 'no-such-session', page: 'x.html', ok: true, diagrams: [] }),
})
check('未知会话的回执 404', () => assert.equal(unknownReceipt.status, 404))

// 页面没展示过 / 不存在：不许落产物。0.3.4 之前不查存在性，随手编一个路径也能催出文件。
const ghostReceipt = await rawRequest(`${base}/mermaid`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    sessionId: 'live-session',
    page: 'a/ghost.html',
    ok: true,
    diagrams: [{ index: 1, type: 'flowchart-v2', error: null, png: `data:image/png;base64,${onePixelPng.toString('base64')}` }],
  }),
})
check('回执指向不存在的页面 → 404', () => assert.equal(ghostReceipt.status, 404))
const mermaidTree = await readdir(join(workspace, '.dsh', 'showme', 'mermaid'), { recursive: true }).catch(() => [])
check('不存在的页面不会催出 PNG', () =>
  assert.equal(mermaidTree.some((file) => String(file).endsWith('ghost.1.png')), false),
)

// 同名页面在不同目录：产物必须各有各的目录，不能互相覆盖（0.3.4 的修复点）。
await mkdir(join(workspace, 'a'), { recursive: true })
await mkdir(join(workspace, 'b'), { recursive: true })
await writeFile(join(workspace, 'a', 'review.html'), '<html></html>', 'utf8')
await writeFile(join(workspace, 'b', 'review.html'), '<html></html>', 'utf8')
/**
 * 给某个页面发一条一像素的渲染回执。
 * @param page - 页面在工作区里的相对路径。
 * @returns `{ status, body }`（body 已解析）。
 */
async function sendReceipt(page) {
  const response = await rawRequest(`${base}/mermaid`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: 'live-session',
      page,
      ok: true,
      diagrams: [{ index: 1, type: 'flowchart-v2', error: null, png: `data:image/png;base64,${onePixelPng.toString('base64')}` }],
    }),
  })
  return { status: response.status, body: JSON.parse(response.body) }
}
const clashA = await sendReceipt('a/review.html')
const clashB = await sendReceipt('b/review.html')
const clashJsonA = (clashA.body.files ?? []).find((file) => file.endsWith('.json')) ?? ''
const clashJsonB = (clashB.body.files ?? []).find((file) => file.endsWith('.json')) ?? ''
check('同名页面：各落各的目录', () => {
  assert.equal(clashA.status, 200)
  assert.equal(clashB.status, 200)
  assert.notEqual(dirname(clashJsonA), dirname(clashJsonB))
})
const recordA = JSON.parse(await readFile(join(workspace, clashJsonA), 'utf8').catch(() => 'null'))
const recordB = JSON.parse(await readFile(join(workspace, clashJsonB), 'utf8').catch(() => 'null'))
check('同名页面：两份记录都指回自己那一页', () => {
  assert.equal(recordA.page, 'a/review.html')
  assert.equal(recordB.page, 'b/review.html')
})
// 归一：浏览器会把 `./` 吃掉；工具侧与回执必须算出同一个目录，否则预告的路径对不上。
const normalizedReceipt = await sendReceipt('./a/review.html')
const normalizedJson = (normalizedReceipt.body.files ?? []).find((file) => file.endsWith('.json')) ?? ''
check('回执里的 ./ 归一后落到同一页目录', () => assert.equal(dirname(normalizedJson), dirname(clashJsonA)))

const notPost = await rawRequest(`${base}/mermaid`)
check('回执路由 GET → 405', () => assert.equal(notPost.status, 405))

// 超过 8 MB：只验证会被拒（不真的把 8 MB 解析完）。
const huge = await rawRequest(`${base}/mermaid`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: 'x'.repeat(8 * 1024 * 1024 + 64),
})
check('回执超过 8 MB → 413', () => assert.equal(huge.status, 413))

console.log('\n[工具] mermaid 语法预检')

const goodResult = await tool.execute({ path: '.dsh/showme/diagram.html' }, exec)
check('好图：工具返回里带 mermaid 结果', () => {
  assert.equal(goodResult.mermaid.count, 1)
  assert.equal(goodResult.mermaid.checked, true)
  assert.deepEqual(goodResult.mermaid.types, ['flowchart-v2'])
})
check('好图：提前给出可预测的 PNG 路径', () => {
  assert.equal(goodResult.mermaid.png.length, 1)
  assert.match(goodResult.mermaid.png[0], /^\.dsh\/showme\/mermaid\/[0-9a-f]{8}\/diagram\.1\.png$/)
})
check('好图：预告的路径就是回执真正落盘的那一个', () =>
  assert.equal(goodResult.mermaid.png[0], savedPngPath),
)
check('好图：hint 里告诉模型去哪看图', () => assert.match(goodResult.hint, /read_image/))

await assert.rejects(
  () => tool.execute({ path: '.dsh/showme/broken.html' }, exec),
  /mermaid 有 1 处写错了/,
)
check('坏图：这次调用直接失败（页面不通过）', () => true)

const brokenAgain = await tool.execute({ path: '.dsh/showme/broken.html' }, exec).then(
  () => null,
  (error) => error,
)
check('坏图：报错里带 mermaid 原文（含 Parse error 与 ^ 指位）', () => {
  assert.match(brokenAgain.message, /Parse error on line 2/)
  assert.match(brokenAgain.message, /-+\^/)
})
check('坏图：报错里说清楚是第几个图、什么类型', () =>
  assert.match(brokenAgain.message, /第 1 个图（flowchart-v2）/),
)

const plainResult = await tool.execute({ path: '.dsh/showme/review.html' }, exec)
check('无 mermaid 的页面：count 为 0，不挡路', () => {
  assert.equal(plainResult.mermaid.count, 0)
  assert.equal(plainResult.mermaid.checked, true)
})

console.log('\\n[草稿] 刷新 / 切会话不丢')

// 草稿由卡片（同源）调用：页面在不透明源里自己 POST 会被跨域拦掉。
const draftPath = '.dsh/showme/review.html'
const draftPost = (body) =>
  rawRequest(`${base}/draft`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const draftGet = (session, page) =>
  rawRequest(`${base}/draft?session=${encodeURIComponent(session)}&page=${encodeURIComponent(page)}`)

const savedDraft = await draftPost({
  sessionId: 'live-session',
  page: draftPath,
  verdicts: { 'hero-v3': '同意', 'stats-panel': '要改' },
  notes: { 'stats-panel': '数字太小' },
})
check('草稿写入 200', () => assert.equal(savedDraft.status, 200))
check('草稿写入回执', () => {
  const body = JSON.parse(savedDraft.body)
  assert.equal(body.ok, true)
  assert.equal(body.saved, true)
  assert.match(body.path, /^\.dsh\/showme\/drafts\/[0-9a-f]{40}\.json$/)
})

const readBack = await draftGet('live-session', draftPath)
check('草稿读回：判定与备注都在', () => {
  const draft = JSON.parse(readBack.body).draft
  assert.ok(draft !== null, '没读到草稿')
  assert.equal(draft.verdicts['hero-v3'], '同意')
  assert.equal(draft.verdicts['stats-panel'], '要改')
  assert.equal(draft.notes['stats-panel'], '数字太小')
  assert.equal(typeof draft.updatedAt, 'string')
})

const draftNames = await readdir(join(workspace, '.dsh', 'showme', 'drafts')).catch(() => [])
check('草稿落在工作区的 drafts 目录里（不进 git）', () =>
  assert.ok(draftNames.filter((name) => name.endsWith('.json')).length >= 1, '没落盘'),
)

const noDraft = await draftGet('live-session', 'stills/none.html')
check('没有草稿：回 draft: null（不是 404）', () => {
  assert.equal(noDraft.status, 200)
  assert.equal(JSON.parse(noDraft.body).draft, null)
})

const cleared = await draftPost({ sessionId: 'live-session', page: draftPath, clear: true })
check('清空：真的删掉', () => assert.equal(JSON.parse(cleared.body).cleared, true))
const afterClear = await draftGet('live-session', draftPath)
check('清空后读回是 null', () => assert.equal(JSON.parse(afterClear.body).draft, null))

const unknownDraft = await draftPost({ sessionId: 'no-such-session', page: draftPath, verdicts: {} })
check('未知会话：404（不往错的地方写）', () => assert.equal(unknownDraft.status, 404))

const escapeDraft = await draftPost({ sessionId: 'live-session', page: '../escape.html', verdicts: {} })
check('页面路径越界：403', () => assert.equal(escapeDraft.status, 403))

const bigDraft = await draftPost({
  sessionId: 'live-session',
  page: draftPath,
  notes: { big: 'x'.repeat(80 * 1024) },
})
check('草稿过大：413', () => assert.equal(bigDraft.status, 413))

const putDraft = await rawRequest(`${base}/draft`, { method: 'PUT' })
check('PUT：405', () => assert.equal(putDraft.status, 405))

// 过期清理：塞一个 40 天前的草稿文件，再写一份新的，老的那份应该被顺手清掉。
const draftDir = join(workspace, '.dsh', 'showme', 'drafts')
const staleName = createHash('sha1').update('live-session\\nstale-page.html').digest('hex')
const stalePath = join(draftDir, `${staleName}.json`)
await writeFile(stalePath, '{"verdicts":{}}\\n', 'utf8')
const staleAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
await utimes(stalePath, staleAt, staleAt)
await draftPost({ sessionId: 'live-session', page: draftPath, verdicts: { 'hero-v3': '不要' } })
const afterPrune = await readdir(draftDir)
check('过期草稿被顺手清掉（30 天）', () =>
  assert.ok(!afterPrune.includes(`${staleName}.json`), '40 天前的草稿还在'),
)

console.log('\\n[markdown] 结构型 md 就当场失败，行内不拦')

// 模板页 = 同目录有同名 .data.js。数据里写 md 表格 → 这次调用应该直接失败。
await writeFile(join(workspace, '.dsh', 'showme', 'md-bad.html'), pageBody, 'utf8')
await writeFile(
  join(workspace, '.dsh', 'showme', 'md-bad.data.js'),
  [
    'window.SHOWME = {',
    "  title: 'x',",
    '  sections: [{',
    "    heading: 'h',",
    '    blocks: [',
    "      { type: 'text', text: '| a | b |\\n|---|---|' },",
    '    ],',
    '  }],',
    '}',
  ].join('\n'),
  'utf8',
)
const mdBad = await tool.execute({ path: '.dsh/showme/md-bad.html' }, exec).then(
  () => null,
  (error) => error,
)
check('数据里有 md 表格：这次调用失败', () => {
  assert.ok(mdBad !== null, 'md 表格没被拦下来')
  assert.match(mdBad.message, /markdown 结构语法/)
})
check('错误里点名该用哪个块', () => assert.match(mdBad.message, /table 块/))
check('错误里给出逃生阀（plain: true）', () => assert.match(mdBad.message, /plain: true/))

// 加了 plain: true 就跳过结构检查（作者明确要显示原文）。
await writeFile(join(workspace, '.dsh', 'showme', 'md-plain.html'), pageBody, 'utf8')
await writeFile(
  join(workspace, '.dsh', 'showme', 'md-plain.data.js'),
  [
    'window.SHOWME = {',
    "  title: 'x',",
    '  sections: [{',
    "    heading: 'h',",
    '    blocks: [',
    "      { type: 'text', plain: true, text: '| a | b |\\n|---|---|' },",
    '    ],',
    '  }],',
    '}',
  ].join('\n'),
  'utf8',
)
const mdPlain = await tool.execute({ path: '.dsh/showme/md-plain.html' }, exec).then(
  () => null,
  (error) => error,
)
check('加了 plain: true：放行', () => assert.equal(mdPlain, null, String(mdPlain && mdPlain.message)))

// 手写页（没有同名数据文件）不受这条检查影响。
await writeFile(join(workspace, '.dsh', 'showme', 'md-hand.html'), '<h1>| a | b |</h1>', 'utf8')
const mdHand = await tool.execute({ path: '.dsh/showme/md-hand.html' }, exec).then(
  () => null,
  (error) => error,
)
check('手写页（没有数据文件）：不误报', () =>
  assert.equal(mdHand, null, String(mdHand && mdHand.message)),
)

console.log('\\n[偏好] 用户级 prefs（<DSH_HOME>/showme/prefs.json）')

// 注意：prefs 落在 DSH_HOME，测试期间必须指到临时目录，
// 绝不能碰用户真实的 ~/.dsh/showme/prefs.json。
const prefsHome = await mkdtemp(join(tmpdir(), 'dsh-prefs-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = prefsHome

const getPrefs = () => rawRequest(`${base}/prefs`)
const postPrefs = (body) =>
  rawRequest(`${base}/prefs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const prefsDefault = await getPrefs()
check('没有偏好文件：回默认值', () => {
  const prefs = JSON.parse(prefsDefault.body).prefs
  assert.equal(prefs.autoOpenSidebar, true)
  assert.equal(prefs.pagePolicy, 'off')
  assert.equal(prefs.planPage, 'offer')
  assert.equal(prefs.planPageOpenOnReview, true)
})

await postPrefs({ planPage: 'require', autoOpenSidebar: false, pagePolicy: 'prefer' })
const prefsAfter = JSON.parse((await getPrefs()).body).prefs
check('写入后再读：改过的值生效', () => {
  assert.equal(prefsAfter.planPage, 'require')
  assert.equal(prefsAfter.autoOpenSidebar, false)
  assert.equal(prefsAfter.pagePolicy, 'prefer')
})
const savedPrefs = JSON.parse(await readFile(join(prefsHome, 'showme', 'prefs.json'), 'utf8'))
check('偏好落在 $DSH_HOME/showme/prefs.json', () => {
  assert.equal(savedPrefs.planPage, 'require')
  assert.equal(savedPrefs.pagePolicy, 'prefer')
})

const prefsJunk = JSON.parse((await postPrefs({ planPage: 'nonsense', pagePolicy: 'sometimes', hack: 1 })).body).prefs
check('非法档位与未知键被忽略', () => {
  assert.equal(prefsJunk.planPage, 'require')
  assert.equal(prefsJunk.pagePolicy, 'prefer')
  assert.equal('hack' in prefsJunk, false)
})

// 计划页提示只该在 plan 模式激活时注入（拿不到状态时 fail-open）。
const planSection = captured.promptSections.find((one) => one.name === 'showme:plan-page')
check('计划页提示：plan 模式未激活 → 不注入', () => {
  assert.ok(planSection !== undefined, 'systemPrompt 段没注册')
  assert.equal(planSection.text({ agent: { session: 'idle' } }), '')
})
check('计划页提示：激活 → 注入，且带「展示页：」锚点', () => {
  const text = planSection.text({ agent: { session: 'plan-on' } })
  assert.ok(text.length > 80, '这段太短，像没注入')
  assert.ok(text.includes('展示页：'), '缺少 markdown 锚点说明')
})
check('计划页提示：缺服务 / 读状态抛错 → 照旧注入（fail-open）', () => {
  const saved = services.planMode
  try {
    services.planMode = undefined
    assert.ok(planSection.text({ agent: { session: 'idle' } }).length > 0, '缺服务时不该静默')
    services.planMode = { loggedActive: () => { throw new Error('projection missing') } }
    assert.ok(planSection.text({ agent: { session: 'idle' } }).length > 0, '抛错时不该静默')
  } finally {
    services.planMode = saved
  }
})
check('计划页提示：没有 agent 上下文 → 空串', () => {
  assert.equal(planSection.text({}), '')
})

// ---------- 回答形态（Showme Often 的插件内版本） ----------

const policySection = captured.promptSections.find((one) => one.name === 'showme:page-policy')
const withAgent = { agent: { session: 's1' } }

check('回答形态提示：注册了 showme:page-policy，且早于计划策略', () => {
  assert.ok(policySection !== undefined, 'systemPrompt 段没注册')
  assert.ok(policySection.order < planSection.order, '两段的顺序不对')
  assert.ok(Number.isFinite(policySection.order), 'order 必须是有限数，宿主会拒收')
})

// 上面几轮已经把 pagePolicy 写成了 prefer，这里先显式回到 off 再测。
await postPrefs({ pagePolicy: 'off' })
check('回答形态提示：off → 一个字都不注入', () => {
  assert.equal(policySection.text(withAgent), '')
})

await postPrefs({ pagePolicy: 'prefer' })
const preferText = policySection.text(withAgent)
check('回答形态提示：prefer → 讲「默认做页」，并点名可纯文字的两个例外', () => {
  assert.ok(preferText.length > 200, '太短，像没注入')
  assert.match(preferText, /showme page/)
  assert.match(preferText, /show_html/)
  assert.match(preferText, /showme-report/)
  assert.match(preferText, /postMessage/)
  assert.match(preferText, /plain text/)
  assert.equal(policySection.text({}), '', '没有 agent 时不该注入')
})

await postPrefs({ pagePolicy: 'always' })
check('回答形态提示：always → 每条都出页，正文限五行', () => {
  const text = policySection.text(withAgent)
  assert.match(text, /always answer with a showme page/)
  assert.match(text, /five lines/)
  assert.notEqual(text, preferText, 'always 与 prefer 不该是同一段文字')
})

await postPrefs({ pagePolicy: 'off' })
check('回答形态提示：再切回 off → 恢复空串', () => {
  assert.equal(policySection.text(withAgent), '')
})

const prefsPut = await rawRequest(`${base}/prefs`, { method: 'PUT' })
check('prefs 的 PUT：405', () => assert.equal(prefsPut.status, 405))

if (previousHome === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = previousHome

console.log('\\n[图片] 缺图就当场失败')

await writeFile(join(workspace, '.dsh', 'showme', 'img-bad.html'), pageBody, 'utf8')
await writeFile(
  join(workspace, '.dsh', 'showme', 'img-bad.data.js'),
  "window.SHOWME = { title: 'x', sections: [{ heading: 'h', items: [{ id: 'a', title: 'A', image: 'stills/nope.png' }] }] }\n",
  'utf8',
)
const imgBad = await tool.execute({ path: '.dsh/showme/img-bad.html' }, exec).then(
  () => null,
  (error) => error,
)
check('image 指向不存在的文件：调用失败', () => {
  assert.ok(imgBad !== null, '缺图没被拦下来')
  assert.match(imgBad.message, /不存在的图片/)
  assert.match(imgBad.message, /stills\/nope\.png/)
})

await writeFile(join(workspace, '.dsh', 'showme', 'img-ok.html'), pageBody, 'utf8')
await writeFile(
  join(workspace, '.dsh', 'showme', 'img-ok.data.js'),
  "window.SHOWME = { title: 'x', sections: [{ heading: 'h', items: [{ id: 'a', title: 'A', image: '../../stills/a.png' }] }] }\n",
  'utf8',
)
const imgOk = await tool.execute({ path: '.dsh/showme/img-ok.html' }, exec).then(
  () => null,
  (error) => error,
)
check('图存在：放行', () => assert.equal(imgOk, null, String(imgOk && imgOk.message)))

console.log('\\n[散文条目] 长段落塞进条目位就当场失败')

// 判据三条：desc 超 240 字 / 含空行 / 含列表或表格行。这里逐个走一遍。
const longDesc = '`db/schema/30-demo.sql:39-42` 的 `ck_demos_erased` 只校验 title、description、cover_url，漏了 guest_name；`122-128` 的 `ck_rev_erased_content` 校验十二列，漏了 single_file 和 external_url。'.repeat(2)
await writeFile(join(workspace, '.dsh', 'showme', 'prose-bad.html'), pageBody, 'utf8')
await writeFile(
  join(workspace, '.dsh', 'showme', 'prose-bad.data.js'),
  `window.SHOWME = { title: 'x', sections: [{ heading: 'h', items: [{ id: 'p0-3', title: '擦除约束', desc: ${JSON.stringify(longDesc)} }] }] }\n`,
  'utf8',
)
const proseBad = await tool.execute({ path: '.dsh/showme/prose-bad.html' }, exec).then(
  () => null,
  (error) => error,
)
check('desc 超长：调用失败并点名 id', () => {
  assert.ok(proseBad !== null, '长段落没被拦下来')
  assert.match(proseBad.message, /长段落写进了条目位/)
  assert.match(proseBad.message, /p0-3/)
  assert.match(proseBad.message, /上限 240/)
})
check('错误里给出该搬去哪个块', () => {
  assert.match(proseBad.message, /callout/)
  assert.match(proseBad.message, /kv/)
  assert.match(proseBad.message, /table/)
})
check('错误里给出逃生阀（plain: true）', () => assert.match(proseBad.message, /plain: true/))

// 空行分段：两段合成一条，也是"条目冒充文档"。
await writeFile(join(workspace, '.dsh', 'showme', 'prose-blank.html'), pageBody, 'utf8')
await writeFile(
  join(workspace, '.dsh', 'showme', 'prose-blank.data.js'),
  "window.SHOWME = { title: 'x', candidates: [{ id: 'a', title: 'A', desc: '第一段。' + String.fromCharCode(10).repeat(3) + '第二段。' }] }",
  'utf8',
)
const proseBlank = await tool.execute({ path: '.dsh/showme/prose-blank.html' }, exec).then(
  () => null,
  (error) => error,
)
check('desc 里有空行分段：调用失败', () => {
  assert.ok(proseBlank !== null, '空行分段没被拦下来')
  assert.match(proseBlank.message, /空行分段/)
})

// 列表行：条目里在写结构。
await writeFile(join(workspace, '.dsh', 'showme', 'prose-list.html'), pageBody, 'utf8')
await writeFile(
  join(workspace, '.dsh', 'showme', 'prose-list.data.js'),
  "window.SHOWME = { title: 'x', candidates: [{ id: 'a', title: 'A', desc: '要做三件事：' + String.fromCharCode(10) + '- 写迁移' + String.fromCharCode(10) + '- 补文档' }] }",
  'utf8',
)
const proseList = await tool.execute({ path: '.dsh/showme/prose-list.html' }, exec).then(
  () => null,
  (error) => error,
)
check('desc 里有列表行：调用失败', () => {
  assert.ok(proseList !== null, '列表行没被拦下来')
  assert.match(proseList.message, /列表行/)
})

// 一句话：正常放行（这条同时守住"别把正常页拦掉"）。
await writeFile(join(workspace, '.dsh', 'showme', 'prose-ok.html'), pageBody, 'utf8')
await writeFile(
  join(workspace, '.dsh', 'showme', 'prose-ok.data.js'),
  "window.SHOWME = { title: 'x', sections: [{ heading: 'h', items: [{ id: 'p0-3', title: '擦除约束', desc: '两条擦除约束各漏了列，写了迁移也不等于擦干净。' }] }] }\\n",
  'utf8',
)
const proseOk = await tool.execute({ path: '.dsh/showme/prose-ok.html' }, exec).then(
  () => null,
  (error) => error,
)
check('一句话的条目：放行', () => assert.equal(proseOk, null, String(proseOk && proseOk.message)))

// 逃生阀：作者明确说这份数据要长文。
await writeFile(join(workspace, '.dsh', 'showme', 'prose-plain.html'), pageBody, 'utf8')
await writeFile(
  join(workspace, '.dsh', 'showme', 'prose-plain.data.js'),
  `window.SHOWME = { title: 'x', plain: true, sections: [{ heading: 'h', items: [{ id: 'p0-3', title: 'T', desc: ${JSON.stringify(longDesc)} }] }] }\n`,
  'utf8',
)
const prosePlain = await tool.execute({ path: '.dsh/showme/prose-plain.html' }, exec).then(
  () => null,
  (error) => error,
)
check('加了 plain: true：跳过散文检查', () => assert.equal(prosePlain, null, String(prosePlain && prosePlain.message)))

// ── 条目内选项集（items[].options）：A/B 两条走法挑一条 ────────────────────
// 合法形状（两条走法 + 倾向）必须放行；写坏的（数量 / value / 重复 / preferred / why）当场失败。
const optGood = "window.SHOWME = { title: 'x', sections: [{ heading: 'h', items: [{ id: 'p1', title: 'hidden 详情页', desc: '两条路挑一条', preferred: 'A', options: [{ value: 'A', label: '详情 404', why: '§EN-1 说完全不可见' }, { value: 'B', label: '200 但不给预览', why: '要加 previewable 字段' }] }] }] }"
await writeFile(join(workspace, '.dsh', 'showme', 'opt-good.html'), pageBody, 'utf8')
await writeFile(join(workspace, '.dsh', 'showme', 'opt-good.data.js'), optGood + "\n", 'utf8')
const optGoodResult = await tool.execute({ path: '.dsh/showme/opt-good.html' }, exec).then(
  () => null,
  (error) => error,
)
check('两条走法 + preferred：放行', () => assert.equal(optGoodResult, null, String(optGoodResult && optGoodResult.message)))

/** 写一份选项集数据并跑一次 show_html，返回抛出的错误（没抛就是 null）。 */
async function runOptions(name, body) {
  await writeFile(join(workspace, '.dsh', 'showme', `opt-${name}.html`), pageBody, 'utf8')
  await writeFile(join(workspace, '.dsh', 'showme', `opt-${name}.data.js`), `window.SHOWME = ${body}\n`, 'utf8')
  return tool.execute({ path: `.dsh/showme/opt-${name}.html` }, exec).then(
    () => null,
    (error) => error,
  )
}

/** 一条 decision 的最小骨架，options 由参数给。 */
function decision(id, options, extra) {
  return `{ title: 'x', sections: [{ heading: 'h', items: [{ id: '${id}', title: 't', desc: '一句话', options: ${options}${extra ? ', ' + extra : ''} }] }] }`
}

// 只有 1 个选项：不是选择题（那是确认）。
const oneOption = await runOptions('one', decision('p1', "[{ value: 'A', label: '只有一条' }]"))
check('只有 1 个选项：调用失败，并说明要 2–4 个', () => {
  assert.ok(oneOption !== null, '1 个选项没被拦下来')
  assert.match(oneOption.message, /选项集/)
  assert.match(oneOption.message, /2–4/)
  assert.match(oneOption.message, /p1/)
})

// 5 个选项：用户不比较了，该拆页面。
const fiveOptions = await runOptions(
  'five',
  decision('p1', "[{ value: 'A' }, { value: 'B' }, { value: 'C' }, { value: 'D' }, { value: 'E' }]"),
)
check('5 个选项：调用失败', () => {
  assert.ok(fiveOptions !== null, '5 个选项没被拦下来')
  assert.match(fiveOptions.message, /2–4/)
})

// value 带空格：回执一行一条，value 就是那个词，不能有空格。
const spaced = await runOptions('spaced', decision('p1', "[{ value: 'A 404' }, { value: 'B' }]"))
check('value 带空格：调用失败', () => {
  assert.ok(spaced !== null, 'value 带空格没被拦下来')
  assert.match(spaced.message, /不能有空格/)
})

// 重复 value：回执里分不清是哪条。
const dup = await runOptions('dup', decision('p1', "[{ value: 'A' }, { value: 'A' }]"))
check('value 重复：调用失败', () => {
  assert.ok(dup !== null, '重复 value 没被拦下来')
  assert.match(dup.message, /重复/)
})

// preferred 指向不存在的 value。
const badPref = await runOptions('pref', decision('p1', "[{ value: 'A' }, { value: 'B' }]", "preferred: 'C'"))
check('preferred 指错：调用失败', () => {
  assert.ok(badPref !== null, 'preferred 指错没被拦下来')
  assert.match(badPref.message, /preferred/)
  assert.match(badPref.message, /C/)
})

// why 超长：理由是一段，不是一篇。
const longWhy = '理由很长。'.repeat(70)
const whyTooLong = await runOptions(
  'longwhy',
  decision('p1', `[{ value: 'A', why: ${JSON.stringify(longWhy)} }, { value: 'B' }]`),
)
check('why 超过 300 字：调用失败并点名 p1/A', () => {
  assert.ok(whyTooLong !== null, '超长理由没被拦下来')
  assert.match(whyTooLong.message, /上限 300/)
  assert.match(whyTooLong.message, /p1\/1/)
})

// why 里有空行分段：理由位不是文档位。
const whyBlank = await runOptions(
  'blankwhy',
  decision('p1', "[{ value: 'A', why: '第一段。' + String.fromCharCode(10).repeat(3) + '第二段。' }, { value: 'B' }]"),
)
check('why 里有空行分段：调用失败', () => {
  assert.ok(whyBlank !== null, '理由里的空行没被拦下来')
  assert.match(whyBlank.message, /空行分段/)
})

// candidates 上的 options 一律忽略（候选不是决策，概念不同）。
const pickOptions = await runOptions(
  'pick',
  "{ title: 'x', candidates: [{ id: 'a', title: 'A', options: [{ value: 'X' }] }] }",
)
check('pick 候选上的 options 被忽略：放行', () => assert.equal(pickOptions, null, String(pickOptions && pickOptions.message)))

// 数据文件里是**代码**而不是纯数据（vm 里跑不起来）：fail-open，不拦。
await writeFile(join(workspace, '.dsh', 'showme', 'prose-dyn.html'), pageBody, 'utf8')
await writeFile(
  join(workspace, '.dsh', 'showme', 'prose-dyn.data.js'),
  "window.SHOWME = { title: 'x', sections: [{ heading: 'h', items: (() => { null.x })() }] }\n",
  'utf8',
)
const proseDyn = await tool.execute({ path: '.dsh/showme/prose-dyn.html' }, exec).then(
  () => null,
  (error) => error,
)
check('数据文件在 vm 里跑不通：fail-open 放行', () => {
  assert.ok(proseDyn === null || !/长段落写进了条目位/.test(proseDyn.message), String(proseDyn && proseDyn.message))
})

server.close()

console.log('\n[路由] 服务缺失时靠工具记录兜底')

// 一个服务全缺的上下文：模拟路由所在的插件上下文里 ctx.get('sessions') /
// ctx.get('sessionQuery') 拿不到（Inspect 把两者都标成 optional）——
// 这正是线上"任何会话都回 unknown session"的成因。
const bare = { route: null, tool: null }
const bareCtx = {
  effect: (fn) => {
    const disposer = fn()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  webServer: {
    register: (route) => {
      bare.route = route
      return () => {}
    },
  },
  tools: {
    register: (definition) => {
      bare.tool = definition
      return () => {}
    },
  },
  get: () => undefined,
}
apply(bareCtx)

const bareServer = createServer((req, res) => bare.route.handler(req, res))
await new Promise((resolve) => bareServer.listen(0, '127.0.0.1', resolve))
const bareBase = `http://127.0.0.1:${bareServer.address().port}/api/showme`
/**
 * 对"服务全缺"那个服务器发一次请求。
 * @param pathname - /api/showme 之后的路径。
 */
async function bareGet(pathname) {
  const response = await fetch(`${bareBase}${pathname}`)
  return { status: response.status, body: await response.text() }
}

const beforeRecord = await bareGet('/raw/fresh-session/.dsh/showme/review.html')
check('未记录 + 服务缺失 → 404，并回报是哪个服务缺了', () => {
  assert.equal(beforeRecord.status, 404)
  assert.match(beforeRecord.body, /sessions=absent/)
  assert.match(beforeRecord.body, /sessionQuery=absent/)
})

const bareExec = { agent: { session: { id: 'fresh-session', header: { cwd: workspace } } } }
const recorded = await bare.tool.execute({ path: '.dsh/showme/review.html' }, bareExec)
check('工具执行时把 会话→工作区根 记了下来', () => assert.equal(recorded.bytes, Buffer.byteLength(pageBody)))
check('工具一并算好了给卡片用的地址', () =>
  assert.equal(recorded.url, '/api/showme/raw/fresh-session/.dsh/showme/review.html'),
)

const afterRecord = await bareGet('/raw/fresh-session/.dsh/showme/review.html')
check('记录之后路由就能服务了（即使服务全缺）', () => {
  assert.equal(afterRecord.status, 200)
  assert.equal(afterRecord.body, pageBody)
})

const bareEscape = await bareGet(`/raw/fresh-session/%2e%2e%2f${escapeTargetName}`)
check('记录来源同样受工作区围栏约束（403）', () => assert.equal(bareEscape.status, 403))

const neverShown = await bareGet('/raw/never-shown/.dsh/showme/review.html')
check('没展示过的会话仍然 404（不因为有了记录就放宽）', () => assert.equal(neverShown.status, 404))

bareServer.close()

// ── skill 投递兜底：链接在时不动，链接丢了就运行时注册顶上 ──────────────
console.log('\n[skill] 投递兜底')

const { parseSkillFile, installSkillFallback } = (await import('../lib/index.js')).__internals
const realSkill = await readFile(join(here, '..', 'skill', 'showme-report', 'SKILL.md'), 'utf8')

check('frontmatter 能被拆出来', () => {
  const { meta, body } = parseSkillFile(realSkill)
  assert.equal(meta.name, 'showme-report')
  assert.ok(meta.description.length > 20, 'description 太短，多半没解析到')
  assert.ok(meta.whenToUse.length > 10, 'whenToUse 没解析到')
  assert.ok(!body.startsWith('---'), '正文里还留着 frontmatter 分隔符')
  assert.match(body, /^#\s/m, '正文应当从标题开始')
})

check('skill 是索引不是手册：正文 ≤230 行，五份 references 齐且被指到', () => {
  const skillDir = join(here, '..', 'skill', 'showme-report')
  const lines = realSkill.split(String.fromCharCode(10)).length
  assert.ok(lines <= 230, `SKILL.md 有 ${lines} 行，超了 230 行的预算（细节挪进 references/）`)
  assert.ok(Buffer.byteLength(realSkill, 'utf8') <= 16 * 1024, 'SKILL.md 超过 16KB')
  for (const name of ['templates', 'layout', 'mermaid', 'sandbox', 'checklist']) {
    const text = readFileSync(join(skillDir, 'references', `${name}.md`), 'utf8')
    assert.ok(text.length > 800, `references/${name}.md 太短，像占位`)
    assert.ok(realSkill.includes(`references/${name}.md`), `SKILL.md 里没有指向 references/${name}.md`)
  }
})

check('代码与文档里引用的 skill §编号，SKILL.md 里都还在', () => {
  const root = join(here, '..')
  const files = [
    'lib/index.js', 'lib/client.js', 'templates/core.js', 'templates/README.md', 'README.md',
    'styles/soft.css', 'styles/swiss.css', 'styles/brutal.css', 'styles/blueprint.css',
  ]
  const found = new Set()
  for (const rel of files) {
    let text
    try {
      text = readFileSync(join(root, rel), 'utf8')
    } catch {
      continue
    }
    for (const m of text.matchAll(/skill\s*§\s*(\d+)(?:\.(\d+))?/g)) {
      found.add(m[2] ? `${m[1]}.${m[2]}` : m[1])
    }
  }
  assert.ok(found.size > 0, '一个 skill § 引用都没找到，这条守卫失效了')
  for (const num of found) {
    const pattern = num.includes('.') ? new RegExp(`^### ${num.replace('.', '\.')}(?![0-9])`, 'm')
      : new RegExp(`^## ${num}(?!\.\d)(?![0-9])`, 'm')
    assert.ok(pattern.test(realSkill), `文件里引用了 skill §${num}，但 SKILL.md 里没有对应的标题`)
  }
})

check('没有 frontmatter 时退化为全文，不抛', () => {
  const { meta, body } = parseSkillFile('# 裸文件\n\n正文')
  assert.deepEqual(meta, {})
  assert.equal(body, '# 裸文件\n\n正文')
})

/**
 * 造一个假 ctx。
 * @param withRegistry - 是否提供 skills 服务。
 */
function fakeSkillCtx(withRegistry) {
  const calls = []
  return {
    calls,
    ctx: {
      effect: (fn) => {
        fn()
        return () => {}
      },
      get: (key) =>
        withRegistry && key === 'skills'
          ? { register: (skill) => { calls.push(skill); return () => {} } }
          : undefined,
    },
  }
}

const linkedHome = await mkdtemp(join(tmpdir(), 'dsh-home-linked-'))
await mkdir(join(linkedHome, 'skills', 'showme-report'), { recursive: true })
await writeFile(join(linkedHome, 'skills', 'showme-report', 'SKILL.md'), realSkill, 'utf8')

const ctxWithLink = fakeSkillCtx(true)
check('链接在 → 什么都不做（保住热发现）', () => {
  assert.equal(installSkillFallback(ctxWithLink.ctx, linkedHome), 'skipped-linked')
  assert.equal(ctxWithLink.calls.length, 0, '链接在时不该注册，否则热发现会被静态内容盖掉')
})

const bareHome = await mkdtemp(join(tmpdir(), 'dsh-home-bare-'))
const ctxWithoutLink = fakeSkillCtx(true)
check('链接丢了 → 运行时注册顶上', () => {
  assert.equal(installSkillFallback(ctxWithoutLink.ctx, bareHome), 'registered')
  assert.equal(ctxWithoutLink.calls.length, 1)
  const skill = ctxWithoutLink.calls[0]
  assert.equal(skill.name, 'showme-report')
  assert.equal(skill.source, 'runtime')
  assert.ok(skill.description.length > 20)
  assert.match(skill.content, /^#\s/m, '注册的应当是正文，不该带 frontmatter')
  assert.equal(skill.resourceBase.kind, 'directory')
})

const noRegistry = fakeSkillCtx(false)
check('没有 skills 服务 → 安静放弃，不抛', () =>
  assert.equal(installSkillFallback(noRegistry.ctx, bareHome), 'unavailable'),
)

console.log(`\n全部通过：${checks} 项断言。\n`)
