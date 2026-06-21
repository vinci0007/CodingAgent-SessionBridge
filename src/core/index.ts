/**
 * Cross-agent session discovery and indexing.
 *
 * Scans both Claude and Codex storage, returning lightweight index entries
 * (metadata only, no full timeline) so listing hundreds of sessions stays fast.
 * Full timelines are loaded on demand via `loadSession`.
 */

import fs from "node:fs";
import path from "node:path";
import type { Agent, SessionIndexEntry, UnifiedSession } from "./model.js";
import {
  claudeProjectDirs,
  codexSessionDirs,
  encodeClaudeProjectDir,
  normalizeProjectCwd,
  walkJsonl,
} from "./paths.js";
import { parseClaudeSession } from "./claude/parse.js";
import { parseCodexSession } from "./codex/parse.js";

export interface ListOptions {
  /** Only sessions whose cwd matches this absolute path. */
  cwd?: string;
  /** Restrict to a single agent. */
  agent?: Agent;
  /** Max entries to return (most-recent first). */
  limit?: number;
}

export interface SourceStatus {
  /** At least one configured root subdir exists and is reachable. */
  available: boolean;
  /** Total jsonl files discovered across all roots. */
  count: number;
  /** Error message if a root existed but could not be scanned. */
  error?: string;
}

export interface IndexStatus {
  claude: SourceStatus;
  codex: SourceStatus;
}

/** Parse just enough of a file to produce an index entry. */
function indexOne(filePath: string, agent: Agent): SessionIndexEntry | null {
  try {
    const session =
      agent === "claude"
        ? parseClaudeSession(filePath)
        : parseCodexSession(filePath);
    // Skip empty / aborted sessions with no real content.
    if (!session.turns.length) return null;
    // Claude subagent sidechains are shown under the owning session, not as
    // independent project sessions in the main list.
    if (agent === "claude" && session.meta.isSidechain) return null;
    return session.meta;
  } catch {
    return null;
  }
}

/** Walk a list of dirs, returning jsonl files (deduped by path). */
function scanDirs(dirs: string[]): { files: string[]; error?: string } {
  const seen = new Set<string>();
  const files: string[] = [];
  let error: string | undefined;
  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const f of walkJsonl(dir)) {
        if (!seen.has(f)) {
          seen.add(f);
          files.push(f);
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  return { files, error };
}

export function listSessions(opts: ListOptions = {}): SessionIndexEntry[] {
  const entries: SessionIndexEntry[] = [];

  if (opts.agent !== "codex") {
    // Claude: optionally narrow to the project folder for a given cwd.
    const claudeDirs = opts.cwd
      ? claudeProjectDirs().map((base) => path.join(base, encodeClaudeProjectDir(opts.cwd!)))
      : claudeProjectDirs();
    const { files: claudeFiles } = scanDirs(claudeDirs);
    for (const f of claudeFiles) {
      const e = indexOne(f, "claude");
      if (e) entries.push(e);
    }
  }

  if (opts.agent !== "claude") {
    // Codex: cwd lives inside the file, so we must scan and filter.
    const { files: codexFiles } = scanDirs(codexSessionDirs());
    for (const f of codexFiles) {
      const e = indexOne(f, "codex");
      if (e) entries.push(e);
    }
  }

  let filtered = entries;
  if (opts.cwd) {
    const target = normalizeCwd(opts.cwd);
    filtered = filtered.filter(
      (e) => e.cwd && normalizeCwd(e.cwd) === target
    );
  }

  filtered.sort((a, b) =>
    (b.updatedAt || "").localeCompare(a.updatedAt || "")
  );

  return opts.limit ? filtered.slice(0, opts.limit) : filtered;
}

/** Report per-agent reachability of session storage across all roots. */
export function indexStatus(): IndexStatus {
  return { claude: statusFor(claudeProjectDirs()), codex: statusFor(codexSessionDirs()) };
}

function statusFor(dirs: string[]): SourceStatus {
  let count = 0;
  let available = false;
  let error: string | undefined;
  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      available = true;
      count += walkJsonl(dir).length;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  return { available, count, error };
}

/** Find one session by its UUID across both agents and all roots. */
export function findSession(
  sessionId: string
): { agent: Agent; filePath: string } | null {
  // Codex file names embed the uuid, so we can match by name fast.
  const { files: codexFiles } = scanDirs(codexSessionDirs());
  for (const f of codexFiles) {
    if (f.includes(sessionId)) return { agent: "codex", filePath: f };
  }
  // Claude file is named exactly <uuid>.jsonl.
  const { files: claudeFiles } = scanDirs(claudeProjectDirs());
  for (const f of claudeFiles) {
    if (path.basename(f) === `${sessionId}.jsonl`)
      return { agent: "claude", filePath: f };
  }
  // Fallback: open Claude files and check parsed id (forked sessions etc.).
  for (const f of claudeFiles) {
    if (f.includes(sessionId)) return { agent: "claude", filePath: f };
  }
  return null;
}

/** Load a full unified session by UUID. */
export function loadSession(sessionId: string): UnifiedSession | null {
  const hit = findSession(sessionId);
  if (!hit) return null;
  return hit.agent === "claude"
    ? parseClaudeSession(hit.filePath)
    : parseCodexSession(hit.filePath);
}

export function loadSessionFile(
  filePath: string,
  agent: Agent
): UnifiedSession {
  return agent === "claude"
    ? parseClaudeSession(filePath)
    : parseCodexSession(filePath);
}

function normalizeCwd(p: string): string {
  return normalizeProjectCwd(p).replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase();
}
