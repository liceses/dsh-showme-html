# references/templates — 套模板时要查的东西

> **唯一真源是 `.dsh/showme/templates/README.md`**（宿主落地的那份，约 14KB）。
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

## 四个形状的最小数据（前三份条目式，doc 是文档式）

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
| `items[].options[]` / `preferred` | **条目内选项集**：2–4 个互斥走法 `{value, label, why}`，回执写 `id A`；`preferred` 只标倾向、不预选。有 `options` 的条目不显示页级判定词 |
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
| `matrix` | `head[]`、`rows[{label,scores}]` | 候选 × 维度打几分（`scoreMax?` 默认 5、`best?` 只许一行、`'—'` = 不适用、`summary?` 进表尾） |
| `rule` | — | 分隔线 |

> 「A 快但风险高、B 慢但稳」这种比较，**一句话说不清就上 `matrix`**：`scores` 画成刻度、`best` 标倾向。
> `head` 2–6 列、`rows` 2–8 行，行列对不上 / 分数越界 / 标两行 best 都会让 `show_html` 失败。

## 写坏了的条目长什么样

条目位（`items[]` / `candidates[]`）在模板里是**一行**：左边一句话，右边控件。
把一段话灌进去，行会被撑成整段高，控件就飘到段落中间。宿主现在会拦（见「报错 → 怎么改」），
但更重要的是写的时候就别这么写。

**判据**：`desc` 超过约 240 字、里面有空行、有列表行或表格行 —— 任一条命中就是写错了位置。

### 反例 1 · 证据塞进一句话

```js
// ✗ 一条 desc 里塞了三个行号、两处疏漏、两个方案
{ id: 'p0-3', title: '擦除约束漏了三列',
  desc: '`db/schema/30-demo.sql:39-42` 的 `ck_demos_erased` 只校验 title / description / cover_url，**漏了 guest_name**。' +
        '`122-128` 的 `ck_rev_erased_content` 校验十二列，**漏了 single_file 和 external_url**。**A**：写迁移 0014。**B**：只登记。' }

// ✓ 条目只留结论，证据进块
{ id: 'p0-3', title: '两条擦除约束各漏了列',
  desc: '写了迁移也不等于擦干净 —— 旧数据仍有残留。' }
// 同一节的 blocks 里：
{ type: 'kv', pairs: [['ck_demos_erased', '30-demo.sql:39-42 只校验 5 列，漏 guest_name'],
                      ['ck_rev_erased_content', '30-demo.sql:122-128 校验 12 列，漏 single_file / external_url']] }
```

### 反例 2 · 条目里分行分段

```js
// ✗ 空行 + 多段 = 它在冒充文档
{ id: 'p0-4', desc: '`accounts.role` 没有外键。\n\n全库只有一处 REFERENCES roles，是 role_permissions。\n\n**A**：补迁移。**B**：改文档。' }

// ✓ 一页只讲一件事时，整页换 doc 形状；要表态就一句话
{ id: 'p0-4', title: 'accounts.role 没有外键', desc: '写进 role 的值可以根本不在 roles 表里。' }
```

### 反例 3 · 用条目位排一个对照表

```js
// ✗ 竖线表格塞进 desc
{ id: 'p0-5', desc: '| 方案 | 成本 |\n|---|---|\n| A | 高 |\n| B | 低 |' }

// ✓ 用 table 块
{ type: 'table', head: ['方案', '成本'], rows: [['A', '高'], ['B', '低']] }
```

### 一段话 → 该搬到哪个块

| 这一段是 | 搬到 |
|---|---|
| 为什么这么说 / 背景 / 结论的语气 | `callout`（`tone: 'good' \| 'warn' \| 'bad'`） |
| 路径、字段名、数字、版本、配置项 | `kv`（`pairs[[k, v]]`） |
| 多列对照、逐项数值 | `table`（`head` + `rows`） |
| 一段不需要表态的叙述 | `text`，或整页换 `doc` 形状 |
| 步骤 | `timeline` |
| 原始代码 / 日志 | `code` |

**如果这份数据确实要长文**（例如整段搬来的报告）：给数据加 `plain: true`，宿主的散文检查会跳过。
但那是逃生阀，不是默认写法 —— 页面上依然会很难看。

## 报错 → 怎么改

| 报错里出现 | 意思 | 改法 |
|---|---|---|
| `没找到数据文件：xxx.data.js` | 数据文件没和页面同名（或那一页在原生文档预览的 blob 里） | 改名成同名；或改静态引入（见 `sandbox.md`） |
| `数据文件里写了 markdown 结构` | 表格/列表/引用/标题/围栏被写进了文本字段 | 换成对应块类型；确实要原样显示就 `plain: true` |
| `把长段落写进了条目位` | 条目 `desc` 太长（>240 字）或自带空行/列表/表格 | 一句话留在条目里，其余搬到 `callout` / `kv` / `table` / `text`（见上一节） |
| `缺图：…` | `image` / `src` 指向的本地文件不存在 | 先真的把图放进去，或删掉这个字段 |
| `mermaid … Parse error` | 图写错了 | 见 `mermaid.md` |
| 页面空白 | 数据里没有 `window.SHOWME`，或 JS 语法错 | 先 `node --check` 那个 `.data.js` |

## 别做的事

- **别 `cp` 模板**（新工作区里 `templates/` 还不存在，第一次 `show_html` 才落地）——直接 `write` 外壳。
- **别改 `core.js` / `presets/*.css`**：四套骨架共用，改一处全变。
- **别读 `core.js` 找字段**：那是实现，答案在上面那份 README 里。
