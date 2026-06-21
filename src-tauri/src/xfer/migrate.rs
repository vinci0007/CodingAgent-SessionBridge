use crate::xfer::index::load_session;
use crate::xfer::model::{Agent, Block, UnifiedSession};
use crate::xfer::write::{migration_banner, write_claude_session, write_codex_session, ModelMapping};
use serde::{Deserialize, Serialize};

pub type MigrateMode = String;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrateOptions {
  pub session_id: String,
  pub to: Agent,
  pub mode: Option<MigrateMode>,
  pub cwd: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrateResult {
  pub from: Agent,
  pub to: Agent,
  pub mode: String,
  pub session_id: String,
  pub file_path: String,
  pub resume_command: String,
  pub turns_written: usize,
  pub model_mapping: ModelMapping,
}

pub fn build_transcript(session: &UnifiedSession) -> String {
  let mut lines = Vec::new();
  for turn in &session.turns {
    for block in &turn.blocks {
      match block {
        Block::Text { text } => lines.push(format!("### {}\n{}", role_name(&turn.role), text)),
        Block::Thinking { text, .. } => lines.push(format!("### {} (thinking)\n{}", role_name(&turn.role), text)),
        Block::ToolCall { name, input, .. } => lines.push(format!("### {} -> tool: {}\n{}", role_name(&turn.role), name, input)),
        Block::ToolResult { output, .. } => lines.push(format!("### tool result\n{}", output)),
      }
    }
  }
  lines.join("\n\n")
}

pub fn migrate(opts: MigrateOptions) -> Result<MigrateResult, String> {
  let src = load_session(&opts.session_id).ok_or_else(|| format!("Session not found: {}", opts.session_id))?;
  if src.meta.agent == opts.to {
    return Err(format!("Session is already a {} session", opts.to.as_str()));
  }
  let mode = opts.mode.unwrap_or_else(|| "faithful".to_string());
  let cwd = opts.cwd.or_else(|| src.meta.cwd.clone()).ok_or_else(|| {
    "No cwd recorded for this session; pass --cwd to set the destination working directory.".to_string()
  })?;
  let payload = if mode == "replay" { as_replay_session(&src, opts.to) } else { src.clone() };
  let turns_written = payload.turns.len();
  let written = match opts.to {
    Agent::Claude => write_claude_session(&payload, &cwd)?,
    Agent::Codex => write_codex_session(&payload, &cwd)?,
  };
  let resume_command = match opts.to {
    Agent::Claude => format!("claude --resume {}", written.session_id),
    Agent::Codex => format!("codex resume {}", written.session_id),
  };
  Ok(MigrateResult {
    from: src.meta.agent,
    to: opts.to,
    mode,
    session_id: written.session_id,
    file_path: written.file_path,
    resume_command,
    turns_written,
    model_mapping: written.model_mapping,
  })
}

fn as_replay_session(src: &UnifiedSession, to: Agent) -> UnifiedSession {
  let transcript = build_transcript(src);
  let banner = migration_banner(src, to);
  let mut replay = src.clone();
  replay.meta.agent = to;
  replay.turns = vec![crate::xfer::model::Turn {
    id: "replay-0".to_string(),
    role: crate::xfer::model::Role::User,
    blocks: vec![Block::Text { text: format!("{banner}\n\n{transcript}") }],
    timestamp: None,
  }];
  replay
}

fn role_name(role: &crate::xfer::model::Role) -> &'static str {
  match role {
    crate::xfer::model::Role::User => "user",
    crate::xfer::model::Role::Assistant => "assistant",
    crate::xfer::model::Role::System => "system",
    crate::xfer::model::Role::Tool => "tool",
  }
}
