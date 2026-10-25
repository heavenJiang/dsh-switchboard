**掌上指挥台**：在手机上通过 Telegram、飞书机器人指挥 Harness 的 Agent——发文字、图片、文件和语音下达任务，边写边看回复，在聊天里审批工具调用、回答 Agent 的提问，订阅长任务通知。侧栏 **掌上指挥台** 查看对话记录，每个会话的 **掌上指挥台** 标签页可关联聊天。

**配置步骤**：在下方 **线路** 里添加 Telegram 线路（找 [@BotFather](https://t.me/BotFather) 创建机器人获得 Token）或飞书线路（企业自建应用的 App ID 与 App Secret，需开启机器人能力并用长连接接收事件），填写 **允许的用户**（给机器人发 `/whoami` 查看自己的 ID）和 **默认工作目录**，然后点 **保存**，即时生效。

完整说明见 [README](https://github.com/heavenJiang/dsh-switchboard/blob/main/README.zh.md)。
