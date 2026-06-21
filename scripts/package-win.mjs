#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = String(pkg.version || "0.0.0");
const tauriCli = path.join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
const wixTools = path.join(process.env.LOCALAPPDATA || "", "tauri", "WixTools314");
const wixDir = path.join(root, "src-tauri", "target", "release", "wix", "x64");
const msiOut = path.join(root, "src-tauri", "target", "release", "bundle", "msi", `xfer_${version}_x64_en-US.msi`);

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, {
    cwd: opts.cwd || root,
    env: process.env,
    stdio: opts.allowFailure ? "pipe" : "inherit",
    encoding: opts.allowFailure ? "utf8" : undefined,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !opts.allowFailure) {
    throw new Error(`${path.basename(command)} ${args.join(" ")} failed with exit code ${result.status}`);
  }
  return result;
}

function requireFile(filePath, message) {
  if (!fs.existsSync(filePath)) throw new Error(`${message}: ${filePath}`);
}

requireFile(tauriCli, "Missing local Tauri CLI");

run(process.execPath, [tauriCli, "build", "--bundles", "nsis"]);

const msiStatus = run(process.execPath, [tauriCli, "build", "--bundles", "msi"], { allowFailure: true });
if ((msiStatus.status || 0) === 0) process.exit(0);

function printCapturedMsiFailure() {
  if (msiStatus.stdout) process.stdout.write(msiStatus.stdout);
  if (msiStatus.stderr) process.stderr.write(msiStatus.stderr);
}

const light = path.join(wixTools, "light.exe");
const wixUi = path.join(wixTools, "WixUIExtension.dll");
const wixUtil = path.join(wixTools, "WixUtilExtension.dll");
const locale = path.join(wixDir, "locale.wxl");
const wixobj = path.join(wixDir, "main.wixobj");

requireFile(light, "Missing WiX light.exe");
requireFile(wixUi, "Missing WiX UI extension");
requireFile(wixUtil, "Missing WiX util extension");
requireFile(locale, "Missing generated WiX locale");
requireFile(wixobj, "Missing generated WiX object");

fs.mkdirSync(path.dirname(msiOut), { recursive: true });
try {
  run(light, [
    "-sval",
    "-ext",
    wixUi,
    "-ext",
    wixUtil,
    "-o",
    msiOut,
    "-cultures:en-us",
    "-loc",
    locale,
    wixobj,
  ]);
} catch (error) {
  printCapturedMsiFailure();
  throw error;
}

console.log(`MSI package produced with WiX validation skipped: ${msiOut}`);
