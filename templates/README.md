# showme-report 模板 · 数据字段表

> **你要读的是这一份，不是 `core.js`。**
>
> `core.js` 是渲染与交互的**实现**（20KB）：控件放哪、怎么组句、什么时候发消息。
> 这些你都不需要懂，也不该改——三个模板共用它一份。
> **这一份才是你要写的接口。**
>
> 实测：一个会话为了搞清"它认哪些块类型"，把整个 `core.js` 读了一遍（≈5–6 千 token），
> 而答案就在下面这张表里。

---

## 一页 = 外壳 + 内核 + 数据

```
templates/<shape>.html   外壳（cp 出来改名）
templates/core.js        内核：别读、别改
<名字>.html              cp 出来的页面
<名字>.data.js           ← **你唯一要写的东西**
```

```bash
cp .dsh/showme/templates/review.html .dsh/showme/<名字>.html
# 然后 write .dsh/showme/<名字>.data.js
# 最后 show_html({ path: '.dsh/showme/<名字>.html' })
```

**数据文件名必须和页面同名**：`foo.html` ↔ `foo.data.js`。
内核按页面自己的文件名去推导数据文件名；不同名会显示"没找到数据文件"。

| 骨架 | 形状 | 什么时候用 |
|---|---|---|
| `review.html` | 逐项表态 | 一排条目，每条一个判定 + 备注。带图不带图都行。**最常用** |
| `pick.html` | 候选挑选 | 单选 / 多选。封面选哪张、这几张素材留哪几个 |
| `report.html` | 图文汇报 | 有图 / 表 / 时间线、不需要逐项表态；每小节一个轻回执 |

---

## 数据文件的样子

```js
window.SHOWME = {
  skin: 'soft',
  kicker: '栏目',
  title: '大标题',
  lead: '导语',
  meta: ['标签', '标签'],
  sections: [ /* … */ ],
}
```

### 共用字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `skin` | string | `soft`（默认）/ `swiss` / `brutal` / `blueprint`。**换皮肤就改这一行** |
| `shape` | string | 一般不用写——外壳已经声明了（`window.SHOWME_SHAPE`） |
| `kicker` | string | 标题上方的小栏目名 |
| `title` | string | 大标题（必填，也用作浏览器标签页标题） |
| `lead` | string | 导语，一到两句 |
| `meta` | string[] | 报头下方那一排小字 |
| `verdicts` | string[] | 可选：覆盖该形状的默认判动词 |

### 每个可点名的东西都要有 `id`

`id` 就是**用户点名用的手柄**（`hero-v3`、`cover-a`、`seg-02`）：
短、唯一、可粘贴、无空格。它会显示在卡片上，并出现在回执的每一行里。
**同页内不许重名。**

---

## `review` 形状 —— 逐项表态

```js
window.SHOWME = {
  skin: 'swiss',
  kicker: '设计评审',
  title: '三个变体，挑一个',
  lead: '看看要不要改',
  meta: ['14 镜', '1920×1080'],
  sections: [
    {
      heading: '候选',
      sub: '可选的副标题',
      intro: '这一段可选的引导语',
      two: true,                       // true = 两栏，默认自适应多栏
      items: [
        { id: 'hero-v3', title: '第 3 版', desc: '蓝底、大标题',
          image: 'stills/hero-v3.png', caption: '图 1 · 展开态' },
        { id: 'hero-v4', title: '第 4 版', desc: '灰底' },
      ],
      blocks: [ /* 可选，见下面的块类型表 */ ],
    },
  ],
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `sections[].heading` | string | 小节标题 |
| `sections[].sub` | string | 副标题（小字） |
| `sections[].intro` | string | 小节引导语 |
| `sections[].two` | boolean | 两栏 |
| `sections[].items[]` | object[] | **每个条目一张卡片，判定控件就在卡片里** |
| `items[].id` | string | 必填、唯一 |
| `items[].title` | string | 条目标题 |
| `items[].desc` | string | 一句话说明 |
| `items[].image` | string | **相对页面**的图片路径 |
| `items[].caption` | string | 图注 |

默认判动词：`同意` / `要改` / `不要`。

---

## `pick` 形状 —— 从候选里挑

```js
window.SHOWME = {
  skin: 'brutal',
  title: '封面用哪一张',
  mode: 'single',              // 'single'（默认）或 'multi'
  question: '选一张当封面',     // 显示在候选上方
  heading: '候选',
  candidates: [
    { id: 'cover-a', title: 'A', image: 'stills/a.png' },
    { id: 'cover-b', title: 'B', image: 'stills/b.png' },
  ],
}
```

`single` 模式下选新的会自动取消旧的。默认判动词：`选这个`。

---

## `report` 形状 —— 图文汇报

```js
window.SHOWME = {
  title: '架构说明',
  sections: [
    {
      heading: '数据流',
      id: 'flow',                  // 可选：回执用的 id（默认由 heading 生成）
      sectionReceipt: true,        // 默认 true；false 则这一节不带回执
      intro: '可选的引导语',
      blocks: [ /* 见下表 */ ],
    },
  ],
}
```

### 块类型全表（`core.js` 认识的就是这 10 种）

| `type` | 字段 | 例子 |
|---|---|---|
| `text` | `text` | `{ type: 'text', text: '一段说明' }` |
| `image` | `src`、`caption?`、`alt?` | `{ type: 'image', src: 'stills/a.png', caption: '图 1' }` |
| `table` | `head`、`rows` | `{ type: 'table', head: ['列 A','列 B'], rows: [['1','2']] }` |
| `callout` | `text`、`label?`、`tone?` | `{ type: 'callout', label: '结论', text: '所以这样', tone: 'good' }` |
| `timeline` | `items[]{title?,text}` | `{ type: 'timeline', items: [{ title: '第一步', text: '做什么' }] }` |
| `kv` | `pairs`（`[键, 值]` 数组） | `{ type: 'kv', pairs: [['预设目录','.dsh/showme/presets/']] }` |
| `code` | `text` | `{ type: 'code', text: 'const a = 1' }` |
| `chips` | `items`（字符串或 `{text,accent?}`） | `{ type: 'chips', items: ['甲', { text: '乙', accent: true }] }` |
| `stat` | `num`、`text?` | `{ type: 'stat', num: '42', text: '个片段' }` |
| `rule` | — | `{ type: 'rule' }` |

`tone` 可取 `good` / `warn` / `bad`（不写就是中性）。

`report` 每小节**默认自带一个轻回执**（判动词 `没意见` / `要改`）。
如果你确实不需要任何回执（纯图示），写 `sectionReceipt: false`。

---

## 常见错误

| 症状 | 原因 |
|---|---|
| 页面显示「没找到数据文件」 | 数据文件名和页面不同名。`foo.html` 必须配 `foo.data.js` |
| 图片裂了 | 用了绝对路径或 URL。必须**相对于页面**（`stills/a.png`） |
| 页面空白、没有内容 | 数据里没写 `window.SHOWME`，或 JSON 语法错了 |
| 想改样式 | **别改 `core.js`**：三个模板共用它，改一处所有页面一起变。换 `skin` 就行 |
| 不知道自己该写什么 | 就是这一份。不要读 `core.js`——它是实现，不是接口 |

## 骨架不合适的场合

模板就是"条目式"的：一排可点名、可表态的东西。
**架构图、时序图、长文分析、并排对比**不是这个形状——那就自己写页面
（skill §3 的回执契约、§4 的通道、§5 的沙箱约束照样适用）。
模板是**可选骨架**，不是形式强制。
