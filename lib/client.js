/**
 * dsh-showme-html — 浏览器半区，运行在 dsh web GUI 里。
 *
 * 注册四处：
 *  1. `tool.call.toolview`（key = `show_html`）：对话流里的展示卡片。
 *     头部：标题 / 体积 / 侧栏打开 / 刷新 / 全屏 / 浏览器打开。
 *     主体：贴边 iframe，指向宿主镜像路由 —— 于是页面里的相对引用
 *     （图片、同目录 css/js、下级 html 页）全部天然可用。
 *  2. `shell.overlay`：画面内全屏浮层（同一个地址，更大的画布）。
 *     ⚠️ 控件一律放**底部**：Windows 桌面端的顶部 40px 是原生窗口按钮，盖住网页。
 *  3. `conversation.input.left`：镜像当前输入框状态，让"把反馈填进输入框"
 *     能追加而不是覆盖用户已经写了一半的草稿。
 *  4. `sidebarRightTabs` + `sidebar.right.pane.tab`：「侧栏打开」用的**页类型**
 *     与它的正文（同一个镜像地址）。**只按 kind 打开，不认领任何后缀**。
 *
 * ── 与原生文档预览的边界（P0）──
 * 本插件**不认领任何后缀**：不注册 `documentPreviews`，不写 `patterns` / `canOpen`，
 * 不去抢 `.html`。原生 `ui-sidebar-documentpreview` 才是 html/code/图片/office 的
 * 默认归宿；我们只在自己的卡片与自己的侧栏页类型里渲染自己的路由。
 * 页面文件要交给原生文档预览时走座位标准属性 `openFile`（卡片右下角那个路径按钮），
 * 那是**另一条**路，不是本插件的主链路 —— 原生文档预览会把页面塞进 blob iframe，
 * 相对引用与"按文件名推导数据文件"都会失效（见 `SIDEBAR_KIND` 上面的说明）。
 *
 * 反馈通道（两条，都很短）：
 *  - AI 写的页面把汇总文本 `postMessage` 给父页面 → 卡片显示并一键填入输入框；
 *  - 页面自己直连 `POST /api/showme/feedback` 落盘 → 卡片显示"已落盘"。
 *  页面不实现任何一条也不影响使用：页面内的可选中文本本来就是通用交换格式。
 *
 * 该文件是 closure-factory 形态（`window.__ModuleLoader__.load`），平台模块
 * （react 等）由加载器的模块表提供，其余全部内联；因此本包零构建、零依赖。
 */

window.__ModuleLoader__.load({
  id: 'dsh-showme-html',
  factory: (require) => {
    'use strict'
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React

    /** Cordis 插件名（与 cordis.patch.yml 的 id 一致）。 */
    const name = 'dsh-showme-html'
    /** 包名：插件页里认自己那一条（`subject.pkg.name` 与它逐字比对）。 */
    const PACKAGE_NAME = 'dsh-showme-html'
    /** 依赖的客户端服务：槽位系统。 */
    const inject = ['slots']

    /** 宿主镜像路由前缀（与 lib/index.js 的 ROUTE_PREFIX 一致）。 */
    const API = '/api/showme'
    /** 工具名 = 卡片槽位的 key。 */
    const TOOL_NAME = 'show_html'
    /** 页面收到的 postMessage 必须带这个 type 才被卡片认领。 */
    const FEEDBACK_TYPE = 'dsh-showme-feedback'
    /**
     * mermaid 渲染回执的 postMessage type（由 `lib/mermaid-boot.js` 发出）。
     *
     * 页面在不透明源里，没法自己 POST 回宿主 —— 所以它只把结果 postMessage 给
     * 宿主窗口，由这里的**顶层监听**（`relayMermaidReceipt`）转成一次同源请求。
     */
    const MERMAID_TYPE = 'dsh-showme-mermaid'
    /** 卡片内页面默认高度（px）。 */
    const FRAME_HEIGHT = 460

    // ══════════════ Chat 行（让页面不被「工作步骤」折叠吃掉）══════════════

    /**
     * 我们在 Chat 里的行类型（`conversation.chat.node` 的渲染 key）。
     *
     * 为什么需要它 —— 2026-11-01 现场：DSH 加了「工作步骤展示」之后，
     * 完成的轮次会把**整个过程组**收起来（简洁/标准/详细三档都收），
     * 而工具调用行在过程组里，于是 `show_html` 的整页卡片被一起折掉，
     * 用户要展开两层才看得到页面。折叠不是 CSS，是 chat 在 `TurnGroups.rebuild()`
     * 里按 `isAtOrOutside(node, 'process')` 切分：**只有 `groupTree` 深度 ≤ process 的
     * 节点才不被并进组**（深度表 exchange:0 / input:1 / turn:2 / process:3）。
     *
     * 所以我们把自己这一行声明成 `groupTree: 'turn'` —— DSH 自己的 `turn-error`
     * （错误行折叠后仍可见）用的就是这一招。
     */
    const SHOWME_KIND = 'showme-page'
    /** 节点注册成功后才置真：旧宿主没有 `uiConversation` 时保持 false，退回工具行内嵌卡片。 */
    let conversationRowsEnabled = false

    /**
     * 从工具调用事件攒出这条 Chat 行需要的状态。
     *
     * 只认 `show_html`：其它工具一律返回 null（绝不抢行）。
     * 事件字段照宿主实现抄（`rootResult()` / `rootCall()`）：
     * `tool/call` → `data.name` / `data.arguments` / `data.callId`；
     * `tool/result` → `data.message.source.callId`、`data.message.content`、
     * `data.message.isError`、`data.error`、**`data.meta`**（就是 `presentationMeta()` 写的 `{bytes,url}`）。
     *
     * @param event - 会话事件（`{ type, seq, data }`）。
     * @param previous - 上一次的状态（`tool/result` 时用来补齐 name/args）。
     * @returns 状态对象；与本插件无关时返回 null。
     */
    function callState(event, previous) {
      const type = event?.type
      const data = event?.data
      if (type === 'tool/call') {
        if (data?.name !== TOOL_NAME) return null
        return buildCallState({
          seq: event.seq,
          callId: String(data.callId),
          argsRaw: typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {}),
          settled: false,
        })
      }
      if (type === 'tool/result') {
        const source = data?.message?.source
        if (source?.name !== TOOL_NAME && previous?.name !== TOOL_NAME) return null
        return buildCallState({
          seq: event.seq,
          callId: String(source?.callId ?? previous?.callId ?? ''),
          argsRaw: previous?.argsRaw,
          settled: true,
          content: data?.message?.content,
          isError: data?.message?.isError === true,
          error: data?.error,
          meta: data?.meta,
        })
      }
      return null
    }

    /**
     * 把一次调用摊平成渲染用的字段（纯函数，离线测试直接喂假事件）。
     * @param input - `{ seq, callId, argsRaw, settled, content?, isError?, error?, meta? }`。
     * @returns 状态对象。
     */
    function buildCallState(input) {
      let args = null
      if (typeof input.argsRaw === 'string' && input.argsRaw !== '') {
        try {
          const parsed = JSON.parse(input.argsRaw)
          args = parsed !== null && typeof parsed === 'object' ? parsed : null
        } catch {
          args = null
        }
      }
      const meta = input.meta !== null && typeof input.meta === 'object' ? input.meta : undefined
      return {
        seq: input.seq,
        callId: input.callId,
        name: TOOL_NAME,
        argsRaw: typeof input.argsRaw === 'string' ? input.argsRaw : '',
        path: typeof args?.path === 'string' ? args.path : '',
        title: typeof args?.title === 'string' ? args.title : '',
        note: typeof args?.note === 'string' ? args.note : '',
        bytes: typeof meta?.bytes === 'number' ? meta.bytes : undefined,
        url: typeof meta?.url === 'string' ? meta.url : '',
        settled: input.settled === true,
        isError: input.isError === true,
        content: input.content,
        error: input.error,
      }
    }

    /**
     * 状态 → Chat 行数据（卡片要的东西全在这里，渲染器不再解析事件）。
     * @param state - `callState()` 的产物。
     * @returns `{ path, title, note, bytes, url, sessionId, settled, failed, failureText }`。
     */
    function projectCall(state) {
      const path = state?.path ?? ''
      const failed = state?.settled === true && state?.isError === true
      return {
        path,
        title: state?.title !== '' && state?.title !== undefined ? state.title : basename(path),
        note: state?.note ?? '',
        bytes: state?.bytes,
        url: state?.url ?? '',
        // 地址里就带着会话：`/api/showme/raw/<sessionId>/...`。节点视图拿不到 props.sessionId。
        sessionId: sessionIdFromUrl(state?.url ?? ''),
        settled: state?.settled === true,
        failed,
        failureText: failed ? resultTextOf(state?.content, state?.error) : '',
      }
    }

    /**
     * 从镜像地址里解出会话 id。
     * @param url - `meta.url`（`/api/showme/raw/<sessionId>/<path>`）。
     * @returns 会话 id；解不出给空串。
     */
    function sessionIdFromUrl(url) {
      if (typeof url !== 'string' || url === '') return ''
      const parts = url.split('?')[0].split('/').filter((segment) => segment !== '')
      const at = parts.indexOf('raw')
      if (at < 0 || parts.length < at + 2) return ''
      try {
        return decodeURIComponent(parts[at + 1])
      } catch {
        return parts[at + 1]
      }
    }

    /**
     * 结果正文的纯文本（错误态显示原因用）。
     * @param content - `message.content` 块数组。
     * @param error - `event.data.error`。
     * @returns 文本；都没有给空串。
     */
    function resultTextOf(content, error) {
      const text = Array.isArray(content)
        ? content
            .filter((part) => part?.type === 'text' && typeof part.text === 'string')
            .map((part) => part.text)
            .join('\\n')
            .trim()
        : ''
      if (text !== '') return text
      if (typeof error?.message === 'string' && error.message !== '') return error.message
      return ''
    }

    /**
     * Chat 行定义：把每次 `show_html` 变成一条独立行，放在过程组**外面**。
     *
     * 官方给插件留的口子就是这个（`cordis-plugin-development/references/practices.md`：
     * 「Add a Chat row by registering an event definition with `ctx.uiConversation.events.register()`
     * and its view in the `conversation.chat.node` slot under the definition's `kind`」）。
     */
    const showmePageDefinition = {
      kind: SHOWME_KIND,
      target: 'chat',
      match: (event) => {
        const state = callState(event, undefined)
        if (state === null) return null
        return { id: state.callId, role: event.type === 'tool/call' ? 'start' : 'update' }
      },
      start: (_context, match) => callState(match.event, undefined),
      update: (context, match) => callState(match.event, context.state) ?? context.state,
      buildViewNode: (context) => {
        const state = context.state
        if (state === undefined || state === null) return null
        return {
          key: context.key,
          kind: SHOWME_KIND,
          id: context.id,
          target: 'chat',
          // 落在**调用结果**的位置：卡片紧跟它对应的那次调用，而不是被推到轮次末尾。
          anchorSeq: state.seq,
          location: context.start?.location ?? { kind: 'unresolved' },
          visibility: 'visible',
          // ★ 这一行就是"不被折叠"：深度 2（turn）≤ process(3) → 不进过程组。
          groupTree: 'turn',
          data: projectCall(state),
        }
      },
    }

    // ══════════════ 原生右栏 tab（P1 的落点）══════════════

    /**
     * 我们在原生右栏里的**页类型**。
     *
     * ⚠️ 这一条是 2026-09-26 现场踩出来的：`show_html` 的页面有相对引用
     * （预设 CSS、`templates/core.js`、数据文件、页面旁边的图片），
     * 而**现成的两个原生表面都保不住它们**：
     *
     * - **原生文档预览**（`openFile` → `ui-sidebar-documentpreview`）把 HTML 塞进一个
     *   blob iframe：它只把相对 `.js` / `.css` 打包成 blob（`packHtml`），
     *   相对图片、下级页、CSS `url()`、以及"按自己文件名推导数据文件"统统失效 ——
     *   现象就是"没找到数据文件：<blob uuid>.data.js"。
     * - **右栏 Browser tab**（`openTab('browser')`）明确拒绝 **DSH 应用自身 origin**，
     *   而我们的镜像路由正在那个 origin 上。
     *
     * 所以正解是**自己注册一个页类型**：tab 的正文由我们渲染成指向镜像路由的 iframe，
     * 于是"相对引用天然可用"这条本插件的地基在侧栏里也成立。
     * 这是**页类型**：不认领任何后缀（没有 `patterns` / `canOpen`），
     * 不会跟原生文档预览抢地盘 —— 只按 kind 打开。
     */
    const SIDEBAR_KIND = 'showme-page'
    /** 本实现在 tab 系统里的身份；也是正文注册用的 key。 */
    const SIDEBAR_ID = 'dsh-showme-html'
    /** 由 apply() 拿到的右栏导航入口；服务不在时保持 null。 */
    let sidebarRight = null

    /** 右栏页类型的注册定义（页类型：按 kind 打开，不认领后缀）。 */
    function sidebarTabDefinition() {
      return {
        id: SIDEBAR_ID,
        kind: SIDEBAR_KIND,
        multiple: true,
        priority: 'builtin',
        title: () => '展示页',
      }
    }

    // ══════════════ 全屏浮层状态（模块级 store，供两个槽位共享） ══════════════

    let fullscreen = null
    const fullscreenListeners = new Set()

    /** 订阅全屏状态变化。 */
    function subscribeFullscreen(listener) {
      fullscreenListeners.add(listener)
      return () => fullscreenListeners.delete(listener)
    }

    /** 读取全屏状态快照（引用稳定，只在变更时替换）。 */
    function getFullscreen() {
      return fullscreen
    }

    /** 进入/退出全屏。 */
    function setFullscreen(next) {
      const previous = fullscreen
      fullscreen = next
      for (const listener of fullscreenListeners) listener()
      return previous
    }

    // ══════════════ 输入框镜像（追加而不是覆盖用户的草稿） ══════════════

    const inputRefs = { draft: '', actions: null, sessionId: '' }

    /** 把一段文本追加进输入框；优先用镜像到的输入面，其次用卡片自带的那份。 */
    function insertIntoComposer(text, fallbackActions) {
      const actions = inputRefs.actions ?? fallbackActions ?? null
      if (actions === null || typeof actions.setDraft !== 'function') return false
      const current = typeof inputRefs.draft === 'string' ? inputRefs.draft : ''
      const separator = current === '' || current.endsWith('\n') ? '' : '\n'
      actions.setDraft(current + separator + text)
      return true
    }

    /**
     * 那个不可见的输入面镜像座位：每次渲染把活的输入状态抄进模块状态。
     *
     * ⚠️ 真契约（Inspect 查到的 `conversation.input.left`）：**`ownerProps: []`**。
     * 这个座位**没有 owner props**，只有标准 props —— 其中 `inputActions` 用来写，
     * `useInput` 这个**选择器 hook** 用来读草稿。
     *
     * 早期版本照抄 `dsh-text-drop` 写成 `props.input?.draft`：那个 `input` 属性不存在，
     * 于是 `inputRefs.draft` 永远是空串，`insertIntoComposer` 就当成"草稿是空的"，
     * 执行 `setDraft(回执)` —— **把用户写了一半的话整个替换掉**。
     * 按钮因此变得不可信，用户只能退回手抄。
     * （同一个错误写法在 `dsh-text-drop` 里也有。）
     *
     * @param props - 该座位的标准 props（sessionId / inputActions / useInput）。
     */
    function InputCapture(props) {
      // 必须无条件调用 hook（React 的 hook 顺序），所以不做 typeof 兜底。
      // 框架保证 session 作用域的槽位组件都能拿到 useInput。
      const draft = props.useInput((state) => state.draft)
      inputRefs.actions = props.inputActions ?? null
      inputRefs.draft = typeof draft === 'string' ? draft : ''
      inputRefs.sessionId = props.sessionId ?? ''
      return null
    }

    // ══════════════ 小工具 ══════════════

    /** 把工作区相对路径变成镜像路由地址；逐段编码，保留目录结构。 */
    function rawUrl(sessionId, workspacePath) {
      // 空 sessionId 会拼出 `/api/showme/raw//<path>`，路由那边只会回
      // `expected /raw/<sessionId>/<workspace-relative path>` —— 与其让用户看这条，
      // 不如干脆不产出地址（上层会显示"拿不到地址"）。
      if (typeof sessionId !== 'string' || sessionId === '') return ''
      const normalized = String(workspacePath).replace(/\\/g, '/').replace(/^\/+/, '')
      const encoded = normalized
        .split('/')
        .filter((segment) => segment !== '')
        .map((segment) => encodeURIComponent(segment))
        .join('/')
      return `${API}/raw/${encodeURIComponent(sessionId)}/${encoded}`
    }

    /** 从工具调用块里取出参数对象（running 与 settled 两种形态都覆盖）。 */
    function readArgs(block) {
      const source = block?.kind === 'tool-result' ? block.call : block
      const raw = source?.argsRaw
      if (typeof raw !== 'string' || raw === '') return null
      try {
        const parsed = JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object' ? parsed : null
      } catch {
        return null
      }
    }

    /** 取出 settled 结果的纯文本内容（错误态用来显示原因）。 */
    function readResultText(block) {
      const content = block?.content
      if (!Array.isArray(content)) return ''
      return content
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n')
        .trim()
    }

    /** 路径末段，作为默认标题。 */
    function basename(workspacePath) {
      const normalized = String(workspacePath).replace(/\\/g, '/')
      const parts = normalized.split('/').filter((segment) => segment !== '')
      return parts.length > 0 ? parts[parts.length - 1] : normalized
    }

    /** 人读的体积。 */
    function humanBytes(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return ''
      if (value < 1024) return `${value} B`
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
      return `${(value / (1024 * 1024)).toFixed(1)} MB`
    }

    /**
     * 把这一页送进**原生右栏**（我们自己的页类型）。
     *
     * 走 `ctx.sidebarRight.openTab(SIDEBAR_KIND, { params: { url, title } })`，
     * 正文是我们注册的那个 iframe（见 `SidebarTabBody`）——
     * 所以侧栏里渲染的地址与卡片**完全同一个**：相对引用、数据文件、回执都照旧。
     *
     * 为什么不直接把文件丢给原生文档预览：见 `SIDEBAR_KIND` 上面那段（blob iframe 会毁掉
     * 相对引用与数据文件命名）。为什么不走右栏 Browser tab：它拒绝应用自身 origin。
     *
     * @param url - **绝对**地址（相对地址在侧栏里没有意义）。
     * @param title - 页面标题，进 tab chip 与 iframe 的 title。
     * @returns `'sidebar'` / `'window'` / `'none'`。
     */
    function openInSidebar(url, title) {
      if (typeof url !== 'string' || url === '') return 'none'

      if (sidebarRight !== null && typeof sidebarRight.openTab === 'function') {
        try {
          sidebarRight.openTab(SIDEBAR_KIND, { params: { url, title } })
          return 'sidebar'
        } catch {
          /* 类型没注册上时 throw —— 落到兜底 */
        }
      }

      if (typeof window !== 'undefined' && typeof window.open === 'function') {
        window.open(url, '_blank', 'noopener,noreferrer')
        return 'window'
      }
      return 'none'
    }

    // ══════════════ 偏好（用户级）与自动开右栏 ══════════════

    /** 偏好路由（用户级，落 `<DSH_HOME>/showme/prefs.json`）。 */
    const PREFS_ENDPOINT = `${API}/prefs`

    /** 计划 markdown 里指向展示页的那一行：`展示页：<工作区相对路径>`。 */
    const PLAN_PAGE_MARKER = /^\s*展示页[:：]\s*(\S+)\s*$/m

    /** 自动开右栏的最小窗口宽度：再窄就只留卡片上的按钮（右栏会挤掉正文）。 */
    const AUTO_OPEN_MIN_WIDTH = 1200

    /** 同一轮里多次 show_html 的防抖窗口：只开最后那一张。 */
    const AUTO_OPEN_DELAY = 1200

    /** 默认值；宿主读不到时用它（与 lib/index.js 的 PREFS_DEFAULTS 一致）。 */
    const PREFS_FALLBACK = { autoOpenSidebar: true, planPage: 'offer', planPageOpenOnReview: true }

    /**
     * 读用户级偏好。
     * @returns 偏好对象；失败退回默认值。
     */
    async function fetchPrefs() {
      try {
        const response = await fetch(PREFS_ENDPOINT, { headers: { accept: 'application/json' } })
        if (response === undefined || response === null || response.ok !== true) return { ...PREFS_FALLBACK }
        const body = await response.json()
        return { ...PREFS_FALLBACK, ...(body?.prefs ?? {}) }
      } catch {
        return { ...PREFS_FALLBACK }
      }
    }

    /**
     * 写用户级偏好（只提交改动的那几项）。
     * @param patch - 要改的键。
     * @returns 写后的偏好；失败抛错交给调用方显示。
     */
    async function savePrefs(patch) {
      const response = await fetch(PREFS_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (response === undefined || response === null || response.ok !== true) throw new Error('保存失败')
      const body = await response.json()
      return { ...PREFS_FALLBACK, ...(body?.prefs ?? {}) }
    }

    /**
     * 打开前先 HEAD 一下：路径写错时**不要**开一个空白 tab。
     * @param url - 镜像地址。
     */
    async function pageExists(url) {
      if (typeof url !== 'string' || url === '') return false
      try {
        const response = await fetch(url, { method: 'HEAD' })
        return response !== undefined && response !== null && response.ok === true
      } catch {
        return false
      }
    }

    /** 打开一个展示页：先验存在，再走右栏（失败给可读原因）。 */
    async function openShowmePage(sessionId, workspacePath, title) {
      if (sessionId === '' || workspacePath === '') return 'missing'
      const url = rawUrl(sessionId, workspacePath)
      if (!(await pageExists(url))) return 'missing'
      return openInSidebar(url, title !== undefined && title !== '' ? title : basename(workspacePath))
    }

    /** 自动开右栏的模块级状态：保证"每轮只开最后一张、每个页面只开一次"。 */
    const autoOpen = { timer: 0, latest: null, opened: new Set() }

    /**
     * 把"这张卡是当前最新的一张"记下来，1.2s 后开它。
     * @param entry - `{ key, url, title }`。
     */
    function scheduleAutoOpen(entry) {
      autoOpen.latest = entry
      if (typeof window === 'undefined') return
      if (autoOpen.timer !== 0) window.clearTimeout(autoOpen.timer)
      autoOpen.timer = window.setTimeout(() => {
        autoOpen.timer = 0
        void runAutoOpen()
      }, AUTO_OPEN_DELAY)
    }

    /** 真的去开（防抖窗口到了之后）。 */
    async function runAutoOpen() {
      const entry = autoOpen.latest
      if (entry === null || entry === undefined) return
      if (autoOpen.opened.has(entry.key)) return
      if (typeof window !== 'undefined' && window.innerWidth < AUTO_OPEN_MIN_WIDTH) return
      const prefs = await fetchPrefs()
      if (prefs.autoOpenSidebar !== true) return
      if (!(await pageExists(entry.url))) return
      autoOpen.opened.add(entry.key)
      openInSidebar(entry.url, entry.title)
    }

    /** 计划评审里"已经自动开过"的记录（按 requestKey）。 */
    const planOpened = new Set()

    // ══════════════ 卡片 ══════════════

    /**
     * 把页面发来的 mermaid 渲染回执转成一次同源请求。
     *
     * 为什么要绕这一圈：展示页跑在 `sandbox` **不透明源**里，它自己 POST 回宿主
     * 会被跨域拦掉；而 `postMessage` 能出来。于是页面只负责"算"，同源的这里负责"送"。
     *
     * 失败只吞掉（`console` 都没有，宿主不可用时页面照常看），不影响展示。
     *
     * @param data - 页面 postMessage 过来的对象。
     */
    function relayMermaidReceipt(data) {
      const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : ''
      const page = typeof data?.page === 'string' ? data.page : ''
      if (sessionId === '' || page === '') return

      const diagrams = (Array.isArray(data.diagrams) ? data.diagrams : []).map((item, index) => ({
        index: Number.isInteger(item?.index) ? item.index : index + 1,
        type: typeof item?.type === 'string' ? item.type : null,
        error: typeof item?.error === 'string' ? item.error : null,
        png: typeof item?.png === 'string' ? item.png : null,
      }))

      try {
        void fetch(`${API}/mermaid`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, page, ok: data.ok === true, diagrams }),
        }).catch(() => {})
      } catch {
        /* 没有 fetch（纯静态预览）就只是拿不到 PNG */
      }
    }

    // ══════════════ 草稿：刷新 / 切会话不丢 ══════════════
    //
    // 展示页是不透明源：它既碰不到 localStorage，也不能直接 POST 宿主。
    // 所以页面只把状态 postMessage 出来，由这里（同源）落盘与读回：
    //   ready  → 读 GET /api/showme/draft → 回灌 { type: RESTORE, state }
    //   draft  → 写 POST /api/showme/draft（clear 为真时删掉）

    /** 页面上报状态用的 type（`templates/core.js` 发出）。 */
    const DRAFT_TYPE = 'dsh-showme-draft'
    /** 页面加载完成、要草稿的 type。 */
    const DRAFT_READY_TYPE = 'dsh-showme-draft-ready'
    /** 卡片把草稿灌回页面的 type。 */
    const DRAFT_RESTORE_TYPE = 'dsh-showme-draft-restore'

    /** 页面渲染完成/失败的 type（`templates/core.js` 的 `reportRendered` 发出）。 */
    const RENDERED_TYPE = 'dsh-showme-rendered'

    /**
     * 从镜像地址里解出这份草稿的身份：`{ sessionId, page }`。
     * 解不出来（blob / 别的地址）就返回 null —— 没有草稿，一切照旧。
     *
     * @param url - 镜像地址。
     */
    function draftIdentityFromUrl(url) {
      if (typeof url !== 'string' || url === '') return null
      const match = /\/api\/showme\/raw\/([^/?#]+)\/([^?#]+)/.exec(url)
      if (match === null) return null
      try {
        return { sessionId: decodeURIComponent(match[1]), page: decodeURIComponent(match[2]) }
      } catch {
        return null
      }
    }

    /**
     * 只留 `string → string` 的扁平表，顺手截断（与宿主侧同一套口径）。
     * @param value - 入站值。
     */
    function draftStringRecord(value) {
      const out = {}
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return out
      for (const [key, item] of Object.entries(value)) {
        if (typeof item !== 'string' || item === '') continue
        out[String(key).slice(0, 200)] = item.slice(0, 4000)
      }
      return out
    }

    /**
     * 从页面的 DRAFT 消息里取出要落盘的两张表。
     * @param data - 页面 postMessage 的对象。
     */
    function draftPayloadOf(data) {
      return {
        verdicts: draftStringRecord(data?.state?.verdicts),
        notes: draftStringRecord(data?.state?.notes),
      }
    }

    /**
     * 把草稿写到宿主（失败就吞掉：草稿丢一次比打断用户更轻）。
     * @param identity - `{ sessionId, page }`。
     * @param data - 页面发来的 DRAFT 消息。
     */
    function relayDraft(identity, data) {
      if (identity === null) return
      const payload = {
        sessionId: identity.sessionId,
        page: identity.page,
        clear: data?.clear === true,
        ...draftPayloadOf(data),
      }
      try {
        void fetch(`${API}/draft`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(() => {})
      } catch {
        /* 没有 fetch 就算了 */
      }
    }

    /**
     * 读回这份草稿。
     * @param identity - `{ sessionId, page }`。
     * @returns 草稿对象，没有就是 null。
     */
    async function fetchDraft(identity) {
      if (identity === null) return null
      try {
        const response = await fetch(
          `${API}/draft?session=${encodeURIComponent(identity.sessionId)}&page=${encodeURIComponent(identity.page)}`,
          { headers: { accept: 'application/json' } },
        )
        if (response === undefined || response === null || response.ok !== true) return null
        const body = await response.json()
        return body?.draft ?? null
      } catch {
        return null
      }
    }

    /**
     * 把页面交回的反馈也落一份盘。
     *
     * 页面自己 `POST /api/showme/feedback` 在卡片里必然被跨域拦掉（不透明源），
     * 而在浏览器标签页里打开时又没有卡片 —— 两边不会重复写。
     *
     * @param identity - `{ sessionId, page }`。
     * @param text - 组好的回执文本。
     */
    function relayFeedback(identity, text) {
      if (identity === null || typeof text !== 'string' || text.trim() === '') return
      try {
        void fetch(`${API}/feedback`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: identity.sessionId, page: identity.page, text }),
        }).catch(() => {})
      } catch {
        /* 没有 fetch 就算了 */
      }
    }

    /**
     * 草稿通道的宿主侧接线：页面 ready 时灌回去，页面变化时存下来。
     *
     * 只认**这一页自己**的 iframe（按 `event.source` 对 `src` 判据太脆，
     * 这里用身份 + 消息类型过滤，页面是本插件的页面，不设防外部页面）。
     *
     * @param url - 这一页的镜像地址。
     */
    function useDraftBridge(url) {
      const identity = useMemo(() => draftIdentityFromUrl(url), [url])
      const sessionId = identity?.sessionId ?? ''
      const page = identity?.page ?? ''
      useEffect(() => {
        const current = sessionId === '' || page === '' ? null : { sessionId, page }
        if (current === null) return undefined
        const onMessage = (event) => {
          const data = event?.data
          if (data === null || typeof data !== 'object') return
          if (data.type === DRAFT_READY_TYPE) {
            const source = event.source
            void fetchDraft(current).then((draft) => {
              try {
                source?.postMessage({ type: DRAFT_RESTORE_TYPE, state: draft }, '*')
              } catch {
                /* 页面已经走了 */
              }
            })
            return
          }
          if (data.type === DRAFT_TYPE) {
            relayDraft(current, data)
            return
          }
          // 顺手把页面交回的反馈落一份盘（页面自己 POST 在卡片里会被跨域拦掉）。
          if (data.type === FEEDBACK_TYPE) relayFeedback(current, data.text)
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
      }, [sessionId, page])
      return identity
    }

    /**
     * 从 postMessage 里挑出"这个页面"的失败项。
     * @param data - 消息体。
     * @param page - 本卡片的页面路径。
     * @returns 失败项数组；不是本页面的回执则 null。
     */
    function mermaidFailuresOf(data, page) {
      if (data === null || typeof data !== 'object' || data.type !== MERMAID_TYPE) return null
      if (typeof data.page !== 'string' || data.page !== page) return null
      const diagrams = Array.isArray(data.diagrams) ? data.diagrams : []
      return diagrams.filter((item) => typeof item?.error === 'string' && item.error !== '')
    }

    /**
     * 解析这次展示该用哪个会话 id。
     *
     * 节点视图拿不到 `props.sessionId`，而 `meta.url` 在客户端的会话事件里**不保证有** ——
     * 缺了它卡片会拼出 `/api/showme/raw//<path>`，路由回的就是
     * `{"ok":false,"error":"expected /raw/<sessionId>/<workspace-relative path>"}`
     * （2026-11-01 独立实例上的现场）。所以最后一级兜底是**输入框座位记下的当前会话**
     * （`conversation.input.left` 的 props 里有，一直在）。
     * @param source - 来源对象（可能带 sessionId）。
     * @param propSessionId - 工具行给的 sessionId（旧渲染路径）。
     * @returns 会话 id；都没有给空串。
     */
    function resolveSessionId(source, propSessionId) {
      if (typeof propSessionId === 'string' && propSessionId !== '') return propSessionId
      if (typeof source?.sessionId === 'string' && source.sessionId !== '') return source.sessionId
      if (typeof inputRefs.sessionId === 'string' && inputRefs.sessionId !== '') return inputRefs.sessionId
      return ''
    }

    /**
     * 解析这次展示该用哪个地址。
     * @param source - 来源对象。
     * @param propSessionId - 工具行给的 sessionId。
     * @returns 镜像地址；拿不到就给空串（卡片会显示一句能行动的话，而不是坏 iframe）。
     */
    function resolveCardUrl(source, propSessionId) {
      const hostUrl = typeof source?.url === 'string' ? source.url : ''
      if (hostUrl !== '') return hostUrl
      const path = typeof source?.path === 'string' ? source.path : ''
      if (path === '') return ''
      return rawUrl(resolveSessionId(source, propSessionId), path)
    }

    /**
     * 工具行那条路径的来源对象（旧宿主 / Chat 行不可用时用）。
     *
     * 与 `projectCall()` 产出同一个形状 —— 卡片只认「来源对象」，不关心它来自
     * 事件投影（Chat 行）还是 `tool.call.toolview` 的 block。
     * @param block - ToolCallOwnerProps 的 block（running 的 tool-call 或 settled 的 tool-result）。
     * @returns 来源对象。
     */
    function sourceFromToolBlock(block) {
      const settled = block?.kind === 'tool-result'
      const args = readArgs(block)
      const path = typeof args?.path === 'string' ? args.path : ''
      const failed = settled && block?.isError === true
      const meta = block?.meta !== null && typeof block?.meta === 'object' ? block.meta : undefined
      const url = typeof meta?.url === 'string' ? meta.url : ''
      return {
        path,
        title: typeof args?.title === 'string' ? args.title : '',
        note: typeof args?.note === 'string' ? args.note : '',
        bytes: typeof meta?.bytes === 'number' ? meta.bytes : undefined,
        url,
        sessionId: sessionIdFromUrl(url),
        settled,
        failed,
        failureText: failed ? readResultText(block) : '',
      }
    }

    /**
     * 一次 `show_html` 调用的展示卡片。
     * @param props - `{ source?, block?, sessionId?, inputActions?, openFile? }`。
     *   `source` 由 Chat 行或工具行给出；两者都不给时按 block 现算。
     */
    function ShowmeCard(props) {
      const source = props.source ?? sourceFromToolBlock(props.block)
      const sessionId = resolveSessionId(source, props.sessionId)
      const openFile = props.openFile

      const workspacePath = source.path
      const title =
        (source.title !== '' && source.title !== undefined ? source.title : basename(workspacePath)) || '展示页'
      const note = source.note
      const failed = source.failed === true
      const failureText = source.failureText ?? ''
      const bytes = source.bytes

      const [nonce, setNonce] = useState(0)
      const [visible, setVisible] = useState(false)
      const [feedback, setFeedback] = useState(null)
      const [notice, setNotice] = useState('')
      const [nativeNotice, setNativeNotice] = useState('')
      const [mermaidFailures, setMermaidFailures] = useState(null)
      const [rendered, setRendered] = useState(null)
      const rootRef = useRef(null)

      // 非可见的卡片不持有活 iframe：历史里几十张卡片同时跑动画会直接把会话拖卡。
      //
      // ⚠️ **不要只信 IntersectionObserver**。2026-11-01 在独立实例上实测：
      // 卡片明明整个在视口里，IO 的首次回调给的却是 `isIntersecting: false`，
      // 之后也不再触发 —— 页面就永远停在"滚动到这里时载入页面"。
      // （chat 的流容器是 `overflow: clip` + `container-type: inline-size`，
      // IO 在那种祖先链下不按预期工作。）所以这里改用几何判断 + 退避轮询兜底，
      // 并且 scroll / resize 时立即复检。代价是每张离屏卡片一个定时器，
      // 一旦进入视口就停 —— 比"页面永远不出来"好得多。
      useEffect(() => {
        const element = rootRef.current
        if (element === null || typeof window === 'undefined') {
          setVisible(true)
          return undefined
        }
        let cancelled = false
        let timer = 0
        let delay = 250
        const inView = () => {
          const rect = element.getBoundingClientRect()
          if (rect.height === 0) return false
          const viewport = window.innerHeight || 0
          return rect.bottom > -200 && rect.top < viewport + 200
        }
        const tick = () => {
          if (cancelled) return
          if (inView()) {
            setVisible(true)
            return
          }
          delay = Math.min(delay * 1.6, 3000)
          timer = window.setTimeout(tick, delay)
        }
        const onMove = () => {
          if (!cancelled && inView()) setVisible(true)
        }
        tick()
        window.addEventListener('scroll', onMove, { passive: true, capture: true })
        window.addEventListener('resize', onMove)
        return () => {
          cancelled = true
          window.clearTimeout(timer)
          window.removeEventListener('scroll', onMove, { capture: true })
          window.removeEventListener('resize', onMove)
        }
      }, [])

      // 页面把汇总文本 postMessage 给父页面 —— 卡片是可靠的剪贴板与输入框通道。
      useEffect(() => {
        const onMessage = (event) => {
          const data = event?.data
          if (data === null || typeof data !== 'object') return
          if (data.type !== FEEDBACK_TYPE) return
          if (typeof data.text !== 'string' || data.text.trim() === '') return
          setFeedback(data.text)
          setNotice('')
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
      }, [])

      // mermaid 渲染结果：语法预检已经在宿主那边挡过一道，这里只管"运行时"失败的显性化
      // —— 页面里会画红框，卡片头部再挂一个徽标，用户不必等 agent 才发现。
      useEffect(() => {
        const onMessage = (event) => {
          const failures = mermaidFailuresOf(event?.data, workspacePath)
          if (failures !== null) setMermaidFailures(failures)
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
      }, [workspacePath])

      // 页面自己报"我渲染好了 / 我挂了"。卡片看不到 iframe 里的 DOM（不透明源），
      // 白屏过去只能等用户说 —— 这一条把"页面到底出来了没有"变成可观测的。
      useEffect(() => {
        const onMessage = (event) => {
          const data = event?.data
          if (data === null || typeof data !== 'object' || data.type !== RENDERED_TYPE) return
          setRendered({
            ok: data.ok === true,
            failed: data.failed === true,
            ids: Number(data.ids) || 0,
            buttons: Number(data.buttons) || 0,
            message: typeof data.message === 'string' ? data.message : '',
          })
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
      }, [])

      const url = resolveCardUrl(source, props.sessionId)
      // 草稿通道：页面 ready 时把它上次的选择灌回去；页面变化时顺手存一份。
      useDraftBridge(url)

      // 自动在右栏打开：用户偏好 + 每轮只开最后一张 + 每个页面只开一次。
      useEffect(() => {
        if (url === '' || failed === true) return
        let absolute = url
        try {
          absolute = new URL(url, window.location.href).href
        } catch {
          /* 不是 URL 就按原样用 */
        }
        scheduleAutoOpen({
          key: `${sessionIdFromUrl(url)}|${workspacePath}`,
          url: absolute,
          title,
        })
      }, [url, failed, workspacePath, title])

      const onRefresh = useCallback(() => setNonce((value) => value + 1), [])

      const onCopy = useCallback(() => {
        if (feedback === null) return
        if (navigator.clipboard?.writeText !== undefined) {
          navigator.clipboard.writeText(feedback).then(
            () => setNotice('已复制 ✓'),
            () => setNotice('复制被浏览器拒绝，请手动选中'),
          )
        } else {
          setNotice('请手动选中复制')
        }
      }, [feedback])

      const onInsert = useCallback(() => {
        if (feedback === null) return
        const inserted = insertIntoComposer(feedback, props.inputActions)
        setNotice(inserted ? '已填入输入框 ✓' : '输入框当前不可用，请用复制')
      }, [feedback, props.inputActions])

      const onFullscreen = useCallback(() => {
        if (url === '') return
        setFullscreen({ url: `${url}?v=${nonce}`, title, workspacePath })
      }, [url, title, workspacePath, nonce])

      // 侧栏打开（P1）：送进原生右栏里我们自己的页类型，渲染的还是这个镜像地址。
      const onSidebar = useCallback(() => {
        const absolute =
          url === '' || typeof window === 'undefined'
            ? ''
            : new URL(url, window.location.href).href
        const describe = (how) =>
          how === 'sidebar'
            ? '已在右侧栏打开'
            : how === 'window'
              ? '右侧栏不可用，已在新标签页打开'
              : '打不开：当前环境没有可用的预览入口'
        setNativeNotice(describe(openInSidebar(absolute, title)))
      }, [url, title])

      // ── 参数缺失 / 调用失败：给一句能行动的话，不白屏 ──
      if (workspacePath === '') {
        return h(
          'div',
          { className: 'dsh-showme-card', ref: rootRef },
          h('div', { className: 'dsh-showme-head' }, h('span', { className: 'dsh-showme-badge' }, 'show_html')),
          h('div', { className: 'dsh-showme-error' }, '这次调用没有带上有效的页面路径。'),
        )
      }

      if (failed) {
        return h(
          'div',
          { className: 'dsh-showme-card', ref: rootRef },
          h(
            'div',
            { className: 'dsh-showme-head' },
            h('span', { className: 'dsh-showme-badge' }, 'show_html'),
            h('span', { className: 'dsh-showme-title' }, title),
          ),
          h('div', { className: 'dsh-showme-error' }, failureText === '' ? '展示失败。' : failureText),
          h('div', { className: 'dsh-showme-path' }, workspacePath),
        )
      }

      if (url === '') {
        return h(
          'div',
          { className: 'dsh-showme-card', ref: rootRef },
          h(
            'div',
            { className: 'dsh-showme-head' },
            h('span', { className: 'dsh-showme-badge' }, 'show_html'),
            h('span', { className: 'dsh-showme-title' }, title),
          ),
          h('div', { className: 'dsh-showme-error' }, '拿不到这一页的地址（会话还没就绪）。刷新一下聊天页再试。'),
          h('div', { className: 'dsh-showme-path' }, workspacePath),
        )
      }

      const frame = visible
        ? h('iframe', {
            key: nonce,
            className: 'dsh-showme-frame',
            src: `${url}?v=${nonce}`,
            sandbox: 'allow-scripts allow-popups allow-popups-to-escape-sandbox',
            title,
          })
        : h('div', { className: 'dsh-showme-placeholder' }, '滚动到这里时载入页面')

      return h(
        'div',
        { className: 'dsh-showme-card', ref: rootRef },
        h(
          'div',
          { className: 'dsh-showme-head' },
          h('span', { className: 'dsh-showme-badge' }, 'show_html'),
          h('span', { className: 'dsh-showme-title', title }, title),
          typeof bytes === 'number' ? h('span', { className: 'dsh-showme-size' }, humanBytes(bytes)) : null,
          mermaidFailures === null
            ? null
            : h(
                'span',
                {
                  className:
                    mermaidFailures.length === 0
                      ? 'dsh-showme-mermaidBadge'
                      : 'dsh-showme-mermaidBadge dsh-showme-mermaidBadge-warn',
                  title:
                    mermaidFailures.length === 0
                      ? 'mermaid 图都渲染出来了'
                      : mermaidFailures
                          .map((item) => `第 ${item.index} 张${item.type ? `（${item.type}）` : ''}：${item.error}`)
                          .join('\n\n'),
                },
                mermaidFailures.length === 0 ? 'mermaid ✓' : `mermaid 失败 ×${mermaidFailures.length}`,
              ),
          rendered === null
            ? null
            : h(
                'span',
                {
                  className: rendered.failed
                    ? 'dsh-showme-renderBadge dsh-showme-renderBadge-warn'
                    : 'dsh-showme-renderBadge',
                  title: rendered.failed
                    ? rendered.message || '页面在 iframe 里抛错了（详见页面内红框）'
                    : `可点名 ${rendered.ids} 项 · 判定按钮 ${rendered.buttons} 个`,
                },
                rendered.failed ? '渲染失败' : `${rendered.ids} 项 · ${rendered.buttons} 按钮`,
              ),
          h(
            'div',
            { className: 'dsh-showme-actions' },
            h('button', { type: 'button', className: 'dsh-showme-btn', onClick: onSidebar }, '侧栏打开'),
            h('button', { type: 'button', className: 'dsh-showme-btn', onClick: onRefresh }, '刷新'),
            h('button', { type: 'button', className: 'dsh-showme-btn', onClick: onFullscreen }, '全屏'),
            h(
              'a',
              { className: 'dsh-showme-btn', href: url, target: '_blank', rel: 'noreferrer' },
              '浏览器打开',
            ),
          ),
        ),
        note === '' && nativeNotice === ''
          ? null
          : h(
              'div',
              { className: 'dsh-showme-note' },
              note,
              note !== '' && nativeNotice !== '' ? ' · ' : '',
              nativeNotice,
            ),
        h(
          'div',
          { className: 'dsh-showme-stage', style: { height: `${FRAME_HEIGHT}px` } },
          frame,
        ),
        h(
          'div',
          { className: 'dsh-showme-foot' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-showme-link',
              onClick: () => {
                if (typeof openFile === 'function') openFile(workspacePath)
              },
            },
            workspacePath,
          ),
          h('span', { className: 'dsh-showme-hint' }, '卡片是安全模式：表单/下载/弹窗请用「浏览器打开」'),
        ),
        feedback === null
          ? null
          : h(
              'div',
              { className: 'dsh-showme-feedback' },
              h('div', { className: 'dsh-showme-feedbackHead' }, '页面交回的反馈'),
              h('textarea', { className: 'dsh-showme-feedbackText', readOnly: true, value: feedback }),
              h(
                'div',
                { className: 'dsh-showme-actions' },
                h('button', { type: 'button', className: 'dsh-showme-btnPrimary', onClick: onInsert }, '填入输入框'),
                h('button', { type: 'button', className: 'dsh-showme-btn', onClick: onCopy }, '复制'),
                notice === '' ? null : h('span', { className: 'dsh-showme-notice' }, notice),
              ),
            ),
      )
    }

    /**
     * Chat 行渲染器：`conversation.chat.node` 里 key = SHOWME_KIND 的那个条目。
     *
     * 拿到的 props 是 chat 的 owner（`{ node, openFile, cwd, inspectCall, ... }`）——
     * **没有 `block`，也没有 `sessionId`**。数据全在 `node.data` 里（由 `projectCall()` 生成，
     * 形状与工具行的来源对象一致），会话 id 从地址里解。
     * @param props - Chat 节点视图 props。
     * @returns 卡片；没有数据时不渲染。
     */
    function ShowmePageNode(props) {
      const source = props.node?.data
      if (source === undefined || source === null) return null
      // ⚠️ **sessionId 要显式转交**：槽位会给标准 props，但 `ShowmeCard` 只认自己收到的那些。
      // 漏了这一句，卡片就会拿不到会话、拼出 `/api/showme/raw//<path>`
      // （现场报错：`expected /raw/<sessionId>/<workspace-relative path>`）。
      return h(ShowmeCard, {
        source,
        sessionId: typeof props.sessionId === 'string' ? props.sessionId : '',
        openFile: props.openFile,
      })
    }

    /**
     * 工具行里的一行摘要。
     *
     * Chat 行可用时**不再内嵌整页 iframe**：页面已经在过程组外面单独一行了，
     * 工具行只保留"这次调用做了什么"和两个不必滚动的入口。
     * Chat 行不可用（旧宿主）时原样返回整张卡片 —— 行为与 0.2.3 完全一致。
     * @param props - `tool.call.toolview` 的 owner props。
     * @returns 摘要行或整张卡片。
     */
    function ShowmeToolRow(props) {
      if (!conversationRowsEnabled) return h(ShowmeCard, props)

      const source = sourceFromToolBlock(props.block)
      const sessionId = props.sessionId ?? source.sessionId
      const workspacePath = source.path
      const title =
        (source.title !== '' && source.title !== undefined ? source.title : basename(workspacePath)) || '展示页'
      const url =
        source.url !== ''
          ? source.url
          : workspacePath === '' || !sessionId
            ? ''
            : rawUrl(sessionId, workspacePath)

      const onSidebar = () => {
        if (url === '') return
        const absolute = new URL(url, window.location.href).href
        openInSidebar(absolute, title)
      }

      return h(
        'div',
        { className: 'dsh-showme-card dsh-showme-compactRow' },
        h(
          'div',
          { className: 'dsh-showme-head' },
          h('span', { className: 'dsh-showme-badge' }, 'show_html'),
          h('span', { className: 'dsh-showme-title' }, title),
          typeof source.bytes === 'number' ? h('span', { className: 'dsh-showme-size' }, humanBytes(source.bytes)) : null,
          source.failed === true
            ? h('span', { className: 'dsh-showme-mermaidBadge dsh-showme-mermaidBadge-warn' }, '失败')
            : null,
          h('span', { className: 'dsh-showme-compactHint' }, '页面在下方'),
          url === ''
            ? null
            : h(
                'div',
                { className: 'dsh-showme-actions' },
                h('button', { type: 'button', className: 'dsh-showme-btn', onClick: onSidebar }, '侧栏打开'),
                h(
                  'a',
                  { className: 'dsh-showme-btn', href: url, target: '_blank', rel: 'noreferrer' },
                  '浏览器打开',
                ),
              ),
        ),
      )
    }

    // ══════════════ 全屏浮层 ══════════════

    /**
     * `shell.overlay` 座位：画面内全屏看同一份地址。
     *
     * ⚠️ **全部控件都放在底部条，顶部一律不放可点的东西。**
     *
     * 原因（实测，2026-09-26）：dsh Desktop 的主窗口在 Windows 上是
     * `titleBarStyle: 'hidden'` + `titleBarOverlay: { height: 40 }` ——
     * 右上角那条 40px 是**原生**窗口按钮（最小化/最大化/关闭），画在网页内容
     * **之上**，`z-index` 再大也盖不过去。早期版本把「退出全屏」放在头部
     * （`.dsh-showme-actions { margin-left: auto }` → 右上角），于是：
     * 按钮**被原生按钮挡住、点不到**，而焦点一旦进了 iframe（用户点了页面里的东西），
     * Esc 也不再冒泡到父文档 —— 用户只能重启 dsh。这就是那次现场。
     */
    function FullscreenHost() {
      const state = useSyncExternalStore(subscribeFullscreen, getFullscreen)

      useEffect(() => {
        if (state === null) return undefined

        /**
         * Esc 退出。
         *
         * 两处都注册、且都用**捕获阶段**：只要焦点还在父文档，就能抢在 DSH 自己
         * 的处理之前拿到按键。但**不能指望它**——展示页在 sandbox 的不透明源 iframe 里，
         * 用户点进页面后焦点在子文档，那里的按键根本不会跨文档冒泡过来。
         * 所以「退出」必须始终有一个看得见、点得到的按钮（就是下面那条底部栏）。
         * @param event - 键盘事件。
         */
        const onKeyDown = (event) => {
          if (event?.key !== 'Escape' && event?.key !== 'Esc') return
          event.stopPropagation?.()
          setFullscreen(null)
        }
        const targets = [window, typeof document === 'undefined' ? null : document].filter(
          (target) => target !== null && typeof target.addEventListener === 'function',
        )
        for (const target of targets) target.addEventListener('keydown', onKeyDown, true)

        // 打开那一刻把焦点抢回父文档：用户还没点进 iframe 时，Esc 才收得到。
        if (typeof window.focus === 'function') {
          try {
            window.focus()
          } catch {
            /* 忽略 */
          }
        }

        return () => {
          for (const target of targets) target.removeEventListener('keydown', onKeyDown, true)
        }
      }, [state])

      if (state === null) return null

      return h(
        'div',
        { className: 'dsh-showme-fullscreen' },
        h('iframe', {
          className: 'dsh-showme-fullscreenFrame',
          src: state.url,
          sandbox: 'allow-scripts allow-popups allow-popups-to-escape-sandbox',
          title: state.title,
        }),
        h(
          'div',
          { className: 'dsh-showme-fullscreenBar' },
          h('span', { className: 'dsh-showme-title' }, state.title),
          h('span', { className: 'dsh-showme-pathInline' }, state.workspacePath),
          h(
            'div',
            { className: 'dsh-showme-actions' },
            h(
              'a',
              { className: 'dsh-showme-btn', href: state.url, target: '_blank', rel: 'noreferrer' },
              '浏览器打开',
            ),
            h(
              'button',
              { type: 'button', className: 'dsh-showme-btnPrimary', onClick: () => setFullscreen(null) },
              '退出全屏 (Esc)',
            ),
          ),
        ),
      )
    }

    // ══════════════ 原生右栏 tab 的正文 ══════════════

    /**
     * 右栏页 tab 的正文：同一个镜像地址（只是画布更大），底部带一条回执栏。
     *
     * 参数从 tab 记录里取（`useTabInfo().tab.navigation.params`，与
     * `ui-sidebar-browser` 取 `params.url` 是同一套）。取不到地址时给一句话，
     * 不白屏。
     *
     * @param props - 该座位的标准 props（含 `useTabInfo`）。
     */
    function SidebarTabBody(props) {
      const info = typeof props?.useTabInfo === 'function' ? props.useTabInfo() : undefined
      const params = info?.tab?.navigation?.params ?? {}
      const url = typeof params.url === 'string' ? params.url : ''
      const title = typeof params.title === 'string' && params.title !== '' ? params.title : '展示页'

      const [feedback, setFeedback] = useState(null)
      const [notice, setNotice] = useState('')

      // 同一套草稿通道：右栏里的页面也会刷新、也会跟着会话走。
      useDraftBridge(url)

      useEffect(() => {
        const onMessage = (event) => {
          const data = event?.data
          if (data === null || typeof data !== 'object') return
          if (data.type !== FEEDBACK_TYPE) return
          if (typeof data.text !== 'string' || data.text.trim() === '') return
          setFeedback(data.text)
          setNotice('')
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
      }, [])

      if (url === '') {
        return h(
          'div',
          { className: 'dsh-showme-error' },
          '这个 tab 没有页面地址：show_html 这次没给出可用的地址。',
        )
      }

      return h(
        'div',
        { className: 'dsh-showme-tab' },
        h('iframe', {
          className: 'dsh-showme-tabFrame',
          src: url,
          sandbox: 'allow-scripts allow-popups allow-popups-to-escape-sandbox',
          title,
        }),
        feedback === null
          ? null
          : h(
              'div',
              { className: 'dsh-showme-tabBar' },
              h('div', { className: 'dsh-showme-feedbackHead' }, '页面交回的反馈'),
              h('textarea', { className: 'dsh-showme-tabText', readOnly: true, value: feedback }),
              h(
                'div',
                { className: 'dsh-showme-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-showme-btnPrimary',
                    onClick: () => {
                      const inserted = insertIntoComposer(feedback, null)
                      setNotice(inserted ? '已填入输入框 ✓' : '输入框当前不可用，请手动选中')
                    },
                  },
                  '填入输入框',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-showme-btn',
                    onClick: () => {
                      if (navigator.clipboard?.writeText === undefined) {
                        setNotice('请手动选中复制')
                        return
                      }
                      navigator.clipboard.writeText(feedback).then(
                        () => setNotice('已复制 ✓'),
                        () => setNotice('复制被拒绝，请手动选中'),
                      )
                    },
                  },
                  '复制',
                ),
                notice === '' ? null : h('span', { className: 'dsh-showme-notice' }, notice),
              ),
            ),
      )
    }

    // ══════════════ 样式与挂载 ══════════════

    /** 用 GUI 的主题令牌，跟随明暗切换。 */
    const CSS = `
.dsh-showme-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; overflow: hidden; background: var(--dsw-alias-bg-layer-2); margin: 6px 0; }
.dsh-showme-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); flex-wrap: wrap; }
.dsh-showme-badge { font-family: Consolas, monospace; font-size: 11px; padding: 1px 6px; border-radius: 4px; background: var(--dsw-alias-brand-primary); color: #fff; flex: none; }
.dsh-showme-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsh-showme-size { font-size: 11px; color: var(--dsw-alias-label-tertiary); font-family: Consolas, monospace; }
/* 工具行摘要：页面本体在过程组外面单独一行，这里只留"这次调用做了什么"。 */
.dsh-showme-compactRow { margin: 4px 0; }
.dsh-showme-compactRow .dsh-showme-head { border-bottom: 0; padding: 4px 8px; gap: 6px; }
.dsh-showme-compactHint { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.dsh-showme-mermaidBadge { font-size: 11px; padding: 1px 6px; border-radius: 4px; background: #e8f5ec; color: #1f7a3d; border: 1px solid #b6e0c2; flex: none; }
.dsh-showme-mermaidBadge-warn { background: #fff1f1; color: #b42318; border-color: #f3b7b3; }
.dsh-showme-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; flex-wrap: wrap; }
.dsh-showme-btn { box-sizing: border-box; height: 26px; padding: 0 10px; display: inline-flex; align-items: center; cursor: pointer; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; font-size: 12px; text-decoration: none; }
.dsh-showme-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-showme-btnPrimary { box-sizing: border-box; height: 26px; padding: 0 12px; cursor: pointer; background: var(--dsw-alias-brand-primary); color: #fff; border: 1px solid var(--dsw-alias-brand-primary); border-radius: 6px; font-size: 12px; }
.dsh-showme-note { padding: 6px 10px; font-size: 12px; color: var(--dsw-alias-label-secondary); border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsh-showme-stage { background: #fff; }
.dsh-showme-frame { width: 100%; height: 100%; border: 0; display: block; background: #fff; }
.dsh-showme-placeholder { display: flex; align-items: center; justify-content: center; height: 100%; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.dsh-showme-foot { display: flex; align-items: center; gap: 10px; padding: 6px 10px; border-top: 1px solid var(--dsw-alias-border-l1); flex-wrap: wrap; }
.dsh-showme-link { background: none; border: 0; padding: 0; cursor: pointer; font-family: Consolas, monospace; font-size: 11px; color: var(--dsw-alias-label-secondary); text-decoration: underline; }
.dsh-showme-link:hover { color: var(--dsw-alias-brand-primary); }
.dsh-showme-hint { font-size: 11px; color: var(--dsw-alias-label-tertiary); margin-left: auto; }
.dsh-showme-error { padding: 10px; font-size: 12px; color: #c20056; white-space: pre-wrap; }
.dsh-showme-path { padding: 0 10px 8px; font-family: Consolas, monospace; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.dsh-showme-feedback { border-top: 1px solid var(--dsw-alias-border-l1); padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
.dsh-showme-feedbackHead { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsh-showme-feedbackText { width: 100%; min-height: 84px; resize: vertical; box-sizing: border-box; font-family: Consolas, monospace; font-size: 12px; line-height: 1.6; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
.dsh-showme-notice { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dsh-showme-fullscreen { position: fixed; inset: 0; z-index: 2147483100; background: var(--dsw-alias-bg-base); display: flex; flex-direction: column; pointer-events: auto; }
.dsh-showme-fullscreenFrame { flex: 1; width: 100%; border: 0; background: #fff; }
/* 控件条贴在**底部**：顶部 40px 是 Windows 原生窗口按钮区，放在那里点不到。 */
.dsh-showme-fullscreenBar { flex: none; display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-top: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); flex-wrap: wrap; }
.dsh-showme-pathInline { font-family: Consolas, monospace; font-size: 11px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 42vw; }
/* 右栏 tab 的正文：撑满格，底部回执栏不随 iframe 滚走。 */
.dsh-showme-tab { display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; }
.dsh-showme-tabFrame { flex: 1; width: 100%; min-height: 0; border: 0; background: #fff; }
.dsh-showme-tabBar { flex: none; display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border-top: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); }
.dsh-showme-tabText { width: 100%; min-height: 54px; resize: vertical; box-sizing: border-box; font-family: Consolas, monospace; font-size: 12px; line-height: 1.6; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
/* 渲染回执徽标：页面自己报"我出来了/我挂了"，卡片据此显性化白屏。 */
.dsh-showme-renderBadge { font-size: 11px; padding: 1px 6px; border-radius: 4px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-tertiary); border: 1px solid var(--dsw-alias-border-l1); flex: none; font-family: Consolas, monospace; }
.dsh-showme-renderBadge-warn { background: #fff1f1; color: #b42318; border-color: #f3b7b3; }
/* 设置（插件页的 plugins.detail.section 区块）。 */
.dsh-showme-settings { display: flex; flex-direction: column; gap: 14px; padding: 4px 2px; max-width: 640px; }
.dsh-showme-settingsTitle { margin: 0; font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsh-showme-settingsMuted { margin: 0; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.dsh-showme-setting { display: flex; align-items: flex-start; gap: 10px; font-size: 13px; color: var(--dsw-alias-label-primary); }
.dsh-showme-setting input[type="checkbox"] { margin-top: 2px; flex: none; }
.dsh-showme-setting b { display: block; font-weight: 600; margin-bottom: 2px; }
.dsh-showme-settingDesc { display: block; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-tertiary); }
.dsh-showme-select { margin-left: auto; flex: none; height: 26px; padding: 0 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 12px; }
.dsh-showme-settingsError { margin: 0; font-size: 12px; color: #b42318; }
/* 区块外壳：list slot 的条目要自绘外观（宿主只负责排序）。 */
.dsh-showme-pluginSection { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--dsw-alias-border-l1); display: flex; flex-direction: column; gap: 10px; }
.dsh-showme-pluginSectionHead h3 { margin: 0 0 3px; font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsh-showme-pluginSectionHead p { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-tertiary); }
/* 计划评审里的"打开展示页"。 */
.dsh-showme-planOpen { box-sizing: border-box; height: 26px; padding: 0 10px; cursor: pointer; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 12px; }
.dsh-showme-planOpen:hover { background: var(--dsw-alias-interactive-bg-hover); }
`

    /**
     * 三个开关的**控件组**（读写用户级偏好 `<DSH_HOME>/showme/prefs.json`）。
     *
     * 标题、说明与关闭按钮不由它负责——外壳是 `ShowmeSettingsSection`（插件页区块）。
     */
    function ShowmeSettings() {
      const [prefs, setPrefs] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')

      useEffect(() => {
        let alive = true
        fetchPrefs().then(
          (value) => {
            if (alive) setPrefs(value)
          },
          (cause) => {
            if (alive) setError(cause instanceof Error ? cause.message : String(cause))
          },
        )
        return () => {
          alive = false
        }
      }, [])

      const commit = (patch) => {
        setBusy(true)
        setError('')
        savePrefs(patch).then(
          (next) => {
            setPrefs(next)
            setBusy(false)
          },
          (cause) => {
            setError(cause instanceof Error ? cause.message : String(cause))
            setBusy(false)
          },
        )
      }

      const toggle = (key, label, description) =>
        h(
          'label',
          { className: 'dsh-showme-setting' },
          h('input', {
            type: 'checkbox',
            checked: prefs !== null && prefs[key] === true,
            disabled: busy || prefs === null,
            onChange: (event) => commit({ [key]: event.target.checked === true }),
          }),
          h(
            'span',
            null,
            h('b', null, label),
            h('span', { className: 'dsh-showme-settingDesc' }, description),
          ),
        )

      if (prefs === null) {
        return h(
          'div',
          { className: 'dsh-showme-settings' },
          h('p', { className: 'dsh-showme-settingsMuted' }, error === '' ? '读取偏好…' : error),
        )
      }

      return h(
        'div',
        { className: 'dsh-showme-settings' },
        toggle(
          'autoOpenSidebar',
          'show_html 之后自动在右栏打开',
          '每轮只开最后一张；你手动关掉后不再抢。窗口窄于 1200px 时不自动开，只留卡片上的按钮。',
        ),
        h(
          'label',
          { className: 'dsh-showme-setting' },
          h('span', null,
            h('b', null, '计划页'),
            h('span', { className: 'dsh-showme-settingDesc' },
              'plan 模式下的产出：off 只写 markdown；offer 复杂计划额外产一页；require 一律产页（markdown 只留摘要）。'),
          ),
          h(
            'select',
            {
              className: 'dsh-showme-select',
              value: prefs.planPage,
              disabled: busy,
              onChange: (event) => commit({ planPage: event.target.value }),
            },
            h('option', { value: 'off' }, 'off · 只用 markdown'),
            h('option', { value: 'offer' }, 'offer · 复杂计划才产页'),
            h('option', { value: 'require' }, 'require · 一律产页'),
          ),
        ),
        toggle(
          'planPageOpenOnReview',
          '计划评审出现时自动打开计划页',
          '只对 markdown 里写了「展示页：<路径>」的那次评审生效；路径不存在时不会开空白 tab。',
        ),
        error === '' ? null : h('p', { className: 'dsh-showme-settingsError' }, error),
      )
    }

    /**
     * 插件页里的「展示页 · 设置」区块（`plugins.detail.section` 槽）。
     *
     * 宿主对每个详情页的 subject 各调一次：`{kind:'bundle',pkg}` / `{kind:'row',pkg,row}` /
     * `{kind:'item',id}`。只认**自己的组合包**，其余一律 `null`——别人的插件页不该多出一块。
     * 区块外观自绘（宿主只负责按 order 排序）。
     *
     * @param props - 槽位给的 `{ subject, t }`。
     */
    function ShowmeSettingsSection(props) {
      const subject = props?.subject
      if (subject === null || typeof subject !== 'object') return null
      if (subject.kind !== 'bundle') return null
      const name = typeof subject.pkg?.name === 'string' ? subject.pkg.name : ''
      if (name !== PACKAGE_NAME) return null
      return h(
        'section',
        { className: 'dsh-showme-pluginSection' },
        h(
          'div',
          { className: 'dsh-showme-pluginSectionHead' },
          h('h3', null, '展示页 · 设置'),
          h('p', null, '用户级偏好：换工作区不用重设。落点是 `<DSH_HOME>/showme/prefs.json`。'),
        ),
        h(ShowmeSettings, null),
      )
    }

    /**
     * 计划评审里的「打开展示页」。
     *
     * 面板正文只有 markdown 的首行/首段（原生渲染），所以页面**不能**靠 markdown 链接打开；
     * 这里解析 `展示页：<路径>` 那一行，验存在后走我们自己的右栏页类型。
     *
     * @param props - 槽位给的 `{ review, requestKey, sessionId }`。
     */
    function PlanPageAction(props) {
      const plan = typeof props?.review?.plan === 'string' ? props.review.plan : ''
      const match = PLAN_PAGE_MARKER.exec(plan)
      const workspacePath = match === null ? '' : match[1].trim()
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
      const requestKey = typeof props?.requestKey === 'string' ? props.requestKey : ''
      const [notice, setNotice] = useState('')

      const open = () => {
        setNotice('打开中…')
        void openShowmePage(sessionId, workspacePath).then(
          (how) => setNotice(how === 'missing' ? '路径不存在' : ''),
          () => setNotice('打不开'),
        )
      }

      // 评审出现时按偏好自动开一次（按 requestKey 记忆，不重复抢）。
      useEffect(() => {
        if (workspacePath === '' || sessionId === '') return
        const key = requestKey === '' ? `review:${workspacePath}` : `review:${requestKey}`
        if (planOpened.has(key)) return
        planOpened.add(key)
        void fetchPrefs().then((prefs) => {
          if (prefs.planPageOpenOnReview === true) open()
        })
      }, [workspacePath, sessionId, requestKey])

      if (workspacePath === '') return null
      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-showme-planOpen',
          onClick: open,
          title: `在右栏打开 ${workspacePath}`,
        },
        notice === '' ? '打开展示页' : notice,
      )
    }

    /**
     * 挂载卡片、全屏浮层、输入镜像座位，以及原生右栏里的页类型。
     * @param ctx - 客户端根上下文（槽位服务）。
     */
    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-showme-html'
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'dsh-showme-html: styles')

      // 工具行：Chat 行可用时这里只留一行摘要（见 ShowmeToolRow），否则内嵌整卡。
      ctx.slots.inject('tool.call.toolview', () =>
        ctx.slots.register({ name: 'tool.call.toolview', key: TOOL_NAME }, ShowmeToolRow),
      )

      // 设置：放在**插件页**（插件 → dsh-showme-html → 展示页 · 设置）。
      // `plugins.detail.section` 是列表槽：条目按 subject 过滤、自绘区块，宿主只负责排序。
      ctx.slots.inject('plugins.detail.section', () =>
        ctx.slots.register(
          { name: 'plugins.detail.section', id: 'dsh-showme-html-settings', order: 40 },
          ShowmeSettingsSection,
        ),
      )

      // 计划评审的 action 槽：只有 markdown 里写了「展示页：…」才有东西可渲染。
      ctx.slots.inject('conversation.plan-review.actions', () =>
        ctx.slots.register(
          {
            name: 'conversation.plan-review.actions',
            id: 'dsh-showme-html-plan',
            inject: (sessionId) => ({ sessionId }),
          },
          PlanPageAction,
        ),
      )

      // mermaid 渲染回执的**统一转发点**。
      //
      // 放在顶层而不是塞进每张卡片：卡片滚出视口会被卸载（历史里的卡片不持有活 iframe），
      // 那时页面可能刚好渲染完 —— 回执不能因为卡片不在就丢掉。PNG 就是这么落盘的。
      ctx.effect(() => {
        const onMessage = (event) => {
          const data = event?.data
          if (data === null || typeof data !== 'object') return
          if (data.type !== MERMAID_TYPE) return
          relayMermaidReceipt(data)
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
      }, 'dsh-showme-html: mermaid receipt relay')

      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'dsh-showme-html-fullscreen', order: 70 }, FullscreenHost),
      )

      ctx.slots.inject('conversation.input.left', () =>
        ctx.slots.register({ name: 'conversation.input.left', id: 'dsh-showme-html-input', order: 91 }, InputCapture),
      )

      // ══════════════ Chat 行：让页面不被「工作步骤」折叠吃掉 ══════════════
      //
      // 页面从"工具行内部"搬到"自己的 Chat 行"，并且声明 `groupTree: 'turn'`。
      // 依据：chat 的 `TurnGroups.rebuild()` 只把 `groupTree` 深度 ≤ process 的节点
      // 放进过程组，组内节点在轮次结束后会整块收起。工具行（深度默认 = process）
      // 一定被收起，所以卡片不能留在那里。
      //
      // ⚠️ 用 `ctx.inject(['uiConversation'])`：**旧宿主没有这个服务时这一段不跑**，
      // `conversationRowsEnabled` 保持 false，工具行退回内嵌整卡（0.2.3 的行为）。
      // 不能让"新能力"把插件核心拖成 pending —— 和右栏那段同一个理由。
      if (typeof ctx.inject === 'function') {
        ctx.inject(['uiConversation'], (scope) => {
          const conversation = scope.uiConversation
            if (conversation === undefined || typeof conversation.events?.register !== 'function') return
          scope.effect(
            () => conversation.events.register(showmePageDefinition),
            'dsh-showme-html: chat row definition',
          )
          conversationRowsEnabled = true
        })
      }

      // 行渲染器：key 必须**等于定义里的 kind**（宿主按 `routedNode.kind` 取 slot entry）。
      ctx.slots.inject('conversation.chat.node', () =>
        ctx.slots.register({ name: 'conversation.chat.node', key: SHOWME_KIND }, ShowmePageNode),
      )

      // 原生右栏：注册我们自己的页类型 + 正文。
      //
      // ⚠️ 用 `ctx.inject(...)`（**不是** exports.inject）：右栏服务缺失时这一段不跑，
      // 但插件本体（卡片）照旧可用 —— 不能让"侧栏预览"这个附加能力把核心功能
      // 拖成 pending。这与 shell 自己用 sidebarRightTabs 的写法一致。
      if (typeof ctx.inject !== 'function') return

      ctx.inject(['sidebarRightTabs', 'sidebarRight'], (scope) => {
        sidebarRight = scope.sidebarRight ?? null

        scope.effect(
          () => scope.sidebarRightTabs.register(sidebarTabDefinition()),
          'dsh-showme-html: sidebar page type',
        )

        scope.effect(
          () =>
            scope.slots.inject('sidebar.right.pane.tab', () =>
              scope.slots.register(
                { name: 'sidebar.right.pane.tab', key: SIDEBAR_ID },
                SidebarTabBody,
              ),
            ),
          'dsh-showme-html: sidebar page body',
        )
      })
    }

    exports.apply = apply
    exports.inject = inject
    // 仅供离线测试用的内部引用（测试用 node:vm 把本文件当作脚本加载，没有别的
    // 途径触达闭包内部）。加载器只读 apply / inject，多余键无害。
    exports.__internals = {
      rawUrl,
      readArgs,
      resultText: readResultText,
      basename,
      humanBytes,
      insertIntoComposer,
      openInSidebar,
      sidebarTabDefinition,
      SidebarTabBody,
      SIDEBAR_KIND,
      SIDEBAR_ID,
      inputRefs,
      ToolCard: ShowmeCard,
      ShowmePageNode,
      ShowmeToolRow,
      SHOWME_KIND,
      showmePageDefinition,
      callState,
      projectCall,
      sourceFromToolBlock,
      sessionIdFromUrl,
      resolveSessionId,
      resolveCardUrl,
      FullscreenHost,
      setFullscreen,
      getFullscreen,
      FEEDBACK_TYPE,
      MERMAID_TYPE,
      relayMermaidReceipt,
      mermaidFailuresOf,
      DRAFT_TYPE,
      DRAFT_READY_TYPE,
      DRAFT_RESTORE_TYPE,
      draftIdentityFromUrl,
      draftPayloadOf,
      relayDraft,
      relayFeedback,
      fetchDraft,
      useDraftBridge,
      RENDERED_TYPE,
      PLAN_PAGE_MARKER,
      fetchPrefs,
      savePrefs,
      pageExists,
      openShowmePage,
      ShowmeSettings,
      ShowmeSettingsSection,
      PlanPageAction,
    }
    return module.exports
  },
})
