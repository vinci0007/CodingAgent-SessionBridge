use crate::xfer::model::{Agent, Block, Role, Turn, UnifiedSession};
use chrono::{Datelike, Utc};
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;
use uuid::Uuid;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
  pub session_id: String,
  pub file_path: String,
  pub model_mapping: ModelMapping,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelMapping {
  pub source_model: Option<String>,
  pub target_model: String,
  pub changed: bool,
  pub reason: String,
}

pub fn migration_banner(src: &UnifiedSession, to: Agent) -> String {
  format!(
    "[Session migrated from {} to {} by xfer]\nOriginal session: {}\nThe full prior conversation has been imported below. Continue the task.",
    src.meta.agent.as_str(),
    to.as_str(),
    src.meta.session_id
  )
}

pub fn write_claude_session(src: &UnifiedSession, cwd: &str) -> Result<WriteResult, String> {
  let session_id = Uuid::new_v4().to_string();
  let model_mapping = resolve_target_model(Agent::Claude, src.meta.model.as_deref());
  let cwd = crate::xfer::paths::normalize_project_cwd(cwd);
  let dir = crate::xfer::paths::claude_projects_dir().join(crate::xfer::paths::encode_claude_project_dir(&cwd));
  fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  let file_path = dir.join(format!("{session_id}.jsonl"));
  let ts = now_iso();
  let mut prev_uuid: Option<String> = None;
  let mut records = Vec::new();

  for turn in &src.turns {
    let content = turn_to_claude_content(turn);
    let Some(content) = content else { continue };
    let role = if turn.role == Role::Assistant { "assistant" } else { "user" };
    let uuid = Uuid::new_v4().to_string();
    let message = if role == "assistant" {
      json!({ "role": role, "model": model_mapping.target_model.as_str(), "content": content })
    } else {
      json!({ "role": role, "content": content })
    };
    records.push(json!({
      "parentUuid": prev_uuid,
      "isSidechain": false,
      "type": role,
      "message": message,
      "uuid": uuid,
      "timestamp": ts,
      "cwd": cwd.as_str(),
      "sessionId": session_id,
    }).to_string());
    prev_uuid = Some(uuid);
  }

  write_jsonl(&file_path, &records)?;
  let title = session_title(src);
  let _ = register_claude_desktop_code_session(&session_id, &cwd, src, &title, &model_mapping.target_model);
  Ok(WriteResult { session_id, file_path: file_path.to_string_lossy().to_string(), model_mapping })
}

fn register_claude_desktop_code_session(
  cli_session_id: &str,
  cwd: &str,
  src: &UnifiedSession,
  title: &str,
  target_model: &str,
) -> Result<(), String> {
  let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).ok_or_else(|| "LOCALAPPDATA is not set".to_string())?;
  let candidates = [local.join("Claude-3p").join("claude-code-sessions"), local.join("Claude").join("claude-code-sessions")];
  let root = candidates.into_iter().find(|p| p.is_dir()).ok_or_else(|| "Claude Desktop code sessions directory not found".to_string())?;
  let workspace = find_claude_desktop_workspace(&root).ok_or_else(|| "Claude Desktop workspace directory not found".to_string())?;
  let local_id = format!("local_{}", Uuid::new_v4());
  let now_ms = Utc::now().timestamp_millis();
  let completed_turns = src.turns.iter().filter(|turn| matches!(turn.role, Role::Assistant)).count();
  let value = json!({
    "sessionId": local_id,
    "cliSessionId": cli_session_id,
    "cwd": cwd,
    "originCwd": cwd,
    "lastFocusedAt": now_ms,
    "createdAt": now_ms,
    "lastActivityAt": now_ms,
    "model": target_model,
    "isArchived": false,
    "title": title,
    "titleSource": "xfer",
    "permissionMode": "acceptEdits",
    "remoteMcpServersConfig": [],
    "completedTurns": completed_turns,
    "alwaysAllowedReasons": [],
    "sessionPermissionUpdates": [],
    "classifierSummaryEnabled": false
  });
  let file = workspace.join(format!("{local_id}.json"));
  fs::write(file, value.to_string()).map_err(|e| format!("failed to register Claude Desktop code session: {e}"))
}

fn find_claude_desktop_workspace(root: &Path) -> Option<PathBuf> {
  let mut workspaces = Vec::new();
  for account in fs::read_dir(root).ok()?.filter_map(Result::ok).filter(|e| e.path().is_dir()) {
    for workspace in fs::read_dir(account.path()).ok()?.filter_map(Result::ok).filter(|e| e.path().is_dir()) {
      let count = fs::read_dir(workspace.path()).ok().map(|items| items.filter_map(Result::ok).filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("json")).count()).unwrap_or(0);
      workspaces.push((count, workspace.path()));
    }
  }
  workspaces.sort_by(|a, b| b.0.cmp(&a.0));
  workspaces.into_iter().map(|(_, path)| path).next()
}

fn turn_to_claude_content(turn: &Turn) -> Option<Value> {
  let mut out = Vec::new();
  for block in &turn.blocks {
    match block {
      Block::Text { text } => out.push(json!({ "type": "text", "text": text })),
      Block::Thinking { text, encrypted } => {
        if encrypted == &Some(true) {
          out.push(json!({ "type": "text", "text": format!("(prior reasoning) {text}") }));
        } else {
          out.push(json!({ "type": "thinking", "thinking": text }));
        }
      }
      Block::ToolCall { id, name, input } => out.push(json!({
        "type": "tool_use",
        "id": if id.is_empty() { format!("toolu_{}", Uuid::new_v4().to_string().replace('-', "").chars().take(24).collect::<String>()) } else { id.clone() },
        "name": name,
        "input": input,
      })),
      Block::ToolResult { call_id, output, is_error } => {
        let mut value = json!({ "type": "tool_result", "tool_use_id": call_id, "content": output });
        if is_error == &Some(true) {
          value["is_error"] = Value::Bool(true);
        }
        out.push(value);
      }
    }
  }
  (!out.is_empty()).then_some(Value::Array(out))
}

pub fn write_codex_session(src: &UnifiedSession, cwd: &str) -> Result<WriteResult, String> {
  let session_id = Uuid::new_v4().to_string();
  let model_mapping = resolve_target_model(Agent::Codex, src.meta.model.as_deref());
  let cwd = crate::xfer::paths::normalize_project_cwd(cwd);
  let now = Utc::now();
  let dir = crate::xfer::paths::codex_sessions_dir()
    .join(now.year().to_string())
    .join(format!("{:02}", now.month()))
    .join(format!("{:02}", now.day()));
  fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  let stamp = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true).replace([':', '.'], "-").trim_end_matches('Z').to_string();
  let file_path = dir.join(format!("rollout-{stamp}-{session_id}.jsonl"));
  let ts = now_iso();
  let mut records = Vec::new();
  let title = session_title(src);
  let preview = first_user_text(src).unwrap_or_else(|| title.clone());
  let model = model_mapping.target_model.clone();

  records.push(json!({
    "timestamp": ts,
    "type": "session_meta",
      "payload": {
        "id": session_id,
        "timestamp": ts,
        "cwd": cwd.as_str(),
      "originator": "xfer",
      "cli_version": "xfer-migrated",
      "source": "vscode",
      "model_provider": "custom",
      "model": model
    }
  }).to_string());

  records.push(json!({
    "timestamp": ts,
    "type": "turn_context",
    "payload": {
      "cwd": cwd.as_str(),
      "model": model,
      "approval_policy": "on-request",
      "sandbox_policy": "workspace-write"
    }
  }).to_string());

  if let Some(text) = first_user_text(src) {
    records.push(json!({
      "timestamp": ts,
      "type": "event_msg",
      "payload": { "type": "user_message", "message": text }
    }).to_string());
  }

  for turn in &src.turns {
    for block in &turn.blocks {
      match block {
        Block::Text { text } => {
          let role = match turn.role {
            Role::Assistant => "assistant",
            Role::System => "developer",
            _ => "user",
          };
          let ctype = if role == "assistant" { "output_text" } else { "input_text" };
          push_item(&mut records, &ts, json!({ "type": "message", "role": role, "content": [{ "type": ctype, "text": text }] }));
        }
        Block::Thinking { text, .. } => push_item(&mut records, &ts, json!({ "type": "reasoning", "summary": [{ "type": "summary_text", "text": text }] })),
        Block::ToolCall { id, name, input } => push_item(&mut records, &ts, json!({
          "type": "function_call",
          "name": name,
          "arguments": if input.is_string() { input.as_str().unwrap_or_default().to_string() } else { input.to_string() },
          "call_id": if id.is_empty() { format!("call_{}", Uuid::new_v4().to_string().replace('-', "").chars().take(22).collect::<String>()) } else { id.clone() }
        })),
        Block::ToolResult { call_id, output, .. } => push_item(&mut records, &ts, json!({ "type": "function_call_output", "call_id": call_id, "output": output })),
      }
    }
  }

  write_jsonl(&file_path, &records)?;
  register_codex_desktop_thread(&session_id, &file_path, &cwd, &title, &preview, &model, &ts)?;
  Ok(WriteResult { session_id, file_path: file_path.to_string_lossy().to_string(), model_mapping })
}

pub fn verify_codex_desktop_index(session_id: &str) -> Result<Value, String> {
  let root = crate::xfer::paths::codex_home();
  let db = root.join("state_5.sqlite");
  let index = root.join("session_index.jsonl");
  let mut sqlite_ok = false;
  let mut rollout_path = String::new();
  let mut archived = None::<i64>;
  if db.is_file() {
    let conn = Connection::open(&db).map_err(|e| e.to_string())?;
    conn.busy_timeout(Duration::from_secs(5)).map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("select rollout_path, archived from threads where id = ?1").map_err(|e| e.to_string())?;
    let row = stmt.query_row(params![session_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))).ok();
    if let Some((path, value)) = row {
      sqlite_ok = Path::new(&path).is_file();
      rollout_path = path;
      archived = Some(value);
    }
  }
  let mut session_index_ok = false;
  if let Ok(raw) = fs::read_to_string(&index) {
    session_index_ok = raw.lines().rev().take(200).any(|line| line.contains(session_id));
  }
  Ok(json!({
    "ok": sqlite_ok && session_index_ok && archived.unwrap_or(1) == 0,
    "sqliteOk": sqlite_ok,
    "sessionIndexOk": session_index_ok,
    "archived": archived,
    "rolloutPath": rollout_path,
    "stateDb": db.to_string_lossy().to_string(),
    "sessionIndex": index.to_string_lossy().to_string()
  }))
}

pub fn verify_claude_desktop_index(session_id: &str) -> Result<Value, String> {
  let matches = find_claude_desktop_index_files(session_id);
  Ok(json!({
    "ok": !matches.is_empty(),
    "count": matches.len(),
    "files": matches.iter().map(|p| p.to_string_lossy().to_string()).collect::<Vec<_>>()
  }))
}

pub fn remove_target_desktop_index(agent: Agent, session_id: &str) -> Result<Value, String> {
  match agent {
    Agent::Claude => remove_claude_desktop_index(session_id),
    Agent::Codex => remove_codex_desktop_index(session_id),
  }
}

fn find_claude_desktop_index_files(session_id: &str) -> Vec<PathBuf> {
  let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) else { return Vec::new() };
  let roots = [local.join("Claude-3p").join("claude-code-sessions"), local.join("Claude").join("claude-code-sessions")];
  let mut out = Vec::new();
  for root in roots.into_iter().filter(|p| p.is_dir()) {
    for entry in walkdir::WalkDir::new(root).into_iter().filter_map(Result::ok).filter(|e| e.file_type().is_file()) {
      if entry.path().extension().and_then(|s| s.to_str()) != Some("json") {
        continue;
      }
      if fs::read_to_string(entry.path()).map(|raw| raw.contains(session_id)).unwrap_or(false) {
        out.push(entry.path().to_path_buf());
      }
    }
  }
  out
}

fn remove_claude_desktop_index(session_id: &str) -> Result<Value, String> {
  let files = find_claude_desktop_index_files(session_id);
  let mut removed = Vec::new();
  for file in &files {
    if fs::remove_file(file).is_ok() {
      removed.push(file.to_string_lossy().to_string());
    }
  }
  Ok(json!({ "removed": removed.len(), "files": removed }))
}

fn remove_codex_desktop_index(session_id: &str) -> Result<Value, String> {
  let root = crate::xfer::paths::codex_home();
  let db = root.join("state_5.sqlite");
  let mut sqlite_removed = false;
  if db.is_file() {
    let conn = Connection::open(&db).map_err(|e| e.to_string())?;
    conn.busy_timeout(Duration::from_secs(5)).map_err(|e| e.to_string())?;
    let changed = conn.execute("delete from threads where id = ?1", params![session_id]).map_err(|e| e.to_string())?;
    sqlite_removed = changed > 0;
  }
  let index = root.join("session_index.jsonl");
  let mut session_index_removed = 0usize;
  if let Ok(raw) = fs::read_to_string(&index) {
    let kept = raw.lines().filter(|line| !line.contains(session_id)).collect::<Vec<_>>();
    session_index_removed = raw.lines().count().saturating_sub(kept.len());
    if session_index_removed > 0 {
      fs::write(&index, kept.join("\n") + "\n").map_err(|e| e.to_string())?;
    }
  }
  Ok(json!({ "sqliteRemoved": sqlite_removed, "sessionIndexRemoved": session_index_removed }))
}

fn session_title(src: &UnifiedSession) -> String {
  src
    .meta
    .title
    .clone()
    .or_else(|| first_user_text(src).map(|s| s.chars().take(72).collect()))
    .unwrap_or_else(|| format!("Migrated {} session", src.meta.agent.as_str()))
}

fn first_user_text(src: &UnifiedSession) -> Option<String> {
  src.turns.iter().find_map(|turn| {
    if turn.role != Role::User {
      return None;
    }
    turn.blocks.iter().find_map(|block| match block {
      Block::Text { text } => {
        let text = text.trim();
        (!text.is_empty()).then(|| text.chars().take(240).collect())
      }
      _ => None,
    })
  })
}

fn register_codex_desktop_thread(
  session_id: &str,
  rollout_path: &Path,
  cwd: &str,
  title: &str,
  preview: &str,
  model: &str,
  ts: &str,
) -> Result<(), String> {
  let root = crate::xfer::paths::codex_home();
  append_codex_session_index(&root, session_id, title, ts)?;
  upsert_codex_thread(&root, session_id, rollout_path, cwd, title, preview, model)
}

fn append_codex_session_index(root: &Path, session_id: &str, title: &str, ts: &str) -> Result<(), String> {
  fs::create_dir_all(root).map_err(|e| e.to_string())?;
  let file = root.join("session_index.jsonl");
  let line = json!({ "id": session_id, "thread_name": title, "updated_at": ts }).to_string();
  let mut out = OpenOptions::new().create(true).append(true).open(file).map_err(|e| e.to_string())?;
  writeln!(out, "{line}").map_err(|e| e.to_string())
}

fn upsert_codex_thread(
  root: &Path,
  session_id: &str,
  rollout_path: &Path,
  cwd: &str,
  title: &str,
  preview: &str,
  model: &str,
) -> Result<(), String> {
  let db = root.join("state_5.sqlite");
  if !db.is_file() {
    return Ok(());
  }
  let conn = Connection::open(db).map_err(|e| e.to_string())?;
  conn.busy_timeout(Duration::from_secs(5)).map_err(|e| e.to_string())?;
  let seconds = Utc::now().timestamp();
  let millis = Utc::now().timestamp_millis();
  let rollout_path = rollout_path.to_string_lossy().to_string();
  let db_cwd = codex_db_cwd(cwd);
  conn.execute(
    r#"INSERT INTO threads (
      id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
      sandbox_policy, approval_mode, tokens_used, has_user_event, archived,
      cli_version, first_user_message, memory_mode, model, thread_source, preview,
      recency_at, created_at_ms, updated_at_ms, recency_at_ms
    ) VALUES (
      ?1, ?2, ?3, ?3, 'vscode', 'custom', ?4, ?5,
      'workspace-write', 'on-request', 0, 1, 0,
      'xfer-migrated', ?6, 'enabled', ?7, 'xfer', ?8,
      ?3, ?9, ?9, ?9
    ) ON CONFLICT(id) DO UPDATE SET
      rollout_path=excluded.rollout_path,
      updated_at=excluded.updated_at,
      updated_at_ms=excluded.updated_at_ms,
      recency_at=excluded.recency_at,
      recency_at_ms=excluded.recency_at_ms,
      cwd=excluded.cwd,
      title=excluded.title,
      first_user_message=excluded.first_user_message,
      preview=excluded.preview,
      model=excluded.model,
      archived=0"#,
    params![session_id, rollout_path, seconds, db_cwd, title, preview, model, preview, millis],
  ).map_err(|e| format!("failed to update Codex desktop thread index: {e}"))?;
  Ok(())
}

fn codex_db_cwd(cwd: &str) -> String {
  if cfg!(target_os = "windows") && cwd.len() > 2 && cwd.as_bytes().get(1) == Some(&b':') && !cwd.starts_with(r"\\?\") {
    format!(r"\\?\{cwd}")
  } else {
    cwd.to_string()
  }
}

fn push_item(records: &mut Vec<String>, ts: &str, payload: Value) {
  records.push(json!({ "timestamp": ts, "type": "response_item", "payload": payload }).to_string());
}

fn resolve_target_model(target_agent: Agent, source_model: Option<&str>) -> ModelMapping {
  let source_model = source_model.map(str::trim).filter(|value| !value.is_empty()).map(str::to_string);
  let default_model = default_target_model(target_agent);

  if let Some(source_owned) = source_model.clone() {
    if let Some(mapped) = alias_target_model(&source_owned) {
      return ModelMapping {
        source_model,
        changed: mapped != source_owned,
        target_model: mapped,
        reason: "matched user model alias".to_string(),
      };
    }
    if model_is_compatible(target_agent, &source_owned) {
      return ModelMapping {
        source_model,
        target_model: source_owned,
        changed: false,
        reason: "source model is compatible with target agent".to_string(),
      };
    }
  }

  let changed = source_model.as_deref() != Some(default_model.as_str());
  ModelMapping {
    source_model,
    target_model: default_model,
    changed,
    reason: "source model is missing or not compatible with target agent; using target default model".to_string(),
  }
}

fn default_target_model(agent: Agent) -> String {
  let env_name = match agent {
    Agent::Claude => "XFER_TARGET_MODEL_CLAUDE",
    Agent::Codex => "XFER_TARGET_MODEL_CODEX",
  };
  std::env::var(env_name)
    .ok()
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty())
    .unwrap_or_else(|| match agent {
      Agent::Claude => "claude-sonnet-4-5".to_string(),
      Agent::Codex => "gpt-5.1-codex".to_string(),
    })
}

fn alias_target_model(source_model: &str) -> Option<String> {
  let raw = std::env::var("XFER_MODEL_ALIASES").ok()?;
  let aliases = serde_json::from_str::<HashMap<String, String>>(&raw).ok()?;
  aliases
    .get(source_model)
    .or_else(|| aliases.get(&source_model.to_ascii_lowercase()))
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty())
}

fn model_is_compatible(agent: Agent, model: &str) -> bool {
  let lower = model.to_ascii_lowercase();
  match agent {
    Agent::Claude => lower.starts_with("claude-") || lower.contains("claude"),
    Agent::Codex => lower.starts_with("gpt-") || lower.starts_with('o') || lower.contains("codex"),
  }
}

fn write_jsonl(file_path: &PathBuf, records: &[String]) -> Result<(), String> {
  fs::write(file_path, records.iter().map(|r| format!("{r}\n")).collect::<String>()).map_err(|e| e.to_string())
}

fn now_iso() -> String {
  Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
