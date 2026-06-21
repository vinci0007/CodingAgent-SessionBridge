import fs from "node:fs";
import path from "node:path";
import { normalizeProjectCwd } from "./paths.js";

export interface XferSettings {
  storageRoot?: string;
  stateRoot?: string;
  logRoot?: string;
  tempRoot?: string;
}

export function envSettings(env: NodeJS.ProcessEnv = process.env): XferSettings {
  return compactSettings({
    storageRoot: env.XFER_STORAGE_ROOT,
    stateRoot: env.XFER_STATE_ROOT,
    logRoot: env.XFER_LOG_ROOT,
    tempRoot: env.XFER_TEMP_ROOT,
  });
}

export function compactSettings(settings: XferSettings): XferSettings {
  return Object.fromEntries(
    Object.entries(settings)
      .map(([key, value]) => [key, typeof value === "string" ? value.trim() : value])
      .filter(([, value]) => typeof value === "string" && value.length > 0)
  ) as XferSettings;
}

export function configuredStatePath(cwd: string): string | null {
  const settings = envSettings();
  const root = settings.stateRoot || settings.storageRoot;
  if (!root) return null;
  return path.join(path.resolve(root), encodeCwd(cwd), "state.json");
}

export function configuredTempRoot(): string | undefined {
  const settings = envSettings();
  return settings.tempRoot || settings.storageRoot;
}

export function configuredLogRoot(): string | undefined {
  const settings = envSettings();
  return settings.logRoot || settings.storageRoot;
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function encodeCwd(cwd: string): string {
  return normalizeProjectCwd(path.resolve(cwd))
    .replace(/^[A-Za-z]:/, (drive) => drive[0].toUpperCase())
    .replace(/[^A-Za-z0-9._-]+/g, "-");
}
