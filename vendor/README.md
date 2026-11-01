# vendor/

第三方文件，原样放进仓库，不参与构建。

## mermaid.min.js

| | |
|---|---|
| 版本 | **12.2.0** |
| 文件 | `dist/mermaid.min.js`（esbuild 单文件 IIFE，末尾 `globalThis["mermaid"] = …`） |
| 字节数 | 5,494,801 |
| sha256 | `a8a6a6f805b074a8261a2825c86f99c8054acb3b35f50bb7e24a4f9f2c3c3b9f` |
| 许可 | MIT |
| 来源 | `npm pack mermaid@12.2.0` |

刷新：`npm run vendor:mermaid`（默认拉 12.2.0；`node tools/vendor-mermaid.mjs --version X.Y.Z` 拉指定版本）。

### 为什么是这一个文件

- **不用 ESM 分块版**：`dist/mermaid.esm.min.mjs` 入口只有 30 KB，但依赖 **208 个 chunk / 24 MB**，还得给展示页配 importmap。
- **不用 CDN**：展示页跑在 `sandbox` 不透明源里，断网就废，也不该把用户的页面依赖外部服务。
- 展示页是不透明源（`HTML_CSP` 没有 `allow-same-origin`），`fetch` 同源资源会被当跨域拦掉，但 `<script src>` / `<link href>` 是 no-cors 请求，能正常加载 —— 所以必须是**普通脚本**。

### 这一份文件被两处用

1. **浏览器**：镜像路由 `GET /api/showme/vendor/mermaid.min.js` 原样发出，页面里由引导脚本 `lib/mermaid-boot.js` 加载、渲染、导出 PNG。
2. **Node 预检**：`lib/mermaid-check.js` 在读同一份文件，**只在内存里**打一个补丁再喂 `vm`：

   ```
   Z1=Rsr()   →   Z1={addHook(){},removeHook(){},removeHooks(){},removeAllHooks(){},
                      sanitize:t=>t,setConfig(){},clearConfig(){},isSupported:!1,
                      version:"3",removed:[]}
   ```

   `Z1` 是 `createDOMPurify()` 的返回值。没有真 DOM 时 dompurify 会退化成空壳，
   流程图解析走到 `setupDompurifyHooks()` 就抛
   `TypeError: Z1.addHook is not a function` —— 补丁只是让这条路径变成 no-op，
   **校验器不做任何净化**（它只解析语法，不渲染、不输出 HTML），所以是安全的。

   > ⚠ 补丁点是**依赖打包产物形态**的：升级 mermaid 时 `tools/../../test/mermaid.test.mjs`
   > 会先红（它断言补丁串在文件里正好命中 1 次）。红了就重新确认补丁点，别默默放行。

### 为什么不引 `@mermaid-js/parser`

试过（2.0.1）：它只覆盖 architecture / gitgraph / packet / pie / radar / treemap /
wardley / cynefin / info / railroad / treeview / eventmodeling —— **没有
flowchart / sequence / class / state / er**，而这几类恰好是最常写的。所以不用。
