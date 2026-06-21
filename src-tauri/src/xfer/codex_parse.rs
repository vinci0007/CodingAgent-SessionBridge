use crate::xfer::model::{Agent, Block, Role, SessionMeta, Turn, UnifiedSession};
use crate::xfer::paths::{extract_uuid, normalize_project_cwd};
use serde_json::Value;
use std::fs;
use std::path::Path;

pub fn parse_codex_session(file_path: &Path) -> Result<UnifiedSession, String> {
  let raw = fs::read_to_string(file_path).map_err(|e| e.to_string())?;
  let mut turns = Vec::new();
  let file_path_str = file_path.to_string_lossy().to_string();
  let file_name = file_path.file_name().and_then(|s| s.to_str()).unwrap_or("");
  let mut session_id = extract_uuid(file_name).unwrap_or_else(|| file_path_str.clone());
  let mut cwd = None;
  let mut model = None;
  let mut cli_version = None;
  let mut git_branch = None;
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
    if let Some(value) = o.get("timestamp").and_then(Value::as_str) {
      if created_at.is_none() { created_at = Some(value.to_string()); }
      updated_at = Some(value.to_string());
    }
    let payload = o.get("payload").unwrap_or(&Value::Null);
    let typ = o.get("type").and_then(Value::as_str);

    if typ == Some("session_meta") {
      if let Some(value) = payload.get("id").and_then(Value::as_str) { session_id = value.to_string(); }
      if let Some(value) = payload.get("cwd").and_then(Value::as_str) { cwd = Some(normalize_project_cwd(value)); }
      if let Some(value) = payload.get("cli_version").and_then(Value::as_str) { cli_version = Some(value.to_string()); }
      if let Some(value) = payload.pointer("/git/branch").and_then(Value::as_str) { git_branch = Some(value.to_string()); }
      if let Some(value) = payload.get("timestamp").and_then(Value::as_str) { created_at = Some(value.to_string()); }
      continue;
    }

    if typ == Some("turn_context") {
      if let Some(value) = payload.get("model").and_then(Value::as_str) {
        if model.is_none() { model = Some(value.to_string()); }
      }
      if let Some(value) = payload.get("cwd").and_then(Value::as_str) {
        if cwd.is_none() { cwd = Some(normalize_project_cwd(value)); }
      }
      continue;
    }

    if typ == Some("event_msg") && payload.get("type").and_then(Value::as_str) == Some("user_message") && title.is_none() {
      if let Some(message) = payload.get("message").and_then(Value::as_str) {
        let cleaned = strip_ide_preamble(message);
        if !cleaned.is_empty() {
          title = Some(cleaned.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(100).collect());
        }
      }
      continue;
    }

    if typ != Some("response_item") {
      continue;
    }

    match payload.get("type").and_then(Value::as_str) {
      Some("message") => {
        let raw_role = payload.get("role").and_then(Value::as_str).unwrap_or("user");
        let role = match raw_role {
          "assistant" => Role::Assistant,
          "developer" | "system" => Role::System,
          _ => Role::User,
        };
        let blocks: Vec<Block> = blocks_from_message(payload)
          .into_iter()
          .filter(|b| !matches!(b, Block::Text { text } if is_noise_preamble(text)))
          .collect();
        if blocks.is_empty() { continue; }
        if title.is_none() && role == Role::User {
          if let Some(text) = first_text(&blocks) {
            if !is_injected_context(text) {
              let cleaned = strip_ide_preamble(text);
              if !cleaned.is_empty() {
                title = Some(cleaned.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(100).collect());
              }
            }
          }
        }
        turns.push(Turn { id: next_id(&mut synthetic), role, blocks, timestamp: timestamp(&o) });
      }
      Some("reasoning") => {
        let text = reasoning_summary(payload).unwrap_or_else(|| "[encrypted reasoning]".to_string());
        turns.push(Turn {
          id: next_id(&mut synthetic),
          role: Role::Assistant,
          blocks: vec![Block::Thinking { text, encrypted: Some(true) }],
          timestamp: timestamp(&o),
        });
      }
      Some("function_call") => {
        let input = match payload.get("arguments") {
          Some(Value::String(s)) => serde_json::from_str::<Value>(s).unwrap_or_else(|_| Value::String(s.clone())),
          Some(v) => v.clone(),
          None => Value::Null,
        };
        let name = payload.get("name").and_then(Value::as_str).unwrap_or("tool").to_string();
        if let Some(label) = subagent_label(&name, &input) {
          subagents.push(label);
        }
        turns.push(Turn {
          id: next_id(&mut synthetic),
          role: Role::Assistant,
          blocks: vec![Block::ToolCall {
            id: payload.get("call_id").and_then(Value::as_str).unwrap_or("").to_string(),
            name,
            input,
          }],
          timestamp: timestamp(&o),
        });
      }
      Some("function_call_output") => {
        let output = payload.get("output").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| serde_json::to_string(payload.get("output").unwrap_or(&Value::Null)).unwrap_or_default());
        turns.push(Turn {
          id: next_id(&mut synthetic),
          role: Role::Tool,
          blocks: vec![Block::ToolResult {
            call_id: payload.get("call_id").and_then(Value::as_str).unwrap_or("").to_string(),
            output,
            is_error: None,
          }],
          timestamp: timestamp(&o),
        });
      }
      _ => {}
    }
  }

  let turn_count = turns.len();
  Ok(UnifiedSession {
    meta: SessionMeta {
      agent: Agent::Codex,
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
      is_sidechain: None,
      subagents: Some(subagents).filter(|v: &Vec<String>| !v.is_empty()),
      parse_error: None,
      archived: None,
    },
    turns,
  })
}

fn timestamp(o: &Value) -> Option<String> {
  o.get("timestamp").and_then(Value::as_str).map(str::to_string)
}

fn next_id(synthetic: &mut usize) -> String {
  let id = format!("x{}", *synthetic);
  *synthetic += 1;
  id
}

fn blocks_from_message(payload: &Value) -> Vec<Block> {
  let Some(content) = payload.get("content").and_then(Value::as_array) else { return Vec::new() };
  content
    .iter()
    .filter_map(|c| {
      let text = c.get("text").and_then(Value::as_str)?;
      let typ = c.get("type").and_then(Value::as_str)?;
      if matches!(typ, "input_text" | "output_text" | "text") && !text.is_empty() {
        Some(Block::Text { text: text.to_string() })
      } else {
        None
      }
    })
    .collect()
}

fn reasoning_summary(payload: &Value) -> Option<String> {
  let summary = payload.get("summary")?.as_array()?;
  if summary.is_empty() { return None; }
  let text = summary
    .iter()
    .filter_map(|s| s.as_str().or_else(|| s.get("text").and_then(Value::as_str)))
    .collect::<Vec<_>>()
    .join("\n");
  (!text.is_empty()).then_some(text)
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

fn is_noise_preamble(text: &str) -> bool {
  text.starts_with("<permissions instructions>")
    || text.starts_with("<collaboration_mode>")
    || text.starts_with("<skills_instructions>")
    || text.starts_with("<environment_context>")
}

fn is_injected_context(text: &str) -> bool {
  let t = text.trim_start();
  t.starts_with("# AGENTS.md")
    || t.starts_with("<environment_context>")
    || t.starts_with("<user_instructions>")
    || (t.starts_with('<') && t.contains("instructions>"))
}

fn strip_ide_preamble(message: &str) -> &str {
  if let Some(index) = message.find("My request for Codex:") {
    return message[index + "My request for Codex:".len()..].trim();
  }
  if is_injected_context(message) { "" } else { message }
}

fn first_text(blocks: &[Block]) -> Option<&str> {
  blocks.iter().find_map(|block| {
    if let Block::Text { text } = block { Some(text.as_str()) } else { None }
  })
}
