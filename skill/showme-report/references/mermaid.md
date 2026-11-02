# references/mermaid — 页面里画流程图 / 时序图

## 四种等价写法

```html
<pre class="mermaid">
graph TD
  A[写页面] --> B[预检]
  B --> C[渲染]
</pre>

<pre data-mermaid>sequenceDiagram
  A->>B: 消息
</pre>

<div class="mermaid">stateDiagram-v2
  [*] --> 就绪
</div>

<pre><code class="language-mermaid">erDiagram
  A ||--o{ B : has
</code></pre>
```

四条都走同一条路：**先宿主预检，再浏览器渲染**。`<pre>` 里的内容**不要缩进**（前导空格会进图源）。

## 三件必须知道的事

1. **写错会让这次 `show_html` 直接失败。** 宿主用 vendored 的 mermaid（`node:vm` 里跑它的 parser）
   逐块预检，报错是 mermaid 自己的原文，比如：

   ```
   .dsh/showme/plan.html 里有 1 张 mermaid 图语法不过，没有展示：
     第 1 个图（flowchart-v2）：Parse error on line 2: … --------------^ Expecting 'AMP','COLON',…
   ```

   改源码再调一次就行。**这不是警告，是硬失败**（裂图不上屏）。

2. **只检查"静态写着"的块。** 预检读的是页面文件本身；由 JS 在浏览器里拼出来的图它看不到。
   所以别动态生成 mermaid 块（那种页面坏图会直接显示红框，`show_html` 却认为没问题）。

3. **渲染完成后每张图会导出 PNG**，路径是 `.dsh/showme/mermaid/<页面名>.<序号>.png`，
   `show_html` 的返回值 `mermaid.png[]` 里就写着。**你可以用 `read_image` 打开它看自己画的图。**

## 支持的图类型（实测）

`flowchart-v2`（`graph TD` / `flowchart LR`）、`sequenceDiagram`、`classDiagram`、
`stateDiagram-v2`、`erDiagram`、`pie`、`gantt`、`mindmap`。其它类型（`gitGraph`、`journey`、
`quadrantChart`、`timeline`…）没逐条实测，写了先看预检报不报。

## 样式上的三条禁忌

- **不要给 mermaid 的 SVG 写 CSS 覆盖**（`.mermaid svg path {fill:…}` 之类）——会打乱主题配色，
  也会让"四套皮肤"失去一致。
- **不要在 `<pre class="mermaid">` 外面套 `display:none` 容器**：渲染时量不到尺寸，出图会变形。
- **不要 `htmlLabels` 依赖**：渲染器固定 `htmlLabels:false`（避免外链字体与布局漂移），
  所以节点文字里别写 HTML 标签，图标用 `:::icon` 或者干脆用 emoji。

## 图太大 / 页面太大

- 单张图导出时按 2× 缩放；超过 ~1.2MB 自动退到 1×；仍超就只留 SVG（回执里 `png: null`）。
- 页面文件 **> 2MB 不注入引导脚本** → 图不会被渲染（页面本身照常显示）。
  页面这么大通常说明该拆了。

## 运行时失败长什么样

块会被替换成红框（`.dsh-showme-mermaid-error`），框里保留原始源码 + 错误信息，
所以用户看到的是"哪一块坏了"，而不是白页。卡片头部同时出现 `mermaid 失败 ×N` 的徽标。
**但正常情况下用户不该看到它**——写错的东西在 `show_html` 那一步就被挡住了。

## 和模板的关系

`review` / `pick` / `report` / `doc` 骨架**没有 mermaid 块**，这是刻意的：
预检只认页面里静态写着的块，模板页的块都是 `core.js` 在浏览器里拼的 —— 两边不一致更难解释。
**要画图就自己写页面**（不套模板），把 `presets/<slug>.css` 引上、按 `layout.md` 写骨架即可。
