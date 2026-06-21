use crate::xfer::db;
use crate::xfer::model::{Agent, SessionIndexEntry};
use crate::xfer::paths::{default_project_cwd, normalize_cwd as normalize_project_key, normalize_project_cwd};
use crate::xfer::settings::configured_state_path;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMapEntry {
  pub cwd: String,
  pub source_agent: Agent,
  pub source_session_id: String,
  pub target_agent: Agent,
  pub target_session_id: String,
  pub target_file_path: String,
  pub created_at: String,
  pub source_updated_at: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct SyncState {
  pub version: u8,
  pub mappings: Vec<SessionMapEntry>,
}

pub fn state_path(cwd: &str) -> PathBuf {
  configured_state_path(cwd).unwrap_or_else(|| PathBuf::from(cwd).join(".xfer").join("state.json"))
}

pub fn load_state(cwd: &str) -> SyncState {
  let file = state_path(cwd);
  let mut state = std::fs::read_to_string(file)
    .ok()
    .and_then(|raw| serde_json::from_str(&raw).ok())
    .unwrap_or(SyncState { version: 1, mappings: Vec::new() });
  if let Ok(mappings) = db::list_mappings(cwd) {
    state = merge_mappings(state, mappings);
  }
  state
}

pub fn save_state(state: &SyncState, cwd: &str) -> Result<(), String> {
  for mapping in &state.mappings {
    let _ = db::upsert_mapping(mapping);
  }
  let file = state_path(cwd);
  let dir = file.parent().ok_or_else(|| format!("invalid state path: {}", file.display()))?;
  std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
  let tmp = dir.join(format!(".state-{}-{}.tmp", std::process::id(), timestamp_millis()));
  std::fs::write(&tmp, serde_json::to_string_pretty(state).map_err(|e| e.to_string())? + "\n")
    .map_err(|e| e.to_string())?;
  std::fs::rename(tmp, file).map_err(|e| e.to_string())
}

fn merge_mappings(mut state: SyncState, mappings: Vec<SessionMapEntry>) -> SyncState {
  for entry in mappings {
    state = upsert_mapping(&state, entry);
  }
  state
}

pub fn find_mapping<'a>(
  state: &'a SyncState,
  source_agent: Agent,
  source_session_id: &str,
  target_agent: Agent,
) -> Option<&'a SessionMapEntry> {
  state.mappings.iter().find(|m| {
    m.source_agent == source_agent
      && m.source_session_id == source_session_id
      && m.target_agent == target_agent
  })
}

pub fn upsert_mapping(state: &SyncState, entry: SessionMapEntry) -> SyncState {
  let entry_cwd = normalize_project_key(&entry.cwd);
  let mut next: Vec<SessionMapEntry> = state
    .mappings
    .iter()
    .cloned()
    .filter(|m| {
      !(normalize_project_key(&m.cwd) == entry_cwd
        && m.source_agent == entry.source_agent
        && m.source_session_id == entry.source_session_id
        && m.target_agent == entry.target_agent)
    })
    .collect();
  next.push(entry);
  next.sort_by(|a, b| b.created_at.cmp(&a.created_at));
  SyncState { version: 1, mappings: next }
}

pub fn latest_for_cwd(
  sessions: &[SessionIndexEntry],
  cwd: &str,
  agent: Agent,
) -> Option<SessionIndexEntry> {
  let target = normalize_cwd(cwd);
  sessions
    .iter()
    .filter(|s| s.agent == agent)
    .filter(|s| s.cwd.as_deref().map(normalize_cwd) == Some(target.clone()))
    .cloned()
    .max_by(|a, b| a.updated_at.cmp(&b.updated_at))
}

pub fn other_agent(agent: Agent) -> Agent {
  agent.other()
}

pub fn resume_command(agent: Agent, session_id: &str) -> String {
  match agent {
    Agent::Claude => format!("claude --resume {session_id}"),
    Agent::Codex => format!("codex resume {session_id}"),
  }
}

pub fn default_cwd(cwd: Option<&str>) -> String {
  default_project_cwd(cwd)
}

fn normalize_cwd(p: &str) -> String {
  normalize_project_cwd(p).replace(['\\', '/'], "/").trim_end_matches('/').to_lowercase()
}

fn timestamp_millis() -> u128 {
  use std::time::{SystemTime, UNIX_EPOCH};
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis())
    .unwrap_or(0)
}
