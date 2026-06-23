#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod xfer;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::{env, path::{Path, PathBuf}};
use tauri::Manager;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientProcess {
  pid: u32,
  name: String,
  path: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientStatus {
  agent: String,
  running: bool,
  can_restart: bool,
  processes: Vec<ClientProcess>,
  note: String,
  launchable: bool,
  launch_path: Option<String>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
  storage_root: Option<String>,
  state_root: Option<String>,
  log_root: Option<String>,
  temp_root: Option<String>,
  archive_root: Option<String>,
  client_paths: Option<HashMap<String, String>>,
  default_models: Option<HashMap<String, String>>,
  model_aliases: Option<HashMap<String, String>>,
  remote_clients: Option<Vec<RemoteClientSettings>>,
  #[serde(skip_serializing_if = "Option::is_none")]
  database_path: Option<String>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteClientSettings {
  id: String,
  label: String,
  agent: String,
  host: String,
  port: Option<u16>,
  username: String,
  password: Option<String>,
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  let dir = app
    .path()
    .app_config_dir()
    .map_err(|e| format!("failed to resolve app config dir: {e}"))?;
  std::fs::create_dir_all(&dir).map_err(|e| format!("failed to create settings dir: {e}"))?;
  Ok(dir.join("settings.json"))
}

fn load_settings(app: &tauri::AppHandle) -> AppSettings {
  let Ok(file) = settings_path(app) else {
    return AppSettings::default();
  };
  std::fs::read_to_string(file)
    .ok()
    .and_then(|raw| serde_json::from_str(&raw).ok())
    .unwrap_or_default()
}

fn save_settings_file(app: &tauri::AppHandle, settings: &AppSettings) -> Result<(), String> {
  let file = settings_path(app)?;
  let data = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
  std::fs::write(file, data + "\n").map_err(|e| format!("failed to write settings: {e}"))
}

fn clean_opt(value: &Option<String>) -> Option<String> {
  value.as_ref().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn clean_settings(settings: AppSettings) -> AppSettings {
  let client_paths = settings.client_paths.map(|paths| {
    paths
      .into_iter()
      .filter_map(|(key, value)| {
        let value = value.trim().to_string();
        (!key.trim().is_empty() && !value.is_empty()).then_some((key.trim().to_string(), value))
      })
      .collect::<HashMap<_, _>>()
  }).filter(|paths| !paths.is_empty());
  let remote_clients = settings.remote_clients.map(|clients| {
    clients
      .into_iter()
      .filter_map(|client| {
        let host = client.host.trim().to_string();
        let username = client.username.trim().to_string();
        (!host.is_empty() && !username.is_empty()).then_some(RemoteClientSettings {
          id: if client.id.trim().is_empty() { format!("remote-{}", host) } else { client.id.trim().to_string() },
          label: if client.label.trim().is_empty() { host.clone() } else { client.label.trim().to_string() },
          agent: client.agent.trim().to_string(),
          host,
          port: client.port,
          username,
          password: clean_opt(&client.password),
        })
      })
      .collect::<Vec<_>>()
  }).filter(|clients| !clients.is_empty());
  let default_models = clean_map(settings.default_models);
  let model_aliases = clean_map(settings.model_aliases);
  AppSettings {
    storage_root: clean_opt(&settings.storage_root),
    state_root: clean_opt(&settings.state_root),
    log_root: clean_opt(&settings.log_root),
    temp_root: clean_opt(&settings.temp_root),
    archive_root: clean_opt(&settings.archive_root),
    client_paths,
    default_models,
    model_aliases,
    remote_clients,
    database_path: None,
  }
}

fn clean_map(values: Option<HashMap<String, String>>) -> Option<HashMap<String, String>> {
  values.map(|items| {
    items
      .into_iter()
      .filter_map(|(key, value)| {
        let key = key.trim().to_string();
        let value = value.trim().to_string();
        (!key.is_empty() && !value.is_empty()).then_some((key, value))
      })
      .collect::<HashMap<_, _>>()
  }).filter(|items| !items.is_empty())
}

fn exe_dir() -> Option<PathBuf> {
  env::current_exe()
    .ok()
    .and_then(|exe| exe.parent().map(|dir| dir.to_path_buf()))
}

fn exe_dir_is_writable(dir: &Path) -> bool {
  let probe = dir.join(".xfer-write-test");
  match std::fs::OpenOptions::new().write(true).create_new(true).open(&probe) {
    Ok(_) => {
      let _ = std::fs::remove_file(probe);
      true
    }
    Err(_) => false,
  }
}

fn runtime_default_root(app: &tauri::AppHandle, name: &str) -> Option<String> {
  let dir = exe_dir()?;
  let root = if exe_dir_is_writable(&dir) {
    dir
  } else {
    app
      .path()
      .app_config_dir()
      .ok()
      .map(|dir| dir.join("runtime"))?
  };
  Some(root.join(name).to_string_lossy().to_string())
}

fn apply_settings_env(app: &tauri::AppHandle, settings: &AppSettings) {
  for name in [
    "XFER_TARGET_MODEL_CLAUDE",
    "XFER_TARGET_MODEL_CODEX",
    "XFER_MODEL_ALIASES",
    "XFER_CLIENT_PATH_CLAUDE",
    "XFER_CLIENT_PATH_CODEX",
    "XFER_CLIENT_PATH_ZCODE",
    "XFER_CLIENT_PATH_OPENCODE",
    "XFER_ARCHIVE_ROOT",
  ] {
    env::remove_var(name);
  }
  set_env_or_default(app, "XFER_STORAGE_ROOT", &settings.storage_root, Some("xfer-data"));
  set_env_or_default(app, "XFER_STATE_ROOT", &settings.state_root, Some("xfer-state"));
  set_env_or_default(app, "XFER_LOG_ROOT", &settings.log_root, Some("xfer-log"));
  set_env_or_default(app, "XFER_TEMP_ROOT", &settings.temp_root, Some("xfer-temp"));
  set_env_or_default(app, "XFER_ARCHIVE_ROOT", &settings.archive_root, Some("xfer-archive"));
  if let Some(paths) = &settings.client_paths {
    for (agent, path) in paths {
      env::set_var(format!("XFER_CLIENT_PATH_{}", agent.to_ascii_uppercase()), path);
    }
  }
  if let Some(models) = &settings.default_models {
    if let Some(model) = models.get("claude") {
      env::set_var("XFER_TARGET_MODEL_CLAUDE", model);
    }
    if let Some(model) = models.get("codex") {
      env::set_var("XFER_TARGET_MODEL_CODEX", model);
    }
  }
  if let Some(aliases) = &settings.model_aliases {
    if let Ok(value) = serde_json::to_string(aliases) {
      env::set_var("XFER_MODEL_ALIASES", value);
    }
  }
}

fn set_env_or_default(app: &tauri::AppHandle, name: &str, value: &Option<String>, runtime_default: Option<&str>) {
  if let Some(value) = value {
    env::set_var(name, value);
  } else if env::var_os(name).is_none() {
    if let Some(default_name) = runtime_default.and_then(|default| runtime_default_root(app, default)) {
      env::set_var(name, default_name);
    }
  }
}

fn with_settings<T>(app: &tauri::AppHandle, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
  let settings = load_settings(app);
  apply_settings_env(app, &settings);
  f()
}

async fn run_blocking<T, F>(f: F) -> Result<T, String>
where
  T: Send + 'static,
  F: FnOnce() -> Result<T, String> + Send + 'static,
{
  tauri::async_runtime::spawn_blocking(f)
    .await
    .map_err(|e| format!("background task failed: {e}"))?
}

fn settings_with_runtime(app: &tauri::AppHandle) -> AppSettings {
  let mut settings = load_settings(app);
  apply_settings_env(app, &settings);
  let database_path = xfer::db::init().unwrap_or_else(|error| format!("failed to initialize database: {error}"));
  settings.database_path = Some(database_path);
  if settings.archive_root.is_none() {
    settings.archive_root = Some(xfer::settings::archive_root().to_string_lossy().to_string());
  }
  settings
}

#[tauri::command]
async fn list_sessions(app: tauri::AppHandle, args: Value) -> Result<Value, String> {
  run_blocking(move || with_settings(&app, || {
    let opts: xfer::index::ListOptions = serde_json::from_value(args).map_err(|e| e.to_string())?;
    serde_json::to_value(xfer::index::list_sessions(opts)).map_err(|e| e.to_string())
  })).await
}

#[tauri::command]
async fn get_session(app: tauri::AppHandle, args: Value) -> Result<Value, String> {
  run_blocking(move || with_settings(&app, || {
    let session_id = args
      .get("sessionId")
      .and_then(Value::as_str)
      .ok_or_else(|| "sessionId is required".to_string())?;
    let session = xfer::index::load_session(session_id)
      .ok_or_else(|| format!("Session not found: {session_id}"))?;
    serde_json::to_value(session).map_err(|e| e.to_string())
  })).await
}

#[tauri::command]
async fn migrate_session(app: tauri::AppHandle, args: Value) -> Result<Value, String> {
  run_blocking(move || with_settings(&app, || {
    let opts: xfer::migrate::MigrateOptions = serde_json::from_value(args).map_err(|e| e.to_string())?;
    serde_json::to_value(xfer::migrate::migrate(opts)?).map_err(|e| e.to_string())
  })).await
}

#[tauri::command]
async fn switch_session(app: tauri::AppHandle, args: Value) -> Result<Value, String> {
  run_blocking(move || with_settings(&app, || {
    let opts: xfer::sync::SwitchOptions = serde_json::from_value(args).map_err(|e| e.to_string())?;
    serde_json::to_value(xfer::sync::switch_session(opts)?).map_err(|e| e.to_string())
  })).await
}

#[tauri::command]
async fn sync_status(app: tauri::AppHandle, args: Value) -> Result<Value, String> {
  run_blocking(move || with_settings(&app, || {
    let cwd = args.get("cwd").and_then(Value::as_str);
    serde_json::to_value(serde_json::json!({ "text": xfer::sync::sync_status(cwd) })).map_err(|e| e.to_string())
  })).await
}

#[tauri::command]
async fn sync_mappings(app: tauri::AppHandle, args: Value) -> Result<Value, String> {
  run_blocking(move || with_settings(&app, || {
    let opts: xfer::sync::SyncMappingsOptions = serde_json::from_value(args).map_err(|e| e.to_string())?;
    serde_json::to_value(xfer::sync::sync_mappings(opts)).map_err(|e| e.to_string())
  })).await
}

#[tauri::command]
async fn undo_migration(app: tauri::AppHandle, args: Value) -> Result<Value, String> {
  run_blocking(move || with_settings(&app, || {
    let opts: xfer::sync::UndoMigrationOptions = serde_json::from_value(args).map_err(|e| e.to_string())?;
    serde_json::to_value(xfer::sync::undo_migration(opts)?).map_err(|e| e.to_string())
  })).await
}

#[tauri::command]
async fn sync_back(app: tauri::AppHandle, args: Value) -> Result<Value, String> {
  run_blocking(move || with_settings(&app, || {
    let opts: xfer::sync::SyncBackOptions = serde_json::from_value(args).map_err(|e| e.to_string())?;
    serde_json::to_value(xfer::sync::sync_back(opts)?).map_err(|e| e.to_string())
  })).await
}

#[tauri::command]
async fn index_status(app: tauri::AppHandle) -> Result<Value, String> {
  run_blocking(move || with_settings(&app, || {
    serde_json::to_value(xfer::index::index_status()).map_err(|e| e.to_string())
  })).await
}

#[tauri::command]
async fn find_session_info(app: tauri::AppHandle, args: Value) -> Result<Value, String> {
  run_blocking(move || with_settings(&app, || {
    let opts: xfer::session_ops::FindSessionOptions = serde_json::from_value(args).map_err(|e| e.to_string())?;
    serde_json::to_value(xfer::session_ops::find_session_info(opts)).map_err(|e| e.to_string())
  })).await
}

#[tauri::command]
async fn archive_preview(app: tauri::AppHandle, args: Value) -> Result<Value, String> {
  run_blocking(move || with_settings(&app, || {
    let opts: xfer::session_ops::ArchiveSessionOptions = serde_json::from_value(args).map_err(|e| e.to_string())?;
    serde_json::to_value(xfer::session_ops::archive_preview(opts)?).map_err(|e| e.to_string())
  })).await
}

#[tauri::command]
async fn archive_session(app: tauri::AppHandle, args: Value) -> Result<Value, String> {
  run_blocking(move || with_settings(&app, || {
    let opts: xfer::session_ops::ArchiveSessionOptions = serde_json::from_value(args).map_err(|e| e.to_string())?;
    serde_json::to_value(xfer::session_ops::archive_session(opts)?).map_err(|e| e.to_string())
  })).await
}

#[tauri::command]
async fn delete_session(app: tauri::AppHandle, args: Value) -> Result<Value, String> {
  run_blocking(move || with_settings(&app, || {
    let opts: xfer::session_ops::DeleteSessionOptions = serde_json::from_value(args).map_err(|e| e.to_string())?;
    serde_json::to_value(xfer::session_ops::delete_session(opts)?).map_err(|e| e.to_string())
  })).await
}

#[tauri::command]
async fn list_archives(app: tauri::AppHandle) -> Result<Value, String> {
  run_blocking(move || with_settings(&app, || {
    serde_json::to_value(xfer::session_ops::list_archives()?).map_err(|e| e.to_string())
  })).await
}

#[tauri::command]
async fn restore_archive(app: tauri::AppHandle, args: Value) -> Result<Value, String> {
  run_blocking(move || with_settings(&app, || {
    let opts: xfer::session_ops::RestoreArchiveOptions = serde_json::from_value(args).map_err(|e| e.to_string())?;
    serde_json::to_value(xfer::session_ops::restore_archive(opts)?).map_err(|e| e.to_string())
  })).await
}

#[tauri::command]
async fn repair_session(app: tauri::AppHandle, args: Value) -> Result<Value, String> {
  run_blocking(move || with_settings(&app, || {
    let opts: xfer::session_ops::RepairSessionOptions = serde_json::from_value(args).map_err(|e| e.to_string())?;
    serde_json::to_value(xfer::session_ops::repair_session(opts)?).map_err(|e| e.to_string())
  })).await
}

#[tauri::command]
async fn repair_sessions_batch(app: tauri::AppHandle, args: Value) -> Result<Value, String> {
  run_blocking(move || with_settings(&app, || {
    let opts: xfer::session_ops::RepairBatchOptions = serde_json::from_value(args).map_err(|e| e.to_string())?;
    serde_json::to_value(xfer::session_ops::repair_sessions_batch(opts)?).map_err(|e| e.to_string())
  })).await
}

#[tauri::command]
fn get_settings(app: tauri::AppHandle) -> AppSettings {
  settings_with_runtime(&app)
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, args: Value) -> Result<AppSettings, String> {
  let settings = args
    .get("settings")
    .cloned()
    .unwrap_or(Value::Null);
  let settings: AppSettings = serde_json::from_value(settings).map_err(|e| e.to_string())?;
  let cleaned = clean_settings(settings);
  save_settings_file(&app, &cleaned)?;
  Ok(settings_with_runtime(&app))
}

#[tauri::command]
fn reset_settings(app: tauri::AppHandle) -> Result<AppSettings, String> {
  let cleaned = AppSettings::default();
  save_settings_file(&app, &cleaned)?;
  Ok(settings_with_runtime(&app))
}

#[tauri::command]
async fn choose_directory(app: tauri::AppHandle, args: Value) -> Result<Value, String> {
  run_blocking(move || with_settings(&app, || {
    let title = args.get("title").and_then(Value::as_str).unwrap_or("闁瀚ㄩ惄顔肩秿");
    let selected = choose_directory_impl(title)?;
    serde_json::to_value(serde_json::json!({ "path": selected })).map_err(|e| e.to_string())
  })).await
}

#[cfg(target_os = "windows")]
fn choose_directory_impl(title: &str) -> Result<Option<String>, String> {
  use std::os::windows::process::CommandExt;
  const CREATE_NO_WINDOW: u32 = 0x08000000;
  let script = format!(
    "Add-Type -AssemblyName System.Windows.Forms; \
     $d = New-Object System.Windows.Forms.FolderBrowserDialog; \
     $d.Description = '{}'; \
     $d.ShowNewFolderButton = $true; \
     if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {{ [Console]::Out.Write($d.SelectedPath) }}",
    title.replace('\'', "''")
  );
  let output = std::process::Command::new("powershell")
    .creation_flags(CREATE_NO_WINDOW)
    .args(["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", &script])
    .output()
    .map_err(|e| format!("failed to open folder picker: {e}"))?;
  if !output.status.success() {
    return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
  }
  let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
  Ok((!value.is_empty()).then_some(value))
}

#[cfg(target_os = "macos")]
fn choose_directory_impl(title: &str) -> Result<Option<String>, String> {
  let script = format!(
    "POSIX path of (choose folder with prompt \"{}\")",
    title.replace('\\', "\\\\").replace('"', "\\\"")
  );
  let output = std::process::Command::new("osascript")
    .args(["-e", &script])
    .output()
    .map_err(|e| format!("failed to open folder picker: {e}"))?;
  if !output.status.success() {
    return Ok(None);
  }
  let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
  Ok((!value.is_empty()).then_some(value))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn choose_directory_impl(_title: &str) -> Result<Option<String>, String> {
  for program in ["zenity", "kdialog"] {
    let available = std::process::Command::new("which").arg(program).output().map(|o| o.status.success()).unwrap_or(false);
    if !available {
      continue;
    }
    let output = if program == "zenity" {
      std::process::Command::new(program).arg("--file-selection").arg("--directory").output()
    } else {
      std::process::Command::new(program).arg("--getexistingdirectory").output()
    }.map_err(|e| format!("failed to open folder picker: {e}"))?;
    if output.status.success() {
      let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
      return Ok((!value.is_empty()).then_some(value));
    }
  }
  Err("No supported folder picker found. Install zenity/kdialog or type the path manually.".to_string())
}

fn cmd_quote(value: &str) -> String {
  format!("\"{}\"", value.replace('"', "\"\""))
}

#[cfg(unix)]
fn sh_quote(value: &str) -> String {
  format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(target_os = "macos")]
fn applescript_quote(value: &str) -> String {
  value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn claude_session_path(session_id: &str, cwd: &str) -> PathBuf {
  xfer::paths::claude_projects_dir()
    .join(xfer::paths::encode_claude_project_dir(cwd))
    .join(format!("{session_id}.jsonl"))
}

fn rewrite_claude_session_cwd(src: &Path, dst: &Path, cwd: &str) -> Result<(), String> {
  let raw = std::fs::read_to_string(src).map_err(|e| format!("failed to read Claude session: {e}"))?;
  if let Some(parent) = dst.parent() {
    std::fs::create_dir_all(parent).map_err(|e| format!("failed to create Claude project dir: {e}"))?;
  }
  let mut out = String::new();
  for line in raw.lines() {
    if line.trim().is_empty() {
      out.push('\n');
      continue;
    }
    match serde_json::from_str::<Value>(line) {
      Ok(mut value) => {
        value["cwd"] = Value::String(cwd.to_string());
        out.push_str(&serde_json::to_string(&value).map_err(|e| e.to_string())?);
      }
      Err(_) => out.push_str(line),
    }
    out.push('\n');
  }
  std::fs::write(dst, out).map_err(|e| format!("failed to repair Claude session path: {e}"))
}

fn ensure_resume_visible(agent: &str, session_id: &str, cwd: &str) -> Result<Option<PathBuf>, String> {
  match agent {
    "claude" => {
      let expected = claude_session_path(session_id, cwd);
      if expected.is_file() {
        return Ok(Some(expected));
      }
      if let Some((found_agent, found_path)) = xfer::index::find_session(session_id) {
        if found_agent == xfer::model::Agent::Claude && found_path.is_file() {
          rewrite_claude_session_cwd(&found_path, &expected, cwd)?;
          return Ok(Some(expected));
        }
      }
      Err(format!(
        "Claude session file not found for this project cwd.\nExpected: {}\nRun migrate/switch again for cwd: {}",
        expected.display(),
        cwd
      ))
    }
    "codex" => {
      if let Some((found_agent, found_path)) = xfer::index::find_session(session_id) {
        if found_agent == xfer::model::Agent::Codex {
          return Ok(Some(found_path));
        }
      }
      Err(format!("Codex session not found: {session_id}"))
    }
    _ => Ok(None),
  }
}

/// Launch a new terminal window that resumes the given session in the target
/// CLI (Claude Code or Codex), cd'd into the session's project cwd. The running
/// CLI processes are not touched; this opens a fresh window into the migrated
/// session so the user lands there with one click.
fn client_process_names(agent: &str) -> Result<Vec<&'static str>, String> {
  match agent {
    "claude" => Ok(vec!["Claude.exe", "Claude Desktop.exe", "Claude Code.exe", "claude.exe"]),
    "codex" => Ok(vec!["Codex.exe", "Codex Desktop.exe", "codex.exe"]),
    "zcode" => Ok(vec!["Zcode.exe", "ZCode.exe", "Zed.exe"]),
    "opencode" => Ok(vec!["opencode.exe", "OpenCode.exe"]),
    other => Err(format!("unknown agent: {other}")),
  }
}

#[cfg(target_os = "windows")]
fn known_client_paths(agent: &str) -> Vec<PathBuf> {
  let mut paths = Vec::new();
  let local = env::var_os("LOCALAPPDATA").map(PathBuf::from);
  let program_files = env::var_os("ProgramFiles").map(PathBuf::from);
  let program_files_x86 = env::var_os("ProgramFiles(x86)").map(PathBuf::from);

  match agent {
    "claude" => {
      if let Some(local) = &local {
        paths.push(local.join("Programs").join("Claude").join("Claude.exe"));
        paths.push(local.join("Claude").join("Claude.exe"));
      }
      if let Some(program_files) = &program_files {
        paths.push(program_files.join("Claude").join("Claude.exe"));
        paths.push(program_files.join("Anthropic").join("Claude").join("Claude.exe"));
      }
      if let Some(program_files_x86) = &program_files_x86 {
        paths.push(program_files_x86.join("Claude").join("Claude.exe"));
        paths.push(program_files_x86.join("Anthropic").join("Claude").join("Claude.exe"));
      }
    }
    "codex" => {
      if let Some(local) = &local {
        paths.push(local.join("Programs").join("Codex").join("Codex.exe"));
        paths.push(local.join("Codex").join("Codex.exe"));
      }
      if let Some(program_files) = &program_files {
        paths.push(program_files.join("Codex").join("Codex.exe"));
        paths.push(program_files.join("OpenAI").join("Codex").join("Codex.exe"));
      }
      if let Some(program_files_x86) = &program_files_x86 {
        paths.push(program_files_x86.join("Codex").join("Codex.exe"));
        paths.push(program_files_x86.join("OpenAI").join("Codex").join("Codex.exe"));
      }
    }
    _ => {}
  }

  paths
}

#[cfg(target_os = "windows")]
fn app_paths_client_path(agent: &str) -> Option<PathBuf> {
  use std::os::windows::process::CommandExt;
  const CREATE_NO_WINDOW: u32 = 0x08000000;
  let exe_names = match agent {
    "claude" => vec!["Claude.exe", "Claude Desktop.exe"],
    "codex" => vec!["Codex.exe", "Codex Desktop.exe"],
    _ => Vec::new(),
  };
  for exe in exe_names {
    let key = format!("HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\{exe}");
    let output = std::process::Command::new("reg")
      .args(["query", &key, "/ve"])
      .creation_flags(CREATE_NO_WINDOW)
      .output()
      .ok()?;
    if output.status.success() {
      let raw = String::from_utf8_lossy(&output.stdout);
      for line in raw.lines() {
        if let Some(index) = line.find("REG_") {
          let value = line[index..].splitn(2, char::is_whitespace).nth(1).unwrap_or("").trim();
          if !value.is_empty() {
            let path = PathBuf::from(value.trim_matches('"'));
            if path.is_file() {
              return Some(path);
            }
          }
        }
      }
    }
  }
  None
}

fn configured_client_path(agent: &str) -> Option<PathBuf> {
  let key = format!("XFER_CLIENT_PATH_{}", agent.to_ascii_uppercase());
  env::var_os(key).map(PathBuf::from).filter(|path| path.is_file())
}

fn client_launch_path(agent: &str, status: Option<&ClientStatus>) -> Option<PathBuf> {
  if let Some(path) = configured_client_path(agent) {
    return Some(path);
  }
  if let Some(path) = status.and_then(|s| s.processes.iter().find_map(|p| p.path.clone())) {
    let path = PathBuf::from(path);
    if path.is_file() {
      return Some(path);
    }
  }

  let program = match agent {
    "claude" => "Claude",
    "codex" => "Codex",
    _ => agent,
  };
  if let Ok(path) = which::which(program) {
    return Some(path);
  }

  #[cfg(target_os = "windows")]
  {
    if let Some(path) = known_client_paths(agent).into_iter().find(|path| path.is_file()) {
      return Some(path);
    }
    if let Some(path) = app_paths_client_path(agent) {
      return Some(path);
    }
  }

  None
}

fn agent_client_status_impl(args: Value) -> Result<ClientStatus, String> {
  let agent = args.get("agent").and_then(Value::as_str).ok_or_else(|| "agent is required".to_string())?;
  let names = client_process_names(agent)?;

  #[cfg(target_os = "windows")]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let quoted_names = names.iter().map(|name| format!("'{name}'")).collect::<Vec<_>>().join(",");
    let agent_pattern = match agent {
      "claude" => "Claude|Anthropic",
      "codex" => "Codex|OpenAI",
      "zcode" => "",
      "opencode" => "",
      _ => agent,
    };
    let script = if agent_pattern.is_empty() {
      format!(
        "$names=@({quoted_names}); Get-CimInstance Win32_Process | Where-Object {{ $names -icontains $_.Name }} | Select-Object Name,ProcessId,ExecutablePath | ConvertTo-Json -Compress"
      )
    } else {
      format!(
        "$names=@({quoted_names}); $pattern='{agent_pattern}'; Get-CimInstance Win32_Process | Where-Object {{ ($names -icontains $_.Name) -or ($_.ExecutablePath -and $_.ExecutablePath -match $pattern) -or ($_.CommandLine -and $_.CommandLine -match $pattern) }} | Select-Object Name,ProcessId,ExecutablePath | ConvertTo-Json -Compress"
      )
    };
    let output = std::process::Command::new("powershell")
      .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &script])
      .creation_flags(CREATE_NO_WINDOW)
      .output()
      .map_err(|e| format!("failed to inspect target client processes: {e}"))?;
    if !output.status.success() {
      let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
      return Err(if err.is_empty() { "failed to inspect target client processes".to_string() } else { err });
    }
    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let mut processes = Vec::new();
    if !raw.is_empty() {
      let value: Value = serde_json::from_str(&raw).map_err(|e| format!("failed to parse process list: {e}"))?;
      let rows = if let Some(items) = value.as_array() { items.clone() } else { vec![value] };
      for row in rows {
        let pid = row.get("ProcessId").and_then(Value::as_u64).unwrap_or_default() as u32;
        let name = row.get("Name").and_then(Value::as_str).unwrap_or_default().to_string();
        let path = row.get("ExecutablePath").and_then(Value::as_str).map(ToString::to_string).filter(|s| !s.is_empty());
        if pid > 0 && !name.is_empty() {
          processes.push(ClientProcess { pid, name, path });
        }
      }
    }
    let can_restart = processes.iter().any(|p| p.path.is_some());
    let mut status = ClientStatus {
      agent: agent.to_string(),
      running: !processes.is_empty(),
      can_restart,
      processes,
      note: if can_restart {
        "Target desktop client is running and can be restarted after confirmation.".to_string()
      } else {
        "Target desktop client is not running or its executable path is unavailable.".to_string()
      },
      launchable: false,
      launch_path: None,
    };
    let launch_path = client_launch_path(agent, Some(&status));
    status.launchable = launch_path.is_some();
    status.launch_path = launch_path.map(|p| p.to_string_lossy().to_string());
    if status.launchable && !status.running {
      status.note = "Target desktop client is not running, but xfer found a launch path.".to_string();
    }
    return Ok(ClientStatus {
      agent: status.agent,
      running: status.running,
      can_restart: status.can_restart,
      processes: status.processes,
      note: status.note,
      launchable: status.launchable,
      launch_path: status.launch_path,
    });
  }

  #[cfg(not(target_os = "windows"))]
  {
    Ok(ClientStatus {
      agent: agent.to_string(),
      running: false,
      can_restart: false,
      processes: Vec::new(),
      note: format!("Desktop client process detection is not implemented on this platform for {agent}."),
      launchable: false,
      launch_path: None,
    })
  }
}

fn restart_agent_client_impl(args: Value) -> Result<ClientStatus, String> {
  let agent = args.get("agent").and_then(Value::as_str).ok_or_else(|| "agent is required".to_string())?;
  let status = agent_client_status_impl(serde_json::json!({ "agent": agent }))?;
  if !status.running {
    return Ok(status);
  }
  let launch_path = status
    .processes
    .iter()
    .find_map(|p| p.path.clone())
    .ok_or_else(|| "Target client is running, but its executable path is unavailable; restart manually.".to_string())?;

  #[cfg(target_os = "windows")]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    for process in &status.processes {
      let _ = std::process::Command::new("taskkill")
        .args(["/PID", &process.pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    }
    std::thread::sleep(std::time::Duration::from_millis(800));
    std::process::Command::new(&launch_path)
      .creation_flags(CREATE_NO_WINDOW)
      .spawn()
      .map_err(|e| format!("failed to restart target client: {e}"))?;
    std::thread::sleep(std::time::Duration::from_millis(800));
    return agent_client_status_impl(serde_json::json!({ "agent": agent }));
  }

  #[cfg(not(target_os = "windows"))]
  {
    let _ = launch_path;
    Err("Restarting desktop clients is not implemented on this platform.".to_string())
  }
}

fn open_agent_client_impl(args: Value) -> Result<ClientStatus, String> {
  let agent = args.get("agent").and_then(Value::as_str).ok_or_else(|| "agent is required".to_string())?;
  let status = agent_client_status_impl(serde_json::json!({ "agent": agent }))?;
  let launch_path = client_launch_path(agent, Some(&status))
    .ok_or_else(|| format!("Cannot locate the {agent} desktop client executable. Start it manually or configure its install path later."))?;

  #[cfg(target_os = "windows")]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    std::process::Command::new(&launch_path)
      .creation_flags(CREATE_NO_WINDOW)
      .spawn()
      .map_err(|e| format!("failed to open target client: {e}"))?;
    std::thread::sleep(std::time::Duration::from_millis(800));
    return agent_client_status_impl(serde_json::json!({ "agent": agent }));
  }

  #[cfg(target_os = "macos")]
  {
    std::process::Command::new("open")
      .arg(&launch_path)
      .spawn()
      .map_err(|e| format!("failed to open target client: {e}"))?;
    std::thread::sleep(std::time::Duration::from_millis(800));
    return agent_client_status_impl(serde_json::json!({ "agent": agent }));
  }

  #[cfg(all(unix, not(target_os = "macos")))]
  {
    std::process::Command::new(&launch_path)
      .spawn()
      .map_err(|e| format!("failed to open target client: {e}"))?;
    std::thread::sleep(std::time::Duration::from_millis(800));
    return agent_client_status_impl(serde_json::json!({ "agent": agent }));
  }
}

fn open_in_agent_impl(args: Value) -> Result<Value, String> {
  let agent = args.get("agent").and_then(Value::as_str).ok_or_else(|| "agent is required".to_string())?;
  let session_id = args.get("sessionId").and_then(Value::as_str).ok_or_else(|| "sessionId is required".to_string())?;
  let cwd = xfer::paths::normalize_project_cwd(args.get("cwd").and_then(Value::as_str).unwrap_or("."));
  let visible_path = ensure_resume_visible(agent, session_id, &cwd)?;
  let (program, resume) = match agent {
    "claude" => ("claude", format!("claude --resume {}", cmd_quote(session_id))),
    "codex" => ("codex", format!("codex resume {}", cmd_quote(session_id))),
    other => return Err(format!("unknown agent: {other}")),
  };
  // Make sure the CLI is on PATH; if not, surface a clear error.
  if which::which(program).is_err() {
    return Err(format!("{program} not found on PATH; install it or add it to PATH"));
  }

  #[cfg(target_os = "windows")]
  {
    // start cmd /K "cd /d <cwd> && <resume>" opens a new console window and keeps it open.
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let mut launcher = if which::which("wt").is_ok() {
      let mut command = std::process::Command::new("wt");
      command.arg("-d").arg(&cwd).arg("cmd").arg("/K").arg(&resume);
      command
    } else {
      let mut command = std::process::Command::new("cmd");
      command.arg("/C").arg("start").arg("").arg("/D").arg(&cwd).arg("cmd").arg("/K").arg(&resume);
      command
    };

    launcher
      .creation_flags(CREATE_NO_WINDOW)
      .spawn()
      .map_err(|e| format!("failed to launch terminal: {e}"))?;
  }
  #[cfg(target_os = "macos")]
  {
    let shell = format!("cd {} && {}", sh_quote(&cwd), resume);
    let script = format!("tell application \"Terminal\" to do script \"{}\"", applescript_quote(&shell));
    std::process::Command::new("osascript").args(["-e", &script]).spawn().map_err(|e| format!("failed to launch terminal: {e}"))?;
  }
  #[cfg(all(unix, not(target_os = "macos")))]
  {
    let term = std::env::var("TERMINAL").unwrap_or_else(|_| "xterm".to_string());
    std::process::Command::new(&term)
      .args(["-e", "sh", "-c", &format!("cd {} && {resume}; exec sh", sh_quote(&cwd))])
      .spawn()
      .map_err(|e| format!("failed to launch terminal ({term}): {e}"))?;
  }
  Ok(serde_json::json!({
    "ok": true,
    "command": resume,
    "cwd": cwd,
    "filePath": visible_path.map(|p| p.to_string_lossy().to_string())
  }))
}

fn open_claude_desktop_import_impl(args: Value) -> Result<Value, String> {
  let session_id = args.get("sessionId").and_then(Value::as_str).ok_or_else(|| "sessionId is required".to_string())?;
  let cwd = xfer::paths::normalize_project_cwd(args.get("cwd").and_then(Value::as_str).unwrap_or("."));
  let visible_path = ensure_resume_visible("claude", session_id, &cwd)?;
  let resume = format!("claude --resume {}", cmd_quote(session_id));
  Ok(serde_json::json!({
    "ok": true,
    "requiresManualClaudeCode": false,
    "reason": "xfer registered the generated Claude Code session in Claude Desktop's local Code sessions index when that directory was available. Restart Claude Desktop if the Code tab does not refresh immediately.",
    "command": resume,
    "cwd": cwd,
    "filePath": visible_path.map(|p| p.to_string_lossy().to_string())
  }))
}

#[tauri::command]
async fn open_in_agent(app: tauri::AppHandle, args: Value) -> Result<Value, String> {
  run_blocking(move || with_settings(&app, || open_in_agent_impl(args))).await
}

#[tauri::command]
async fn open_claude_desktop_import(app: tauri::AppHandle, args: Value) -> Result<Value, String> {
  run_blocking(move || with_settings(&app, || open_claude_desktop_import_impl(args))).await
}

fn test_remote_connection_impl(args: Value) -> Result<Value, String> {
  let host = args.get("host").and_then(Value::as_str).ok_or_else(|| "host is required".to_string())?.trim();
  let username = args.get("username").and_then(Value::as_str).ok_or_else(|| "username is required".to_string())?.trim();
  let port = args.get("port").and_then(Value::as_u64).unwrap_or(22).to_string();
  if host.is_empty() || username.is_empty() {
    return Err("host and username are required".to_string());
  }
  if which::which("ssh").is_err() {
    return Err("ssh command not found. Install OpenSSH Client or add ssh to PATH.".to_string());
  }
  let target = format!("{username}@{host}");
  let output = std::process::Command::new("ssh")
    .args([
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=8",
      "-o", "StrictHostKeyChecking=accept-new",
      "-p", &port,
      &target,
      "echo xfer-remote-ok",
    ])
    .output()
    .map_err(|e| format!("failed to run ssh: {e}"))?;
  let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
  let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
  Ok(serde_json::json!({
    "ok": output.status.success() && stdout.contains("xfer-remote-ok"),
    "exitCode": output.status.code(),
    "stdout": stdout,
    "stderr": stderr,
    "target": target,
    "port": port,
    "note": "Password fields are saved for future remote protocol support. This SSH test uses OpenSSH BatchMode, so it succeeds with keys/agent and fails clearly when password auth is required."
  }))
}

#[tauri::command]
async fn test_remote_connection(app: tauri::AppHandle, args: Value) -> Result<Value, String> {
  run_blocking(move || with_settings(&app, || test_remote_connection_impl(args))).await
}

#[tauri::command]
async fn verify_codex_desktop_index(app: tauri::AppHandle, args: Value) -> Result<Value, String> {
  run_blocking(move || with_settings(&app, || {
    let session_id = args.get("sessionId").and_then(Value::as_str).ok_or_else(|| "sessionId is required".to_string())?;
    xfer::write::verify_codex_desktop_index(session_id)
  })).await
}

#[tauri::command]
async fn verify_claude_desktop_index(app: tauri::AppHandle, args: Value) -> Result<Value, String> {
  run_blocking(move || with_settings(&app, || {
    let session_id = args.get("sessionId").and_then(Value::as_str).ok_or_else(|| "sessionId is required".to_string())?;
    xfer::write::verify_claude_desktop_index(session_id)
  })).await
}

#[tauri::command]
async fn agent_client_status(app: tauri::AppHandle, args: Value) -> Result<ClientStatus, String> {
  run_blocking(move || with_settings(&app, || agent_client_status_impl(args))).await
}

#[tauri::command]
async fn restart_agent_client(app: tauri::AppHandle, args: Value) -> Result<ClientStatus, String> {
  run_blocking(move || with_settings(&app, || restart_agent_client_impl(args))).await
}

#[tauri::command]
async fn open_agent_client(app: tauri::AppHandle, args: Value) -> Result<ClientStatus, String> {
  run_blocking(move || with_settings(&app, || open_agent_client_impl(args))).await
}

fn main() {
  tauri::Builder::default()
    .setup(|app| {
      let settings = load_settings(app.handle());
      apply_settings_env(app.handle(), &settings);
      xfer::db::init().map_err(|e| Box::<dyn std::error::Error>::from(e))?;
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      list_sessions,
      get_session,
      migrate_session,
      switch_session,
      sync_status,
      sync_mappings,
      undo_migration,
      sync_back,
      index_status,
      find_session_info,
      archive_preview,
      archive_session,
      delete_session,
      list_archives,
      restore_archive,
      repair_session,
      repair_sessions_batch,
      get_settings,
      save_settings,
      reset_settings,
      choose_directory,
      open_in_agent,
      open_claude_desktop_import,
      test_remote_connection,
      verify_codex_desktop_index,
      verify_claude_desktop_index,
      agent_client_status,
      restart_agent_client,
      open_agent_client
    ])
    .run(tauri::generate_context!())
    .expect("error while running xfer app");
}
