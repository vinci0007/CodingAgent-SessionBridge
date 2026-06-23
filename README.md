# CodingAgent-SessionBridge

<p>
  <a href="./README.md">English</a>
  |
  <a href="./README.zh-CN.md">中文</a>
</p>

`xfer` is a lightweight desktop and CLI tool for inspecting, repairing, archiving, switching, and migrating AI coding sessions between Claude Code and Codex.

## What It Does

Claude Code and Codex both store local session history as JSONL files, but their formats, project indexes, and resume flows are different. `xfer` normalizes those histories into one session model and provides:

- Project-grouped session browsing for Claude and Codex.
- Full conversation rendering with user, assistant, tool, and reasoning blocks.
- Claude-to-Codex and Codex-to-Claude migration.
- Project-aware switch/sync mappings to avoid duplicate migrations.
- Desktop index verification for migrated sessions.
- Session ID lookup, including unreadable session files.
- Repair and rebuild flows for damaged sessions.
- Delete, backup archive, and archive restore operations with confirmation.
- Configurable data, state, log, temp, archive, and database locations.

## Storage Formats

| Agent | Default session location | Resume command |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` | `claude --resume <uuid>` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `codex resume <uuid>` |

`xfer` writes target-native session files where possible. When a source session is damaged, the repair flow first tries normal parsing, then falls back to recovering text from the raw JSONL transcript.

## Interfaces

### Desktop App

```bash
npm install
npm run app:dev
```

Desktop builds use Tauri and the system WebView. The production app does not expose a browser localhost URL and does not require Electron.

### CLI

```bash
npm install
npm run build
npm run xfer -- list --limit 20
node dist/cli/index.js view <sessionId>
```

### Web Viewer

```bash
npm run web
```

### MCP Server

```bash
npm run mcp
```

## Build

```bash
npm run build
npm run build:ui
cargo check --manifest-path src-tauri/Cargo.toml --locked
```

Platform packages:

```bash
npm run app:build:win      # Windows MSI + NSIS installer
npm run app:portable:win   # Windows portable exe folder
npm run app:build:mac      # macOS .app + .dmg
npm run app:portable:mac   # macOS portable binary folder
npm run app:build:linux    # Linux AppImage + deb + rpm
npm run app:portable:linux # Linux portable binary folder
```

Cross-platform packages must be built on the target operating system. GitHub Actions builds Windows, macOS, and Linux release artifacts automatically when the project version changes.

## Release Automation

This repository includes two GitHub Actions workflows:

- **PR Check**: builds TypeScript, Vite UI, and Rust on Windows, macOS, and Linux; also scans for blocked text and mojibake.
- **Release**: runs when `package.json` version changes on `main` or `master`, or when manually triggered. It creates a tag like `vX.Y.Z`, builds installer and portable artifacts for Windows, macOS, and Linux, and publishes a GitHub Release.

Release notes are generated from commits since the previous tag and include English and Chinese sections.

## Runtime Data

The desktop app lets you configure:

- Storage root
- State root
- Log root
- Temp root
- Backup archive root
- Database path
- Client executable paths
- Model aliases for gateway/API-name compatibility

Portable builds default runtime data beside the executable when writable. Archived sessions are moved out of normal agent session directories and are not indexed unless the archive view is opened.

## Safety Notes

- Delete and archive operations require a second confirmation with the exact file path.
- Archive restore refuses to overwrite an existing file at the original location.
- Repair creates a new session in the same agent instead of overwriting the damaged file.
- Desktop client visibility depends on each client refreshing its own index; `xfer` verifies local files and known desktop indexes where possible.

## Tech Stack

- Rust + Tauri for the desktop app and native session operations.
- TypeScript for shared UI, CLI, Web, and MCP surfaces.
- SQLite for migration mapping metadata.
- Vite for the frontend build.
