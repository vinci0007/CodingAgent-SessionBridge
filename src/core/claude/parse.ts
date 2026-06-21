/**
 * Parse a Claude Code session file (Anthropic content-block JSONL) into the USM.
 *
 * Record types observed in `~/.claude/projects/.../<uuid>.jsonl`:
 *   - user        : { message: { role, content } }   content = string | Block[]
 *   - assistant   : { message: { role, content: Block[], model } }
 *   - attachment  : injected context (skill listings etc.) — skipped
 *   - queue-operation / last-prompt : bookkeeping — skipped
 *
 * Anthropic blocks: text | thinking | tool_use | tool_result.
 */

import fs from "node:fs";
import type { Block, Role, Turn, UnifiedSession, SessionMeta } from "../model.js";
import { extractUuid, normalizeProjectCwd } from "../paths.js";

interface RawLine {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
    model?: string;
  };
  uuid?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  isSidechain?: boolean;
  version?: string;
}

function blocksFromContent(content: unknown): Block[] {
  // Claude user messages are often a bare string.
  if (typeof content === "string") {
    return content.trim() ? [{ kind: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: Block[] = [];
  for (const b of content as any[]) {
    if (!b || typeof b !== "object") continue;
    switch (b.type) {
      case "text":
        if (typeof b.text === "string" && b.text.length)
          blocks.push({ kind: "text", text: b.text });
        break;
      case "thinking":
        if (typeof b.thinking === "string")
          blocks.push({ kind: "thinking", text: b.thinking });
        break;
      case "tool_use":
        blocks.push({
          kind: "tool_call",
          id: String(b.id ?? ""),
          name: String(b.name ?? "tool"),
          input: b.input ?? {},
        });
        break;
      case "tool_result": {
        const out =
          typeof b.content === "string"
            ? b.content
            : Array.isArray(b.content)
              ? b.content
                  .map((c: any) => (typeof c?.text === "string" ? c.text : ""))
                  .join("")
              : JSON.stringify(b.content ?? "");
        blocks.push({
          kind: "tool_result",
          callId: String(b.tool_use_id ?? ""),
          output: out,
          isError: b.is_error === true,
        });
        break;
      }
      default:
        break;
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

export function parseClaudeSession(filePath: string): UnifiedSession {
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split("\n");
  const turns: Turn[] = [];

  let sessionId =
    extractUuid(filePath.split(/[\\/]/).pop() || "") || filePath;
  let cwd: string | undefined;
  let model: string | undefined;
  let cliVersion: string | undefined;
  let gitBranch: string | undefined;
  let isSidechain = false;
  let title: string | undefined;
  let createdAt: string | undefined;
  let updatedAt: string | undefined;
  const subagents: string[] = [];

  let synthetic = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let o: RawLine;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.cwd && !cwd) cwd = normalizeProjectCwd(o.cwd);
    if (o.gitBranch && !gitBranch) gitBranch = o.gitBranch;
    if (o.isSidechain === true) isSidechain = true;
    if (o.version && !cliVersion) cliVersion = o.version;
    if (o.timestamp) {
      if (!createdAt) createdAt = o.timestamp;
      updatedAt = o.timestamp;
    }

    if (o.type !== "user" && o.type !== "assistant") continue;
    const role: Role = o.type === "assistant" ? "assistant" : "user";
    if (o.message?.model && !model) model = o.message.model;
    const blocks = blocksFromContent(o.message?.content);
    if (!blocks.length) continue;

    for (const b of blocks) {
      if (b.kind === "tool_call") {
        const label = subagentLabel(b.name, b.input);
        if (label) subagents.push(label);
      }
    }
    // tool_result blocks logically belong to the "tool" role for display grouping.
    const onlyToolResults = blocks.every((b) => b.kind === "tool_result");
    turns.push({
      id: o.uuid || `c${synthetic++}`,
      role: onlyToolResults ? "tool" : role,
      blocks,
      timestamp: o.timestamp,
    });

    if (!title && role === "user") {
      const t = blocks.find((b) => b.kind === "text") as
        | { text: string }
        | undefined;
      if (t) title = t.text.replace(/\s+/g, " ").trim().slice(0, 100);
    }
  }

  const meta: SessionMeta = {
    agent: "claude",
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
    isSidechain: isSidechain || undefined,
    subagents: subagents.length ? subagents : undefined,
  };
  return { meta, turns };
}
