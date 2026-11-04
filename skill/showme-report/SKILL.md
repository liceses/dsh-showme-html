---
name: showme-report
description: 用一页 HTML 向用户汇报、并把用户的指认与表态快速收回来。当你要交付"需要看而不是读"的成果（方案对比、设计评审、多变体挑选、证据并排、进度台账），或者用户需要在一堆产物里点名、表态、挑选时使用。本 skill 只规定功能与交换格式，不规定版式、配色与页面结构——形式由你决定。
whenToUse: 你准备用 HTML 页面代替长篇 Markdown 向用户汇报；或用户明确要求"用网页给我看""做成一个页面""我要挑/我要表态"；或这一轮产出了多个候选（方案/变体/截图/组件）需要用户指认；或要往页面里放流程图/时序图。
---

# showme-report — 用一页 HTML 汇报，并让反馈回来

> **这一页是索引。** 硬契约在下面几节；字段、版式、mermaid、沙箱细节在 `references/`，**按需再读**。
> 模型写前端的能力够用 —— 这里只钉"不钉就会错"的部分。

## 四件事，缺一不可

1. **每个可点名的东西有一个稳定 id**，并且**在页面上显示出来**（`hero-v3`、`f2`）；
2. **表态控件就在那个东西旁边**（同一块 / 同一行），不集中到底部（§3.2）；
3. **每次判定变化都 `postMessage` 给卡片**（§4.1），不是只在"发送"按钮里发一次；
4. **汇总文本一行一条**：`<id> <判定词>[：备注]`（§3.1），并放进可选中复制的 `<textarea>`。

套模板（`review` / `pick` / `report` / `doc`）通常只要写一个数据文件，交互与回执全在核心里 —— §1。

## 0. 管什么

- **管**：交换格式（id / 判定 / 备注 / 回执）、通道、沙箱边界。
- **不管**：版式、配色、结构、信息组织 —— 按内容自己判断，别把 skill 当设计规范。
- 模板是**可选骨架**，不是形式强制。

## 1. 交付流程

### 1.1 套模板（大多数页面不用自己写）

宿主在**第一次 `show_html`** 时才把骨架落到 `.dsh/showme/templates/`；**不要 `cp`，直接 `write`**。

**先选形状（三行决定，别跳过）**：要用户**逐项表态** → `review`；要**从候选里挑** → `pick`；
**只是把一件事讲清楚**（不需要在条目上打勾）→ `doc`；有**多个小节、每节各一块内容** → `report`。
选错的典型症状：四份独立发现被压成一排"每条一大段"的条目 —— 那不是 `review`，是 `doc` 或 `report`。

| 骨架 | 形状 | 什么时候用 |
|---|---|---|
| `review.html` | 逐项表态 | 一排可点名的东西，每条一个判定 + 备注。**最常用** |
| `pick.html` | 候选挑选 | 单选 / 多选 |
| `report.html` | 图文汇报 | 图 / 表 / 时间线，每小节一个轻回执 |
| `doc.html` | 纯文档 | 没有可表态的东西：无判定、无回执，只有「复制全文」 |

三步：**写外壳**（`window.SHOWME_SHAPE` 改形状）→ **写同名数据** `<名字>.data.js`（`window.SHOWME = { … }`）
→ **`show_html`**。外壳就这几行：

```html
<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>—</title>
<link id="skin" rel="stylesheet" href="presets/soft.css"></head><body>
<div class="page"><div id="sm-masthead"></div><div id="sm-content"></div><div id="sm-receipt"></div></div>
<script>window.SHOWME_SHAPE = 'review'</script>
<script src="templates/core.js"></script></body></html>
```

**字段与块类型**：`.dsh/showme/templates/README.md` 是唯一真源（约 14KB）；速查版见 `references/templates.md`。
**不要读 `core.js`**——那是实现。

- 文本字段只认四种行内写法：`**粗**`、`` `代码` ``、`[文字](https://…)`、换行；
  表格 / 列表 / 引用 / 标题 / 围栏代码**必须用块类型**（写成 markdown 会让 `show_html` 失败）。
- `image` 必须真实存在，否则 `show_html` 直接失败（缺图 = 裂图，不让它上屏）。
- **`image` 决定形态**：带了就成卡，不带就走行 —— 别给每条都塞图。

### 1.2 要画图就写 mermaid

`<pre class="mermaid">graph TD; A-->B</pre>` 会渲染成 SVG；**写错会让这次 `show_html` 直接失败**，
渲染完每张图的 PNG 落在 `.dsh/showme/mermaid/<页面短哈希>/<页面名>.<序号>.png`，可直接 `read_image`。
四种写法、样式禁忌、失败形态 → `references/mermaid.md`。

## 2. 样式：四套预设（可选菜单 + 一个默认）

| slug | 名字 | 什么时候用 |
|---|---|---|
| `soft` | 柔和现代 | **默认**。通用汇报、长时间阅读 |
| `swiss` | 瑞士国际主义 | 编辑部长文、结论多的分析 |
| `brutal` | 新野兽派 | 设计评审、多变体挑选 |
| `blueprint` | 蓝图 / 工程图 | 架构、数据流、时序 |

一行引用：`<link rel="stylesheet" href="presets/soft.css">`。**不要检查 `presets/` 现在是否存在**
（第一次 `show_html` 才落地），也不要"留了 link 又内联一套视觉"。

### 2.1 用预设就必须按共用语义标记写

换皮肤一个字都不改标记，代价是标记要用约定名（`.page` / `.section` / `.card` / `.cols` / `.stat` /
`.table` / `.callout` / `.timeline` / `.kv` / `.code` / `.chips` / `.rule`）→ `references/layout.md`。

### 2.2 三条硬规则

1. 不要改预设 CSS 里的颜色；要别的感觉就换一套，或问用户。
2. 不要混两套预设。
3. 引了预设，页面自己的 CSS **只写布局与结构**，别再定义一套颜色/字体/字号。

### 2.3 什么时候**不**该用预设

评审 / 复刻某个具体系统的视觉语言时，用那个系统的官方令牌才是对的：**不写 `<link href="presets/…">`**，
自包含地内联 CSS，并在回复里说明为什么（有理由的偏离允许，悬空的引用不行）。

### 2.4 想用 StyleKit 目录里的其他风格

`GET https://www.stylekit.top/api/styles/{slug}/md` 拉规格，但当约束清单用、自己翻成原生 CSS
（`colors` / `doList` / `dontList` 可用，`globalCss` 与 JSX 别照抄）→ `references/layout.md`。

## 3. 回执：默认每一页都要有

| # | 必须做到 |
|---|---|
| F1 | 每个可点名对象有**稳定、唯一、可粘贴**的 id（短 ASCII、无空格），并且**在页面上可见** |
| F2 | 每个 id 都能表态（判定词自定）+ 能写备注 |
| F3 | 能产出**一行一条**的汇总文本（§3.1） |
| F4 | 汇总文本放在可选中复制的 `<textarea>` 里，不依赖 localStorage / clipboard / 服务器 |
| F5 | 引用真实产物一律用**相对路径** |

**哪怕只是汇报，也问一句：用户看完想说什么？** 把那个答案做成可点选的东西。

### 3.1 统一交换格式（一行一条）

```
f1 OK
f2 要改：数字太小，10000 不要写 1 万
```

`<id> <判定词>[：备注]`；判定词由页面自定，但**页面必须把本页的判定词列出来**。

```js
// 解析：一行一条 → [{id, verdict, note}]
function parseLines(text) {
  return text.split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean)
    .map(function (line) {
      var m = line.match(/^([A-Za-z0-9_.:-]+)\s+(\S+)\s*[:：]?\s*(.*)$/);
      return m ? { id: m[1], verdict: m[2], note: m[3].trim() } : null;
    }).filter(Boolean);
}
// 生成：一条 → 一行
function toLine(item) {
  return item.id + ' ' + item.verdict + (item.note ? '：' + item.note : '');
}
```

> 用脚本拼页面时，正则与换行字面量一律**写双反斜杠**（`\\r?\\n`）——单反斜杠会被模板字符串吃掉。

### 3.2 表态控件必须和它指的对象**在一起**

- ✅ 同一块里：对象 + id + 判定控件 + 备注（模板默认「一条一行」，带图才成卡）；
- ❌ 选项集中在顶部、预览在别处；❌ 底部一张大表单；❌ 左右两地来回跳；
- ❌ 每一条都是一模一样的卡（布局重复、没有焦点）。

判据一句：**做一次判定时，对象和控件是否同屏可见。** 图太高就 `max-height: 60vh` 或把控件贴到图旁。

### 3.3 什么时候可以不带回执

只有一种：这页确实没有任何可表态的东西（纯图示、一张截图、定稿正文）。那就用 `doc` 形状，
并在回复里说明理由。**"没有可表态的"和"我懒得做"是两回事。**

## 4. 反馈怎么回到你手里

### 4.1 默认通道 · `postMessage` 交给卡片

```js
// 在**每一次判定变化**时都发（不是只在一个"发送"按钮里发）
if (window.parent !== window) {
  window.parent.postMessage({ type: 'dsh-showme-feedback', text: 汇总文本 }, '*');
}
```

卡片只认 `type: 'dsh-showme-feedback'` 且 `text` 非空；**每次变化都发**，回执条才是活的。
页面里的选择与备注由模板自动存草稿（刷新/切会话不丢），**你不用实现**。

### 4.2 兜底通道 · 页面里可选中复制的文本

它是唯一永远可用的路径（页面被单独用浏览器打开时也能用），但**是兜底不是主交互**：
不要做「全选下面文本」这种按钮，不要把复制当主要动作，也不要只在"发送"按钮里发一次。

### 4.3 可选通道 · 直接落盘

页面 `POST /api/showme/feedback`（`{ sessionId, text, page }`）→ 追加到 `.dsh/showme/inbox.jsonl`。
不实现也完全没问题。sessionId 从地址里取：`location.pathname` 按 `/` 切开后，
**`raw` 后面那一段**。别写死下标 —— 路由是 `/api/showme/raw/<sessionId>/<page>`，
写死 `[3]` 拿到的是字面量 `raw`（这个错 0.3.4 修过）。

## 5. 沙箱硬约束（**已经实测撞过的墙**）

页面在 `sandbox` 且**没有** `allow-same-origin` 的 iframe 里 = **不透明源**：

1. **`localStorage` 会抛异常**（不是返回 null）。要存就 `try/catch` + 内存兜底 + 可导出文本。
2. **`navigator.clipboard` 大概率被拒**。汇总文本必须在能选中复制的 `<textarea>` 里。
3. **表单提交、`alert/confirm`、下载在卡片里被拦**（真实浏览器里放开）——让用户走「浏览器打开」。

卡片是安全模式；工具栏的「浏览器打开」才是功能全开的那条路（仍碰不到 DSH 应用本身）。
更多坑（blob 预览、宿主差异）→ `references/sandbox.md`。

## 6. 什么时候别用这个

先自检：**这一页有没有 Markdown 给不了的东西？**（图 / 并排对比 / 真表格 / 可点选的对象）

一条都没有 → **直接用 Markdown 回答**。把散文排版得好看不构成理由。
正文超过两三千字、上面四条一条都没有时，几乎一定是错的选择。其余 → `references/checklist.md`。

## 7. 计划页（plan 模式下）

计划涉及方案对比 / 多变体 / 证据并排 / 多步取舍时，**除了**给 `exit_plan_mode` 的 markdown，
还写一页展示页，并在 markdown **第一段**写一行：

```
展示页：.dsh/showme/plan-xxx.html
```

- markdown 仍是**权威存档**（`exit_plan_mode` 的参数不变），页面是它的展开；
- 那一行是给人和插件用的锚点，插件据此在右栏打开页面（**不是** markdown 链接）；
- 用户可能在 **插件页 → dsh-showme-html → 展示页 · 设置** 里把 `planPage` 设成 `off` / `offer` / `require`：`off` 时只写 markdown。

---

## 按需读的 references

| 文件 | 什么时候读 |
|---|---|
| `references/templates.md` | 查字段、块类型、条目形态、报错含义 |
| `references/layout.md` | 自己写页面但用预设皮肤（共用标记全表、StyleKit 翻译） |
| `references/mermaid.md` | 画流程图 / 时序图，或图报错了 |
| `references/sandbox.md` | 页面要用存储 / 剪贴板 / 表单，或结果和预期不一样 |
| `references/checklist.md` | 交付前自检、常见错误对照 |
