/**
 * Render a UnifiedSession as a plain-text timeline for the terminal.
 * Kept dependency-free; the web viewer renders the same USM as HTML.
 */

import type { UnifiedSession, Turn, Block } from "./model.js";

const ROLE_LABEL: Record<string, string> = {
  user: "USER",
  assistant: "ASSISTANT",
  system: "SYSTEM",
  tool: "TOOL",
};

export interface RenderOptions {
  /** Truncate long text/outputs to this many chars (0 = no limit). */
  maxChars?: number;
  /** Hide thinking blocks. */
  hideThinking?: boolean;
  /** Hide tool calls/results. */
  hideTools?: boolean;
}

function clip(s: string, max: number): string {
  if (!max || s.length <= max) return s;
  return s.slice(0, max) + ` …[+${s.length - max} chars]`;
}

function renderBlock(b: Block, opts: RenderOptions): string | null {
  const max = opts.maxChars ?? 0;
  switch (b.kind) {
    case "text":
      return clip(b.text, max);
    case "thinking":
      if (opts.hideThinking) return null;
      return `💭 ${b.encrypted ? "(reasoning) " : ""}${clip(b.text, max || 500)}`;
    case "tool_call":
      if (opts.hideTools) return null;
      return `🔧 ${b.name}(${clip(
        typeof b.input === "string" ? b.input : JSON.stringify(b.input),
        max || 300
      )})`;
    case "tool_result":
      if (opts.hideTools) return null;
      return `↳ ${b.isError ? "[error] " : ""}${clip(b.output, max || 300)}`;
  }
}

export function renderTimeline(
  session: UnifiedSession,
  opts: RenderOptions = {}
): string {
  const { meta, turns } = session;
  const lines: string[] = [];
  lines.push("─".repeat(72));
  lines.push(`Session ${meta.sessionId}  [${meta.agent}]`);
  if (meta.title) lines.push(`Title:  ${meta.title}`);
  if (meta.cwd) lines.push(`Cwd:    ${meta.cwd}`);
  lines.push(
    `Model:  ${meta.model || "?"}   Turns: ${meta.turnCount}   ${
      meta.updatedAt || ""
    }`
  );
  lines.push("─".repeat(72));

  for (const turn of turns) {
    const rendered = turn.blocks
      .map((b) => renderBlock(b, opts))
      .filter((x): x is string => x !== null);
    if (!rendered.length) continue;
    const label = ROLE_LABEL[turn.role] || turn.role.toUpperCase();
    lines.push("");
    lines.push(`▌ ${label}`);
    for (const r of rendered) {
      for (const ln of r.split("\n")) lines.push(`  ${ln}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
