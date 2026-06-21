/**
 * Project-local sync state for near-seamless switching.
 *
 * xfer intentionally keeps sync metadata out of Claude/Codex internals. The map
 * only records which source session has already been migrated to which target
 * session for a given cwd, so `switch` can reuse existing destinations instead
 * of duplicating sessions every time.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Agent, SessionIndexEntry } from "./model.js";
import { configuredStatePath } from "./settings.js";
import { normalizeProjectCwd } from "./paths.js";

export interface SessionMapEntry {
  cwd: string;
  sourceAgent: Agent;
  sourceSessionId: string;
  targetAgent: Agent;
  targetSessionId: string;
  targetFilePath: string;
  createdAt: string;
  sourceUpdatedAt?: string;
}

export interface SyncState {
  version: 1;
  mappings: SessionMapEntry[];
}

export function statePath(cwd = process.cwd()): string {
  return configuredStatePath(cwd) || path.join(cwd, ".xfer", "state.json");
}

export function loadState(cwd = process.cwd()): SyncState {
  const file = statePath(cwd);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as SyncState;
  } catch {
    return { version: 1, mappings: [] };
  }
}

export function saveState(state: SyncState, cwd = process.cwd()): void {
  const file = statePath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.state-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

export function findMapping(
  state: SyncState,
  sourceAgent: Agent,
  sourceSessionId: string,
  targetAgent: Agent
): SessionMapEntry | undefined {
  return state.mappings.find(
    (m) =>
      m.sourceAgent === sourceAgent &&
      m.sourceSessionId === sourceSessionId &&
      m.targetAgent === targetAgent
  );
}

export function upsertMapping(
  state: SyncState,
  entry: SessionMapEntry
): SyncState {
  const next = state.mappings.filter(
    (m) =>
      !(
        m.sourceAgent === entry.sourceAgent &&
        m.sourceSessionId === entry.sourceSessionId &&
        m.targetAgent === entry.targetAgent
      )
  );
  next.push(entry);
  next.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { version: 1, mappings: next };
}

export function latestForCwd(
  sessions: SessionIndexEntry[],
  cwd: string,
  agent?: Agent
): SessionIndexEntry | undefined {
  const target = normalizeCwd(cwd);
  return sessions
    .filter((s) => (!agent || s.agent === agent) && s.cwd && normalizeCwd(s.cwd) === target)
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))[0];
}

export function otherAgent(agent: Agent): Agent {
  return agent === "claude" ? "codex" : "claude";
}

export function normalizeCwd(p: string): string {
  return normalizeProjectCwd(p).replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase();
}

export function defaultProjectCwd(cwd = process.cwd()): string {
  return normalizeProjectCwd(path.resolve(cwd));
}
