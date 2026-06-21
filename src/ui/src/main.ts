import { api, type Agent, type ClientId, type ClientStatus, type IndexStatus, type ModelMapping, type SessionIndexEntry, type SessionMapEntry, type SwitchResult, type MigrateResult, type UnifiedSession } from "./api.js";
import "./styles.css";
import type { ArchivedSession } from "./api.js";

const app = document.querySelector<HTMLDivElement>("#app")!;

type DisplaySession = SessionIndexEntry & {
  mapping?: SessionMapEntry;
  mappingRole?: "source" | "target";
  mappedPeer?: SessionIndexEntry;
};

let rawSessions: SessionIndexEntry[] = [];
let sessions: DisplaySession[] = [];
let syncMappings: SessionMapEntry[] = [];
let current: UnifiedSession | null = null;
let selectedId = "";

const EXPANDED_KEY = "xfer.expandedProjects.v2";
const EXPANDED_SUBAGENT_KEY = "xfer.expandedSubagents.v2";
const AUTOSYNC_KEY = "xfer.autoSync.v1";
const THEME_KEY = "xfer.theme.v1";
const BG_KEY = "xfer.background.v1";
const CLIENT_ORDER_KEY = "xfer.clientOrder.v1";
const REFRESH_INTERVAL_SECONDS = 3;
const STATUS_EVERY_N_TICKS = 10;
const DEFAULT_CLIENT_ORDER: ClientId[] = ["claude", "codex", "zcode", "opencode"];

const expandedProjects = loadSet(EXPANDED_KEY);
const expandedSubagents = loadSet(EXPANDED_SUBAGENT_KEY);
const autoSyncOn = loadSet(AUTOSYNC_KEY);
const autoSyncSeen = new Map<string, string>();

let refreshCountdown = REFRESH_INTERVAL_SECONDS;
let refreshTimer: number | undefined;
let paused = true;
let tickCount = 0;
let lastRenderSig = "";
let listRequestSeq = 0;
let filterTimer: number | undefined;
let deferredRefreshTimer: number | undefined;
let listRefreshInFlight = false;
let statusRefreshInFlight = false;
let currentTheme: Theme = loadTheme();
let currentBg = localStorage.getItem(BG_KEY) || "";
let clientOrder = loadClientOrder();
const clientStates = new Map<ClientId, { kind: "ok" | "warn" | "off"; tip: string }>();

type Theme = "system" | "light" | "dark";

app.innerHTML = `
<div class="app">
  <nav class="rail" aria-label="主导航">
    <div class="rail-brand" title="xfer">${xferLogo("rail-logo")}</div>
    <button class="rail-btn active" id="navProjects" data-tip="项目与会话" title="项目与会话">${icon("folder")}</button>
    <button class="rail-btn" id="navSync" data-tip="同步状态" title="同步状态">${icon("sync")}</button>
    <button class="rail-btn" id="navSettings" data-tip="设置" title="设置">${icon("settings")}</button>
    <div class="rail-spacer"></div>
    <div class="rail-status-shell">
      <div class="rail-status" id="statusDots" aria-label="服务状态">
        ${renderRailStatusHtml()}
      </div>
      <button class="agent-drawer-trigger" id="agentDrawerTrigger" data-tip="客户端" title="客户端"><img src="/client_buton.png" alt="" /></button>
      <div id="agentDrawer" class="agent-drawer" hidden>
        ${renderClientDrawerHtml()}
      </div>
    </div>
    <button class="rail-btn" id="navTheme" data-tip="切换主题" title="切换主题">${icon("theme")}</button>
  </nav>
  <aside class="list-pane">
    <div class="list-head">
      <select id="agentFilter" title="按客户端筛选">
        <option value="">全部客户端</option>
        <option value="claude">Claude</option>
        <option value="codex">Codex</option>
      </select>
      <input id="cwdFilter" placeholder="按项目路径 / 会话 ID 检索，回车生效" />
      <button id="autoToggle" class="icon-btn paused" title="自动刷新：关闭，点击开启">${icon("play")}<span id="refreshCountdown">暂停</span></button>
      <button id="refreshNow" class="icon-btn raised" title="手动刷新">${icon("refresh")}<span>刷新</span></button>
    </div>
    <div id="list" class="list"><div class="spin">加载中...</div></div>
  </aside>
  <main class="main">
    <header class="mainhead">
      <div id="info" class="info">
        <div class="title">选择一个会话</div>
        <div class="sub">默认按项目折叠；右键会话可迁移、切换或开启自动同步。</div>
      </div>
      <div class="main-actions">
        <button id="switchClaude" class="quick-btn" title="把当前项目最新会话切换到 Claude">${icon("external")}<span>切换到 Claude</span></button>
        <button id="switchCodex" class="quick-btn" title="把当前项目最新会话切换到 Codex">${icon("external")}<span>切换到 Codex</span></button>
        <button id="migrateBtn" class="btn-3d" disabled>${icon("external")}<span>迁移当前会话</span></button>
      </div>
    </header>
    <section id="timeline" class="timeline"><div class="empty">从左侧选择会话。</div></section>
  </main>
</div>
<dialog id="dialog">
  <div id="dialogBody" class="dialog-body"></div>
  <div class="dialog-actions"><button id="closeDialog" class="btn-3d">关闭</button></div>
</dialog>
<div id="ctxMenu" class="ctx-menu" hidden></div>
<div id="startupOverlay" class="startup-overlay" aria-live="polite">
  <div class="startup-card">
    ${xferLogo("startup-logo xfer-logo")}
    <div class="startup-title">xfer</div>
    <div id="startupStep" class="startup-step">正在初始化界面...</div>
    <div class="startup-bar"><span></span></div>
  </div>
</div>
`;

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;
const input = (selector: string) => $(selector) as HTMLInputElement;
const select = (selector: string) => $(selector) as HTMLSelectElement;
const dialog = (selector: string) => $(selector) as HTMLDialogElement;

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function icon(name: string, cls = "ic"): string {
  const p: Record<string, string> = {
    refresh: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
    play: '<polygon points="7 4 19 12 7 20 7 4"/>',
    pause: '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>',
    settings: '<path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
    sync: '<path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="M4 4l5 5"/>',
    folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    bot: '<rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><path d="M8 16h.01"/><path d="M16 16h.01"/>',
    terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
    spark: '<path d="M12 2 14.8 8.2 21 11l-6.2 2.8L12 20l-2.8-6.2L3 11l6.2-2.8Z"/>',
    wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-2.4Z"/>',
    theme: '<path d="M12 3a6 6 0 0 0 9 7.8A9 9 0 1 1 12 3Z"/>',
    triangle: '<polygon points="9 5 19 12 9 19 9 5"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/>',
  };
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p[name] || ""}</svg>`;
}

function xferLogo(cls = "xfer-logo"): string {
  return `<picture class="${cls}" aria-hidden="true"><img src="/logo_white.svg" alt="" /></picture>`;
}

function clientLabel(client: ClientId): string {
  return ({ claude: "Claude", codex: "Codex", zcode: "Zcode", opencode: "OpenCode" } as Record<ClientId, string>)[client];
}

function loadClientOrder(): ClientId[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(CLIENT_ORDER_KEY) || "[]") as ClientId[];
    const valid = parsed.filter((id): id is ClientId => DEFAULT_CLIENT_ORDER.includes(id));
    return [...valid, ...DEFAULT_CLIENT_ORDER.filter((id) => !valid.includes(id))];
  } catch {
    return [...DEFAULT_CLIENT_ORDER];
  }
}

function saveClientOrder() {
  localStorage.setItem(CLIENT_ORDER_KEY, JSON.stringify(clientOrder));
}

function clientState(client: ClientId): { kind: "ok" | "warn" | "off"; tip: string } {
  return clientStates.get(client) || { kind: "off", tip: `${clientLabel(client)} 未检测` };
}

function renderRailStatusHtml(): string {
  return clientOrder.map((client) => {
    const state = clientState(client);
    return `<span class="agent-dot ${client} ${state.kind}" data-client="${client}" data-tip="${esc(state.tip)}">${clientMark(client, false)}</span>`;
  }).join("");
}

function renderClientDrawerHtml(): string {
  const tiles = clientOrder.map((client) => renderClientTile(client)).join("");
  return `<div class="agent-drawer-title">客户端</div><div class="agent-grid">${tiles}<button class="agent-tile add-client" data-client-add="1" title="手动增加新客户端">${icon("plus")}<span>添加</span></button></div>`;
}
function renderClientTile(client: ClientId): string {
  const state = clientState(client);
  return `<button class="agent-tile ${client} ${state.kind}" data-client="${client}" data-tip="${esc(state.tip)}">
    <span class="drag-grip"></span>${clientMark(client)}<span class="agent-state-dot"></span>
  </button>`;
}

function rerenderClientArea() {
  const status = document.querySelector<HTMLDivElement>("#statusDots");
  if (status) status.innerHTML = renderRailStatusHtml();
  const drawer = document.querySelector<HTMLDivElement>("#agentDrawer");
  if (drawer) {
    drawer.innerHTML = renderClientDrawerHtml();
    bindClientDrawer();
  }
}

function officialAgentLogo(agent: ClientId, cls = "agent-logo"): string {
  if (agent === "claude") {
    return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/>
    </svg>`;
  }
  if (agent === "zcode") {
    return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M5 4h14v3L10.7 17H19v3H5v-3L13.3 7H5z"/>
      <path fill="currentColor" opacity=".62" d="M7 2h10v2H7zm0 18h10v2H7z"/>
    </svg>`;
  }
  if (agent === "opencode") {
    return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 3.2a5.8 5.8 0 1 1 0 11.6 5.8 5.8 0 0 1 0-11.6Z"/>
      <path fill="currentColor" d="m9.4 8.8 2.8 3.2-2.8 3.2H6.3L9 12 6.3 8.8zm5.1 6.4h3.2v-2.4h-3.2z"/>
    </svg>`;
  }
  return `<svg class="${cls}" viewBox="0 0 320 320" aria-hidden="true">
    <path fill="currentColor" d="m297.06 130.97c7.26-21.79 4.76-45.66-6.85-65.48-17.46-30.4-52.56-46.04-86.84-38.68-15.25-17.18-37.16-26.95-60.13-26.81-35.04-.08-66.13 22.48-76.91 55.82-22.51 4.61-41.94 18.7-53.31 38.67-17.59 30.32-13.58 68.54 9.92 94.54-7.26 21.79-4.76 45.66 6.85 65.48 17.46 30.4 52.56 46.04 86.84 38.68 15.24 17.18 37.16 26.95 60.13 26.8 35.06.09 66.16-22.49 76.94-55.86 22.51-4.61 41.94-18.7 53.31-38.67 17.57-30.32 13.55-68.51-9.94-94.51zm-120.28 168.11c-14.03.02-27.62-4.89-38.39-13.88.49-.26 1.34-.73 1.89-1.07l63.72-36.8c3.26-1.85 5.26-5.32 5.24-9.07v-89.83l26.93 15.55c.29.14.48.42.52.74v74.39c-.04 33.08-26.83 59.9-59.91 59.97zm-128.84-55.03c-7.03-12.14-9.56-26.37-7.15-40.18.47.28 1.3.79 1.89 1.13l63.72 36.8c3.23 1.89 7.23 1.89 10.47 0l77.79-44.92v31.1c.02.32-.13.63-.38.83l-64.41 37.19c-28.69 16.52-65.33 6.7-81.92-21.95zm-16.77-139.09c7-12.16 18.05-21.46 31.21-26.29 0 .55-.03 1.52-.03 2.2v73.61c-.02 3.74 1.98 7.21 5.23 9.06l77.79 44.91-26.93 15.55c-.27.18-.61.21-.91.08l-64.42-37.22c-28.63-16.58-38.45-53.21-21.95-81.89zm221.26 51.49-77.79-44.92 26.93-15.54c.27-.18.61-.21.91-.08l64.42 37.19c28.68 16.57 38.51 53.26 21.94 81.94-7.01 12.14-18.05 21.44-31.2 26.28v-75.81c.03-3.74-1.96-7.2-5.2-9.06zm26.8-40.34c-.47-.29-1.3-.79-1.89-1.13l-63.72-36.8c-3.23-1.89-7.23-1.89-10.47 0l-77.79 44.92v-31.1c-.02-.32.13-.63.38-.83l64.41-37.16c28.69-16.55 65.37-6.7 81.91 22 6.99 12.12 9.52 26.31 7.15 40.1zm-168.51 55.43-26.94-15.55c-.29-.14-.48-.42-.52-.74v-74.39c.02-33.12 26.89-59.96 60.01-59.94 14.01 0 27.57 4.92 38.34 13.88-.49.26-1.33.73-1.89 1.07l-63.72 36.8c-3.26 1.85-5.26 5.31-5.24 9.06l-.04 89.79zm14.63-31.54 34.65-20.01 34.65 20v40.01l-34.65 20-34.65-20z"/>
  </svg>`;
}

function clientMark(client: ClientId, showLabel = true): string {
  return `${officialAgentLogo(client, "agent-logo")}${showLabel ? `<span class="agent-short">${clientLabel(client)}</span>` : ""}`;
}

function agentMark(agent: Agent, showLabel = true): string {
  return clientMark(agent, showLabel);
}

function loadSet(key: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) || "[]"));
  } catch {
    return new Set();
  }
}

function saveSet(key: string, value: Set<string>) {
  localStorage.setItem(key, JSON.stringify([...value]));
}

function loadTheme(): Theme {
  const t = localStorage.getItem(THEME_KEY);
  return t === "light" || t === "dark" ? t : "system";
}

function resolvedDark(theme: Theme): boolean {
  return theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
}

function backgroundValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("data:")) return `url("${trimmed}") center / cover fixed`;
  if (/^https?:\/\//i.test(trimmed) || /^file:\/\//i.test(trimmed)) return `url("${trimmed}") center / cover fixed`;
  if (/[\\/.]\w+$/.test(trimmed)) return `url("${trimmed.replace(/\\/g, "/")}") center / cover fixed`;
  return trimmed;
}

function applyTheme(theme: Theme, bg?: string) {
  const dark = resolvedDark(theme);
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  document.querySelectorAll<HTMLImageElement>(".xfer-logo img, .rail-logo img").forEach((img) => {
    img.src = dark ? "/logo_white.svg" : "/logo_black.svg";
  });
  document.body.style.background = backgroundValue(bg || "");
}

applyTheme(currentTheme, currentBg);
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (currentTheme === "system") applyTheme("system", currentBg);
});

function isAutoSync(sessionId: string): boolean {
  return autoSyncOn.has(sessionId);
}

function toggleAutoSync(sessionId: string) {
  if (autoSyncOn.has(sessionId)) {
    autoSyncOn.delete(sessionId);
    autoSyncSeen.delete(sessionId);
  } else {
    autoSyncOn.add(sessionId);
    const s = sessions.find((it) => it.sessionId === sessionId);
    if (s) autoSyncSeen.set(sessionId, sessionSignature(s));
  }
  saveSet(AUTOSYNC_KEY, autoSyncOn);
  lastRenderSig = "";
  renderList();
}

function sessionSignature(s: SessionIndexEntry): string {
  return `${s.sessionId}:${s.updatedAt || ""}:${s.turnCount || 0}`;
}

function listSignature(list: DisplaySession[]): string {
  return list.map((s) => `${s.sessionId}:${s.updatedAt || ""}:${s.turnCount || 0}:${s.mapping?.targetSessionId || ""}:${isAutoSync(s.sessionId) ? 1 : 0}`).join("|");
}

function normalizeCwdKey(value?: string): string {
  return String(value || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function mappingSignature(list: SessionMapEntry[]): string {
  return list.map((m) => `${m.sourceSessionId}:${m.targetSessionId}:${m.createdAt}`).join("|");
}

function buildDisplaySessions(list: SessionIndexEntry[]): DisplaySession[] {
  const byId = new Map(list.map((s) => [s.sessionId, s]));
  const bySource = new Map<string, SessionMapEntry>();
  const byTarget = new Map<string, SessionMapEntry>();
  for (const mapping of syncMappings) {
    if (!bySource.has(mapping.sourceSessionId)) bySource.set(mapping.sourceSessionId, mapping);
    if (!byTarget.has(mapping.targetSessionId)) byTarget.set(mapping.targetSessionId, mapping);
  }
  return list.flatMap((session) => {
    const asTarget = byTarget.get(session.sessionId);
    if (asTarget && byId.has(asTarget.sourceSessionId)) return [];
    const asSource = bySource.get(session.sessionId);
    const mapping = asSource || asTarget;
    return [{
      ...session,
      mapping,
      mappingRole: asSource ? "source" : asTarget ? "target" : undefined,
      mappedPeer: mapping
        ? byId.get(asSource ? mapping.targetSessionId : mapping.sourceSessionId)
        : undefined,
    }];
  });
}

function matchesActiveFilters(session: DisplaySession): boolean {
  const agent = select("#agentFilter").value as Agent | "";
  const cwd = input("#cwdFilter").value.trim().toLowerCase();
  if (agent) {
    const agents = new Set<Agent>([session.agent]);
    if (session.mapping) {
      agents.add(session.mapping.sourceAgent);
      agents.add(session.mapping.targetAgent);
    }
    if (!agents.has(agent)) return false;
  }
  if (cwd) {
    const haystack = [
      session.cwd,
      session.mapping?.cwd,
      session.title,
      session.sessionId,
      session.mapping?.sourceSessionId,
      session.mapping?.targetSessionId,
    ].map((value) => String(value || "").toLowerCase()).join("\n");
    if (!haystack.includes(cwd)) return false;
  }
  return true;
}

function applyCachedSessions(opts: { silent?: boolean; keepScroll?: boolean } = {}) {
  const listEl = $("#list");
  const next = buildDisplaySessions(rawSessions).filter(matchesActiveFilters);
  const sig = `${listSignature(next)}::${mappingSignature(syncMappings)}`;
  if (opts.silent && sig === lastRenderSig) {
    resetRefreshCountdown();
    return;
  }
  lastRenderSig = sig;
  const scrollTop = opts.keepScroll ? listEl.scrollTop : 0;
  sessions = next;
  renderList();
  if (opts.keepScroll) listEl.scrollTop = scrollTop;
}

function queueFilterApply(delay = 120) {
  if (filterTimer !== undefined) window.clearTimeout(filterTimer);
  filterTimer = window.setTimeout(() => {
    filterTimer = undefined;
    lastRenderSig = "";
    applyCachedSessions();
    resetRefreshCountdown();
  }, delay);
}

async function runAutoSyncStep() {
  if (!autoSyncOn.size) return;
  const byId = new Map(buildDisplaySessions(rawSessions).map((session) => [session.sessionId, session]));
  for (const sessionId of autoSyncOn) {
    const s = byId.get(sessionId);
    if (!s) continue;
    const sig = sessionSignature(s);
    if (autoSyncSeen.get(s.sessionId) === sig) continue;
    autoSyncSeen.set(s.sessionId, sig);
    const to: Agent = s.agent === "claude" ? "codex" : "claude";
    try {
      await api.switchSession({ to, cwd: s.cwd, sourceSessionId: s.sessionId, mode: "faithful" });
    } catch {
      // Auto-sync is best-effort; errors are visible through manual status checks.
    }
  }
}

function statusKind(status: { available: boolean; error?: string } | undefined): "ok" | "warn" | "off" {
  if (!status || !status.available) return "off";
  if (status.error) return "warn";
  return "ok";
}

async function refreshStatus() {
  await refreshClientStatus();
}

function updateRefreshCountdown() {
  const el = document.querySelector<HTMLSpanElement>("#refreshCountdown");
  if (el) el.textContent = paused ? "暂停" : `${refreshCountdown}s`;
  const btn = document.querySelector<HTMLButtonElement>("#autoToggle");
  if (btn) {
    btn.classList.toggle("paused", paused);
    btn.title = paused ? "自动刷新：关闭，点击开启" : "自动刷新：开启，点击关闭";
    btn.innerHTML = `${icon(paused ? "play" : "pause")}<span id="refreshCountdown">${paused ? "暂停" : `${refreshCountdown}s`}</span>`;
  }
}

async function refreshClientStatus() {
  if (statusRefreshInFlight) return;
  statusRefreshInFlight = true;
  const indexTips = new Map<ClientId, { ok: boolean; tip: string }>();
  try {
    try {
      const st = await api.indexStatus();
      const applyIndex = (agent: Agent, s: IndexStatus["claude"]) => {
        const base = `${clientLabel(agent)} 索引${s.available ? "可用" : "不可用"}，${s.count} 个会话`;
        indexTips.set(agent, { ok: !s.error, tip: s.error ? `${base}\n索引错误：${s.error}` : base });
      };
      applyIndex("claude", st.claude);
      applyIndex("codex", st.codex);
    } catch (error) {
      indexTips.set("claude", { ok: false, tip: `Claude 索引检测失败：${String(error)}` });
      indexTips.set("codex", { ok: false, tip: `Codex 索引检测失败：${String(error)}` });
    }

    await Promise.all(clientOrder.map(async (client) => {
      try {
        const status = await api.agentClientStatus({ agent: client });
        const processTip = status.running
          ? `桌面客户端运行中${status.processes.length ? `：${status.processes.map((p) => `${p.name} #${p.pid}`).join("；")}` : ""}`
          : status.launchable
            ? "已找到客户端安装路径，但未检测到运行进程"
            : "未检测到客户端安装路径或运行进程";
        const index = indexTips.get(client);
        clientStates.set(client, {
          kind: index?.ok === false ? "warn" : status.running ? "ok" : "off",
          tip: [clientLabel(client), processTip, status.launchPath ? `路径：${status.launchPath}` : "", index?.tip || "", status.note].filter(Boolean).join("\n"),
        });
      } catch (error) {
        const index = indexTips.get(client);
        clientStates.set(client, {
          kind: "warn",
          tip: [clientLabel(client), index?.tip || "", `桌面客户端检测失败：${String(error)}`].filter(Boolean).join("\n"),
        });
      }
    }));
    rerenderClientArea();
  } finally {
    statusRefreshInFlight = false;
  }
}
function resetRefreshCountdown() {
  if (paused) return;
  refreshCountdown = REFRESH_INTERVAL_SECONDS;
  updateRefreshCountdown();
}

function startAutoRefresh() {
  if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
  updateRefreshCountdown();
  refreshTimer = window.setInterval(() => {
    if (paused || document.hidden) return;
    refreshCountdown -= 1;
    if (refreshCountdown <= 0) {
      refreshCountdown = REFRESH_INTERVAL_SECONDS;
      tickCount += 1;
      void loadList({ silent: true }).then(() => {
        void runAutoSyncStep();
        if (tickCount % STATUS_EVERY_N_TICKS === 0) void refreshClientStatus();
      });
    }
    updateRefreshCountdown();
  }, 1000);
}

function scheduleIdle(task: () => void | Promise<void>, timeout = 1200) {
  const run = () => {
    void task();
  };
  const idleWindow = window as Window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  };
  if (idleWindow.requestIdleCallback) {
    idleWindow.requestIdleCallback(run, { timeout });
  } else {
    window.setTimeout(run, Math.min(timeout, 600));
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function setStartupStep(text: string) {
  const el = document.querySelector<HTMLDivElement>("#startupStep");
  if (el) el.textContent = text;
}

function finishStartup() {
  const overlay = document.querySelector<HTMLDivElement>("#startupOverlay");
  if (!overlay) return;
  overlay.classList.add("done");
  window.setTimeout(() => overlay.remove(), 420);
}

async function bootstrapApp() {
  const started = performance.now();
  setStartupStep("加载主题与交互...");
  await sleep(90);
  setStartupStep("索引 Claude / Codex 项目与会话...");
  await loadList({ silent: true });
  const remain = Math.max(0, 900 - (performance.now() - started));
  if (remain > 0) await sleep(remain);
  setStartupStep("完成");
  finishStartup();
  scheduleIdle(() => refreshClientStatus(), 800);
}

function setPaused(next: boolean) {
  paused = next;
  if (paused) refreshCountdown = REFRESH_INTERVAL_SECONDS;
  updateRefreshCountdown();
}

async function loadList(opts: { silent?: boolean } = {}) {
  if (listRefreshInFlight && opts.silent) return;
  listRefreshInFlight = true;
  const seq = ++listRequestSeq;
  const listEl = $("#list");
  const keepExisting = rawSessions.length > 0;
  if (!opts.silent && !keepExisting) listEl.innerHTML = '<div class="spin">加载中...</div>';
  if (!opts.silent) listEl.classList.add("loading");
  try {
    const list = await api.listSessions({ limit: 600 });
    if (seq !== listRequestSeq) return;
    const cwds = [...new Set(list.map((s) => s.cwd).filter((cwd): cwd is string => !!cwd))];
    const mappings = await api.syncMappings({ cwds });
    if (seq !== listRequestSeq) return;
    rawSessions = list;
    syncMappings = mappings;
    applyCachedSessions({ silent: opts.silent, keepScroll: opts.silent || keepExisting });
    resetRefreshCountdown();
  } catch (error) {
    if (seq !== listRequestSeq) return;
    if (!opts.silent && !keepExisting) listEl.innerHTML = `<div class="empty error">${esc(error)}</div>`;
    if (!opts.silent && keepExisting) showDialog(`<h2>刷新失败</h2><p class="error">${esc(error)}</p>`);
  } finally {
    listRefreshInFlight = false;
    if (seq === listRequestSeq) listEl.classList.remove("loading");
  }
}

function scheduleBackgroundListRefresh(delay = 650) {
  if (deferredRefreshTimer !== undefined) window.clearTimeout(deferredRefreshTimer);
  deferredRefreshTimer = window.setTimeout(() => {
    deferredRefreshTimer = undefined;
    void loadList({ silent: true });
  }, delay);
}

function looksLikeSessionId(value: string): boolean {
  const text = value.trim();
  return text.length >= 8 && !/[\\/:]/.test(text) && /^[A-Za-z0-9._-]+$/.test(text);
}

async function searchBySessionId(value: string): Promise<boolean> {
  if (!looksLikeSessionId(value) || api.runtime !== "app") return false;
  try {
    const info = await api.findSessionInfo({ sessionId: value.trim() });
    if (!info.found || !info.entry) {
      showDialog(`<h2>未找到会话 ID</h2><p class="error">${esc(value)}</p>`);
      return true;
    }
    const index = rawSessions.findIndex((s) => s.sessionId === info.entry!.sessionId);
    if (index >= 0) rawSessions[index] = info.entry;
    else rawSessions.unshift(info.entry);
    if (info.entry.cwd) expandedProjects.add(info.entry.cwd);
    saveSet(EXPANDED_KEY, expandedProjects);
    input("#cwdFilter").value = info.entry.sessionId;
    lastRenderSig = "";
    applyCachedSessions({ keepScroll: false });
    await openSession(info.entry.sessionId);
    return true;
  } catch (error) {
    showDialog(`<h2>会话 ID 检索失败</h2><p class="error">${esc(error)}</p>`);
    return true;
  }
}

function applyUndoResultLocally(result: {
  sourceSessionId: string;
  targetSessionId: string;
  targetFilePath: string;
  removedTargetFile: boolean;
}) {
  const ids = new Set([result.sourceSessionId, result.targetSessionId]);
  syncMappings = syncMappings.filter((mapping) =>
    mapping.sourceSessionId !== result.sourceSessionId
    && mapping.targetSessionId !== result.targetSessionId
  );
  rawSessions = rawSessions.filter((session) =>
    session.sessionId !== result.targetSessionId
    && (!result.removedTargetFile || session.filePath !== result.targetFilePath)
  );
  if (ids.has(selectedId)) {
    selectedId = result.sourceSessionId;
  }
  applyCachedSessions({ silent: true, keepScroll: true });
}

type ProjectGroup = { cwd: string; label: string; latest: string; sessions: DisplaySession[] };

function projectLabel(cwd: string): string {
  const clean = cwd.trim();
  if (!clean) return "(无项目路径)";
  return clean.split(/[\\/]/).filter(Boolean).pop() || clean;
}

function groupSessions(list: DisplaySession[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const session of list) {
    const cwd = (session.cwd || "").trim();
    const key = cwd || "(无项目路径)";
    const time = session.updatedAt || session.createdAt || "";
    const group = groups.get(key) || { cwd: key, label: projectLabel(cwd), latest: time, sessions: [] };
    group.sessions.push(session);
    if (time > group.latest) group.latest = time;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.latest.localeCompare(a.latest) || a.label.localeCompare(b.label));
}

function sortSessions(list: DisplaySession[]): DisplaySession[] {
  return [...list].sort((a, b) => (b.updatedAt || b.createdAt || "").localeCompare(a.updatedAt || a.createdAt || ""));
}

function renderMappingBadge(s: DisplaySession): string {
  if (!s.mapping) return "";
  const role = s.mappingRole === "target" ? "迁移目标" : "迁移源";
  const source = agentLabel(s.mapping.sourceAgent);
  const target = agentLabel(s.mapping.targetAgent);
  const targetId = s.mapping.targetSessionId.slice(0, 8);
  const sourceId = s.mapping.sourceSessionId.slice(0, 8);
  const title = `${source}:${sourceId} → ${target}:${targetId}\n${s.mapping.targetFilePath || ""}`;
  const visibleId = s.mappingRole === "target" ? sourceId : targetId;
  return `<span class="map-badge ${s.mappingRole || "source"}" title="${esc(title)}"><b>${role}</b><span>${source}</span><span>→</span><span>${target}</span><code>${esc(visibleId)}</code></span>`;
}

function sessionPresenceAgents(s: DisplaySession): Agent[] {
  const agents = new Set<Agent>([s.agent]);
  if (s.mapping) {
    agents.add(s.mapping.sourceAgent);
    agents.add(s.mapping.targetAgent);
  }
  return [...agents].sort((a, b) => a.localeCompare(b));
}

function renderPresenceBadges(s: DisplaySession): string {
  return `<span class="presence-badges" title="该会话或映射关系当前涉及的客户端">${sessionPresenceAgents(s)
    .map((agent) => `<span class="badge ${agent}">${agentMark(agent)}</span>`)
    .join("")}</span>`;
}

function renderItem(s: DisplaySession, group: ProjectGroup): string {
  const updated = (s.updatedAt || "").slice(0, 16).replace("T", " ");
  const created = (s.createdAt || "").slice(0, 10);
  const active = s.sessionId === selectedId ? " active" : "";
  const syncIcon = isAutoSync(s.sessionId) ? `<span class="sync-icon" title="自动同步已开启">${icon("sync", "ic-sm")}</span>` : "";
  const model = s.model ? `<span class="meta-tag">${esc(s.model)}</span>` : "";
  const turns = s.turnCount != null ? `${s.turnCount} 轮` : "";
  const corrupt = s.parseError ? `<span class="meta-tag bad">无法读取</span>` : "";
  const loc = (s.cwd || "").split(/[\\/]/).filter(Boolean).pop() || group.label;
  const subs = uniqueSubagents(s.subagents ?? []);
  const title = s.title || "(无标题会话)";
  const fullPath = s.cwd || group.cwd;
  return `<div class="session-wrap">
    <button class="item${active}" data-id="${esc(s.sessionId)}" title="右键可迁移、切换或同步">
      <span class="item-row1">
        ${renderPresenceBadges(s)}${syncIcon}
        <span class="pill">${updated || created || "无时间"}${turns ? " · " + turns : ""}</span>
      </span>
      <div class="item-title" title="${esc(title)}">${esc(title)}</div>
      <div class="meta"><span class="project-mini">${esc(loc)}</span><span>${esc(s.sessionId.slice(0, 8))}</span>${created ? `<span>${created}</span>` : ""}</div>
      <div class="meta path" title="${esc(fullPath)}">${esc(fullPath)}</div>
      ${(model || corrupt) ? `<div class="meta2">${model}${corrupt}</div>` : ""}
      ${s.parseError ? `<div class="meta error" title="${esc(s.parseError)}">解析错误：${esc(s.parseError)}</div>` : ""}
      ${s.mapping ? `<div class="map-row">${renderMappingBadge(s)}</div>` : ""}
    </button>
    ${renderSubagents(s.sessionId, subs)}
  </div>`;
}

function uniqueSubagents(subagents: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of subagents) {
    const clean = String(name || "").trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    result.push(clean);
  }
  return result;
}

function renderSubagents(sessionId: string, subs: string[]): string {
  if (!subs.length) return "";
  const open = expandedSubagents.has(sessionId);
  return `<details class="subagent-tree" data-subagents="${esc(sessionId)}"${open ? " open" : ""}>
    <summary>${icon("bot", "ic-sm")} 子代理<span>${subs.length}</span></summary>
    <div class="subagent-list">
      ${subs.map((name) => `<div class="subagent-row">${icon("bot", "ic-sm")}<span title="${esc(name)}">${esc(name)}</span></div>`).join("")}
    </div>
  </details>`;
}

function isSubagentTool(name: string): boolean {
  return /^(Task|Agent|delegate)$/i.test(name) || /subagent|delegate/i.test(name);
}

function renderList() {
  const groups = groupSessions(sessions);
  if (!groups.length) {
    $("#list").innerHTML = '<div class="empty">暂无会话。</div>';
    return;
  }
  $("#list").innerHTML = groups.map((group) => {
    const expanded = expandedProjects.has(group.cwd);
    const sorted = sortSessions(group.sessions);
    const items = expanded ? sorted.map((s) => renderItem(s, group)).join("") : "";
    const groupAgents = new Set<Agent>();
    group.sessions.forEach((s) => {
      groupAgents.add(s.agent);
      if (s.mapping) {
        groupAgents.add(s.mapping.sourceAgent);
        groupAgents.add(s.mapping.targetAgent);
      }
    });
    const agents = [...groupAgents].map((agent) => `<span class="mini-agent ${agent}" title="${agentLabel(agent)}">${agentMark(agent, false)}</span>`).join("");
    return `<section class="project-card${expanded ? "" : " collapsed"}">
      <button class="project-head" data-project="${esc(group.cwd)}" title="${expanded ? "折叠项目" : "展开项目"}">
        <div class="project-main">
          <div class="project-title">${icon("folder", "ic-folder")}<span class="chev">${expanded ? "?" : "?"}</span><span title="${esc(group.label)}">${esc(group.label)}</span></div>
          <div class="project-path" title="${esc(group.cwd)}">${esc(group.cwd)}</div>
        </div>
        <div class="project-side"><div class="project-agents">${agents}</div><span class="project-count">${group.sessions.length} 会话</span></div>
      </button>
      <div class="project-items">${items}</div>
    </section>`;
  }).join("");
  document.querySelectorAll<HTMLButtonElement>(".project-head").forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      const key = el.dataset.project || "";
      if (expandedProjects.has(key)) expandedProjects.delete(key);
      else expandedProjects.add(key);
      saveSet(EXPANDED_KEY, expandedProjects);
      renderList();
    };
  });
  document.querySelectorAll<HTMLDetailsElement>(".subagent-tree").forEach((el) => {
    el.ontoggle = () => {
      const key = el.dataset.subagents || "";
      if (!key) return;
      if (el.open) expandedSubagents.add(key);
      else expandedSubagents.delete(key);
      saveSet(EXPANDED_SUBAGENT_KEY, expandedSubagents);
    };
  });
  document.querySelectorAll<HTMLButtonElement>(".item").forEach((el) => {
    el.onclick = () => openSession(el.dataset.id || "");
    el.oncontextmenu = (event) => {
      event.preventDefault();
      openContextMenu(el.dataset.id || "", event.clientX, event.clientY);
    };
  });
}

async function openSession(id: string) {
  if (!id) return;
  selectedId = id;
  renderList();
  $("#timeline").innerHTML = '<div class="spin">加载中...</div>';
  const cached = sessions.find((it) => it.sessionId === id);
  if (cached?.parseError) {
    current = null;
    $("#info").innerHTML = `<div class="title">${esc(cached.title || cached.sessionId)}</div>
      <div class="sub"><span class="badge ${cached.agent}">${agentMark(cached.agent)}</span> 损坏/无法读取 · ${esc(cached.filePath)}</div>`;
    ($("#migrateBtn") as HTMLButtonElement).disabled = true;
    $("#timeline").innerHTML = `<div class="empty error">
      <p>该会话文件当前无法解析。</p>
      <p>${esc(cached.parseError)}</p>
      <div class="row">
        <button class="btn-3d" id="repairBrokenSession">${icon("wrench")}<span>修复会话</span></button>
        <button class="btn-3d" id="archiveBrokenSession">${icon("folder")}<span>备份归档</span></button>
      </div>
    </div>`;
    document.querySelector<HTMLButtonElement>("#repairBrokenSession")?.addEventListener("click", () => void repairSessionById(id));
    document.querySelector<HTMLButtonElement>("#archiveBrokenSession")?.addEventListener("click", () => void archiveSessionById(id));
    return;
  }
  try {
    current = await api.getSession(id);
    const m = current.meta;
    $("#info").innerHTML = `<div class="title">${esc(m.title || m.sessionId)}</div>
      <div class="sub"><span class="badge ${m.agent}">${agentMark(m.agent)}</span> ${esc(m.model || "未知模型")} · ${m.turnCount || 0} 轮 · ${esc(m.cwd || "")}</div>`;
    ($("#migrateBtn") as HTMLButtonElement).disabled = false;
    renderTimeline(current);
  } catch (error) {
    $("#timeline").innerHTML = `<div class="empty error">${esc(error)}</div>`;
  }
}

function renderTimeline(data: UnifiedSession) {
  const html = data.turns.map((turn) => {
    const blocks = turn.blocks.map((b) => {
      if (b.kind === "text") return `<div class="block">${esc(b.text)}</div>`;
      if (b.kind === "thinking") return `<div class="block thinking">${esc(b.text)}</div>`;
      if (b.kind === "tool_call") {
        const isSub = isSubagentTool(b.name);
        const label = isSub ? `${icon("bot", "ic-sm")}子代理：${esc(b.name)}` : `${icon("wrench", "ic-sm")}${esc(b.name)}`;
        return `<details class="block tool_call${isSub ? " subagent" : ""}">
          <summary>${label}</summary>
          <pre>${esc(typeof b.input === "string" ? b.input : JSON.stringify(b.input, null, 2))}</pre>
        </details>`;
      }
      if (b.kind === "tool_result") return `<details class="block tool_result"><summary>工具结果</summary><pre>${esc(b.output)}</pre></details>`;
      return "";
    }).join("");
    if (!blocks) return "";
    return `<article class="turn ${turn.role}"><div class="role">${roleName(turn.role)}</div>${blocks}</article>`;
  }).join("");
  $("#timeline").innerHTML = html || '<div class="empty">没有可展示内容。</div>';
}
function roleName(role: string): string {
  return ({ user: "用户", assistant: "助手", system: "系统", tool: "工具" } as Record<string, string>)[role] || role;
}
function showDialog(html: string) {
  $("#dialogBody").innerHTML = html;
  const modal = dialog("#dialog");
  if (!modal.open) modal.showModal();
}

function selectedProjectCwd(): string | undefined {
  return input("#cwdFilter").value.trim() || current?.meta.cwd || undefined;
}

type OpStepState = "pending" | "active" | "done" | "warn" | "error";
type OpStep = { label: string; state: OpStepState; detail?: string };

function operationDialog(title: string, steps: OpStep[], body = ""): string {
  const items = steps.map((step) => `
    <div class="op-step ${step.state}">
      <span class="op-dot"></span>
      <div><strong>${esc(step.label)}</strong>${step.detail ? `<p>${esc(step.detail)}</p>` : ""}</div>
    </div>`).join("");
  return `<h2>${esc(title)}</h2><div class="op-steps">${items}</div>${body}`;
}

function setStep(steps: OpStep[], index: number, state: OpStepState, detail?: string) {
  steps[index] = { ...steps[index], state, detail };
}

async function verifyTargetSession(agent: Agent, sessionId: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const loaded = await api.getSession(sessionId);
    if (loaded.meta.agent !== agent) {
      return { ok: false, detail: `已写入，但索引到的客户端类型是 ${agentLabel(loaded.meta.agent)}` };
    }
    return { ok: true, detail: `xfer 本地索引已验证：目标会话文件可解析，${loaded.turns.length} 条记录可查看。目标客户端是否显示，还取决于它自己的会话索引与刷新机制。` };
  } catch (error) {
    return { ok: false, detail: `目标文件已写入，但当前索引尚未解析到该会话：${String(error)}` };
  }
}

function clientStatusHtml(status: ClientStatus, agent: Agent): string {
  if (!api.runtime || api.runtime !== "app") return "";
  const visibilityNote = agent === "codex"
    ? "xfer 会同时写入 Codex rollout 文件，并尝试注册 Codex Desktop 的本地 threads/session_index 索引；如果 Codex 正在运行，仍可能需要重启后刷新。"
    : "Claude Desktop 与 Claude Code 的历史库不是同一个列表。xfer 写入的是 Claude Code 会话，不会直接出现在 Claude Desktop 历史；要进入 Claude Desktop，需要先用 Claude Code 恢复该会话，再使用 Claude 官方的 /desktop 导入流程。";
  if (!status.running) {
    const action = status.launchable
      ? `<button class="btn-3d open-desktop-client" data-agent="${agent}">${icon("bot")}<span>打开 ${agentLabel(agent)} Desktop</span></button>`
      : `<span class="hint">未定位到 ${agentLabel(agent)} Desktop 可执行文件，请先手动启动客户端。</span>`;
    return `<div class="client-note">
      <strong>目标客户端：</strong>未检测到正在运行的 ${agentLabel(agent)} 桌面客户端。
      <p>xfer 已写入本地会话文件；目标客户端是否显示，需要它启动后重新索引会话库。</p>
      <p>${esc(visibilityNote)}</p>
      ${status.launchPath ? `<p>启动路径：</p><code>${esc(status.launchPath)}</code>` : ""}
      <div class="row">${action}</div>
    </div>`;
  }
  const processes = status.processes.map((p) => `<li>${esc(p.name)} #${p.pid}${p.path ? `<br><span>${esc(p.path)}</span>` : ""}</li>`).join("");
  const action = status.canRestart
    ? `<button class="btn-3d restart-client" data-agent="${agent}">${icon("refresh")}<span>重启 ${agentLabel(agent)} 桌面客户端</span></button>`
    : `<span class="hint">检测到客户端正在运行，但无法取得可重启路径。</span>`;
  return `<div class="client-note warn">
    <strong>目标桌面客户端正在运行。</strong>
    <p>客户端可能缓存会话列表；如果目标端没有立即显示新的会话状态，可以确认后重启客户端刷新索引。</p>
    <p>${esc(visibilityNote)}</p>
    <ul>${processes}</ul>
    ${status.launchPath ? `<p>启动路径：</p><code>${esc(status.launchPath)}</code>` : ""}
    <div class="row">${action}</div>
  </div>`;
}

function switchResultBody(result: SwitchResult, verification: { ok: boolean; detail: string }, status?: ClientStatus): string {
  const target = result.targetAgent;
  const file = result.targetFilePath ? `<p>目标文件：</p><code>${esc(result.targetFilePath)}</code>` : "";
  const mapText = result.reused ? "复用已迁移的目标会话" : "已写入目标会话并记录项目映射";
  return `<div class="result-box">
    <p><strong>${esc(mapText)}</strong></p>
    <p>${agentLabel(result.sourceAgent)} → ${agentLabel(target)}：<code>${esc(result.targetSessionId)}</code></p>
    ${modelMappingHtml(result.modelMapping)}
    ${file}
    <p>恢复命令：</p><code>${esc(result.resumeCommand)}</code>
    <p class="${verification.ok ? "ok-text" : "warn-text"}">${esc(verification.detail)}</p>
    <p class="hint">注意：这里验证的是 xfer 本地索引，不等于目标 Claude/Codex Desktop 已热更新显示。</p>
  </div>
  ${status ? clientStatusHtml(status, target) : ""}
  ${openButtons(target, result.targetSessionId, sessionCwd(result.sourceSessionId))}`;
}

function migrateResultBody(result: MigrateResult, verification: { ok: boolean; detail: string }, status?: ClientStatus): string {
  return `<div class="result-box">
    <p><strong>已写入目标会话库</strong></p>
    <p>${agentLabel(result.from)} → ${agentLabel(result.to)}：<code>${esc(result.sessionId)}</code></p>
    ${modelMappingHtml(result.modelMapping)}
    <p>目标文件：</p><code>${esc(result.filePath)}</code>
    <p>恢复命令：</p><code>${esc(result.resumeCommand)}</code>
    <p class="${verification.ok ? "ok-text" : "warn-text"}">${esc(verification.detail)}</p>
    <p class="hint">注意：这里验证的是 xfer 本地索引，不等于目标 Claude/Codex Desktop 已热更新显示。</p>
  </div>
  ${status ? clientStatusHtml(status, result.to) : ""}
  ${openButtons(result.to, result.sessionId, selectedProjectCwd())}`;
}

async function codexDesktopIndexNote(agent: Agent, sessionId: string): Promise<string> {
  if (agent !== "codex" || api.runtime !== "app") return "";
  try {
    const index = await api.verifyCodexDesktopIndex({ sessionId });
    return `<div class="client-note ${index.ok ? "" : "warn"}">
      <strong>Codex Desktop 索引验证：${index.ok ? "通过" : "未通过"}</strong>
      <p>SQLite threads：${index.sqliteOk ? "OK" : "缺失/路径无效"}；session_index：${index.sessionIndexOk ? "OK" : "缺失"}；archived：${esc(String(index.archived ?? "?"))}</p>
      ${index.rolloutPath ? `<p>rollout：</p><code>${esc(index.rolloutPath)}</code>` : ""}
    </div>`;
  } catch (error) {
    return `<div class="client-note warn"><strong>Codex Desktop 索引验证失败</strong><p class="error">${esc(error)}</p></div>`;
  }
}

async function desktopIndexNote(agent: Agent, sessionId: string): Promise<string> {
  if (agent === "codex") return codexDesktopIndexNote(agent, sessionId);
  if (agent !== "claude" || api.runtime !== "app") return "";
  try {
    const index = await api.verifyClaudeDesktopIndex({ sessionId });
    return `<div class="client-note ${index.ok ? "" : "warn"}">
      <strong>Claude Desktop 索引验证：${index.ok ? "通过" : "未通过"}</strong>
      <p>匹配索引文件：${index.count}</p>
      ${index.files.slice(0, 2).map((file) => `<code>${esc(file)}</code>`).join("")}
      <p class="hint">如果 Claude Desktop 已运行但 Code tab 未刷新，请重启 Claude Desktop。</p>
    </div>`;
  } catch (error) {
    return `<div class="client-note warn"><strong>Claude Desktop 索引验证失败</strong><p class="error">${esc(error)}</p></div>`;
  }
}

function closeContextMenu() {
  const menu = document.querySelector<HTMLDivElement>("#ctxMenu")!;
  menu.hidden = true;
  menu.innerHTML = "";
  menu.removeAttribute("style");
}

function openContextMenu(sessionId: string, x: number, y: number) {
  const s = sessions.find((it) => it.sessionId === sessionId);
  if (!s) return;
  const to: Agent = s.agent === "claude" ? "codex" : "claude";
  const on = isAutoSync(sessionId);
  const menu = document.querySelector<HTMLDivElement>("#ctxMenu")!;
  const undoButton = s.mapping
    ? `<button data-act="undo" data-id="${esc(sessionId)}">${icon("refresh", "ic-sm")}撤回迁移</button>`
    : "";
  menu.innerHTML = `
    <button data-act="migrate" data-id="${esc(sessionId)}" data-to="${to}">${icon("external", "ic-sm")}迁移到 ${agentLabel(to)}</button>
    <button data-act="switch" data-id="${esc(sessionId)}" data-to="${to}">${icon("sync", "ic-sm")}切换到 ${agentLabel(to)}</button>
    <button data-act="repair" data-id="${esc(sessionId)}">${icon("wrench", "ic-sm")}修复/重建会话</button>
    <button data-act="autosync" data-id="${esc(sessionId)}">${icon("sync", "ic-sm")}${on ? "关闭自动同步" : "开启自动同步"}</button>
    <button data-act="archive" data-id="${esc(sessionId)}">${icon("folder", "ic-sm")}备份归档</button>
    <button data-act="delete" data-id="${esc(sessionId)}" class="danger-menu">${icon("trash", "ic-sm")}删除会话</button>
    ${undoButton}`;
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
  menu.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
    btn.onclick = async () => {
      const act = btn.dataset.act || "";
      const id = btn.dataset.id || "";
      const target = (btn.dataset.to || "") as Agent;
      closeContextMenu();
      if (act === "migrate") await migrateSessionById(id, target);
      else if (act === "switch") await switchProjectTo(target, sessionCwd(id), id);
      else if (act === "repair") await repairSessionById(id);
      else if (act === "autosync") toggleAutoSync(id);
      else if (act === "archive") await archiveSessionById(id);
      else if (act === "delete") await deleteSessionById(id);
      else if (act === "undo") await undoMigrationById(id);
    };
  });
}
function agentLabel(agent: Agent): string {
  return agent === "claude" ? "Claude" : "Codex";
}

function modelMappingHtml(mapping?: ModelMapping): string {
  if (!mapping) return "";
  const source = mapping.sourceModel || "(未记录)";
  const cls = mapping.changed ? "warn-text" : "ok-text";
  const label = mapping.changed ? "已替换目标模型" : "模型兼容";
  return `<div class="model-map">
    <p><strong>${label}</strong></p>
    <p>源模型：<code>${esc(source)}</code></p>
    <p>目标模型：<code>${esc(mapping.targetModel)}</code></p>
    <p class="${cls}">${esc(mapping.reason)}</p>
  </div>`;
}

function sessionCwd(sessionId: string): string | undefined {
  return sessions.find((it) => it.sessionId === sessionId)?.cwd || selectedProjectCwd();
}

async function repairSessionById(sessionId: string) {
  showDialog(operationDialog("修复会话", [
    { label: "定位原始会话文件", state: "active" },
    { label: "解析或抽取 transcript", state: "pending" },
    { label: "写回原客户端新会话", state: "pending" },
  ]));
  try {
    const result = await api.repairSession({ sessionId, cwd: sessionCwd(sessionId) });
    scheduleBackgroundListRefresh();
    showDialog(`<h2>修复完成</h2>
      <div class="result-box">
        <p>方法：<strong>${esc(result.method)}</strong></p>
        <p>${agentLabel(result.agent)}：<code>${esc(result.sourceSessionId)}</code> → <code>${esc(result.repairedSessionId)}</code></p>
        <p>写入记录：${result.turnsWritten}</p>
        <p>原文件：</p><code>${esc(result.sourceFilePath)}</code>
        <p>新文件：</p><code>${esc(result.repairedFilePath)}</code>
      </div>
      <p class="hint">修复不会覆盖损坏原文件；它会在同一客户端会话库里创建一个可继续恢复的新会话。</p>`);
  } catch (error) {
    showDialog(`<h2>修复失败</h2><p class="error">${esc(error)}</p>`);
  }
}

async function archiveSessionById(sessionId: string) {
  try {
    const preview = await api.archivePreview({ sessionId });
    showDialog(`<h2>确认备份归档？</h2>
      <p>归档会把会话从正常客户端会话目录移到备份归档目录。正常列表不会索引归档内容，减少用户目录负担。</p>
      <div class="result-box">
        <p>${agentLabel(preview.archive.agent)}：<code>${esc(preview.archive.sessionId)}</code></p>
        <p>原位置：</p><code>${esc(preview.archive.originalPath)}</code>
        <p>移动到：</p><code>${esc(preview.archive.archivePath)}</code>
        <p>元数据：</p><code>${esc(preview.metadataPath)}</code>
      </div>
      <div class="row"><button id="confirmArchiveSession" class="btn-3d danger">${icon("folder")}<span>确认移动到归档</span></button></div>`);
    document.querySelector<HTMLButtonElement>("#confirmArchiveSession")?.addEventListener("click", async () => {
      try {
        const result = await api.archiveSession({ sessionId });
        rawSessions = rawSessions.filter((s) => s.sessionId !== result.archive.sessionId);
        if (selectedId === result.archive.sessionId) {
          selectedId = "";
          current = null;
          $("#timeline").innerHTML = '<div class="empty">会话已归档。</div>';
        }
        applyCachedSessions({ silent: true, keepScroll: true });
        showDialog(`<h2>已备份归档</h2>
          <div class="result-box">
            <p>已移动到：</p><code>${esc(result.archive.archivePath)}</code>
            <p>元数据：</p><code>${esc(result.metadataPath)}</code>
            <p>客户端索引清理：</p><pre class="status">${esc(JSON.stringify(result.desktopIndexRemoval || {}, null, 2))}</pre>
          </div>`);
      } catch (error) {
        showDialog(`<h2>归档失败</h2><p class="error">${esc(error)}</p>`);
      }
    });
  } catch (error) {
    showDialog(`<h2>归档预览失败</h2><p class="error">${esc(error)}</p>`);
  }
}

async function deleteSessionById(sessionId: string) {
  try {
    const info = await api.findSessionInfo({ sessionId });
    if (!info.found || !info.agent || !info.filePath) {
      showDialog(`<h2>未找到会话</h2><p class="error">无法定位会话 ID：${esc(sessionId)}</p>`);
      return;
    }
    showDialog(`<h2>确认永久删除？</h2>
      <p class="error">删除不会进入归档，无法通过 xfer 恢复。建议需要保留时使用“备份归档”。</p>
      <div class="result-box">
        <p>${agentLabel(info.agent)}：<code>${esc(info.entry?.sessionId || sessionId)}</code></p>
        <p>将删除文件：</p><code>${esc(info.filePath)}</code>
      </div>
      <div class="row"><button id="confirmDeleteSession" class="btn-3d danger">${icon("trash")}<span>确认永久删除</span></button></div>`);
    document.querySelector<HTMLButtonElement>("#confirmDeleteSession")?.addEventListener("click", async () => {
      try {
        const result = await api.deleteSession({ sessionId });
        rawSessions = rawSessions.filter((s) => s.sessionId !== result.sessionId && s.filePath !== result.filePath);
        if (selectedId === result.sessionId) {
          selectedId = "";
          current = null;
          $("#timeline").innerHTML = '<div class="empty">会话已删除。</div>';
        }
        applyCachedSessions({ silent: true, keepScroll: true });
        showDialog(`<h2>已删除会话</h2>
          <div class="result-box">
            <p>文件：${result.removedFile ? "已删除" : "未找到"}</p>
            <code>${esc(result.filePath)}</code>
            <p>客户端索引清理：</p><pre class="status">${esc(JSON.stringify(result.desktopIndexRemoval || {}, null, 2))}</pre>
          </div>`);
      } catch (error) {
        showDialog(`<h2>删除失败</h2><p class="error">${esc(error)}</p>`);
      }
    });
  } catch (error) {
    showDialog(`<h2>删除预览失败</h2><p class="error">${esc(error)}</p>`);
  }
}

async function undoMigrationById(sessionId: string) {
  const s = sessions.find((it) => it.sessionId === sessionId);
  const mapping = s?.mapping;
  if (!mapping) return;
  const source = `${agentLabel(mapping.sourceAgent)}:${mapping.sourceSessionId.slice(0, 8)}`;
  const target = `${agentLabel(mapping.targetAgent)}:${mapping.targetSessionId.slice(0, 8)}`;
  showDialog(`<h2>撤回迁移</h2>
    <p>将删除此项目映射，并删除迁移生成的目标会话文件；源会话不会被修改。</p>
    <div class="result-box">
      <p>${esc(source)} → ${esc(target)}</p>
      <p>目标文件：</p><code>${esc(mapping.targetFilePath)}</code>
    </div>
    <div class="row"><button id="confirmUndoMigration" class="btn-3d danger">${icon("refresh")}<span>确认撤回</span></button></div>`);
  document.querySelector<HTMLButtonElement>("#confirmUndoMigration")?.addEventListener("click", async () => {
    const steps: OpStep[] = [
      { label: "删除迁移映射", state: "active" },
      { label: "删除生成的目标会话文件", state: "pending" },
      { label: "刷新项目索引", state: "pending" },
      { label: "检查目标客户端", state: "pending" },
    ];
    showDialog(operationDialog("撤回迁移", steps));
    try {
      const result = await api.undoMigration({
        cwd: mapping.cwd || sessionCwd(sessionId),
        sourceSessionId: mapping.sourceSessionId,
        targetSessionId: mapping.targetSessionId,
        removeTargetFile: true,
      });
      setStep(steps, 0, result.removedMapping ? "done" : "warn", result.removedMapping ? "映射已删除。" : "未删除映射，请检查状态文件。")
      setStep(steps, 1, result.removedTargetFile ? "done" : "warn", result.removedTargetFile ? "目标会话文件已删除。" : "未找到目标文件或无需删除。")
      setStep(steps, 2, "active");
      showDialog(operationDialog("撤回迁移", steps));
      applyUndoResultLocally(result);
      scheduleBackgroundListRefresh();
      setStep(steps, 2, "done", "列表已更新，完整索引在后台刷新。")
      setStep(steps, 3, "active");
      showDialog(operationDialog("撤回迁移", steps));
      const status = await api.agentClientStatus({ agent: result.targetAgent });
      setStep(steps, 3, status.running ? "warn" : "done", status.running ? "目标客户端正在运行，可能需要重启后刷新会话列表。" : "未检测到正在运行的目标桌面客户端。")
      showDialog(operationDialog("已撤回迁移", steps, `<div class="result-box">
        <p>映射：${result.removedMapping ? "已删除" : "未删除"}</p>
        <p>目标会话文件：${result.removedTargetFile ? "已删除" : "未找到或无需删除"}</p>
        <p>客户端索引撤回：</p><pre class="status">${esc(JSON.stringify(result.desktopIndexRemoval || {}, null, 2))}</pre>
        <p>状态文件：</p><code>${esc(result.statePath)}</code>
      </div>${clientStatusHtml(status, result.targetAgent)}`));
    } catch (error) {
      const active = steps.findIndex((step) => step.state === "active");
      if (active >= 0) setStep(steps, active, "error", String(error));
      showDialog(operationDialog("撤回失败", steps, `<p class="error">${esc(error)}</p>`));
    }
  });
}
function openButtons(agent: Agent, sessionId: string, cwd?: string): string {
  if (api.runtime !== "app") return "";
  const claudeDesktopImport = agent === "claude"
    ? `<button class="quick-btn claude-desktop-import" data-id="${esc(sessionId)}" data-cwd="${esc(cwd || "")}">${icon("bot")}<span>导入 Claude Desktop</span></button>`
    : "";
  return `<div class="row client-actions">
    <button class="quick-btn open-agent" data-agent="${agent}" data-id="${esc(sessionId)}" data-cwd="${esc(cwd || "")}">${icon("terminal")}<span>CLI 恢复</span></button>
    ${claudeDesktopImport}
    <button class="quick-btn desktop-target" data-agent="${agent}">${icon("bot")}<span>Desktop 客户端</span></button>
  </div>`;
}
async function openInAgent(agent: Agent, sessionId: string, cwd?: string) {
  try {
    await api.openInAgent({ agent, sessionId, cwd: cwd || undefined });
    showDialog(`<h2>已打开 CLI</h2><p>已在新的 ${agentLabel(agent)} CLI 终端中恢复 <code>${esc(sessionId.slice(0, 8))}</code>。</p><p>Desktop App 按钮表示目标桌面端状态；如果桌面端没有自动刷新，请使用重启提示。</p>`);
  } catch (error) {
    showDialog(`<h2>CLI 打开失败</h2><p class="error">${esc(error)}</p>`);
  }
}
async function restartClient(agent: Agent) {
  showDialog(`<h2>确认重启 ${agentLabel(agent)} 桌面客户端？</h2>
    <p>这会关闭当前检测到的 ${agentLabel(agent)} 桌面客户端进程并重新打开。未保存的客户端侧输入可能丢失。</p>
    <div class="row"><button class="btn-3d danger" id="confirmRestartClient" data-agent="${agent}">${icon("refresh")}<span>确认重启</span></button></div>`);
  document.querySelector<HTMLButtonElement>("#confirmRestartClient")?.addEventListener("click", async () => {
    showDialog(operationDialog(`重启 ${agentLabel(agent)} 桌面客户端`, [
      { label: "关闭目标客户端进程", state: "active" },
      { label: "重新启动客户端", state: "pending" },
    ]));
    try {
      const status = await api.restartAgentClient({ agent });
      const processes = status.processes.map((p) => `<li>${esc(p.name)} #${p.pid}${p.path ? `<br><span>${esc(p.path)}</span>` : ""}</li>`).join("");
      showDialog(`<h2>已发送重启请求</h2><p>${agentLabel(agent)} 桌面客户端已重新启动或正在启动中。</p>${processes ? `<ul class="process-list">${processes}</ul>` : ""}`);
      void refreshClientStatus();
    } catch (error) {
      showDialog(`<h2>重启失败</h2><p class="error">${esc(error)}</p><p>可以手动关闭并重新打开目标客户端；迁移/撤回写入的本地状态已经保留。</p>`);
    }
  });
}

async function openDesktopClient(agent: Agent) {
  try {
    const status = await api.openAgentClient({ agent });
    const processes = status.processes.map((p) => `<li>${esc(p.name)} #${p.pid}${p.path ? `<br><span>${esc(p.path)}</span>` : ""}</li>`).join("");
    showDialog(`<h2>已请求打开 ${agentLabel(agent)} Desktop</h2>
      <p>如果目标客户端仍然没有显示迁移会话，说明它没有热更新当前会话索引；请在客户端内刷新，或关闭后重新打开。</p>
      ${status.launchPath ? `<p>启动路径：</p><code>${esc(status.launchPath)}</code>` : ""}
      ${processes ? `<ul class="process-list">${processes}</ul>` : ""}`);
    void refreshClientStatus();
  } catch (error) {
    showDialog(`<h2>Desktop 打开失败</h2>
      <p class="error">${esc(error)}</p>
      <p>迁移文件仍已写入本地。当前只能手动启动 ${agentLabel(agent)} Desktop，或使用 CLI 恢复按钮验证会话。</p>`);
  }
}
async function migrateSessionById(sessionId: string, to: Agent) {
  const steps: OpStep[] = [
    { label: "解析源会话", state: "active" },
    { label: "写入目标会话库", state: "pending" },
    { label: "校验 Desktop 解析", state: "pending" },
    { label: "检查目标客户端", state: "pending" },
  ];
  showDialog(operationDialog(`迁移到 ${agentLabel(to)}`, steps));
  try {
    setStep(steps, 0, "done", `源会话 ${sessionId.slice(0, 8)} 已选定。`);
    setStep(steps, 1, "active");
    showDialog(operationDialog(`迁移到 ${agentLabel(to)}`, steps));
    const result = await api.switchSession({ to, cwd: sessionCwd(sessionId), sourceSessionId: sessionId, mode: "faithful", force: true });
    scheduleBackgroundListRefresh();
    setStep(steps, 1, "done", result.targetFilePath || "目标会话文件已写入。");
    setStep(steps, 2, "active");
    showDialog(operationDialog(`迁移到 ${agentLabel(result.targetAgent)}`, steps));
    const verification = await verifyTargetSession(result.targetAgent, result.targetSessionId);
    setStep(steps, 2, verification.ok ? "done" : "warn", verification.detail);
    setStep(steps, 3, "active");
    showDialog(operationDialog(`迁移到 ${agentLabel(result.targetAgent)}`, steps));
    const status = await api.agentClientStatus({ agent: result.targetAgent });
    setStep(steps, 3, status.running ? "warn" : "done", status.running ? "目标客户端正在运行，可能需要重启后刷新会话列表。" : "未检测到正在运行的目标桌面客户端。");
    void refreshClientStatus();
    const indexNote = await desktopIndexNote(result.targetAgent, result.targetSessionId);
    showDialog(operationDialog(`已迁移到 ${agentLabel(result.targetAgent)}`, steps, switchResultBody(result, verification, status) + indexNote));
  } catch (error) {
    const active = steps.findIndex((step) => step.state === "active");
    if (active >= 0) setStep(steps, active, "error", String(error));
    showDialog(operationDialog("迁移失败", steps, `<p class="error">${esc(error)}</p>`));
  }
}

async function switchProjectTo(to: Agent, cwd?: string, sourceSessionId?: string) {
  const steps: OpStep[] = [
    { label: "定位项目会话", state: "active" },
    { label: "写入或复用目标会话", state: "pending" },
    { label: "校验 Desktop 解析", state: "pending" },
    { label: "检查目标客户端", state: "pending" },
  ];
  showDialog(operationDialog(`切换到 ${agentLabel(to)}`, steps));
  try {
    setStep(steps, 0, "done", cwd || sourceSessionId ? "已按项目/会话定位源会话。" : "已按当前项目定位最新源会话。");
    setStep(steps, 1, "active");
    showDialog(operationDialog(`切换到 ${agentLabel(to)}`, steps));
    const result = await api.switchSession({ to, cwd, sourceSessionId });
    scheduleBackgroundListRefresh();
    setStep(steps, 1, "done", result.reused ? "已复用此前写入的目标会话。" : (result.targetFilePath || "目标会话文件已写入，并记录项目映射。"));
    setStep(steps, 2, "active");
    showDialog(operationDialog(`切换到 ${agentLabel(result.targetAgent)}`, steps));
    const verification = await verifyTargetSession(result.targetAgent, result.targetSessionId);
    setStep(steps, 2, verification.ok ? "done" : "warn", verification.detail);
    setStep(steps, 3, "active");
    showDialog(operationDialog(`切换到 ${agentLabel(result.targetAgent)}`, steps));
    const status = await api.agentClientStatus({ agent: result.targetAgent });
    setStep(steps, 3, status.running ? "warn" : "done", status.running ? "目标客户端正在运行，可能需要重启后刷新会话列表。" : "未检测到正在运行的目标桌面客户端。");
    void refreshClientStatus();
    const indexNote = await desktopIndexNote(result.targetAgent, result.targetSessionId);
    showDialog(operationDialog(`${result.reused ? "已复用迁移结果" : "已完成切换"}`, steps, switchResultBody(result, verification, status) + indexNote));
  } catch (error) {
    const active = steps.findIndex((step) => step.state === "active");
    if (active >= 0) setStep(steps, active, "error", String(error));
    showDialog(operationDialog("切换失败", steps, `<p class="error">${esc(error)}</p>`));
  }
}

async function migrateCurrent() {
  if (!current) return;
  const to: Agent = current.meta.agent === "claude" ? "codex" : "claude";
  await migrateSessionById(current.meta.sessionId, to);
}
async function switchTo(to: Agent) {
  await switchProjectTo(to, selectedProjectCwd());
}

async function showSyncStatus() {
  try {
    const status = await api.syncStatus({ cwd: selectedProjectCwd() });
    showDialog(`<h2>同步状态</h2><pre class="status">${esc(status.text)}</pre>`);
  } catch (error) {
    showDialog(`<h2>错误</h2><p class="error">${esc(error)}</p>`);
  }
}

async function openClaudeDesktopImport(sessionId: string, cwd?: string) {
  showDialog(`<h2>确认导入到 Claude Desktop？</h2>
    <p>xfer 会检查生成的 Claude Code 会话文件，并尝试注册到 Claude Desktop 的本地 Code sessions 索引。</p>
    <p>整个过程在后台完成，不会弹出 cmd；如果 Claude Desktop 已运行但没有刷新，完成后可重启 Desktop。</p>
    <div class="row"><button class="btn-3d" id="confirmClaudeDesktopImport" data-id="${esc(sessionId)}" data-cwd="${esc(cwd || "")}">${icon("bot")}<span>开始导入</span></button></div>`);
  document.querySelector<HTMLButtonElement>("#confirmClaudeDesktopImport")?.addEventListener("click", async () => {
    showDialog(operationDialog("导入 Claude Desktop", [
      { label: "检查 Claude Code 会话文件", state: "active" },
      { label: "注册 Claude Desktop Code sessions 索引", state: "pending" },
      { label: "提示刷新/重启 Desktop", state: "pending" },
    ]));
    try {
      const result = await api.openClaudeDesktopImport({ sessionId, cwd: cwd || undefined });
      showDialog(`<h2>${result.ok ? "Claude Desktop 索引已注册" : "Claude Desktop 导入未完成"}</h2>
        <p>${result.ok ? "xfer 已尝试把该 Claude Code 会话写入 Claude Desktop 本地 Code sessions 索引。" : "xfer 未能确认 Claude Desktop 本地索引。"}</p>
        <p>如果 Claude Desktop Code tab 没有立即显示，请重启 Claude Desktop 后再检查。</p>
        ${result.reason ? `<p class="hint">${esc(result.reason)}</p>` : ""}
        <p>命令：</p><code>${esc(result.command)}</code>
        ${result.filePath ? `<p>会话文件：</p><code>${esc(result.filePath)}</code>` : ""}`);
      void refreshClientStatus();
    } catch (error) {
      showDialog(`<h2>Claude Desktop 导入失败</h2><p class="error">${esc(error)}</p><p>可以先用 CLI 恢复会话，然后在 Claude Code 中手动输入 <code>/desktop</code>。</p>`);
    }
  });
}

function formatModelAliases(aliases?: Record<string, string>): string {
  return Object.entries(aliases || {})
    .map(([source, target]) => `${source}=${target}`)
    .join("\n");
}

function parseModelAliases(raw: string): Record<string, string> | undefined {
  const aliases: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const splitAt = trimmed.indexOf("=");
    if (splitAt <= 0) continue;
    const source = trimmed.slice(0, splitAt).trim();
    const target = trimmed.slice(splitAt + 1).trim();
    if (source && target) aliases[source] = target;
  }
  return Object.keys(aliases).length ? aliases : undefined;
}

async function showSettings() {
  try {
    const settings = await api.getSettings();
    showDialog(`<h2>设置</h2>
      <section class="set-section">
        <h3>外观</h3>
        <div class="set-field"><label for="setTheme">主题</label>
          <select id="setTheme">
            <option value="system" ${currentTheme === "system" ? "selected" : ""}>跟随系统</option>
            <option value="light" ${currentTheme === "light" ? "selected" : ""}>日间</option>
            <option value="dark" ${currentTheme === "dark" ? "selected" : ""}>夜间</option>
          </select>
        </div>
        <div class="set-field"><label for="setBg">背景</label>
          <div class="bg-row">
            <input id="setBg" value="${esc(currentBg.startsWith("data:") ? "(已选择本地图片)" : currentBg)}" placeholder="颜色、图片 URL 或本地路径" />
            <label class="btn-3d browse" for="bgFile" title="选择本地图片">选择图片</label>
            <input id="bgFile" type="file" accept="image/*" hidden />
          </div>
        </div>
      </section>
      <section class="set-section">
        <h3>运行存储 <span class="hint">可选，留空则使用默认位置</span></h3>
        <div class="set-field"><label>存储根目录</label><div class="path-row"><input id="setStorage" value="${esc(settings.storageRoot || "")}" placeholder="可选基础目录" /><button class="btn-3d pick-dir" data-target="setStorage">选择目录</button></div></div>
        <div class="set-field"><label>状态目录</label><div class="path-row"><input id="setState" value="${esc(settings.stateRoot || "")}" placeholder="同步状态目录" /><button class="btn-3d pick-dir" data-target="setState">选择目录</button></div></div>
        <div class="set-field"><label>日志目录</label><div class="path-row"><input id="setLog" value="${esc(settings.logRoot || "")}" placeholder="日志目录" /><button class="btn-3d pick-dir" data-target="setLog">选择目录</button></div></div>
        <div class="set-field"><label>临时目录</label><div class="path-row"><input id="setTemp" value="${esc(settings.tempRoot || "")}" placeholder="临时/中间文件目录" /><button class="btn-3d pick-dir" data-target="setTemp">选择目录</button></div></div>
        <div class="set-field"><label>备份归档目录</label><div class="path-row"><input id="setArchive" value="${esc(settings.archiveRoot || "")}" placeholder="备份归档目录" /><button class="btn-3d pick-dir" data-target="setArchive">选择目录</button></div></div>
        <div class="set-field"><label>当前数据库</label><code class="path-code">${esc(settings.databasePath || "尚未初始化")}</code></div>
        <div class="row"><button id="showArchives" class="btn-3d">${icon("folder")}<span>查看备份归档</span></button></div>
      </section>
      <section class="set-section">
        <h3>客户端路径 <span class="hint">默认自动检测；找不到时可手动指定</span></h3>
        <div class="set-field"><label>Claude Desktop</label><input id="setClientClaude" value="${esc(settings.clientPaths?.claude || "")}" placeholder="Claude.exe 路径，可留空自动检测" /></div>
        <div class="set-field"><label>Codex Desktop</label><input id="setClientCodex" value="${esc(settings.clientPaths?.codex || "")}" placeholder="Codex.exe 路径，可留空自动检测" /></div>
        <div class="set-field"><label>Zcode</label><input id="setClientZcode" value="${esc(settings.clientPaths?.zcode || "")}" placeholder="可选，本地客户端 exe 路径" /></div>
        <div class="set-field"><label>OpenCode</label><input id="setClientOpencode" value="${esc(settings.clientPaths?.opencode || "")}" placeholder="可选，本地客户端 exe 路径" /></div>
      </section>
      <section class="set-section">
        <h3>模型兼容 <span class="hint">用于不同中转站/API 配置名不一致时的迁移兜底</span></h3>
        <div class="set-field"><label>Claude 默认模型</label><input id="setDefaultClaudeModel" value="${esc(settings.defaultModels?.claude || "")}" placeholder="默认 claude-sonnet-4-5" /></div>
        <div class="set-field"><label>Codex 默认模型</label><input id="setDefaultCodexModel" value="${esc(settings.defaultModels?.codex || "")}" placeholder="默认 gpt-5.1-codex" /></div>
        <div class="set-field"><label>模型别名</label><textarea id="setModelAliases" rows="5" placeholder="每行一个：源模型=目标模型">${esc(formatModelAliases(settings.modelAliases))}</textarea></div>
        <p class="hint">例：openrouter/claude-sonnet-4.5=claude-sonnet-4-5。未匹配且不兼容的源模型会自动替换为目标客户端默认模型。</p>
      </section>
      <section class="set-section">
        <h3>远程服务器客户端 <span class="hint">预留连接配置；真实同步需接入远程协议</span></h3>
        <div class="set-field"><label>启用远程</label><select id="setRemoteEnabled"><option value="no" ${settings.remoteClients?.length ? "" : "selected"}>否</option><option value="yes" ${settings.remoteClients?.length ? "selected" : ""}>是</option></select></div>
        <div class="set-field"><label>Agent</label><select id="setRemoteAgent"><option value="claude">Claude</option><option value="codex">Codex</option><option value="zcode">Zcode</option><option value="opencode">OpenCode</option></select></div>
        <div class="set-field"><label>服务器地址</label><input id="setRemoteHost" value="${esc(settings.remoteClients?.[0]?.host || "")}" placeholder="host 或 IP" /></div>
        <div class="set-field"><label>端口</label><input id="setRemotePort" value="${esc(String(settings.remoteClients?.[0]?.port || ""))}" placeholder="默认 22" /></div>
        <div class="set-field"><label>用户名</label><input id="setRemoteUser" value="${esc(settings.remoteClients?.[0]?.username || "")}" placeholder="远程用户名" /></div>
        <div class="set-field"><label>密码</label><input id="setRemotePassword" type="password" value="${esc(settings.remoteClients?.[0]?.password || "")}" placeholder="当前版本存入设置文件，后续应接系统凭据库" /></div>
        <div class="row"><button id="testRemoteConnection" class="btn-3d">测试远程连接</button></div>
      </section>
      <div class="row"><button id="resetSettings">重置</button><button id="saveSettings" class="btn-3d">保存</button></div>`);
    $("#saveSettings").addEventListener("click", saveSettings);
    $("#resetSettings").addEventListener("click", resetSettings);
    $("#testRemoteConnection").addEventListener("click", testRemoteConnection);
    $("#showArchives").addEventListener("click", showArchives);
    document.querySelectorAll<HTMLButtonElement>(".pick-dir").forEach((btn) => {
      btn.addEventListener("click", () => void chooseDirectoryFor(btn.dataset.target || ""));
    });
    const bgFile = document.querySelector<HTMLInputElement>("#bgFile");
    if (bgFile) {
      bgFile.addEventListener("change", () => {
        const file = bgFile.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          currentBg = String(reader.result || "");
          localStorage.setItem(BG_KEY, currentBg);
          applyTheme(currentTheme, currentBg);
          const setBg = document.querySelector<HTMLInputElement>("#setBg");
          if (setBg) setBg.value = `(已选择本地图片：${file.name})`;
        };
        reader.readAsDataURL(file);
      });
    }
  } catch (error) {
    showDialog(`<h2>错误</h2><p class="error">${esc(error)}</p>`);
  }
}

async function testRemoteConnection() {
  showDialog(operationDialog("测试远程连接", [
    { label: "读取远程配置", state: "done" },
    { label: "执行 SSH 连接测试", state: "active" },
  ]));
  try {
    const result = await api.testRemoteConnection({
      host: input("#setRemoteHost").value.trim(),
      port: Number(input("#setRemotePort").value.trim()) || undefined,
      username: input("#setRemoteUser").value.trim(),
      password: input("#setRemotePassword").value,
    });
    showDialog(`<h2>${result.ok ? "远程连接成功" : "远程连接失败"}</h2>
      <p>目标：<code>${esc(result.target)}:${esc(result.port)}</code></p>
      <p>退出码：<code>${esc(String(result.exitCode ?? "unknown"))}</code></p>
      ${result.stdout ? `<p>stdout：</p><pre class="status">${esc(result.stdout)}</pre>` : ""}
      ${result.stderr ? `<p>stderr：</p><pre class="status">${esc(result.stderr)}</pre>` : ""}
      <p class="hint">${esc(result.note)}</p>`);
  } catch (error) {
    showDialog(`<h2>远程连接测试失败</h2><p class="error">${esc(error)}</p>`);
  }
}

async function chooseDirectoryFor(targetId: string) {
  if (!targetId) return;
  try {
    const result = await api.chooseDirectory({ title: "选择 xfer 目录" });
    if (result.path) input(`#${targetId}`).value = result.path;
  } catch (error) {
    showDialog(`<h2>选择目录失败</h2><p class="error">${esc(error)}</p><p class="hint">可以继续手动输入目录路径。</p>`);
  }
}

function archiveRow(item: ArchivedSession): string {
  return `<div class="archive-row">
    <div>
      <strong>${agentLabel(item.agent)} · ${esc(item.title || item.sessionId)}</strong>
      <p><code>${esc(item.sessionId)}</code></p>
      <p>归档时间：${esc(item.archivedAt.slice(0, 19).replace("T", " "))}</p>
      <p>原位置：</p><code>${esc(item.originalPath)}</code>
      <p>归档文件：</p><code>${esc(item.archivePath)}</code>
      ${item.parseError ? `<p class="error">原解析错误：${esc(item.parseError)}</p>` : ""}
    </div>
    <button class="btn-3d restore-archive" data-id="${esc(item.archiveId)}">${icon("refresh")}<span>恢复</span></button>
  </div>`;
}

async function showArchives() {
  try {
    const archives = await api.listArchives();
    if (!archives.length) {
      showDialog("<h2>备份归档</h2><div class=\"empty\">暂无归档会话。</div>");
      return;
    }
    showDialog(`<h2>备份归档</h2>
      <p class="hint">归档内容不会进入正常项目索引；只有打开这里时才读取。</p>
      <div class="archive-list">${archives.map(archiveRow).join("")}</div>`);
    document.querySelectorAll<HTMLButtonElement>(".restore-archive").forEach((btn) => {
      btn.addEventListener("click", () => confirmRestoreArchive(btn.dataset.id || ""));
    });
  } catch (error) {
    showDialog(`<h2>读取归档失败</h2><p class="error">${esc(error)}</p>`);
  }
}

async function confirmRestoreArchive(archiveId: string) {
  const archives = await api.listArchives();
  const item = archives.find((it) => it.archiveId === archiveId);
  if (!item) {
    showDialog(`<h2>归档不存在</h2><p class="error">${esc(archiveId)}</p>`);
    return;
  }
  showDialog(`<h2>确认恢复归档？</h2>
    <p>会把归档文件移回原始会话目录；如果原位置已经存在同名文件，恢复会停止以避免覆盖。</p>
    <div class="result-box">
      <p>${agentLabel(item.agent)}：<code>${esc(item.sessionId)}</code></p>
      <p>从：</p><code>${esc(item.archivePath)}</code>
      <p>恢复到：</p><code>${esc(item.originalPath)}</code>
    </div>
    <div class="row"><button id="confirmRestoreArchive" class="btn-3d">${icon("refresh")}<span>确认恢复</span></button></div>`);
  document.querySelector<HTMLButtonElement>("#confirmRestoreArchive")?.addEventListener("click", async () => {
    try {
      const result = await api.restoreArchive({ archiveId });
      scheduleBackgroundListRefresh(0);
      showDialog(`<h2>归档已恢复</h2>
        <div class="result-box">
          <p>${agentLabel(result.agent)}：<code>${esc(result.sessionId)}</code></p>
          <p>恢复到：</p><code>${esc(result.restoredPath)}</code>
        </div>`);
    } catch (error) {
      showDialog(`<h2>恢复失败</h2><p class="error">${esc(error)}</p>`);
    }
  });
}
async function saveSettings() {
  try {
    currentTheme = (select("#setTheme").value as Theme) || "system";
    const bgText = input("#setBg").value.trim();
    if (!bgText.startsWith("(已选择本地图片")) currentBg = bgText;
    localStorage.setItem(THEME_KEY, currentTheme);
    localStorage.setItem(BG_KEY, currentBg);
    applyTheme(currentTheme, currentBg);
    const saved = await api.saveSettings({
      storageRoot: input("#setStorage").value.trim() || undefined,
      stateRoot: input("#setState").value.trim() || undefined,
      logRoot: input("#setLog").value.trim() || undefined,
      tempRoot: input("#setTemp").value.trim() || undefined,
      archiveRoot: input("#setArchive").value.trim() || undefined,
      clientPaths: {
        claude: input("#setClientClaude").value.trim(),
        codex: input("#setClientCodex").value.trim(),
        zcode: input("#setClientZcode").value.trim(),
        opencode: input("#setClientOpencode").value.trim(),
      },
      defaultModels: {
        claude: input("#setDefaultClaudeModel").value.trim(),
        codex: input("#setDefaultCodexModel").value.trim(),
      },
      modelAliases: parseModelAliases((document.querySelector<HTMLTextAreaElement>("#setModelAliases")?.value || "")),
      remoteClients: select("#setRemoteEnabled").value === "yes" ? [{
        id: "remote-primary",
        label: input("#setRemoteHost").value.trim() || "Remote",
        agent: select("#setRemoteAgent").value,
        host: input("#setRemoteHost").value.trim(),
        port: Number(input("#setRemotePort").value.trim()) || undefined,
        username: input("#setRemoteUser").value.trim(),
        password: input("#setRemotePassword").value,
      }] : undefined,
    });
    showDialog(`<h2>设置已保存</h2><pre class="status">${esc(JSON.stringify(saved, null, 2))}</pre>`);
  } catch (error) {
    showDialog(`<h2>错误</h2><p class="error">${esc(error)}</p>`);
  }
}

async function resetSettings() {
  try {
    await api.resetSettings();
    currentTheme = "system";
    currentBg = "";
    localStorage.removeItem(THEME_KEY);
    localStorage.removeItem(BG_KEY);
    applyTheme(currentTheme, currentBg);
    showDialog("<h2>设置已重置</h2><p>运行存储位置和外观已恢复默认。</p>");
  } catch (error) {
    showDialog(`<h2>错误</h2><p class="error">${esc(error)}</p>`);
  }
}

let draggingClient: ClientId | null = null;
let dragTimer: number | undefined;
let suppressClientClick = false;

function isClientId(value: string): value is ClientId {
  return DEFAULT_CLIENT_ORDER.includes(value as ClientId);
}

function toggleAgentDrawer(force?: boolean) {
  const drawer = document.querySelector<HTMLDivElement>("#agentDrawer");
  if (!drawer) return;
  drawer.hidden = force === undefined ? !drawer.hidden : !force;
  document.querySelector<HTMLButtonElement>("#agentDrawerTrigger")?.classList.toggle("open", !drawer.hidden);
}

function moveClientBefore(source: ClientId, target: ClientId) {
  if (source === target) return;
  const next = clientOrder.filter((id) => id !== source);
  const targetIndex = next.indexOf(target);
  next.splice(targetIndex < 0 ? next.length : targetIndex, 0, source);
  clientOrder = next;
  saveClientOrder();
  rerenderClientArea();
}

function endClientDrag() {
  if (draggingClient) {
    suppressClientClick = true;
    window.setTimeout(() => {
      suppressClientClick = false;
    }, 0);
  }
  if (dragTimer !== undefined) {
    window.clearTimeout(dragTimer);
    dragTimer = undefined;
  }
  draggingClient = null;
  document.querySelectorAll(".agent-tile.dragging").forEach((el) => el.classList.remove("dragging"));
}

function bindClientDrawer() {
  const drawer = document.querySelector<HTMLDivElement>("#agentDrawer");
  if (!drawer) return;
  drawer.querySelector<HTMLButtonElement>(".add-client")?.addEventListener("click", () => {
    showDialog(`<h2>添加客户端</h2>
      <div class="set-section">
        <h3>客户端类型</h3>
        <div class="row"><button class="btn-3d" id="addLocalClient">本地客户端</button><button class="btn-3d" id="addRemoteClient">远程服务器客户端</button></div>
      </div>
      <p class="hint">本地客户端会优先自动检测运行状态和安装位置；找不到时可在设置里手动填写 exe 路径。远程服务器客户端需要配置地址、用户名和密码，当前版本先保存连接配置，远程同步协议后续接入。</p>`);
    document.querySelector<HTMLButtonElement>("#addLocalClient")?.addEventListener("click", showSettings);
    document.querySelector<HTMLButtonElement>("#addRemoteClient")?.addEventListener("click", showSettings);
  });
  drawer.querySelectorAll<HTMLButtonElement>(".agent-tile[data-client]").forEach((tile) => {
    const client = tile.dataset.client || "";
    if (!isClientId(client)) return;
    tile.addEventListener("pointerdown", () => {
      endClientDrag();
      dragTimer = window.setTimeout(() => {
        draggingClient = client;
        tile.classList.add("dragging");
      }, 240);
    });
    tile.addEventListener("pointerenter", () => {
      if (!draggingClient || draggingClient === client) return;
      moveClientBefore(draggingClient, client);
    });
    tile.addEventListener("click", () => {
      if (draggingClient || suppressClientClick) return;
      const state = clientState(client);
      showDialog(`<h2>${esc(clientLabel(client))}</h2><p>${esc(state.tip)}</p><p>Zcode / OpenCode 迁移逻辑暂未接入；这里仅用于客户端状态与位置管理。</p>`);
    });
  });
}

bindClientDrawer();
$("#agentDrawerTrigger").addEventListener("click", (event) => {
  event.stopPropagation();
  toggleAgentDrawer();
});
$("#autoToggle").addEventListener("click", () => setPaused(!paused));
$("#refreshNow").addEventListener("click", async () => {
  void loadList();
  void refreshClientStatus();
});
$("#agentFilter").addEventListener("change", () => {
  resetRefreshCountdown();
  queueFilterApply(0);
});
input("#cwdFilter").addEventListener("input", () => {
  queueFilterApply();
});
input("#cwdFilter").addEventListener("keydown", async (event: KeyboardEvent) => {
  if (event.key === "Enter") {
    const searched = await searchBySessionId(input("#cwdFilter").value);
    if (searched) return;
    resetRefreshCountdown();
    queueFilterApply(0);
  }
});
$("#migrateBtn").addEventListener("click", migrateCurrent);
$("#switchClaude").addEventListener("click", () => switchTo("claude"));
$("#switchCodex").addEventListener("click", () => switchTo("codex"));
$("#navSync").addEventListener("click", showSyncStatus);
$("#navSettings").addEventListener("click", showSettings);
$("#navTheme").addEventListener("click", () => {
  const order: Theme[] = ["system", "light", "dark"];
  currentTheme = order[(order.indexOf(currentTheme) + 1) % order.length];
  localStorage.setItem(THEME_KEY, currentTheme);
  applyTheme(currentTheme, currentBg);
});
$("#closeDialog").addEventListener("click", () => dialog("#dialog").close());
document.querySelector("#dialog")?.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const openBtn = target.closest<HTMLButtonElement>(".open-agent");
  if (openBtn) {
    void openInAgent(openBtn.dataset.agent as Agent, openBtn.dataset.id || "", openBtn.dataset.cwd || undefined);
    return;
  }
  const claudeImportBtn = target.closest<HTMLButtonElement>(".claude-desktop-import");
  if (claudeImportBtn) {
    void openClaudeDesktopImport(claudeImportBtn.dataset.id || "", claudeImportBtn.dataset.cwd || undefined);
    return;
  }
  const restartBtn = target.closest<HTMLButtonElement>(".restart-client");
  if (restartBtn) {
    void restartClient(restartBtn.dataset.agent as Agent);
    return;
  }
  const openDesktopBtn = target.closest<HTMLButtonElement>(".open-desktop-client");
  if (openDesktopBtn) {
    void openDesktopClient(openDesktopBtn.dataset.agent as Agent);
    return;
  }
  const desktopBtn = target.closest<HTMLButtonElement>(".desktop-target");
  if (desktopBtn) {
    const agent = desktopBtn.dataset.agent as Agent;
    void (async () => {
      try {
        const status = await api.agentClientStatus({ agent });
        showDialog(`<h2>${agentLabel(agent)} Desktop 客户端</h2>
          <p>迁移/撤回已经写入本地会话文件和 xfer 状态。目标客户端是否立即显示，取决于它自己的会话索引刷新机制。</p>
          ${clientStatusHtml(status, agent)}`);
      } catch (error) {
        showDialog(`<h2>${agentLabel(agent)} Desktop 检测失败</h2><p class="error">${esc(error)}</p>`);
      }
    })();
  }
});
document.addEventListener("click", (e) => {
  const menu = document.querySelector<HTMLDivElement>("#ctxMenu")!;
  if (!menu.hidden && !menu.contains(e.target as Node)) closeContextMenu();
  const shell = document.querySelector<HTMLDivElement>(".rail-status-shell");
  const drawer = document.querySelector<HTMLDivElement>("#agentDrawer");
  const trigger = document.querySelector<HTMLButtonElement>("#agentDrawerTrigger");
  const target = e.target as Node;
  if (shell && drawer && trigger && !shell.contains(target) && !drawer.contains(target) && !trigger.contains(target)) {
    toggleAgentDrawer(false);
  }
});
document.addEventListener("pointerup", endClientDrag);
document.addEventListener("pointercancel", endClientDrag);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeContextMenu();
    if (dialog("#dialog").open) dialog("#dialog").close();
  }
});
$("#list").addEventListener("scroll", closeContextMenu, { passive: true });

if (api.runtime !== "app") $("#navSettings")?.remove();

startAutoRefresh();
scheduleIdle(() => bootstrapApp(), 120);







