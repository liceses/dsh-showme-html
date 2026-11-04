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

import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { access, appendFile, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, extname, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'

import { checkMermaidBlocks, formatMermaidErrors, hasMermaidBlocks } from './mermaid-check.js'

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

/**
 * 草稿目录（工作区相对路径）。
 *
 * 展示页跑在 `sandbox` 不透明源里，`localStorage` / `cookie` 都碰不到，
 * 刷新或切会话就等于把用户填的东西全丢掉。于是页面把状态 `postMessage`
 * 给卡片（同源），卡片再送到这里落盘；页面重新加载时由卡片读回来灌进去。
 */
const DRAFT_DIR = '.dsh/showme/drafts'

/** 单份草稿上限（判定 + 备注，正常几 KB 就够）。 */
const MAX_DRAFT_BYTES = 64 * 1024

/** 草稿保留天数与数量上限：只留最近这些，免得工作区里堆成垃圾场。 */
const MAX_DRAFT_AGE_DAYS = 30
const MAX_DRAFT_FILES = 200

/**
 * 全局偏好（**用户级**，不是工作区级）：`<DSH_HOME>/showme/prefs.json`。
 *
 * 为什么放家目录而不是工作区：这两个开关是"这个人的展示习惯"——
 * 换一个项目还要再设一遍，那就是工作区级设置该干的事，不是它。
 */
const PREFS_DEFAULTS = { autoOpenSidebar: true, pagePolicy: 'off', planPage: 'offer', planPageOpenOnReview: true }

/** `planPage` 允许的三档。 */
const PLAN_PAGE_MODES = ['off', 'offer', 'require']

/**
 * `pagePolicy` 允许的三档 —— 「回答的默认形状」。
 *
 *  - off：一个字都不注入，完全按 `show_html` 工具描述本来的克制程度；
 *  - prefer：有结构可看（多条目 / 对比 / 表格 / 流程 / 截图 / 待逐项批准 / 可点名）就默认出页；
 *  - always：每条实质回答都是一页，正文只留五行以内的摘要。
 */
const PAGE_POLICY_MODES = ['off', 'prefer', 'always']

/** 计划页在 markdown 里的锚点前缀（`offer` / `require` 两档都要求写它）。 */
const PLAN_PAGE_MARKER = '展示页：'

/** 偏好文件的缓存时长：prompt section 每轮都会问一次，别每次都读盘。 */
const PREFS_TTL_MS = 30 * 1000

/** `readPrefs` 的进程内缓存。 */
let prefsCache = { at: 0, value: undefined }

/** 偏好里「枚举档位」型的键 → 合法值。其余键一律当布尔。 */
const ENUM_PREFS = { planPage: PLAN_PAGE_MODES, pagePolicy: PAGE_POLICY_MODES }

/**
 * vendored 静态资源的路由：`GET /api/showme/vendor/<文件名>`。
 *
 * 展示页跑在 `sandbox` 不透明源里，`fetch` 同源资源会被当跨域拦掉，但
 * `<script src>` / `<link href>` 是 no-cors 请求，能正常加载 —— 所以 mermaid
 * 必须以**普通脚本**的形式从这里发出去。白名单查表，不做任何路径拼接。
 */
const VENDOR_ROUTE = `${ROUTE_PREFIX}/vendor`

/** 允许分发的 vendor 文件：路由名 → 包内相对路径。 */
const VENDOR_FILES = new Map([
  ['mermaid.min.js', new URL('../vendor/mermaid.min.js', import.meta.url)],
])

/** 页面里出现 mermaid 块时才注入引导脚本；超过这个体积就不注入（读全文太贵）。 */
const MAX_INJECT_BYTES = 2 * 1024 * 1024

/** mermaid 渲染回执（含 PNG）的体积上限。 */
const MAX_RECEIPT_BYTES = 8 * 1024 * 1024

/** 渲染产物落盘目录：`<工作区>/.dsh/showme/mermaid/`。 */
const MERMAID_OUTPUT_DIR = '.dsh/showme/mermaid'

/**
 * 注入浏览器的引导脚本（内联进 HTML）。
 *
 * 只在页面里真的有 mermaid 块时注入 —— 否则每页白背 9 KB。
 */
const MERMAID_BOOT = readFileSync(new URL('./mermaid-boot.js', import.meta.url), 'utf8')

/**
 * 插件包里要落到工作区的资产。
 *
 * 每一组：源目录（相对本模块，随包走）→ 工作区相对目录 → 文件清单。
 * 落地是 **create-only**，不覆盖用户改过的文件。
 */
const ASSET_SETS = [
  {
    source: '../styles/',
    target: '.dsh/showme/presets',
    files: ['index.json', 'soft.css', 'swiss.css', 'brutal.css', 'blueprint.css'],
  },
  {
    source: '../templates/',
    target: '.dsh/showme/templates',
    files: ['README.md', 'core.js', 'review.html', 'pick.html', 'report.html', 'doc.html'],
  },
]

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
 * `dsh-text-drop` 正是这么写的）。
 *
 * ⚠️ 第二个坑（2026-11-01 在 DSH 0.2.1-rc.5 上踩到）：`sessionQuery.readSession()`
 * 返回的不是顶层 `header`，而是
 * `{ session: <克隆的 header>, inheritedEventCount, events }` —— cwd 挂在 `session` 下。
 * 只认顶层 `header` 的写法在 rc.5 上让"不在本进程里活着"的会话一律
 * `404 unknown session`（诊断串是 `sessions.get=miss sessionQuery=no-cwd`），
 * 而 rc.2 上因为 `sessions.get()` 能命中持久化会话，这个坑被遮住了。
 *
 * 这里按 header → session → session.header → meta → 裸 cwd 依次尝试，容忍形状漂移。
 *
 * @param record - 会话对象或日志快照。
 * @returns 绝对路径，或 undefined。
 */
function readCwd(record) {
  const candidates = [
    record?.header?.cwd,
    record?.session?.cwd,
    record?.session?.header?.cwd,
    record?.meta?.cwd,
    record?.cwd,
  ]
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
 * 把插件包里的资产落到工作区，让页面能用相对路径引用它们：
 * 预设样式（`<link href="presets/soft.css">`）与模板（`templates/core.js`）。
 *
 * **create-only**：已存在的文件一律不碰——你在工作区里改过的预设/模板是你的，不该被覆盖。
 * 之所以由宿主做而不是让模型 `write`：前者零 token，后者每套要抄几千字。
 *
 * @param workspaceRoot - 会话工作区根。
 * @returns 本次新落地的 `目标目录/文件名`（已存在的不计）。
 */
async function seedAssets(workspaceRoot) {
  const created = []
  for (const set of ASSET_SETS) {
    const target = join(workspaceRoot, set.target)
    await mkdir(target, { recursive: true })
    for (const file of set.files) {
      const destination = join(target, file)
      try {
        await access(destination)
        continue
      } catch {
        /* 不存在 → 落地 */
      }
      const content = await readFile(new URL(file, new URL(set.source, import.meta.url)), 'utf8')
      await writeFile(destination, content, 'utf8')
      created.push(`${set.target}/${file}`)
    }
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
    if (tail === '/draft') {
      await handleDraft(ctx, request, response)
      return
    }
    if (tail === '/prefs') {
      await handlePrefs(request, response)
      return
    }
    if (tail === '/mermaid') {
      await handleMermaidReceipt(ctx, request, response)
      return
    }
    if (tail.startsWith('/vendor/')) {
      const fileName = safeDecode(tail.slice('/vendor/'.length))
      if (fileName === undefined || fileName === '' || fileName.includes('/')) {
        sendJson(response, 400, { ok: false, error: 'malformed vendor path' })
        return
      }
      await handleVendor(request, response, fileName)
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

    // 页面里有 mermaid 块时，把引导脚本内联进去（其余情况保持原来的流式直发，零开销）。
    if (contentType.startsWith('text/html') && info.size <= MAX_INJECT_BYTES) {
      let injected
      try {
        const html = await readFile(located.path, 'utf8')
        if (hasMermaidBlocks(html)) injected = Buffer.from(injectMermaidBoot(html), 'utf8')
      } catch {
        /* 读不到就走流式，页面照常发 */
      }
      if (injected !== undefined) {
        headers['content-length'] = String(injected.length)
        response.writeHead(200, headers)
        response.end(method === 'HEAD' ? undefined : injected)
        return
      }
    }

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
 * 归一一个**工作区相对路径**，并确认它没有跑出工作区。
 *
 * 和 `locateInWorkspace` 的区别：那个走 `realpath`，要求文件已经存在；
 * 草稿是拿"页面路径"当 key 存取的，对应的文件可能根本还没创建过。
 *
 * @param workspaceRoot - 工作区根目录（绝对路径）。
 * @param relativePath - 待检查的工作区相对路径。
 * @returns 绝对路径；越界或为空时返回 undefined。
 */
function resolveInsideWorkspace(workspaceRoot, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.trim() === '') return undefined
  const root = resolve(workspaceRoot)
  const target = resolve(root, relativePath)
  if (target !== root && !target.startsWith(root + sep)) return undefined
  return target
}

/**
 * 只留 `string → string` 的扁平表（判定词表 / 备注表），顺手截断。
 * @param value - 入站值。
 * @param limit - 最多保留多少条。
 */
function plainStringRecord(value, limit = 500) {
  const out = {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return out
  let count = 0
  for (const [key, item] of Object.entries(value)) {
    if (count >= limit) break
    if (typeof item !== 'string') continue
    out[String(key).slice(0, 200)] = item.slice(0, 4000)
    count += 1
  }
  return out
}

/**
 * 草稿文件名：会话 + 页面路径的稳定散列（不把路径塞进文件名，免得出怪字符）。
 * @param directory - 草稿目录。
 * @param sessionId - 会话 id。
 * @param page - 工作区相对页面路径。
 */
function draftFileFor(directory, sessionId, page) {
  const digest = createHash('sha1').update(`${sessionId}\n${page}`).digest('hex')
  return resolve(directory, `${digest}.json`)
}

/**
 * 清掉过期 / 超量的草稿。best-effort：任何一步失败都不影响这次写入。
 * @param directory - 草稿目录。
 */
async function pruneDrafts(directory) {
  let names
  try {
    names = await readdir(directory)
  } catch {
    return
  }
  const deadline = Date.now() - MAX_DRAFT_AGE_DAYS * 24 * 60 * 60 * 1000
  const kept = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const full = resolve(directory, name)
    try {
      const info = await stat(full)
      if (info.mtimeMs < deadline) await unlink(full)
      else kept.push({ full, at: info.mtimeMs })
    } catch {
      /* 单个文件读不了就跳过 */
    }
  }
  if (kept.length <= MAX_DRAFT_FILES) return
  kept.sort((left, right) => left.at - right.at)
  for (const one of kept.slice(0, kept.length - MAX_DRAFT_FILES)) {
    try {
      await unlink(one.full)
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * `GET|POST /api/showme/draft`：把页面上的判定与备注存成草稿，刷新/切会话后还能捡回来。
 *
 * 为什么由卡片来调、而不是页面自己调：展示页在 `sandbox` 不透明源里，
 * 直接 POST 宿主会被跨域拦掉；`postMessage` 能出来，同源的卡片负责"送"。
 *
 * @param ctx - 宿主插件上下文。
 * @param request - 入站请求。
 * @param response - 响应。
 */
async function handleDraft(ctx, request, response) {
  const method = request.method ?? 'GET'
  if (method !== 'GET' && method !== 'POST') {
    sendJson(response, 405, { ok: false, error: `method not allowed: ${method}` })
    return
  }

  let url
  try {
    url = new URL(request.url ?? '/', 'http://127.0.0.1')
  } catch {
    sendJson(response, 400, { ok: false, error: 'bad request url' })
    return
  }

  let body = {}
  if (method === 'POST') {
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > MAX_DRAFT_BYTES) {
        sendJson(response, 413, { ok: false, error: 'draft body too large' })
        return
      }
      chunks.push(chunk)
    }
    try {
      body = Buffer.concat(chunks).toString('utf8')
      body = body === '' ? {} : JSON.parse(body)
    } catch {
      sendJson(response, 400, { ok: false, error: 'invalid JSON body' })
      return
    }
  }

  const sessionId = method === 'POST'
    ? (typeof body?.sessionId === 'string' ? body.sessionId : '')
    : (url.searchParams.get('session') ?? '')
  const page = method === 'POST'
    ? (typeof body?.page === 'string' ? body.page : '')
    : (url.searchParams.get('page') ?? '')
  if (sessionId === '' || page === '') {
    sendJson(response, 400, { ok: false, error: 'sessionId and page are required' })
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
  if (resolveInsideWorkspace(workspaceRoot, page) === undefined) {
    sendJson(response, 403, { ok: false, error: 'forbidden: page escapes the session workspace' })
    return
  }

  const directory = resolve(workspaceRoot, DRAFT_DIR)
  const target = draftFileFor(directory, sessionId, page)

  if (method === 'GET') {
    let draft = null
    try {
      const parsed = JSON.parse(await readFile(target, 'utf8'))
      draft = {
        sessionId: typeof parsed?.sessionId === 'string' ? parsed.sessionId : sessionId,
        page: typeof parsed?.page === 'string' ? parsed.page : page,
        updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : null,
        verdicts: plainStringRecord(parsed?.verdicts),
        notes: plainStringRecord(parsed?.notes),
      }
    } catch {
      draft = null
    }
    sendJson(response, 200, { ok: true, draft })
    return
  }

  if (body?.clear === true) {
    try {
      await unlink(target)
    } catch {
      /* 本来就没有草稿 */
    }
    sendJson(response, 200, { ok: true, cleared: true })
    return
  }

  const record = {
    sessionId,
    page,
    updatedAt: new Date().toISOString(),
    verdicts: plainStringRecord(body?.verdicts),
    notes: plainStringRecord(body?.notes),
  }
  const payload = `${JSON.stringify(record)}\n`
  if (Buffer.byteLength(payload) > MAX_DRAFT_BYTES) {
    sendJson(response, 413, { ok: false, error: 'draft too large' })
    return
  }
  try {
    await mkdir(directory, { recursive: true })
    const temporary = `${target}.${process.pid}.tmp`
    await writeFile(temporary, payload, 'utf8')
    await rename(temporary, target)
  } catch (error) {
    sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    return
  }
  await pruneDrafts(directory)
  sendJson(response, 200, { ok: true, saved: true, path: `${DRAFT_DIR}/${basename(target)}` })
}

/**
 * `GET /api/showme/vendor/<文件名>`：把 vendored 的第三方脚本原样发出去。
 *
 * 为什么需要这条路由，而不是让页面去 CDN：展示页是不透明源，`fetch` 同源会被拦，
 * 但 `<script src>` 能过；而 CDN 一旦断网，页面里的图就永远是空白。
 *
 * 走白名单查表（`VENDOR_FILES`），**不做任何路径拼接** —— 没有穿越面。
 *
 * @param request - 入站请求。
 * @param response - 响应。
 * @param fileName - 路由里的文件名。
 */
async function handleVendor(request, response, fileName) {
  const method = request.method ?? 'GET'
  if (method !== 'GET' && method !== 'HEAD') {
    sendJson(response, 405, { ok: false, error: `method not allowed: ${method}` })
    return
  }

  const source = VENDOR_FILES.get(fileName)
  if (source === undefined) {
    sendJson(response, 404, { ok: false, error: `unknown vendor file: ${fileName}` })
    return
  }

  let bytes
  try {
    bytes = await readFile(source)
  } catch (error) {
    sendJson(response, 500, { ok: false, error: `cannot read vendor file: ${error.message}` })
    return
  }

  response.writeHead(200, {
    'content-type': 'text/javascript; charset=utf-8',
    'content-length': String(bytes.length),
    // 版本由文件内容决定，文件名不变；页面每次都是新请求，缓存住反而省事。
    'cache-control': 'public, max-age=31536000, immutable',
    'access-control-allow-origin': '*',
    'x-content-type-options': 'nosniff',
  })
  if (method === 'HEAD') {
    response.end()
    return
  }
  response.end(bytes)
}

/**
 * 把引导脚本内联进页面。
 *
 * 注入点在 `</body>` 之前（用 `lastIndexOf`：脚本字符串里也可能出现字面量
 * `</body>`）；找不到就追加到末尾。
 *
 * @param html - 页面源码。
 * @returns 注入后的页面源码。
 */
function injectMermaidBoot(html) {
  const tag = `<script>${MERMAID_BOOT}</script>`
  const at = html.toLowerCase().lastIndexOf('</body>')
  if (at < 0) return `${html}${tag}`
  return `${html.slice(0, at)}${tag}${html.slice(at)}`
}

/**
 * 把页面路径归一成 `/` 分隔、且不含 `.` / `..` 的形式。
 *
 * 两个调用方必须算出**同一个**结果：工具用的是参数里的路径，回执用的是浏览器
 * 地址里的路径（浏览器会先把 `./`、`..` 归一掉）。不归一的话 `./a.html` 与
 * `a.html` 会被当成两页，工具预告的 PNG 路径与真正落盘的路径就对不上了。
 *
 * @param value - 工作区相对路径。
 * @returns 归一后的相对路径（可能是空串）。
 */
function normalizePagePath(value) {
  const out = []
  for (const part of String(value ?? '').replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      out.pop()
      continue
    }
    out.push(part)
  }
  return out.join('/')
}

/**
 * 算出一个页面里每张图渲染产物的落盘相对路径。
 *
 * 路径是**可预测**的：`show_html` 在返回时就把它们告诉模型，模型不必再问一次
 * "图在哪"，渲染完成后直接 `read_image` 就能看见自己画的图。
 *
 * 每个页面一个子目录（目录名是归一后页面路径的短哈希）：产物按页分组，
 * `a/review.html` 与 `b/review.html` 不会再互相覆盖。0.3.3 及以前直接用
 * basename 当文件名，两个同名页面会抢同一份 `review.1.png` / `review.json`。
 *
 * @param relativePath - 页面在工作区里的相对路径。
 * @param count - 图的数量。
 * @returns `{ dir, stem, png }`；`dir` 与 `png` 都是工作区相对路径。
 */
function mermaidOutputFor(relativePath, count) {
  const page = normalizePagePath(relativePath) || 'page.html'
  const stem = basename(page).replace(/\.[^.]+$/, '') || 'page'
  const slot = createHash('sha1').update(page).digest('hex').slice(0, 8)
  const dir = `${MERMAID_OUTPUT_DIR}/${slot}`
  const png = []
  for (let index = 1; index <= count; index += 1) {
    png.push(`${dir}/${stem}.${index}.png`)
  }
  return { dir, stem, png }
}

/**
 * `POST /api/showme/mermaid`：接收浏览器半区转来的渲染回执。
 *
 * 为什么不从页面直接 POST：展示页在不透明源里，跨源请求会被拦。页面 `postMessage`
 * 给宿主窗口，宿主窗口里的浏览器半区（同源）再转这一下。
 *
 * 落盘：每张图一个 PNG + 一份 `<页面名>.json`（最新一次回执）；有失败时另写
 * `<页面名>.errors.txt`，方便模型直接读文本。
 *
 * @param ctx - 宿主插件上下文。
 * @param request - 入站请求。
 * @param response - 响应。
 */
async function handleMermaidReceipt(ctx, request, response) {
  if ((request.method ?? 'GET') !== 'POST') {
    sendJson(response, 405, { ok: false, error: `method not allowed: ${request.method}` })
    return
  }

  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_RECEIPT_BYTES) {
      sendJson(response, 413, { ok: false, error: 'mermaid receipt too large' })
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
  const page = typeof body?.page === 'string' ? body.page : ''
  if (sessionId === '' || page === '') {
    sendJson(response, 400, { ok: false, error: 'sessionId and page are required' })
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
  // 归一一次，后面落盘目录与记录里的 page 都用它：工具侧算 PNG 路径时用的是
  // 同一条归一化（见 normalizePagePath），两边不归一就会预告一个不存在的路径。
  const normalizedPage = normalizePagePath(page)
  if (normalizedPage === '') {
    sendJson(response, 400, { ok: false, error: 'page must point to a file inside the workspace' })
    return
  }
  const located = await locateInWorkspace(workspaceRoot, normalizedPage)
  if (located.kind === 'escape') {
    sendJson(response, 403, { ok: false, error: 'forbidden: path escapes the session workspace' })
    return
  }
  // 只给**真实存在**的页面落产物：0.3.3 及以前不查存在性，任何随手编的路径都能
  // 在 `.dsh/showme/mermaid/` 下催出文件（同名页面还会互相覆盖）。
  if (located.kind === 'missing') {
    sendJson(response, 404, {
      ok: false,
      error: `page not found in workspace: ${normalizedPage} (show it first)`,
    })
    return
  }

  const diagrams = Array.isArray(body?.diagrams) ? body.diagrams : []
  const output = mermaidOutputFor(normalizedPage, Math.max(diagrams.length, 1))
  const directory = resolve(workspaceRoot, output.dir)

  const written = []
  const summary = []
  try {
    await mkdir(directory, { recursive: true })
    for (const diagram of diagrams) {
      const index = Number.isInteger(diagram?.index) ? diagram.index : summary.length + 1
      const pngData = typeof diagram?.png === 'string' ? diagram.png : ''
      const relative = `${output.dir}/${output.stem}.${index}.png`
      let saved = null
      if (pngData.startsWith('data:image/png;base64,')) {
        await writeFile(resolve(workspaceRoot, relative), Buffer.from(pngData.slice('data:image/png;base64,'.length), 'base64'))
        saved = relative
        written.push(relative)
      }
      summary.push({
        index,
        type: typeof diagram?.type === 'string' ? diagram.type : null,
        error: typeof diagram?.error === 'string' ? diagram.error : null,
        png: saved,
      })
    }

    const record = {
      at: new Date().toISOString(),
      sessionId,
      page: normalizedPage,
      ok: body?.ok === true,
      diagrams: summary,
    }
    await writeFile(resolve(directory, `${output.stem}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    written.push(`${output.dir}/${output.stem}.json`)

    const failures = summary.filter((item) => item.error !== null)
    if (failures.length > 0) {
      const lines = [`${normalizedPage} 里有 ${failures.length} 张 mermaid 图没渲染出来：`, '']
      for (const item of failures) {
        lines.push(`  第 ${item.index} 张${item.type ? `（${item.type}）` : ''}：`, ...String(item.error).split('\n').map((line) => `    ${line}`), '')
      }
      await writeFile(resolve(directory, `${output.stem}.errors.txt`), `${lines.join('\n')}\n`, 'utf8')
      written.push(`${output.dir}/${output.stem}.errors.txt`)
    }
  } catch (error) {
    sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    return
  }

  sendJson(response, 200, { ok: true, page: normalizedPage, diagrams: summary, files: written })
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
 * 注意 `presets/*.css` 不会被误报：宿主在这次调用里刚把它们落地过（见 seedAssets）。
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
 * 找出页面用 `<script src="…">` 引的**本地**脚本，返回它们的绝对路径（存在才收）。
 *
 * 回执体检必须把外链脚本一起算进来：模板外壳只有几百字节，
 * 交互逻辑全在 `templates/core.js` 里 —— 只看页面本体会把模板页**全部误报**
 * （实测：模板示例页就是这么被自己的检查咬到的）。
 *
 * @param html - 页面正文。
 * @param pagePath - 页面绝对路径（相对引用以它的目录为基准）。
 * @returns 存在的本地脚本绝对路径。
 */
async function localScriptPaths(html, pagePath) {
  const paths = []
  for (const match of html.matchAll(/<script[^>]*\bsrc\s*=\s*"([^"]+)"/gi)) {
    const value = match[1].trim()
    if (value === '') continue
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(value)) continue
    let decoded
    try {
      decoded = decodeURIComponent(value.split(/[?#]/)[0])
    } catch {
      decoded = value.split(/[?#]/)[0]
    }
    const full = resolve(dirname(pagePath), decoded)
    try {
      await access(full)
      paths.push(full)
    } catch {
      /* 缺文件归引用体检管，这里不管 */
    }
  }
  return paths
}

/**
 * 找到这一页对应的模板数据文件（`foo.html` → `foo.data.js`）。
 *
 * 只认同目录同名，外加页面里 `<script src="….data.js">` 的**本地**引用。
 * 一个都找不到就当"不是模板页"，结构检查整段跳过。
 *
 * @param pagePath - 页面绝对路径。
 * @param html - 页面正文。
 * @returns 数据文件绝对路径；没有就是 null。
 */
async function templateDataFile(pagePath, html) {
  const sibling = resolve(dirname(pagePath), `${basename(pagePath, extname(pagePath))}.data.js`)
  try {
    await access(sibling)
    return sibling
  } catch {
    /* 没有同名数据文件，再看脚本引用 */
  }
  for (const match of html.matchAll(/<script[^>]*\bsrc\s*=\s*"([^"]+\.data\.js)"/gi)) {
    const value = match[1].trim()
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(value)) continue
    const full = resolve(dirname(pagePath), value.split(/[?#]/)[0])
    try {
      await access(full)
      return full
    } catch {
      /* 下一个 */
    }
  }
  return null
}

/**
 * 结构型 markdown 的逐行判据：只看**整行的形状**，不猜语义。
 *
 * 之所以要拦：模板把结构交给块类型（table / timeline / chips / code / callout），
 * 同一种结构有两种写法就会长出两种风格。行内那点东西（强调 / 行内代码 / 链接）没有
 * 块类型等价物，所以由 `templates/core.js` 的 `inlineMd` 渲染；结构则一律报错指路。
 */
const STRUCTURAL_RULES = [
  {
    kind: '代码围栏',
    block: "code 块（{ type: 'code', text: '…' }）",
    test: (line) => /^\s*```/.test(line),
  },
  {
    kind: '标题',
    block: 'sections[].heading（小节标题）',
    test: (line) => /^\s{0,3}#{1,6}\s+\S/.test(line),
  },
  {
    kind: '引用',
    block: "callout 块（{ type: 'callout', tone: 'good', text: '…' }）",
    test: (line) => /^\s{0,3}>\s+\S/.test(line),
  },
  {
    kind: '表格',
    block: "table 块（{ type: 'table', head: [...], rows: [[...]] }）",
    test: (line, next) =>
      /^\s*\|.*\|/.test(line) && next !== undefined && /^\s*\|?[\s:|-]*-{3,}[\s:|-]*$/.test(next),
  },
  {
    kind: '列表',
    block: "timeline 块（有序）/ chips 块（无序）",
    test: (line, next) =>
      /^\s*(?:[-*]|\d+[.)])\s+\S/.test(line) &&
      next !== undefined &&
      /^\s*(?:[-*]|\d+[.)])\s+\S/.test(next),
  },
]

/**
 * 把数据文件里的**字符串字面量**抽出来（`'…'` / `"…"` / 反引号），并做最小的反转义。
 *
 * 为什么必须抽字面量而不是扫整份源码：markdown 的表格/列表形状是"行首"特征，
 * 而数据文件里它们是写在 `text: '…'` 引号里的——直接扫源码永远匹配不到行首。
 *
 * @param source - 数据文件源码。
 * @returns `{ body, index }` 列表（`index` 是字面量在源码里的偏移，用来报行号）。
 */
function stringLiteralsOf(source) {
  const literals = []
  const pattern = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`[^`]*`/g
  let match
  while ((match = pattern.exec(source)) !== null) {
    const raw = match[0]
    if (raw.length < 2) continue
    const body = raw
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\r/g, '\r')
      .replace(/\\(['"`\\])/g, '$1')
    literals.push({ body, index: match.index })
  }
  return literals
}

/**
 * 扫一遍模板数据文件，找出会被原样显示的 markdown 结构。
 *
 * **不执行**数据文件（宿主里不 eval 工作区里的 JS，这是安全底线），
 * 只抽字符串字面量做逐行匹配；代价是"code 块里恰好写着 markdown 示例"也会被拦，
 * 兜底是错误文本里的提示与 `plain: true`。
 *
 * @param pagePath - 页面绝对路径。
 * @param html - 页面正文。
 * @returns 命中的位置列表（行号 / 结构 / 该用哪个块）。
 */
async function findStructuralMarkdown(pagePath, html) {
  const dataPath = await templateDataFile(pagePath, html)
  if (dataPath === null) return []
  let source
  try {
    source = await readFile(dataPath, 'utf8')
  } catch {
    return []
  }
  // 逃生阀：作者明确说"这段就是原文"时，这一页不再做结构检查。
  if (/\bplain\s*:\s*true\b/.test(source)) return []

  const issues = []
  for (const literal of stringLiteralsOf(source)) {
    const lines = literal.body.split(/\r?\n/)
    const baseLine = source.slice(0, literal.index).split(/\r?\n/).length
    for (let offset = 0; offset < lines.length; offset += 1) {
      const line = lines[offset]
      const next = lines[offset + 1]
      for (const rule of STRUCTURAL_RULES) {
        if (!rule.test(line, next)) continue
        issues.push({ line: baseLine + offset, kind: rule.kind, block: rule.block })
        break
      }
    }
  }
  return issues
}

/**
 * 把结构 markdown 的命中拼成一条给模型看的错误（格式与 mermaid 预检一致）。
 *
 * @param issues - `findStructuralMarkdown` 的返回。
 * @param pageName - 展示用的页面路径。
 */
function formatStructuralErrors(issues, pageName) {
  const detail = issues
    .slice(0, 8)
    .map((one) => `  · 第 ${one.line} 行：${one.kind} → 用 ${one.block}`)
    .join('\n')
  const more = issues.length > 8 ? `\n  …还有 ${issues.length - 8} 处` : ''
  return [
    '这一页的数据里有 markdown 结构语法，模板不会解析它（结构只能用块类型），用户会看到原文。',
    detail + more,
    `改完再调用一次 show_html（页面：${pageName}）。`,
    '如果这段确实是正文、不是在写 markdown：把它写成一段话，或者在数据里加 `plain: true`（这一页就跳过结构检查）。',
  ].join('\n')
}

/**
 * 找出数据文件里指向**不存在的本地图片**的条目。
 *
 * 为什么升级成硬失败：过去 image 路径写错只给一条软提示，用户看到的是**裂图**——
 * 那是"半失败"状态。和 mermaid 一样，展示前就该挡住。
 * 外链（`http(s):` / `//`）与绝对路径放过：那不是模板能替它保证的东西。
 *
 * @param pagePath - 页面绝对路径。
 * @param html - 页面正文。
 * @returns 缺失的相对路径列表（去重）。
 */
async function findMissingImages(pagePath, html) {
  const dataPath = await templateDataFile(pagePath, html)
  if (dataPath === null) return []
  let source
  try {
    source = await readFile(dataPath, 'utf8')
  } catch {
    return []
  }
  const missing = new Set()
  for (const match of source.matchAll(/\b(?:image|src)\s*:\s*'([^'\\\n]+)'/g)) {
    const value = match[1].trim()
    if (value === '') continue
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(value)) continue
    const full = resolve(dirname(pagePath), value.split(/[?#]/)[0])
    try {
      await access(full)
    } catch {
      missing.add(value)
    }
  }
  return [...missing]
}

/**
 * 把缺失图片拼成一条给模型看的错误（与 mermaid / 结构 markdown 同格式）。
 * @param missing - 缺失的相对路径。
 * @param pageName - 展示用的页面路径。
 */
function formatMissingImages(missing, pageName) {
  const detail = missing
    .slice(0, 8)
    .map((one) => `  · ${one}`)
    .join('\n')
  const more = missing.length > 8 ? `\n  …还有 ${missing.length - 8} 个` : ''
  return [
    '这一页的数据引用了不存在的图片，展示出来会是裂图，所以这次调用失败。',
    detail + more,
    `图片必须**相对于页面**并存放在同一工作区里；补上文件、改对路径，或者先去掉这几条 image 再调用 show_html（页面：${pageName}）。`,
  ].join('\n')
}

/**
 * 条目位能容纳的长度：一句话，顶多再补一句。
 *
 * 条目（`items[]` / `candidates[]`）在模板里是**行**：左边一句话、右边控件
 * （`templates/core.js` 的 `.sm-line` 是 `minmax(0,1fr) 296px` 的网格）。
 * 一段 300 字灌进去，行会被撑成 300 字高，控件按垂直居中就飘到段落中间——
 * 这不是审美问题，是格子装不下。所以超长就当"写错了位置"报出来。
 */
const PROSE_DESC_MAX = 240

/**
 * 条目内选项集（`items[].options`）的硬边界。
 *
 * 为什么是 2–4：一个选项就不是选择题（那是确认），五个以上用户就不比较了，
 * 直接猜——那说明该拆页面，而不是继续加列。
 */
const OPTION_MIN = 2
const OPTION_MAX = 4
const OPTION_VALUE_MAX = 12
const OPTION_LABEL_MAX = 40
const OPTION_WHY_MAX = 300
const OPTION_VALUE_SHAPE = /^[A-Za-z0-9_.-]{1,12}$/

/**
 * 条目里出现这些形状，等于在条目位里写结构（段落 / 列表 / 表格）。
 * 与 `STRUCTURAL_RULES` 同一套判断，只是换成"在字段内部"的视角。
 */
const PROSE_STRUCTURE = [
  { kind: '空行分段', test: (text) => /\n[ \t]*\n[ \t]*\n/.test(text) },
  { kind: '列表行', test: (text) => /\n[ \t]*(?:[-*]|\d+[.)])[ \t]+\S/.test(text) },
  { kind: '表格行', test: (text) => /\n[ \t]*\|.*\|/.test(text) },
]

/**
 * 读模板页的数据文件并取 `window.SHOWME`。
 *
 * 用 `node:vm` 而不是 `import()`：数据文件名不固定、也不该进模块缓存；
 * 沙箱里只有裸 `window`，没有 require / fetch / process，1 秒超时。
 * 任何一步出问题都返回 null（fail-open）：动态拼出来的数据在 vm 里跑不通是正常的，
 * 宁可不检查，也不要因为检查本身把正常页面拦掉。
 *
 * @param pagePath - 页面绝对路径。
 * @param html - 页面正文。
 * @returns 数据对象；读不到 / 不是纯数据就是 null。
 */
async function readTemplateData(pagePath, html) {
  const dataPath = await templateDataFile(pagePath, html)
  if (dataPath === null) return null
  let source
  try {
    source = await readFile(dataPath, 'utf8')
  } catch {
    return null
  }
  const sandbox = { window: {} }
  try {
    runInContext(source, createContext(sandbox), { timeout: 1000, displayErrors: false })
  } catch {
    return null
  }
  const data = sandbox.window === undefined ? null : sandbox.window.SHOWME
  if (data === null || typeof data !== 'object') return null
  return data
}

/**
 * 校验一条条目的 `options`（A/B 两条走法挑一条）。
 *
 * 只在 review 的 `items[]` 上生效：`pick.candidates` 是"从一个集合里挑对象"，
 * 给它加 options 是概念混淆，一律忽略。
 *
 * @param id - 条目 id（报错时点名用）。
 * @param item - 条目对象。
 * @returns `[{ id, reasons }]`，空数组表示没问题。
 */
function checkOptions(id, item) {
  if (!Array.isArray(item.options)) return []
  const options = item.options
  const reasons = []
  if (options.length < OPTION_MIN || options.length > OPTION_MAX) {
    reasons.push(`选项 ${options.length} 个（要 ${OPTION_MIN}–${OPTION_MAX} 个）`)
  }
  const seen = new Set()
  for (const [index, option] of options.entries()) {
    const where = `${id}/${index + 1}`
    if (option === null || typeof option !== 'object') {
      reasons.push(`第 ${index + 1} 个选项不是对象`)
      continue
    }
    const value = typeof option.value === 'string' ? option.value : ''
    if (value === '') {
      reasons.push(`第 ${index + 1} 个选项缺 value`)
    } else if (!OPTION_VALUE_SHAPE.test(value)) {
      reasons.push(`value「${value}」要用 ≤${OPTION_VALUE_MAX} 个字母/数字/._-，不能有空格`)
    } else if (seen.has(value)) {
      reasons.push(`value「${value}」重复了`)
    } else {
      seen.add(value)
    }
    if (typeof option.label === 'string' && [...option.label].length > OPTION_LABEL_MAX) {
      reasons.push(`${where} 的 label 超过 ${OPTION_LABEL_MAX} 字`)
    }
    const why = typeof option.why === 'string' ? option.why : ''
    if (why !== '') {
      const whyLength = [...why.trim()].length
      if (whyLength > OPTION_WHY_MAX) reasons.push(`${where} 的理由 ${whyLength} 字（上限 ${OPTION_WHY_MAX}）`)
      for (const rule of PROSE_STRUCTURE) {
        if (rule.test(why)) reasons.push(`${where} 的理由里有${rule.kind}`)
      }
    }
  }
  if (item.preferred !== undefined && item.preferred !== null) {
    const preferred = String(item.preferred)
    if (!seen.has(preferred)) reasons.push(`preferred「${preferred}」不是本条的某个 value`)
  }
  return reasons.length === 0 ? [] : [{ id, reasons }]
}

/**
 * 找出"被写成散文"的条目，以及写坏的选项集。
 *
 * 只看条目位：`sections[].items[]` 与 `candidates[]`。`blocks` 里的 text / callout
 * 本来就该放长文，不在检查范围；`doc` 形状没有条目位，自然也不受影响。
 *
 * @param pagePath - 页面绝对路径。
 * @param html - 页面正文。
 * @returns `[{ id, where, length, reasons, kind }]`，空数组表示没问题。
 */
async function findProseItems(pagePath, html) {
  const data = await readTemplateData(pagePath, html)
  if (data === null) return []
  if (data.plain === true) return []

  const buckets = []
  if (Array.isArray(data.candidates)) buckets.push({ where: 'candidates', items: data.candidates, options: false })
  if (Array.isArray(data.sections)) {
    for (const section of data.sections) {
      if (section !== null && typeof section === 'object' && Array.isArray(section.items)) {
        buckets.push({ where: 'sections[].items', items: section.items, options: true })
      }
    }
  }

  const issues = []
  for (const bucket of buckets) {
    for (const [index, item] of bucket.items.entries()) {
      if (item === null || typeof item !== 'object') continue
      const id = typeof item.id === 'string' && item.id !== '' ? item.id : `${bucket.where}[${index}]`
      const desc = typeof item.desc === 'string' ? item.desc : ''
      if (desc !== '') {
        const reasons = []
        const length = [...desc.trim()].length
        if (length > PROSE_DESC_MAX) reasons.push(`正文 ${length} 字（上限 ${PROSE_DESC_MAX}）`)
        for (const rule of PROSE_STRUCTURE) {
          if (rule.test(desc)) reasons.push(`正文里有${rule.kind}`)
        }
        if (reasons.length > 0) issues.push({ id, where: bucket.where, length, reasons, kind: 'prose' })
      }
      if (bucket.options) {
        for (const one of checkOptions(id, item)) {
          issues.push({ id: one.id, where: bucket.where, length: 0, reasons: one.reasons, kind: 'options' })
        }
      }
    }
  }
  return issues
}

/**
 * 把"散文条目"拼成一条给模型看的错误（与 mermaid / 结构 markdown / 缺图同格式）。
 * @param issues - `findProseItems` 的返回。
 * @param pageName - 展示用的页面路径。
 */
function formatProseErrors(issues, pageName) {
  const prose = issues.filter((one) => one.kind !== 'options')
  const badOptions = issues.filter((one) => one.kind === 'options')
  const parts = []
  if (prose.length > 0) {
    const detail = prose
      .slice(0, 6)
      .map((one) => `  · ${one.id}：${one.reasons.join('；')}`)
      .join('\n')
    const more = prose.length > 6 ? `\n  …还有 ${prose.length - 6} 条` : ''
    parts.push([
      '这一页把长段落写进了条目位，排出来会变成"按钮飘在段落中间"的一堵墙，所以这次调用失败。',
      detail + more,
      '条目位只放一句话（结论 / 这一条是什么）。把证据与展开搬到块里：',
      '  · 一段说明 → { type: \'callout\', tone: \'warn\', text: \'…\' }',
      '  · 路径 / 字段 / 数字 → { type: \'kv\', rows: [[\'键\', \'值\'], …] }',
      '  · 多列对照 → { type: \'table\', head: [...], rows: [...] }',
      '  · 纯叙述（不需要表态）→ { type: \'text\', text: \'…\' }，或把整页换成 doc 形状',
    ].join('\n'))
  }
  if (badOptions.length > 0) {
    const detail = badOptions
      .slice(0, 6)
      .map((one) => `  · ${one.id}：${one.reasons.join('；')}`)
      .join('\n')
    parts.push([
      '这一页的条目内选项集（items[].options）写坏了，所以这次调用失败。',
      detail,
      '正确形状（每条 2–4 个互斥走法，理由写在选项里，不要塞进 desc）：',
      '  options: [',
      "    { value: 'A', label: '详情 404', why: '§EN-1 的字面是「完全不可见」…' },",
      "    { value: 'B', label: '200 但不给预览', why: '要给 DemoDetail 加 previewable…' },",
      "  ]，可选 preferred: 'A' 标一个倾向。",
      '约束：value ≤12 个字母数字._-、同条目内唯一；label ≤40 字；why ≤300 字且不许空行/列表/表格。',
    ].join('\n'))
  }
  parts.push(
    `逃生阀：确实要长文（例如整段搬来的报告）时给数据加 \`plain: true\` 跳过这项检查（页面：${pageName}）。`,
  )
  return parts.join('\n\n')
}
/**
 * 偏好文件路径：`<DSH_HOME>/showme/prefs.json`。
 */
function prefsLocation() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'showme', 'prefs.json')
}

/**
 * 只保留认识的键、认的类型（读坏文件也退回默认值，不让它把展示搞挂）。
 * @param raw - 读到的 JSON。
 */
function normalizePrefs(raw) {
  const out = { ...PREFS_DEFAULTS }
  if (raw !== null && typeof raw === 'object') {
    if (typeof raw.autoOpenSidebar === 'boolean') out.autoOpenSidebar = raw.autoOpenSidebar
    if (typeof raw.planPageOpenOnReview === 'boolean') out.planPageOpenOnReview = raw.planPageOpenOnReview
    if (typeof raw.planPage === 'string' && PLAN_PAGE_MODES.includes(raw.planPage)) out.planPage = raw.planPage
    if (typeof raw.pagePolicy === 'string' && PAGE_POLICY_MODES.includes(raw.pagePolicy)) out.pagePolicy = raw.pagePolicy
  }
  return out
}

/**
 * 读偏好（同步 + 30s 缓存：prompt section 每轮都会问，不能每轮读盘）。
 * @param force - 忽略缓存（设置页写入后立刻刷新用）。
 */
function readPrefs(force = false) {
  const now = Date.now()
  if (!force && prefsCache.value !== undefined && now - prefsCache.at < PREFS_TTL_MS) return prefsCache.value
  let value
  try {
    value = normalizePrefs(JSON.parse(readFileSync(prefsLocation(), 'utf8')))
  } catch {
    value = { ...PREFS_DEFAULTS }
  }
  prefsCache = { at: now, value }
  return value
}

/**
 * 计划模式是否处在激活态。
 *
 * 拿不到 `planMode` 服务、它没有 `loggedActive()`、或读状态抛错时一律返回 `true`
 * （fail-open）：宁可多注入一段提示，也不能让计划页在宿主换版本后**悄悄失效**——
 * 那种失效只能靠"模型哪天不产页了"才被发现。
 *
 * @param scope - 注入作用域（用来取可选服务）。
 * @param context - 系统提示的求值上下文。
 * @returns 是否应当注入计划页指引。
 */
function planModeActive(scope, context) {
  try {
    const service = typeof scope?.get === 'function' ? scope.get('planMode') : undefined
    if (service === undefined || service === null) return true
    if (typeof service.loggedActive !== 'function') return true
    return service.loggedActive(context.agent.session) === true
  } catch {
    return true
  }
}

/**
 * 计划页的指引文本（作为我们自己的 prompt section 注入，**不覆盖** DSH 的 plan:policy）。
 *
 * 三档：
 *  - off：什么都不说（完全按原生行为）
 *  - offer：复杂计划额外产一页，简单计划只写 markdown
 *  - require：一律产页，markdown 退化成摘要
 *
 * 只有 plan 模式激活时才注入：普通回合里这段是纯噪声（约 120 token，
 * 而且开头就写着 "Plan mode:"）。
 *
 * @param context - 系统提示的求值上下文。
 * @param scope - 注入作用域（可选，用来读 plan 模式状态）。
 */
function planPageGuide(context, scope = undefined) {
  if (context?.agent === undefined) return ''
  const mode = readPrefs().planPage
  if (mode === 'off') return ''
  if (planModeActive(scope, context) !== true) return ''
  const common = [
    'The markdown you pass to exit_plan_mode stays the authoritative record; the page is its expansion, never a replacement.',
    `When you do produce a page, write one line \`${PLAN_PAGE_MARKER}<workspace-relative path>\` on its own line (ideally in the first paragraph of that markdown); the plugin uses that line to open the page in the sidebar, and it only reads the first such line.`,
  ].join(' ')
  if (mode === 'require') {
    return [
      'Plan mode: always produce a showme page for the plan (templates/ skeleton + show_html), and pass a SHORT markdown summary to exit_plan_mode — at most five lines: goal, phases, and the page path.',
      common,
    ].join(' ')
  }
  return [
    'Plan mode: when the plan involves comparing options, multiple variants, side-by-side evidence, or multi-step tradeoffs, also produce a showme page (templates/ skeleton + show_html) in addition to the markdown plan. A short markdown-only plan is fine otherwise.',
    common,
  ].join(' ')
}

/**
 * 「回答的默认形状」指引文本（`pagePolicy`）。
 *
 * 与 `planPage` 不同，它**不看 plan 模式**：普通回合也该生效。`off` 时返回空串，
 * 宿主会把这一个 section 渲染成空，等于没加。
 *
 * 为什么放在插件里而不是做成 agent 预设：预设只认 DSH 内置的四个 id，
 * 自定义预设会让 dsh-ops 之类的插件找不到自己的模式（它们的发布门是
 * `modeOf(agent) === mode`），顺手把整排 ops 工具也弄丢。这里只追加一段提示，
 * 预设仍是 standard，工具面一个不少。
 *
 * @param context - 系统提示的求值上下文。
 * @returns 注入的文本（`off` 或拿不到 agent 时为空串）。
 */
function pagePolicyGuide(context) {
  if (context?.agent === undefined) return ''
  const mode = readPrefs().pagePolicy
  if (mode === 'off') return ''
  const shared = [
    'Write the page into the workspace first (a templates/ skeleton plus its same-named `<name>.data.js`, or a custom page), then call `show_html` with its path. Load the `showme-report` skill before writing it — it carries the reply contract and the sandbox traps.',
    'Every page must be answerable: stable ids visible on the page for anything the user may point at, the verdict controls next to those items, a copyable one-line-per-item summary, and a `postMessage` on every change.',
    'Keep the chat reply to a short summary plus what needs a decision; the page carries the detail.',
    'If `show_html` is unavailable, say so in one line and fall back to Markdown.',
  ].join(' ')
  const opening =
    mode === 'always'
      ? [
          'Answer shape: always answer with a showme page. Every user-visible answer is a page; the chat reply is at most five lines saying what it is and what needs a decision. The only exceptions are a one-line acknowledgement and an explicit request for text or raw code.',
        ].join(' ')
      : [
          'Answer shape: default to a showme page. The `show_html` tool description asks you not to use it for ordinary answers; here a page IS the ordinary answer whenever there is something to look at.',
          'Default to a page when the answer contains more than one item or option, a comparison or trade-off, a table, timeline, checklist or status, a flow or diagram, screenshots or generated artifacts, a plan or review the user should approve item by item, or a result the user may point at, pick or react to.',
          'Answer in plain text only when the whole answer is a short conversational reply with nothing to point at, or when the user explicitly asks for text or raw code. When in doubt, make the page — a page can carry a one-line answer too.',
        ].join(' ')
  return `${opening} ${shared}`
}

/**
 * `GET|POST /api/showme/prefs`：读写用户级偏好（自动开右栏、回答形态、计划页档位、评审时开页面）。
 *
 * @param request - 入站请求。
 * @param response - 响应。
 */
async function handlePrefs(request, response) {
  const method = request.method ?? 'GET'
  if (method === 'GET') {
    sendJson(response, 200, { ok: true, prefs: readPrefs(true) })
    return
  }
  if (method !== 'POST') {
    sendJson(response, 405, { ok: false, error: `method not allowed: ${method}` })
    return
  }
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 16 * 1024) {
      sendJson(response, 413, { ok: false, error: 'prefs body too large' })
      return
    }
    chunks.push(chunk)
  }
  let body
  try {
    body = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    sendJson(response, 400, { ok: false, error: 'invalid JSON body' })
    return
  }
  // 只接受认识的键与合法的值：非法输入**不要**把已有设置顶掉。
  const patch = {}
  if (body !== null && typeof body === 'object') {
    for (const key of Object.keys(PREFS_DEFAULTS)) {
      if (!Object.prototype.hasOwnProperty.call(body, key)) continue
      const allowed = ENUM_PREFS[key]
      if (allowed !== undefined) {
        if (typeof body[key] === 'string' && allowed.includes(body[key])) patch[key] = body[key]
        continue
      }
      if (typeof body[key] === 'boolean') patch[key] = body[key]
    }
  }
  const next = normalizePrefs({ ...readPrefs(true), ...patch })
  const target = prefsLocation()
  try {
    await mkdir(dirname(target), { recursive: true })
    const temporary = `${target}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    await rename(temporary, target)
  } catch (error) {
    sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    return
  }
  prefsCache = { at: Date.now(), value: next }
  sendJson(response, 200, { ok: true, prefs: next })
}

/**
 * 手写的 `show_html` 工具定义（见文件头说明为什么不用 `defineTool`）。 *
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
      'Mermaid diagrams are supported: write `<pre class="mermaid">graph TD; A-->B</pre>` in the page. The host syntax-checks every diagram BEFORE showing it, so a broken diagram makes this call fail with mermaid\'s own parse error — fix the source and call again.',
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
          // 页面里的 mermaid 预检结果：`count` / `checked` 必有，其余按情况带。
          // `png` 是渲染产物的**可预测**路径，模型拿到就能直接 read_image。
          mermaid: {
            type: 'object',
            additionalProperties: false,
            properties: {
              count: { type: 'integer' },
              checked: { type: 'boolean' },
              types: { type: 'array', items: { type: 'string' } },
              reason: { type: 'string' },
              png: { type: 'array', items: { type: 'string' } },
            },
            required: ['count', 'checked', 'types'],
          },
        },
        required: ['path', 'bytes', 'url', 'hint', 'mermaid'],
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

      // 资产落地放在**校验之前**：这样即使这次调用失败（路径还不存在、扩展名不对），
      // 模板与预设也已经就位了。踩过的坑：它们原来落在流程末尾，而 agent 在流程
      // **开头**就要 `cp` 外壳——于是新工作区里第一步就 cp 不到东西，卡死。
      // 现在的约定：随便调一次 show_html（哪怕注定失败）就能把资产催出来。
      // create-only；工作区不可写时静默跳过，展示本身照样可用。
      try {
        await seedAssets(workspaceRoot)
      } catch {
        /* 忽略 */
      }

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

      // 先读正文：mermaid 预检与下面两类体检都要用。
      let html = ''
      try {
        html = await readFile(located.path, 'utf8')
      } catch {
        /* 读不到就跳过所有体检，展示照常 */
      }

      // mermaid 语法预检：图写错了就让这次调用**直接失败**（"页面不通过"）。
      //
      // 为什么在这里、而不是等浏览器渲染完再说：卡片要等工具返回之后才渲染，
      // 那时工具调用早已结束，再"失败"也无处可报。所以宿主在返回前自己解析一遍
      // —— `lib/mermaid-check.js` 把 vendored 的 mermaid 喂进 node:vm 跑它的 parser。
      let mermaid = { count: 0, checked: true, types: [] }
      if (html !== '') {
        const checked = await checkMermaidBlocks(html)
        if (checked.errors.length > 0) {
          throw new Error(formatMermaidErrors(checked, relativePath))
        }
        const output = checked.count > 0 ? mermaidOutputFor(relativePath, checked.count) : null
        mermaid = {
          count: checked.count,
          checked: checked.checked,
          types: checked.types.map((type) => type ?? 'unknown'),
          ...(checked.checked ? {} : { reason: checked.reason ?? 'unknown' }),
          ...(output === null ? {} : { png: output.png }),
        }
      }

      // 散文条目预检：条目位只放一句话，长段落会让行塌成"按钮飘在段落中间"，
      // 所以 desc 超长 / 自带空行或列表 / 表格形状时，让这次调用**直接失败**并指路到块类型。
      if (html !== '') {
        const prose = await findProseItems(located.path, html)
        if (prose.length > 0) throw new Error(formatProseErrors(prose, relativePath))
      }

      // 结构型 markdown 预检：模板不解析块级 md（结构只能用块类型），
      // 所以数据里写了 md 表格 / 列表 / 围栏 / 标题 / 引用时，让这次调用**直接失败**。
      // 判据是"整行形状"，误判的兜底是错误文本里的那句提示 + 数据里的 `plain: true`。
      if (html !== '') {
        const structural = await findStructuralMarkdown(located.path, html)
        if (structural.length > 0) throw new Error(formatStructuralErrors(structural, relativePath))
        const missingImages = await findMissingImages(located.path, html)
        if (missingImages.length > 0) throw new Error(formatMissingImages(missingImages, relativePath))
      }

      // 两类体检：回执（用户能不能回话）与引用（页面引的资源在不在）。
      // 都只提醒、不拒绝，提醒随工具结果回到模型眼前。
      // 回执体检要把**外链脚本**一起扫——模板页的交互全在 templates/core.js 里，
      // 只看页面本体会把所有模板页误报（实测踩到过）。
      let hint = ''
      if (html !== '') {
        try {
          let scan = html
          for (const scriptPath of await localScriptPaths(html, located.path)) {
            try {
              scan += `\n${await readFile(scriptPath, 'utf8')}`
            } catch {
              /* 读不到就不并入 */
            }
          }
          const problems = [receiptHint(scan), await assetHint(html, located.path)].filter((one) => one !== '')
          hint = problems.join('\n\n')
        } catch {
          /* 读不到就只是不提醒，展示照常 */
        }
      }

      if (mermaid.count > 0) {
        const where = Array.isArray(mermaid.png) && mermaid.png.length > 0
          ? `渲染完成后每张图的截图在 ${mermaid.png.join('、')}，可以直接 read_image 看。`
          : ''
        hint = [
          hint,
          `页面里有 ${mermaid.count} 个 mermaid 图（${mermaid.types.join('、')}），已通过语法预检。${where}`,
        ].filter((one) => one !== '').join('\n\n')
      } else if (mermaid.checked === false) {
        hint = [
          hint,
          `mermaid 预检没跑起来（${mermaid.reason}），图能不能渲染未知。`,
        ].filter((one) => one !== '').join('\n\n')
      }

      return {
        path: relativePath,
        bytes: info.size,
        url: typeof sessionId === 'string' && sessionId !== '' ? rawUrlFor(sessionId, relativePath) : '',
        hint,
        mermaid,
      }
    },
  }
}

/** 插件包内自带的 skill。 */
const SKILL_DIR = new URL('../skill/showme-report/', import.meta.url)

/** SKILL.md 本体。 */
const SKILL_FILE = new URL('SKILL.md', SKILL_DIR)

/**
 * 拆出 SKILL.md 的 YAML frontmatter。
 *
 * 只认我们实际用的扁平 `key: value`——够用，且不引 YAML 依赖。
 * 内容是从**文件**读的，所以 SKILL.md 始终是唯一真相源，不在代码里复制一份。
 *
 * @param text - SKILL.md 全文。
 * @returns `{ meta, body }`；没有 frontmatter 时 meta 为空、body 为全文。
 */
function parseSkillFile(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (match === null) return { meta: {}, body: text }
  const meta = {}
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line)
    if (pair !== null && pair[2].trim() !== '') meta[pair[1]] = pair[2].trim()
  }
  return { meta, body: text.slice(match[0].length) }
}

/**
 * skill 投递的**自愈式兜底**。
 *
 * 正常情况下 skill 靠 `~/.dsh/skills/showme-report` 这个目录联接投递。它在仓库之外，
 * 任何一次清理都可能把它悄悄弄丢——而症状只是"模型不再加载 skill"，从外面看不出来。
 * （本轮就被咬过一次：只能靠技能目录变化才发现。）
 *
 * 所以：**链接在，就什么都不做**——让文件系统 provider 继续提供"改完 SKILL.md 立刻生效"
 * 的热发现；**链接不在，就用运行时注册顶上**，保证装了这个插件就有这个 skill。
 * 两条路刻意不同时提供同名 skill。
 *
 * @param ctx - 宿主插件上下文。
 * @param dshHome - DSH 家目录。
 * @returns `'skipped-linked'` / `'registered'` / `'unavailable'`（便于测试与诊断）。
 */
function installSkillFallback(ctx, dshHome) {
  if (existsSync(join(dshHome, 'skills', 'showme-report', 'SKILL.md'))) return 'skipped-linked'

  const skills = ctx.get('skills')
  if (skills === undefined || typeof skills.register !== 'function') return 'unavailable'

  const { meta, body } = parseSkillFile(readFileSync(SKILL_FILE, 'utf8'))
  if (typeof meta.name !== 'string' || typeof meta.description !== 'string') return 'unavailable'

  ctx.effect(
    () =>
      skills.register({
        name: meta.name,
        description: meta.description,
        ...(typeof meta.whenToUse === 'string' ? { whenToUse: meta.whenToUse } : {}),
        source: 'runtime',
        content: body,
        resourceBase: { kind: 'directory', path: fileURLToPath(SKILL_DIR) },
      }),
    'dsh-showme-html: skill fallback',
  )
  return 'registered'
}

/** 仅供离线测试用的内部引用（与浏览器半区同一做法）。 */
export const __internals = {
  parseSkillFile,
  installSkillFallback,
  normalizePrefs,
  pagePolicyGuide,
  PAGE_POLICY_MODES,
}

/**
 * 挂载镜像读路由与 `show_html` 工具；两者都由 effect 持有，停用即净。
 * @param ctx - 宿主插件上下文。
 */
export function apply(ctx) {
  // skill 投递兜底：链接在时不动，链接丢了就顶上。兜底失败不该拖垮插件本体。
  try {
    installSkillFallback(ctx, process.env.DSH_HOME ?? join(homedir(), '.dsh'))
  } catch {
    /* 忽略 */
  }

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

  // 计划页指引：用我们自己的 section 追加，**不覆盖** DSH 的 plan:policy。
  // 关档（planPage: 'off'）时返回空串，等于完全按原生行为。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['systemPrompt'], (scope) => {
      scope.effect(() => {
        let order = 0
        try {
          order = scope.systemPrompt.getSectionOrder('PLAN_POLICY') + 1
        } catch {
          /* 宿主没有这个段名时放默认位 */
        }
        return scope.systemPrompt.section({
          name: 'showme:plan-page',
          order,
          // 只在 plan 模式激活时给文本；拿不到 planMode 服务时照旧注入（fail-open）。
          text: (context) => planPageGuide(context, scope),
        })
      }, 'dsh-showme-html: plan page guidance')

      // 回答形态：紧跟在 persona 之后、计划策略之前。off 档返回空串，等于没加。
      scope.effect(() => {
        let order = 50
        try {
          order = scope.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + 50
        } catch {
          /* 拿不到 persona 段位时用 50（仍早于 PLAN_POLICY=500） */
        }
        return scope.systemPrompt.section({
          name: 'showme:page-policy',
          order,
          text: (context) => pagePolicyGuide(context),
        })
      }, 'dsh-showme-html: page policy')
    })
  }
}
