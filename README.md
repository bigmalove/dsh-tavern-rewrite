# revnovel润色（dsh-tavern-rewrite）

revnovel润色：正文一边写一边润。模型每写满一段，就先把这段发给 [北棱改文站（revnovel）](https://revnovel.org) 的 OpenAI 兼容 API 改写，再显示出来；玩家看到的、存进存档的始终是润色版。关掉「正文边写边润」时退回旧做法：正文写完后整段润色，再用 `editTurn` 替换。

GitHub：<https://github.com/bigmalove/dsh-tavern-rewrite>

这是独立维护的插件仓库（原在 `dsh-tavern/examples/` 下，已移出，不占用本体仓库的提交）。内部包名和安装目录仍用 `dsh-tavern-rewrite`，界面显示为「revnovel润色」。

> 0.4.0：新增「正文边写边润」——宿主 v8 的 `tavern.replyRewriter()` 让插件在正文 token 流里按段落改写，首段从「写完整段 + 一次改写」后才出现，之后基本追着模型写；润色版直接落进存档，不再有结算后的整段跳变。工具提交模式（`submit_story`）、自动精修、玩家手动编辑仍走各自的正文路径。
>
> 0.3.1：修正文标记保护——`image###…###` 与 Markdown 图片行内保护放宽长度与边界，不再被截断；RunningHub `[[RH:SHOT]]…[[/RH]]` 标记块与 MVU 变量块一样整块跳过，不再被改写或拆坏；写入 `editTurn` 时带 `polish: true`，场景插图不会被正文替换冲掉。
>
> 0.3.0：适配 `revnovel.org` 新版裸改写端点（`https://revnovel.org/rw/v1`，模型 `rewrite3-27B`，仅调用润色模型、无需托管云端 key；支持 `/health` 健康检查与 `model_offline` 错误识别）。旧配置里的 `rewrite.revnovel.org` 与旧模型会自动迁移。

## 它怎么工作

1. **正文边写边润（默认开）**：宿主把正文 token 流按「完整段落 + 至少 400 字」切段，插件改写完一段才把这段显示出来，所以气泡里出现的就是润色版。首段要等这一轮凑够一整段（默认 500 字，可在面板调）并改写完成，会比原来晚几秒；之后模型继续写、改写接着上，基本追着写。
2. **关掉流式后**：后台结算开始时，插件的结算任务（`parallel` 阶段）先并行润色这一轮；正文写完、结算结束后再调用 `editTurn` 替换。
3. 润色只改**文字段落**：HTML 状态栏、`details`、表格、```html 围栏、脚本整块原样保留；插件标记（`image###…###`）、URL、行内代码、宏、叙事标签会先换成占位符，回来再还原；MVU 的 `<UpdateVariable>` / `<InitVar>` 变量块整块跳过。提交前会做一次结构自检，HTML 有任何变化就放弃这次润色，保留原文。
4. 改写台要求输入至少 400 字、最多 20000 字。插件按 1000 字左右切段（可在面板里调），每段单独调用；不足 400 字的段落跳过，正文整体太短时这一轮就不润色。
5. `rewrite3-27B` 直接接收整段 `user` 正文即可改写（发 `assistant` 预填反而会触发续写）；自部署旧版 `v12` 模型仍保留 `assistant` 预填兜底。输出统一做校验：长度比例、和原文的二字组重合度、复读、是否被截断、占位符是否丢失/新增、结尾标点。不合格会重试，最多 3 次；仍不合格就跳过这一段。跳过的段落保留原文，其余段落照常替换。
6. `editTurn` 会再触发一次 `onTurnSettled`。插件用 `textVersion`、润色文本哈希和 `onTimelineChanged` 的 `edit/regenerate` 事件做防循环，不会反复润色。玩家手动编辑过的正文也不会被自动覆盖。
7. 面板里有「自动润色」总开关；每局也可以在「本局设置 → revnovel润色」里单独关闭。输入框上方的「revnovel润色」按钮可以手动重跑当前这一轮。
8. 改写台后端模型没接上时会返回 `【mock 模式：模型未接入，以下为原文回显】` 加原文。插件把它当成上游不可用：**不替换正文**，在面板里记一条「改写台处于 mock 模式」，并在这之后 2 分钟内直接跳过自动润色（手动按钮仍会重试）。面板的「测试连接」也能提前发现这种状态。

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

装好后刷新 Tavern 页面，先到 [revnovel.org/keys](https://revnovel.org/keys) 用 Discord 登录后创建 `sk-rw-…` 密钥（本插件仅调用裸改写模型，无需托管云端 key），再打开侧栏「revnovel润色」，把 API 密钥粘贴到「API 密钥」里点「保存密钥」。密钥保存在 DSH 凭据 `DSH_TAVERN_REWRITE_API_KEY` 中。

`config.json` 是可选的非密钥配置（参考 `config.example.json`），只放服务地址、模型、温度这些：

```json
{
  "baseURL": "https://revnovel.org/rw",
  "model": "rewrite3-27B",
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
| `baseURL` | `https://revnovel.org/rw` | 裸改写服务地址，不带 `/v1`；直接贴 `revnovel.org/keys` 或根域名也会自动归一到 `/rw`；旧的 `rewrite.revnovel.org` 会自动迁移 |
| `model` | `rewrite3-27B` | 默认润色模型；旧配置里的 v9/v12 或带 `/` 的云端组合模型名会自动迁移，服务端换模型时也会用 `/v1/models` 自动切换 |
| `temperature` | `0.6` | 建议 0.5–0.8；太低会原样回显，太高容易加戏或复读 |
| `maxChars` | `1000` | 单次送进 API 的目标字数；400–2000。短尾巴会并入前一段，实际单段可能到 1.5 倍 |
| `minChars` | `400` | 低于这个字数不送；改写台自己也会拒绝 |
| `concurrency` | `2` | 同时发几段；1–4 |
| `timeoutMs` | `90000` | 单次请求超时 |
| `retries` | `2` | 429/5xx/网络错误的自动重试次数 |

密钥不在这张表里：它只在「revnovel润色」面板里配置，存进 DSH 凭据。

## 改写台 API 备忘（2026-11 新版）

- 密钥页面在 `https://revnovel.org/keys`（需要 Discord 登录，仅限「类脑」服务器成员），创建 `sk-rw-…` 密钥即可使用，不需要托管云端模型 key。
- 本插件对接的是裸改写模型端点 `https://revnovel.org/rw/v1`（旧的 `rewrite.revnovel.org` 已下线）。`GET /rw/v1/models` 需要带鉴权头，当前返回 `rewrite3-27B`。
- 调用方式：`POST /rw/v1/chat/completions`，`Authorization: Bearer sk-rw-…`（也支持 `X-API-Key`）。用 `curl`/Node 时记得带 `User-Agent`，Cloudflare 会拦默认 UA。
- 后端健康检查：`GET https://revnovel.org/health` 返回 `{"ok":true,"service":"revnovel-site","version":"0.1.0"}`（兼容旧版/自部署服务的 `/api/health`）。面板的「测试连接」会同时拉取 `/v1/models` 与健康状态。
- 0.4.0 起，Tavern 插件接口 v8 提供 `tavern.replyRewriter()`：插件能拿到正文 token 流，按段落改写后再交给前端和存档，所以默认就是「边写边润」。工具提交模式（`storyOutputToolCall`）的正文在工具参数里，仍只能走结算后的 `editTurn`。

## 作者 / 反馈

改写台作者 Discord：[加入频道](https://discord.com/channels/1134557553011998840/1553427579346616480)

## 已知限制

- **正文不足 400 字**：改写台直接拒绝，插件会跳过并在面板里记一条「跳过」。
- **v12 偶尔续写或原样回显**：这是服务端模型状态。插件会校验并重试，仍不合格就保留原文，不会把续写或回显写进正文；面板里会记「偏离原文」「原样返回」等原因，稍后手动重试即可。
- **行内 HTML**：像 `<b>她的声音很轻。</b>` 这种夹在句子中间的标签必须原样保留，插件会把它当成分段边界。标签前后的文字如果各自不足 400 字，就不润色；不会为了润色去改 HTML。
- **插件标记在句子中间**：标记会换成占位符；模型如果弄丢占位符，这一段就跳过。像 `image###…###` 这样单独一行的标记通常能保留。
- **模型仍可能改写风格**：这是改写模型，不是校对器；它可能调整标点、合并句子、偶尔加一个「……」过渡。觉得太激进就把温度降到 0.4–0.5；太低会原样回显，建议在 0.5–0.8 之间微调。
- **只润色最新的、已经结算完的一轮**：结算后替换路径的接口限制；手动按钮也只对最新一轮可用。
- **流式润色有首段延迟**：改写台单次至少收 400 字，所以第一段要等正文写满「流式起改字数」（默认 500）并改写完才出现，通常比直接流式晚几秒；之后每段都追着模型写。调小起改字数能更快看到首段，但段太短会被改写台拒绝（400 字下限）。
- **流式润色只覆盖纯文本正文**：打开「输出走工具调用」后正文由 `submit_story` 提交，流式改写不介入，改成结算后整段替换。
- **需要宿主 v8**：旧版 Tavern（插件接口 7 及以下）没有 `replyRewriter`，插件会自动退回结算后整段替换。
- **开场白不自动润色**：`onTurnSettled` 不为开场白发通知；如果开场白是最新一轮，可以手动点「revnovel润色」补一次。
- **改写台处于 mock 模式**：这是服务端状态，插件无法绕过。此时这一轮保持原文，等改写台恢复后再手动点一次即可。
- **服务端换模型**：默认模型已经迁到 `rewrite-v12-fp8`；如果以后 `/v1/models` 再换 id，插件会在 `404 model_not_found` 时自动取列表里的第一个模型重试，但面板里的「模型」字段不会自动改写，建议点一次「测试连接」确认。

## 测试

```sh
npm test
```

- `tests/polish.test.mjs`：切段、HTML/MVU 结构保护、占位符、段落重排、输出校验，不需要网络。
- `tests/plugin.test.mjs`：用假的 fetch 跑宿主侧注册、预润色、`editTurn`、防循环、设置和密钥处理，以及新版请求体（`task`/`auto_split`/预填）、`model_not_found` 自动切换，不需要网络。
- `tests/stream.test.mjs`：流式切点（不足阈值、段落边界、围栏与 RunningHub 标记块不切断）、改写走真实润色管线、流式过的轮次结算时不再整段重写。
- 结构交叉检查默认读同级的 `dsh-tavern` 本体（`../dsh-tavern`）的 `editableReplyParts`；没有本体时退化为插件自己的 `collectProtected` 检查。可以用 `DSH_TAVERN_REPO=/path/to/dsh-tavern` 指定。

## 发布

已发布在 <https://github.com/bigmalove/dsh-tavern-rewrite>。更新代码后推送到 `main` 即可；DSH Tavern 的「设置 → 插件」按默认分支安装/更新。发布前确认 `config.json` 没有被提交。

## 卸载

删除插件文件夹，刷新页面。插件数据里只保存非密钥设置；密钥在 DSH 凭据里，可在面板里清除，或删掉 `DSH_TAVERN_REWRITE_API_KEY` 凭据。
