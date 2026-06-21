use crate::xfer::model::{Agent, Block, Role, SessionMeta, Turn, UnifiedSession};
use crate::xfer::paths::{extract_uuid, normalize_project_cwd};
use serde_json::Value;
use std::fs;
use std::path::Path;

pub fn parse_claude_session(file_path: &Path) -> Result<UnifiedSession, String> {
  let raw = fs::read_to_string(file_path).map_err(|e| e.to_string())?;
  let mut turns = Vec::new();
  let file_path_str = file_path.to_string_lossy().to_string();
  let file_name = file_path.file_name().and_then(|s| s.to_str()).unwrap_or("");
  let mut session_id = extract_uuid(file_name).unwrap_or_else(|| file_path_str.clone());
  let mut cwd = None;
  let mut model = None;
  let mut cli_version = None;
  let mut git_branch = None;
  let mut is_sidechain = false;
  let mut title = None;
  let mut created_at = None;
  let mut updated_at = None;
  let mut subagents: Vec<String> = Vec::new();
  let mut synthetic = 0usize;

  for line in raw.lines() {
    if line.trim().is_empty() {
      continue;
    }
    let Ok(o) = serde_json::from_str::<Value>(line) else { continue };
    if let Some(value) = o.get("cwd").and_then(Value::as_str) {
      if cwd.is_none() { cwd = Some(normalize_project_cwd(value)); }
    }
    if let Some(value) = o.get("gitBranch").and_then(Value::as_str) {
      if git_branch.is_none() { git_branch = Some(value.to_string()); }
    }
    if o.get("isSidechain").and_then(Value::as_bool) == Some(true) {
      is_sidechain = true;
    }
    if let Some(value) = o.get("version").and_then(Value::as_str) {
      if cli_version.is_none() { cli_version = Some(value.to_string()); }
    }
    if let Some(value) = o.get("timestamp").and_then(Value::as_str) {
      if created_at.is_none() { created_at = Some(value.to_string()); }
      updated_at = Some(value.to_string());
    }
    if let Some(value) = o.get("sessionId").and_then(Value::as_str) {
      if extract_uuid(value).is_some() {
        session_id = value.to_string();
      }
    }

    let typ = o.get("type").and_then(Value::as_str);
    if typ != Some("user") && typ != Some("assistant") {
      continue;
    }
    let role = if typ == Some("assistant") { Role::Assistant } else { Role::User };
    let message = o.get("message").unwrap_or(&Value::Null);
    if let Some(value) = message.get("model").and_then(Value::as_str) {
      if model.is_none() { model = Some(value.to_string()); }
    }
    let blocks = blocks_from_content(message.get("content").unwrap_or(&Value::Null));
    if blocks.is_empty() {
      continue;
    }
    for block in &blocks {
      if let Block::ToolCall { name, input, .. } = block {
        if let Some(label) = subagent_label(name, input) {
          subagents.push(label);
        }
      }
    }
    let only_tool_results = blocks.iter().all(|b| matches!(b, Block::ToolResult { .. }));
    let turn_role = if only_tool_results { Role::Tool } else { role.clone() };
    let id = o.get("uuid").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| {
      let id = format!("c{synthetic}");
      synthetic += 1;
      id
    });
    if title.is_none() && role == Role::User {
      title = first_text_title(&blocks);
    }
    turns.push(Turn {
      id,
      role: turn_role,
      blocks,
      timestamp: o.get("timestamp").and_then(Value::as_str).map(str::to_string),
    });
  }

  let turn_count = turns.len();
  Ok(UnifiedSession {
    meta: SessionMeta {
      agent: Agent::Claude,
      session_id,
      file_path: file_path_str,
      cwd,
      model,
      cli_version,
      title,
      created_at,
      updated_at,
      turn_count: Some(turn_count),
      git_branch,
      is_sidechain: is_sidechain.then_some(true),
      subagents: Some(subagents).filter(|v: &Vec<String>| !v.is_empty()),
      parse_error: None,
      archived: None,
    },
    turns,
  })
}

fn blocks_from_content(content: &Value) -> Vec<Block> {
  if let Some(text) = content.as_str() {
    return if text.trim().is_empty() { Vec::new() } else { vec![Block::Text { text: text.to_string() }] };
  }
  let Some(items) = content.as_array() else { return Vec::new() };
  let mut blocks = Vec::new();
  for item in items {
    let typ = item.get("type").and_then(Value::as_str);
    match typ {
      Some("text") => {
        if let Some(text) = item.get("text").and_then(Value::as_str) {
          if !text.is_empty() { blocks.push(Block::Text { text: text.to_string() }); }
        }
      }
      Some("thinking") => {
        if let Some(text) = item.get("thinking").and_then(Value::as_str) {
          blocks.push(Block::Thinking { text: text.to_string(), encrypted: None });
        }
      }
      Some("tool_use") => {
        blocks.push(Block::ToolCall {
          id: item.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
          name: item.get("name").and_then(Value::as_str).unwrap_or("tool").to_string(),
          input: item.get("input").cloned().unwrap_or_else(|| Value::Object(Default::default())),
        });
      }
      Some("tool_result") => {
        let output = stringify_tool_result(item.get("content").unwrap_or(&Value::Null));
        blocks.push(Block::ToolResult {
          call_id: item.get("tool_use_id").and_then(Value::as_str).unwrap_or("").to_string(),
          output,
          is_error: item.get("is_error").and_then(Value::as_bool).filter(|v| *v),
        });
      }
      _ => {}
    }
  }
  blocks
}

fn stringify_tool_result(value: &Value) -> String {
  if let Some(text) = value.as_str() {
    return text.to_string();
  }
  if let Some(items) = value.as_array() {
    return items
      .iter()
      .filter_map(|item| item.get("text").and_then(Value::as_str))
      .collect::<Vec<_>>()
      .join("");
  }
  serde_json::to_string(value).unwrap_or_default()
}

fn subagent_label(name: &str, input: &Value) -> Option<String> {
  let lower = name.to_ascii_lowercase();
  let has_subagent_hint =
    input.get("subagent_type").and_then(Value::as_str).is_some()
      || input.get("agent_type").and_then(Value::as_str).is_some();
  if !matches!(name, "Task" | "Agent" | "delegate")
    && !lower.contains("subagent")
    && !lower.contains("delegate")
    && !has_subagent_hint
  {
    return None;
  }
  for key in ["subagent_type", "agent_type", "description", "name", "agent"] {
    if let Some(value) = input.get(key).and_then(Value::as_str) {
      let clean = value.trim();
      if !clean.is_empty() {
        return Some(clean.chars().take(80).collect());
      }
    }
  }
  Some(name.to_string())
}

fn first_text_title(blocks: &[Block]) -> Option<String> {
  blocks.iter().find_map(|block| {
    if let Block::Text { text } = block {
      Some(text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(100).collect())
    } else {
      None
    }
  })
}
