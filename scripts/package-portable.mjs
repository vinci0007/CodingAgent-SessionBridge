#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = String(pkg.version || "0.0.0");
const platform = process.argv[2] || platformName();
const exeName = process.platform === "win32" ? "xfer.exe" : "xfer";
const artifactBase = `xfer-${version}-${platform}`;
const outDir = path.join(root, "dist-portable", artifactBase);
const sourceExe = path.join(root, "src-tauri", "target", "release", exeName);
const outExe = path.join(outDir, process.platform === "win32" ? `${artifactBase}.exe` : "xfer");
const portableReadme = path.join(root, "README-portable.txt");

function platformName() {
  if (process.platform === "win32") return "win-x64";
  if (process.platform === "darwin") return os.arch() === "arm64" ? "mac-arm64" : "mac-x64";
  if (process.platform === "linux") return os.arch() === "arm64" ? "linux-arm64" : "linux-x64";
  return `${process.platform}-${os.arch()}`;
}

function requirePath(filePath, hint) {
  if (!fs.existsSync(filePath)) throw new Error(`${hint}: ${filePath}`);
}

requirePath(sourceExe, "Missing release executable; run tauri build --no-bundle first");
fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(sourceExe, outExe);
if (process.platform !== "win32") fs.chmodSync(outExe, 0o755);

if (fs.existsSync(portableReadme)) {
  fs.copyFileSync(portableReadme, path.join(outDir, "README-portable.txt"));
}

console.log(`Portable package staged: ${outDir}`);
console.log(`Portable executable: ${outExe}`);
