# references/sandbox — 页面的能力边界

页面被塞进 iframe，宿主给它的响应头是：

```
Content-Security-Policy: sandbox allow-scripts allow-forms allow-modals allow-downloads allow-popups
```

**没有 `allow-same-origin`** → 页面处在**不透明源**（opaque origin）。这不是配置疏漏，
是刻意的：展示页永远不该能碰到 DSH 应用本身。

## 三条实测撞过的墙

| 能力 | 在不透明源里 | 你该怎么做 |
|---|---|---|
| `localStorage` / `sessionStorage` | **直接抛异常**（不是返回 null） | 要存就 `try/catch` + 内存兜底 + 可导出文本；**或者干脆用模板的草稿**（自动的） |
| `navigator.clipboard` | 大概率被拒（权限查询挂在 origin 上） | 汇总文本放在能选中复制的 `<textarea>` 里，复制按钮只能是加分项 |
| 表单提交、`alert/confirm`、下载 | 被拦（真实浏览器里放开） | 别依赖；需要时让用户走「浏览器打开」 |

由此推出主文件 F4 那条：**永远要有"能鼠标选中、能 Ctrl+C"的文本**。

## 同源请求为什么也不行

页面是不透明源 → `fetch('/api/...')` 是**跨域**请求，而镜像路由没给它 CORS 头。
所以：

- 数据不要 `fetch`，用 `<script src="…data.js">`（`<script>` 是 no-cors 请求，能过）；
- 页面想直接 `POST /api/showme/feedback` 多半会被浏览器拦掉 —— **别指望它**（宿主侧已经有
  卡片代投这条路，见下）。

## 三条可用通道

### 1. `postMessage` → 卡片（默认）

```js
window.parent.postMessage({ type: 'dsh-showme-feedback', text: 汇总文本 }, '*')
```

卡片同源、可信；它拿到文本后出现「填入输入框 / 复制」。**每次判定变化都发**。

### 2. 卡片代投 `/api/showme/feedback` → `inbox.jsonl`

卡片带 sessionId 转发，宿主追加到 `<工作区>/.dsh/showme/inbox.jsonl`。
页面自己不用发（也发不通）。

### 3. 草稿（模板自动做，手写页面可选）

页面 `<->` 卡片 `<->` `POST|GET /api/showme/draft`，落盘到
`<工作区>/.dsh/showme/drafts/<sha1>.json`。消息类型：

| 类型 | 方向 | 用途 |
|---|---|---|
| `dsh-showme-draft` | 页面 → 卡片 | 交一份草稿（debounce 400ms + `pagehide` 补发） |
| `dsh-showme-draft-ready` | 页面 → 卡片 | 页面已就绪，索要恢复数据（**在此之前不要写草稿**，否则空状态覆盖旧草稿） |
| `dsh-showme-draft-restore` | 卡片 → 页面 | 回灌 `{savedAt, state}` |

手写页面可以完全不管它——代价是刷新后用户要重填。

## 原生文档预览（blob iframe）这条路的差异

卡片右下角的路径按钮会走宿主原生的文档预览，它把 HTML 塞进 **blob iframe**：

- 地址是 `blob:…/<uuid>`，**没有文件名** → 模板推导出的数据文件名是一串 uuid；
- 只打包**相对的、直接的** `<script src>` 与 `<link href>`，所以相对**图片、下级页、CSS `url()`** 全失效；
- 页面里若有 `<base href>`，宿主跳过打包。

三条正常路径（卡片 / 侧栏打开 / 浏览器打开）都走 `/api/showme/raw/<sessionId>/…`，没有这些问题。
**要在 blob 宿主里也能起来**，就改成静态引入数据（把数据 `<script>` 放在 `core.js` 之前）。

## 「浏览器打开」= 能力全开，但仍碰不到 DSH

工具栏那个按钮返回的响应同样带 `sandbox`（只是不受卡片容器限制）：剪贴板、表单、
下载通常能用，脚本照跑，但它仍然是**独立文档**——不共享 DSH 的 origin、cookie、存储。

两处的能力差异不必在页面里解释（卡片底部已经写了提示）。

## 自检

- [ ] 页面在没有任何存储的情况下也完整可用
- [ ] 汇总文本在 `<textarea>` 里（不是只有一个"复制"按钮）
- [ ] 没有 `fetch` 同源接口的硬依赖
- [ ] 没有 `alert` / `confirm` / 自动下载
