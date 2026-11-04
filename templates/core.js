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

  /** 渲染回执的 type（卡片据此发现白屏，0.3.0）。 */
  var RENDERED_TYPE = 'dsh-showme-rendered'

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

  /** 条目自带选项集时收集到的选项词（回执词表要把它们并进去）。 */
  var optionWords = []

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

  /**
   * 行内 markdown：只认**块类型表达不了**的三种写法（强调 / 行内代码 / 链接），外加换行。
   *
   * 顺序很关键：**先 esc 再替换**。反过来的话数据里的 `<img onerror=…>` 就成了真节点。
   * 不支持的一律原样返回（斜体、删除线、图片、脚注、嵌套都不认）——
   * 宁可少认几种，也不要让正文里的 `*` 和 `|` 被误解析。
   *
   * @param value - 来自数据的文本。
   */
  function inlineMd(value) {
    var text = esc(value)

    // 行内代码先摘出来，里面的内容不再参与后面的替换。
    var codes = []
    text = text.replace(/`([^`\n]+)`/g, function (_, inner) {
      codes.push(inner)
      return '\u0000' + (codes.length - 1) + '\u0000'
    })

    // 链接：只放行 http(s)、页内锚点、相对路径；其它 scheme 原样留着。
    text = text.replace(/\[([^\]\n]+)\]\(([^()\s]+)\)/g, function (whole, label, href) {
      if (!/^(?:https?:\/\/|#|\.{1,2}\/)/i.test(href)) return whole
      return '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + label + '</a>'
    })

    // 强调：两侧 ** 成对、内部不含 *、首尾不是空白才算。
    text = text.replace(/\*\*([^*\n]+)\*\*/g, function (whole, inner) {
      if (inner === '' || inner.trim() !== inner) return whole
      return '<strong>' + inner + '</strong>'
    })

    // 换行就是换行（文本字段里的 \n 不该被吞）。
    text = text.replace(/\n/g, '<br>')

    // 把行内代码放回去。
    text = text.replace(/\u0000(\d+)\u0000/g, function (_, index) {
      return '<code>' + codes[Number(index)] + '</code>'
    })
    return text
  }

  /**
   * 页面文件名 → 数据文件名（同目录、同名、`.data.js`）。
   *
   * 基准用 `document.baseURI`：页面里若声明了 `<base href>`，真实位置在它身上；
   * 没有 base 时它就等于 `location`。
   */
  function dataFileName() {
    var source = String(document.baseURI || location.href || '')
    source = source.split('#')[0].split('?')[0]
    var last = decodeURIComponent((source.split('/').pop() || '').trim())
    return last.replace(/\.html?$/i, '') + '.data.js'
  }

  /**
   * 这一页是不是跑在"地址里没有文件名"的宿主里。
   *
   * 实测（2026-09-26）：dsh 的**原生文档预览**把 HTML 塞进一个 blob iframe
   * （`URL.createObjectURL(new Blob([html]))`），地址那一串是 blob 的 uuid ——
   * 于是"按自己的文件名推导数据文件"必然失败，报出来的名字就是一个 uuid。
   * 这不是页面写错了，是那种宿主天生给不了文件名。
   * @returns true 表示推导不可靠。
   */
  function urlHasNoFileName() {
    var protocol = String(location.protocol || '')
    if (protocol === 'blob:' || protocol === 'data:') return true
    return /^about:/.test(String(location.href || ''))
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
    reportRendered({ ok: false, failed: true, message: String(title) })
  }

  // ══════════════ 通用内容块 ══════════════

  /** 渲染一个内容块。report 形状用它，其它形状也可顺手用。 */
  function block(one) {
    if (one === null || typeof one !== 'object') return ''
    switch (one.type) {
      case 'text':
        return '<p>' + (one.plain === true ? esc(one.text) : inlineMd(one.text)) + '</p>'
      case 'image':
        return '<figure class="evidence"><img class="sm-img" src="' + esc(one.src) + '" alt="' + esc(one.alt || '') + '">' +
          (one.caption ? '<figcaption>' + inlineMd(one.caption) + '</figcaption>' : '') + '</figure>'
      case 'table':
        return '<table class="table"><thead><tr>' +
          list(one.head).map(function (cell) { return '<th>' + inlineMd(cell) + '</th>' }).join('') +
          '</tr></thead><tbody>' +
          list(one.rows).map(function (row) {
            return '<tr>' + list(row).map(function (cell) { return '<td>' + inlineMd(cell) + '</td>' }).join('') + '</tr>'
          }).join('') + '</tbody></table>'
      case 'callout':
        return '<div class="callout' + (one.tone ? ' ' + esc(one.tone) : '') + '">' +
          (one.label ? '<span class="label">' + esc(one.label) + '</span>' : '') + inlineMd(one.text) + '</div>'
      case 'timeline':
        return '<ol class="timeline">' + list(one.items).map(function (entry) {
          return '<li>' + (entry.title ? '<b>' + esc(entry.title) + '</b>' : '') + inlineMd(entry.text || '') + '</li>'
        }).join('') + '</ol>'
      case 'kv':
        return '<dl class="kv">' + list(one.pairs).map(function (pair) {
          var cells = list(pair)
          return '<dt>' + esc(cells[0]) + '</dt><dd>' + inlineMd(cells[1]) + '</dd>'
        }).join('') + '</dl>'
      case 'code':
        return '<pre class="code"><code>' + esc(one.text) + '</code></pre>'
      case 'chips':
        return '<div class="chips">' + list(one.items).map(function (chip) {
          if (typeof chip === 'string') return '<span class="chip">' + inlineMd(chip) + '</span>'
          return '<span class="chip' + (chip && chip.accent ? ' accent' : '') + '">' + inlineMd(chip && chip.text) + '</span>'
        }).join('') + '</div>'
      case 'stat':
        return '<div class="stat"><b class="num">' + esc(one.num) + '</b><span>' + inlineMd(one.text || '') + '</span></div>'
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
   * 判定控件：三个词、固定顺序、位置不随条目变化（希克定律 + 肌肉记忆）。
   * @param id - 条目 id。
   * @param words - 该条目的判动词。
   * @param mode - 'single' 时按钮上带 data-mode。
   */
  function controlHtml(id, words, mode) {
    var buttons = words.map(function (word) {
      return '<button class="sm-btn" data-id="' + esc(id) + '" data-w="' + esc(word) + '" aria-pressed="false"' +
        (mode ? ' data-mode="' + mode + '"' : '') + '>' + esc(word) + '</button>'
    }).join('')
    return '<div class="sm-seg" role="group" aria-label="' + esc(id) + ' 的判定">' + buttons + '</div>' +
      '<input class="sm-note" data-id="' + esc(id) + '" placeholder="备注（可空）" value="">'
  }

  /**
   * 条目内选项集：「这一条有两条互斥的路，挑一条」。
   *
   * 为什么复用 `.sm-btn` + `data-id`/`data-w` 而不是自己一套状态：
   * 判定在 `state[id]` 里只存一个词，`toggle()` / `refreshPressed()` / `sync()` /
   * 草稿通道 / click 委托全都零改动就生效；同一个 id 只有一个 verdict，
   * 互斥是天然的。**不要**加 `data-mode`——那是 pick 的跨条目单选。
   *
   * @param item - 带 `options` 的条目：`[{ value, label, why }]`。
   */
  function optionsHtml(item) {
    var id = String(item.id || '')
    var options = list(item.options)
    var preferred = item.preferred === undefined ? '' : String(item.preferred)
    var cells = options.map(function (option) {
      var value = String(option.value === undefined ? '' : option.value)
      if (optionWords.indexOf(value) === -1) optionWords.push(value)
      var label = option.label === undefined ? value : String(option.label)
      var why = option.why === undefined ? '' : String(option.why)
      return '<button class="sm-btn sm-opt" type="button" role="radio" aria-checked="false"' +
        ' data-id="' + esc(id) + '" data-w="' + esc(value) + '"' +
        ' aria-label="' + esc(id + ' ' + value + ' ' + label) + '">' +
        '<span class="sm-optTop"><span class="sm-optVal">' + esc(value) + '</span>' +
        '<span class="sm-optLabel">' + esc(label) + '</span>' +
        (preferred === value ? '<span class="sm-optPref">倾向</span>' : '') + '</span>' +
        (why ? '<span class="sm-optWhy">' + inlineMd(why) + '</span>' : '') +
        '<span class="sm-optPick"><span class="sm-optDot"></span>选这个</span>' +
        '</button>'
    }).join('')
    return '<div class="sm-opts" role="radiogroup" aria-label="' + esc(id) + ' 的选项">' + cells + '</div>' +
      '<input class="sm-note" data-id="' + esc(id) + '" placeholder="备注（可空）" value="">'
  }

  /** 这一条是自己挑选项（而不是共用页级判定词）。 */
  function hasOptions(item) {
    return Array.isArray(item.options) && item.options.length > 0
  }

  /**
   * 回执词表：页级判动词 + 条目选项的词，去重保序、最多 8 个。
   *
   * 为什么要合并：带 options 的条目根本不接受页级判定词，只列 `同意/要改/不要`
   * 会让用户以为能填那些词。上限 8 个是为了那一行 chips 不换行换到失控。
   */
  function wordsForChips() {
    var out = []
    function push(word) {
      if (word === '' || out.indexOf(word) !== -1) return
      out.push(word)
    }
    for (var i = 0; i < verdicts.length; i++) push(String(verdicts[i]))
    for (var n = 0; n < optionWords.length; n++) push(optionWords[n])
    if (out.length <= 8) return out
    return out.slice(0, 8).concat(['…'])
  }

  /**
   * 带图的条目：发一张卡（视觉重量只给真需要看图的东西，孤立效应）。
   * @param item - { id, title, desc, image, caption }。
   */
  function cardHtml(item, words, mode) {
    var id = String(item.id || '')
    ids.push(id)
    return '<div class="card sm-item" data-item="' + esc(id) + '" data-done="0">' +
      '<div class="sm-head"><span class="sm-id">' + esc(id) + '</span>' +
      (item.title ? '<h3>' + esc(item.title) + '</h3>' : '') + '</div>' +
      (item.desc
        ? '<p class="sm-desc' + (String(item.desc).length > 90 ? ' sm-clamped' : '') + '" data-desc="' + esc(id) + '">' + inlineMd(item.desc) + '</p>' +
          (String(item.desc).length > 90 ? '<button class="sm-more" type="button" data-more="' + esc(id) + '">展开</button>' : '')
        : '') +
      '<figure class="evidence"><img class="sm-img" src="' + esc(item.image) + '" alt="' + esc(item.title || '') + '">' +
      (item.caption ? '<figcaption>' + inlineMd(item.caption) + '</figcaption>' : '') + '</figure>' +
      '<div class="sm-ctl">' + (hasOptions(item) ? optionsHtml(item) : controlHtml(id, words, mode)) + '</div>' +
      '</div>'
  }

  /**
   * 纯文字的条目：走一行（同类同形，不做「一人一张卡」的重复布局）。
   * @param item - { id, title, desc }。
   */
  function lineHtml(item, words, mode) {
    var id = String(item.id || '')
    ids.push(id)
    return '<div class="sm-line' + (hasOptions(item) ? ' sm-hasOpts' : '') + '" data-item="' + esc(id) + '" data-done="0">' +
      '<div class="sm-lineMain"><div class="sm-head"><span class="sm-id">' + esc(id) + '</span>' +
      (item.title ? '<h3>' + esc(item.title) + '</h3>' : '') + '</div>' +
      (item.desc
        ? '<p class="sm-desc' + (String(item.desc).length > 90 ? ' sm-clamped' : '') + '" data-desc="' + esc(id) + '">' + inlineMd(item.desc) + '</p>' +
          (String(item.desc).length > 90 ? '<button class="sm-more" type="button" data-more="' + esc(id) + '">展开</button>' : '')
        : '') + '</div>' +
      '<div class="sm-ctl">' + (hasOptions(item) ? optionsHtml(item) : controlHtml(id, words, mode)) + '</div>' +
      '</div>'
  }

  /**
   * 一组条目：带图的发卡、纯文字的合成一块面板；组内保序，卡片组在前。
   * @param items - 条目数组。
   * @param words - 判动词。
   * @param mode - 透传给控件。
   */
  function itemsHtml(items, words, mode, two) {
    if (items.length === 0) return ''
    var cards = []
    var lines = []
    items.forEach(function (item) { (item && item.image ? cards : lines).push(item) })
    var cardsHtml = ''
    if (cards.length > 0) {
      cardsHtml = '<div class="cols sm-cards' + (two ? ' two' : '') + '">' +
        cards.map(function (item) { return cardHtml(item, words, mode) }).join('') + '</div>'
    }
    var linesHtml = ''
    if (lines.length > 0) {
      linesHtml = '<div class="sm-list">' +
        lines.map(function (item) { return lineHtml(item, words, mode) }).join('') + '</div>'
    }
    // 横屏节省空间：只有一张卡 + 一叠文字行时，左右并排，而不是让右半边空着。
    if (cards.length === 1 && lines.length > 0) {
      return '<div class="sm-split">' + cardsHtml + linesHtml + '</div>'
    }
    return cardsHtml + linesHtml
  }

  /** doc：纯文档。没有判定控件、没有回执——它只负责把内容讲清楚。 */
  function renderDoc(data) {
    var html = ''
    list(data.sections).forEach(function (sec) {
      var body = sec.intro ? '<p>' + inlineMd(sec.intro) + '</p>' : ''
      body += list(sec.blocks).map(block).join('')
      html += section(sec.heading, sec.sub, body)
    })
    return html
  }

  /** doc 的页尾：一个复制按钮，别的一概没有。 */
  function docFooterHtml() {
    return '<section class="section sm-receipt"><p style="margin-top:0">' +
      '<button class="btn" id="sm-copy-doc" type="button">复制全文</button>' +
      '<span class="sm-msg" id="sm-msg"></span>' +
      '</p></section>'
  }

  /**
   * 告诉卡片"我渲染完了/我挂了"。
   *
   * 为什么需要：卡片看不到 iframe 里的 DOM（不透明源），白屏时只能等用户说。
   * 这一条消息让"页面出来了没有"变成可观测的（0.3.0）。
   *
   * @param payload - `{ ok, failed?, message?, ids? }`。
   */
  function reportRendered(payload) {
    if (window.parent === window) return
    var buttons = 0
    try {
      buttons = document.querySelectorAll('.sm-btn').length
    } catch (error) {
      buttons = 0
    }
    try {
      window.parent.postMessage({
        type: RENDERED_TYPE,
        ok: payload.ok === true,
        failed: payload.failed === true,
        ids: payload.ids === undefined ? ids.length : payload.ids,
        buttons: buttons,
        message: payload.message || '',
      }, '*')
    } catch (error) { /* 父页面不在就算了 */ }
  }

  // ══════════════ 三个形状 ══════════════

  /** review：逐项表态。 */
  function renderReview(data) {
    var html = ''
    list(data.sections).forEach(function (sec) {
      var body = sec.intro ? '<p>' + inlineMd(sec.intro) + '</p>' : ''
      var items = list(sec.items)
      if (items.length > 0) body += itemsHtml(items, verdicts, '', sec.two)
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
    if (items.length > 0) html += itemsHtml(items, [verdicts[0]], mode)
    html += list(data.blocks).map(block).join('')
    return section(data.heading, data.sub, html)
  }

  /** report：图文汇报。每小节一个轻回执，可用 sectionReceipt:false 关掉。 */
  function renderReport(data) {
    var html = ''
    list(data.sections).forEach(function (sec) {
      var body = sec.intro ? '<p>' + inlineMd(sec.intro) + '</p>' : ''
      body += list(sec.blocks).map(block).join('')
      if (sec.sectionReceipt !== false && sec.heading) {
        var id = String(sec.id || ('sec-' + String(sec.heading).slice(0, 20)))
        ids.push(id)
        body += '<div class="sm-list sm-list-solo"><div class="sm-line" data-item="' + esc(id) + '" data-done="0">' +
          '<div class="sm-lineMain"><div class="sm-head"><span class="sm-id">' + esc(id) + '</span></div></div>' +
          '<div class="sm-ctl">' + controlHtml(id, DEFAULT_VERDICTS.report, '') + '</div>' +
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
      '<p class="sm-progress" id="sm-progress"></p>' +
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

    // 进度一直可见：还差几条，用户知道什么时候可以收工（目标梯度）。
    var done = 0
    for (var n = 0; n < ids.length; n++) {
      if (state[ids[n]] && state[ids[n]].verdict) done++
    }
    var progress = document.getElementById('sm-progress')
    if (progress !== null) {
      progress.textContent = ids.length === 0 ? ''
        : done === 0 ? '还没表态 · 一共 ' + ids.length + ' 条'
          : '已表态 ' + done + ' / ' + ids.length
    }

    // 默认通道：**每次变化都发**，卡片上的回执条才是活的（skill §4.1）。
    if (window.parent !== window) {
      try {
        window.parent.postMessage({ type: FEEDBACK_TYPE, text: composeText() }, '*')
      } catch (error) { /* 父页面不在时忽略 */ }
    }

    // 顺手存一份草稿：刷新 / 切会话回来还能捡回选择与备注。
    saveDraftSoon()
  }

  /** 写一句状态提示。 */
  function say(text) {
    var el = document.getElementById('sm-msg')
    if (el !== null) el.textContent = text
  }

  // ══════════════ 草稿：刷新 / 切会话不丢 ══════════════
  //
  // 展示页跑在 sandbox 的不透明源里，localStorage / cookie 都用不了；对宿主的
  // POST 也会被跨域拦掉。所以这里只做两件事：**把状态 postMessage 给卡片**、
  // 以及**接收卡片灌回来的草稿**。落盘与读取由同源的卡片负责（lib/client.js）。

  /** 与 lib/client.js 对齐的三个消息类型。 */
  var DRAFT_TYPE = 'dsh-showme-draft'
  var DRAFT_READY_TYPE = 'dsh-showme-draft-ready'
  var DRAFT_RESTORE_TYPE = 'dsh-showme-draft-restore'

  /** 是否跑在卡片里（不是卡片就没有草稿，一切照旧）。 */
  var inCard = window.parent !== window

  /** 收到卡片回灌之前不写草稿 —— 否则 boot 时那次空 sync 会把旧草稿覆盖掉。 */
  var draftReady = false

  /** 还没渲染完就收到的草稿先存这里：undefined = 还没收到，null = 没有草稿。 */
  var pendingDraft

  /** 已经渲染过一次没有（草稿要等有 id 了才能套）。 */
  var rendered = false

  /** debounce 句柄。 */
  var draftTimer = null

  /** 这次恢复出来的信息（横幅用）。 */
  var restored = null

  /** 把 state 摊成草稿要的形状：{ verdicts: {id: word}, notes: {id: text} }。 */
  function draftPayload() {
    var out = { verdicts: {}, notes: {} }
    for (var i = 0; i < ids.length; i++) {
      var one = state[ids[i]]
      if (!one) continue
      if (one.verdict) out.verdicts[ids[i]] = one.verdict
      if (one.note) out.notes[ids[i]] = one.note
    }
    return out
  }

  /** 立刻把草稿发出去（页面要消失时别等 debounce）。 */
  function postDraft() {
    if (!inCard) return
    if (draftTimer !== null) { clearTimeout(draftTimer); draftTimer = null }
    if (!draftReady) return
    try {
      window.parent.postMessage({ type: DRAFT_TYPE, state: draftPayload() }, '*')
    } catch (error) { /* 父页面不在就算了 */ }
  }

  /** 状态变了：等 400ms 再发（打字时别每一键都发）。 */
  function saveDraftSoon() {
    if (!inCard || !draftReady) return
    if (SHAPE === 'doc') return
    if (typeof setTimeout !== 'function') return
    if (draftTimer !== null) clearTimeout(draftTimer)
    draftTimer = setTimeout(postDraft, 400)
  }

  /** 把 'YYYY-MM-DDTHH:mm:ss.sssZ' 写成 '10-31 23:12'（本地时间）。 */
  function localTime(value) {
    var at = new Date(value)
    if (isNaN(at.getTime())) return ''
    function two(number) { return (number < 10 ? '0' : '') + number }
    return two(at.getMonth() + 1) + '-' + two(at.getDate()) + ' ' + two(at.getHours()) + ':' + two(at.getMinutes())
  }

  /** 恢复横幅。 */
  function bannerHtml() {
    if (restored === null) return ''
    var when = restored.at ? ' ' + localTime(restored.at) : ''
    var text = '已恢复' + when + ' 的表态（' + restored.count + ' 条）'
    if (restored.missing > 0) text += '；其中 ' + restored.missing + ' 条这页已没有，已忽略'
    return '<div class="sm-draft" role="status"><span>' + esc(text) + '</span>' +
      '<button type="button" class="sm-draftClear" id="sm-draft-clear">清空</button></div>'
  }

  /** 只重画横幅那一块。 */
  function renderDraftBanner() {
    var host = document.getElementById('sm-banner')
    if (host !== null) host.innerHTML = bannerHtml()
  }

  /**
   * 把草稿套回页面：只认当前这页还存在的 id。
   * @param draft - 卡片回灌的草稿，或 null（说明没有草稿）。
   */
  function applyDraft(draft) {
    draftReady = true
    if (!draft) {
      restored = null
      renderDraftBanner()
      return
    }
    var known = {}
    for (var i = 0; i < ids.length; i++) known[ids[i]] = true
    var incoming = draft.verdicts || {}
    var notes = draft.notes || {}
    var count = 0
    var missing = 0
    var key
    for (key in incoming) {
      if (!Object.prototype.hasOwnProperty.call(incoming, key)) continue
      if (!known[key]) { missing += 1; continue }
      var one = state[key] || { verdict: '', note: '' }
      one.verdict = String(incoming[key] || '')
      state[key] = one
      if (one.verdict) count += 1
    }
    for (key in notes) {
      if (!Object.prototype.hasOwnProperty.call(notes, key)) continue
      if (!known[key]) { missing += 1; continue }
      var two = state[key] || { verdict: '', note: '' }
      two.note = String(notes[key] || '')
      state[key] = two
    }
    restored = count === 0 ? null : { at: draft.updatedAt || '', count: count, missing: missing }
    refreshPressed()
    sync()
    renderDraftBanner()
  }

  /** 清空：页内清掉、通知卡片把草稿也删掉。 */
  function clearDraft() {
    state = {}
    restored = null
    refreshPressed()
    sync()
    renderDraftBanner()
    if (!inCard) return
    try {
      window.parent.postMessage({ type: DRAFT_TYPE, clear: true }, '*')
    } catch (error) { /* 父页面不在就算了 */ }
    say('已清空')
  }

  /** 接上草稿通道：等卡片回灌 + 页面消失前补发一次。 */
  function bootDraft() {
    if (!inCard) return
    if (typeof window.addEventListener !== 'function') return
    window.addEventListener('message', function (event) {
      var data = event.data
      if (!data || data.type !== DRAFT_RESTORE_TYPE) return
      pendingDraft = data.state === undefined || data.state === null ? null : data.state
      if (rendered) applyDraft(pendingDraft)
    })
    // 页面被卸载 / 切到后台时，debounce 里那一次不能再等。
    window.addEventListener('pagehide', postDraft)
    if (document !== undefined && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') postDraft()
      })
    }
    try {
      window.parent.postMessage({ type: DRAFT_READY_TYPE }, '*')
    } catch (error) { /* 父页面不在就算了 */ }
    // 卡片没回话（老宿主 / 没接上）时，别把用户这一轮的选择也锁死。
    if (typeof setTimeout === 'function') {
      setTimeout(function () {
        if (!draftReady) draftReady = true
      }, 1500)
    } else {
      draftReady = true
    }
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

  /**
   * 从事件目标向上找第一个带某个类名的节点。
   *
   * 为什么要它：按钮里嵌了 span（选项的 value / label / 理由），点击的 target
   * 通常是那个 span 而不是按钮本身 —— 直接看 target.className 会漏掉绝大多数点击。
   *
   * @param node - 起始节点。
   * @param name - 类名（不含点）。
   */
  function closestByClass(node, name) {
    var one = node
    var limit = 6
    while (one && limit > 0) {
      if (one.className && String(one.className).indexOf(name) !== -1) return one
      one = one.parentNode
      limit -= 1
    }
    return null
  }

  /** 把按钮的 aria-pressed 刷成与 state 一致。 */
  function refreshPressed() {
    var buttons = document.querySelectorAll('.sm-btn')
    for (var i = 0; i < buttons.length; i++) {
      var one = state[buttons[i].getAttribute('data-id')]
      var on = one && one.verdict === buttons[i].getAttribute('data-w')
      buttons[i].setAttribute('aria-pressed', on ? 'true' : 'false')
      // 选项是 radiogroup 里的 radio：同一个状态要同时反映在 aria-checked 上。
      if (buttons[i].className.indexOf('sm-opt') !== -1) {
        buttons[i].setAttribute('aria-checked', on ? 'true' : 'false')
      }
    }
  }

  /** 接上事件。 */
  function wire() {
    var main = document.getElementById('sm-content')
    if (SHAPE === 'doc') {
      var copy = document.getElementById('sm-copy-doc')
      if (copy !== null) {
        copy.addEventListener('click', function () {
          var text = main === null ? '' : String(main.innerText || main.textContent || '')
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(
              function () { say('已复制全文 ✓') },
              function () { say('剪贴板被拦，请手动选中') },
            )
          } else {
            say('请手动选中复制')
          }
        })
      }
      return
    }
    main.addEventListener('click', function (event) {
      var target = event.target
      if (!target || !target.getAttribute || !target.className) return
      if (target.id === 'sm-draft-clear') { clearDraft(); return }
      // 按钮里有 span（选项的 value / label / 理由），点到的往往是内层节点：
      // 一律往上找到带类名的那一层，否则点字不生效、只有点边框才生效。
      var more = closestByClass(target, 'sm-more')
      if (more !== null) {
        var row = more.parentNode
        if (row && row.querySelector) {
          var desc = row.querySelector('.sm-desc')
          if (desc) desc.classList.remove('sm-clamped')
        }
        if (row && row.removeChild) row.removeChild(more)
        return
      }
      var button = closestByClass(target, 'sm-btn')
      if (button === null) return
      var id = button.getAttribute('data-id')
      var word = button.getAttribute('data-w')
      if (id && word) toggle(id, word, button.getAttribute('data-mode'))
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

  /**
   * 控件样式。只用预设令牌，所以换皮肤会跟着变。
   * 结构原则（skill §3.2）：控件和它指的对象在同一块里 —— 纯文字走行，带图才发卡。
   */
  var CONTROL_CSS = [
    // 条目里的层次：id（锚点）→ 标题 → 描述 → 控件
    '.sm-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}',
    '.sm-head h3{margin:0}',
    '.sm-id{font-family:var(--mono,monospace);font-size:var(--f-xs,12px);letter-spacing:.06em;color:var(--accent,#3b82f6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:34ch}',
    '.sm-desc{margin:0;font-size:var(--f-sm,13.5px);color:var(--ink-2,#4b5563)}',
    // 长描述先折三行（兜底：条目位装不下一段话，别让行塌成整段高）
    '.sm-desc.sm-clamped{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}',
    '.sm-more{cursor:pointer;align-self:start;justify-self:start;margin-top:2px;padding:2px 0;border:0;background:none;font:500 var(--f-xs,12px)/1 var(--font,sans-serif);color:var(--accent,#3b82f6)}',
    '.sm-more:hover{text-decoration:underline}',
    '.sm-item[data-done="1"] .sm-id::after,.sm-line[data-done="1"] .sm-id::after{content:" ✓"}',
    '.sm-item[data-done="1"] .sm-desc{opacity:.72}',

    // 带图条目：卡片（视觉重量只给它）
    '.cols.sm-cards{grid-template-columns:repeat(auto-fit,minmax(min(100%,400px),1fr));margin-top:14px}',
    // 横屏：一张卡 + 一叠文字行并排（右边不再空着）
    '.sm-split{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.2fr);gap:16px;align-items:start;margin-top:14px}',
    '.sm-split .sm-cards{margin-top:0}',
    '.sm-split .sm-list{margin:0}',
    '.sm-split .sm-line{grid-template-columns:1fr;gap:8px;align-items:start}',
    '.sm-split .sm-ctl{width:100%}',
    '.sm-split .sm-seg{display:flex;width:100%;justify-self:stretch}',
    '.sm-split .sm-btn{flex:1}',
    '.sm-item{display:flex;flex-direction:column;gap:10px;max-width:640px}',

    // 纯文字条目：一块面板 + 行（共同区域 + 邻近性）
    '.sm-list{background:var(--surface,#fff);border:1px solid var(--line,#e5e7eb);border-radius:var(--r,14px);overflow:hidden;margin:14px 0}',
    '.sm-list-solo{margin:10px 0 0}',
    // 小节回执：一行搞定（id 在左，判定 + 备注在右并排），不再占一整块面板的高度。
    '.sm-list-solo .sm-line{grid-template-columns:auto minmax(0,1fr);align-items:center;padding:10px 16px}',
    '.sm-list-solo .sm-ctl{grid-auto-flow:column;justify-content:end;align-items:center;gap:10px}',
    '.sm-list-solo .sm-note{width:240px}',
    '.sm-line{display:grid;grid-template-columns:minmax(0,1fr) 296px;gap:18px;align-items:start;padding:12px 16px}',
    '.sm-line .sm-ctl{margin-top:0}',
    '.sm-line + .sm-line{border-top:1px solid var(--line,#e5e7eb)}',
    '.sm-line:hover{background:var(--surface-2,#f4f4f4)}',
    '.sm-lineMain{display:flex;flex-direction:column;gap:3px;min-width:0}',
    // 带选项的条目占满整行：296px 的控件列放不下两张带理由的选项卡。
    '.sm-line.sm-hasOpts{grid-template-columns:1fr}',
    '.sm-hasOpts .sm-ctl{grid-template-columns:1fr}',
    '.sm-hasOpts .sm-opts{max-width:760px}',

    // 控件层：分段控件 + 备注一行，钉在底部
    '.sm-ctl{display:grid;gap:8px;margin-top:auto}',
    '.sm-seg{display:inline-flex;justify-self:start;border:1px solid var(--line-strong,#d5dae2);border-radius:var(--r-pill,999px);overflow:hidden;background:var(--surface,#fff)}',
    '.sm-btn{cursor:pointer;font:500 var(--f-xs,12px)/1 var(--font,sans-serif);padding:10px 15px;border:0;background:none;color:var(--ink-2,#4b5563)}',
    '.sm-btn + .sm-btn{border-left:1px solid var(--line,#e5e7eb)}',
    '.sm-btn:hover{background:var(--surface-2,#f4f4f4);color:var(--ink,#111)}',
    '.sm-btn[aria-pressed="true"]{background:var(--accent,#3b82f6);color:#fff}',
    '.sm-btn:focus-visible,.sm-note:focus-visible{outline:2px solid var(--accent,#3b82f6);outline-offset:2px}',
    '.sm-note{width:100%;min-height:36px;font:400 var(--f-xs,12px)/1.5 var(--font,sans-serif);padding:8px 10px;border:1px solid var(--line,#e5e7eb);background:var(--paper,transparent);color:var(--ink,#111);border-radius:var(--r-sm,4px)}',
    // 行里的备注是可选项：虚线 + 静音，别让它抢判定按钮的注意力（也不做隐藏，避免悬停时行高跳动）。
    '.sm-line .sm-note{border-style:dashed;background:transparent;color:var(--muted,#8a8a8a)}',
    '.sm-line .sm-note:focus{color:var(--ink,#111);border-style:solid}',
    '.sm-note:focus{outline:none;border-color:var(--accent,#3b82f6)}',
    '.sm-img{display:block;width:100%;max-height:360px;object-fit:contain;background:var(--surface-2,#f4f4f4)}',

    // 条目内选项集（A/B 两条走法挑一条）：两张并排的选项卡，理由写在选项里。
    // .sm-opt 与 .sm-btn 同时出现在元素上，所以这里用双类提升特异性、覆盖分段按钮的外观。
    '.sm-opts{display:grid;grid-template-columns:1fr 1fr;gap:10px}',
    '.sm-btn.sm-opt{display:grid;gap:7px;justify-items:start;text-align:left;white-space:normal;padding:12px 13px;border:1px solid var(--line-strong,#d5dae2);border-radius:var(--r-sm,10px);background:var(--surface,#fff);color:var(--ink,#111);font:inherit}',
    '.sm-btn.sm-opt + .sm-btn.sm-opt{border-left:1px solid var(--line-strong,#d5dae2)}',
    '.sm-btn.sm-opt:hover{background:var(--surface-2,#f4f4f4)}',
    '.sm-btn.sm-opt[aria-pressed="true"]{background:var(--surface,#fff);color:var(--ink,#111);border-color:var(--accent,#3b82f6);box-shadow:0 0 0 3px var(--accent-soft,#eef5ff)}',
    '.sm-optTop{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.sm-optVal{font:700 var(--f-xs,12px)/1 var(--mono,monospace);min-width:22px;height:22px;display:inline-grid;place-items:center;padding:0 6px;border-radius:6px;background:var(--surface-2,#f4f4f4);border:1px solid var(--line-strong,#d5dae2);color:var(--ink-2,#4b5563)}',
    '.sm-btn.sm-opt[aria-pressed="true"] .sm-optVal{background:var(--accent,#3b82f6);border-color:var(--accent,#3b82f6);color:#fff}',
    '.sm-optLabel{font:600 var(--f-sm,13.5px)/1.35 var(--font,sans-serif)}',
    '.sm-optPref{font:600 var(--f-xs,12px)/1 var(--font,sans-serif);padding:3px 7px;border-radius:5px;background:var(--good-soft,#ecfdf5);border:1px solid var(--good-line,#a7f3d0);color:var(--good,#047857)}',
    '.sm-optWhy{font:400 var(--f-xs,12px)/1.62 var(--font,sans-serif);color:var(--ink-2,#4b5563);display:block}',
    '.sm-optPick{display:flex;align-items:center;gap:6px;font:400 var(--f-xs,12px)/1 var(--font,sans-serif);color:var(--muted,#8a8a8a);margin-top:2px}',
    '.sm-optDot{width:13px;height:13px;border-radius:50%;border:1px solid var(--line-strong,#d5dae2);background:var(--surface,#fff);display:inline-block}',
    '.sm-btn.sm-opt[aria-pressed="true"] .sm-optDot{border-color:var(--accent,#3b82f6);background:var(--accent,#3b82f6);box-shadow:inset 0 0 0 3px var(--surface,#fff)}',

    // 回执区
    '.sm-draft{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:0 0 18px;padding:10px 14px;border:1px dashed var(--line-strong,#d5dae2);border-radius:var(--r-sm,10px);background:var(--surface,#fff);font-size:var(--f-sm,13.5px);color:var(--ink-2,#4b5563)}',
    '.sm-draft span{flex:1;min-width:200px}',
    '.sm-draftClear{cursor:pointer;font:500 var(--f-xs,12px)/1 var(--font,sans-serif);padding:7px 12px;border:1px solid var(--line-strong,#d5dae2);border-radius:var(--r-pill,999px);background:var(--surface,#fff);color:var(--ink,#111)}',
    '.sm-draftClear:hover{background:var(--surface-2,#f4f4f4)}',
    '.sm-progress{margin:0 0 10px;font-size:var(--f-xs,12px);color:var(--muted,#8a8a8a)}',
    '.sm-receipt textarea{width:100%;min-height:110px;box-sizing:border-box;padding:10px;resize:vertical;font:400 var(--f-sm,13px)/1.7 var(--mono,monospace);background:none;color:var(--ink,#111);border:1px solid var(--line,#e5e7eb);border-radius:var(--r-sm,4px)}',
    '.sm-msg{font-size:var(--f-xs,12px);color:var(--muted,#8a8a8a);margin-left:8px}',

    // 窄屏：行折成一列，分段控件铺满（菲茨定律：别把小按钮塞在窄格里）
    '@media (max-width:760px){.sm-line{grid-template-columns:1fr;gap:10px;align-items:start}',
    '.sm-ctl{width:100%}.sm-seg{display:flex;width:100%;justify-self:stretch}.sm-btn{flex:1}',
    '.sm-btn.sm-opt{flex:none;width:100%}',
    '.sm-list-solo .sm-line{grid-template-columns:1fr}.sm-list-solo .sm-ctl{grid-auto-flow:row}',
    '.sm-list-solo .sm-note{width:100%}}',
    // 选项卡窄屏一列（两列会挤成窄条，理由读不动）
    '@media (max-width:820px){.sm-opts{grid-template-columns:1fr}}',
    // 一张卡并排时，窄屏回到上下堆叠
    '@media (max-width:900px){.sm-split{grid-template-columns:1fr}}',
    // 横屏：报头两栏（标题在左、元信息在右），纵向省下一整段
    '@media (min-width:900px){.masthead{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:24px;align-items:end}',
    '.masthead .meta{flex-direction:column;align-items:flex-end;text-align:right;margin-top:0}}',
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
    optionWords = []

    var body = SHAPE === 'doc' ? renderDoc(data)
      : SHAPE === 'pick' ? renderPick(data)
        : SHAPE === 'report' ? renderReport(data)
          : renderReview(data)

    document.getElementById('sm-masthead').innerHTML =
      '<header class="masthead">' +
      '<div class="mastheadMain">' +
      (data.kicker ? '<div class="kicker">' + esc(data.kicker) + '</div>' : '') +
      '<h1>' + esc(data.title || '（数据里缺 title）') + '</h1>' +
      (data.lead ? '<p class="lead">' + inlineMd(data.lead) + '</p>' : '') +
      '</div>' +
      (list(data.meta).length > 0
        ? '<div class="meta">' + list(data.meta).map(function (one) { return '<span>' + esc(one) + '</span>' }).join('') + '</div>'
        : '') +
      '</header>'

    document.getElementById('sm-content').innerHTML =
      '<div id="sm-banner">' + bannerHtml() + '</div>' + body

    if (SHAPE === 'doc') {
      document.getElementById('sm-receipt').innerHTML = docFooterHtml()
    } else {
      document.getElementById('sm-receipt').innerHTML = receiptHtml()
      // 词表必须列出来：用户要知道能填什么，模型要知道收到了什么（skill §3.1）
      document.getElementById('sm-words').innerHTML =
        wordsForChips().map(function (word) { return '<span class="chip accent">' + esc(word) + '</span>' }).join('') +
        '<span class="chip">备注可空</span>'
    }

    wire()
    sync()

    // 草稿可能在渲染前就到了（页面小、卡片快），那时 id 还没有，得等这里再套。
    rendered = true
    if (pendingDraft !== undefined) applyDraft(pendingDraft)

    // 上报"我渲染好了"：卡片据此判断白屏，宿主据此留一份记录（0.3.0）。
    reportRendered({ ok: true, ids: ids.length })
  }

  /** 启动：拿到数据（静态引入或按同名推导）并渲染。 */
  function boot() {
    var style = document.createElement('style')
    style.textContent = CONTROL_CSS
    document.head.appendChild(style)

    // 先接上草稿通道：卡片会在这之后回灌上次的选择。
    bootDraft()

    // 第一条路：数据已经由页面**静态**引入（<script src="x.data.js"> 排在 core.js 之前）。
    // 这条路在原生文档预览里也能活 —— 它会把文档里的静态 script 打包进那个 blob。
    if (window.SHOWME !== null && typeof window.SHOWME === 'object') {
      try {
        render(window.SHOWME)
      } catch (error) {
        fail('渲染出错：' + (error && error.message ? error.message : String(error)), [
          '多半是数据的字段写错了；对照 templates/README.md 的字段表核对一遍。',
        ])
      }
      return
    }

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
          '多半是数据的字段写错了；对照 templates/README.md 的字段表核对一遍。',
        ])
      }
    }
    script.onerror = function () {
      // 宿主给不出文件名时，别把"页面写错了"这口锅甩给作者 —— 说清是哪条路走岔了。
      if (urlHasNoFileName()) {
        fail('这个宿主里读不到数据文件：' + name, [
          '这一页正跑在<b>原生文档预览</b>里：它把 HTML 塞进 blob iframe，地址里没有文件名，' +
            '于是 <code>foo.html</code> ↔ <code>foo.data.js</code> 这条推导失效了（你看到的那个名字是一串 uuid）。',
          '改用卡片的<code>侧栏打开</code>或<code>浏览器打开</code> —— 那两条路走宿主镜像路由，地址里有真实文件名。',
          '要让这一页在原生文档预览里也能起来：把数据改成<b>静态引入</b>，' +
            '在 <code>&lt;script src="templates/core.js"&gt;</code> <b>之前</b>加一行 ' +
            '<code>&lt;script src="页面名.data.js"&gt;&lt;/script&gt;</code>。',
        ])
        return
      }
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
