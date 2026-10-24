# dsh-telegram-bridge

[English](README.md) | 中文

用 Telegram 机器人遥控 DeepSeek Harness：发消息、图片和文件给 Agent，接收 Agent 交付的文件，中止任务、切换工作目录与会话，并直接在 Telegram 里点按钮审批工具调用。

机器人是 Web Host 的另一个客户端：它通过 `ctx.sessionController`（与 Web 界面走同一条路径）创建会话和发送提示，所以 Telegram 里开的会话会出现在 Web 侧栏中，Web 端的会话也可以用 `/use` 接管。

## 快速开始

1. 在 Telegram 找 [@BotFather](https://t.me/BotFather)，发送 `/newbot` 创建机器人，复制 Token。
2. 安装到 profile（Web 组合包，例如 `web`）：

   ```sh
   dsh plugin --profile web add /path/to/dsh-telegram-bridge
   dsh web
   ```

   也可以在 Web 侧栏 **插件 → 添加插件** 中填入本地路径或 Git 地址安装。
3. 打开 Web 侧栏 **插件**，在「已安装插件」分组（列表靠下，在内置插件和实验性插件之后）点击 **Telegram 遥控** 卡片，在详情页中填写：
   - **Bot Token**
   - **允许的用户**：你的 Telegram 用户 ID（不知道就先给机器人发 `/whoami`）
   - **默认工作目录**：新会话使用的绝对路径
4. 点击 **保存**。配置即时生效，无需重启。

## 机器人命令

| 命令 | 作用 |
| --- | --- |
| 直接发文字 | 发给当前会话；没有会话时自动在默认工作目录新建 |
| 发图片 / 文件 | 作为附件交给当前会话，图片说明作为文字（见下文） |
| `/new [目录]` | 新建会话 |
| `/cwd <目录>` | 设置本聊天新会话的工作目录 |
| `/use <会话ID>` | 切换到已有会话（含 Web 端会话） |
| `/sessions` | 最近的会话 |
| `/stop` | 中止当前工作 |
| `/steer <文字>` | 在正在进行的轮次中途插话引导 |
| `/status` | 当前会话、工作目录与运行状态 |
| `/whoami` | 显示你的用户 ID 与聊天 ID（任何人可用） |
| 其他 `/xxx` | 原样交给 Agent（例如 `/plan …`、skill 命令） |

Agent 的文字回复、工具调用提示（可关闭）、出错/中止提示会推送回绑定的聊天；运行时显示「正在输入」。

## 图片与文件

**发给 Agent**：照片、文件（document）、视频、音频、语音、视频消息、静态贴纸都可以直接发给机器人。

- 机器人通过 Bot API 下载后，用 `ctx.fileUploads` 暂存进当前会话——与 Web 输入框添加附件是同一条路径，受部署的附件限制约束。
- 图片（JPEG / PNG / GIF / WebP，按文件头字节识别，不信任发送方声明的类型）走图片通道，模型直接看图；部署不接受的图片以及其他类型作为文件交给 Agent。
- 图片说明（caption）作为同一条 prompt 的文字。相册（一次发送多张）合并成一条 prompt。
- 超过 **接收文件大小上限** 的文件不会下载，机器人会说明原因。官方 Bot API 最多只能下载 20 MB；要接收更大的文件，需要自建 [Bot API 服务器](https://github.com/tdlib/telegram-bot-api) 并修改 **Bot API 地址**。

**发回 Telegram**：Agent 用 `present` 工具交付文件时（Web 端「产出物」显示的同一事件），机器人把文件发到绑定的聊天：常见图片直接显示（≤10 MB，GIF 除外），其他作为文件发送，附带文件名和说明。超过 Telegram 50 MB 上限的文件只发一条提示。可用 **回传交付文件** 关闭。

## 在 Web 中查看聊天记录

侧栏的 **Telegram** 入口打开聊天记录查看器（插件运行时才出现）：

- **左栏**：所有与机器人对话过的聊天（私聊、群组），显示最后一条消息和时间，可搜索；只被拦截过的陌生人带「未授权」标签。顶部显示机器人连接状态。
- **右栏**：选中聊天的完整记录，按天分隔。用户消息在左、机器人消息在右；照片直接显示（点击看原图），文件显示为文件卡片；工具调用、提示、被拦截的消息用紧凑的单行显示；工具审批显示为卡片，带参数、原因、结果和操作人。
- **打开会话**：一键跳到该聊天绑定的 Web 会话。
- 页面每 3 秒刷新一次，停留在底部时自动跟随新消息；向上可加载更早的记录。窄窗口下变为单栏，带返回按钮。

记录保存在 `$DSH_HOME/telegram-bridge/chats/`（每个聊天一个 JSONL 文件，收到的图片另存一份供显示），不会进入会话上下文。每个聊天保留的条数由 **每个聊天保留的记录条数** 控制，超出后清理最早的记录和图片。查询接口 `/api/telegram-bridge/*` 只有已登录的 owner 能访问。

## 工具审批

开启 **在 Telegram 中审批工具调用** 后，绑定到某个聊天的会话需要审批时，机器人会发送带 **允许一次 / 拒绝** 按钮的消息（附带命令或参数预览）。只有允许列表中的用户能按。超过 **审批超时** 未回答，问题交回 Web 界面；会话撤回请求时消息会标记为已撤回。

## 配置项

全部字段都是 volatile，可在插件页修改并即时生效（`pollTimeoutSec`、`stateFile` 除外，需写在 profile 的 `cordis.patch.yml` 中）。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 是否运行机器人 |
| `botToken` | — | 机器人 Token，`role('secret')`，不会回传浏览器 |
| `allowedUsers` | `[]` | 允许的用户 ID 或 `@用户名`；为空则拒绝所有人 |
| `workspacePath` | `''` | 新会话默认工作目录 |
| `agentPreset` | `standard` | 新会话的 Agent 预设 |
| `permissionPreset` | `workspace-write` | 新会话的权限预设；为空沿用部署默认 |
| `approvalViaTelegram` | `true` | 在 Telegram 中审批 |
| `approvalTimeoutSec` | `300` | 审批超时（10–3600 秒） |
| `notifyToolCalls` | `true` | 推送工具调用 |
| `language` | `zh` | 机器人提示语言（`zh` / `en`） |
| `apiBaseUrl` | `https://api.telegram.org` | Bot API 地址（自建服务器或反代） |
| `maxDownloadMb` | `20` | 接收文件大小上限（1–2000 MB） |
| `sendDeliverables` | `true` | 把 `present` 交付的文件发回聊天 |
| `historyLimit` | `2000` | Web 聊天记录中每个聊天保留的条数（100–100000） |
| `pollTimeoutSec` | `30` | 长轮询等待秒数 |
| `stateFile` | `$DSH_HOME/telegram-bridge/state.json` | 聊天↔会话绑定与轮询进度 |

网络受限时，启动 `dsh` 前设置 `HTTPS_PROXY` 即可，Harness 的出站代理策略会自动覆盖机器人请求。

## 安全

- 机器人能让 Agent 在本机执行工具，**务必只把自己的用户 ID 加入允许列表**。列表为空时拒绝所有人。
- 默认使用 `workspace-write` 权限预设并在 Telegram 中审批；除非清楚后果，不要使用 `danger-full-access`。
- Token 以 secret 字段保存在 profile 的 `cordis.patch.yml` 中（与其他插件密钥相同），Web 客户端永远读不到它。

## 架构

```
src/index.ts      宿主半侧：Config schema、接入 sessionController / agents / approval
src/bridge.ts     桥接核心：长轮询、命令、输出镜像、审批（经 HarnessPort 解耦，可单测）
src/telegram.ts   精简 Bot API 客户端（Node fetch，含文件下载与 multipart 上传）
src/media.ts      附件提取、图片类型识别、回传方式选择
src/bindings.ts   聊天↔会话绑定与 update offset 的持久化
src/chatlog.ts    Web 查看器用的聊天记录（JSONL + 索引 + 图片副本，按条数清理）
src/routes.ts     查看器的 owner-only 查询路由（ctx.connection.fetch）
src/client/       浏览器半侧：侧栏 Telegram 聊天记录面板（sidebar.panellist + main）与配置表单（plugins.bundle.config）
cordis.patch.yml  组合包层：插入 id 为 telegram-bridge 的插件行
```

用到的扩展点与服务：`ctx.fileUploads`（暂存附件）、`session/event`（镜像助手输出、工具调用、`deliverables/presented`、轮次结束）、`agent/status`（输入中提示）、`approval/request`（prepend 应答者，超时 `next()` 交回）、`loader/volatile-update`（Token/开关变更时重连）。

## 开发

需要相邻目录有已构建的 deepseek-harness 检出（`../deepseek-harness`），仅用于类型检查。

```sh
pnpm install
pnpm typecheck   # 宿主 + 浏览器两侧
pnpm test        # vitest，假 Bot API + 假 Harness
pnpm build       # esbuild → lib/index.js 与 lib/client.js（客户端模块系统 factory 格式）
```

`pnpm build` 也是 `prepare` 脚本，因此可直接从 Git 安装（首次需要在 profile 的 `pnpm-workspace.yaml` 中 `allowBuilds` 授权）。
