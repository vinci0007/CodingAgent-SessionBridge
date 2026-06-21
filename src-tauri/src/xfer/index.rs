use crate::xfer::claude_parse::parse_claude_session;
use crate::xfer::codex_parse::parse_codex_session;
use crate::xfer::model::{Agent, SessionIndexEntry, UnifiedSession};
use crate::xfer::paths::{claude_project_dirs, codex_session_dirs, encode_claude_project_dir, extract_uuid, normalize_cwd, walk_jsonl};
use serde::Deserialize;
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListOptions {
  pub cwd: Option<String>,
  pub agent: Option<Agent>,
  pub limit: Option<usize>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceStatus {
  pub available: bool,
  pub count: usize,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct IndexStatus {
  pub claude: SourceStatus,
  pub codex: SourceStatus,
}

/// Walk a list of dirs, returning jsonl files (deduped by path), capturing any error.
fn scan_dirs(dirs: &[PathBuf]) -> (Vec<PathBuf>, Option<String>) {
  let mut seen = HashSet::new();
  let mut files = Vec::new();
  let mut error: Option<String> = None;
  for dir in dirs {
    if !dir.exists() {
      continue;
    }
    match std::fs::metadata(dir) {
      Ok(_) => {}
      Err(e) => {
        error = Some(e.to_string());
        continue;
      }
    }
    for f in walk_jsonl(dir) {
      if seen.insert(f.clone()) {
        files.push(f);
      }
    }
  }
  (files, error)
}

pub fn list_sessions(opts: ListOptions) -> Vec<SessionIndexEntry> {
  let mut entries = Vec::new();
  let per_agent_limit = opts.limit.map(|limit| limit.saturating_mul(3).max(limit));

  if opts.agent != Some(Agent::Codex) {
    let claude_dirs: Vec<PathBuf> = if let Some(cwd) = &opts.cwd {
      claude_project_dirs().into_iter().map(|base| base.join(encode_claude_project_dir(cwd))).collect()
    } else {
      claude_project_dirs()
    };
    let (files, _) = scan_dirs(&claude_dirs);
    for file in newest_files(files, per_agent_limit) {
      if let Some(entry) = index_one(&file, Agent::Claude) {
        entries.push(entry);
      }
    }
  }

  if opts.agent != Some(Agent::Claude) {
    let (files, _) = scan_dirs(&codex_session_dirs());
    for file in newest_files(files, per_agent_limit) {
      if let Some(entry) = index_one(&file, Agent::Codex) {
        entries.push(entry);
      }
    }
  }

  if let Some(cwd) = &opts.cwd {
    let target = normalize_cwd(cwd);
    entries.retain(|entry| entry.cwd.as_deref().map(normalize_cwd) == Some(target.clone()));
  }

  entries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
  if let Some(limit) = opts.limit {
    entries.truncate(limit);
  }
  entries
}

fn newest_files(mut files: Vec<PathBuf>, limit: Option<usize>) -> Vec<PathBuf> {
  files.sort_by(|a, b| file_mtime(b).cmp(&file_mtime(a)));
  if let Some(limit) = limit {
    files.truncate(limit);
  }
  files
}

fn file_mtime(path: &Path) -> std::time::SystemTime {
  std::fs::metadata(path)
    .and_then(|metadata| metadata.modified())
    .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
}

fn file_mtime_iso(path: &Path) -> String {
  let ts = file_mtime(path)
    .duration_since(UNIX_EPOCH)
    .unwrap_or_default()
    .as_millis();
  chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ts as i64)
    .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
    .unwrap_or_else(|| chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

/// Report per-agent reachability of session storage across all roots.
pub fn index_status() -> IndexStatus {
  IndexStatus {
    claude: status_for(&claude_project_dirs()),
    codex: status_for(&codex_session_dirs()),
  }
}

fn status_for(dirs: &[PathBuf]) -> SourceStatus {
  let mut count = 0usize;
  let mut available = false;
  let mut error: Option<String> = None;
  for dir in dirs {
    if !dir.exists() {
      continue;
    }
    available = true;
    match std::fs::metadata(dir) {
      Ok(_) => count += walk_jsonl(dir).len(),
      Err(e) => error = Some(e.to_string()),
    }
  }
  SourceStatus { available, count, error }
}

fn index_one(file: &Path, agent: Agent) -> Option<SessionIndexEntry> {
  match load_session_file(file, agent) {
    Ok(session) => {
      if session.turns.is_empty() {
        None
      } else if agent == Agent::Claude && session.meta.is_sidechain == Some(true) {
        None
      } else {
        Some(session.meta)
      }
    }
    Err(error) => broken_index_entry(file, agent, &error),
  }
}

pub fn index_session_file(file: &Path, agent: Agent) -> Option<SessionIndexEntry> {
  index_one(file, agent)
}

fn broken_index_entry(file: &Path, agent: Agent, error: &str) -> Option<SessionIndexEntry> {
  let session_id = extract_uuid(file.file_name().and_then(|s| s.to_str()).unwrap_or_default())
    .or_else(|| extract_uuid(&file.to_string_lossy()))
    .unwrap_or_else(|| file.file_stem().and_then(|s| s.to_str()).unwrap_or("unknown").to_string());
  Some(SessionIndexEntry {
    agent,
    session_id,
    file_path: file.to_string_lossy().to_string(),
    cwd: None,
    model: None,
    cli_version: None,
    title: Some("损坏/无法读取的会话".to_string()),
    created_at: None,
    updated_at: Some(file_mtime_iso(file)),
    turn_count: Some(0),
    git_branch: None,
    is_sidechain: None,
    subagents: None,
    parse_error: Some(error.to_string()),
    archived: None,
  })
}

pub fn find_session(session_id: &str) -> Option<(Agent, PathBuf)> {
  let (codex_files, _) = scan_dirs(&codex_session_dirs());
  for file in &codex_files {
    if file_name_contains(file, session_id) {
      return Some((Agent::Codex, file.clone()));
    }
  }
  for file in codex_files {
    if path_contains(&file, session_id) {
      return Some((Agent::Codex, file));
    }
  }
  let (claude_files, _) = scan_dirs(&claude_project_dirs());
  for file in &claude_files {
    if file.file_name().and_then(|s| s.to_str()) == Some(&format!("{session_id}.jsonl")) {
      return Some((Agent::Claude, file.clone()));
    }
  }
  for file in claude_files {
    if path_contains(&file, session_id) {
      return Some((Agent::Claude, file));
    }
  }
  None
}

fn file_name_contains(path: &Path, needle: &str) -> bool {
  path.file_name().and_then(|s| s.to_str()).map(|name| name.contains(needle)).unwrap_or(false)
}

fn path_contains(path: &Path, needle: &str) -> bool {
  path.to_string_lossy().contains(needle)
}

pub fn load_session(session_id: &str) -> Option<UnifiedSession> {
  let (agent, file) = find_session(session_id)?;
  load_session_file(&file, agent).ok()
}

pub fn load_session_file(file: &Path, agent: Agent) -> Result<UnifiedSession, String> {
  match agent {
    Agent::Claude => parse_claude_session(file),
    Agent::Codex => parse_codex_session(file),
  }
}
