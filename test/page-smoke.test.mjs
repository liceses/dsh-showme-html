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
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const stylesDir = join(here, '..', 'styles')
// 示例页源码放在 examples/（进仓库）；运行时的展示副本在 .dsh/showme/（不进仓库，
// 否则克隆下来 npm test 会因为缺文件而挂）。
//
// 两个目录都扫：examples/ 里的优先（那是进仓库的版本），
// 但**新写还没同步进 examples/ 的页面也会被覆盖到**，不用记得手动拷。
const examplesDir = join(here, '..', 'examples')
const runtimeDir = join(here, '..', '.dsh', 'showme')

/** 收集 .html 页面，按文件名去重、examples/ 优先。 */
async function collectPages() {
  const byName = new Map()
  const scan = async (dir, prefix) => {
    for (const name of await readdir(dir).catch(() => [])) {
      if (name.endsWith('.html')) byName.set(name, join(dir, name))
    }
    return prefix
  }
  await scan(runtimeDir)
  await scan(examplesDir) // 后扫覆盖先扫 → examples/ 优先
  return [...byName.values()].sort()
}

const targets = process.argv.length > 2 ? process.argv.slice(2) : await collectPages()

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

    // skill 的契约是「页面必须把本页用到的判定词列出来」——不是某个固定 class 名。
    // 所以从条目上解析出实际用到的词，再要求词表里都有。
    const verdicts = [...new Set([...items.innerHTML.matchAll(/data-w="([^"]+)"/g)].map((m) => m[1]))]
    check('页面把用到的判定词都列了出来（skill 契约）', () => {
      assert.ok(verdicts.length >= 2, `只解析到 ${verdicts.length} 个判定词`)
      const words = elements.get('words').innerHTML
      for (const word of verdicts) assert.ok(words.includes(word), `词表里没有「${word}」`)
    })
    check('汇总区是可选中复制的 textarea', () => assert.match(html, /<textarea[^>]*id="out"[^>]*readonly/))

    check('点击判定后汇总文本会变', () => {
      const firstId = unique[0]
      // 假目标同时提供 dataset / getAttribute / className：
      // 页面用哪种写法读属性都行，测试不该规定实现。
      items.handlers.click({
        target: {
          dataset: { id: firstId, w: '同意' },
          className: 'vbtn',
          getAttribute: (name) => (name === 'data-id' ? firstId : name === 'data-w' ? '同意' : null),
          classList: { contains: (n) => n === 'vbtn' },
        },
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
    // 契约：页面能切到的每个预设都必须真实存在。**不规定**页面是把 href 写死在
    // HTML 里还是在 JS 里拼——两种写法都从 HTML 与脚本里一起抓。
    check('能切到的预设都真实存在于 styles/', () => {
      const refs = new Set()
      for (const m of html.matchAll(/presets\/([\w-]+)\.css/g)) refs.add(m[1])
      for (const m of script.matchAll(/slug:\s*'([\w-]+)'/g)) refs.add(m[1])
      for (const m of html.matchAll(/data-skin="([\w-]+)"/g)) refs.add(m[1])
      assert.ok(refs.size >= 2, `只找到 ${refs.size} 个预设引用`)
      for (const slug of refs) {
        assert.ok(existsSync(join(stylesDir, `${slug}.css`)), `presets/${slug}.css 不存在`)
      }
    })
    // 以上是所有"带皮肤切换"的页面都该满足的；下面几条只有"预览器"形态才有
    // （promo 那种页面只把皮肤当演示开关，没有可选的卡片列表）。
    if (elements.has('picker')) {
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
  }

  check('引用真实产物用的是相对路径', () => {
    const srcs = [...html.matchAll(/<img[^>]*src="([^"]+)"/g)].map((m) => m[1])
    for (const src of srcs) assert.ok(!/^(?:[a-z]+:|\/)/i.test(src), `图片用了绝对地址：${src}`)
  })
}

console.log(`\n全部通过：${checks} 项断言。\n`)
