#!/usr/bin/env node
/**
 * xfer MCP server — exposes session viewing & migration as MCP tools, so you can
 * trigger a switch from *inside* a Claude or Codex conversation:
 *
 *   "list my codex sessions for this project"
 *   "migrate session <id> to claude"
 *
 * Tools:
 *   list_sessions   { agent?, cwd?, limit? }
 *   view_session    { sessionId, maxChars? }
 *   migrate_session { sessionId, to, mode?, cwd? }
 *
 * Runs over stdio. Register with:
 *   claude mcp add xfer -- node /abs/path/dist/mcp/server.js
 *   codex mcp add xfer -- node /abs/path/dist/mcp/server.js
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { listSessions, loadSession } from "../core/index.js";
import { renderTimeline } from "../core/render.js";
import { migrate, type MigrateMode } from "../core/migrate.js";
import type { Agent } from "../core/model.js";

const server = new Server(
  { name: "xfer", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_sessions",
      description:
        "List Claude Code and/or Codex coding sessions, most recent first. Use to find a session to view or migrate. Filter by agent and/or working directory.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", enum: ["claude", "codex"], description: "Restrict to one agent." },
          cwd: { type: "string", description: "Only sessions whose working directory matches this absolute path." },
          limit: { type: "number", description: "Max results (default 30)." },
        },
      },
    },
    {
      name: "view_session",
      description:
        "Return the full conversation history of a session (any agent) as a readable timeline, including user/assistant messages, reasoning, and tool calls.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "The session UUID." },
          maxChars: { type: "number", description: "Truncate long blocks to this many chars (0 = no limit, default 4000)." },
        },
        required: ["sessionId"],
      },
    },
    {
      name: "migrate_session",
      description:
        "Migrate a session to the other agent so it can be resumed there with full prior context. Returns the new session id and the resume command. mode 'faithful' reconstructs native records (best fidelity); 'replay' injects a robust transcript (version-proof).",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "The source session UUID." },
          to: { type: "string", enum: ["claude", "codex"], description: "Target agent." },
          mode: { type: "string", enum: ["faithful", "replay"], description: "Migration mode (default faithful)." },
          cwd: { type: "string", description: "Override destination working directory (defaults to source cwd)." },
        },
        required: ["sessionId", "to"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    if (name === "list_sessions") {
      const sessions = listSessions({
        agent: args.agent as Agent | undefined,
        cwd: args.cwd as string | undefined,
        limit: (args.limit as number) ?? 30,
      });
      const lines = sessions.map(
        (s) =>
          `${s.agent}\t${s.sessionId}\t${s.turnCount} turns\t${(s.updatedAt || "").slice(0, 16)}\t${s.cwd || ""}\t${(s.title || "").slice(0, 80)}`
      );
      return {
        content: [
          {
            type: "text",
            text:
              `Found ${sessions.length} session(s) [agent  id  turns  updated  cwd  title]:\n` +
              lines.join("\n"),
          },
        ],
      };
    }

    if (name === "view_session") {
      const session = loadSession(args.sessionId as string);
      if (!session)
        return errorResult(`Session not found: ${args.sessionId}`);
      const text = renderTimeline(session, {
        maxChars: (args.maxChars as number) ?? 4000,
      });
      return { content: [{ type: "text", text }] };
    }

    if (name === "migrate_session") {
      const result = migrate(args.sessionId as string, {
        to: args.to as Agent,
        mode: (args.mode as MigrateMode) || "faithful",
        cwd: args.cwd as string | undefined,
      });
      const note =
        result.to === "claude"
          ? "\nNote: Claude resumes by cwd — run the command from the same working directory."
          : "";
      return {
        content: [
          {
            type: "text",
            text:
              `Migrated ${result.from} → ${result.to} (mode: ${result.mode}).\n` +
              `New session: ${result.sessionId}\n` +
              `File: ${result.filePath}\n` +
              `Turns: ${result.turnsWritten}\n` +
              `Resume with: ${result.resumeCommand}${note}`,
          },
        ],
      };
    }

    return errorResult(`Unknown tool: ${name}`);
  } catch (e) {
    return errorResult(e instanceof Error ? e.message : String(e));
  }
});

function errorResult(msg: string) {
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logging; stdout is the MCP channel.
  console.error("xfer MCP server running on stdio");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
