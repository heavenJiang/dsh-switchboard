# 发布到 npm（准备说明）

当前插件从 GitHub 安装（`github:heavenJiang/dsh-switchboard`），插件页的「版本」区块用 GitHub 检查与更新。发布到 npm 后，用户可以在 **添加插件** 里直接搜索安装，插件页原生的版本区块与一键更新也会可用。

## 需要先决定的事

1. **包名**：`dsh-switchboard` 在 npm 上尚未被占用，可以直接以不带作用域的名字发布（旧名 `dsh-telegram-bridge` 属于另一位作者）。
2. **账号**：发布需要你的 npm 账号；公开发布后，同一版本号不能再次发布。

## 从 dsh-telegram-bridge 迁移

0.5.4 起包名为 `dsh-switchboard`，插件行 id 为 `switchboard`。已安装旧包的 profile：

1. 在 profile 的 `cordis.patch.yml` 中把 `id: telegram-bridge` / `name: dsh-telegram-bridge` 改为 `id: switchboard` / `name: dsh-switchboard`，其余配置不变。
2. 卸载 `dsh-telegram-bridge`，安装 `github:heavenJiang/dsh-switchboard`。
3. 首次启动时，`$DSH_HOME/telegram-bridge/` 会自动移到 `$DSH_HOME/switchboard/`，绑定、聊天记录与媒体都会保留。凭据库里的 Token（`TELEGRAM_BOT_TOKEN`）不依赖包名，无需改动。

## 发布步骤

```sh
pnpm typecheck && pnpm test && pnpm build
npm pack --dry-run          # 检查打包内容：lib/、locale/、docs/、cordis.patch.yml、icon.svg、README
npm publish --access public
```

`prepare` 脚本会在发布前构建 `lib/`。每次发布前提升 `version`，并在 `CHANGELOG.md` 记录变化。
