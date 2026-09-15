/**
 * dsh-showme-html — 浏览器半区，运行在 dsh web GUI 里。
 *
 * 注册三处：
 *  1. `tool.call.toolview`（key = `show_html`）：对话流里的展示卡片。
 *     头部：标题 / 源文件路径 / 刷新 / 全屏 / 在浏览器打开原文件。
 *     主体：贴边 iframe，指向宿主镜像路由 —— 于是页面里的相对引用
 *     （图片、同目录 css/js、下级 html 页）全部天然可用。
 *  2. `shell.overlay`：画面内全屏浮层（同一个地址，更大的画布）。
 *  3. `conversation.input.left`：镜像当前输入框状态，让"把反馈填进输入框"
 *     能追加而不是覆盖用户已经写了一半的草稿。
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
    /** 依赖的客户端服务：槽位系统。 */
    const inject = ['slots']

    /** 宿主镜像路由前缀（与 lib/index.js 的 ROUTE_PREFIX 一致）。 */
    const API = '/api/showme'
    /** 工具名 = 卡片槽位的 key。 */
    const TOOL_NAME = 'show_html'
    /** 页面收到的 postMessage 必须带这个 type 才被卡片认领。 */
    const FEEDBACK_TYPE = 'dsh-showme-feedback'
    /** 卡片内页面默认高度（px）。 */
    const FRAME_HEIGHT = 460

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

    // ══════════════ 卡片 ══════════════

    /**
     * 一次 `show_html` 调用的展示卡片。
     * @param props - ToolCallOwnerProps 与标准 props（sessionId / inputActions / openFile）。
     */
    function ShowmeCard(props) {
      const block = props.block
      const sessionId = props.sessionId
      const openFile = props.openFile

      const settled = block?.kind === 'tool-result'
      const args = readArgs(block)
      const workspacePath = typeof args?.path === 'string' ? args.path : ''
      const title = (typeof args?.title === 'string' && args.title !== '' ? args.title : basename(workspacePath)) || '展示页'
      const note = typeof args?.note === 'string' ? args.note : ''
      const failed = settled && block?.isError === true
      const failureText = failed ? readResultText(block) : ''
      const meta = block?.meta !== null && typeof block?.meta === 'object' ? block.meta : undefined
      const bytes = meta?.bytes
      // 优先用宿主算好的地址：这样不依赖"客户端的 sessionId == 宿主的 session id"。
      const hostUrl = typeof meta?.url === 'string' ? meta.url : ''

      const [nonce, setNonce] = useState(0)
      const [visible, setVisible] = useState(false)
      const [feedback, setFeedback] = useState(null)
      const [notice, setNotice] = useState('')
      const rootRef = useRef(null)

      // 非可见的卡片不持有活 iframe：历史里几十张卡片同时跑动画会直接把会话拖卡。
      useEffect(() => {
        const element = rootRef.current
        if (element === null || typeof IntersectionObserver === 'undefined') {
          setVisible(true)
          return undefined
        }
        const observer = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) setVisible(entry.isIntersecting)
          },
          { rootMargin: '200px 0px' },
        )
        observer.observe(element)
        return () => observer.disconnect()
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

      const url = hostUrl !== '' ? hostUrl : workspacePath === '' ? '' : rawUrl(sessionId, workspacePath)

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
          h(
            'div',
            { className: 'dsh-showme-actions' },
            h('button', { type: 'button', className: 'dsh-showme-btn', onClick: onRefresh }, '刷新'),
            h('button', { type: 'button', className: 'dsh-showme-btn', onClick: onFullscreen }, '全屏'),
            h(
              'a',
              { className: 'dsh-showme-btn', href: url, target: '_blank', rel: 'noreferrer' },
              '浏览器打开',
            ),
          ),
        ),
        note === '' ? null : h('div', { className: 'dsh-showme-note' }, note),
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

    // ══════════════ 全屏浮层 ══════════════

    /** `shell.overlay` 座位：画面内全屏看同一份地址。 */
    function FullscreenHost() {
      const state = useSyncExternalStore(subscribeFullscreen, getFullscreen)

      useEffect(() => {
        if (state === null) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setFullscreen(null)
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [state])

      if (state === null) return null

      return h(
        'div',
        { className: 'dsh-showme-fullscreen' },
        h(
          'div',
          { className: 'dsh-showme-fullscreenHead' },
          h('span', { className: 'dsh-showme-title' }, state.title),
          h('span', { className: 'dsh-showme-path' }, state.workspacePath),
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
        h('iframe', {
          className: 'dsh-showme-fullscreenFrame',
          src: state.url,
          sandbox: 'allow-scripts allow-popups allow-popups-to-escape-sandbox',
          title: state.title,
        }),
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
.dsh-showme-fullscreen { position: fixed; inset: 0; z-index: 2147483100; background: var(--dsw-alias-bg-base); display: flex; flex-direction: column; }
.dsh-showme-fullscreenHead { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); flex-wrap: wrap; }
.dsh-showme-fullscreenFrame { flex: 1; width: 100%; border: 0; background: #fff; }
`

    /**
     * 挂载卡片、全屏浮层与输入镜像座位。
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

      ctx.slots.inject('tool.call.toolview', () =>
        ctx.slots.register({ name: 'tool.call.toolview', key: TOOL_NAME }, ShowmeCard),
      )

      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'dsh-showme-html-fullscreen', order: 70 }, FullscreenHost),
      )

      ctx.slots.inject('conversation.input.left', () =>
        ctx.slots.register({ name: 'conversation.input.left', id: 'dsh-showme-html-input', order: 91 }, InputCapture),
      )
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
      inputRefs,
      ToolCard: ShowmeCard,
      FullscreenHost,
      FEEDBACK_TYPE,
    }
    return module.exports
  },
})
