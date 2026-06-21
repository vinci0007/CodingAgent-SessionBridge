#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const sourceDir = path.join(root, "assets");
const outDir = path.join(root, "src", "ui", "public");
const files = [
  "client_buton.png",
  "logo_black.svg",
  "logo_rainbow.svg",
  "logo_white.svg",
];

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

for (const name of files) {
  const source = path.join(sourceDir, name);
  if (!fs.existsSync(source)) {
    throw new Error(`Missing UI asset: ${source}`);
  }
  fs.copyFileSync(source, path.join(outDir, name));
}

console.log(`Prepared ${files.length} UI assets in: ${outDir}`);
