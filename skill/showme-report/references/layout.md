# references/layout — 用预设皮肤时该写的标记

> 前提：这一页**引了** `presets/<slug>.css`。引了就必须按下面的共用标记写——四套皮肤
> 认的是类名，不是你的视觉意图。不引预设时这一份不适用（见主文件的 §2.3）。

## 页面的骨架（四套皮肤都认同一套类名）

下面是**完整骨架** —— 类名就是词汇表本身，不用数个数。`test/presets.test.mjs`
逐个盯着其中 22 个语义选择器（`.page` `.masthead` `.kicker` `.lead` `.meta`
`.section` `.card` `.cols` `.stat` `.num` `.chips` `.chip` `.btn` `.table`
`.callout` `.evidence` `.timeline` `.kv` `.code` `.muted` `.mark` `.rule`），
少一个四套皮肤就有一套会坏。

```html
<div class="page">
  <header class="masthead">
    <span class="kicker">栏目名</span>
    <h1>标题</h1>
    <p class="lead">导语</p>
    <div class="meta"><span>标签</span><span>标签</span></div>
  </header>

  <section class="section">
    <h2>小节标题 <small>副标题</small></h2>
    <p>正文。用 <span class="mark">高亮</span> 和 <span class="muted">弱化</span>。</p>
    <div class="rule"></div>

    <div class="card">
      <h3>卡片标题</h3>
      <p>卡片正文。</p>
    </div>

    <div class="cols two">          <!-- 不带 two 就是自适应多栏 -->
      <div class="card">…</div>
      <div class="card">…</div>
    </div>

    <table class="table">
      <thead><tr><th>列</th><th>列</th></tr></thead>
      <tbody><tr><td>值</td><td class="num">42</td></tr></tbody>
    </table>

    <div class="callout">
      <span class="label">结论</span>
      正文
    </div>
    <!-- callout 的变体：class="callout good" / "callout warn" / "callout bad" -->

    <ol class="timeline">
      <li><b>第一步</b>做什么</li>
    </ol>

    <dl class="kv">
      <dt>键</dt><dd>值</dd>
    </dl>

    <div class="chips"><span class="chip">甲</span><span class="chip accent">乙</span></div>

    <div class="stat"><span class="num">42</span><span>个片段</span></div>

    <div class="code"><code>const a = 1</code></div>

    <figure class="evidence">
      <img src="stills/a.png" alt="…">
      <figcaption>图 1 · 说明</figcaption>
    </figure>

    <button class="btn">次要动作</button>
    <button class="btn primary">主要动作</button>
  </section>
</div>
```

**这就是全部词汇表。** 四个 slug 的差别只在同一个 `.page` 下这套类名的外观，
所以换皮肤时你一个字都不用改。

## 三条硬规则（写页面时最容易破的）

1. **不要改预设里的颜色**（也别在 `:root` 里重定义它们的变量）。要别的感觉就换一套 slug。
2. **不要混两套预设**（两个 `<link>` 叠着 = 后者吃掉前者，且没人知道最终是什么样）。
3. 引了预设，页面自己的 `<style>` **只写布局与结构**（栅格、间距、`max-height`、响应式），
   别定义颜色 / 字体 / 字号 —— 那会盖住皮肤，且四套皮肤下都会错。

## 什么时候该换个 slug

| 内容气质 | slug |
|---|---|
| 通用汇报、要读一会儿 | `soft` |
| 结论多、像编辑部长文 | `swiss` |
| 设计评审、要冲击力 | `brutal` |
| 架构、数据流、工程图 | `blueprint` |

判据不是"哪个好看"，是"这份内容读者是谁、要读多久"。

## StyleKit 目录里的其它风格怎么用

`GET https://www.stylekit.top/api/styles/{slug}/md` 能拉到一份风格规格，别直接照抄：

- **可用**：`colors`（取值做 CSS 变量）、`doList` / `dontList`（当约束清单读）、
  版式意图描述（决定栅格与节奏）。
- **别照抄**：`globalCss`（Tailwind 重置，会打架）、任何 JSX / React 代码、
  任何 `@import` 或 CDN（页面在沙箱里、且必须自包含）。
- **翻成原生 CSS**：Tailwind 类名 → 你要的几条规则，只写这一页真正用到的。
- 翻了以后**仍然要满足上面的三条件**（不引预设就不要写 `<link href="presets/…">`，
  并且在回复里说一句为什么不用预设）。

## 自检

- [ ] 页面里只有**一个** `<link href="presets/…css">`（或一个都没有）
- [ ] 自己的 `<style>` 里没有颜色 / 字号 / 字体家族
- [ ] 每个对象都有可见 id，控件就在它旁边（主文件 §3.2）
- [ ] 窄屏（≈520px）下不横向滚动
