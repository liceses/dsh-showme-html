# references/templates — 套模板时要查的东西

> **唯一真源是 `.dsh/showme/templates/README.md`**（宿主落地的那份，4KB）。
> 这份是给你的"快速翻页版"：先在这里定位，需要全文再去读那份。

## 先决定要不要套模板

| 你想做的东西 | 套模板吗 |
|---|---|
| 一排可点名、可表态的条目（方案、截图、组件、结论） | ✅ `review` |
| 从几个候选里挑一个 / 挑几个（封面、素材、路线） | ✅ `pick` |
| 有图有表有时间线，只要每小节一个轻回执 | ✅ `report` |
| 长文讲解、机制说明，**没有**要用户决定的 | ✅ `doc` |
| 架构图 / 时序图 / 流程图 | ❌ 自己写页面（模板没有图块，见 `mermaid.md`） |
| 左右强对比、并排像素差异 | ❌ 自己写页面（`.cols` + `.card` 可以凑，但常不如手写） |

## 三个形状的最小数据

```js
// review：逐项表态
window.SHOWME = { skin:'soft', title:'…', sections:[{ heading:'候选', items:[
  { id:'a', title:'A 版', desc:'一句话' },               // 纯文字 → 一行一条
  { id:'b', title:'B 版', image:'stills/b.png', caption:'图 1' }, // 带图 → 成卡
]}]}

// pick：候选挑选
window.SHOWME = { title:'…', mode:'single', question:'选一张', candidates:[
  { id:'cover-a', title:'A', image:'stills/a.png' } ]}

// report：图文汇报
window.SHOWME = { title:'…', sections:[{ heading:'数据流', id:'flow',
  blocks:[ { type:'kv', pairs:[['入口','/api/showme']] } ]}]}

// doc：纯文档（无判定、无回执，只有「复制全文」）
window.SHOWME = { title:'…', sections:[{ heading:'…', blocks:[ { type:'text', text:'…' } ]}]}
```

## 字段速查

| 字段 | 说明 |
|---|---|
| `skin` | `soft`（默认）/ `swiss` / `brutal` / `blueprint` —— 换皮肤只改这一行 |
| `title` | 必填，也用作标签页标题 |
| `kicker` / `lead` / `meta[]` | 报头上方小栏目 / 导语 / 下方一排小字 |
| `verdicts[]` | 覆盖默认判动词（review：`同意/要改/不要`，pick：`选这个`，report：`没意见/要改`） |
| `sections[].heading` / `sub` / `intro` / `two` | 小节标题 / 副标题 / 引导语 / 两栏 |
| `items[].id` | **必填、唯一、短 ASCII**，会显示在页面上，也进回执行 |
| `items[].image` | **相对页面**的路径；**给了才成卡**（这是"密度"的开关） |
| `sections[].sectionReceipt` | `report` 专用，`false` = 这一节没有轻回执 |

## 块类型（`report` / `doc` 的 `blocks`，以及 `review` 每节的 `blocks`）

| `type` | 必填 | 说明 |
|---|---|---|
| `text` | `text` | 一段说明（支持四种行内写法） |
| `image` | `src` | `caption?` / `alt?`；`src` 必须真实存在 |
| `table` | `head[]`、`rows[][]` | 真表格，不是 markdown 竖线 |
| `callout` | `text` | `label?` / `tone?`：`good` `warn` `bad` |
| `timeline` | `items[{title?,text}]` | 步骤 |
| `kv` | `pairs[[k,v]]` | 键值对，适合参数 / 路径 / 结论 |
| `code` | `text` | 代码块（**不参与行内 markdown**） |
| `chips` | `items[]` | 字符串或 `{text, accent?}` |
| `stat` | `num` | `text?`；一排数字 |
| `rule` | — | 分隔线 |

## 报错 → 怎么改

| 报错里出现 | 意思 | 改法 |
|---|---|---|
| `没找到数据文件：xxx.data.js` | 数据文件没和页面同名（或那一页在原生文档预览的 blob 里） | 改名成同名；或改静态引入（见 `sandbox.md`） |
| `数据文件里写了 markdown 结构` | 表格/列表/引用/标题/围栏被写进了文本字段 | 换成对应块类型；确实要原样显示就 `plain: true` |
| `缺图：…` | `image` / `src` 指向的本地文件不存在 | 先真的把图放进去，或删掉这个字段 |
| `mermaid … Parse error` | 图写错了 | 见 `mermaid.md` |
| 页面空白 | 数据里没有 `window.SHOWME`，或 JS 语法错 | 先 `node --check` 那个 `.data.js` |

## 别做的事

- **别 `cp` 模板**（新工作区里 `templates/` 还不存在，第一次 `show_html` 才落地）——直接 `write` 外壳。
- **别改 `core.js` / `presets/*.css`**：四套骨架共用，改一处全变。
- **别读 `core.js` 找字段**：那是实现，答案在上面那份 README 里。
