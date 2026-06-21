#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const exe = path.join(process.cwd(), "src-tauri", "target", "release", "xfer.exe");

if (fs.existsSync(exe)) {
  fs.rmSync(exe, { force: true });
  console.log(`Removed stale release executable: ${exe}`);
}
