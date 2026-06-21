#!/usr/bin/env node
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = String(process.argv[2] || pkg.version || "0.0.0").replace(/^v/, "");
const tag = `v${version}`;
const outDir = path.join(root, ".release");
const notesFile = path.join(outDir, "release-notes.md");
const outputFile = process.env.GITHUB_OUTPUT;

function git(args, fallback = "") {
  try {
    return execSync(`git ${args}`, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return fallback;
  }
}

function tagExists(name) {
  return git(`rev-parse -q --verify refs/tags/${name}`) !== "";
}

function previousPackageVersion() {
  const raw = git("show HEAD^:package.json");
  if (!raw) return "";
  try {
    return String(JSON.parse(raw).version || "");
  } catch {
    return "";
  }
}

function previousTag() {
  return git("tag --sort=-v:refname")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && line !== tag)[0] || "";
}

function sanitize(line) {
  const blockedUrl = "https://dc.hhhl.cc/chat/room/" + "amlc1bekzi";
  const blockedGroup = "QQ" + "群";
  return line
    .split(blockedUrl).join("[redacted]")
    .split(blockedGroup).join("[redacted]");
}

const manual = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
const prevVersion = previousPackageVersion();
const versionChanged = manual || !prevVersion || prevVersion !== version;
const exists = tagExists(tag);
const shouldRelease = versionChanged && !exists;
const prevTag = previousTag();
const range = prevTag ? `${prevTag}..HEAD` : "HEAD";
const subjects = git(`log ${range} --pretty=format:%s`)
  .split(/\r?\n/)
  .map((line) => sanitize(line.trim()))
  .filter(Boolean);
const fallback = subjects.length ? subjects : [`Prepare ${tag} release.`];

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(notesFile, `# xfer ${tag}

## English

Repository name: agent-session-bridge

Changes since ${prevTag || "the initial version"}:

${fallback.map((line) => `- ${line}`).join("\n")}

## 中文

仓库名：agent-session-bridge

自 ${prevTag || "初始版本"} 以来的功能更新：

${fallback.map((line) => `- ${line}`).join("\n")}
`, "utf8");

if (outputFile) {
  fs.appendFileSync(outputFile, `version=${version}\n`);
  fs.appendFileSync(outputFile, `tag=${tag}\n`);
  fs.appendFileSync(outputFile, `previous_tag=${prevTag}\n`);
  fs.appendFileSync(outputFile, `notes_file=${notesFile.replace(/\\/g, "/")}\n`);
  fs.appendFileSync(outputFile, `should_release=${shouldRelease ? "true" : "false"}\n`);
}

console.log(`version=${version}`);
console.log(`tag=${tag}`);
console.log(`previous_tag=${prevTag || "(none)"}`);
console.log(`should_release=${shouldRelease}`);
console.log(`notes_file=${notesFile}`);
