# 变更记录

## 0.3.6 — 2026-11-03

**plan 模式展示页：把两套打开器合成一条链路（`docs/plan-mode-showme-flow.md` 里 11 条缺陷的 P0/P1 部分）。**

用户报「plan 模式的 showme page 的行为逻辑有问题」，复核后确认全中（双开、页面晚到不开、按钮显示「路径不存在」、
窗口窄也照开、改一版计划又开一个 tab）。这一版改的是**打开页这件事的骨架**，不是补丁：

- **唯一入口 `openShowmePageOnce(sessionId, workspacePath, { title, manual, retrying })`**：卡片自动开、评审自动开、
  人点按钮都走它。返回值说清楚为什么没开：`opened` / `window` / `already` / `narrow` / `missing` /
  `no-session` / `failed` / `invalid`。
- **一套去重键**：`pageOpenKey()` = 会话 + **归一化**路径（`normalizeWorkspacePath()` 处理反斜杠、`./`、前导斜杠、
  重复斜杠、包裹的引号/反引号，并拒绝 `D:\…` 这类绝对路径）。`autoOpen.opened` 与 `planOpened` 两个集合删掉，
  换成按这个键记录的 `pageOpenStatus`。同一页在两条路径之间只会被自动开一次；「要求修改」发新 `requestKey`
  也不会再开第二个 tab。
- **先成功、后记账**：以前 `planOpened.add(key)` 在打开之前，页面晚落盘（HEAD 404）就永久不开。
  现在是成功之后才 `markPageOpened()`；失败（404）进 `schedulePageRetry()`，1s 一次、最多 10 次，
  页面出现就开。
- **并发也只开一个**：自动路径在 `HEAD` 之前先写 `pending`，第二个并发调用直接拿 `already`。
- **两条路径共用一张门**：`pageOpenGate({ status, manual, width, retrying })` 是纯函数 —— 宽度闸
  （`PAGE_OPEN_MIN_WIDTH = 1200`）以前只在卡片路径上有，现在评审路径也过；`manual: true`（人点的按钮）跳过
  去重与宽度。
- **评审路径补上会话 id 兜底**：`PlanPageAction` 改用 `resolveSessionId(null, props.sessionId)`（与卡片同一套
  三级兜底：props → source → `inputRefs`），以前空 id 会让按钮显示「路径不存在」。
- **标记行解析放宽**：`parsePlanPagePath()` 认 `- 展示页：` / `1. 展示页：` / 反引号或引号包裹 / 行尾说明
  （`（这一版的对比）`、` <workspace-relative path>`），**只取第一个命中**（正文里举例的路径不算交付物）。
  宿主那段指引也从「写在第一段」改成「单独一行（最好在第一段）」，与"只认第一条"对齐。
- 顺带把 `autoOpen` 里的绝对地址换算、`sessionIdFromUrl` 兜底键删了 —— 键已经不含地址。

断言 431 → **437**（客户端 94 → 100：门函数、键归一化、标记解析三组纯函数用例 + 双开/晚到两条行为用例）。

## 0.3.5 — 2026-11-03

**仓库内新增一个 agent 预设：Showme Often —— 选中它的会话，回答默认是一页。**

- 位置 `preset/showme-often/`（`package.json` + `cordis.patch.yml` + `README.md`）：独立 bundle、**不进 npm 包**。
- 只改一处：`persona` 前缀写死「默认做页」的规则（多条目 / 对比 / 表格 / 流程 / 截图 / 待评审 / 可点名 → 一律做页；只有一两句话且无可指的东西才用纯文字；拿不准就做页），并明确压过 `show_html` 工具描述里那句「不要用于普通回答」。
- 插件清单逐字照抄 DSH 自带的 `standard` 预设（升级 DSH 时重抄、只保留 persona 段）；**不重复挂本插件** —— 它是宿主级工具，再挂会出现两个同名 `show_html`。
- 安装：`plugin_manager install_bundle`。已在本机 desktop profile 上装好并 applied，`Config.listConfigs` 的预设从 4 条变 5 条；名册与新会话选择器里应出现「Showme Often」。
- 插件代码未改：`lib/` 一行不动，离线断言仍是 431 项。

## 0.3.4 — 2026-11-02

**一次通读评审后的八条修复：四条代码/测试、四条文档，外加补 tag。**

### 缺陷与加固
- **mermaid 产物改为按页分目录**：`.dsh/showme/mermaid/<页面短哈希>/<页面名>.<序号>.png`（同目录还有 `<页面名>.json`、失败时 `<页面名>.errors.txt`）。0.3.3 及以前只用 basename，`a/review.html` 与 `b/review.html` 会抢同一份 `review.1.png` / `review.json`。工具预告路径与回执落盘路径必须算出同一个结果，所以两边共用新的 `normalizePagePath()`（先把反斜杠、`./`、`..` 归一）。
- **回执要求页面真实存在**：`POST /api/showme/mermaid` 对不存在的 page 回 404。以前只挡越界，随手编一个路径也能在 `.dsh/showme/mermaid/` 下催出文件。
- **回执转发核对来源**：浏览器半区的顶层转发点只接受来自本插件 iframe（地址是 `/api/showme/raw/<sessionId>/<page>`）且正文里的 `sessionId` / `page` 与地址一致的回执（`acceptMermaidReceipt`）。以前文档里任何 frame 的 `postMessage` 都会被转发去写文件。
- **doctor 补查 `doc.html`**：`test/doctor.mjs` 的模板资产清单从"内核 + 三个外壳"改成四份外壳（0.3.0 就发了 `doc`，体检一直没看它）。

### 文档
- `skill/showme-report/SKILL.md` §4.3 的 sessionId 取法改成"`location.pathname` 按 `/` 切开后、`raw` 后面那一段"，不再写死 `split('/')[3]` —— 那个下标拿到的是字面量 `raw`（路由是 `/api/showme/raw/<sessionId>/<page>`）。
- `docs/0.1.7-native-preview-compat-plan.md` 更正 P0 门禁描述：门禁禁的是 `documentPreviews.register` 与 `dsh-resource://`，**`sidebarRightTabs.register` 不在门禁里**（P1 的侧栏打开正要用它）；"不抢后缀"由"页类型不许有 `patterns` / `canOpen`"那条行为门禁守。
- `skill/showme-report/references/layout.md` 的"十个类"改成"同一套类名"，并写明 `test/presets.test.mjs` 逐个盯着 22 个语义选择器。
- `docs/方案与验收-v4.md` 的"现在 417"改为 420；"75 / 88" 两处标明是**当时**的数字。

### 仓库卫生
- 补打 `v0.2.6` – `v0.3.3` 七个 tag（每个 commit 的 `package.json` 版本都逐个核对过）；本次发 `v0.3.4`。

### 验证
- `npm test` **431 项全绿**（清单 7 / 宿主 **153（+7）** / mermaid 35 / 客户端 **94（+4）** / 预设 38 / 模板 67 / 页面 37）。
- 新增断言：同名页面各落各的目录、两份 JSON 的 `page` 不串、`./` 归一后落同一目录、不存在页面 404 且不催出文件、工具预告路径 == 回执真正落盘的路径；回执来源核对四条 + 顶层监听只转发被承认的那一条。
- `npm run doctor` 六段全绿（工作区落地副本已用 `npm run assets:refresh` 同步）。

## 0.3.3 — 2026-11-02

**设置从 DSH 的「设置」弹窗搬进插件自己的页面（插件 → dsh-showme-html → 展示页 · 设置）。**

### 为什么搬
`设置 → 展示页` 那一栏是 0.3.0 拿 `settings.section` 挂的，位置对，但归属不对：
它是这个插件的开关，却长在 DSH 全局设置里。宿主对插件页留了扩展点，那里才是它的家。

### 宿主契约（在 asar 的插件开发文档里核实，不是猜的）
插件页声明了三个详情页列表槽：`plugins.detail.actions`（页头控件）、`plugins.detail.badge`（标题旁标签）、
`plugins.detail.section`（页面正文之下的区块）。每个条目以**页面的 `subject`** 渲染：
`{kind:'bundle',pkg}` / `{kind:'row',pkg,row}` / `{kind:'item',id}`；**对无话可说的 subject 返回 null**，
区块外观自绘，页面按 `order` 排序。

### 改动（只动浏览器半区）
- 删掉 `ctx.slots.inject('settings.section', …)`（原生设置弹窗里那一栏**整块消失**）。
- 新增 `ShowmeSettingsSection({subject})`：`subject.kind !== 'bundle'` 或 `subject.pkg.name !== 'dsh-showme-html'` → `null`（别人的插件页不受影响）；否则渲染区块外壳（标题「展示页 · 设置」+ 用户级偏好落点说明）+ 原来的三件控件。
- `ShowmeSettings` 变成纯「控件组」：标题、说明、关闭按钮都交出去。
- 注册改为 `{ name:'plugins.detail.section', id:'dsh-showme-html-settings', order:40 }`。
- 新增 `PACKAGE_NAME` 常量（与 `subject.pkg.name` 逐字比对）与区块外壳样式（只用 `--dsw-alias-*`）。
- 行为不变：仍是用户级 `<DSH_HOME>/showme/prefs.json`，仍走 `GET|POST /api/showme/prefs`（白名单 / 原子写 / 30s 缓存）。

### 验证
离线：`npm test` **420 项全绿**（清单 7 / 宿主 146 / mermaid 35 / 客户端 **90（+3）** / 预设 38 / 模板 67 / 页面 37）。
新增三条：只认自己那条组合包（行页 / 官方插件页 / 别人的包全返回 `null`）；自己的包渲染出 `<section>` + 标题 + 复用控件组；`settings.section` **不再注册**（防回潮）。

真机（隔离实例 3320，带 token；为防额度面板每秒轮询干扰自动化，先屏蔽 `/api/opencode-go/usage`）：
- 插件 → 已安装插件 → `dsh-showme-html`（显示 `v0.3.3`、运行中）→ 详情页**底部**出现「展示页 · 设置」区块：说明 + 2 个 checkbox + 1 个 select，`.dsh-showme-pluginSection` 计数 1。
- 把「计划页」从 `offer` 改成 `off`：页面无错误，`GET /api/showme/prefs` 与 `~/.dsh/showme/prefs.json` 都变成 `off`；重进详情页仍显示 `off`（读路径也通）。
- 点开另一个插件 `dsh-status-rotator`：标题是那个插件，`.dsh-showme-pluginSection` 计数 **0**，页面里搜不到「展示页 · 设置」——subject 过滤在真机上成立。
- 测完已恢复：偏好文件原本不存在，已删除；实例与 relay 已停，临时日志已清。

## 0.3.2 — 2026-11-02

**文档一致性巡检 + 计划页真机验收，外加一处「提示无条件注入」的修复。**

### 文档漂移（逐处，全部实测）
- **骨架计数**：`README.md`（目录、标题、能力表、结构清单、"内核只写一份"那句）、`templates/README.md`（开头、"想画图"一节、常见错误表）、`references/templates.md` 一共 10 处还写着"三份骨架 / 三个形状"——`doc` 已经随包发布，统一改成**四份**，并区分"前三份条目式 / `doc` 文档式"。
- **体积声明**（四份文件里重复的同一个事实）：`templates/README.md` 实际 **14,475 字节**却写 "4KB"（README:354、SKILL.md:52、references/templates.md:3）；`templates/core.js` 实际 **40,903 字节**却写 "20KB"（README:356、templates/README.md:5）。全部改成"约 14KB / 约 40KB"。
- **`doc` 形状没有数据示例**：`templates/README.md` 只在骨架表里一行，补一节形状说明 + 可直接抄的最小数据（并写明它是文档式、不渲染 `items`）。
- **`tools/README.md`** 说"三个脚本"，实际五个（`asar-lib` / `asar-peek` / `asar-scan` / `refresh-assets` / `vendor-mermaid`）：改成表 + 两组用法。
- **历史文档**：`docs/方案与验收-v4.md` 加"⚠️ 历史文档（0.1.0 时代）"头并注明当时的 75/88 项断言；`docs/0.1.7-native-preview-compat-plan.md` 状态行补"范围止于 0.1.7 共存"+ §1 客户端座位表补 0.2.4 之后的第四个座位与另外两个槽位。
- **断言数**：`docs/方案与验收-v4.md` banner 里的"现在 413"改为 417；`README.md` 的 `npm test` 行同步 417（宿主 146）。

### 计划页真机验收（0.3.0 那条链路第一次真的跑通）
环境：隔离实例 `RELAY_FORWARDER_PORT=18768 dsh web --port 3317 --no-open`，带启动 token 进入；为了让结论确定，先把偏好临时设为 `planPage: require` / `planPageOpenOnReview: true` / `autoOpenSidebar: false`（**测完已恢复**：`~/.dsh/showme/prefs.json` 原本不存在，已删除）。

跑的是 `/plan …`（用命令进入计划模式），一个回合内拿到：
- `command/run {name:"plan"}` → 计划模式激活；
- `tool/call show_html {"path":".dsh/showme/plan-doc-consistency.html"}` 且校验通过（页面 499 B、数据 4.4 KB 落盘）；
- `tool/call exit_plan_mode`，其 markdown **第二行就是** `展示页：.dsh/showme/plan-doc-consistency.html`；
- DOM 实测：评审面板里出现 `.dsh-showme-planOpen`（文案「打开展示页」）；**右栏自动开出 tab「展示页」**，其 iframe `src=/api/showme/raw/session-e995d0c9-…/.dsh/showme/plan-doc-consistency.html` 已渲染出页面标题；同一回合的 Chat 行卡片（`[data-chat-flow-kind="showme-page"]`，1 个 iframe）也在。
- 未单独点验：手动再点一次「打开展示页」是否幂等（自动打开走的是同一个 `openShowmePage()`，已覆盖）。

顺带：那一次回合自己扫出了本节的 9 处漂移 —— 计划页不只是装饰，它把"要改哪些文档"变成了可核对的一页。

### 修复：计划页提示不再无条件注入
`showme:plan-page` 之前对**每个**请求都注入（只判断 `planPage !== 'off'`），普通回合里白背约 120 token，而且开头写着 "Plan mode:"。
现在 `text` 回调会取可选的 `planMode` 服务并调 `loggedActive(session)`，**只有激活时**才给文本；
拿不到服务、没有该方法、或读状态抛错时**照旧注入**（fail-open —— 宁可多一段提示，也不能让计划页在宿主换版本后悄悄失效）。

### 验证
`npm test` **417 项全绿**：清单 7 / 宿主 **146（+4）** / mermaid 35 / 客户端 87 / 预设 38 / 模板 67 / 页面 37。
新增 4 条：未激活不注入 / 激活注入且含「展示页：」/ 缺服务与抛错时 fail-open / 无 agent 上下文为空串。
`npm run assets:refresh` 后 `npm run doctor` 通过（`templates/` 落地副本一致）。

## 0.3.1 — 2026-11-02

**skill 拆成"索引 + 按需读"：526 行 → 215 行索引 + 五份 references。**

### 为什么改
旧 `SKILL.md` 526 行、一次读完才动手，但其中大半是"这一轮可能根本用不到"的东西
（四套皮肤的版式标记、mermaid 的四种写法、沙箱里的每个坑）。模型按需加载的意义就在"按需"，
一进门就塞满反而把真正要钉的硬契约稀释了。

### 结构
| 文件 | 内容 |
|---|---|
| `SKILL.md` | 索引：四件事、交付流程、四套皮肤、回执 F1–F5 与交换格式、通道、沙箱三条、计划页锚点 |
| `references/templates.md` | 字段速查、块类型表、报错 → 怎么改 |
| `references/layout.md` | 四套皮肤共用的语义标记全表、StyleKit 规格怎么翻成原生 CSS |
| `references/mermaid.md` | 四种等价写法、预检是硬失败、PNG 在哪、样式禁忌 |
| `references/sandbox.md` | 不透明源的三堵墙、三条通道、blob 预览宿主差异 |
| `references/checklist.md` | 交付前六问、常见错误对照 |

**章节编号一个都没动**（§2.3 / §2.4 / §3 / §3.1–§3.3 / §4 / §4.1–§4.3 / §5 仍被
`README.md`、`templates/README.md`、`templates/core.js`、`lib/index.js` 引用）。新增 §7 计划页。

### 修掉的一处旧错
`templates/core.js` 两处渲染失败提示写着"对照 skill §5 的字段表" —— 字段表从来不在 §5（那是沙箱）。
改成指向 `templates/README.md`。

### 新守卫（`test/route.test.mjs` 的 [skill] 段，+2）
1. `SKILL.md` 正文 ≤230 行、≤16KB，且 `references/` 五份存在、各 ≥800 字节、都被索引指到；
2. **静态扫**（`lib/`、`templates/`、`styles/`、两份 README）里出现的每一个 `skill §N[.M]`，
   `SKILL.md` 里必须有对应标题 —— 以后谁再动编号，测试会当场红。

`npm test` **413 项全绿**：清单 7 / 宿主 **142（+2）** / mermaid 35 / 客户端 87 / 预设 38 / 模板 67 / 页面 37。

## 0.3.0 — 2026-11-02

**渲染可观测、缺图硬失败、纯文档形状，以及"设置页"这块地基。**

### 渲染回执（render-report）
- 页面 `render()` 成功后 `postMessage` 一条 `dsh-showme-rendered { ok, ids, buttons }`；失败路径（`fail()`）发 `ok:false, failed:true`。
- 卡片头部据此挂徽标：正常显示「N 项 · M 按钮」，失败显示红色「渲染失败」。
  过去卡片看不到 iframe 内部（不透明源），白屏只能等用户说 —— 现在它自己会报。
- 说明：本轮只上**卡片徽标**；`rendered.jsonl` 落盘留到下一轮（没有读者的日志先不做）。

### 缺图硬失败（image-hard-fail）
- `show_html` 预检新增 `findMissingImages()`：模板数据里 `image:` / `src:` 指向的**本地**文件不存在 → 与 mermaid 同格式抛错，点名文件。
- 外链与绝对路径放过（那不是模板能保证的）。裂图这个"半失败"状态没有了。

### 纯文档形状（doc-shape）
- `templates/doc.html` + `core.js` 的 `renderDoc()`：**没有判定控件、没有回执**，只有 masthead + sections + 一个「复制全文」。
- 长说明、机制讲解、结论汇总用它，别再往 `review` 里硬塞空控件。

### 设置页 + 用户级偏好
- 客户端注册 `settings.section` 一页「展示页」（设置 → 展示页）；**用户级**偏好存 `<DSH_HOME>/showme/prefs.json`（不是工作区级）。
- 新路由 `GET|POST /api/showme/prefs`：字段白名单、非法值不顶掉已有设置、原子写、30s 缓存。
- 三项：`autoOpenSidebar` / `planPage` / `planPageOpenOnReview`。

### 自动开右侧栏 + 计划页（首版）
- `show_html` 之后按偏好自动在右栏打开：每轮只开最后一张（1.2s 防抖）、每页只开一次、手动关闭后不再抢、窗口 <1200px 不开。
- 计划页：插件注册 `showme:plan-page` 系统提示段（`planPage` 三档，`off` 时为空），并在 `conversation.plan-review.actions` 里注册「打开展示页」——
  解析 markdown 里的 `展示页：<路径>`，**打开前 HEAD 验存在**，不存在就给一句人话，不开空白 tab。
- 明确不做：fork `exit_plan_mode` / 评审面板 —— 计划仍是 markdown（可 diff、可审计），页面是展开。

### 验证
- `npm test` **411 项全绿**：清单 7 / 宿主 **140（+7）** / mermaid 35 / 客户端 **87（+8）** / 预设 38 / 模板 **67（+5）** / 页面 37。
- 新增 20 条护栏：渲染回执（成功 / 失败）、doc 页无控件与无回执、prefs 的读写/落盘/非法值/405、缺图硬失败与放行、偏好 GET/POST 地址、页面 HEAD 校验、计划页标记解析、按钮有无。

## 0.2.8 — 2026-11-02

**文本字段里的 markdown 不再露原文；但结构仍然只有"块类型"一种写法。**

起因：AI 常在 showme 页面的文本字段里写 markdown（`**粗体**`、`| a | b |`、`- 列表`），模板只做转义，于是用户看到带星号和竖线的源码。第一版方案是"解析一个 markdown 子集"，复盘后否掉了——那会让**同一件事有两种写法**（md 表格 vs `table` 块），页面风格必然长出两套。最终取舍：

### 行内：只补块类型表达不了的三样
`templates/core.js` 新增 `inlineMd()`（**先 `esc()` 再替换**，顺序不能反）：

| 写法 | 渲染 | 拒绝条件 |
|---|---|---|
| `**粗**` | `<strong>` | 未成对 / 内部含 `*` / 首尾是空白 |
| `` `代码` `` | `<code>` | 未成对 / 跨行 |
| `[文字](url)` | `<a target="_blank" rel="noopener noreferrer">` | scheme 不是 `http(s)` / `#` / `./` `../`（`javascript:` 之类原样显示） |
| 换行 | `<br>` | — |

应用位置：`text`、`callout.text`、`timeline[].text`、`table` 单元格、`kv` 的值、`chips`、`stat.text`、图注、`item.desc`、`lead`、`sections[].intro`。
**不应用**：`id`（必须逐字可复制）、小节标题、`code` 块（原样是特性）、`fail()` 的提示。

### 结构：不解析，改成展示前失败
`lib/index.js` 新增 `findStructuralMarkdown()`：只对**模板页**（同目录有 `<页面名>.data.js`，或页面里引了本地 `*.data.js`）生效，
**静态扫描**数据文件里的字符串字面量（**不 eval 工作区里的 JS**，这条是安全底线），识别表格 / 列表 / 围栏代码 / 标题 / 引用五种结构；
命中就让 `show_html` **直接失败**，错误里逐条写明行号与该用的块类型（格式与 mermaid 预检一致）。
逃生阀：数据里出现 `plain: true` → 这一页跳过结构检查（用于"就是要显示这段 markdown"的页面）。

### 为什么不是"全量支持 markdown"
- 两份结构语法 → 模型每次二选一，同一套页面里混着长；
- 子集必然有边界（图片、嵌套列表、删除线），不支持的还是露原文；
- 内核要多一个 mini-parser（+120 行、要审转义）；宿主还要多一套 lint 规则 → 三份知识会漂。
现在只有一处真源：`templates/README.md` 的「文本字段能写什么」；SKILL 只写一句并指过去。

### 验证
- `npm test` **391 项全绿**：清单 7 / 宿主 **133（+5）** / mermaid 35 / 客户端 79 / 预设 38 / 模板 **62（+9）** / 页面 37。
- 新增 14 条护栏：四类行内渲染、误伤对照组（`3 * 2`、`a | b`、`5 > 3`）、`**<b>x</b>**` 变成转义文本、`javascript:` 不生成 `a`、`plain: true` 保原文、表格单元格也走行内；宿主侧 md 表格 → 失败并点名 `table` 块、带 `plain: true` 放行、手写页不误报。
- 真机：重新展示原理页（`.dsh/showme/draft-explainer.html`），`**…**` 变粗体。

## 0.2.7 — 2026-11-02

**刷新 / 切会话不再丢你填的东西。** 起因：README 里那句「不缓存：每次刷新都重读文件」，
用起来变成了「切会话或误刷新，页面里选的判定和写了一半的备注全没了」——大量反馈内容丢失的代价太高。

### 根因
不是缓存策略的错：`/raw/` 的 `Cache-Control: no-store` 只管**文件内容**要不要重读。
真正的丢数据点是——展示页跑在 `sandbox` **不透明源**里（`HTML_CSP` 与 iframe 属性都这么要求），
`localStorage` / `sessionStorage` / `cookie` 一律 `SecurityError`，页内状态只在 JS 内存里；
切会话 / 刷新会让 iframe 重新加载文档，状态随之清空。

### 改了什么
- **草稿通道**（沿用 mermaid 回执那条已验证的链路：页面只"算"，同源卡片负责"送"）：
  - 页面每次变化 `postMessage` → 卡片 **debounce 400ms** 落盘；`pagehide` / 切后台时立即补发。
  - 页面加载完发 `dsh-showme-draft-ready` → 卡片读回草稿 → `postMessage` 灌回页面。
- **宿主新路由** `GET|POST /api/showme/draft`：写在 `<工作区>/.dsh/showme/drafts/<sha1>.json`
  （会话 + 页面路径当 key）。原子写（`.tmp` + `rename`）；单份 64 KiB；`30 天` / `200 份` 上限，写时顺手清理；
  未知会话 404、页面路径越界 403、超限 413、非 GET/POST 405；**不新增 CORS 头**（同源卡片调用）。
- **恢复有据可查**：套用后页面顶部一条横幅「已恢复 10-31 23:12 的表态（3 条）· 清空」，
  不静默复活旧选择；id 对不上时写明「其中 N 条这页已没有，已忽略」；点「清空」页内清掉并删草稿。
- **顺手修好一条既有缺陷**：文档承诺的反馈通道 ②（页面 `POST /api/showme/feedback`）在卡片里
  其实是坏的（同样是跨域），现在由卡片在收到反馈消息时补发一次 `/feedback`；浏览器标签页里打开时
  没有卡片，页面自投照旧 —— 两边不会重复写。
- 文档：README 新增 [刷新 / 切会话不丢](#draft) 一节、TOC 一行、核心能力一行；把「不缓存」
  那句话改成「只管文件内容」；SKILL §4.1 与 `templates/README.md` 各补一句「草稿是自带的，你不用实现」。

### 验证
- `npm test` **377 项全绿**：清单 7 / 宿主 **128（+12）** / mermaid 35 / 客户端 **79（+7）** / 预设 38 / 模板 **53（+7）** / 页面 37。
- 新增护栏 26 条：草稿写入/读回/清空/未知会话/越界/超限/405/过期清理；页面侧 ready 握手、恢复套用、
  对不上的 id 忽略、debounce 发出的载荷、清空消息、浏览器直开不发；卡片侧身份解析、载荷清洗、
  POST/GET 地址、两个宿主都挂桥、反馈补发。
- 真机：独立实例（新宿主路由）+ 真实卡片走一轮「选判定 → 写备注 → 点刷新 → 横幅与选中态回来」。

## 0.2.6 — 2026-11-01

**模板重做：按内容定密度 + 横屏。** 起因是两句反馈：「纯文字的时候重复的卡片布局会很多」、
「模版有点难看了」，并要求按设计心理学来定，而不是只换配色。

### 改了什么（每条对应一条依据）

- **按内容定密度**（相似性原则 / 孤立效应）：条目不再一人一张卡。纯文字的条目合成**一块面板、一行一条**；
  **只有带 `image` 的条目才单独成卡**。混排时卡片组在前、两组各自保序。整页终于有焦点，不再是一排一模一样的卡。
- **小节标题去掉下边框**（信噪比）：soft 皮肤原来是 `.section > h2 { border-bottom }` + `margin-top: 68px`，
  截图里那对「平行黑线」就是它。改成 `44px` 间距 + 无边框，小节之间靠留白分。
- **横屏用满宽度**（米勒 / 分组）：量宽 soft `900 → 1120`、swiss `1060 → 1180`、blueprint/brutal `1020 → 1120`；
  `≥900px` 报头走两栏（标题在左、元信息在右）；文字行的判定控件固定 `296px` 右列成一列；
  `≤760px` 行折一列、分段控件铺满一行。
- **控件**（希克 / 菲茨）：判定改成胶囊**分段控件**（`role="group"` + `aria-label`，按钮高 36px）；
  补 `:focus-visible` 焦点环（以前只有备注输入改边框，键盘用户看不见按钮焦点）；
  行里的备注改成**虚线 + 静音**（可选项不该抢判定按钮的注意力）；卡片最大 `640px`、图 `max-height: 60vh`。
- **完成感**（目标梯度 / 蔡格尼克）：回执区新增进度「已表态 n / m」；已表态的条目 id 追加 `✓`、描述降权。
- **report 小节回执**：从「每节一张卡」改成**一行回执条**（id 在左、判定 + 备注在右并排），不再占一整块面板的高度。

### 可见变化（升级要知道）

- **没有 `image` 的条目从「卡」变「行」**。数据一个字都不用改，渲染形态变了。
- `sections[].two` 现在只影响带图卡片那一组；纯文字行永远是整行。

### 验证

- `npm test` **351 项全绿**：清单 7 / 宿主 116 / mermaid 35 / 客户端 72 / 预设 38 / **模板 46（+13）** / 页面 37。
- 新增 13 条护栏：纯文字不许成卡、带图必须成卡、混排保序、分段控件包裹与组名、`sm-note`/`sm-btn` 契约仍在、
  soft 皮肤无 `border-bottom`、`:focus-visible` 存在、窄屏铺满规则存在、完成降权存在、横屏两栏存在、进度元素存在。
- 真机（本地静态服务 + 真实浏览器）：`.dsh/showme/tpl-{review,pick,report}.html` 三种形状 × 1120 / 560 两宽度实拍；
  点一次判定 → id 出现 `✓`、回执 `已表态 1 / 6`、`#sm-out` 里出现 `stats-panel 要改`，全部照预期。

## 0.2.5 — 2026-11-01

**在独立实例上真跑了一轮 `show_html`，一次验出三个 bug，全修。**

0.2.4 把卡片搬成独立 Chat 行之后，只在离线测试里过 —— 真机上第一个回合就露馅了：
卡片在，但**身体是白的**，控制台/接口还报 `expected /raw/<sessionId>/<workspace-relative path>`。

### 修

- **卡片身体白屏（懒挂载永不触发）**。`IntersectionObserver` 在 chat 的流容器
  （`overflow: clip` + `container-type: inline-size`）里首次回调就是 `isIntersecting: false`，
  之后不再触发 —— 页面永远停在"滚动到这里时载入页面"。改成**几何判断 + 退避轮询**
  （250ms → ×1.6 → 上限 3s），scroll/resize 立即复检，进视口就停表。
  离屏历史卡片仍不持有活 iframe。
- **`expected /raw/<sessionId>/<workspace-relative path>`**（两层）：
  ① `ShowmePageNode` 只转交了 `{source, openFile}`，**把槽位标准 props 里的 `sessionId` 丢了**；
  ② `rawUrl('')` 会硬拼出 `/api/showme/raw//<path>`。现在显式转交 + 三级兜底
  （槽位 props → `meta.url` → `conversation.input.left` 记下的当前会话），
  `rawUrl` 遇空 id 直接返回空串。
- 地址为空时卡片显示「拿不到这一页的地址（会话还没就绪）。刷新一下聊天页再试。」，
  不再挂一个坏 iframe 让用户对着白块猜。

### 实测（独立实例，真模型回合）

```
tool/call   name=show_html  args={"path":".dsh/showme/mermaid-demo.html","title":"折叠验证"}
tool/result meta={"bytes":2107,"url":"/api/showme/raw/session-…/.dsh/showme/mermaid-demo.html"}
DOM： [data-chat-flow-kind="showme-page"] 存在（不在过程组里）
      iframe 1 个，.dsh-showme-placeholder 0 个
```

轮次结束后工具调用收起，卡片里的页面照常渲染。

- 离线断言 **338 项全绿**（清单 7 / 宿主 116 / mermaid 35 / **客户端 72** / 预设 38 / 模板 33 / 页面 37）。

## 0.2.4 — 2026-11-01

**页面卡片不再被「工作步骤」折叠吃掉 —— 它现在是一条独立的 Chat 行。**

### 修

- DSH 新版加了「工作步骤展示」：完成的轮次会把**整个过程组**收起来（简洁 / 标准 / 详细三档都收，
  只有「完全展开」不收）。卡片原来长在工具行内部（`tool.call.toolview`），工具行属于过程组，
  于是整页卡片被一起折掉 —— 用户得展开「工作步骤」→ 再展开某一组才找得到页面。
- 根因不是 CSS，是 chat 的分组规则：`TurnGroups.rebuild()` 按 `isAtOrOutside(node, 'process')`
  切分，**只有 `groupTree` 深度 ≤ `process` 的节点才不进组**（`exchange:0 / input:1 / turn:2 / process:3`）。
  工具调用行不声明 `groupTree`，默认就落在 `process` 上。

### 加

- **自家的 Chat 行**：`ctx.uiConversation.events.register()` 注册一条 `kind: 'showme-page'` 的行定义，
  渲染器挂在 `conversation.chat.node` 槽位（key = kind）。节点声明 **`groupTree: 'turn'`**
  （深度 2 ≤ 3）→ 不进过程组 → 折叠与它无关。DSH 自己的错误行（`turn-error`）用的就是同一招。
- 行数据从会话事件投影出来：`tool/call` 取参数、`tool/result` 取 `meta`（就是 `presentationMeta()`
  写的 `{ bytes, url }`）与错误态；会话 id 从地址里解（节点视图拿不到 `props.sessionId`）。
- 工具行降为**一行摘要**（标题 / 体积 / 「页面在下方」/ 侧栏打开 / 浏览器打开），不再内嵌 iframe。
- 旧宿主的兼容：`uiConversation` 是**可选注入**，服务不在时整段不执行、工具行原样内嵌整卡。

### 实测

- 离线断言 **333 项全绿**（清单 7 / 宿主 116 / mermaid 35 / **客户端 67** / 预设 38 / 模板 33 / 页面 37）。
  客户端新增 15 条：只认 `show_html`、`groupId` 归并、`groupTree === 'turn'`、`anchorSeq` 落点、
  `meta` 落地、从地址解会话 id、摘要行没有 iframe、缺 `uiConversation` 时不注册。
- `doctor` 的 `[5]` 在运行中的实例上核到新 bundle（25 个类名）。

### 已知边界

- 卡片位置跟着**调用结果**走（不是轮次末尾）：一轮里调两次 `show_html`，过程组会被切成
  `组 → 卡片 → 组 → 卡片 → 回答`。这是刻意的 —— 卡片要贴着它对应的那次调用。
- 只有 `show_html` 这么搬。其它工具（bash / read / edit …）照旧在过程组里折叠。

## 0.2.3 — 2026-11-01

**0.2.2 的补丁版：只补文档与截图，代码一行未改。**

为什么单独发一版而不是挪 `v0.2.2` 的 tag：tag 一旦推出去就不再移动，
而 0.2.2 的 tag 打在功能提交上 —— 从 tag 下载的包里 README 的两张 mermaid 图是断的。
所以按补丁版补发，功能与 0.2.2 完全一致。

### 加

- `docs/screenshots/mermaid-diagrams.png`：flowchart / sequence / state / pie 一页四图。
- `docs/screenshots/mermaid-types.png`：classDiagram / er / gitGraph / mindmap。
  两张都是**真截图**——临时实例（`dsh web --port 3312`）的镜像路由打开页面后拍的，
  原件在 `examples/mermaid-demo.html` 与 `examples/mermaid-types.html`，可复现。
- README 的 [mermaid] 一节补上这两张图与图注；仓库结构里标明哪个示例是截图原件。

### 说明

- 版本号为什么不是 `0.2.2.1`：语义化版本只有三段，`semver.valid('0.2.2.1') === null`；
  而 `0.2.2-1` 虽然合法，排序却**低于** `0.2.2`（预发布版），任何比较都会当成降级。
  "0.2.2 之后的一个补丁"在 semver 里就是 `0.2.3`。

## 0.2.2 — 2026-11-01

**页面里可以直接写 mermaid 了；而且图写错时 `show_html` 会当场失败。**

### 升级

- **重启一次 `dsh web` / 桌面实例**（宿主半区在启动时装载，改配置触发不了重载）。
  mermaid 的 5.5 MB 随包走，不下载、不改任何配置。
- 落地副本：`presets/` 不用动；`templates/README.md` 想拿到新版（多了"想画图"一节）就跑
  `npm run assets:refresh` —— create-only，旧文件会先备份成 `.bak-<时间戳>`。
- 重启后确认：`node test/doctor.mjs` 的 `[4]` 里应有
  `vendor 路由可达 …… 与磁盘一致（5494801 字节）`。

### 加

- **mermaid 支持**。页面里写 `<pre class="mermaid">graph TD; A-->B</pre>` 就会渲染成图
  （也认 `<div class="mermaid">`、`<code class="language-mermaid">`、`<pre data-mermaid>`）。
  vendored 的是 mermaid **12.2.0** 的 `dist/mermaid.min.js`（5.49 MB，普通脚本），
  由新路由 `GET /api/showme/vendor/mermaid.min.js` 发出，页面用 `<script src>` 加载 ——
  展示页是不透明源，`fetch` 会被跨域拦，只有 `<script src>` 过得去；也不走 CDN。
- **宿主侧语法预检**：`show_html` 返回**之前**，宿主把页面里每个 mermaid 块解析一遍。
  图写错 → 这次工具调用直接失败，报错里是 mermaid 自己的 `Parse error on line N: … ^` 原文。
  这就是"渲染报错 = 页面不通过"。
  实现：把 vendored 的 mermaid 喂进 `node:vm`；没有真 DOM 时 dompurify 会退化成空壳，
  流程图一解析就抛 `TypeError: Z1.addHook is not a function`，所以在**内存里**把
  `Z1=Rsr()` 换成 stub（磁盘上的文件不动，浏览器拿到的仍是原版）。
  首次加载 ~150 ms（每进程一次），每块 5–50 ms。补丁点由测试钉住：升级 mermaid 时会先红。
- **渲染回执与截图**：页面渲染完把每张图导出 PNG，`postMessage` → 浏览器半区（同源）
  `POST /api/showme/mermaid` → 落盘到 `<工作区>/.dsh/showme/mermaid/<页面名>.<序号>.png`
  （另写 `<页面名>.json`；有失败再写 `<页面名>.errors.txt`）。
  路径是**可预测**的，`show_html` 的结果里直接给出，模型渲染完 `read_image` 就能看见自己画的图。
- 卡片头部新增 mermaid 徽标：全部渲染成功是 `mermaid ✓`，运行时失败是红色 `mermaid 失败 ×N`
  （悬停看每张图的报错）。
- 纯静态页（没有内联 `<script>`）不再被页面冒烟测试判失败 —— 带图的页面常常一行 JS 都不用写。

### 为什么不用 `@mermaid-js/parser`

试过（2.0.1）：它只覆盖 architecture / gitgraph / packet / pie / radar / treemap / wardley /
cynefin / info / railroad / treeview / eventmodeling —— **没有 flowchart / sequence / class /
state / er**，而这几个恰好是最常写的。所以舍掉。

### 实测

- 离线断言 **318 项全绿**（清单 7 / 宿主 116 / mermaid 35 / 客户端 52 / 预设 38 / 模板 33 / 页面 37）。
  宿主的第 117 条是"软链接逃逸 403"——Windows 上建不出软链接时自动跳过，不是失败。
- 预检覆盖的图类型：flowchart / sequence / class / state / er / pie / gantt / mindmap 各一条好图
  全部通过；`graph TD; A-->` 这类坏图抛出带 `^` 指位的原文。

### 文档

- `vendor/README.md`：版本、sha256、为什么是单文件普通脚本、Node 侧为什么要打补丁、补丁点长什么样。
- `npm run vendor:mermaid`（`tools/vendor-mermaid.mjs`）：重新拉取并覆盖 `vendor/mermaid.min.js`。
- `SKILL.md` 新增 **§1.2**（怎么画、写错会失败、PNG 在哪、预检只管语法），TL;DR 与 `whenToUse` 各补一句。
  **没有重编号**——`templates/core.js`、`templates/README.md`、`README.md` 都在引用 §5。
- `templates/README.md` 新增"想画图：模板里没有图块，自己写页面"（含可直接抄的最小例子）。
- README 的 mermaid 一节补**两张真实截图**：`docs/screenshots/mermaid-diagrams.png`
  （flowchart / sequence / state / pie）与 `mermaid-types.png`（classDiagram / er / gitGraph / mindmap）。
  原件是 `examples/mermaid-demo.html` 与 `examples/mermaid-types.html`，
  截图就是经镜像路由打开这两个文件的样子 —— 不是拼出来的示意图。
- `README.md`：版本徽章 0.2.2、新增 [mermaid](#mermaid) 一节与目录项、已知限制补三条、仓库结构补
  `lib/mermaid-*.js` / `vendor/` / `tools/`、断言总数与分项同步。

### 已知边界

- 预检只查**语法**。运行时渲染错误（预检过了但浏览器里仍失败）拦不住已经返回的工具调用，
  这类错误显示成页面里的红框 + 卡片徽标 + `<页面名>.errors.txt`。
- JS 里动态拼出来的 mermaid 块不在预检范围内（宿主只扫静态 HTML）。
- 页面超过 2 MB 时不注入引导脚本。
- 原生文档预览（blob iframe）里没有 vendor 路由，图不会渲染 —— 用卡片 / 侧栏 / 全屏。

## 0.2.1 — 2026-11-01

**修一个只在 DSH 0.2.1-rc.5 上现形的 bug；补上"落地副本"这条盲区。**

### 修

- **镜像路由对"本进程还没加载过"的会话回 404**（rc.5 上）。
  根因：`sessionQuery.readSession()` 返回的是
  `{ session: <克隆的 header>, inheritedEventCount, events }` —— cwd 挂在 `session` 下，
  而 `readCwd()` 只认顶层 `header`。兜底链是 `sessions.get()` → `sessionQuery.readSession()`，
  前者对没加载过的会话是 miss，于是整条链断掉，诊断串是
  `sessions.get=miss sessionQuery=no-cwd`。
  现在 `readCwd()` 依次尝试 `header.cwd` / `session.cwd` / `session.header.cwd` / `meta.cwd` / `cwd`。
  回归用例：`test/route.test.mjs` 的「rc.5 的 { session: header } 形态也能解析」。
- 这个 bug **只在刚启动的进程上现形**：实例跑久了、会话被热起来之后，`sessions.get()` 会命中，
  症状自己消失（实测：同一个 3080 进程，23:48 启动，00:30 左右两个会话都 404，
  02:09 同样的请求全部 200）。所以验证必须对着**新起的实例**做，别对着跑了一天的那个。

### 加

- `npm run doctor` 第 **[6]** 节：工作区里 `.dsh/showme/templates/` 的落地副本是否与包内一致。
  落地是 create-only，插件升级或改了模板文档之后，工作区那份会悄悄停在旧版 ——
  症状不是报错，而是文档教的是已废弃的流程（这个坑踩过两次，现在有断言盯着）。
- `npm run assets:refresh`（`tools/refresh-assets.mjs`）：同步落地副本。
  覆盖前把旧文件备份成 `<文件名>.bak-<本地时间戳>`；`presets/` 默认只补缺、不覆盖内容。
- `tools/`：`asar-peek.mjs` / `asar-scan.mjs`（只读解析 `app.asar`，用来核对宿主契约）
  与 `asar-lib.mjs`。**不进 npm 包**（`files` 里没有 `tools/`）。

### 实测（DSH 0.2.1-rc.5，全局 npm 装的那份）

- `npm run doctor` 六节全绿：客户端半区 rev `ea91496cdb57`，23 个 `dsh-showme-*` 类名逐个核对通过。
- `live-probe` 五项全绿：页面 200 / 相对引用 SVG 200 / 越界 403 / 不存在 404 / 未登记类型 415。
- 404 那个 bug 的 A/B：同一份 rc.5、同一个持久化会话、**新起的实例** ——
  修前 `{"ok":false,"error":"unknown session: … (sessions.get=miss sessionQuery=no-cwd)"}`，
  修后 200 + 12 KB 页面正文。
- 离线断言 253 项全绿（清单 7 / 宿主 86 / 客户端 52 / 预设 38 / 模板 33 / 页面 37）。

### 文档

- README 版本徽章从 `0.1.0` 修正为当前版本；卡片头部图注补上「侧栏打开」（是四个按钮，不是三个）。
- README「支持的 DSH 版本」补 `0.2.1-rc.5`；开发一节的示例端口从已失效的 19387 改为 2785。
- 0.2.0 留下的那条边界（"没在 0.2.1-rc.2 上重跑 UI 人工回归"）已由用户在桌面端
  实际使用确认：对话卡片 / 全屏 / 侧栏打开 / 反馈回填都走过了。

## 0.2.0 — 2026-10-29

**兼容 DSH 0.2.x。**

- `engines.dsh` 由 `^0.1.7-rc.1` 放宽为 `^0.1.7-rc.1 || ^0.2.1-rc.1`。
  此前这条声明让插件在 DSH 0.2.1-rc.2 上被硬门禁拦下（安装与启动都会被拒），
  现在两个 DSH 版本线都声明支持。
- 在 DSH `0.2.1-rc.2` 上实测通过的证据（不是"应该能跑"）：
  - 宿主半区：`GET /api/showme/raw/<session>/<path>` 返回插件自己的 `unknown session` JSON，
    说明 `ctx.webServer.register` 那条前缀路由已挂上；
  - 浏览器半区：HMR graph 里出现 `dsh-showme-html`（`plugins/??dsh-showme-html/client.js&rev=…`），
    且该 bundle 可取回 29 KB 正文，说明 `dsh.client` 被 client-modules 正常发现。
  - 业务代码**未改一行**：`sidebarRightTabs` / `slots` / `tools` / `webServer` 四个扩展点在
    `0.2.1-rc.2` 的 `app.asar` 里都还在（逐个字符串核对过），API 形状未变。
- README 增加「支持的 DSH 版本」一段：写清这条声明是硬门禁、失败长什么样、
  以及 `dsh plugin allow-version` 这个精确版本逃生舱怎么用。

未覆盖的边界：本轮验的是「装载 + 路由可达」，没有在 0.2.1-rc.2 上重跑一遍
「对话卡片 / 全屏 / 右侧栏页类型」的人工交互回归；UI 层的自动化断言仍是
`npm test` 的 245 项离线断言（它们不依赖 DSH 版本）。

## 0.1.0

首个可用版本。

- `show_html` 工具（`path` / `title` / `note`）：把工作区里的 HTML 页直接展示在对话里。
- 镜像读路由 `/api/showme/raw/<sessionId>/<工作区相对路径>`，带工作区围栏（越界 403 / 不存在 404 / 未登记类型 415），
  页面里的相对引用天然可用。
- 三个呈现面：对话内卡片、画面内全屏（`shell.overlay`）、右侧栏页类型（`sidebarRightTabs`）。
- 反馈闭环：页面上「点名 + 表态」→ 一行回执 → 一键填回输入框 → 回到 agent 手里。
