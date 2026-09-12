<div align="center">
  <img src="apps/readest-app/src-tauri/icons/icon.png" alt="Logo" width="96" />
  <h1>Readest · 自用 Fork</h1>
</div>

fork 自 [readest/readest](https://github.com/readest/readest)（基线：上游 v0.12.6，`f6146c217`，2026-08-29），在官方功能之上按自己的阅读习惯定制的版本。日常主力：Android 阅读器 + Arch Linux 桌面。

## 本 Fork 的定制

- **AI 阅读助手** — 多角色（头像库、聊天背景、一键模板）、多供应商连接、整套系统提示词可编辑、MCP 工具服务器、朗读 AI 回复、配置整体导入导出
- **生词本** — 查词收藏（全词典释义快照 + 语境句子）、英文词形归并（running/ran → run）、正文生词高亮标记、点击打开详情、打开弹窗自动发音（与"朗读文章"同引擎/同声音/同语速）
- **桌面 Linux 适配** — 默认 X11 + 软件渲染；应用 HTTP 走系统代理
- **阅读体验** — 背景图定时轮换、自选轮换图集

完整清单（52 个提交、逐条附提交哈希）见 [FORK-CHANGES.md](./FORK-CHANGES.md)。

## 文档

| 文档 | 内容 |
|------|------|
| [FORK-CHANGES.md](./FORK-CHANGES.md) | 相对上游的全部功能更新 |
| [FORK-GUIDE.md](./FORK-GUIDE.md) | 构建环境、出包脚本、签名密钥、常见坑（会话交接文档） |
| [ROADMAP.md](./ROADMAP.md) | 功能规划、排队与搁置记录 |

## 构建

日常出包一条命令，产物自动归集到仓库根 `releases/`（目录已 gitignore）：

```bash
./scripts/release-artifacts.sh apk       # Android arm64（~82MB）
./scripts/release-artifacts.sh appimage  # Linux x86_64
./scripts/release-artifacts.sh both
```

本地开发（Web UI 验证）：

```bash
pnpm install
cd apps/readest-app && pnpm dev-web
```

完整环境要求（JDK17、Android SDK/NDK、Rust target、签名密钥等）与流程细节见 [FORK-GUIDE.md](./FORK-GUIDE.md)。Android 包名为 `com.bilingify.readest.dev`，可与官方版共存安装。

## 与上游同步

```bash
git fetch upstream
git merge upstream/main
```

## 许可

继承上游 [AGPL-3.0](./LICENSE)。
