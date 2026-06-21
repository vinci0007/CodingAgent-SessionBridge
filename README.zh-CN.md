# CodingAgent-SessionBridge

<p>
  <a href="./README.md">English</a>
  |
  <a href="./README.zh-CN.md">中文</a>
</p>

`xfer` 是一个轻量桌面端与 CLI 工具，用于在 Claude Code 与 Codex 之间查看、修复、归档、切换、同步和迁移 AI 编程会话。

推荐仓库名：**CodingAgent-SessionBridge**。可执行文件和包名仍然保留为 **xfer**，因为日常命令更短、更好输入。

## 功能

Claude Code 与 Codex 都会把本地会话保存为 JSONL，但格式、项目索引和恢复方式都不同。`xfer` 会把两边历史统一成一个会话模型，并提供：

- 按项目分组浏览 Claude 与 Codex 会话。
- 展示完整对话历史，包括用户、助手、工具、推理内容。
- Claude 到 Codex、Codex 到 Claude 的会话迁移。
- 按项目记录 switch/sync 映射，避免重复迁移。
- 迁移后验证目标桌面端索引。
- 通过会话 ID 检索，包括无法解析的损坏会话文件。
- 损坏会话修复与重建。
- 会话删除、备份归档、归档恢复，并带二次确认。
- 可自定义 data/state/log/temp/archive/database 等目录。

## 会话存储格式

| Agent | 默认会话位置 | 恢复命令 |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` | `claude --resume <uuid>` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `codex resume <uuid>` |

`xfer` 会尽量写入目标客户端原生格式。损坏会话修复会先尝试正常解析；如果失败，再从原始 JSONL 中抽取文本 transcript 重建。

## 使用入口

### 桌面 App

```bash
npm install
npm run app:dev
```

桌面端基于 Tauri 和系统 WebView。生产版本不会暴露浏览器 localhost 地址，也不使用 Electron。

### CLI

```bash
npm install
npm run build
npm run xfer -- list --limit 20
node dist/cli/index.js view <sessionId>
```

### Web 查看器

```bash
npm run web
```

### MCP Server

```bash
npm run mcp
```

## 构建

```bash
npm run build
npm run build:ui
cargo check --manifest-path src-tauri/Cargo.toml --locked
```

平台包：

```bash
npm run app:build:win      # Windows MSI + NSIS 安装包
npm run app:portable:win   # Windows portable exe 目录
npm run app:build:mac      # macOS .app + .dmg
npm run app:portable:mac   # macOS portable 二进制目录
npm run app:build:linux    # Linux AppImage + deb + rpm
npm run app:portable:linux # Linux portable 二进制目录
```

跨平台包需要在对应系统上构建。GitHub Actions 会在项目版本号变化时自动构建 Windows、macOS、Linux 的 release 产物。

## 自动发布

仓库包含两个 GitHub Actions workflow：

- **PR Check**：在 Windows、macOS、Linux 上构建 TypeScript、Vite UI、Rust，并扫描禁用文本与乱码。
- **Release**：当 `package.json` 版本号在 `main` 或 `master` 上变化时运行，也支持手动触发。它会创建 `v0.1.0` 这种 tag，构建 Windows、macOS、Linux 的安装包与 portable 包，并发布 GitHub Release。

Release notes 会根据上一个 tag 以来的 commit 自动生成，并包含英文与中文两段。

## 运行数据目录

桌面端可以设置：

- 存储根目录
- 状态目录
- 日志目录
- 临时目录
- 备份归档目录
- 数据库路径
- 客户端可执行文件路径
- 用于中转站/API 模型名兼容的模型别名

portable 版本默认会把运行数据放在 exe 同级可写目录。归档会话会从正常 agent 会话目录移走，只有打开归档视图时才索引。

## 安全说明

- 删除和归档都会显示确切路径并要求二次确认。
- 归档恢复不会覆盖原位置已经存在的文件。
- 修复会话会创建同客户端的新会话，不覆盖损坏原文件。
- 目标桌面客户端能否立刻显示迁移结果取决于它自己的索引刷新机制；`xfer` 会尽量验证本地文件和已知桌面端索引。

## 技术栈

- Rust + Tauri：桌面端与原生会话操作。
- TypeScript：共享 UI、CLI、Web、MCP。
- SQLite：迁移映射元数据。
- Vite：前端构建。
