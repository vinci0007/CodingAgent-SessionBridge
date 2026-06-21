/**
 * Zero-dependency web server for the unified session viewer.
 *
 * Serves a single-page app that lists sessions from both agents and renders any
 * session's full timeline. JSON API:
 *   GET /api/sessions?agent=&cwd=&limit=     -> SessionIndexEntry[]
 *   GET /api/session/:id                     -> UnifiedSession
 *   POST /api/migrate {sessionId,to,mode,cwd}-> MigrateResult
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listSessions, loadSession, indexStatus } from "../core/index.js";
import { migrate, type MigrateMode } from "../core/migrate.js";
import { switchSession } from "../core/sync.js";
import { syncStatus } from "../core/sync.js";
import type { Agent } from "../core/model.js";
import { PAGE } from "./page.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const staticRoot = path.resolve(__dirname, "../../dist-ui");

function sendJson(res: http.ServerResponse, code: number, data: unknown) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendFile(res: http.ServerResponse, filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
    const ext = path.extname(filePath).toLowerCase();
    const contentType =
      ext === ".html"
        ? "text/html; charset=utf-8"
        : ext === ".js"
          ? "text/javascript; charset=utf-8"
          : ext === ".css"
            ? "text/css; charset=utf-8"
            : "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
    res.end(fs.readFileSync(filePath));
    return true;
  } catch {
    return false;
  }
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

export function startWebServer(port: number): Promise<void> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`);
    const pathname = url.pathname;

    try {
      if (pathname === "/" || pathname === "/index.html") {
        if (sendFile(res, path.join(staticRoot, "index.html"))) return;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(PAGE);
        return;
      }

      if (!pathname.startsWith("/api/")) {
        const staticPath = path.resolve(staticRoot, `.${pathname}`);
        if (staticPath.startsWith(staticRoot) && sendFile(res, staticPath)) return;
      }

      if (pathname === "/api/sessions") {
        const agent = (url.searchParams.get("agent") as Agent) || undefined;
        const cwd = url.searchParams.get("cwd") || undefined;
        const limit = url.searchParams.get("limit");
        const parsedLimit = limit ? Number.parseInt(limit, 10) : 200;
        const sessions = listSessions({
          agent: agent || undefined,
          cwd: cwd || undefined,
          limit: Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : 200,
        });
        return sendJson(res, 200, sessions);
      }

      const m = pathname.match(/^\/api\/session\/(.+)$/);
      if (m) {
        const session = loadSession(decodeURIComponent(m[1]));
        if (!session) return sendJson(res, 404, { error: "not found" });
        return sendJson(res, 200, session);
      }

      if (pathname === "/api/migrate" && req.method === "POST") {
        const body = await readBody(req);
        const { sessionId, to, mode, cwd } = body;
        if (!sessionId || (to !== "claude" && to !== "codex"))
          return sendJson(res, 400, { error: "sessionId and to required" });
        const result = migrate(sessionId, {
          to,
          mode: (mode as MigrateMode) || "faithful",
          cwd,
        });
        return sendJson(res, 200, result);
      }

      if (pathname === "/api/switch" && req.method === "POST") {
        const body = await readBody(req);
        const { to, from, cwd, sourceSessionId, mode, force } = body;
        if (to !== "claude" && to !== "codex")
          return sendJson(res, 400, { error: "to must be claude or codex" });
        const result = switchSession({ to, from, cwd, sourceSessionId, mode, force });
        return sendJson(res, 200, result);
      }

      if (pathname === "/api/index-status") {
        return sendJson(res, 200, indexStatus());
      }

      if (pathname === "/api/sync-status") {
        const cwd = url.searchParams.get("cwd") || undefined;
        return sendJson(res, 200, { text: syncStatus(cwd) });
      }

      sendJson(res, 404, { error: "not found" });
    } catch (e) {
      sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      console.log(`\n  xfer web viewer running:\n    http://localhost:${port}\n`);
      console.log("  Press Ctrl+C to stop.\n");
      resolve();
    });
  });
}
