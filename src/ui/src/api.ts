export type Agent = "claude" | "codex";
export type ClientId = Agent | "zcode" | "opencode";

export interface SessionIndexEntry {
  agent: Agent;
  sessionId: string;
  filePath: string;
  cwd?: string;
  model?: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  turnCount?: number;
  isSidechain?: boolean;
  subagents?: string[];
  parseError?: string;
  archived?: boolean;
}

export interface UnifiedSession {
  meta: SessionIndexEntry;
  turns: Array<{
    id: string;
    role: "user" | "assistant" | "system" | "tool";
    timestamp?: string;
    blocks: Array<
      | { kind: "text"; text: string }
      | { kind: "thinking"; text: string; encrypted?: boolean }
      | { kind: "tool_call"; id: string; name: string; input: unknown }
      | { kind: "tool_result"; callId: string; output: string; isError?: boolean }
    >;
  }>;
}

export interface MigrateResult {
  from: Agent;
  to: Agent;
  mode: "faithful" | "replay";
  sessionId: string;
  filePath: string;
  resumeCommand: string;
  turnsWritten: number;
  modelMapping: ModelMapping;
}

export interface SwitchResult {
  reused: boolean;
  sourceAgent: Agent;
  sourceSessionId: string;
  targetAgent: Agent;
  targetSessionId: string;
  targetFilePath?: string;
  resumeCommand: string;
  statePath: string;
  modelMapping?: ModelMapping;
  note?: string;
}

export interface ModelMapping {
  sourceModel?: string;
  targetModel: string;
  changed: boolean;
  reason: string;
}

export interface SessionMapEntry {
  cwd: string;
  sourceAgent: Agent;
  sourceSessionId: string;
  targetAgent: Agent;
  targetSessionId: string;
  targetFilePath: string;
  createdAt: string;
  sourceUpdatedAt?: string;
}

export interface UndoMigrationResult {
  removedMapping: boolean;
  removedTargetFile: boolean;
  sourceAgent: Agent;
  sourceSessionId: string;
  targetAgent: Agent;
  targetSessionId: string;
  targetFilePath: string;
  statePath: string;
  desktopIndexRemoval?: unknown;
}

export interface SyncBackResult {
  sourceAgent: Agent;
  backSessionId: string;
  backFilePath: string;
  resumeCommand: string;
  turnsWritten: number;
  modelMapping: ModelMapping;
  statePath: string;
  note: string;
}

export interface XferSettings {
  storageRoot?: string;
  stateRoot?: string;
  logRoot?: string;
  tempRoot?: string;
  archiveRoot?: string;
  databasePath?: string;
  clientPaths?: Record<string, string>;
  defaultModels?: Record<string, string>;
  modelAliases?: Record<string, string>;
  remoteClients?: Array<{
    id: string;
    label: string;
    agent: string;
    host: string;
    port?: number;
    username: string;
    password?: string;
  }>;
}

export interface SessionFileInfo {
  found: boolean;
  agent?: Agent;
  sessionId: string;
  filePath?: string;
  entry?: SessionIndexEntry;
}

export interface ArchivedSession {
  archiveId: string;
  agent: Agent;
  sessionId: string;
  originalPath: string;
  archivePath: string;
  archivedAt: string;
  cwd?: string;
  title?: string;
  parseError?: string;
}

export interface ArchiveSessionResult {
  archive: ArchivedSession;
  metadataPath: string;
  desktopIndexRemoval?: unknown;
}

export interface DeleteSessionResult {
  removedFile: boolean;
  agent: Agent;
  sessionId: string;
  filePath: string;
  desktopIndexRemoval?: unknown;
}

export interface RestoreArchiveResult {
  restored: boolean;
  agent: Agent;
  sessionId: string;
  restoredPath: string;
  archiveId: string;
}

export interface RepairSessionResult {
  agent: Agent;
  sourceSessionId: string;
  sourceFilePath: string;
  repairedSessionId: string;
  repairedFilePath: string;
  turnsWritten: number;
  method: string;
}

export interface SourceStatus {
  available: boolean;
  count: number;
  error?: string;
}

export interface IndexStatus {
  claude: SourceStatus;
  codex: SourceStatus;
}

export interface ClientProcess {
  pid: number;
  name: string;
  path?: string;
}

export interface ClientStatus {
  agent: ClientId;
  running: boolean;
  canRestart: boolean;
  processes: ClientProcess[];
  note: string;
  launchable?: boolean;
  launchPath?: string;
}

interface InvokeApi {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

declare global {
  interface Window {
    __TAURI__?: { core?: InvokeApi };
  }
}

async function invoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const core = window.__TAURI__?.core;
  if (!core) throw new Error("Tauri invoke is not available");
  return core.invoke<T>(command, { args });
}

function isTauri(): boolean {
  return !!window.__TAURI__?.core;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error || response.statusText);
  return data;
}

export const api = {
  runtime: isTauri() ? "app" : "web",

  async listSessions(input: { agent?: Agent; cwd?: string; limit?: number } = {}) {
    if (isTauri()) return invoke<SessionIndexEntry[]>("list_sessions", input);
    const q = new URLSearchParams();
    if (input.agent) q.set("agent", input.agent);
    if (input.cwd) q.set("cwd", input.cwd);
    if (input.limit) q.set("limit", String(input.limit));
    return json<SessionIndexEntry[]>(`/api/sessions?${q}`);
  },

  async getSession(sessionId: string) {
    if (isTauri()) return invoke<UnifiedSession>("get_session", { sessionId });
    return json<UnifiedSession>(`/api/session/${encodeURIComponent(sessionId)}`);
  },

  async migrateSession(input: {
    sessionId: string;
    to: Agent;
    mode?: "faithful" | "replay";
    cwd?: string;
  }) {
    if (isTauri()) return invoke<MigrateResult>("migrate_session", input);
    return json<MigrateResult>("/api/migrate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  },

  async switchSession(input: {
    to: Agent;
    from?: Agent;
    cwd?: string;
    sourceSessionId?: string;
    mode?: "faithful" | "replay";
    force?: boolean;
  }) {
    if (isTauri()) return invoke<SwitchResult>("switch_session", input);
    return json<SwitchResult>("/api/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  },

  async indexStatus() {
    if (isTauri()) return invoke<IndexStatus>("index_status", {});
    return json<IndexStatus>("/api/index-status");
  },

  async findSessionInfo(input: { sessionId: string }) {
    if (!isTauri()) throw new Error("Session ID lookup is only available in the desktop app");
    return invoke<SessionFileInfo>("find_session_info", input);
  },

  async archivePreview(input: { sessionId: string }) {
    if (!isTauri()) throw new Error("Session archive is only available in the desktop app");
    return invoke<ArchiveSessionResult>("archive_preview", input);
  },

  async archiveSession(input: { sessionId: string }) {
    if (!isTauri()) throw new Error("Session archive is only available in the desktop app");
    return invoke<ArchiveSessionResult>("archive_session", input);
  },

  async deleteSession(input: { sessionId: string }) {
    if (!isTauri()) throw new Error("Session delete is only available in the desktop app");
    return invoke<DeleteSessionResult>("delete_session", input);
  },

  async listArchives() {
    if (!isTauri()) return [] as ArchivedSession[];
    return invoke<ArchivedSession[]>("list_archives", {});
  },

  async restoreArchive(input: { archiveId: string }) {
    if (!isTauri()) throw new Error("Archive restore is only available in the desktop app");
    return invoke<RestoreArchiveResult>("restore_archive", input);
  },

  async repairSession(input: { sessionId: string; cwd?: string }) {
    if (!isTauri()) throw new Error("Session repair is only available in the desktop app");
    return invoke<RepairSessionResult>("repair_session", input);
  },

  async repairSessionsBatch(input: { agents?: Agent[]; cwd?: string }) {
    if (!isTauri()) throw new Error("Session repair is only available in the desktop app");
    return invoke<{
      total: number;
      repaired: number;
      failed: number;
      skipped: number;
      items: Array<{
        sessionId: string;
        agent?: Agent;
        ok: boolean;
        repairedSessionId?: string;
        repairedFilePath?: string;
        method?: string;
        turnsWritten?: number;
        error?: string;
      }>;
    }>("repair_sessions_batch", input);
  },

  async openInAgent(input: { agent: Agent; sessionId: string; cwd?: string }) {
    if (!isTauri()) throw new Error("Opening a terminal is only available in the desktop app");
    return invoke<{ ok: boolean; command: string; cwd?: string; filePath?: string }>("open_in_agent", input);
  },

  async openClaudeDesktopImport(input: { sessionId: string; cwd?: string }) {
    if (!isTauri()) throw new Error("Claude Desktop import is only available in the desktop app");
    return invoke<{ ok: boolean; command: string; cwd?: string; filePath?: string; reason?: string; requiresManualClaudeCode?: boolean }>("open_claude_desktop_import", input);
  },

  async agentClientStatus(input: { agent: ClientId }) {
    if (!isTauri()) {
      return { agent: input.agent, running: false, canRestart: false, processes: [], note: "Desktop client detection is only available in the desktop app" } as ClientStatus;
    }
    return invoke<ClientStatus>("agent_client_status", input);
  },

  async restartAgentClient(input: { agent: Agent }) {
    if (!isTauri()) throw new Error("Restarting a desktop client is only available in the desktop app");
    return invoke<ClientStatus>("restart_agent_client", input);
  },

  async openAgentClient(input: { agent: Agent }) {
    if (!isTauri()) throw new Error("Opening a desktop client is only available in the desktop app");
    return invoke<ClientStatus>("open_agent_client", input);
  },

  async testRemoteConnection(input: { host: string; port?: number; username: string; password?: string }) {
    if (!isTauri()) throw new Error("Remote connection testing is only available in the desktop app");
    return invoke<{ ok: boolean; exitCode?: number; stdout: string; stderr: string; target: string; port: string; note: string }>("test_remote_connection", input);
  },

  async verifyCodexDesktopIndex(input: { sessionId: string }) {
    if (!isTauri()) throw new Error("Codex desktop index verification is only available in the desktop app");
    return invoke<{ ok: boolean; sqliteOk: boolean; sessionIndexOk: boolean; archived?: number; rolloutPath: string; stateDb: string; sessionIndex: string }>("verify_codex_desktop_index", input);
  },

  async verifyClaudeDesktopIndex(input: { sessionId: string }) {
    if (!isTauri()) throw new Error("Claude desktop index verification is only available in the desktop app");
    return invoke<{ ok: boolean; count: number; files: string[] }>("verify_claude_desktop_index", input);
  },

  async syncMappings(input: { cwds?: string[] } = {}) {
    if (isTauri()) return invoke<SessionMapEntry[]>("sync_mappings", input);
    return [] as SessionMapEntry[];
  },

  async undoMigration(input: { cwd?: string; sourceSessionId?: string; targetSessionId?: string; removeTargetFile?: boolean }) {
    if (!isTauri()) throw new Error("Undo migration is only available in the desktop app");
    return invoke<UndoMigrationResult>("undo_migration", input);
  },

  async syncBack(input: { targetSessionId: string; cwd?: string }) {
    if (!isTauri()) throw new Error("Sync back is only available in the desktop app");
    return invoke<SyncBackResult>("sync_back", input);
  },

  async syncStatus(input: { cwd?: string } = {}) {
    if (isTauri()) return invoke<{ text: string }>("sync_status", input);
    const q = new URLSearchParams();
    if (input.cwd) q.set("cwd", input.cwd);
    return json<{ text: string }>(`/api/sync-status?${q}`);
  },

  async getSettings() {
    if (!isTauri()) return {} as XferSettings;
    return invoke<XferSettings>("get_settings", {});
  },

  async saveSettings(settings: XferSettings) {
    if (!isTauri()) throw new Error("Settings are only available in the desktop app");
    return invoke<XferSettings>("save_settings", { settings });
  },

  async resetSettings() {
    if (!isTauri()) throw new Error("Settings are only available in the desktop app");
    return invoke<XferSettings>("reset_settings", {});
  },

  async chooseDirectory(input: { title?: string } = {}) {
    if (!isTauri()) throw new Error("Folder picker is only available in the desktop app");
    return invoke<{ path?: string }>("choose_directory", input);
  },
};
