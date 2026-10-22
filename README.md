# revnovel润色（dsh-tavern-rewrite）

revnovel润色：每轮正文写完后，把正文发给 [revnovel 改写台](https://rewrite.revnovel.org) 的 OpenAI 兼容 API 润色一次，再用 `editTurn` 把显示和存档里的正文替换成润色后的版本。

GitHub：<https://github.com/bigmalove/dsh-tavern-rewrite>

这是独立维护的插件仓库（原在 `dsh-tavern/examples/` 下，已移出，不占用本体仓库的提交）。内部包名和安装目录仍用 `dsh-tavern-rewrite`，界面显示为「revnovel润色」。

> 0.2.0：适配改写台 2026-10 新版 API（`rewrite-v12-fp8`、`task`/`auto_split`、`/v1/models` 模型发现）。旧配置里的 v9 模型和 0.15 温度会自动迁移。

## 它怎么工作

1. 后台结算开始时，插件的结算任务（`parallel` 阶段）先并行润色这一轮；正文写完、结算结束后再调用 `editTurn` 替换，因此通常不会在结算结束后额外等很久。
2. 润色只改**文字段落**：HTML 状态栏、`details`、表格、```html 围栏、脚本整块原样保留；插件标记（`image###…###`）、URL、行内代码、宏、叙事标签会先换成占位符，回来再还原；MVU 的 `<UpdateVariable>` / `<InitVar>` 变量块整块跳过。提交前会做一次结构自检，HTML 有任何变化就放弃这次润色，保留原文。
3. 改写台要求输入至少 400 字、最多 20000 字。插件按 1000 字左右切段（可在面板里调），每段单独调用；不足 400 字的段落跳过，正文整体太短时这一轮就不润色。
4. 新版 v12 有时会顺着正文往下写，温度太低又会原样回显。插件把原文第一句作为 `assistant` 预填，让模型从“改写”而不是“续写”的位置起步；输出再做校验：长度比例、和原文的二字组重合度、复读、是否被截断、占位符是否丢失/新增、结尾标点。不合格会换锚点/温度重试，最多 3 种策略；仍不合格就跳过这一段。跳过的段落保留原文，其余段落照常替换。
5. `editTurn` 会再触发一次 `onTurnSettled`。插件用 `textVersion`、润色文本哈希和 `onTimelineChanged` 的 `edit/regenerate` 事件做防循环，不会反复润色。玩家手动编辑过的正文也不会被自动覆盖。
6. 面板里有「自动润色」总开关；每局也可以在「本局设置 → revnovel润色」里单独关闭。输入框上方的「revnovel润色」按钮可以手动重跑当前这一轮。
7. 改写台后端模型没接上时会返回 `【mock 模式：模型未接入，以下为原文回显】` 加原文。插件把它当成上游不可用：**不替换正文**，在面板里记一条「改写台处于 mock 模式」，并在这之后 2 分钟内直接跳过自动润色（手动按钮仍会重试）。面板的「测试连接」也能提前发现这种状态。

## 安装

在 DSH Tavern 的「设置 → 插件」里粘贴仓库地址：

```text
https://github.com/bigmalove/dsh-tavern-rewrite
```

点安装，刷新页面。

也可以本地安装。本仓库就是一个 Tavern 插件文件夹，在仓库根目录运行：

```sh
npm run install:tavern
```

默认复制到：

```text
~/.dsh/profile-data/tavern/data/plugins/dsh-tavern-rewrite/
```

也可以用 `DSH_TAVERN_PLUGIN_DIR` 指定别的插件目录：

```sh
DSH_TAVERN_PLUGIN_DIR=/path/to/plugins/dsh-tavern-rewrite npm run install:tavern
```

脚本只更新代码和说明，**不会覆盖目标目录已有的 `config.json`**。

装好后刷新 Tavern 页面，打开侧栏「revnovel润色」，把 API 密钥粘贴到「API 密钥」里点「保存密钥」。密钥保存在 DSH 凭据 `DSH_TAVERN_REWRITE_API_KEY` 中。

`config.json` 是可选的非密钥配置（参考 `config.example.json`），只放服务地址、模型、温度这些：

```json
{
  "baseURL": "https://rewrite.revnovel.org",
  "model": "rewrite-v12-fp8",
  "temperature": 0.6,
  "maxChars": 1000,
  "concurrency": 2
}
```

宿主侧（`index.mjs` / `lib/`）改动后要重启 DSH/Tavern 才生效；浏览器侧（`client.js`）刷新页面即可。

也可以手动把 `package.json`、`index.mjs`、`client.js`、`lib/`、`README.md`、`config.example.json` 复制过去，效果一样。

### 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `auto` | `true` | 自动润色总开关；面板里也有勾选框 |
| `baseURL` | `https://rewrite.revnovel.org` | 服务地址，不带 `/v1`；直接贴 `/api` 文档页也可以 |
| `model` | `rewrite-v12-fp8` | 服务当前只提供这一个模型；旧配置里的 v9 会自动迁移，服务端换模型时插件会用 `/v1/models` 自动切换 |
| `temperature` | `0.6` | v12 建议 0.5–0.8。0.15 左右基本只会原样回显，1.0 以上容易加戏或复读 |
| `maxChars` | `1000` | 单次送进 API 的目标字数；400–2000。短尾巴会并入前一段，实际单段可能到 1.5 倍 |
| `minChars` | `400` | 低于这个字数不送；改写台自己也会拒绝 |
| `concurrency` | `2` | 同时发几段；1–4 |
| `timeoutMs` | `90000` | 单次请求超时 |
| `retries` | `2` | 429/5xx/网络错误的自动重试次数 |

密钥不在这张表里：它只在「revnovel润色」面板里配置，存进 DSH 凭据。

## 改写台 API 备忘（2026-10 新版）

- 文档页是 `https://rewrite.revnovel.org/api`（需要 Discord 登录，登录后能创建/查看密钥）。
- OpenAI 兼容根地址是 `https://rewrite.revnovel.org/v1`。先 `GET /v1/models` 取 `data[0].id`，当前是 `rewrite-v12-fp8`；不要写死模型名，服务端换模型时 `404 model_not_found` 就是这个原因。
- 调用方式：`POST /v1/chat/completions`，`Authorization: Bearer sk-rw-…`。`messages` 里**只放一条 `user`**，正文整段放进 `content`；服务端会自动拼当前任务的指令，不要传 `system`，也不要在正文里加“请改写/请扩写”。用 `curl`/Node 时记得带 `User-Agent`，Cloudflare 会拦默认的 Node UA。
- 请求体支持 `task: "rewrite" | "expand"`（默认 `rewrite`）、`auto_split`（默认 `true`，长文按约 1000 字切段）、`stream`、`temperature 0–2`、`top_p`、`stop`、`max_tokens`（上限 8192，实际还会按输入长度收紧）。插件自己按段落切段，所以显式传 `auto_split: false`，避免服务端再切一次把预填锚点打散。
- 单次输入至少 400 字、最多 20000 字；全局 24 路并发，满了返回 429；后端暂时不可用返回 502。
- 流式响应是 SSE，拼 `choices[0].delta.content`，最后 `data: [DONE]`；非流式取 `choices[0].message.content`。返回的是小说正文，不是解释或问答。
- 服务端会实时检测周期性复读：触发时 `finish_reason` 为 `length`，顶层带 `revnovel: {"truncated": true, "reason": "periodic" | "repeated_ngram"}`。这不是报错，换一段或重试通常就正常。
- 实测 v12 在只给正文时经常会**接着往下写**，温度低时又会原样回显；这是模型/服务端状态，不是插件参数能完全消除的。插件的做法是把原文第一句作为 `assistant` 预填（OpenAI 兼容的 prefill），让模型从改写位置继续；再用长度比例、二字组重合度、复读、占位符、结尾标点做校验，不合格就换锚点/温度重试，最多 3 次，仍不合格就保留原文。这是客户端兜底，不是官方推荐参数。
- 后端状态：`GET /api/health` 返回 `{"ok":true,"backend":"openai","model":"rewrite-v12-fp8"}`；`backend` 是 `mock` 就说明模型没接上。面板的「测试连接」会读这个接口并直接提示。
- Tavern 的插件接口没有「首次显示前替换流式正文」的钩子，公开的替换路径只有结算后的 `editTurn`。所以生成和后台结算期间先看到原文，结算结束后切换成润色版；预润色只是把切换前的额外等待压到最小。

## 作者 / 反馈

改写台作者 Discord：[加入频道](https://discord.com/channels/1134557553011998840/1553427579346616480)

## 已知限制

- **正文不足 400 字**：改写台直接拒绝，插件会跳过并在面板里记一条「跳过」。
- **v12 偶尔续写或原样回显**：这是服务端模型状态。插件会校验并重试，仍不合格就保留原文，不会把续写或回显写进正文；面板里会记「偏离原文」「原样返回」等原因，稍后手动重试即可。
- **行内 HTML**：像 `<b>她的声音很轻。</b>` 这种夹在句子中间的标签必须原样保留，插件会把它当成分段边界。标签前后的文字如果各自不足 400 字，就不润色；不会为了润色去改 HTML。
- **插件标记在句子中间**：标记会换成占位符；模型如果弄丢占位符，这一段就跳过。像 `image###…###` 这样单独一行的标记通常能保留。
- **模型仍可能改写风格**：这是改写模型，不是校对器；它可能调整标点、合并句子、偶尔加一个「……」过渡。觉得太激进就把温度降到 0.4–0.5；太低会原样回显，建议在 0.5–0.8 之间微调。
- **只润色最新的、已经结算完的一轮**：`editTurn` 的接口限制；手动按钮也只对最新一轮可用。
- **开场白不自动润色**：`onTurnSettled` 不为开场白发通知；如果开场白是最新一轮，可以手动点「revnovel润色」补一次。
- **改写台处于 mock 模式**：这是服务端状态，插件无法绕过。此时这一轮保持原文，等改写台恢复后再手动点一次即可。
- **服务端换模型**：默认模型已经迁到 `rewrite-v12-fp8`；如果以后 `/v1/models` 再换 id，插件会在 `404 model_not_found` 时自动取列表里的第一个模型重试，但面板里的「模型」字段不会自动改写，建议点一次「测试连接」确认。

## 测试

```sh
npm test
```

- `tests/polish.test.mjs`：切段、HTML/MVU 结构保护、占位符、段落重排、输出校验，不需要网络。
- `tests/plugin.test.mjs`：用假的 fetch 跑宿主侧注册、预润色、`editTurn`、防循环、设置和密钥处理，以及新版请求体（`task`/`auto_split`/预填）、`model_not_found` 自动切换，不需要网络。
- 结构交叉检查默认读同级的 `dsh-tavern` 本体（`../dsh-tavern`）的 `editableReplyParts`；没有本体时退化为插件自己的 `collectProtected` 检查。可以用 `DSH_TAVERN_REPO=/path/to/dsh-tavern` 指定。

## 发布

已发布在 <https://github.com/bigmalove/dsh-tavern-rewrite>。更新代码后推送到 `main` 即可；DSH Tavern 的「设置 → 插件」按默认分支安装/更新。发布前确认 `config.json` 没有被提交。

## 卸载

删除插件文件夹，刷新页面。插件数据里只保存非密钥设置；密钥在 DSH 凭据里，可在面板里清除，或删掉 `DSH_TAVERN_REWRITE_API_KEY` 凭据。
