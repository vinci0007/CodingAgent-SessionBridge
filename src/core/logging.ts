import fs from "node:fs";
import path from "node:path";
import { configuredLogRoot, ensureDir } from "./settings.js";

export function logEvent(event: string, data: Record<string, unknown> = {}): void {
  const root = configuredLogRoot();
  if (!root) return;

  try {
    ensureDir(root);
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + "\n";
    fs.appendFileSync(path.join(root, "xfer.log"), line, "utf8");
  } catch {
    // Logging must never break session operations.
  }
}
