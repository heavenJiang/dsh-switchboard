# 发布到 npm（准备说明）

当前插件从 GitHub 安装（`github:heavenJiang/dsh-telegram-bridge`），插件页的「版本」区块用 GitHub 检查与更新。发布到 npm 后，用户可以在 **添加插件** 里直接搜索安装，插件页原生的版本区块与一键更新也会可用。

## 需要先决定的事

1. **包名**：npm 上的 `dsh-telegram-bridge` 已被另一位作者占用，需要改用带作用域的名字，例如 `@heavenjiang/dsh-telegram-bridge`。
2. **迁移影响**：改名后，已从 GitHub 安装的用户需要卸载旧包、按新名字重新安装。配置（profile 中 `telegram-bridge` 行）和数据（`$DSH_HOME/telegram-bridge/`、凭据库里的 Token）都会保留，因为它们不依赖包名。
3. **账号**：发布需要你的 npm 账号与作用域权限，公开发布后不可撤回同一版本号。

## 改名时需要同步修改的地方

- `package.json`：`name`，并加 `"publishConfig": { "access": "public" }`。
- `cordis.patch.yml`：`name: dsh-telegram-bridge` 改为新包名（行 `id: telegram-bridge` 保持不变，配置因此得以保留）。
- `src/client/index.tsx`：`PACKAGE` 常量（插件页的配置区按包名挂载）。
- README 中的安装命令。

## 发布步骤

```sh
pnpm typecheck && pnpm test && pnpm build
npm pack --dry-run          # 检查打包内容：lib/、locale/、docs/、cordis.patch.yml、icon.svg、README
npm publish --access public
```

`prepare` 脚本会在发布前构建 `lib/`。每次发布前提升 `version`，并在 `CHANGELOG.md` 记录变化。
