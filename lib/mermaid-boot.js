/**
 * 注入到展示页里的引导脚本（宿主按需内联，只有页面里出现 mermaid 块时才注）。
 *
 * 它做四件事：
 *   1. 收集页面里的 mermaid 块（`.mermaid` / `[data-mermaid]` / `code.language-mermaid`）；
 *   2. 加载 vendored 的 mermaid（同源 `/api/showme/vendor/mermaid.min.js`，普通脚本，
 *      在不透明源里能过，`fetch` 过不去）—— 页面自己已经引了就用页面那份；
 *   3. 逐块渲染，失败就地显示红框并保留源码；
 *   4. 每块成功的图导出 PNG，连同结果一起 `postMessage` 给宿主窗口。
 *
 * 为什么 PNG 要绕一圈：展示页是不透明源，`fetch` 同源资源会被当跨域拦；
 * 而 `<script src>` 能加载、`postMessage` 能出去。所以页面只负责"算出来"，
 * 由同源的浏览器半区（`lib/client.js`）转成一次 `POST /api/showme/mermaid`。
 *
 * 整个脚本包在 try/catch 里：引导脚本自己出错不许把页面弄白。
 */
;(function () {
  if (window.__showmeMermaidBoot) return
  window.__showmeMermaidBoot = true

  var RECEIPT_TYPE = 'dsh-showme-mermaid'
  var VENDOR = '/api/showme/vendor/mermaid.min.js'
  /** 单张 PNG 的 base64 上限：超过就退成 1x，再超就不要图（不拖垮一条回执）。 */
  var PNG_LIMIT = 1.2 * 1024 * 1024

  /**
   * 从 `/api/showme/raw/<sessionId>/<path>` 里解出会话与页面路径。
   * @returns `{ sessionId, page }`，解不出就是空串。
   */
  function parsePage() {
    var parts = location.pathname.split('/')
    var rawAt = parts.indexOf('raw')
    if (rawAt < 0 || parts.length < rawAt + 3) return { sessionId: '', page: '' }
    var sessionId = parts[rawAt + 1] || ''
    var page = decodeURIComponent(parts.slice(rawAt + 2).join('/'))
    return { sessionId: sessionId, page: page }
  }

  var PAGE = parsePage()

  function collect() {
    var nodes = document.querySelectorAll('.mermaid, [data-mermaid], code.language-mermaid')
    return Array.prototype.slice.call(nodes).filter(function (node) {
      // 嵌套只取外层：`<pre class="mermaid"><code class="language-mermaid">` 里那个内层不要。
      // 判据是"**祖先**里有没有同类块"——`closest()` 会连自己一起匹配，
      // 所以必须从 `parentElement` 往上找（第一版写成 `closest(...) !== parentElement`，
      // 结果把**所有**块都滤掉了，页面一片源码、也不报错）。
      var parent = node.parentElement
      return !(parent && parent.closest('.mermaid, [data-mermaid], code.language-mermaid'))
    })
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var el = document.createElement('script')
      el.src = src
      el.onload = function () { resolve() }
      el.onerror = function () { reject(new Error('加载失败：' + src)) }
      document.head.appendChild(el)
    })
  }

  function guessType(source) {
    try {
      var type = window.mermaid.detectType(source)
      return typeof type === 'string' ? type : null
    } catch (error) {
      return null
    }
  }

  /**
   * 把 SVG 元素转成 PNG data URL。
   * @param svg - 已渲染进页面的 `<svg>`。
   * @param scale - 缩放倍数（2 更清楚，超限会退到 1）。
   * @returns 失败给 null —— 页面显示不受影响。
   */
  function svgToPng(svg, scale) {
    return new Promise(function (resolve) {
      try {
        var box = svg.getBoundingClientRect()
        var width = Math.max(1, Math.round(box.width || svg.viewBox.baseVal.width || 800))
        var height = Math.max(1, Math.round(box.height || svg.viewBox.baseVal.height || 600))

        var clone = svg.cloneNode(true)
        clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
        clone.setAttribute('width', String(width))
        clone.setAttribute('height', String(height))
        var xml = new XMLSerializer().serializeToString(clone)

        var blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' })
        var url = URL.createObjectURL(blob)
        var image = new Image()
        image.onload = function () {
          try {
            var canvas = document.createElement('canvas')
            canvas.width = width * scale
            canvas.height = height * scale
            var ctx = canvas.getContext('2d')
            ctx.fillStyle = '#ffffff'
            ctx.fillRect(0, 0, canvas.width, canvas.height)
            ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
            var data = canvas.toDataURL('image/png')
            URL.revokeObjectURL(url)
            resolve(data.length <= PNG_LIMIT ? data : null)
          } catch (error) {
            URL.revokeObjectURL(url)
            resolve(null)
          }
        }
        image.onerror = function () { URL.revokeObjectURL(url); resolve(null) }
        image.src = url
      } catch (error) {
        resolve(null)
      }
    })
  }

  /**
   * 渲染失败时就地显示红框（同时保留源码，方便直接复制走）。
   * @param el - 原来的 mermaid 元素。
   * @param source - mermaid 源码。
   * @param message - 报错文本。
   */
  function showError(el, source, message) {
    var box = document.createElement('div')
    box.className = 'dsh-showme-mermaid-error'
    box.setAttribute('data-showme-mermaid-error', '')
    box.style.cssText = [
      'border:1px solid #e5484d', 'border-radius:8px', 'padding:12px 14px',
      'background:#fff5f5', 'color:#8f1d21', 'font:13px/1.6 ui-monospace,monospace',
      'white-space:pre-wrap', 'margin:12px 0',
    ].join(';')
    var head = document.createElement('div')
    head.style.cssText = 'font-weight:600;margin-bottom:6px;color:#c62a2f'
    head.textContent = 'mermaid 渲染失败'
    var detail = document.createElement('div')
    detail.textContent = message
    var code = document.createElement('pre')
    code.style.cssText = 'margin:8px 0 0;padding:8px;background:#fff;border-radius:6px;overflow:auto'
    code.textContent = source
    box.appendChild(head)
    box.appendChild(detail)
    box.appendChild(code)
    el.innerHTML = ''
    el.appendChild(box)
  }

  /**
   * 把结果送回宿主窗口。
   * @param ok - 是否全部成功。
   * @param diagrams - `[{ index, type, error, png }]`。
   */
  function post(ok, diagrams) {
    if (window.parent === window) return
    try {
      window.parent.postMessage(
        { type: RECEIPT_TYPE, sessionId: PAGE.sessionId, page: PAGE.page, ok: ok, diagrams: diagrams },
        '*',
      )
    } catch (error) {
      // 回执送不出去不该影响页面。
    }
  }

  async function run() {
    var nodes = collect()
    if (nodes.length === 0) return

    if (!window.mermaid) {
      await loadScript(location.origin + VENDOR)
    }
    if (!window.mermaid || typeof window.mermaid.render !== 'function') {
      throw new Error('mermaid 没能加载起来（vendor 路由不可达？）')
    }

    window.mermaid.initialize({
      startOnLoad: false,
      // `<foreignObject>` 里塞 HTML 会让 SVG→canvas 变成被污染的画布，导不出 PNG。
      htmlLabels: false,
      securityLevel: 'strict',
    })

    var results = []
    for (var i = 0; i < nodes.length; i += 1) {
      var el = nodes[i]
      var source = (el.textContent || '').trim()
      var type = guessType(source)
      try {
        var rendered = await window.mermaid.render('dsh-showme-mm-' + i + '-' + Date.now(), source)
        el.innerHTML = rendered.svg
        if (typeof rendered.bindFunctions === 'function') rendered.bindFunctions(el)
        var svg = el.querySelector('svg')
        var png = svg ? await svgToPng(svg, 2) : null
        if (svg && !png) png = await svgToPng(svg, 1)
        results.push({ index: i + 1, type: type, error: null, png: png })
      } catch (error) {
        var message = String((error && error.message) || error)
        showError(el, source, message)
        results.push({ index: i + 1, type: type, error: message, png: null })
      }
    }

    post(
      results.every(function (item) { return !item.error }),
      results,
    )
  }

  try {
    run().catch(function (error) {
      post(false, [{ index: 0, type: null, error: String((error && error.message) || error), png: null }])
    })
  } catch (error) {
    post(false, [{ index: 0, type: null, error: String((error && error.message) || error), png: null }])
  }
})()
