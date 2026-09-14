# dsh-showme-html

> 给 agent 一个**快捷入口**：把工作区里写好的 HTML 页直接展示在对话里，并让用户在页面上产生的反馈**快速回到 agent 手里**。

DSH（DeepSeek Harness）插件。它不规定页面长什么样——长什么样由 agent 和 `showme-report` skill 决定；
但附了**四套预设样式**，让 AI 写出来的东西不至于一副"默认长相"。

仓库：<https://github.com/liceses/dsh-showme-html>

---

## 它提供什么

| 东西 | 说明 |
|---|---|
| **工具 `show_html`** | agent 调一下，就等于"把这一页给用户看"。参数只有 `path` / `title` / `note`；**不收 HTML 正文**（省 token、可留档、可用你自己的编辑器改）。 |
| **镜像读路由** | `GET /api/showme/raw/<sessionId>/<工作区相对路径>`。按工作区目录结构镜像分发，于是页面里的**相对引用天然可用**（`<img src="stills/a.png">`、同目录 css/js、下级 html 页）。同一个地址就是「在浏览器打开原文件」。 |
| **对话内卡片** | 标题 / 源文件路径 / 刷新 / **全屏** / **浏览器打开**；非可见的卡片不持有活 iframe。 |
| **反馈落盘** | `POST /api/showme/feedback` → 追加到 `<工作区>/.dsh/showme/inbox.jsonl`。 |
| **skill `showme-report`** | 教 agent 怎么写这一页：**挑皮肤**、功能点、一行一条的交换格式、沙箱坑。**不含版式要求。** |
| **四套预设样式** | 同一份内容上的四张皮：`soft` 柔和现代（默认）/ `swiss` 瑞士国际主义 / `brutal` 新野兽派 / `blueprint` 蓝图。见下。 |

## 预设样式

放在插件包的 `styles/`，**宿主在你第一次展示页面时自动落到工作区**
`<工作区>/.dsh/showme/presets/`（**create-only**：已存在的文件不覆盖，所以你可以自己改）。

页面引用就是一行：

```html
<link rel="stylesheet" href="presets/soft.css">
```

| slug | 名字 | 什么时候用 |
|---|---|---|
| `soft` | 柔和现代 | **默认**。通用汇报、进展同步、长时间阅读 |
| `swiss` | 瑞士国际主义 | 编辑部长文、结论多的分析、要权威感 |
| `brutal` | 新野兽派 | 设计评审、多变体挑选、强指认感 |
| `blueprint` | 蓝图 / 工程图 | 架构、数据流、时序、依赖关系 |

**四套吃同一套语义标记**（`.page` `.masthead` `.kicker` `.lead` `.meta` `.section`
`.card` `.cols` `.stat`/`.num` `.chips`/`.chip` `.btn` `.table` `.callout` `.evidence`
`.timeline` `.kv` `.code` `.muted` `.mark` `.rule`），所以**换皮肤不用改标记**——
这也是「可切换预览器」能成立的前提。

- `styles/index.json` 是清单，里面那行 `default` 就是默认皮肤，改一行即可。
- 每套预设都写死了自己的字号刻度、间距节奏、明暗策略（`soft`/`swiss` 跟随系统明暗，
  `brutal` 固定亮色，`blueprint` 固定暗色）。
- **自包含**：无 `@import`、无外链字体、无 `url()`、无 CDN。断网也完整。
- 想用 [StyleKit](https://www.stylekit.top/zh/styles) 目录里的其他风格？它的 tokens/components 是
  Tailwind + React，直接用不了；把它当**约束清单**（`colors` / `doList` / `dontList` / `philosophy`）
  自己翻译成原生 CSS。`skill/showme-report/SKILL.md` §2.3 写了具体路径。

## 装

```powershell
# 从 GitHub 直接装
dsh plugin --profile web add "github:liceses/dsh-showme-html"

# 或者从本地源码目录装（开发时用这个，改完源码好追踪）
dsh plugin --profile web add "link:<本目录绝对路径>"

# 两种方式都需要重启 dsh web 才生效（宿主半区在启动时装载）
```

`dsh plugin add` 会自动把本包同时写进 profile 的 `dependencies` 与 `dsh.profile.bundles`，
并并入 `dsh.bundle.patch` 声明的插件行（id `showme-html`）。

> `github:` 装法不需要构建步骤——`lib/` 就是成品，仓库里没有编译产物之外的东西。

卸载：

```powershell
dsh plugin --profile web remove dsh-showme-html
```

## 用

```js
// agent 侧：先写页面，再展示
write({ path: '.dsh/showme/review.html', content: '<!doctype html>…' })
show_html({ path: '.dsh/showme/review.html', title: '设计评审', note: '挑一个变体' })
```

页面放在 `.dsh/showme/` 下（隐藏目录，不污染源码树、不进 git），
要引用的图片/组件放在它旁边。**不要写绝对 URL**——相对路径就对了。

## 安全模型（两层，刻意不同）

同一个地址，两种档位：

| | 卡片内（iframe） | 真浏览器新标签页 |
|---|---|---|
| 生效的 sandbox | iframe 的 `allow-scripts allow-popups …` **∩** 响应头 CSP | 只有响应头 CSP |
| 脚本 | ✅ | ✅ |
| 表单 / 下载 / `alert` / 弹窗 | ❌ | ✅ |
| 能碰到 DSH 应用本身 | ❌（不透明源） | ❌（CSP `sandbox` 强制不透明源） |

所以卡片是**安全模式**，工具栏的「浏览器打开」是**逃生门**：功能完整，但依然读不到应用数据。

其他围栏：

- **回环围栏**：只服务 `127.0.0.1`/`::1` 且 Host 是回环的请求（LAN 暴露的部署不服务这条路由）。
  ⚠️ **不要用 `Sec-Fetch-Site` 做判断——在这里它完全冗余，而且会咬自己两次**：
  展示页跑在 `sandbox` 的不透明源里，它加载自己的图片、嵌套页、页内 `<a href>` 跳转、
  以及自己的 `fetch`，**统统**被浏览器标成 `cross-site`，`Origin` 是字面量 `"null"`。
  真正管用的是**只收回环地址** + **Host 必须是回环** + **一个 CORS 头都不发**
  （跨站方发起了也只会拿到不透明响应，拿不走工作区文件）——所以 `Origin` 那条判断就够了：
  真实跨站请求带 `https://evil.example` → 拒；我们自己页面带 `null` → 放行。
  两次翻车现场见 `docs/方案与验收-v4.md` §六之补四。
- **工作区根 + realpath 双重校验**：`..`、编码穿越（`%2f` / `%5c`）、指向工作区外的软链接，一律 403。
- **扩展名白名单**：不在表里的一律 415。
- `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Cache-Control: no-store`。

## 已知限制

- **不缓存**：每次刷新都重读文件（故意的——页面会被反复改）。
- **不做范围请求**：大视频文件会整个读进内存再发。
- **不做文件监听**：改完文件要按卡片上的「刷新」（自动刷新属于后续里程碑）。
- **页面在卡片里能力受限**：见上表；需要 `localStorage` / 表单 / 下载时请用「浏览器打开」。
- **不支持 `file://` 链接**：浏览器禁止从 http 页面跳到 `file://`，所以「在浏览器打开」走的是上面那条 HTTP 路由。
- 单页上限 8 MiB；反馈正文上限 256 KiB。
- **`ctx.get('sessions')` / `ctx.get('sessionQuery')` 在路由所在的插件上下文里取不到**
  （Inspect 标注为 `optional`）。所以权威来源改成**工具执行时记下的「会话 → 工作区根」**，
  服务查询只作兜底；认不出来时错误信息会回报具体哪个服务缺了。

## 仓库结构

```
lib/index.js          宿主半区：show_html 工具 + 镜像读路由 + 反馈落盘 + 预设落地
lib/client.js         浏览器半区：对话卡片 + 画面内全屏 + 输入框镜像（closure-factory）
styles/*.css          四套预设样式（插件资产，宿主动态落地到工作区）
styles/index.json     预设清单：一行 default 就是默认皮肤
skill/showme-report/  产品核心：功能契约 + 交换格式 + 沙箱坑（junction 到 ~/.dsh/skills/）
examples/             示例页源码（页面冒烟测试的夹具）
test/                 离线验收：宿主 / 客户端 / 预设 / 页面 四组
docs/                 需求演进与定稿方案
```

`.dsh/` 不进仓库——那是 DSH 在本工作区里的运行痕迹（展示副本、预设落地副本、反馈信箱）。
示例页源码在 `examples/`；要在 GUI 里看，把它拷到工作区 `.dsh/showme/` 再调 `show_html`。

## 开发

```powershell
npm test                                   # 88 项离线断言（宿主 48 + 客户端 29 + 展示页 11）

# 装配是否真的生效——对着运行中的 3080 打真实请求
node test/live-probe.mjs <sessionId>
# sessionId 在 ~/.dsh/sessions/--<工作区路径转义>--/session-<uuid>/ 的目录名里
```

**零构建、零依赖**：`lib/index.js` 与 `lib/client.js` 就是成品，没有编译步骤。

- 宿主半区**不 import 任何 `@deepseek-ai/*`**。以 `link:` 安装时插件位于工作区外，
  Node 从真实路径向上找不到 profile 的 `node_modules`，外部 import 解析不了
  （同 profile 里 `dsh-text-drop` / `dsh-workspace-tree` 的宿主半区同样只用 node 内置模块）。
  因此工具定义按 `ToolDefinition` 契约手写：契约是 `{name, description, parameters}` +
  `output: {schema, render, presentationMeta?}` + `execute`，其中 `parameters` / `output.schema`
  都是**已编译好的 JSON Schema**。代价是参数校验要自己写，`execute` 里做了。
- 浏览器半区是 closure-factory 形态（`window.__ModuleLoader__.load({id, factory})`），
  平台模块（`react` 等）由加载器的模块表提供。

### 改完什么要做什么（**实测结论，没有捷径**）

| 改了 | 生效方式 |
|---|---|
| `skill/showme-report/**` | **热发现，什么都不用做** |
| `lib/index.js`（宿主半区） | **重启 `dsh web`**（改配置触发不了重载，实测三次都不行） |
| `lib/client.js`（浏览器半区） | 重启后由 client-modules 扫描；之后改它需要浏览器 **F5** |

### 写测试时的坑

桩必须照**真实契约**写。本轮就因为宿主测试的假 `sessions` 返回了 `{meta:{cwd}}`，
而真实 `Session` 只有 `header.cwd`，导致离线 46 项全绿、线上全红。
离线测试证明逻辑，`live-probe` 证明装配——两个都要。

