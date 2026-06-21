/**
 * Polling watcher for near-seamless xfer workflows.
 *
 * This intentionally avoids low-level filesystem watching in the first release:
 * Claude/Codex append JSONL while turns are active, so a conservative interval
 * poll plus existing `switchSession` mapping reuse is safer than reacting to
 * every write event.
 */

import type { Agent, SessionIndexEntry } from "./model.js";
import { listSessions } from "./index.js";
import { defaultProjectCwd, latestForCwd, otherAgent } from "./sync-state.js";
import { switchSession, type SwitchResult } from "./sync.js";
import type { MigrateMode } from "./migrate.js";

export interface WatchOptions {
  cwd?: string;
  to?: Agent;
  from?: Agent;
  intervalMs?: number;
  once?: boolean;
  mode?: MigrateMode;
  force?: boolean;
  onEvent?: (event: WatchEvent) => void;
}

export type WatchEvent =
  | { type: "status"; message: string }
  | { type: "latest"; agent: Agent; session?: SessionIndexEntry }
  | { type: "switched"; result: SwitchResult }
  | { type: "error"; error: string };

export async function watchSessions(opts: WatchOptions = {}): Promise<void> {
  const cwd = defaultProjectCwd(opts.cwd);
  const intervalMs = opts.intervalMs ?? 3000;
  const emit = opts.onEvent ?? defaultEventLogger;
  const seen = new Map<Agent, string>();

  emit({ type: "status", message: `Watching ${cwd}` });
  if (opts.to) {
    emit({
      type: "status",
      message: `Auto-switch enabled: ${opts.from || otherAgent(opts.to)} → ${opts.to}`,
    });
  }

  while (true) {
    try {
      const agents: Agent[] = opts.to
        ? [opts.from || otherAgent(opts.to)]
        : ["claude", "codex"];

      for (const agent of agents) {
        const latest = latestForCwd(listSessions({ agent }), cwd, agent);
        const key = latest ? `${latest.sessionId}:${latest.updatedAt || ""}:${latest.turnCount || 0}` : "none";
        if (seen.get(agent) !== key) {
          seen.set(agent, key);
          emit({ type: "latest", agent, session: latest });
          if (opts.to && latest) {
            const result = switchSession({
              to: opts.to,
              from: agent,
              cwd,
              mode: opts.mode || "faithful",
              force: opts.force === true,
            });
            emit({ type: "switched", result });
          }
        }
      }
    } catch (e) {
      emit({ type: "error", error: e instanceof Error ? e.message : String(e) });
    }

    if (opts.once) return;
    await sleep(intervalMs);
  }
}

function defaultEventLogger(event: WatchEvent) {
  switch (event.type) {
    case "status":
      console.log(event.message);
      break;
    case "latest":
      if (event.session) {
        console.log(
          `[${new Date().toLocaleTimeString()}] latest ${event.agent}: ${event.session.sessionId} (${event.session.turnCount} turns)`
        );
      } else {
        console.log(`[${new Date().toLocaleTimeString()}] latest ${event.agent}: none`);
      }
      break;
    case "switched":
      console.log(
        `  ${event.result.reused ? "reused" : "created"} ${event.result.targetAgent}: ${event.result.targetSessionId}`
      );
      console.log(`  resume: ${event.result.resumeCommand}`);
      break;
    case "error":
      console.error(`watch error: ${event.error}`);
      break;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
