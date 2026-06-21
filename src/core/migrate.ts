/**
 * Migration orchestrator: take a session from one agent and produce a resumable
 * session on the other.
 *
 * Two modes:
 *  - "faithful"  : reconstruct the destination agent's native records 1:1, so the
 *                  resumed conversation shows native message/tool bubbles. Depends
 *                  on the (unpublished) on-disk format and may break across CLI
 *                  upgrades.
 *  - "replay"    : collapse the whole prior conversation into one structured text
 *                  transcript injected as the opening user turn. Robust and
 *                  version-proof; the prior steps appear as replayed text.
 *
 * Default is "faithful" with the transcript also embedded as a leading note, so a
 * resume still has the full context even if some native records are ignored.
 */

import type { Agent, UnifiedSession } from "./model.js";
import { loadSession } from "./index.js";
import {
  writeClaudeSession,
  writeCodexSession,
  type WriteResult,
  migrationBanner,
} from "./write.js";

export type MigrateMode = "faithful" | "replay";

export interface MigrateOptions {
  to: Agent;
  mode?: MigrateMode;
  /** Override the destination cwd (defaults to the source session's cwd). */
  cwd?: string;
}

export interface MigrateResult extends WriteResult {
  from: Agent;
  to: Agent;
  mode: MigrateMode;
  resumeCommand: string;
  turnsWritten: number;
}

/** Build a compact, structured plain-text transcript of the whole session. */
export function buildTranscript(session: UnifiedSession): string {
  const lines: string[] = [];
  for (const turn of session.turns) {
    for (const b of turn.blocks) {
      switch (b.kind) {
        case "text":
          lines.push(`### ${turn.role}\n${b.text}`);
          break;
        case "thinking":
          lines.push(`### ${turn.role} (thinking)\n${b.text}`);
          break;
        case "tool_call":
          lines.push(
            `### ${turn.role} -> tool: ${b.name}\n${
              typeof b.input === "string" ? b.input : JSON.stringify(b.input)
            }`
          );
          break;
        case "tool_result":
          lines.push(`### tool result\n${b.output}`);
          break;
      }
    }
  }
  return lines.join("\n\n");
}

/** Wrap the source session into a single replay turn for "replay" mode. */
function asReplaySession(src: UnifiedSession, to: Agent): UnifiedSession {
  const transcript = buildTranscript(src);
  const banner = migrationBanner(src, to);
  return {
    meta: { ...src.meta, agent: to },
    turns: [
      {
        id: "replay-0",
        role: "user",
        blocks: [{ kind: "text", text: `${banner}\n\n${transcript}` }],
      },
    ],
  };
}

export function migrate(
  sessionId: string,
  opts: MigrateOptions
): MigrateResult {
  const src = loadSession(sessionId);
  if (!src) throw new Error(`Session not found: ${sessionId}`);
  if (src.meta.agent === opts.to)
    throw new Error(`Session is already a ${opts.to} session`);

  const mode: MigrateMode = opts.mode ?? "faithful";
  const cwd = opts.cwd || src.meta.cwd;
  if (!cwd)
    throw new Error(
      "No cwd recorded for this session; pass --cwd to set the destination working directory."
    );

  const payload = mode === "replay" ? asReplaySession(src, opts.to) : src;

  let written: WriteResult;
  if (opts.to === "claude") {
    written = writeClaudeSession(payload, { cwd });
  } else {
    written = writeCodexSession(payload, { cwd });
  }

  const resumeCommand =
    opts.to === "claude"
      ? `claude --resume ${written.sessionId}`
      : `codex resume ${written.sessionId}`;

  return {
    ...written,
    from: src.meta.agent,
    to: opts.to,
    mode,
    resumeCommand,
    turnsWritten: payload.turns.length,
  };
}
