/**
 * Near-seamless switching commands.
 *
 * This is deliberately not real-time bidirectional sync yet. It implements the
 * safe first step: pick the latest session for a project, migrate it to the
 * requested target agent if needed, and remember the mapping in `.xfer/state.json`.
 */

import type { Agent } from "./model.js";
import { listSessions, loadSession } from "./index.js";
import { migrate, type MigrateMode, type MigrateResult } from "./migrate.js";
import type { ModelMapping } from "./write.js";
import {
  defaultProjectCwd,
  findMapping,
  latestForCwd,
  loadState,
  otherAgent,
  saveState,
  statePath,
  upsertMapping,
} from "./sync-state.js";

export interface SwitchOptions {
  to: Agent;
  cwd?: string;
  from?: Agent;
  /**
   * Migrate/sync a specific source session instead of the latest one for the
   * project. The result is still indexed by project (recorded in
   * `.xfer/state.json`), so the chosen session can be reused on later syncs.
   */
  sourceSessionId?: string;
  mode?: MigrateMode;
  force?: boolean;
}

export interface SwitchResult {
  reused: boolean;
  sourceAgent: Agent;
  sourceSessionId: string;
  targetAgent: Agent;
  targetSessionId: string;
  targetFilePath?: string;
  resumeCommand: string;
  statePath: string;
  modelMapping?: ModelMapping;
  note?: string;
}

export function switchSession(opts: SwitchOptions): SwitchResult {
  const cwd = defaultProjectCwd(opts.cwd);
  const targetAgent = opts.to;

  // Resolve the source session: a user-chosen one if provided, else the latest
  // session for this project on the opposite agent.
  let sourceAgent: Agent;
  let sourceSessionId: string;
  let sourceUpdatedAt: string | undefined;
  if (opts.sourceSessionId) {
    const chosen = loadSession(opts.sourceSessionId);
    if (!chosen) {
      throw new Error(`Session not found: ${opts.sourceSessionId}`);
    }
    if (chosen.meta.agent === targetAgent) {
      throw new Error("Source session is already on the target agent");
    }
    sourceAgent = chosen.meta.agent;
    sourceSessionId = chosen.meta.sessionId;
    sourceUpdatedAt = chosen.meta.updatedAt;
  } else {
    sourceAgent = opts.from || otherAgent(targetAgent);
    if (sourceAgent === targetAgent) {
      throw new Error("--from and --to must be different agents");
    }
    const latest = latestForCwd(listSessions({ agent: sourceAgent }), cwd, sourceAgent);
    if (!latest) {
      throw new Error(`No ${sourceAgent} session found for cwd: ${cwd}`);
    }
    sourceSessionId = latest.sessionId;
    sourceUpdatedAt = latest.updatedAt;
  }

  const state = loadState(cwd);
  const existing = findMapping(
    state,
    sourceAgent,
    sourceSessionId,
    targetAgent
  );

  if (existing && !opts.force) {
    return {
      reused: true,
      sourceAgent,
      sourceSessionId,
      targetAgent,
      targetSessionId: existing.targetSessionId,
      targetFilePath: existing.targetFilePath,
      resumeCommand: resumeCommand(targetAgent, existing.targetSessionId),
      statePath: statePath(cwd),
      note: targetAgent === "claude" ? "Run from the same cwd for Claude resume." : undefined,
    };
  }

  const result = migrate(sourceSessionId, {
    to: targetAgent,
    mode: opts.mode || "faithful",
    cwd,
  });

  const nextState = upsertMapping(state, {
    cwd,
    sourceAgent,
    sourceSessionId,
    targetAgent,
    targetSessionId: result.sessionId,
    targetFilePath: result.filePath,
    createdAt: new Date().toISOString(),
    sourceUpdatedAt,
  });
  saveState(nextState, cwd);

  return toSwitchResult(sourceAgent, sourceSessionId, result, cwd);
}

function toSwitchResult(
  sourceAgent: Agent,
  sourceSessionId: string,
  result: MigrateResult,
  cwd: string
): SwitchResult {
  return {
    reused: false,
    sourceAgent,
    sourceSessionId,
    targetAgent: result.to,
    targetSessionId: result.sessionId,
    targetFilePath: result.filePath,
    resumeCommand: result.resumeCommand,
    statePath: statePath(cwd),
    modelMapping: result.modelMapping,
    note: result.to === "claude" ? "Run from the same cwd for Claude resume." : undefined,
  };
}

export function resumeCommand(agent: Agent, sessionId: string): string {
  return agent === "claude"
    ? `claude --resume ${sessionId}`
    : `codex resume ${sessionId}`;
}

export function syncStatus(cwd = process.cwd()): string {
  const projectCwd = defaultProjectCwd(cwd);
  const sessions = listSessions({ cwd: projectCwd, limit: 20 });
  const state = loadState(projectCwd);
  const lines: string[] = [];
  lines.push(`Project: ${projectCwd}`);
  lines.push(`State:   ${statePath(projectCwd)}`);
  lines.push("");
  lines.push("Latest sessions:");
  for (const agent of ["claude", "codex"] as const) {
    const latest = latestForCwd(sessions, projectCwd, agent);
    lines.push(
      `  ${agent}: ${latest ? `${latest.sessionId} (${latest.turnCount} turns, ${latest.updatedAt || "?"})` : "none"}`
    );
  }
  lines.push("");
  lines.push("Mappings:");
  if (!state.mappings.length) lines.push("  none");
  for (const m of state.mappings) {
    lines.push(
      `  ${m.sourceAgent}:${m.sourceSessionId.slice(0, 8)} → ${m.targetAgent}:${m.targetSessionId.slice(0, 8)}  ${m.createdAt}`
    );
  }
  return lines.join("\n");
}
