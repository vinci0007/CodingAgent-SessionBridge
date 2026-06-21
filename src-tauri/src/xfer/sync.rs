use crate::xfer::index::{list_sessions, load_session};
use crate::xfer::migrate::{migrate, MigrateOptions, MigrateResult};
use crate::xfer::model::Agent;
use crate::xfer::write::ModelMapping;
use crate::xfer::db;
use crate::xfer::sync_state::{
  default_cwd, find_mapping, latest_for_cwd, load_state, other_agent, resume_command, save_state,
  state_path, upsert_mapping, SessionMapEntry,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchOptions {
  pub to: Agent,
  pub cwd: Option<String>,
  pub from: Option<Agent>,
  pub source_session_id: Option<String>,
  pub mode: Option<String>,
  pub force: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchResult {
  pub reused: bool,
  pub source_agent: Agent,
  pub source_session_id: String,
  pub target_agent: Agent,
  pub target_session_id: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub target_file_path: Option<String>,
  pub resume_command: String,
  pub state_path: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub model_mapping: Option<ModelMapping>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub note: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncMappingsOptions {
  pub cwds: Option<Vec<String>>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoMigrationOptions {
  pub cwd: Option<String>,
  pub source_session_id: Option<String>,
  pub target_session_id: Option<String>,
  pub remove_target_file: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoMigrationResult {
  pub removed_mapping: bool,
  pub removed_target_file: bool,
  pub source_agent: Agent,
  pub source_session_id: String,
  pub target_agent: Agent,
  pub target_session_id: String,
  pub target_file_path: String,
  pub state_path: String,
  pub desktop_index_removal: serde_json::Value,
}

pub fn switch_session(opts: SwitchOptions) -> Result<SwitchResult, String> {
  let cwd = default_cwd(opts.cwd.as_deref());
  let target_agent = opts.to;

  // Resolve the source: a user-chosen session if provided, else the latest for
  // this project on the opposite agent. Either way the result is project-indexed.
  let (source_agent, source_session_id, source_updated_at): (Agent, String, Option<String>) =
    if let Some(sid) = &opts.source_session_id {
      let chosen = load_session(sid).ok_or_else(|| format!("Session not found: {sid}"))?;
      if chosen.meta.agent == target_agent {
        return Err("Source session is already on the target agent".to_string());
      }
      (chosen.meta.agent, chosen.meta.session_id.clone(), chosen.meta.updated_at.clone())
    } else {
      let source_agent = opts.from.unwrap_or_else(|| other_agent(target_agent));
      if source_agent == target_agent {
        return Err("--from and --to must be different agents".to_string());
      }
      let latest = latest_for_cwd(&list_sessions(crate::xfer::index::ListOptions { cwd: Some(cwd.clone()), agent: Some(source_agent), limit: Some(1) }), &cwd, source_agent)
        .ok_or_else(|| format!("No {} session found for cwd: {cwd}", source_agent.as_str()))?;
      (latest.agent, latest.session_id.clone(), latest.updated_at.clone())
    };

  let state = load_state(&cwd);
  if let Some(existing) = find_mapping(&state, source_agent, &source_session_id, target_agent) {
    if opts.force != Some(true) && mapping_target_is_usable(&existing.target_file_path, &existing.target_session_id, target_agent) {
      return Ok(SwitchResult {
        reused: true,
        source_agent,
        source_session_id: source_session_id.clone(),
        target_agent,
        target_session_id: existing.target_session_id.clone(),
        target_file_path: Some(existing.target_file_path.clone()),
        resume_command: resume_command(target_agent, &existing.target_session_id),
        state_path: state_path(&cwd).to_string_lossy().to_string(),
        model_mapping: None,
        note: (target_agent == Agent::Claude).then_some("Run from the same cwd for Claude resume.".to_string()),
      });
    }
  }

  let result = migrate(MigrateOptions {
    session_id: source_session_id.clone(),
    to: target_agent,
    mode: opts.mode,
    cwd: Some(cwd.clone()),
  })?;

  let next_state = upsert_mapping(&state, SessionMapEntry {
    cwd: cwd.clone(),
    source_agent,
    source_session_id: source_session_id.clone(),
    target_agent,
    target_session_id: result.session_id.clone(),
    target_file_path: result.file_path.clone(),
    created_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    source_updated_at,
  });
  save_state(&next_state, &cwd)?;
  Ok(to_switch_result(source_agent, &source_session_id, result, &cwd))
}

fn mapping_target_is_usable(file_path: &str, session_id: &str, target_agent: Agent) -> bool {
  let path = std::path::Path::new(file_path);
  if !path.is_file() {
    return false;
  }
  load_session(session_id)
    .map(|session| session.meta.agent == target_agent)
    .unwrap_or(false)
}

fn to_switch_result(source_agent: Agent, source_session_id: &str, result: MigrateResult, cwd: &str) -> SwitchResult {
  SwitchResult {
    reused: false,
    source_agent,
    source_session_id: source_session_id.to_string(),
    target_agent: result.to,
    target_session_id: result.session_id.clone(),
    target_file_path: Some(result.file_path),
    resume_command: result.resume_command,
    state_path: state_path(cwd).to_string_lossy().to_string(),
    model_mapping: Some(result.model_mapping),
    note: (result.to == Agent::Claude).then_some("Run from the same cwd for Claude resume.".to_string()),
  }
}

pub fn sync_mappings(opts: SyncMappingsOptions) -> Vec<SessionMapEntry> {
  let mut seen = HashSet::new();
  let mut cwds = opts.cwds.unwrap_or_default();
  if cwds.is_empty() {
    cwds = list_sessions(crate::xfer::index::ListOptions {
      cwd: None,
      agent: None,
      limit: Some(1000),
    })
    .into_iter()
    .filter_map(|s| s.cwd)
    .collect();
  }

  let mut result = Vec::new();
  for cwd in cwds {
    let project_cwd = default_cwd(Some(&cwd));
    if !seen.insert(project_cwd.clone()) {
      continue;
    }
    result.extend(load_state(&project_cwd).mappings);
  }
  result.sort_by(|a, b| b.created_at.cmp(&a.created_at));
  result
}

pub fn undo_migration(opts: UndoMigrationOptions) -> Result<UndoMigrationResult, String> {
  if opts.source_session_id.is_none() && opts.target_session_id.is_none() {
    return Err("sourceSessionId or targetSessionId is required".to_string());
  }

  if let Some(mapping) = db::find_active_mapping(opts.source_session_id.as_deref(), opts.target_session_id.as_deref())? {
    return undo_mapping(mapping, opts.remove_target_file);
  }

  let mut cwds = Vec::new();
  if let Some(cwd) = opts.cwd.as_deref() {
    cwds.push(default_cwd(Some(cwd)));
  } else {
    let mut seen = HashSet::new();
    for session in list_sessions(crate::xfer::index::ListOptions {
      cwd: None,
      agent: None,
      limit: Some(1000),
    }) {
      if let Some(cwd) = session.cwd {
        let cwd = default_cwd(Some(&cwd));
        if seen.insert(cwd.clone()) {
          cwds.push(cwd);
        }
      }
    }
  }

  for cwd in cwds {
    let state = load_state(&cwd);
    let pos = state.mappings.iter().position(|mapping| {
      opts
        .source_session_id
        .as_deref()
        .map(|id| id == mapping.source_session_id)
        .unwrap_or(false)
        || opts
          .target_session_id
          .as_deref()
          .map(|id| id == mapping.target_session_id)
          .unwrap_or(false)
    });

    if let Some(index) = pos {
      let mut next = state.clone();
      let mapping = next.mappings.remove(index);
      save_state(&next, &cwd)?;
      return undo_mapping(mapping, opts.remove_target_file);
    }
  }

  Err("Migration mapping not found".to_string())
}

fn undo_mapping(mapping: SessionMapEntry, remove_target_file: Option<bool>) -> Result<UndoMigrationResult, String> {
  let cwd = mapping.cwd.clone();
  let mut state = load_state(&cwd);
  let before = state.mappings.len();
  state.mappings.retain(|entry| {
    !(entry.source_session_id == mapping.source_session_id
      && entry.target_session_id == mapping.target_session_id)
  });
  if state.mappings.len() != before {
    save_state(&state, &cwd)?;
  }

  let undone_at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
  let db_removed = db::mark_mapping_undone(
    &cwd,
    Some(&mapping.source_session_id),
    Some(&mapping.target_session_id),
    &undone_at,
  ).unwrap_or(false);

  let mut removed_target_file = false;
  if remove_target_file != Some(false) {
    let target_path = Path::new(&mapping.target_file_path);
    if target_path.is_file() {
      std::fs::remove_file(target_path)
        .map_err(|e| format!("failed to remove target session file: {e}"))?;
      removed_target_file = true;
    }
  }
  let desktop_index_removal = crate::xfer::write::remove_target_desktop_index(mapping.target_agent, &mapping.target_session_id)
    .unwrap_or_else(|error| serde_json::json!({ "error": error }));

  Ok(UndoMigrationResult {
    removed_mapping: db_removed || state.mappings.len() != before,
    removed_target_file,
    source_agent: mapping.source_agent,
    source_session_id: mapping.source_session_id,
    target_agent: mapping.target_agent,
    target_session_id: mapping.target_session_id,
    target_file_path: mapping.target_file_path,
    state_path: state_path(&cwd).to_string_lossy().to_string(),
    desktop_index_removal,
  })
}

pub fn sync_status(cwd: Option<&str>) -> String {
  let project_cwd = default_cwd(cwd);
  let sessions = list_sessions(crate::xfer::index::ListOptions {
    cwd: Some(project_cwd.clone()),
    agent: None,
    limit: Some(20),
  });
  let state = load_state(&project_cwd);
  let mut lines = Vec::new();
  lines.push(format!("Project: {project_cwd}"));
  lines.push(format!("State:   {}", state_path(&project_cwd).display()));
  lines.push(format!("Database: {}", crate::xfer::db::path().display()));
  lines.push("".to_string());
  lines.push("Latest sessions:".to_string());
  for agent in [Agent::Claude, Agent::Codex] {
    let latest = latest_for_cwd(&sessions, &project_cwd, agent);
    let value = latest
      .map(|s| format!("{} ({} turns, {})", s.session_id, s.turn_count.unwrap_or(0), s.updated_at.unwrap_or_else(|| "?".to_string())))
      .unwrap_or_else(|| "none".to_string());
    lines.push(format!("  {}: {value}", agent.as_str()));
  }
  lines.push("".to_string());
  lines.push("Mappings:".to_string());
  if state.mappings.is_empty() {
    lines.push("  none".to_string());
  }
  for m in state.mappings {
    lines.push(format!(
      "  {}:{} → {}:{}  {}",
      m.source_agent.as_str(),
      short(&m.source_session_id),
      m.target_agent.as_str(),
      short(&m.target_session_id),
      m.created_at
    ));
  }
  lines.join("\n")
}

fn short(s: &str) -> &str {
  s.get(..8).unwrap_or(s)
}
