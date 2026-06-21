#!/usr/bin/env node
/**
 * Minimal smoke tests for xfer.
 *
 * These tests avoid writing to the user's real Claude/Codex homes by setting
 * CLAUDE_CONFIG_DIR and CODEX_HOME to temporary directories for migration checks.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { listSessions, loadSession } from "../src/core/index.js";
import { renderTimeline } from "../src/core/render.js";
import { migrate } from "../src/core/migrate.js";
import { writeClaudeSession } from "../src/core/write.js";
import { switchSession, syncStatus } from "../src/core/sync.js";
import { watchSessions } from "../src/core/watch.js";

function mktemp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function pick(agent: "claude" | "codex") {
  const session = listSessions({ agent, limit: 1 })[0];
  assert.ok(session, `expected at least one ${agent} session`);
  return session;
}

const realEnv = { ...process.env };
const claude = pick("claude");
const codex = pick("codex");

const claudeSession = loadSession(claude.sessionId);
const codexSession = loadSession(codex.sessionId);
assert.ok(claudeSession, "loads a Claude session");
assert.ok(codexSession, "loads a Codex session");
assert.match(renderTimeline(claudeSession, { maxChars: 500 }), /Session/);
assert.match(renderTimeline(codexSession, { maxChars: 500 }), /Session/);

const tmpClaude = mktemp("xfer-smoke-claude-");
const tmpCodex = mktemp("xfer-smoke-codex-");
const tmpProject = mktemp("xfer-smoke-project-");

function restoreEnv(key: "CLAUDE_CONFIG_DIR" | "CODEX_HOME") {
  const value = realEnv[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

try {
  restoreEnv("CLAUDE_CONFIG_DIR");
  process.env.CODEX_HOME = tmpCodex;

  const toCodex = migrate(claude.sessionId, {
    to: "codex",
    cwd: claude.cwd || process.cwd(),
  });
  assert.equal(toCodex.to, "codex");
  assert.ok(fs.existsSync(toCodex.filePath), "writes migrated Codex session");
  assert.ok(
    path.resolve(toCodex.filePath).startsWith(path.resolve(tmpCodex)),
    "writes Codex migration under temp CODEX_HOME"
  );

  process.env.CLAUDE_CONFIG_DIR = tmpClaude;
  restoreEnv("CODEX_HOME");

  const toClaude = migrate(codex.sessionId, {
    to: "claude",
    cwd: codex.cwd || process.cwd(),
  });
  assert.equal(toClaude.to, "claude");
  assert.ok(fs.existsSync(toClaude.filePath), "writes migrated Claude session");
  assert.ok(
    path.resolve(toClaude.filePath).startsWith(path.resolve(tmpClaude)),
    "writes Claude migration under temp CLAUDE_CONFIG_DIR"
  );

  process.env.CLAUDE_CONFIG_DIR = tmpClaude;
  process.env.CODEX_HOME = tmpCodex;
  const fixture = writeClaudeSession(
    {
      meta: {
        agent: "claude",
        sessionId: "fixture-source",
        filePath: "fixture",
        cwd: tmpProject,
        title: "fixture",
      },
      turns: [
        {
          id: "u1",
          role: "user",
          blocks: [{ kind: "text", text: "Continue this fixture task." }],
          timestamp: new Date().toISOString(),
        },
        {
          id: "a1",
          role: "assistant",
          blocks: [{ kind: "text", text: "Fixture task acknowledged." }],
          timestamp: new Date().toISOString(),
        },
      ],
    },
    { cwd: tmpProject }
  );
  assert.ok(fixture.sessionId, "writes fixture Claude session");
  const switched = switchSession({ to: "codex", cwd: tmpProject });
  assert.equal(switched.sourceAgent, "claude");
  assert.equal(switched.targetAgent, "codex");
  assert.ok(switched.targetFilePath && fs.existsSync(switched.targetFilePath));
  assert.match(syncStatus(tmpProject), /Mappings:/);

  const watchEvents: string[] = [];
  await watchSessions({
    cwd: tmpProject,
    to: "codex",
    once: true,
    onEvent: (event) => watchEvents.push(event.type),
  });
  assert.ok(watchEvents.includes("latest"), "watch reports latest session");
  assert.ok(watchEvents.includes("switched"), "watch triggers mapped switch");

  const help = execFileSync("node", ["--import", "tsx", "src/cli/index.ts", "help"], {
    cwd: process.cwd(),
    env: realEnv,
    encoding: "utf8",
  });
  assert.match(help, /setup-mcp/);

  console.log("xfer smoke tests passed.");
} finally {
  restoreEnv("CLAUDE_CONFIG_DIR");
  restoreEnv("CODEX_HOME");
  fs.rmSync(tmpClaude, { recursive: true, force: true });
  fs.rmSync(tmpCodex, { recursive: true, force: true });
  fs.rmSync(tmpProject, { recursive: true, force: true });
}
