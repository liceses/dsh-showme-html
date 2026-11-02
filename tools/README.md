# tools/ —— 开发期的一次性小刀

这些脚本**不进 npm 包**（`package.json` 的 `files` 里没有 `tools/`），只在仓库里用。
它们解决的是同一类问题：**宿主的真实契约和我以为的不一样**。

## 为什么需要它们

这个插件的每一个关键决定，最终都落在宿主的实现上：

- 「`sidebarRightTabs` 到底存不存在？」—— 计划文档说没有，asar 里其实有。
- 「`priority` 有几个值？」—— 文档写两值，实现里是 `builtin` / `extension` / `fallback`。
- 「`sessionQuery.readSession()` 返回什么形状？」—— 0.2.1-rc.5 是 `{ session: header }`，
  不是顶层 `header`；认错了就整条路由对非活跃会话 404。
- 「全屏按钮为什么点不到？」—— `titleBarOverlay` 的高度是 40，原生按钮画在网页之上。

这类问题的答案只在**装好的那份代码**里。装一个 `@electron/asar` 只为读它，不值得；
所以这里有一个 60 行的只读解析器。

## 五个脚本

| 脚本 | 干什么 | 对应 npm script |
|---|---|---|
| `asar-lib.mjs` | 只读 asar 解析器（`asar-peek` / `asar-scan` 共用，不单独跑） | — |
| `asar-peek.mjs` | `list <正则>` 按路径找条目；`x <目录> <正则>` 取出来读 | `asar:list` |
| `asar-scan.mjs` | 只知道字符串、不知道在哪个包里时，扫字节并打上下文 | `asar:scan` |
| `refresh-assets.mjs` | 同步工作区的落地副本（`templates/` 覆盖、`presets/` 只补缺） | `assets:refresh` |
| `vendor-mermaid.mjs` | 重新取 `mermaid@<版本>` 的 dist 单文件进 `vendor/`，并打印 sha256 | `vendor:mermaid` |

### 读 asar

```bash
# 1) 按路径找条目（正则，大小写不敏感）
node tools/asar-peek.mjs list 'dsh-client-ui-sidebar-right'
node tools/asar-peek.mjs list 'sidebar.*client\.js$'

# 2) 把命中的文件取出来读（落在 .dsh/out/，gitignore 内）
node tools/asar-peek.mjs x .dsh/out 'dsh-client-ui-sidebar-right/lib/client.js'

# 3) 只知道字符串、不知道在哪个包里时，直接扫字节 + 打上下文
node tools/asar-scan.mjs titleBarOverlay 300 2
node tools/asar-scan.mjs 'unknown session' 200 3
```

### 同步 / 重取资产

```bash
npm run assets:refresh    # 改了 templates/ 或 styles/ 之后同步到 .dsh/showme/ 落地副本
npm run vendor:mermaid    # 换 mermaid 版本时重取（版本号在脚本里，sha256 会打到 stdout）
```

归档路径默认是 `D:/applications/dshDesktop/resources/app.asar`（Windows 桌面版），
换机器用 `--asar <路径>` 或 `DSH_ASAR` 环境变量指定。

## 踩过的坑：header 涨到 4.8 MB

asar 的头部布局是：

```
[u32 = 4][u32 pickle 尺寸][u32 字符串 pickle 尺寸][u32 JSON 字节数][JSON…]
```

早先的版本按「固定 4 MiB 探测缓冲 + 花括号配对」找 JSON 的结尾，在 0.1.7 时代够用。
到 0.2.x，header JSON 涨到 ~4.8 MB，于是直接报：

```
Error: asar header JSON 没找到结尾
```

现在一律读 offset 12 的 u32 当长度，`dataOffset = align4(16 + jsonLength)`。
**别再改回"猜长度"的写法。**

## 还有一个：`refresh-assets.mjs`

它不属于"读宿主"，属于"修工作区"：把 `.dsh/showme/` 里的落地副本同步成包内那一份。

```bash
npm run assets:refresh -- --dry-run   # 只看会改什么
npm run assets:refresh                # 同步 templates/，补齐 presets/ 缺的文件
```

为什么要它：`show_html` 落地资产是 **create-only**（不覆盖你改过的文件），
所以插件升级、或仓库改了 `templates/README.md` 之后，工作区那份会**悄悄停在旧版**。
症状不是报错，而是"文档教的是已经废弃的流程"——这个坑踩过两次，
现在由 `npm run doctor` 的第 [6] 节盯着，落后就红。

覆盖前会把旧文件备份成 `<文件名>.bak-<本地时间戳>`，手改过的内容不会凭空消失。
`presets/` 默认只补缺、不覆盖内容（那是留给你改的）；要强制覆盖加 `--presets`。
