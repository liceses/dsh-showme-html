/**
 * dsh-showme-html — 宿主半区。
 *
 * 本文件只做两件事：
 *
 *  1. 注册工具 `show_html`：agent 调它，就等于"把工作区里这一页 HTML 展示给用户"。
 *     这是本插件存在的理由——一个快捷入口，而不是又一个文件预览器。
 *
 *  2. 注册镜像读路由 `/api/showme/raw/<sessionId>/<工作区相对路径>`：
 *     它按工作区目录结构镜像分发文件，于是展示页里的相对引用天然可用
 *     （`<img src="stills/a.png">`、同目录的 `.css` / `.js`、`shot-f3.html`），
 *     写页面的 agent 不需要知道任何 URL 前缀。同一个地址也是
 *     "在浏览器打开原文件" 的目标。
 *
 * 另外提供 `POST /api/showme/feedback`，把用户在页面上的表态落到
 * `<工作区>/.dsh/showme/inbox.jsonl`（只追加），让反馈能快速回到 agent 手里。
 *
 * ── 为什么这里没有任何 `@deepseek-ai/*` 的运行时 import ──
 * 本插件以 `link:` 方式安装在工作区外的源码目录，Node 从真实路径向上找不到
 * profile 的 node_modules，宿主半区的外部 import 解析不了（同 profile 里
 * `dsh-text-drop` / `dsh-workspace-tree` 的宿主半区也都只 import node 内置模块）。
 * 因此工具定义按 `ToolDefinition` 契约**手写**：它继承自 `ToolSchema`
 * （{ name, description, parameters }，parameters 是调用方已编译好的 JSON Schema），
 * 外加 `output: { schema, render }` 与 `execute`。代价是参数校验要自己做，
 * 本文件在 execute 里显式做了。
 *
 * 所有使用的宿主服务（webServer / tools / sessions / sessionQuery / sandboxPolicy）
 * 都通过 `ctx` 结构化取用，不依赖任何类型包。
 */

import { createReadStream } from 'node:fs'
import { access, appendFile, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { extname, dirname, join, resolve, sep } from 'node:path'

/** Cordis 插件名，与 cordis.patch.yml 里的 id 一致。 */
export const name = 'showme-html'

/** 需要的宿主服务：`tools` 注册工具，`webServer` 注册镜像路由。 */
export const inject = ['tools', 'webServer']

/** 本插件独占的路由前缀。 */
const ROUTE_PREFIX = '/api/showme'

/** 工具名；也是客户端 `tool.call.toolview` 的 key。 */
const TOOL_NAME = 'show_html'

/** 单页大小上限，超限直接拒绝（避免把浏览器拖死）。 */
const MAX_PAGE_BYTES = 8 * 1024 * 1024

/** 反馈正文上限。 */
const MAX_FEEDBACK_BYTES = 256 * 1024

/** 反馈落盘目录（工作区相对路径）。 */
const FEEDBACK_DIR = '.dsh/showme'

/** 反馈落盘文件名（JSONL，只追加）。 */
const FEEDBACK_FILE = 'inbox.jsonl'

/** 预设样式在工作区里的落地目录（工作区相对路径）。 */
const PRESET_DIR = '.dsh/showme/presets'

/** 预设样式清单：插件包内 `styles/` 下就是这几个文件。 */
const PRESET_FILES = ['index.json', 'soft.css', 'swiss.css', 'brutal.css', 'blueprint.css']

/** 插件包内预设目录的位置（相对本模块，随包走）。 */
const STYLES_DIR = new URL('../styles/', import.meta.url)

/** 能当"展示页"的扩展名。 */
const PAGE_EXTENSIONS = new Set(['.html', '.htm'])

/** 镜像路由允许分发的资源类型；不在表里的一律 415。 */
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
}

/**
 * 只对 HTML 响应下发的 CSP sandbox。
 *
 * 这是把"能在浏览器打开原文件"变成安全的逃生门的关键：即使有人在标签页里
 * 直接打开这个地址，文档也被强制放进**不透明源**，拿不到 DSH 应用的源、
 * 读不到它的接口。而 `allow-forms` / `allow-modals` / `allow-downloads` /
 * `allow-popups` 让真实浏览器里的页面功能完整。
 *
 * 卡片内层还叠了 iframe 的 `sandbox="allow-scripts"`，两层取交集 →
 * 卡片里最严（只跑脚本），浏览器里放开。
 */
const HTML_CSP = 'sandbox allow-scripts allow-forms allow-modals allow-downloads allow-popups'

/**
 * 生成一份页面在镜像路由下的地址（与浏览器半区的 `rawUrl` 同构）。
 *
 * 由**宿主**算好并随工具结果下发，卡片优先用它：这样即使客户端拿到的 sessionId
 * 与宿主 `exec.agent.session.id` 不是同一个字符串，地址也依然正确。
 * 逐段编码，保留目录结构。
 *
 * @param sessionId - 会话 id。
 * @param workspacePath - 工作区相对路径。
 * @returns 路由地址。
 */
function rawUrlFor(sessionId, workspacePath) {
  const segments = String(workspacePath)
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => encodeURIComponent(segment))
  return `${ROUTE_PREFIX}/raw/${encodeURIComponent(sessionId)}/${segments.join('/')}`
}

/**
 * 回环信任围栏：只服务本机、且 Host 是回环的请求。
 *
 * ⚠️ **不要拿 `Sec-Fetch-Site` 做判断——这条检查在这里是完全冗余的，而且会咬自己。**
 *
 * 展示页跑在 `sandbox` 的**不透明源**里，于是它发起的一切请求（加载自己的图片 / 样式 /
 * 嵌套页 / 页内 `<a href>` 跳转 / `fetch`）都被浏览器标成 `Sec-Fetch-Site: cross-site`，
 * `Origin` 还是字面量 `"null"`。踩过两次，现场各是一句话：
 *
 *  - 一刀切拒 `cross-site` → **"卡片出来了，数据流图裂了"**（所有相对引用全灭）；
 *  - 只留"拒跨站文档导航" → **点图片跳到 `forbidden: loopback-only`**，
 *    而且页内 `<a href="shot-f3.html">` 这类跳转也会被一起拦死（多页汇报整片失效）。
 *
 * 真正撑住这条路由的是下面三条，它们都在：
 *  1. **只接受回环地址** —— 远程主机根本打不到；
 *  2. **Host 必须是回环** —— DNS rebinding 那类把戏进不来；
 *  3. **一个 CORS 头都不发** —— 即使别的站点在用户浏览器里发起了请求，响应也只是不透明的，
 *     读不到内容，也就拿不走工作区文件。
 *
 * 所以 `Origin` 那条就够了：真实跨站请求带的是 `https://evil.example`，会被拒；
 * 我们自己页面带的是 `null`，放行。
 *
 * @param request - 入站请求。
 * @returns 是否放行。
 */
function isLoopbackRequest(request) {
  const address = request.socket?.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers?.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  const hostname = hostUrl.hostname
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') return false

  const origin = request.headers.origin
  // 没有 Origin（子资源、导航）或不透明源的 "null"（沙箱页面自己的请求）一律放行。
  if (origin === undefined || origin === 'null') return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/**
 * 回一个 JSON 响应。
 * @param res - 响应对象。
 * @param status - HTTP 状态码。
 * @param body - 可序列化正文。
 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  })
  res.end(payload)
}

/**
 * 解码一个 URL 片段，失败返回 undefined（不抛）。
 * @param text - 原始片段。
 * @returns 解码结果，或 undefined。
 */
function safeDecode(text) {
  try {
    const decoded = decodeURIComponent(text)
    return decoded.includes('\u0000') ? undefined : decoded
  } catch {
    return undefined
  }
}

/**
 * 会话 → 工作区根。**权威来源是 `show_html` 工具自己**：它拿到的是
 * `exec.agent.session`，那里 `header.cwd` 一定有值（没有就当次调用直接失败）。
 *
 * 为什么不只靠服务：实测发现 `ctx.get('sessions')` / `ctx.get('sessionQuery')`
 * 在**路由那个插件上下文**里拿不到（Inspect 也把这两个标成 `optional`，
 * `requiresUndefinedCheck`），于是路由对任何会话都回 "unknown session"。
 * 而工具是在 agent 作用域里跑的，一定拿得到——所以让工具把答案记下来，
 * 路由优先查这份记录，服务只作为兜底。
 */
const knownRoots = new Map()

/**
 * 从会话对象里读工作区根。
 *
 * ⚠️ 关键事实（实测踩到）：`Session` 暴露的是 **`header.cwd`**，**没有 `meta`**。
 * 写成 `get(id)?.meta?.cwd` 会永远拿到 undefined（同一个 profile 里
 * `dsh-text-drop` 正是这么写的）。`sessionQuery.readSession()` 返回的是
 * "克隆的 header + 完整事件日志"，同样不是 `meta`。这里按 header → meta → 裸 cwd
 * 依次尝试，容忍形状漂移。
 *
 * @param record - 会话对象或日志快照。
 * @returns 绝对路径，或 undefined。
 */
function readCwd(record) {
  const candidates = [record?.header?.cwd, record?.meta?.cwd, record?.cwd]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return undefined
}

/**
 * 解析会话的工作区根：工具记录 → 活跃会话 → 持久化会话。
 *
 * **不做全局兜底**。早先的版本在会话认不出来时会退到 `sandboxPolicy.workspaceRoot`，
 * 那等于让任意一个伪造的 sessionId 都能读到那个根下的文件。现在会话必须**可识别**
 * 且**有 cwd**，否则一律 404。
 *
 * @param ctx - 宿主插件上下文。
 * @param sessionId - 会话 id。
 * @returns `{ root, source }` 或 `{ unknown: true, diagnostics }`。
 */
async function workspaceRootFor(ctx, sessionId) {
  const remembered = knownRoots.get(sessionId)
  if (remembered !== undefined) return { root: remembered, source: 'show_html' }

  const notes = []
  const sessions = ctx.get('sessions')
  if (sessions === undefined) notes.push('sessions=absent')
  else if (typeof sessions.get !== 'function') notes.push('sessions.get=absent')
  else {
    const live = sessions.get(sessionId)
    if (live === undefined || live === null) notes.push('sessions.get=miss')
    else {
      const cwd = readCwd(live)
      if (cwd !== undefined) return { root: cwd, source: 'sessions' }
      notes.push('sessions.get=no-cwd')
    }
  }

  const sessionQuery = ctx.get('sessionQuery')
  if (sessionQuery === undefined) notes.push('sessionQuery=absent')
  else if (typeof sessionQuery.readSession !== 'function') notes.push('sessionQuery.readSession=absent')
  else {
    try {
      const cwd = readCwd(await sessionQuery.readSession(sessionId))
      if (cwd !== undefined) return { root: cwd, source: 'sessionQuery' }
      notes.push('sessionQuery=no-cwd')
    } catch (error) {
      notes.push(`sessionQuery=threw(${error instanceof Error ? error.message : String(error)})`)
    }
  }

  return { unknown: true, diagnostics: notes.join(' ') }
}

/**
 * 把一个工作区相对路径定位成**已解析软链接**的绝对路径，并确认它没跑出工作区。
 *
 * realpath 是关键：`..` 与指向工作区外的符号链接都会在这一步被拉平，
 * 之后的包含判断才是可信的。
 *
 * @param workspaceRoot - 工作区根。
 * @param relativePath - 工作区相对路径（可以是 `a/b.png`）。
 * @returns `{ kind: 'ok', path }` / `{ kind: 'missing' }` / `{ kind: 'escape' }`。
 */
async function locateInWorkspace(workspaceRoot, relativePath) {
  let rootReal
  try {
    rootReal = await realpath(workspaceRoot)
  } catch {
    return { kind: 'missing' }
  }
  let targetReal
  try {
    targetReal = await realpath(resolve(rootReal, relativePath))
  } catch {
    return { kind: 'missing' }
  }
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + sep)) return { kind: 'escape' }
  return { kind: 'ok', path: targetReal }
}

/**
 * 把插件包里的预设样式落到工作区，让页面能用相对路径引用它们
 * （`<link rel="stylesheet" href="presets/soft.css">`）。
 *
 * **create-only**：已存在的文件一律不碰——你在工作区里改过的预设是你的，不该被覆盖。
 * 之所以由宿主做而不是让模型 `write`：前者零 token，后者每套要抄几千字。
 *
 * @param workspaceRoot - 会话工作区根。
 * @returns 本次新落地的文件名（已存在的不计）。
 */
async function seedPresets(workspaceRoot) {
  const target = join(workspaceRoot, PRESET_DIR)
  await mkdir(target, { recursive: true })
  const created = []
  for (const file of PRESET_FILES) {
    const destination = join(target, file)
    try {
      await access(destination)
      continue
    } catch {
      /* 不存在 → 落地 */
    }
    const content = await readFile(new URL(file, STYLES_DIR), 'utf8')
    await writeFile(destination, content, 'utf8')
    created.push(file)
  }
  return created
}

/**
 * 生成镜像读路由的处理函数。
 * @param ctx - 宿主插件上下文。
 * @returns node:http 处理器。
 */
function makeRouteHandler(ctx) {
  return async function handle(request, response) {
    if (!isLoopbackRequest(request)) {
      sendJson(response, 403, { ok: false, error: 'forbidden: loopback-only' })
      return
    }

    let url
    try {
      url = new URL(request.url ?? '/', 'http://127.0.0.1')
    } catch {
      sendJson(response, 400, { ok: false, error: 'bad request url' })
      return
    }

    const tail = url.pathname.slice(ROUTE_PREFIX.length)

    if (tail === '/feedback') {
      await handleFeedback(ctx, request, response)
      return
    }
    if (!tail.startsWith('/raw/')) {
      sendJson(response, 404, { ok: false, error: `unknown showme route: ${tail}` })
      return
    }

    const method = request.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(response, 405, { ok: false, error: `method not allowed: ${method}` })
      return
    }

    // /raw/<sessionId>/<工作区相对路径...>
    const rel = tail.slice('/raw/'.length)
    const slash = rel.indexOf('/')
    if (slash <= 0) {
      sendJson(response, 400, { ok: false, error: 'expected /raw/<sessionId>/<workspace-relative path>' })
      return
    }
    const sessionId = safeDecode(rel.slice(0, slash))
    const relativePath = safeDecode(rel.slice(slash + 1))
    if (sessionId === undefined || sessionId === '' || relativePath === undefined || relativePath === '') {
      sendJson(response, 400, { ok: false, error: 'malformed session id or path' })
      return
    }

    const resolved = await workspaceRootFor(ctx, sessionId)
    if (resolved.unknown === true) {
      sendJson(response, 404, {
        ok: false,
        error: `unknown session: ${sessionId} (${resolved.diagnostics ?? ''})`,
      })
      return
    }
    const workspaceRoot = resolved.root

    const located = await locateInWorkspace(workspaceRoot, relativePath)
    if (located.kind === 'escape') {
      sendJson(response, 403, { ok: false, error: 'forbidden: path escapes the session workspace' })
      return
    }
    if (located.kind === 'missing') {
      // 把解析到的根一并回报：出错时最想知道的就是"它到底在哪个目录里找"。
      sendJson(response, 404, { ok: false, error: `not found in workspace: ${relativePath} (workspace root: ${workspaceRoot})` })
      return
    }

    let info
    try {
      info = await stat(located.path)
    } catch {
      sendJson(response, 404, { ok: false, error: `not found in workspace: ${relativePath} (workspace root: ${workspaceRoot})` })
      return
    }
    if (!info.isFile()) {
      sendJson(response, 404, { ok: false, error: `not a regular file: ${relativePath}` })
      return
    }

    const extension = extname(located.path).toLowerCase()
    const contentType = CONTENT_TYPES[extension]
    if (contentType === undefined) {
      sendJson(response, 415, { ok: false, error: `unsupported media type: ${extension || '(none)'}` })
      return
    }

    const headers = {
      'content-type': contentType,
      'content-length': String(info.size),
      // 页面会被反复改，永远不要缓存——"刷新"按钮必须真的重读。
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    }
    if (contentType.startsWith('text/html')) headers['content-security-policy'] = HTML_CSP

    response.writeHead(200, headers)
    if (method === 'HEAD') {
      response.end()
      return
    }
    const stream = createReadStream(located.path)
    stream.on('error', () => {
      try {
        response.destroy()
      } catch {
        /* 响应已经断了 */
      }
    })
    stream.pipe(response)
  }
}

/**
 * `POST /api/showme/feedback`：把用户在一个展示页上的表态追加进
 * `<工作区>/.dsh/showme/inbox.jsonl`，agent 读这个文件就能拿到反馈。
 * @param ctx - 宿主插件上下文。
 * @param request - 入站请求。
 * @param response - 响应。
 */
async function handleFeedback(ctx, request, response) {
  if ((request.method ?? 'GET') !== 'POST') {
    sendJson(response, 405, { ok: false, error: `method not allowed: ${request.method}` })
    return
  }
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_FEEDBACK_BYTES) {
      sendJson(response, 413, { ok: false, error: 'feedback body too large' })
      return
    }
    chunks.push(chunk)
  }
  let body
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    sendJson(response, 400, { ok: false, error: 'invalid JSON body' })
    return
  }
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
  const text = typeof body?.text === 'string' ? body.text : ''
  if (sessionId === '' || text.trim() === '') {
    sendJson(response, 400, { ok: false, error: 'sessionId and text are required' })
    return
  }
  const resolved = await workspaceRootFor(ctx, sessionId)
  if (resolved.unknown === true) {
    sendJson(response, 404, {
      ok: false,
      error: `unknown session: ${sessionId} (${resolved.diagnostics ?? ''})`,
    })
    return
  }
  const workspaceRoot = resolved.root
  const directory = resolve(workspaceRoot, FEEDBACK_DIR)
  const target = resolve(directory, FEEDBACK_FILE)
  const record = {
    at: new Date().toISOString(),
    sessionId,
    page: typeof body?.page === 'string' ? body.page : undefined,
    text,
  }
  try {
    await mkdir(directory, { recursive: true })
    await appendFile(target, `${JSON.stringify(record)}\n`, 'utf8')
  } catch (error) {
    sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    return
  }
  sendJson(response, 200, { ok: true, path: `${FEEDBACK_DIR}/${FEEDBACK_FILE}` })
}

/**
 * 「可点名」的迹象：条目上的稳定 id 与表态控件。
 *
 * 词汇放宽到一小族 `data-*`，因为 skill 只规定"要有稳定 id"，没规定必须叫 `data-id`；
 * 收窄了会误报——实测我自己的预设画廊用的是 `data-pick` / `data-default`。
 * JS 里拼出来的标记（`'data-id="' + id + '"'`）在源码里同样字面出现，所以对模板生成也有效。
 */
const RECEIPT_ID_SIGNALS = [/data-(?:id|w|pick|choice|key|slug|verdict|option)\s*=/i]

/**
 * 「可回传」的迹象：**默认通道是 postMessage**（卡片会给出「填入输入框」按钮），
 * 页面里可选中复制的文本只是兜底。所以这里只认 postMessage。
 *
 * 实测教训：早先把它写成"readonly textarea **或** postMessage"，结果模型只做兜底那条
 * （页面上放个「全选下面的文本」按钮）——用户的体验就是"回执还得自己抄"。
 */
const RECEIPT_SUMMARY_SIGNALS = [/postMessage/]

/**
 * 检查页面有没有「让用户回话」的部分；缺了就返回一段**给模型看的**提醒。
 *
 * 为什么放在宿主，而不是只写在 skill 里：
 * **实测过 skill 被加载、被读，却没被照做**（两个工作区、四个页面，几乎都没有回执）。
 * 工具结果是模型紧接着必读的东西，是这条链路上唯一不依赖它自觉的通道。
 *
 * 只提醒、不拒绝：挡下展示会把一次交付变成一次报错，代价比漏一次提醒大得多。
 *
 * @param html - 页面正文。
 * @returns 提醒文本；页面没问题时返回空串。
 */
function receiptHint(html) {
  const hasIds = RECEIPT_ID_SIGNALS.some((signal) => signal.test(html))
  const hasSummary = RECEIPT_SUMMARY_SIGNALS.some((signal) => signal.test(html))
  if (hasIds && hasSummary) return ''

  const missing = []
  if (!hasIds) missing.push('pointable ids (`data-id="…"` or similar, on each item)')
  if (!hasSummary) {
    missing.push(
      'the `postMessage` hook-up (`window.parent.postMessage({ type: \'dsh-showme-feedback\', text }, \'*\')` '
      + 'on every verdict change, so the card can offer a one-click fill)',
    )
  }

  return [
    'ⓘ Host check: this page does not look like it lets the user reply — missing',
    `${missing.join(' + ')}.`,
    'Every showme page is expected to carry the reply block: load the `showme-report` skill (§3 and §4)',
    'and add it, then call show_html again.',
    'Note: a copyable text block alone is NOT enough — the default path is postMessage to the card,',
    'which gives the user a one-click "fill the composer" button. Do not design the page around',
    'manual copying (no "select all the text below" buttons).',
    'If you implemented the reply block a different way, ignore this.',
    'If the page genuinely has nothing to decide, say so in your reply instead — then it is fine.',
  ].join(' ')
}

/**
 * 从 HTML 里抓出"相对路径引用"，用来检查这些资源是不是真的存在。
 *
 * 只收**看起来像资源**的引用：带扩展名、不是协议/协议相对/根路径/锚点。
 * 这样既不会去检查 `/api/…` 与 `https://…`，也不会把 `#anchor` 当资源。
 *
 * @param html - 页面正文。
 * @returns 去重后的相对引用（去掉查询串与哈希）。
 */
function relativeRefs(html) {
  const refs = new Set()
  for (const match of html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/gi)) {
    const value = match[1].trim()
    if (value === '') continue
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(value)) continue
    if (!/\.\w{1,6}(?:[?#]|$)/.test(value)) continue
    refs.add(value.split(/[?#]/)[0])
  }
  return [...refs]
}

/**
 * 检查页面引用的相对资源是否都存在；缺了就返回一段**给模型看的**提醒。
 *
 * 为什么值得做：模型很容易写下一个"打算创建但忘了创建"的图片路径，
 * 或者引用一个不存在的子页面——用户那边表现为一张裂图，而模型完全不知道。
 * 这是同一类问题：**只有当模型拿到反馈时才会修**。
 *
 * 注意 `presets/*.css` 不会被误报：宿主在这次调用里刚把它们落地过（见 seedPresets）。
 *
 * @param html - 页面正文。
 * @param pagePath - 页面本身的绝对路径（相对引用以它的目录为基准）。
 * @returns 提醒文本；没有缺失时返回空串。
 */
async function assetHint(html, pagePath) {
  const missing = []
  for (const ref of relativeRefs(html)) {
    let decoded
    try {
      decoded = decodeURIComponent(ref)
    } catch {
      decoded = ref
    }
    try {
      await access(resolve(dirname(pagePath), decoded))
    } catch {
      missing.push(ref)
    }
  }
  if (missing.length === 0) return ''
  const shown = missing.slice(0, 5)
  const more = missing.length > shown.length ? ` (+${missing.length - shown.length} more)` : ''
  return [
    'ⓘ Host check: this page references files that do not exist next to it —',
    `${shown.map((ref) => `\`${ref}\``).join(', ')}${more}.`,
    'They will show up to the user as broken images or missing styles.',
    'Write those files (relative to the page), fix the paths, or drop the references, then call show_html again.',
  ].join(' ')
}

/**
 * 手写的 `show_html` 工具定义（见文件头说明为什么不用 `defineTool`）。
 *
 * `parameters` 与 `output.schema` 是**已经编译好的 JSON Schema**：
 * `defineTool` 内部就是 `parameterSchemaSpecToJsonSchema` / `valueSchemaSpecToJsonSchema`
 * 的结果，这里直接给出等价形态。
 *
 * @param ctx - 宿主插件上下文。
 * @returns 注册用的工具定义。
 */
function buildTool(ctx) {
  return {
    name: TOOL_NAME,
    description: [
      'Show the user a rendered HTML page from the workspace, inside the conversation.',
      'Use it to REPORT or EXPLAIN something visually — a design review, a comparison, a plan, an evidence board, a set of variants for the user to choose from — instead of long prose.',
      'The page must already exist: write it first (write tool), then call this with its path.',
      'Load the `showme-report` skill BEFORE writing the page — it carries the reply contract, the four preset styles, and the sandbox traps. Do not write the page from memory.',
      'Every page should let the user reply: stable ids on the things they might point at, a verdict control per id, and a copyable one-line-per-item summary. The skill says exactly how. If the page genuinely has nothing to decide, say so in your reply instead.',
      'Relative references inside the page work (`<img src="stills/a.png">`, sibling css/js, other html pages), so keep the assets next to the page.',
      'Do NOT use it for ordinary answers, short replies, or raw code.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Workspace-relative path of an existing .html/.htm file, for example `.dsh/showme/review.html`.',
        },
        title: {
          type: 'string',
          description: 'Short title shown on the card above the page. Defaults to the file name.',
        },
        note: {
          type: 'string',
          description: 'One short line telling the user why they should look at this page.',
        },
      },
      required: ['path'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          bytes: { type: 'integer' },
          url: { type: 'string' },
          hint: { type: 'string' },
        },
        required: ['path', 'bytes', 'url', 'hint'],
      },
      render(_args, value) {
        const shown = `Already shown to the user in the conversation: ${value?.path}`
        // hint 是给模型的：页面缺回执时，这里是唯一不看模型自觉的提醒通道。
        return [{ type: 'text', text: value?.hint ? `${shown}\n\n${value.hint}` : shown }]
      },
      // 传给卡片的展示元数据（顶层调用才会计算）：体积 + **宿主算好的地址**。
      // 卡片优先用 meta.url，从而不依赖"客户端的 sessionId 等于宿主的 session id"。
      presentationMeta(_args, value) {
        return { bytes: value?.bytes ?? 0, url: value?.url ?? '' }
      },
    },
    async execute(args, exec) {
      const relativePath = typeof args?.path === 'string' ? args.path.trim() : ''
      if (relativePath === '') throw new Error('show_html requires a non-empty `path`')

      const workspaceRoot = exec?.agent?.session?.header?.cwd
      if (typeof workspaceRoot !== 'string' || workspaceRoot === '') {
        throw new Error('show_html requires an open workspace (the session has no cwd)')
      }

      // 把权威答案记下来给路由用：这里的 session 一定有 cwd，而路由上下文里的
      // `sessions` / `sessionQuery` 服务实测拿不到（见 workspaceRootFor 的注释）。
      const sessionId = exec?.agent?.session?.id
      if (typeof sessionId === 'string' && sessionId !== '') knownRoots.set(sessionId, workspaceRoot)

      const extension = extname(relativePath).toLowerCase()
      if (!PAGE_EXTENSIONS.has(extension)) {
        throw new Error(`show_html only shows .html/.htm pages; got "${extension || '(no extension)'}"`)
      }

      const located = await locateInWorkspace(workspaceRoot, relativePath)
      if (located.kind === 'escape') {
        throw new Error(`show_html cannot read ${relativePath}: the path escapes the session workspace`)
      }
      if (located.kind === 'missing') {
        throw new Error(`show_html cannot find ${relativePath} in the workspace. Write the page first, then call this again.`)
      }

      const info = await stat(located.path)
      if (!info.isFile()) throw new Error(`show_html cannot show ${relativePath}: not a regular file`)
      if (info.size > MAX_PAGE_BYTES) {
        throw new Error(
          `show_html cannot show ${relativePath}: ${info.size} bytes exceeds the ${MAX_PAGE_BYTES}-byte page limit`,
        )
      }

      // 预设样式落地（create-only）。工作区不可写时静默跳过：展示本身仍然可用，
      // 只是页面不能外链预设。
      try {
        await seedPresets(workspaceRoot)
      } catch {
        /* 忽略 */
      }

      // 两类体检：回执（用户能不能回话）与引用（页面引的资源在不在）。
      // 都只提醒、不拒绝，提醒随工具结果回到模型眼前。
      let hint = ''
      try {
        const html = await readFile(located.path, 'utf8')
        const problems = [receiptHint(html), await assetHint(html, located.path)].filter((one) => one !== '')
        hint = problems.join('\n\n')
      } catch {
        /* 读不到就只是不提醒，展示照常 */
      }

      return {
        path: relativePath,
        bytes: info.size,
        url: typeof sessionId === 'string' && sessionId !== '' ? rawUrlFor(sessionId, relativePath) : '',
        hint,
      }
    },
  }
}

/**
 * 挂载镜像读路由与 `show_html` 工具；两者都由 effect 持有，停用即净。
 * @param ctx - 宿主插件上下文。
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: makeRouteHandler(ctx),
      }),
    'dsh-showme-html: workspace mirror route',
  )

  ctx.effect(() => ctx.tools.register(buildTool(ctx)), 'dsh-showme-html: show_html tool')
}
