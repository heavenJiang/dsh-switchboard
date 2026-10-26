# 掌上指挥台（Switchboard · dsh-switchboard）

[English](README.md) | 中文

<img src="icon.svg" width="72" alt="" align="right">

在手机上通过 Telegram、飞书机器人指挥 DeepSeek Harness 的 Agent：在手机上给 Agent 发文字、图片、文件和语音，看它边写边回复，审批工具调用、回答它的提问，订阅长任务的完成通知；在 Web 端查看所有渠道的聊天记录，并把任意会话关联到聊天。

机器人是 Web Host 的另一个客户端：它通过 `ctx.sessionController`（与 Web 界面同一条路径）创建会话和发送消息，所以聊天里开的会话会出现在 Web 侧栏中，Web 端的会话也可以接管或订阅。机器人新建的会话会放进工作目录对应的 Web 工作区（没有就自动创建），和其他会话一起显示在侧栏里。

![掌上指挥台概览](docs/images/panel-dashboard.png)

## 线路

一条**线路**是某个聊天平台上的一个机器人，加上允许使用它的人。可以配置多条线路：例如你自己用 Telegram，团队用飞书；每条线路有自己的凭据、允许的用户和群、默认工作目录。

- 同一个会话可以同时从多条线路绑定或订阅，回复、审批、提问会发到每个关联的聊天。
- 聊天在内部以「线路:聊天 ID」区分（例如 `feishu:oc_xxx`）；最早那条 Telegram 线路（ID 为 `telegram`）沿用纯数字 ID，旧版本的绑定和聊天记录原样可用。
- 目前支持 **Telegram** 和 **飞书 / Lark**。

## 快速开始

1. 安装到 Web profile：在 Web 侧栏 **插件 → 添加插件** 中填 `github:heavenJiang/dsh-switchboard`，或用命令行：

   ```sh
   dsh plugin --profile web add github:heavenJiang/dsh-switchboard
   ```

2. 打开侧栏 **插件 → 已安装插件 → 掌上指挥台**（也可以点侧栏 **掌上指挥台** 右上角的 **插件设置**），在 **线路** 里添加线路、填写凭据和 **允许的用户**，再填 **默认工作目录**，点 **保存**，即时生效。
3. 给机器人发 `/whoami` 可以查看自己的用户 ID，把它填进 **允许的用户**。

### Telegram 线路

1. 在 Telegram 找 [@BotFather](https://t.me/BotFather)，发送 `/newbot` 创建机器人，复制 Token。
2. 设置页点 **+ Telegram 线路**，粘贴 **Bot Token**，填 **允许的用户**（Telegram 用户 ID 或 `@用户名`）。

### 飞书线路

飞书通过开放平台的**长连接**接收事件，不需要公网地址或回调 URL。

**扫码创建（推荐）**：设置页点 **+ 飞书线路** → **扫码创建飞书应用**，用飞书 App 扫码（或在这台电脑上点「在浏览器中打开」）并确认。机器人能力、所需权限、消息事件 `im.message.receive_v1` 和卡片回调 `card.action.trigger` 都已预先填好；确认后 App Secret 由宿主直接存入凭据库（不经过浏览器），扫码人自动加入 **允许的用户**，线路自动保存并连接。已有的应用可以点 **补全权限**，扫码补上缺少的权限、事件或回调。

**手动配置**：

1. 在 [飞书开放平台](https://open.feishu.cn/app)（国际版用 [Lark](https://open.larksuite.com/app)）创建**企业自建应用**，在「添加应用能力」中添加 **机器人**。
2. 在「权限管理」中开通：
   - `im:message.p2p_msg:readonly`（读取用户发给机器人的单聊消息）
   - `im:message.group_at_msg:readonly`（接收群聊中 @ 机器人消息事件）
   - `im:message:send_as_bot`（以应用的身份发消息）
   - `im:resource`（获取与上传图片或文件资源）
   - 可选：`contact:user.base:readonly`（显示用户姓名）、`im:chat:readonly`（显示群名）。
3. 在设置页点 **+ 飞书线路**，填 **App ID**（`cli_` 开头）和 **App Secret**，平台选飞书或 Lark，**保存**。线路状态显示机器人名称即连接成功。飞书要求先有客户端连上，才能在后台选择长连接，所以这一步要在下一步之前。
4. 在「事件与回调」中：
   - 事件配置的订阅方式选择 **使用长连接接收事件**，添加事件 `im.message.receive_v1`（接收消息）；
   - 回调配置同样选择长连接，添加回调 `card.action.trigger`（卡片回传交互，审批、模型选择等按钮需要它）。
5. 「版本管理与发布」中创建版本并发布，可用范围包含你自己（企业内需管理员审核通过）。权限和事件在发布后生效。
6. 在飞书里搜索机器人名称打开单聊，发 `/whoami`，把回复里的 open_id（`ou_` 开头）填进线路的 **允许的用户** 并保存。open_id 按应用区分，同一个人在不同应用下的 open_id 不同，要用这个机器人回复的那个。

飞书没有「正在输入」提示和命令菜单，其余功能与 Telegram 一致：回复、草稿、工具活动和带按钮的消息以消息卡片发送并就地更新，普通提示用文本消息。

## 在聊天里

| 命令 | 作用 |
| --- | --- |
| 直接发文字 / 图片 / 文件 / 语音 | 交给当前会话；没有会话时自动在默认工作目录新建 |
| `/new [目录]` | 新建会话 |
| `/cwd <目录>` | 设置本聊天新会话的工作目录 |
| `/sessions` | 最近的会话（带序号） |
| `/use <序号\|会话ID>` | 切换到已有会话（含 Web 端会话） |
| `/watch [序号\|会话ID]` | 订阅某个会话的完成与审批通知；不带参数列出订阅 |
| `/unwatch <序号\|会话ID\|all>` | 取消订阅 |
| `/stop` | 中止当前工作 |
| `/steer <文字>` | 在正在进行的轮次中途插话引导 |
| `/queue`、`/cancel <序号\|all>` | 查看、取消排队中的消息 |
| `/model [模型名]` | 查看或切换当前会话的模型（按钮列表，支持模糊匹配；不影响 Web 默认） |
| `/mode [模式]` | 查看或切换当前会话的权限模式（只读 / 工作区可写 / 完全访问） |
| `/get <路径>` | 获取工作目录里的文件，或列出目录（不能越出工作目录，符号链接也不行） |
| `/status` | 当前会话、模型、工作目录与线路状态 |
| `/whoami` | 显示你的用户 ID 与聊天 ID（任何人可用） |
| Harness 命令 | `/compact`、`/plan`、`/goal`、`/permission`、`/export` 等，与 Web 输入框一样在宿主上直接执行，结果发回聊天；`/help`（以及 Telegram 的命令菜单）会列出当前可用的命令 |
| 其他 `/xxx` | 不是命令的，原样作为文字交给 Agent |

**回复的呈现**

- Agent 的 Markdown 回复按平台渲染：Telegram 转成它支持的 HTML（粗体、斜体、代码块、链接、标题、引用、列表；表格转等宽块，排版被拒时退回纯文本）；飞书用消息卡片的 Markdown 组件。长回复按段落和代码块安全分段。
- **边写边显示**：回复生成时先发一条草稿，每隔一两秒更新，写完后原地替换成正式回复。
- **工具调用**：两次回复之间的所有工具调用合并成一条「🛠 工具调用 · N 次」消息，就地更新，不会刷屏。
- **回合摘要**：长任务结束时发一行摘要，包括用时、工具调用次数、改动了哪些文件。默认只在超过 60 秒的任务后发送，可以设置为每轮都发或关闭。

**审批与提问**

- **工具审批**：需要审批时，聊天里弹出带参数预览的 **允许一次 / 拒绝** 按钮。
- **Agent 提问**：Agent 调用「向用户提问」工具时，问题和选项按钮会发到聊天里，多选题勾选后点 **完成**。问题待回答期间，直接发文字就是自定义回答，不会被当成新消息。
- 两者都只有这条线路允许的用户能操作，超时未答（默认 300 秒）交回 Web 界面。

**图片、文件与语音**

- **图片和文件**：照片、文件、视频、音频都会通过 `ctx.fileUploads` 暂存进会话，这是 Web 输入框添加附件的同一条路径。图片按文件头字节识别真实类型，走图片通道，模型能直接看图；其他类型作为文件交给 Agent。飞书富文本消息里的文字和图片一并交给 Agent；Telegram 相册合并成一条消息。
- **语音**：先用 ffmpeg 转成 WAV，再用 Harness 的语音识别（语音输入插件）转成文字发给 Agent，聊天里会显示识别结果。识别不可用时，语音作为文件交给 Agent，并说明原因。
- **交付文件**：Agent 用 `present` 工具交付的文件会发回聊天，常见图片直接显示，其他作为文件发送（Telegram 上限 50 MB，飞书 30 MB）。
- Telegram 官方 Bot API 最多只能下载 20 MB 的文件；要接收更大的文件，需要自建 [Bot API 服务器](https://github.com/tdlib/telegram-bot-api) 并修改线路的 **Bot API 地址**。

**不丢消息**

- **线路断开时先存起来**：Agent 的回复、回合结束通知和交付文件，如果发送时线路没连上（网络抖动、代理断开、飞书 IP 白名单等），会存进发件箱。线路恢复后按顺序补发，并注明原定发送时间。只有「确定没发出去」的消息才会重发，发送结果不确定的不重发，避免重复。最多重试 3 次，保留 24 小时。
- **插件重启后补发**：插件更新或重启期间结束的回合，重新启动后会把每轮的最终回复（或失败原因）发到关联的聊天，每个会话最多补最近 3 轮。
- **掉线提醒**：线路断开超过设定时长（默认 5 分钟），通过其他正常的线路通知 **掉线提醒聊天**（留空则用定时任务推送聊天），恢复时再通知一次。设置页线路卡片和面板会显示待补发条数。

**群聊**

- 默认只响应命令、@机器人 和回复机器人的消息，群里的其他闲聊会被忽略（可按线路关闭）。
- 可以按用户授权，也可以在线路的 **允许的群** 里填群 ID，授权整个群的成员。
- 聊天记录面板里，群聊可以按成员筛选。

**安全**

- 只有线路的 **允许的用户**（以及 **允许的群** 里的成员）能使用这条线路的机器人，列表为空时拒绝所有人。
- 陌生人每小时最多收到一次「未授权」提示，不会被利用来刷屏。
- Telegram Token 和飞书 App Secret 保存在 Harness 凭据库（默认名称 `TELEGRAM_BOT_TOKEN`、`FEISHU_APP_SECRET`，也会读取同名环境变量），不写入 profile 配置文件，也永远不会回传到浏览器。旧版本写在配置文件里的明文 Token 在设置页填入新 Token 并保存后会迁移进凭据库。
- 默认权限预设是 `workspace-write`，并在聊天中审批。除非清楚后果，不要使用 `danger-full-access`。

## 在 Web 里

**掌上指挥台面板**（侧栏入口）

- **左栏**：所有线路的聊天，可搜索，显示每条线路的连接状态；有多条线路时每个聊天带线路标签；只被拦截过的陌生人带「未授权」标签。
- **右栏**：没选中聊天时显示概览，包括今日消息、7 天活跃聊天、审批和拦截次数，以及近 14 天的消息量图表。选中聊天后显示完整记录：气泡区分用户和机器人，图片直接显示，文件显示为卡片，工具调用和审批用紧凑样式，群聊可按成员筛选；**打开会话** 一键跳到绑定的会话。
- 右上角有 **插件设置** 按钮，发现新版本时旁边会出现 **新版本** 徽章。

![聊天记录](docs/images/panel-thread.png)

**会话内的掌上指挥台标签页**

每个会话里都有 **掌上指挥台** 标签页：
- 查看关联的聊天（任意线路），可以解除关联；
- 从已知聊天里选一个 **绑定**（聊天里发的消息交给本会话，回复也发回去）或 **订阅**（只收完成和审批通知）；
- 以机器人身份给绑定的聊天发消息，支持 Markdown；
- 查看本会话的聊天记录。

**Web 输入框里的 `/switchboard` 命令**

- `/switchboard`：列出当前会话关联的聊天和所有可用聊天。
- `/switchboard bind <聊天>`、`/switchboard watch <聊天>`、`/switchboard unbind [聊天]`、`/switchboard send <文字>`：分别是绑定、订阅、解除关联、发消息。`<聊天>` 可以是聊天 ID、`@用户名` 或标题的一部分。

命令在宿主上直接执行，不会进入模型上下文。

**提示词注入**

绑定了聊天的会话会注入一段简短说明，告诉模型：回复会在手机上的聊天软件里阅读，要简洁，长内容用文件交付。可以在设置里关闭或改写。这段说明用 `ctx.systemPrompt.context()` 注入，只作用于绑定的会话，对 KV 缓存友好。

## 模型

一个会话用哪个模型，按优先级从高到低决定：

1. 在聊天里用 `/model` 为这个会话选的模型；
2. 插件页「机器人默认模型」，作用于机器人新建的会话，可以附带推理强度；
3. Web 默认模型。

前两种方式都直接记在会话自身，**不会改变 Web 的默认模型**。`/model` 和 `/mode` 对当前不在内存中的会话做的选择会持久保存，在会话下次加载时（处理消息之前）生效。

## 定时任务推送

在 **定时任务推送聊天** 里填聊天（Telegram 填聊天 ID，其他线路填「线路:聊天 ID」）后，Harness 定时任务（自动化任务）运行时，Agent 的回复和回合摘要会发到这些聊天。

## 版本与更新

插件详情页（配置表单上方）有 **版本** 区块：显示当前版本和安装来源，可以 **检查更新**。

- **从 GitHub 安装**：检查默认分支最新提交里 `package.json` 的版本号。点 **更新到 vX.Y.Z** 后，插件管理器用最新提交就地重装。新提交第一次安装需要授权构建脚本，页面会列出要授权的条目，确认后继续。
- **从 npm 安装**：调用插件管理器原生的更新接口。
- **本地链接或来源不明**：只显示版本，不检查也不更新。

从旧包名 `dsh-telegram-bridge` 迁移的步骤见 [docs/PUBLISHING.md](docs/PUBLISHING.md)。

## 配置项

所有字段都可以在插件页修改，并即时生效；`pollTimeoutSec`、`stateFile` 除外，需要写在 profile 的 `cordis.patch.yml` 中。

| 分组 | 字段 | 默认值 | 说明 |
| --- | --- | --- | --- |
| 常规 | `enabled` | `true` | 总开关：关闭后断开所有线路 |
| | `language` | `zh` | 机器人提示语言（`zh` / `en`） |
| 线路 | `lines` | `[]` | 线路列表，见下表；为空时使用下方旧版 Telegram 字段组成的 `telegram` 线路 |
| 会话 | `workspacePath` | `''` | 新会话默认工作目录（线路可单独覆盖） |
| | `modelProvider` / `model` / `reasoningEffort` | 空 | 机器人新建会话的模型；为空跟随 Web 默认 |
| | `agentPreset` | `standard` | 新会话的 Agent 预设 |
| | `permissionPreset` | `workspace-write` | 新会话的权限预设 |
| | `channelPrompt` / `channelPromptText` | `true` / 空 | 是否注入聊天场景说明 / 自定义说明 |
| 消息与通知 | `streamReplies` | `true` | 边写边显示回复 |
| | `notifyToolCalls` | `true` | 显示工具活动消息 |
| | `turnSummary` / `turnSummaryMinSec` | `long` / `60` | 回合摘要：`off` / `long` / `always`，及长任务阈值 |
| | `scheduleChats` | `[]` | 定时任务结果推送的聊天 |
| | `alertChats` / `alertAfterMin` | `[]` / `5` | 掉线提醒的聊天（空则用定时任务推送聊天）/ 断开多少分钟后提醒（0 关闭） |
| 审批 | `approvalViaTelegram` | `true` | 在聊天中审批 |
| | `questionsViaTelegram` | `true` | 在聊天中回答 Agent 的提问 |
| | `approvalTimeoutSec` | `300` | 审批与提问的超时（10–3600 秒） |
| 文件与语音 | `sendDeliverables` | `true` | 把 `present` 交付的文件发回聊天 |
| | `maxDownloadMb` | `20` | 接收文件大小上限（1–2000 MB） |
| | `transcribeVoice` / `ffmpegPath` | `true` / `ffmpeg` | 语音转文字 / ffmpeg 路径 |
| 界面与记录 | `showPanel` / `showSessionTab` | `true` | 侧栏掌上指挥台入口 / 会话内标签页 |
| | `historyLimit` | `2000` | 每个聊天保留的记录条数 |
| （文件） | `pollTimeoutSec` | `30` | Telegram 长轮询等待秒数 |
| （文件） | `stateFile` | `$DSH_HOME/switchboard/state.json` | 绑定、订阅、待生效选择与轮询进度 |
| （旧版） | `botToken`、`botTokenRef`、`apiBaseUrl`、`allowedUsers`、`allowedChats`、`groupMentionOnly` | — | 0.5.5 之前的 Telegram 字段；设置页保存一次后写入 `lines` |

每条线路（`lines` 的一项）：

| 字段 | 说明 |
| --- | --- |
| `id` | 线路 ID，聊天键以它开头；创建后不要修改 |
| `type` | `telegram` 或 `feishu` |
| `name` | 显示名称；为空时显示平台名 |
| `enabled` | 是否运行 |
| `secretRef` | 凭据名称：Telegram Bot Token 或飞书 App Secret |
| `allowedUsers` / `allowedChats` | 允许的用户 / 允许的群 |
| `groupMentionOnly` | 群聊中只响应命令、@机器人、回复机器人 |
| `workspacePath` | 这条线路新会话的工作目录；为空用全局默认 |
| `apiBaseUrl` | Telegram：Bot API 地址（自建服务器或反代） |
| `appId` / `domain` | 飞书：App ID，以及 `feishu` 或 `lark` |

网络受限时，在启动 `dsh` 前设置 `HTTPS_PROXY` 即可，Harness 的出站代理策略会自动覆盖机器人的请求。

![设置页](docs/images/settings.png)

## 架构

```
src/index.ts                宿主入口：配置 schema（含线路）、凭据解析、接入 sessionController / agents / approval / user-questions / 可选服务
src/bridge.ts               核心：按线路运行渠道、命令、流式输出、工具活动、摘要与订阅、审批与提问（经 HarnessPort 解耦，可单测）
src/lines.ts                线路模型与聊天键
src/channels/types.ts       渠道接口：入站消息 / 按钮、发送 / 编辑 / 文件 / 下载
src/channels/telegram.ts    Telegram：长轮询、相册合并、@ 识别、HTML 渲染与回退
src/channels/feishu.ts      飞书：长连接事件、消息解析（文本 / 富文本 / 图片 / 文件 / 语音）、消息卡片
src/channels/feishu-api.ts  飞书开放平台接口：REST（fetch）与长连接（WebSocket），协议与官方 SDK 一致
src/channels/feishu-frame.ts 长连接帧（protobuf）编解码
src/markdown.ts             Markdown → Telegram HTML 与安全分段
src/telegram.ts             精简 Bot API 客户端（Node fetch，429 退避、文件下载、multipart 上传）
src/media.ts                附件提取、图片类型识别、回传方式选择
src/bindings.ts             绑定、订阅、待生效选择、各线路轮询进度的持久化
src/chatlog.ts              Web 查看器的聊天记录（JSONL + 索引 + 图片副本 + 每日统计）
src/routes.ts               owner-only 路由（ctx.connection.fetch）
src/command.ts              Web 输入框的 /switchboard 命令（ctx.commands）
src/updates.ts              版本检查（GitHub / npm，经宿主代理）
src/version.ts              安装来源解析与版本比较（宿主与浏览器共用）
src/client/                 浏览器半侧：面板、会话标签页、设置页（含线路编辑器）、版本区块
cordis.patch.yml            组合包层：插入 id 为 switchboard 的插件行
```

用到的扩展点：
- **事件**：`session/event`、`agent/assistant-stream`、`agent/status`、`agent/created`；
- **waterfall**：`approval/request`、`user-questions/request`，都以 prepend 方式先于 Web 应答，超时调用 `next()` 交回；
- **可选服务**：`ctx.systemPrompt.context`、`ctx.commands`、`ctx.credentials`、`ctx.speechToText`、`ctx.workspaceChanges`、`ctx.connection`，存在时才接入。
- **浏览器端 slot**：`sidebar.panellist`、`main`、`conversation.view`、`plugins.bundle.config`。

接入新渠道：实现 `src/channels/types.ts` 的 `Channel` 接口，在 `lines.ts` 的 `ChannelType` 和 `bridge.ts` 的 `startLine` 中登记，再在设置页的线路编辑器里加上它的凭据字段。

## 开发

需要相邻目录有已构建的 deepseek-harness 检出（`../deepseek-harness`），用于类型检查和加载器组合测试。

```sh
pnpm install
pnpm typecheck   # 宿主 + 浏览器两侧
pnpm test        # vitest：假 Bot API、假飞书开放平台 + 假 Harness；有相邻检出时还会跑真实 Loader 组合测试
pnpm build       # esbuild → lib/index.js 与 lib/client.js（客户端模块系统的 factory 格式）
```

`pnpm build` 同时是 `prepare` 脚本，所以可以直接从 Git 安装。发布到 npm 的准备事项见 [docs/PUBLISHING.md](docs/PUBLISHING.md)，版本变化见 [CHANGELOG.md](CHANGELOG.md)。
