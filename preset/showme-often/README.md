# Showme Often · agent 预设

一个装在 DSH profile 里的**会话预设**：选中它的会话，默认用 [`show_html`](../../lib/index.js) 展示页回答，聊天正文只留摘要。

它解决的问题不是「能不能展示」，而是「模型总爱写长文」：默认形态被改成页面，长解释、对比、评审、状态、候选都上页面，文字只做索引。

## 它改了什么

只有一行：`persona` 的前缀。插件清单逐字照抄 DSH 自带的 `standard` 预设（bash / fs / search / web / 子任务 / 计划模式 / 压缩……），所以页面之外的能力一个不少。

策略原文在 [`cordis.patch.yml`](./cordis.patch.yml) 的 `persona.config.prefix` 里，规则是：

- 出现**多个条目、对比、表格、流程、截图、待评审方案、可点名可表态的东西** → 一律做页；
- 只有「一两句话、没有结构、没有可指的东西」或用户明确要文字/代码时才用纯文字；
- 拿不准就做页；做完页，正文只写摘要与要用户决定的事；
- 页面必须可回话（可见 id、控件同屏、每次变化 `postMessage`、一行一条回执）；
- `show_html` 不可用时说一句并退回 Markdown。

它明确压过 `show_html` 工具描述里那句「不要用于普通回答」——那句话是为默认预设写的，这里被有意反转。

## 安装

前提：`dsh-showme-html` 已经装在 profile 里（宿主级工具，预设不重复挂，否则会出现两个同名工具）。

在 agent 里：

```text
plugin_manager action=install_bundle target=<仓库绝对路径>/preset/showme-often
```

或者用 CLI 指向同一个目录。装完 `plugin_manager list_bundles` 应出现 `@local/dsh-showme-often-preset`，`list_plugins` 应出现 `preset-showme-often` 且为 active。

## 选中它

**新会话**才能选（DSH 的预设是会话起始时定死的，既有会话换不了）：

- 新会话的选择器里选 **Showme Often**；或
- 设置 → 预设 → Showme Often → 设为默认（之后每个新任务都用它）。

不想全局生效就只在新会话里选，默认仍是 Standard。

## 验收三轮

1. 「比较这三份方案」→ 应该出展示页 + 几行摘要，页面里每个方案有 id 与判定控件。
2. 「1+1 等于几」→ 允许纯文字（这就是策略里的下限）。
3. 在页面上点一个判定 → 卡片出现「填入输入框」，文本一行一条。

## DSH 升级之后

预设里的插件清单是**照抄**的，不继承。升级 DSH 后如果某个包改名或消失，这一行会激活失败并在名册里留下诊断。修法：

1. 从新版 `@deepseek-ai/dsh-web-app/presets/standard.patch.yml` 重抄 `config.plugins`；
2. 只把 `persona` 的 `config.prefix` 换成本文件里那一段（从 `You are a coding agent` 到最后一个 `paragraphs.`）；
3. 重装 bundle。

`complete` 必须保持默认 `false`：设成 `true` 会顶掉运行时上下文与 `AGENTS.md` 的注入。

## 回滚

```text
plugin_manager action=remove_bundle target=@local/dsh-showme-often-preset
```

名册回到四条预设，既有会话与其它预设不受影响。

## 边界

- 只影响**选中它的会话**；不改变其它预设，也不改插件代码。
- 这个目录**不进 npm 包**（`files` 里没有 `preset/`），它是仓库内的独立 bundle。
- 如果你想要的是「全 profile 所有会话都页面优先」，那是另一个方案（给插件加全局档位），不在这个预设里。
