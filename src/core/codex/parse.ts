/**
 * Parse a Codex session file (OpenAI Responses JSONL) into the USM.
 *
 * Record envelope: { timestamp, type, payload }
 *   - session_meta : first line; payload has id, cwd, model_provider, git, base_instructions
 *   - turn_context : payload.model, cwd per turn
 *   - response_item: payload.type = message | reasoning | function_call | function_call_output
 *   - event_msg    : payload.type = user_message | agent_message | task_* | token_count ...
 *
 * We build the timeline primarily from `response_item` records (the canonical
 * model I/O). `event_msg` records are largely UI mirrors of the same content, so
 * we ignore them for turns to avoid duplication — except we use them as a
 * fallback for the title.
 *
 * Codex `reasoning` is stored encrypted (`encrypted_content`); only the optional
 * `summary` array is human-readable. We surface summary text and mark it encrypted.
 */

import fs from "node:fs";
import type { Block, Role, Turn, UnifiedSession, SessionMeta } from "../model.js";
import { extractUuid, normalizeProjectCwd } from "../paths.js";

interface Envelope {
  timestamp?: string;
  type?: string;
  payload?: any;
}

/** Developer/system preamble text we don't want cluttering the human timeline. */
function isNoisePreamble(text: string): boolean {
  return (
    text.startsWith("<permissions instructions>") ||
    text.startsWith("<collaboration_mode>") ||
    text.startsWith("<skills_instructions>") ||
    text.startsWith("<environment_context>")
  );
}

/** Auto-injected context that should never be used as a session title. */
function isInjectedContext(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith("# AGENTS.md") ||
    t.startsWith("<environment_context>") ||
    t.startsWith("<user_instructions>") ||
    (t.startsWith("<") && t.includes("instructions>"))
  );
}

function blocksFromMessage(payload: any): Block[] {
  const blocks: Block[] = [];
  const content = payload?.content;
  if (!Array.isArray(content)) return blocks;
  for (const c of content) {
    const text = c?.text;
    if (typeof text !== "string" || !text.length) continue;
    // input_text (user/developer) and output_text (assistant) both carry plain text.
    if (c.type === "input_text" || c.type === "output_text" || c.type === "text") {
      blocks.push({ kind: "text", text });
    }
  }
  return blocks;
}

function subagentLabel(name: string, input: unknown): string | null {
  const isKnownDelegator = /^(Task|Agent|delegate)$/i.test(name);
  const isNamedDelegator = /subagent|delegate/i.test(name);
  const hasSubagentHint =
    input &&
    typeof input === "object" &&
    ["subagent_type", "agent_type"].some((key) => typeof (input as Record<string, unknown>)[key] === "string");
  if (!isKnownDelegator && !isNamedDelegator && !hasSubagentHint) {
    return null;
  }
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    for (const key of ["subagent_type", "agent_type", "description", "name", "agent"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim().slice(0, 80);
    }
  }
  return name;
}

export function parseCodexSession(filePath: string): UnifiedSession {
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split("\n");
  const turns: Turn[] = [];

  let sessionId =
    extractUuid(filePath.split(/[\\/]/).pop() || "") || filePath;
  let cwd: string | undefined;
  let model: string | undefined;
  let cliVersion: string | undefined;
  let gitBranch: string | undefined;
  let title: string | undefined;
  let createdAt: string | undefined;
  let updatedAt: string | undefined;
  const subagents: string[] = [];

  let synthetic = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let o: Envelope;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.timestamp) {
      if (!createdAt) createdAt = o.timestamp;
      updatedAt = o.timestamp;
    }

    const p = o.payload;
    if (!p) continue;

    if (o.type === "session_meta") {
      if (p.id) sessionId = p.id;
      if (p.cwd) cwd = normalizeProjectCwd(p.cwd);
      if (p.cli_version) cliVersion = p.cli_version;
      if (p.git?.branch) gitBranch = p.git.branch;
      if (p.timestamp) createdAt = p.timestamp;
      continue;
    }

    if (o.type === "turn_context") {
      if (p.model && !model) model = p.model;
      if (p.cwd && !cwd) cwd = normalizeProjectCwd(p.cwd);
      continue;
    }

    // Title fallback from the event_msg user_message stream.
    if (o.type === "event_msg" && p.type === "user_message" && !title) {
      if (typeof p.message === "string") {
        const cleaned = stripIdePreamble(p.message);
        if (cleaned) title = cleaned.replace(/\s+/g, " ").trim().slice(0, 100);
      }
      continue;
    }

    if (o.type !== "response_item") continue;

    switch (p.type) {
      case "message": {
        const role: string = p.role || "user";
        // developer messages are system preambles; skip the noisy ones.
        const blocks = blocksFromMessage(p).filter(
          (b) => !(b.kind === "text" && isNoisePreamble(b.text))
        );
        if (!blocks.length) break;
        let usmRole: Role =
          role === "assistant"
            ? "assistant"
            : role === "developer" || role === "system"
              ? "system"
              : "user";
        turns.push({
          id: `x${synthetic++}`,
          role: usmRole,
          blocks,
          timestamp: o.timestamp,
        });
        if (!title && usmRole === "user") {
          const t = blocks.find((b) => b.kind === "text") as
            | { text: string }
            | undefined;
          if (t && !isInjectedContext(t.text)) {
            const cleaned = stripIdePreamble(t.text);
            if (cleaned)
              title = cleaned.replace(/\s+/g, " ").trim().slice(0, 100);
          }
        }
        break;
      }
      case "reasoning": {
        const summary: string =
          Array.isArray(p.summary) && p.summary.length
            ? p.summary
                .map((s: any) => (typeof s === "string" ? s : s?.text || ""))
                .join("\n")
            : "";
        turns.push({
          id: `x${synthetic++}`,
          role: "assistant",
          blocks: [
            {
              kind: "thinking",
              text: summary || "[encrypted reasoning]",
              encrypted: true,
            },
          ],
          timestamp: o.timestamp,
        });
        break;
      }
      case "function_call": {
        const fname = String(p.name ?? "tool");
        let input: unknown = p.arguments;
        if (typeof p.arguments === "string") {
          try {
            input = JSON.parse(p.arguments);
          } catch {
            input = p.arguments;
          }
        }
        const label = subagentLabel(fname, input);
        if (label) subagents.push(label);
        turns.push({
          id: `x${synthetic++}`,
          role: "assistant",
          blocks: [
            {
              kind: "tool_call",
              id: String(p.call_id ?? ""),
              name: String(p.name ?? "tool"),
              input,
            },
          ],
          timestamp: o.timestamp,
        });
        break;
      }
      case "function_call_output": {
        const out =
          typeof p.output === "string" ? p.output : JSON.stringify(p.output);
        turns.push({
          id: `x${synthetic++}`,
          role: "tool",
          blocks: [
            {
              kind: "tool_result",
              callId: String(p.call_id ?? ""),
              output: out,
            },
          ],
          timestamp: o.timestamp,
        });
        break;
      }
      default:
        break;
    }
  }

  const meta: SessionMeta = {
    agent: "codex",
    sessionId,
    filePath,
    cwd,
    model,
    cliVersion,
    title,
    createdAt,
    updatedAt,
    turnCount: turns.length,
    gitBranch,
    subagents: subagents.length ? subagents : undefined,
  };
  return { meta, turns };
}

/**
 * Codex IDE integration wraps the real request in a "# Context from my IDE setup"
 * preamble ending in a "## My request for Codex:" section. Pull out just the ask.
 */
function stripIdePreamble(msg: string): string {
  const marker = msg.indexOf("My request for Codex:");
  if (marker >= 0) {
    return msg.slice(marker + "My request for Codex:".length).trim();
  }
  if (isInjectedContext(msg)) return "";
  return msg;
}
