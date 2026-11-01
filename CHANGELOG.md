# 变更记录

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
