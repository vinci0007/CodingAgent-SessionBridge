use crate::xfer::index::load_session;
use crate::xfer::model::{Agent, Block, Role, Turn, UnifiedSession};
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
  let payload = if mode == "replay" {
    as_replay_session(&src, opts.to)
  } else {
    sanitize_session_for_target(&src, opts.to)
  };
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

/// Strip source-agent-specific system prompts, AGENTS.md injections, and
/// embedded instruction markers so the migrated session does not leak the
/// origin agent's persona/role setup into the target agent's context.
///
/// What gets removed:
/// - Entire `system`/`developer` role turns authored by the source CLI itself
///   (these carry Codex/Claude bootstrap instructions, not user content).
/// - Leading "memory" / instruction preamble blocks that some CLIs prepend to
///   the first user turn (e.g. `<userMemory>`, `# AGENTS.md` content).
/// - Agent-specific XML/HTML tags left inside user/assistant text blocks
///   (`<system-reminder>`, `<env>`, `<userMemory>`, `<userRules>` etc).
///
/// User task content, assistant reasoning, tool calls and tool results are
/// preserved untouched.
pub fn sanitize_session_for_target(src: &UnifiedSession, _to: Agent) -> UnifiedSession {
  let mut out = src.clone();
  out.turns = src
    .turns
    .iter()
    .filter(|turn| !is_agent_bootstrap_turn(turn))
    .map(|turn| sanitize_turn(turn))
    .filter(|turn| !turn.blocks.is_empty())
    .collect();
  out
}

fn is_agent_bootstrap_turn(turn: &Turn) -> bool {
  // System/developer turns in source sessions are CLI-authored bootstrap
  // (Codex developer instructions, Claude system prompts). They are not user
  // content and must not be carried into the target agent.
  matches!(turn.role, Role::System)
}

fn sanitize_turn(turn: &Turn) -> Turn {
  let mut cleaned = turn.clone();
  cleaned.blocks = turn
    .blocks
    .iter()
    .map(|block| sanitize_block(block, turn.role.clone()))
    .filter(|block| !is_empty_block(block))
    .collect();

  // Drop a leading instruction-preamble from the first user turn. Some CLIs
  // prepend AGENTS.md / memory content as a separate text block before the
  // actual user message; we detect and remove it.
  if turn.role == Role::User {
    cleaned.blocks = strip_leading_preamble(&cleaned.blocks);
  }

  cleaned
}

fn sanitize_block(block: &Block, role: Role) -> Block {
  match block {
    Block::Text { text } => {
      let cleaned = strip_agent_tags(text);
      if role == Role::System && cleaned.trim().is_empty() {
        Block::Text { text: String::new() }
      } else {
        Block::Text { text: cleaned }
      }
    }
    other => other.clone(),
  }
}

fn is_empty_block(block: &Block) -> bool {
  matches!(block, Block::Text { text } if text.trim().is_empty())
}

/// Remove agent-specific markup that another CLI would misinterpret as live
/// instructions. We erase the tag wrappers but keep the human-readable text
/// inside when it looks like genuine user/assistant content.
fn strip_agent_tags(text: &str) -> String {
  let tags = [
    "system-reminder",
    "userMemory",
    "userRules",
    "env",
    "system-guidance",
    "instructions",
  ];
  let mut out = text.to_string();
  for tag in tags {
    out = remove_tag_pair(&out, tag);
  }
  // Collapse runs of blank lines left behind.
  while out.contains("\n\n\n") {
    out = out.replace("\n\n\n", "\n\n");
  }
  out.trim().to_string()
}

fn remove_tag_pair(input: &str, tag: &str) -> String {
  let open = format!("<{tag}");
  let close = format!("</{tag}>");
  let self_closing = format!("<{tag} ... />");
  let mut result = String::new();
  let mut rest = input;
  while let Some(start) = rest.find(&open) {
    // Keep text before the tag.
    result.push_str(&rest[..start]);
    let after_open = &rest[start..];
    if after_open.starts_with(&self_closing) {
      rest = &after_open[self_closing.len()..];
      continue;
    }
    if let Some(end) = after_open.find(&close) {
      // Drop the entire tagged section: these wrappers carry source-agent
      // instructions, not user task content.
      rest = &after_open[end + close.len()..];
    } else {
      // Unclosed tag — drop the remainder of the wrapper line only.
      let line_end = after_open.find('\n').unwrap_or(after_open.len());
      rest = &after_open[line_end..];
    }
  }
  result.push_str(rest);
  result
}

fn strip_leading_preamble(blocks: &[Block]) -> Vec<Block> {
  // Heuristic: if the first user text block is dominated by instruction-like
  // markers (AGENTS.md, memory, role setup) rather than a real user message,
  // remove it so the target session starts cleanly.
  let Some(first) = blocks.first() else {
    return blocks.to_vec();
  };
  let Block::Text { text } = first else {
    return blocks.to_vec();
  };
  let lower = text.to_ascii_lowercase();
  let is_preamble = lower.contains("agents.md")
    || lower.contains("# memory")
    || lower.contains("usermemory")
    || lower.contains("you are ")
    || lower.contains("system prompt")
    || lower.contains("preferred language");
  if is_preamble && blocks.len() > 1 {
    return blocks[1..].to_vec();
  }
  blocks.to_vec()
}
