# 发布到 npm

包名 `dsh-switchboard`（不带作用域，公开发布）。发布后可以用 `dsh plugin --profile web add dsh-switchboard` 安装；npm 包里是构建好的 `lib/`，安装时不需要授权构建脚本。插件页的版本检查与更新会改走 npm。

> 在 npm 上可以搜到，不等于出现在 Harness 的「插件市场 / 发现」里：插件市场读取用户配置的插件索引，不搜索 npm。要出现在发现页，需另外提交到社区索引。

## 每次发布

1. 提升 `package.json` 的 `version`（小版本递增，例如 0.5.15 → 0.5.16），在 `CHANGELOG.md` 记录变化，提交并推送。
2. 确认登录：`npm whoami`；未登录时运行 `npm login`。
3. 发布：

   ```sh
   npm publish
   ```

   `prepublishOnly` 会先运行类型检查、全部测试和构建，任何一步失败都不会发布。账号开启了两步验证时，按提示输入验证码（或加 `--otp 123456`）。

4. 核对：`npm view dsh-switchboard version`。

发布前可以用 `npm pack --dry-run` 查看会发布哪些文件：`lib/`、`locale/`、`cordis.patch.yml`、`icon.svg`、`docs/*.md`、README、CHANGELOG。源码、测试和截图不在包里（npm 页面上的 README 图片取自 GitHub）。

**注意**：同一个版本号只能发布一次，撤回后也不能重用。

## 从 GitHub 安装切换到 npm

已从 GitHub 安装的 profile：

```sh
dsh plugin --profile web remove dsh-switchboard
dsh plugin --profile web add dsh-switchboard
```

配置（profile 中的 `switchboard` 行）、数据（`$DSH_HOME/switchboard/`）和凭据库里的密钥都不依赖安装来源，保持不变。

## 从 dsh-telegram-bridge 迁移

0.5.4 起包名为 `dsh-switchboard`，插件行 id 为 `switchboard`。已安装旧包的 profile：

1. 在 profile 的 `cordis.patch.yml` 中把 `id: telegram-bridge` / `name: dsh-telegram-bridge` 改为 `id: switchboard` / `name: dsh-switchboard`，其余配置不变。
2. 卸载 `dsh-telegram-bridge`，安装 `dsh-switchboard`。
3. 首次启动时，`$DSH_HOME/telegram-bridge/` 会自动移到 `$DSH_HOME/switchboard/`，绑定、聊天记录与媒体都会保留。凭据库里的 Token（`TELEGRAM_BOT_TOKEN`）不依赖包名，无需改动。
