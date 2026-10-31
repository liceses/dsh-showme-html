# 变更记录

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
