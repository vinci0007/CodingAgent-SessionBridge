#!/usr/bin/env node
/**
 * JSON command bridge used by the Tauri app.
 *
 * The app keeps xfer's TypeScript core as the source of truth. Tauri commands
 * spawn this bridge with a fixed command name and JSON args, then return the JSON
 * result to the WebView. No localhost server is involved.
 */

import { listSessions, loadSession, indexStatus } from "../core/index.js";
import { migrate } from "../core/migrate.js";
import { switchSession, syncStatus } from "../core/sync.js";
import type { Agent } from "../core/model.js";
import type { MigrateMode } from "../core/migrate.js";
import { logEvent } from "../core/logging.js";

interface BridgeResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
  });
}

function parseArgs(raw: string | undefined): any {
  if (!raw || !raw.trim()) return {};
  return JSON.parse(raw);
}

function write(response: BridgeResponse) {
  process.stdout.write(JSON.stringify(response));
}

async function main() {
  const command = process.argv[2];
  const inlineArgs = process.argv[3];
  const args = parseArgs(inlineArgs ?? (await readStdin()));
  logEvent("bridge:start", { command });

  let result: unknown;
  switch (command) {
    case "list_sessions":
      result = listSessions({
        agent: args.agent as Agent | undefined,
        cwd: args.cwd as string | undefined,
        limit: args.limit as number | undefined,
      });
      break;
    case "get_session": {
      if (!args.sessionId) throw new Error("sessionId is required");
      const session = loadSession(String(args.sessionId));
      if (!session) throw new Error(`Session not found: ${args.sessionId}`);
      result = session;
      break;
    }
    case "migrate_session":
      if (!args.sessionId) throw new Error("sessionId is required");
      if (args.to !== "claude" && args.to !== "codex") {
        throw new Error("to must be 'claude' or 'codex'");
      }
      result = migrate(String(args.sessionId), {
        to: args.to as Agent,
        mode: (args.mode as MigrateMode) || "faithful",
        cwd: args.cwd as string | undefined,
      });
      break;
    case "switch_session":
      if (args.to !== "claude" && args.to !== "codex") {
        throw new Error("to must be 'claude' or 'codex'");
      }
      result = switchSession({
        to: args.to as Agent,
        from: args.from as Agent | undefined,
        cwd: args.cwd as string | undefined,
        sourceSessionId: args.sourceSessionId as string | undefined,
        mode: (args.mode as MigrateMode) || "faithful",
        force: args.force === true,
      });
      break;
    case "sync_status":
      result = { text: syncStatus(args.cwd as string | undefined) };
      break;
    case "index_status":
      result = indexStatus();
      break;
    default:
      throw new Error(`Unknown bridge command: ${command}`);
  }

  logEvent("bridge:success", { command });
  write({ ok: true, result });
  process.exit(0);
}

main().catch((error) => {
  logEvent("bridge:error", { error: error instanceof Error ? error.message : String(error) });
  write({ ok: false, error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
