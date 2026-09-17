/**
 * showme-report · 模板内核（三个形状共用这一份）
 * ============================================================================
 *
 * ⚠️ **要写数据的话，别读这个文件。** 字段表在同目录的 `README.md`（约 4KB）：
 *    三个形状、全部字段、10 种内容块、常见错误，都在那一份里。这里只是实现。
 *    实测：有会话为了搞清"它认哪些块类型"把本文件通读了一遍（≈5–6 千 token），
 *    而答案就是 README 里一张 10 行的表。
 *
 * 为什么会有这个文件：skill 用文字规定"回执怎么做"，模型每次都重新实现一遍，
 * 于是控件位置、组句格式、postMessage 时机反复出错。**模板把"实现"变成"填数据"。**
 *
 * 一页由三部分组成：
 *   <name>.html         外壳（从 templates/<shape>.html 拷出来；模型不用碰）
 *   templates/core.js   本文件：全部渲染与交互（模型不用碰）
 *   <name>.data.js      模型唯一要写的东西 —— 只有数据
 *
 * 数据文件名由**页面自己的文件名**推导（`foo.html` → `foo.data.js`），
 * 所以同一目录下可以放很多页而不会互相踩。
 *
 * ⚠️ 为什么数据走 `<script src>` 而不是 `fetch`：展示页跑在 sandbox 的不透明源里，
 * `fetch` 同源资源会被当成跨域请求，而我们不发 CORS 头 → 必然被拦。
 * 经典 `<script src>` 不受这条限制。
 *
 * 自包含：无 @import、无外链字体、无 url()。皮肤来自 `presets/<skin>.css`。
 * 不依赖 localStorage、不依赖 navigator.clipboard（两者在沙箱里都会坏）。
 */

(function () {
  'use strict'

  /** 卡片认这个 type 才收。与 skill §4.1 的契约一致。 */
  var FEEDBACK_TYPE = 'dsh-showme-feedback'

  /** 当前形状，由外壳用 `window.SHOWME_SHAPE` 声明。 */
  var SHAPE = window.SHOWME_SHAPE || 'review'

  /** 三个形状的默认判动词。 */
  var DEFAULT_VERDICTS = {
    review: ['同意', '要改', '不要'],
    pick: ['选这个'],
    report: ['没意见', '要改'],
  }

  /** 本形状实际用的判动词（数据可覆盖）。 */
  var verdicts = DEFAULT_VERDICTS[SHAPE] || DEFAULT_VERDICTS.review

  /** id → { verdict, note } */
  var state = {}

  /** 渲染出来的可点名 id（按出现顺序）。 */
  var ids = []

  // ══════════════ 小工具 ══════════════

  /** HTML 转义。所有来自数据的文本都要过这一道。 */
  function esc(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  /** 数组兜底。 */
  function list(value) {
    return Array.isArray(value) ? value : []
  }

  /** 页面文件名 → 数据文件名（同目录、同名、`.data.js`）。 */
  function dataFileName() {
    var last = decodeURIComponent((location.pathname.split('/').pop() || '').trim())
    return last.replace(/\.html?$/i, '') + '.data.js'
  }

  // ══════════════ 失败态：一律给"怎么办"，不白屏 ══════════════

  /**
   * 渲染一个可读的失败页。
   * @param title - 一句话说清出了什么事。
   * @param steps - 怎么办（字符串数组，允许行内 <code>）。
   */
  function fail(title, steps) {
    var main = document.getElementById('sm-content')
    if (main !== null) {
      main.innerHTML = '<section class="section"><div class="callout bad sm-fail">' +
        '<span class="label">模板没能起来</span>' + esc(title) +
        '<ol class="timeline" style="margin-top:12px">' +
        steps.map(function (one) { return '<li>' + one + '</li>' }).join('') +
        '</ol></div></section>'
    }
    var receipt = document.getElementById('sm-receipt')
    if (receipt !== null) receipt.innerHTML = ''
  }

  // ══════════════ 通用内容块 ══════════════

  /** 渲染一个内容块。report 形状用它，其它形状也可顺手用。 */
  function block(one) {
    if (one === null || typeof one !== 'object') return ''
    switch (one.type) {
      case 'text':
        return '<p>' + esc(one.text) + '</p>'
      case 'image':
        return '<figure class="evidence"><img class="sm-img" src="' + esc(one.src) + '" alt="' + esc(one.alt || '') + '">' +
          (one.caption ? '<figcaption>' + esc(one.caption) + '</figcaption>' : '') + '</figure>'
      case 'table':
        return '<table class="table"><thead><tr>' +
          list(one.head).map(function (cell) { return '<th>' + esc(cell) + '</th>' }).join('') +
          '</tr></thead><tbody>' +
          list(one.rows).map(function (row) {
            return '<tr>' + list(row).map(function (cell) { return '<td>' + esc(cell) + '</td>' }).join('') + '</tr>'
          }).join('') + '</tbody></table>'
      case 'callout':
        return '<div class="callout' + (one.tone ? ' ' + esc(one.tone) : '') + '">' +
          (one.label ? '<span class="label">' + esc(one.label) + '</span>' : '') + esc(one.text) + '</div>'
      case 'timeline':
        return '<ol class="timeline">' + list(one.items).map(function (entry) {
          return '<li>' + (entry.title ? '<b>' + esc(entry.title) + '</b>' : '') + esc(entry.text || '') + '</li>'
        }).join('') + '</ol>'
      case 'kv':
        return '<dl class="kv">' + list(one.pairs).map(function (pair) {
          var cells = list(pair)
          return '<dt>' + esc(cells[0]) + '</dt><dd>' + esc(cells[1]) + '</dd>'
        }).join('') + '</dl>'
      case 'code':
        return '<pre class="code"><code>' + esc(one.text) + '</code></pre>'
      case 'chips':
        return '<div class="chips">' + list(one.items).map(function (chip) {
          if (typeof chip === 'string') return '<span class="chip">' + esc(chip) + '</span>'
          return '<span class="chip' + (chip && chip.accent ? ' accent' : '') + '">' + esc(chip && chip.text) + '</span>'
        }).join('') + '</div>'
      case 'stat':
        return '<div class="stat"><b class="num">' + esc(one.num) + '</b><span>' + esc(one.text || '') + '</span></div>'
      case 'rule':
        return '<hr class="rule">'
      default:
        return ''
    }
  }

  /** 一个小节的外壳。 */
  function section(heading, sub, body) {
    if (!body) return ''
    return '<section class="section">' +
      (heading ? '<h2>' + esc(heading) + (sub ? ' <small>' + esc(sub) + '</small>' : '') + '</h2>' : '') +
      body + '</section>'
  }

  // ══════════════ 可点名条目的公共零件 ══════════════

  /**
   * 渲染一个可点名条目。**控件长在条目自己的卡片里**（skill §3.2）。
   * @param item - { id, title, desc, image, caption }。
   * @param words - 该条目的判动词。
   * @param mode - 'single' 时按钮上带 data-mode。
   */
  function itemHtml(item, words, mode) {
    var id = String(item.id || '')
    ids.push(id)
    var buttons = words.map(function (word) {
      return '<button class="sm-btn" data-id="' + esc(id) + '" data-w="' + esc(word) + '" aria-pressed="false"' +
        (mode ? ' data-mode="' + mode + '"' : '') + '>' + esc(word) + '</button>'
    }).join('')
    return '<div class="card sm-item" data-item="' + esc(id) + '" data-done="0">' +
      '<div class="sm-id">' + esc(id) + '</div>' +
      (item.title ? '<h3>' + esc(item.title) + '</h3>' : '') +
      (item.desc ? '<p>' + esc(item.desc) + '</p>' : '') +
      (item.image
        ? '<figure class="evidence"><img class="sm-img" src="' + esc(item.image) + '" alt="' + esc(item.title || '') + '">' +
          (item.caption ? '<figcaption>' + esc(item.caption) + '</figcaption>' : '') + '</figure>'
        : '') +
      '<div class="sm-row">' + buttons +
      '<input class="sm-note" data-id="' + esc(id) + '" placeholder="备注（可空）" value="">' +
      '</div></div>'
  }

  // ══════════════ 三个形状 ══════════════

  /** review：逐项表态。 */
  function renderReview(data) {
    var html = ''
    list(data.sections).forEach(function (sec) {
      var body = sec.intro ? '<p>' + esc(sec.intro) + '</p>' : ''
      var items = list(sec.items)
      if (items.length > 0) {
        body += '<div class="cols' + (sec.two ? ' two' : '') + '">' +
          items.map(function (item) { return itemHtml(item, verdicts, '') }).join('') + '</div>'
      }
      body += list(sec.blocks).map(block).join('')
      html += section(sec.heading, sec.sub, body)
    })
    return html
  }

  /** pick：从候选里挑。单选或多选。 */
  function renderPick(data) {
    var mode = data.mode === 'multi' ? 'multi' : 'single'
    var html = data.question
      ? '<div class="callout"><span class="label">要你定</span>' + esc(data.question) + '</div>'
      : ''
    var items = list(data.candidates)
    if (items.length > 0) {
      html += '<div class="cols">' +
        items.map(function (item) { return itemHtml(item, [verdicts[0]], mode) }).join('') + '</div>'
    }
    html += list(data.blocks).map(block).join('')
    return section(data.heading, data.sub, html)
  }

  /** report：图文汇报。每小节一个轻回执，可用 sectionReceipt:false 关掉。 */
  function renderReport(data) {
    var html = ''
    list(data.sections).forEach(function (sec) {
      var body = sec.intro ? '<p>' + esc(sec.intro) + '</p>' : ''
      body += list(sec.blocks).map(block).join('')
      if (sec.sectionReceipt !== false && sec.heading) {
        var id = String(sec.id || ('sec-' + String(sec.heading).slice(0, 20)))
        ids.push(id)
        var buttons = DEFAULT_VERDICTS.report.map(function (word) {
          return '<button class="sm-btn" data-id="' + esc(id) + '" data-w="' + esc(word) + '" aria-pressed="false">' +
            esc(word) + '</button>'
        }).join('')
        body += '<div class="callout sm-item" data-item="' + esc(id) + '" data-done="0">' +
          '<div class="sm-id">' + esc(id) + '</div>' +
          '<div class="sm-row">' + buttons +
          '<input class="sm-note" data-id="' + esc(id) + '" placeholder="这一段有意见就写在这里" value="">' +
          '</div></div>'
      }
      html += section(sec.heading, sec.sub, body)
    })
    return html
  }

  // ══════════════ 收尾区：回执 ══════════════

  /** 兜底通道：可选中复制的文本 + 几个按钮。默认通道是 postMessage（见 sync）。 */
  function receiptHtml() {
    return '<section class="section sm-receipt">' +
      '<h2>回执 <small>这行文本就是回执；也可以点上面的判定，我会实时把它交给卡片</small></h2>' +
      '<div class="chips" id="sm-words"></div>' +
      '<textarea id="sm-out" readonly placeholder="在上面做选择，这里会出现一行一条的回执"></textarea>' +
      '<p style="margin-top:10px">' +
      '<button class="btn primary" id="sm-send">交给卡片</button> ' +
      '<button class="btn" id="sm-copy">复制全部</button> ' +
      '<button class="btn" id="sm-clear">清空</button>' +
      '<span class="sm-msg" id="sm-msg"></span>' +
      '</p></section>'
  }

  /** 组句：一行一条 `<id> <判定词>[：备注]`。 */
  function composeText() {
    var lines = []
    for (var i = 0; i < ids.length; i++) {
      var one = state[ids[i]]
      if (one && one.verdict !== '') lines.push(ids[i] + ' ' + one.verdict + (one.note ? '：' + one.note : ''))
    }
    return lines.join('\n')
  }

  /** 每次状态变化：刷新标记、组句、发给卡片。 */
  function sync() {
    var out = document.getElementById('sm-out')
    if (out !== null) out.value = composeText()

    var items = document.querySelectorAll('[data-item]')
    for (var i = 0; i < items.length; i++) {
      var one = state[items[i].getAttribute('data-item')]
      items[i].setAttribute('data-done', one && one.verdict ? '1' : '0')
    }

    // 默认通道：**每次变化都发**，卡片上的回执条才是活的（skill §4.1）。
    if (window.parent !== window) {
      try {
        window.parent.postMessage({ type: FEEDBACK_TYPE, text: composeText() }, '*')
      } catch (error) { /* 父页面不在时忽略 */ }
    }
  }

  /** 写一句状态提示。 */
  function say(text) {
    var el = document.getElementById('sm-msg')
    if (el !== null) el.textContent = text
  }

  /** 开关一个判定。pick 单选模式下互斥。 */
  function toggle(id, word, mode) {
    if (mode === 'single') {
      for (var key in state) {
        if (Object.prototype.hasOwnProperty.call(state, key) && key !== id) state[key].verdict = ''
      }
    }
    var one = state[id] || { verdict: '', note: '' }
    one.verdict = one.verdict === word ? '' : word
    state[id] = one
    refreshPressed()
    sync()
  }

  /** 把按钮的 aria-pressed 刷成与 state 一致。 */
  function refreshPressed() {
    var buttons = document.querySelectorAll('.sm-btn')
    for (var i = 0; i < buttons.length; i++) {
      var one = state[buttons[i].getAttribute('data-id')]
      buttons[i].setAttribute('aria-pressed', one && one.verdict === buttons[i].getAttribute('data-w') ? 'true' : 'false')
    }
  }

  /** 接上事件。 */
  function wire() {
    var main = document.getElementById('sm-content')
    main.addEventListener('click', function (event) {
      var target = event.target
      if (!target || !target.getAttribute || !target.className) return
      if (target.className.indexOf('sm-btn') === -1) return
      var id = target.getAttribute('data-id')
      var word = target.getAttribute('data-w')
      if (id && word) toggle(id, word, target.getAttribute('data-mode'))
    })
    main.addEventListener('input', function (event) {
      var target = event.target
      if (!target || !target.className || target.className.indexOf('sm-note') === -1) return
      var id = target.getAttribute('data-id')
      state[id] = state[id] || { verdict: '', note: '' }
      state[id].note = target.value
      sync()
    })

    document.getElementById('sm-send').addEventListener('click', function () {
      if (composeText() === '') { say('还没有做任何选择'); return }
      sync()
      say(window.parent === window ? '不在卡片里，直接选中上面的文本复制即可' : '已交给卡片 ✓ 点卡片上的「填入输入框」')
    })
    document.getElementById('sm-copy').addEventListener('click', function () {
      var out = document.getElementById('sm-out')
      if (out.value === '') { say('还没有做任何选择'); return }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(out.value).then(
          function () { say('已复制 ✓') },
          function () { out.focus(); out.select(); say('剪贴板被拦，已帮你选中，按 Ctrl+C') },
        )
      } else {
        out.focus(); out.select(); say('已选中，按 Ctrl+C')
      }
    })
    document.getElementById('sm-clear').addEventListener('click', function () {
      state = {}
      refreshPressed(); sync(); say('已清空')
    })
  }

  // ══════════════ 启动 ══════════════

  /** 控件样式。只用预设令牌，所以换皮肤会跟着变。 */
  var CONTROL_CSS = [
    '.sm-item{display:flex;flex-direction:column;gap:var(--s2,10px)}',
    '.sm-id{font-family:var(--mono,monospace);font-size:var(--f-xs,12px);letter-spacing:.08em;color:var(--accent,#3b82f6)}',
    '.sm-item[data-done="1"] .sm-id::after{content:" ✓"}',
    '.sm-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:auto}',
    '.sm-btn{cursor:pointer;font:400 var(--f-xs,12px)/1 var(--font,sans-serif);padding:7px 11px;border:1px solid var(--line,#e5e7eb);background:none;color:var(--ink-2,#4b5563);border-radius:var(--r-sm,4px)}',
    '.sm-btn:hover{border-color:var(--ink,#111);color:var(--ink,#111)}',
    '.sm-btn[aria-pressed="true"]{background:var(--accent,#3b82f6);border-color:var(--accent,#3b82f6);color:#fff}',
    '.sm-note{flex:1;min-width:150px;font:400 var(--f-xs,12px)/1.5 var(--font,sans-serif);padding:6px 9px;border:1px solid var(--line,#e5e7eb);background:none;color:var(--ink,#111);border-radius:var(--r-sm,4px)}',
    '.sm-note:focus{outline:none;border-color:var(--ink,#111)}',
    '.sm-img{display:block;width:100%;max-height:60vh;object-fit:contain;background:var(--surface-2,#f4f4f4)}',
    '.sm-receipt textarea{width:100%;min-height:110px;box-sizing:border-box;padding:10px;resize:vertical;font:400 var(--f-sm,13px)/1.7 var(--mono,monospace);background:none;color:var(--ink,#111);border:1px solid var(--line,#e5e7eb);border-radius:var(--r-sm,4px)}',
    '.sm-msg{font-size:var(--f-xs,12px);color:var(--muted,#8a8a8a);margin-left:8px}',
  ].join('')

  /** 渲染整页。 */
  function render(data) {
    if (data.skin) {
      var skin = document.getElementById('skin')
      if (skin !== null) skin.setAttribute('href', 'presets/' + String(data.skin) + '.css')
    }
    if (Array.isArray(data.verdicts) && data.verdicts.length > 0) verdicts = data.verdicts
    if (data.shape) SHAPE = data.shape
    if (data.title) document.title = String(data.title)

    // 先把状态清干净，允许重复渲染
    ids = []
    state = {}

    var body = SHAPE === 'pick' ? renderPick(data)
      : SHAPE === 'report' ? renderReport(data)
        : renderReview(data)

    document.getElementById('sm-masthead').innerHTML =
      '<header class="masthead">' +
      (data.kicker ? '<div class="kicker">' + esc(data.kicker) + '</div>' : '') +
      '<h1>' + esc(data.title || '（数据里缺 title）') + '</h1>' +
      (data.lead ? '<p class="lead">' + esc(data.lead) + '</p>' : '') +
      (list(data.meta).length > 0
        ? '<div class="meta">' + list(data.meta).map(function (one) { return '<span>' + esc(one) + '</span>' }).join('') + '</div>'
        : '') +
      '</header>'

    document.getElementById('sm-content').innerHTML = body
    document.getElementById('sm-receipt').innerHTML = receiptHtml()

    // 词表必须列出来：用户要知道能填什么，模型要知道收到了什么（skill §3.1）
    document.getElementById('sm-words').innerHTML =
      verdicts.map(function (word) { return '<span class="chip accent">' + esc(word) + '</span>' }).join('') +
      '<span class="chip">备注可空</span>'

    wire()
    sync()
  }

  /** 启动：加载同名数据文件并渲染。 */
  function boot() {
    var style = document.createElement('style')
    style.textContent = CONTROL_CSS
    document.head.appendChild(style)

    var name = dataFileName()
    var script = document.createElement('script')
    script.src = name
    script.onload = function () {
      if (!window.SHOWME || typeof window.SHOWME !== 'object') {
        fail('数据文件里没有 `window.SHOWME`：' + name, [
          '数据文件必须写成 <code>window.SHOWME = { … }</code>；',
          '文件名必须和页面同名：<code>foo.html</code> ↔ <code>foo.data.js</code>。',
        ])
        return
      }
      try {
        render(window.SHOWME)
      } catch (error) {
        fail('渲染出错：' + (error && error.message ? error.message : String(error)), [
          '多半是数据的字段写错了；对照 skill §5 的字段表核对一遍。',
        ])
      }
    }
    script.onerror = function () {
      fail('没找到数据文件：' + name, [
        '数据文件必须和页面<strong>同名同目录</strong>：<code>foo.html</code> ↔ <code>foo.data.js</code>。',
        '用 <code>write</code> 把数据写到 <code>.dsh/showme/' + esc(name) + '</code>。',
        '数据文件里第一行写 <code>window.SHOWME = { … }</code>。',
      ])
    }
    document.head.appendChild(script)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
