/**
 * Serialize a UnifiedSession back into a target agent's native JSONL format,
 * producing a fresh session file the agent can `resume` into.
 *
 * This is the "faithful" half of migration: USM turns are translated 1:1 into
 * the destination schema (Anthropic content-blocks for Claude, OpenAI Responses
 * items for Codex) so the resumed conversation looks native.
 *
 * Note: these formats are not officially published; writers aim to match what
 * the CLIs emit today. The migration layer always offers a context-replay
 * fallback (see migrate.ts) for when a CLI version rejects a reconstructed file.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { UnifiedSession, Turn } from "./model.js";
import {
  claudeProjectsDir,
  codexSessionsDir,
  encodeClaudeProjectDir,
  normalizeProjectCwd,
} from "./paths.js";

export interface WriteResult {
  sessionId: string;
  filePath: string;
  modelMapping: ModelMapping;
}

export interface ModelMapping {
  sourceModel?: string;
  targetModel: string;
  changed: boolean;
  reason: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** A short banner injected as the first user turn explaining the migration. */
export function migrationBanner(src: UnifiedSession, to: string): string {
  return (
    `[Session migrated from ${src.meta.agent} to ${to} by xfer]\n` +
    `Original session: ${src.meta.sessionId}\n` +
    `The full prior conversation has been imported below. Continue the task.`
  );
}

/* ------------------------------------------------------------------ Claude */

/** Translate USM turns into Claude content-block records and write a .jsonl. */
export function writeClaudeSession(
  src: UnifiedSession,
  opts: { cwd: string; sessionId?: string }
): WriteResult {
  const sessionId = opts.sessionId || crypto.randomUUID();
  const modelMapping = resolveTargetModel("claude", src.meta.model);
  const cwd = normalizeProjectCwd(opts.cwd);
  const dir = path.join(claudeProjectsDir(), encodeClaudeProjectDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.jsonl`);

  const records: string[] = [];
  let prevUuid: string | null = null;
  const ts = nowIso();

  const push = (role: "user" | "assistant", content: unknown) => {
    const uuid = crypto.randomUUID();
    records.push(
      JSON.stringify({
        parentUuid: prevUuid,
        isSidechain: false,
        type: role,
        message:
          role === "assistant"
            ? { role, model: modelMapping.targetModel, content }
            : { role, content },
        uuid,
        timestamp: ts,
        cwd,
        sessionId,
      })
    );
    prevUuid = uuid;
  };

  for (const turn of src.turns) {
    const content = turnToClaudeContent(turn);
    if (!content.length) continue;
    // Claude tool_result blocks must be carried on a user-role message.
    const role: "user" | "assistant" =
      turn.role === "assistant" ? "assistant" : "user";
    push(role, content);
  }

  fs.writeFileSync(filePath, records.map((r) => r + "\n").join(""), "utf8");
  return { sessionId, filePath, modelMapping };
}

function turnToClaudeContent(turn: Turn): any[] {
  const out: any[] = [];
  for (const b of turn.blocks) {
    switch (b.kind) {
      case "text":
        out.push({ type: "text", text: b.text });
        break;
      case "thinking":
        // Encrypted (Codex) reasoning can't be faithfully replayed; demote to text note.
        if (b.encrypted)
          out.push({ type: "text", text: `(prior reasoning) ${b.text}` });
        else out.push({ type: "thinking", thinking: b.text });
        break;
      case "tool_call":
        out.push({
          type: "tool_use",
          id: b.id || `toolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
          name: b.name,
          input: b.input,
        });
        break;
      case "tool_result":
        out.push({
          type: "tool_result",
          tool_use_id: b.callId,
          content: b.output,
          ...(b.isError ? { is_error: true } : {}),
        });
        break;
    }
  }
  return out;
}

/* ------------------------------------------------------------------- Codex */

/** Translate USM turns into Codex Responses items and write a rollout-*.jsonl. */
export function writeCodexSession(
  src: UnifiedSession,
  opts: { cwd: string; sessionId?: string }
): WriteResult {
  const sessionId = opts.sessionId || crypto.randomUUID();
  const modelMapping = resolveTargetModel("codex", src.meta.model);
  const cwd = normalizeProjectCwd(opts.cwd);
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const dir = path.join(codexSessionsDir(), String(y), m, d);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-").replace("Z", "");
  const filePath = path.join(dir, `rollout-${stamp}-${sessionId}.jsonl`);

  const ts = nowIso();
  const records: string[] = [];

  // session_meta first line 鈥?minimal but sufficient for resume + display.
  records.push(
    JSON.stringify({
      timestamp: ts,
      type: "session_meta",
      payload: {
        id: sessionId,
        timestamp: ts,
        cwd,
        originator: "xfer",
        cli_version: "xfer-migrated",
        source: "xfer",
        model_provider: "custom",
        model: modelMapping.targetModel,
      },
    })
  );

  records.push(
    JSON.stringify({
      timestamp: ts,
      type: "turn_context",
      payload: {
        cwd,
        model: modelMapping.targetModel,
        approval_policy: "on-request",
        sandbox_policy: "workspace-write",
      },
    })
  );

  const item = (payload: unknown) =>
    records.push(JSON.stringify({ timestamp: ts, type: "response_item", payload }));

  for (const turn of src.turns) {
    for (const b of turn.blocks) {
      switch (b.kind) {
        case "text": {
          const role =
            turn.role === "assistant"
              ? "assistant"
              : turn.role === "system"
                ? "developer"
                : "user";
          const ctype = role === "assistant" ? "output_text" : "input_text";
          item({ type: "message", role, content: [{ type: ctype, text: b.text }] });
          break;
        }
        case "thinking":
          // Codex reasoning is normally encrypted; replay summary as a reasoning summary.
          item({ type: "reasoning", summary: [{ type: "summary_text", text: b.text }] });
          break;
        case "tool_call":
          item({
            type: "function_call",
            name: b.name,
            arguments:
              typeof b.input === "string" ? b.input : JSON.stringify(b.input),
            call_id: b.id || `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`,
          });
          break;
        case "tool_result":
          item({
            type: "function_call_output",
            call_id: b.callId,
            output: b.output,
          });
          break;
      }
    }
  }

  fs.writeFileSync(filePath, records.map((r) => r + "\n").join(""), "utf8");
  return { sessionId, filePath, modelMapping };
}

function resolveTargetModel(agent: "claude" | "codex", source?: string): ModelMapping {
  const sourceModel = source?.trim() || undefined;
  const defaultModel = defaultTargetModel(agent);
  if (sourceModel) {
    const aliases = modelAliases();
    const mapped = aliases[sourceModel] || aliases[sourceModel.toLowerCase()];
    if (mapped?.trim()) {
      const targetModel = mapped.trim();
      return {
        sourceModel,
        targetModel,
        changed: targetModel !== sourceModel,
        reason: "matched user model alias",
      };
    }
    if (modelIsCompatible(agent, sourceModel)) {
      return {
        sourceModel,
        targetModel: sourceModel,
        changed: false,
        reason: "source model is compatible with target agent",
      };
    }
  }
  return {
    sourceModel,
    targetModel: defaultModel,
    changed: sourceModel !== defaultModel,
    reason: "source model is missing or not compatible with target agent; using target default model",
  };
}

function defaultTargetModel(agent: "claude" | "codex"): string {
  const envName = agent === "claude" ? "XFER_TARGET_MODEL_CLAUDE" : "XFER_TARGET_MODEL_CODEX";
  const configured = process.env[envName]?.trim();
  if (configured) return configured;
  return agent === "claude" ? "claude-sonnet-4-5" : "gpt-5.1-codex";
}

function modelAliases(): Record<string, string> {
  try {
    return JSON.parse(process.env.XFER_MODEL_ALIASES || "{}");
  } catch {
    return {};
  }
}

function modelIsCompatible(agent: "claude" | "codex", model: string): boolean {
  const lower = model.toLowerCase();
  return agent === "claude"
    ? lower.startsWith("claude-") || lower.includes("claude")
    : lower.startsWith("gpt-") || lower.startsWith("o") || lower.includes("codex");
}
