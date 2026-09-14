/**
 * 展示页冒烟测试：把页面里的内联脚本抽出来，在一个最小 DOM 桩上真跑一遍。
 *
 * 目的不是覆盖页面逻辑，而是拦住最难堪的失败——**白屏**：
 * 语法错误（比如正则里的单反斜杠被吞）、运行时抛异常、渲染没产出内容。
 * 页面是给人看的，出了这种错用户只会看到一片空白。
 *
 * 覆盖两类页面：
 *  - report 形态（`#items` + `#out`）：逐项表态 → 组句 → postMessage
 *  - gallery 形态（`#skin` + `#picker`）：换皮肤 → 选默认 → 组句 → postMessage
 *
 * 跑法：`node test/page-smoke.test.mjs [页面路径...]`
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
// 示例页源码放在 examples/（进仓库）；运行时的展示副本在 .dsh/showme/（不进仓库，
// 否则克隆下来 npm test 会因为缺文件而挂）。
const examplesDir = join(here, '..', 'examples')

const targets = process.argv.length > 2
  ? process.argv.slice(2)
  : [join(examplesDir, 'review.html'), join(examplesDir, 'preset-gallery.html')]

let checks = 0
/**
 * 断言包装。
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

/**
 * 造一个够用的元素桩：记录 innerHTML/value 写入，保存事件处理器与属性。
 * @param id - 元素 id。
 */
function makeElement(id) {
  const attributes = {}
  return {
    id,
    innerHTML: '',
    value: '',
    textContent: '',
    dataset: {},
    style: {},
    handlers: {},
    children: [],
    classList: {
      _set: new Set(),
      contains(name) { return this._set.has(name) },
      add(name) { this._set.add(name) },
      remove(name) { this._set.delete(name) },
      toggle(name, on) {
        if (on === undefined) {
          if (this._set.has(name)) this._set.delete(name)
          else this._set.add(name)
        } else if (on) this._set.add(name)
        else this._set.delete(name)
      },
    },
    addEventListener(type, handler) { this.handlers[type] = handler },
    appendChild(child) { this.children.push(child); return child },
    getAttribute(name) { return name in attributes ? attributes[name] : null },
    setAttribute(name, value) { attributes[name] = String(value) },
    focus() {},
    select() {},
    querySelectorAll() { return [] },
  }
}

for (const target of targets) {
  const path = resolve(target)
  const html = await readFile(path, 'utf8')
  const name = path.split(/[\\/]/).pop()
  console.log(`\n[页面] ${name}`)

  const match = html.match(/<script>([\s\S]*?)<\/script>/)
  assert.ok(match !== null, '页面里没有找到内联 <script>')
  const script = match[1]

  check('内联脚本能通过语法解析', () => new vm.Script(script, { filename: name }))

  const elements = new Map()
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id))
      return elements.get(id)
    },
    createElement: (tag) => makeElement(`<${tag}>`),
    querySelector: (selector) => document.getElementById(`sel:${selector}`),
    querySelectorAll: () => [],
    addEventListener: () => {},
    head: { appendChild: () => {} },
  }
  const messages = []
  const window = { parent: { postMessage: (data) => messages.push(data) } }

  check('脚本能完整跑完（渲染 + 首次同步）', () => {
    const context = vm.createContext({ document, window, navigator: {}, console, parseInt, setTimeout, clearTimeout })
    new vm.Script(script, { filename: name }).runInContext(context)
  })

  // ── 通用：不能白屏 ───────────────────────────────────────────────────
  // `.page` 是共用语义标记的根；历史页面用的是 `.wrap`，两者都认。
  check('页面上有可读内容（不是白屏）', () =>
    assert.ok(html.length > 2000 && /<div class="(?:page|wrap)"/.test(html)),
  )
  check('没有依赖 localStorage 才能工作', () => assert.ok(!/localStorage/.test(script)))

  // ── report 形态 ─────────────────────────────────────────────────────
  if (elements.has('items')) {
    const items = elements.get('items')
    check('渲染出了内容（不是白屏）', () => assert.ok(items.innerHTML.length > 200))

    const ids = [...items.innerHTML.matchAll(/data-id="([^"]+)"/g)].map((m) => m[1])
    const unique = [...new Set(ids)]
    check('每个可点名对象都带 id 且可见', () => {
      assert.ok(unique.length >= 3, `只找到 ${unique.length} 个 id`)
      for (const id of unique) assert.match(items.innerHTML, new RegExp(`class="id">${id}<`))
    })

    check('页面列出了判定词表', () => assert.ok(elements.get('words').innerHTML.includes('class="w"')))
    check('汇总区是可选中复制的 textarea', () => assert.match(html, /<textarea[^>]*id="out"[^>]*readonly/))

    check('点击判定后汇总文本会变', () => {
      const firstId = unique[0]
      items.handlers.click({
        target: { dataset: { id: firstId, w: '同意' }, classList: { contains: (n) => n === 'vbtn' } },
      })
      const out = elements.get('out').value
      assert.ok(out.includes(firstId), `汇总里没有 ${firstId}`)
      assert.match(out, /同意/)
    })

    check('组句格式是一行一条 <id> <判定词>', () => {
      const line = elements.get('out').value.split('\n').filter(Boolean)[0]
      assert.match(line, /^[A-Za-z0-9_.:-]+ \S+/)
    })

    check('同步时把文本 postMessage 给了父页面', () => {
      const last = messages[messages.length - 1]
      assert.ok(last !== undefined, '一次 postMessage 都没发')
      assert.equal(last.type, 'dsh-showme-feedback')
    })
  }

  // ── gallery 形态 ────────────────────────────────────────────────────
  if (elements.has('skin')) {
    check('通过一个 <link id="skin"> 加载预设', () =>
      assert.match(html, /<link id="skin"[^>]*href="presets\/[\w-]+\.css"/),
    )
    check('四套预设都出现在页面里', () => {
      for (const slug of ['soft', 'swiss', 'brutal', 'blueprint']) {
        assert.ok(html.includes(`presets/${slug}.css`), `页面里没有 ${slug}`)
      }
    })
    check('切换皮肤只改 href（标记不动）', () => assert.ok(/setAttribute\('href'/.test(script)))
    check('提供键盘 1–4 快捷键', () => assert.ok(/keydown/.test(script)))

    const picker = elements.get('picker')
    check('渲染出四张可选卡片', () => assert.equal(picker.children.length, 4))

    check('选中后组句符合 skill 的一行一条格式', () => {
      picker.handlers.click({ target: { getAttribute: (n) => (n === 'data-default' ? 'brutal' : null) } })
      assert.match(elements.get('out').value, /^preset-brutal 用这个：/)
    })

    check('选择同样 postMessage 给父页面', () => {
      const last = messages[messages.length - 1]
      assert.ok(last !== undefined, '一次 postMessage 都没发')
      assert.equal(last.type, 'dsh-showme-feedback')
      assert.match(last.text, /^preset-brutal /)
    })
  }

  check('引用真实产物用的是相对路径', () => {
    const srcs = [...html.matchAll(/<img[^>]*src="([^"]+)"/g)].map((m) => m[1])
    for (const src of srcs) assert.ok(!/^(?:[a-z]+:|\/)/i.test(src), `图片用了绝对地址：${src}`)
  })
}

console.log(`\n全部通过：${checks} 项断言。\n`)
