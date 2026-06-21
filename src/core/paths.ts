/**
 * Locating session files on disk for each agent, cross-platform.
 *
 * Claude:  <claudeRoot>/projects/<encoded-cwd>/<session-uuid>.jsonl
 *          where <encoded-cwd> is the absolute cwd with every run of non
 *          [A-Za-z0-9] characters replaced by '-'.
 * Codex:   <codexRoot>/sessions/YYYY/MM/DD/rollout-<ts>-<session-uuid>.jsonl
 *          (cwd lives inside the file's session_meta, not the path).
 *
 * Multiple roots are supported so xfer can index sessions from the CLI install,
 * a desktop app data dir, and third-party/gateway-mode installs at once. Extra
 * roots come from XFER_CLAUDE_EXTRA_ROOTS / XFER_CODEX_EXTRA_ROOTS, each an OS
 * path-list (a;b on Windows, a:b on POSIX).
 */

import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export function claudeHome(): string {
  // Claude Code reads CLAUDE_CONFIG_DIR for an alternate config/data location.
  return (
    process.env.CLAUDE_CONFIG_DIR ||
    process.env.CLAUDE_HOME ||
    path.join(os.homedir(), ".claude")
  );
}

export function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

/** Split an OS path-list env value into trimmed, non-empty roots. */
export function splitRoots(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** All Claude roots: the primary home plus any extra configured roots. */
export function claudeRoots(): string[] {
  return [claudeHome(), ...splitRoots(process.env.XFER_CLAUDE_EXTRA_ROOTS)];
}

/** All Codex roots: the primary home plus any extra configured roots. */
export function codexRoots(): string[] {
  return [codexHome(), ...splitRoots(process.env.XFER_CODEX_EXTRA_ROOTS)];
}

/** Primary Claude projects dir (used for writing migrated Claude sessions). */
export function claudeProjectsDir(): string {
  return path.join(claudeHome(), "projects");
}

/** Primary Codex sessions dir (used for writing migrated Codex sessions). */
export function codexSessionsDir(): string {
  return path.join(codexHome(), "sessions");
}

/** Every Claude `projects` dir across all roots (for read/index scanning). */
export function claudeProjectDirs(): string[] {
  return claudeRoots().map((r) => path.join(r, "projects"));
}

/** Every Codex `sessions` dir across all roots (for read/index scanning). */
export function codexSessionDirs(): string[] {
  return codexRoots().map((r) => path.join(r, "sessions"));
}

export function normalizeProjectCwd(cwd: string): string {
  if (cwd.startsWith("\\\\?\\UNC\\")) return `\\\\${cwd.slice("\\\\?\\UNC\\".length)}`;
  if (/^\\\\\?\\[A-Za-z]:[\\/]/.test(cwd)) return cwd.slice(4);
  return cwd;
}

/**
 * Encode an absolute cwd the way Claude Code names its project folders.
 * Observed rule: replace every character that is not a letter or digit with '-'.
 * e.g. `E:\0001_Work\foo` -> `E--0001-Work-foo`.
 */
export function encodeClaudeProjectDir(cwd: string): string {
  return normalizeProjectCwd(cwd).replace(/[^A-Za-z0-9]/g, "-");
}

/** Recursively collect all *.jsonl files under a directory (returns [] if missing). */
export function walkJsonl(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkJsonl(p));
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

/** Extract a UUID embedded anywhere in a string (session id from file names). */
export function extractUuid(s: string): string | undefined {
  const m = s.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
  );
  return m ? m[0] : undefined;
}
