/**
 * The Unified Session Model (USM).
 *
 * Both Claude Code (`~/.claude/projects/.../<uuid>.jsonl`, Anthropic content-block
 * schema) and Codex (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, OpenAI
 * Responses schema) are normalized into this single representation. Everything
 * downstream — the timeline viewer, the web UI, and the migration engine — speaks
 * USM, so neither side needs to know about the other's on-disk format.
 */

export type Agent = "claude" | "codex";

export type Role = "user" | "assistant" | "system" | "tool";

/** A single content fragment inside a turn. */
export type Block =
  | { kind: "text"; text: string }
  /** Model chain-of-thought. `encrypted` is true for Codex reasoning where only a summary (or nothing) is recoverable. */
  | { kind: "thinking"; text: string; encrypted?: boolean }
  /** A tool/function invocation by the assistant. */
  | { kind: "tool_call"; id: string; name: string; input: unknown }
  /** The result returned to a prior tool_call (matched by id). */
  | { kind: "tool_result"; callId: string; output: string; isError?: boolean };

/** One logical message in the conversation timeline. */
export interface Turn {
  /** Stable id within the session (source uuid when available, else synthetic). */
  id: string;
  role: Role;
  blocks: Block[];
  /** ISO-8601 timestamp if the source recorded one. */
  timestamp?: string;
}

/** Metadata describing where a session came from. */
export interface SessionMeta {
  agent: Agent;
  /** Native session/conversation UUID used to resume on that agent. */
  sessionId: string;
  /** Absolute path of the on-disk session file. */
  filePath: string;
  /** Working directory the session was rooted in. */
  cwd?: string;
  model?: string;
  cliVersion?: string;
  /** First user message, trimmed — used as a human-readable title. */
  title?: string;
  /** ISO timestamps. */
  createdAt?: string;
  updatedAt?: string;
  /** Number of turns (cheap summary stat). */
  turnCount?: number;
  gitBranch?: string;
  /** Claude sidechain/subagent transcript; hidden from the main session list. */
  isSidechain?: boolean;
  /** Names of subagent tool calls (Task/Agent/delegate) found in the session. */
  subagents?: string[];
}

/** A fully parsed session: metadata plus normalized timeline. */
export interface UnifiedSession {
  meta: SessionMeta;
  turns: Turn[];
}

/** Lightweight index entry (no turns) for listing many sessions fast. */
export type SessionIndexEntry = SessionMeta;
