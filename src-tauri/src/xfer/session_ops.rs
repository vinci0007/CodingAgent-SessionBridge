use crate::xfer::index::{find_session, index_session_file, load_session_file};
use crate::xfer::model::{Agent, Block, Role, SessionIndexEntry, SessionMeta, Turn, UnifiedSession};
use crate::xfer::paths::extract_uuid;
use crate::xfer::settings::archive_root;
use crate::xfer::write::{remove_target_desktop_index, write_claude_session, write_codex_session, WriteResult};
use chrono::{Datelike, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindSessionOptions {
  pub session_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFileInfo {
  pub found: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub agent: Option<Agent>,
  pub session_id: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub file_path: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub entry: Option<SessionIndexEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveSessionOptions {
  pub session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSessionOptions {
  pub session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreArchiveOptions {
  pub archive_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairSessionOptions {
  pub session_id: String,
  pub cwd: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivedSession {
  pub archive_id: String,
  pub agent: Agent,
  pub session_id: String,
  pub original_path: String,
  pub archive_path: String,
  pub archived_at: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub cwd: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub title: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub parse_error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveSessionResult {
  pub archive: ArchivedSession,
  pub metadata_path: String,
  pub desktop_index_removal: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSessionResult {
  pub removed_file: bool,
  pub agent: Agent,
  pub session_id: String,
  pub file_path: String,
  pub desktop_index_removal: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreArchiveResult {
  pub restored: bool,
  pub agent: Agent,
  pub session_id: String,
  pub restored_path: String,
  pub archive_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairSessionResult {
  pub agent: Agent,
  pub source_session_id: String,
  pub source_file_path: String,
  pub repaired_session_id: String,
  pub repaired_file_path: String,
  pub turns_written: usize,
  pub method: String,
}

pub fn find_session_info(opts: FindSessionOptions) -> SessionFileInfo {
  let session_id = opts.session_id.trim().to_string();
  let Some((agent, path)) = find_session(&session_id) else {
    return SessionFileInfo { found: false, agent: None, session_id, file_path: None, entry: None };
  };
  let entry = index_session_file(&path, agent);
  SessionFileInfo {
    found: true,
    agent: Some(agent),
    session_id,
    file_path: Some(path.to_string_lossy().to_string()),
    entry,
  }
}

pub fn archive_preview(opts: ArchiveSessionOptions) -> Result<ArchiveSessionResult, String> {
  let (agent, path) = locate(&opts.session_id)?;
  let archive = build_archive_metadata(agent, &path)?;
  Ok(ArchiveSessionResult {
    archive,
    metadata_path: metadata_path_for(&build_archive_path(agent, &path)?).to_string_lossy().to_string(),
    desktop_index_removal: Value::Null,
  })
}

pub fn archive_session(opts: ArchiveSessionOptions) -> Result<ArchiveSessionResult, String> {
  let (agent, path) = locate(&opts.session_id)?;
  let archive_path = build_archive_path(agent, &path)?;
  let mut archive = build_archive_metadata(agent, &path)?;
  archive.archive_path = archive_path.to_string_lossy().to_string();
  if let Some(parent) = archive_path.parent() {
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  }
  move_file(&path, &archive_path)?;
  let metadata_path = metadata_path_for(&archive_path);
  fs::write(&metadata_path, serde_json::to_string_pretty(&archive).map_err(|e| e.to_string())? + "\n").map_err(|e| e.to_string())?;
  let desktop_index_removal = remove_target_desktop_index(agent, &archive.session_id).unwrap_or_else(|e| serde_json::json!({ "error": e }));
  Ok(ArchiveSessionResult {
    archive,
    metadata_path: metadata_path.to_string_lossy().to_string(),
    desktop_index_removal,
  })
}

pub fn delete_session(opts: DeleteSessionOptions) -> Result<DeleteSessionResult, String> {
  let (agent, path) = locate(&opts.session_id)?;
  let session_id = session_id_for(&path).unwrap_or(opts.session_id);
  let removed_file = match fs::remove_file(&path) {
    Ok(_) => true,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
    Err(e) => return Err(e.to_string()),
  };
  let desktop_index_removal = remove_target_desktop_index(agent, &session_id).unwrap_or_else(|e| serde_json::json!({ "error": e }));
  Ok(DeleteSessionResult {
    removed_file,
    agent,
    session_id,
    file_path: path.to_string_lossy().to_string(),
    desktop_index_removal,
  })
}

pub fn list_archives() -> Result<Vec<ArchivedSession>, String> {
  let root = archive_root();
  if !root.exists() {
    return Ok(Vec::new());
  }
  let mut out = Vec::new();
  for entry in walkdir::WalkDir::new(root).into_iter().filter_map(Result::ok).filter(|e| e.file_type().is_file()) {
    if entry.path().extension().and_then(|s| s.to_str()) != Some("json") {
      continue;
    }
    if let Ok(raw) = fs::read_to_string(entry.path()) {
      if let Ok(item) = serde_json::from_str::<ArchivedSession>(&raw) {
        out.push(item);
      }
    }
  }
  out.sort_by(|a, b| b.archived_at.cmp(&a.archived_at));
  Ok(out)
}

pub fn restore_archive(opts: RestoreArchiveOptions) -> Result<RestoreArchiveResult, String> {
  let archives = list_archives()?;
  let archive = archives
    .into_iter()
    .find(|item| item.archive_id == opts.archive_id)
    .ok_or_else(|| format!("Archive not found: {}", opts.archive_id))?;
  let src = PathBuf::from(&archive.archive_path);
  if !src.is_file() {
    return Err(format!("Archive file not found: {}", archive.archive_path));
  }
  let dst = PathBuf::from(&archive.original_path);
  if dst.exists() {
    return Err(format!("Restore target already exists: {}", dst.display()));
  }
  if let Some(parent) = dst.parent() {
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  }
  move_file(&src, &dst)?;
  let metadata_path = metadata_path_for(&src);
  let _ = fs::remove_file(metadata_path);
  Ok(RestoreArchiveResult {
    restored: true,
    agent: archive.agent,
    session_id: archive.session_id,
    restored_path: dst.to_string_lossy().to_string(),
    archive_id: archive.archive_id,
  })
}

pub fn repair_session(opts: RepairSessionOptions) -> Result<RepairSessionResult, String> {
  let (agent, path) = locate(&opts.session_id)?;
  let (source, method) = match load_session_file(&path, agent) {
    Ok(session) => (session, "parsed session rewrite".to_string()),
    Err(parse_error) => (recover_raw_session(&path, agent, &parse_error)?, "raw JSONL transcript recovery".to_string()),
  };
  let cwd = opts
    .cwd
    .or_else(|| source.meta.cwd.clone())
    .or_else(|| std::env::current_dir().ok().map(|p| p.to_string_lossy().to_string()))
    .ok_or_else(|| "No cwd available for repaired session".to_string())?;
  let turns_written = source.turns.len();
  let written = write_same_agent(agent, &source, &cwd)?;
  Ok(RepairSessionResult {
    agent,
    source_session_id: source.meta.session_id.clone(),
    source_file_path: path.to_string_lossy().to_string(),
    repaired_session_id: written.session_id,
    repaired_file_path: written.file_path,
    turns_written,
    method,
  })
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairBatchOptions {
  // None = repair all agents; Some(set) = only listed agents.
  pub agents: Option<Vec<Agent>>,
  pub cwd: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairBatchItem {
  pub session_id: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub agent: Option<Agent>,
  pub ok: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub repaired_session_id: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub repaired_file_path: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub method: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub turns_written: Option<usize>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairBatchResult {
  pub total: usize,
  pub repaired: usize,
  pub failed: usize,
  pub skipped: usize,
  pub items: Vec<RepairBatchItem>,
}

pub fn repair_sessions_batch(opts: RepairBatchOptions) -> Result<RepairBatchResult, String> {
  let agent_filter: Option<std::collections::HashSet<Agent>> = opts.agents.map(|agents| agents.into_iter().collect());
  let mut all = crate::xfer::index::list_sessions(crate::xfer::index::ListOptions {
    cwd: None,
    agent: None,
    limit: Some(5000),
  });
  all.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));

  let mut items = Vec::new();
  let mut repaired = 0usize;
  let mut failed = 0usize;
  let mut skipped = 0usize;

  for entry in all {
    if let Some(filter) = &agent_filter {
      if !filter.contains(&entry.agent) {
        continue;
      }
    }
    if entry.parse_error.is_none() {
      skipped += 1;
      continue;
    }

    let result = repair_session(RepairSessionOptions {
      session_id: entry.session_id.clone(),
      cwd: opts.cwd.clone().or_else(|| entry.cwd.clone()),
    });

    match result {
      Ok(ok) => {
        repaired += 1;
        items.push(RepairBatchItem {
          session_id: entry.session_id.clone(),
          agent: Some(ok.agent),
          ok: true,
          repaired_session_id: Some(ok.repaired_session_id),
          repaired_file_path: Some(ok.repaired_file_path),
          method: Some(ok.method),
          turns_written: Some(ok.turns_written),
          error: None,
        });
      }
      Err(error) => {
        failed += 1;
        items.push(RepairBatchItem {
          session_id: entry.session_id.clone(),
          agent: Some(entry.agent),
          ok: false,
          repaired_session_id: None,
          repaired_file_path: None,
          method: None,
          turns_written: None,
          error: Some(error),
        });
      }
    }
  }

  Ok(RepairBatchResult {
    total: items.len(),
    repaired,
    failed,
    skipped,
    items,
  })
}

fn locate(session_id: &str) -> Result<(Agent, PathBuf), String> {
  find_session(session_id).ok_or_else(|| format!("Session not found: {session_id}"))
}

fn write_same_agent(agent: Agent, source: &UnifiedSession, cwd: &str) -> Result<WriteResult, String> {
  match agent {
    Agent::Claude => write_claude_session(source, cwd),
    Agent::Codex => write_codex_session(source, cwd),
  }
}

fn build_archive_metadata(agent: Agent, path: &Path) -> Result<ArchivedSession, String> {
  let parsed = load_session_file(path, agent);
  let entry = index_session_file(path, agent);
  let session_id = parsed
    .as_ref()
    .ok()
    .map(|s| s.meta.session_id.clone())
    .or_else(|| entry.as_ref().map(|s| s.session_id.clone()))
    .or_else(|| session_id_for(path))
    .unwrap_or_else(|| Uuid::new_v4().to_string());
  let archive_path = build_archive_path(agent, path)?;
  Ok(ArchivedSession {
    archive_id: format!("{}-{}", agent.as_str(), session_id),
    agent,
    session_id,
    original_path: path.to_string_lossy().to_string(),
    archive_path: archive_path.to_string_lossy().to_string(),
    archived_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    cwd: parsed.as_ref().ok().and_then(|s| s.meta.cwd.clone()).or_else(|| entry.as_ref().and_then(|s| s.cwd.clone())),
    title: parsed.as_ref().ok().and_then(|s| s.meta.title.clone()).or_else(|| entry.as_ref().and_then(|s| s.title.clone())),
    parse_error: parsed.err().or_else(|| entry.and_then(|s| s.parse_error)),
  })
}

fn build_archive_path(agent: Agent, path: &Path) -> Result<PathBuf, String> {
  let root = archive_root();
  let now = Utc::now();
  let session_id = session_id_for(path).unwrap_or_else(|| Uuid::new_v4().to_string());
  let file_name = format!("{}-{}.jsonl", agent.as_str(), session_id);
  let mut dst = root
    .join(agent.as_str())
    .join(now.year().to_string())
    .join(format!("{:02}", now.month()))
    .join(file_name);
  let mut n = 1;
  while dst.exists() || metadata_path_for(&dst).exists() {
    let file_name = format!("{}-{}-{n}.jsonl", agent.as_str(), session_id);
    dst = root
      .join(agent.as_str())
      .join(now.year().to_string())
      .join(format!("{:02}", now.month()))
      .join(file_name);
    n += 1;
  }
  Ok(dst)
}

fn metadata_path_for(archive_path: &Path) -> PathBuf {
  archive_path.with_extension("json")
}

fn session_id_for(path: &Path) -> Option<String> {
  extract_uuid(path.file_name().and_then(|s| s.to_str()).unwrap_or_default())
    .or_else(|| extract_uuid(&path.to_string_lossy()))
}

fn move_file(src: &Path, dst: &Path) -> Result<(), String> {
  match fs::rename(src, dst) {
    Ok(_) => Ok(()),
    Err(_) => {
      fs::copy(src, dst).map_err(|e| e.to_string())?;
      fs::remove_file(src).map_err(|e| e.to_string())
    }
  }
}

fn recover_raw_session(path: &Path, agent: Agent, parse_error: &str) -> Result<UnifiedSession, String> {
  let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
  let mut turns = Vec::new();
  let mut cwd = None;
  let mut model = None;
  let mut created_at = None;
  let mut updated_at = None;
  let mut title = None;
  for (idx, line) in raw.lines().enumerate() {
    let trimmed = line.trim();
    if trimmed.is_empty() {
      continue;
    }
    let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
      continue;
    };
    fill_meta_from_value(&value, &mut cwd, &mut model, &mut created_at, &mut updated_at);
    let role = recover_role(&value).unwrap_or(Role::User);
    for text in recover_texts(&value) {
      let clean = text.trim();
      if clean.is_empty() {
        continue;
      }
      if title.is_none() && role == Role::User {
        title = Some(clean.chars().take(72).collect());
      }
      turns.push(Turn {
        id: format!("repair-{idx}-{}", turns.len()),
        role: role.clone(),
        blocks: vec![Block::Text { text: clean.to_string() }],
        timestamp: value.get("timestamp").and_then(Value::as_str).map(str::to_string),
      });
    }
  }
  if turns.is_empty() {
    return Err(format!("Session is unreadable and no text could be recovered: {parse_error}"));
  }
  let session_id = session_id_for(path).unwrap_or_else(|| Uuid::new_v4().to_string());
  Ok(UnifiedSession {
    meta: SessionMeta {
      agent,
      session_id,
      file_path: path.to_string_lossy().to_string(),
      cwd,
      model,
      cli_version: None,
      title,
      created_at,
      updated_at,
      turn_count: Some(turns.len()),
      git_branch: None,
      is_sidechain: None,
      subagents: None,
      parse_error: Some(parse_error.to_string()),
      archived: None,
    },
    turns,
  })
}

fn fill_meta_from_value(value: &Value, cwd: &mut Option<String>, model: &mut Option<String>, created_at: &mut Option<String>, updated_at: &mut Option<String>) {
  if cwd.is_none() {
    *cwd = value.pointer("/cwd").or_else(|| value.pointer("/payload/cwd")).and_then(Value::as_str).map(str::to_string);
  }
  if model.is_none() {
    *model = value.pointer("/message/model").or_else(|| value.pointer("/payload/model")).and_then(Value::as_str).map(str::to_string);
  }
  let ts = value.get("timestamp").and_then(Value::as_str).map(str::to_string);
  if created_at.is_none() {
    *created_at = ts.clone();
  }
  if ts.is_some() {
    *updated_at = ts;
  }
}

fn recover_role(value: &Value) -> Option<Role> {
  let role = value
    .pointer("/message/role")
    .or_else(|| value.pointer("/payload/role"))
    .or_else(|| value.pointer("/payload/role"))
    .or_else(|| value.pointer("/type"))
    .and_then(Value::as_str)?;
  match role {
    "assistant" => Some(Role::Assistant),
    "system" | "developer" => Some(Role::System),
    "tool" => Some(Role::Tool),
    _ => Some(Role::User),
  }
}

fn recover_texts(value: &Value) -> Vec<String> {
  let mut out = Vec::new();
  collect_text(value.pointer("/message/content"), &mut out);
  collect_text(value.pointer("/payload/content"), &mut out);
  collect_text(value.pointer("/payload/message"), &mut out);
  collect_text(value.pointer("/payload/summary"), &mut out);
  out
}

fn collect_text(value: Option<&Value>, out: &mut Vec<String>) {
  let Some(value) = value else { return };
  match value {
    Value::String(text) => out.push(text.clone()),
    Value::Array(items) => {
      for item in items {
        collect_text(Some(item), out);
      }
    }
    Value::Object(map) => {
      if let Some(text) = map.get("text").or_else(|| map.get("content")).or_else(|| map.get("summary")).and_then(Value::as_str) {
        out.push(text.to_string());
      }
      for key in ["content", "summary"] {
        collect_text(map.get(key), out);
      }
    }
    _ => {}
  }
}
