#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = String(pkg.version || "0.0.0");
const platform = process.argv[2] || platformName();
const bundleRoot = path.join(root, "src-tauri", "target", "release", "bundle");
const outRoot = path.join(root, "dist-release", `xfer-${version}-${platform}`);

function platformName() {
  if (process.platform === "win32") return "win-x64";
  if (process.platform === "darwin") return os.arch() === "arm64" ? "mac-arm64" : "mac-x64";
  if (process.platform === "linux") return os.arch() === "arm64" ? "linux-arm64" : "linux-x64";
  return `${process.platform}-${os.arch()}`;
}

function copyFile(src, destDir, destName = path.basename(src)) {
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, path.join(destDir, destName));
}

function copyDir(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

function files(dir, exts) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map((name) => path.join(dir, name))
    .filter((file) => fs.statSync(file).isFile() && exts.includes(path.extname(file).toLowerCase()));
}

fs.mkdirSync(outRoot, { recursive: true });

const staged = [];
for (const file of files(path.join(bundleRoot, "msi"), [".msi"])) {
  const destName = `xfer-${version}-${platform}-installer.msi`;
  copyFile(file, outRoot, destName);
  staged.push(destName);
}
for (const file of files(path.join(bundleRoot, "nsis"), [".exe"])) {
  const destName = `xfer-${version}-${platform}-setup.exe`;
  copyFile(file, outRoot, destName);
  staged.push(destName);
}
for (const file of files(path.join(bundleRoot, "dmg"), [".dmg"])) {
  const destName = `xfer-${version}-${platform}.dmg`;
  copyFile(file, outRoot, destName);
  staged.push(destName);
}
for (const file of files(path.join(bundleRoot, "appimage"), [".appimage"])) {
  const destName = `xfer-${version}-${platform}.AppImage`;
  copyFile(file, outRoot, destName);
  staged.push(destName);
}
for (const file of files(path.join(bundleRoot, "deb"), [".deb"])) {
  const destName = `xfer-${version}-${platform}.deb`;
  copyFile(file, outRoot, destName);
  staged.push(destName);
}
for (const file of files(path.join(bundleRoot, "rpm"), [".rpm"])) {
  const destName = `xfer-${version}-${platform}.rpm`;
  copyFile(file, outRoot, destName);
  staged.push(destName);
}

const macAppDir = path.join(bundleRoot, "macos", "xfer.app");
if (fs.existsSync(macAppDir)) {
  const destName = `xfer-${version}-${platform}.app`;
  copyDir(macAppDir, path.join(outRoot, destName));
  staged.push(destName);
}

if (!staged.length) {
  console.log(`No bundle artifacts found under ${bundleRoot}`);
} else {
  console.log(`Versioned bundle artifacts staged: ${outRoot}`);
  for (const name of staged) console.log(`- ${name}`);
}
