# 变更记录

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
