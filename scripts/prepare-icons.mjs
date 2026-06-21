#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const source = path.join(root, "assets", "logo_rainbow.png");
const iconDir = path.join(root, "src-tauri", "icons");
const icoTarget = path.join(iconDir, "icon.ico");
const pngTargets = [
  ["32x32.png", "32x32"],
  ["128x128.png", "128x128"],
  ["128x128@2x.png", "256x256"],
];

if (!fs.existsSync(source)) {
  throw new Error(`Missing rainbow icon source: ${source}`);
}

fs.mkdirSync(iconDir, { recursive: true });

for (const [name, size] of pngTargets) {
  const out = path.join(iconDir, name);
  const png = spawnSync("magick", [source, "-resize", `${size}!`, out], {
    cwd: root,
    stdio: "inherit",
    shell: false,
  });
  if (png.error || png.status !== 0) {
    if (!fs.existsSync(out)) {
      throw png.error || new Error(`magick failed to create ${name} with exit code ${png.status}`);
    }
    console.warn(`ImageMagick failed to refresh ${name}; keeping existing file.`);
  }
}

const result = spawnSync("magick", [
  source,
  "-define",
  "icon:auto-resize=256,128,64,48,32,16",
  icoTarget,
], {
  cwd: root,
  stdio: "inherit",
  shell: false,
});

if (result.error || result.status !== 0) {
  if (!fs.existsSync(icoTarget)) {
    throw result.error || new Error(`magick failed with exit code ${result.status}`);
  }
  console.warn("ImageMagick is unavailable or failed; keeping existing src-tauri/icons/icon.ico.");
}

console.log(`Prepared Tauri icons in: ${iconDir}`);
