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
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

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
const captured = { route: null, tool: null }
const services = {
  // 真实契约：`sessions.get(id)` 返回 Session，暴露的是 `header.cwd`（**没有 meta**）。
  // meta-session 是刻意留的形状容忍用例。
  sessions: {
    get: (id) => {
      if (id === 'live-session') return { header: { cwd: workspace } }
      if (id === 'meta-session') return { meta: { cwd: workspace } }
      return undefined
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

console.log(`\n全部通过：${checks} 项断言。\n`)
