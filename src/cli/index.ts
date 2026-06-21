#!/usr/bin/env node
/**
 * xfer — view and migrate AI coding sessions between Claude Code and Codex.
 *
 * Commands:
 *   xfer list [--agent claude|codex] [--cwd PATH] [--here] [--limit N]
 *   xfer view <sessionId> [--no-thinking] [--no-tools] [--full]
 *   xfer migrate <sessionId> --to claude|codex [--mode faithful|replay] [--cwd PATH] [--run]
 *   xfer switch --to claude|codex [--from claude|codex] [--cwd PATH] [--force] [--run]
 *   xfer sync [--cwd PATH]
 *   xfer watch [--cwd PATH] [--to claude|codex] [--from claude|codex] [--interval SECONDS] [--once]
 *   xfer web [--port N]
 *   xfer setup-mcp [--apply]
 */

import { spawn } from "node:child_process";
import { listSessions, loadSession } from "../core/index.js";
import { renderTimeline } from "../core/render.js";
import { migrate, type MigrateMode } from "../core/migrate.js";
import type { Agent } from "../core/model.js";
import { startWebServer } from "../web/server.js";
import { switchSession, syncStatus } from "../core/sync.js";
import { watchSessions } from "../core/watch.js";

interface Flags {
  _: string[];
  [k: string]: string | boolean | string[];
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      (flags._ as string[]).push(a);
    }
  }
  return flags;
}

function fmtDate(iso?: string): string {
  if (!iso) return "          ";
  return iso.slice(0, 16).replace("T", " ");
}

function cmdList(flags: Flags) {
  const agent = flags.agent as Agent | undefined;
  const cwd =
    flags.here ? process.cwd() : (flags.cwd as string | undefined);
  const limit = flags.limit ? parseInt(flags.limit as string, 10) : 30;
  const sessions = listSessions({ agent, cwd, limit });

  if (!sessions.length) {
    console.log("No sessions found.");
    return;
  }
  console.log(
    `Found ${sessions.length} session(s)` + (cwd ? ` in ${cwd}` : "") + ":\n"
  );
  for (const s of sessions) {
    const tag = s.agent === "claude" ? "claude" : "codex ";
    console.log(
      `${fmtDate(s.updatedAt)}  [${tag}]  ${s.sessionId}  (${s.turnCount} turns)`
    );
    const loc = s.cwd ? s.cwd.split(/[\\/]/).pop() : "?";
    console.log(`            ${loc} — ${(s.title || "(no title)").slice(0, 70)}`);
  }
  console.log(
    `\nView:    xfer view <sessionId>\nMigrate: xfer migrate <sessionId> --to claude|codex`
  );
}

function cmdView(flags: Flags) {
  const id = (flags._ as string[])[1];
  if (!id) return die("usage: xfer view <sessionId>");
  const session = loadSession(id);
  if (!session) return die(`Session not found: ${id}`);
  const out = renderTimeline(session, {
    maxChars: flags.full ? 0 : 2000,
    hideThinking: flags["no-thinking"] === true,
    hideTools: flags["no-tools"] === true,
  });
  console.log(out);
}

function cmdMigrate(flags: Flags) {
  const id = (flags._ as string[])[1];
  if (!id) return die("usage: xfer migrate <sessionId> --to claude|codex");
  const to = flags.to as Agent | undefined;
  if (to !== "claude" && to !== "codex")
    return die("--to must be 'claude' or 'codex'");
  const mode = (flags.mode as MigrateMode) || "faithful";

  const result = migrate(id, {
    to,
    mode,
    cwd: flags.cwd as string | undefined,
  });

  console.log(`✓ Migrated ${result.from} → ${result.to}  (mode: ${result.mode})`);
  console.log(`  New session: ${result.sessionId}`);
  console.log(`  File:        ${result.filePath}`);
  console.log(`  Turns:       ${result.turnsWritten}`);
  console.log(`\n  Resume with:\n    ${result.resumeCommand}`);

  if (flags.run) {
    console.log(`\nLaunching: ${result.resumeCommand}\n`);
    const [cmd, ...args] = result.resumeCommand.split(" ");
    const child = spawn(cmd, args, { stdio: "inherit", shell: true });
    child.on("exit", (code) => process.exit(code ?? 0));
  }
}

function cmdSwitch(flags: Flags) {
  const to = flags.to as Agent | undefined;
  if (to !== "claude" && to !== "codex") {
    return die("usage: xfer switch --to claude|codex [--from claude|codex] [--cwd PATH] [--force] [--run]");
  }
  const from = flags.from as Agent | undefined;
  if (from !== undefined && from !== "claude" && from !== "codex") {
    return die("--from must be 'claude' or 'codex'");
  }

  const result = switchSession({
    to,
    from,
    cwd: flags.cwd as string | undefined,
    mode: (flags.mode as MigrateMode) || "faithful",
    force: flags.force === true,
  });

  console.log(result.reused ? "✓ Existing migrated session found" : "✓ Created migrated session");
  console.log(`  Source: ${result.sourceAgent} ${result.sourceSessionId}`);
  console.log(`  Target: ${result.targetAgent} ${result.targetSessionId}`);
  if (result.targetFilePath) console.log(`  File:   ${result.targetFilePath}`);
  console.log(`  State:  ${result.statePath}`);
  if (result.note) console.log(`  Note:   ${result.note}`);
  console.log(`\n  Resume with:\n    ${result.resumeCommand}`);

  if (flags.run) {
    console.log(`\nLaunching: ${result.resumeCommand}\n`);
    const [cmd, ...args] = result.resumeCommand.split(" ");
    const child = spawn(cmd, args, { stdio: "inherit", shell: true });
    child.on("exit", (code) => process.exit(code ?? 0));
  }
}

function cmdSync(flags: Flags) {
  console.log(syncStatus((flags.cwd as string | undefined) || process.cwd()));
}

async function cmdWatch(flags: Flags) {
  const to = flags.to as Agent | undefined;
  if (to !== undefined && to !== "claude" && to !== "codex") {
    return die("--to must be 'claude' or 'codex'");
  }
  const from = flags.from as Agent | undefined;
  if (from !== undefined && from !== "claude" && from !== "codex") {
    return die("--from must be 'claude' or 'codex'");
  }
  const intervalSeconds = flags.interval
    ? Number.parseFloat(flags.interval as string)
    : 3;
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    return die("--interval must be a positive number of seconds");
  }
  await watchSessions({
    cwd: flags.cwd as string | undefined,
    to,
    from,
    intervalMs: Math.max(250, intervalSeconds * 1000),
    once: flags.once === true,
    mode: (flags.mode as MigrateMode) || "faithful",
    force: flags.force === true,
  });
}

async function cmdWeb(flags: Flags) {
  const port = flags.port ? parseInt(flags.port as string, 10) : 4178;
  await startWebServer(port);
}

function cmdSetupMcp(flags: Flags) {
  const serverPath = `${process.cwd().replace(/\\/g, "/")}/dist/mcp/server.js`;
  const claudeCmd = `claude mcp add xfer -- node "${serverPath}"`;
  const codexCmd = `codex mcp add xfer -- node "${serverPath}"`;
  const installedClaudeCmd = "claude mcp add xfer -- xfer-mcp";
  const installedCodexCmd = "codex mcp add xfer -- xfer-mcp";

  console.log("If installed globally with npm link/npm install -g:");
  console.log("  " + installedClaudeCmd);
  console.log("  " + installedCodexCmd);
  console.log("");
  console.log("For this local checkout, build first:");
  console.log("  npm run build");
  console.log("");
  console.log("Then register this checkout:");
  console.log(`  ${claudeCmd}`);
  console.log(`  ${codexCmd}`);

  if (flags.apply) {
    console.log("\nApplying MCP registrations...\n");
    runCommand(claudeCmd);
    runCommand(codexCmd);
  }
}

function runCommand(commandLine: string) {
  const child = spawn(commandLine, { stdio: "inherit", shell: true });
  child.on("exit", (code) => {
    if ((code ?? 1) !== 0) process.exit(code ?? 1);
  });
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function help() {
  console.log(`xfer — cross-CLI session viewer & migrator (Claude Code ⇄ Codex)

Usage:
  xfer list [--agent claude|codex] [--cwd PATH | --here] [--limit N]
  xfer view <sessionId> [--no-thinking] [--no-tools] [--full]
  xfer migrate <sessionId> --to claude|codex [--mode faithful|replay] [--cwd PATH] [--run]
  xfer switch --to claude|codex [--from claude|codex] [--cwd PATH] [--force] [--run]
  xfer sync [--cwd PATH]
  xfer watch [--cwd PATH] [--to claude|codex] [--from claude|codex] [--interval SECONDS] [--once]
  xfer web [--port N]
  xfer setup-mcp [--apply]
`);
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const cmd = (flags._ as string[])[0];
  switch (cmd) {
    case "list":
      return cmdList(flags);
    case "view":
      return cmdView(flags);
    case "migrate":
      return cmdMigrate(flags);
    case "switch":
      return cmdSwitch(flags);
    case "sync":
      return cmdSync(flags);
    case "watch":
      return cmdWatch(flags);
    case "web":
      return cmdWeb(flags);
    case "setup-mcp":
      return cmdSetupMcp(flags);
    case undefined:
    case "help":
    case "--help":
      return help();
    default:
      die(`Unknown command: ${cmd}\nRun 'xfer help' for usage.`);
  }
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
