use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Agent {
  Claude,
  Codex,
}

impl Agent {
  pub fn other(self) -> Self {
    match self {
      Self::Claude => Self::Codex,
      Self::Codex => Self::Claude,
    }
  }

  pub fn as_str(self) -> &'static str {
    match self {
      Self::Claude => "claude",
      Self::Codex => "codex",
    }
  }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
  User,
  Assistant,
  System,
  Tool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind")]
pub enum Block {
  #[serde(rename = "text")]
  Text { text: String },
  #[serde(rename = "thinking")]
  Thinking {
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    encrypted: Option<bool>,
  },
  #[serde(rename = "tool_call")]
  ToolCall { id: String, name: String, input: Value },
  #[serde(rename = "tool_result")]
  ToolResult {
    #[serde(rename = "callId")]
    call_id: String,
    output: String,
    #[serde(rename = "isError", skip_serializing_if = "Option::is_none")]
    is_error: Option<bool>,
  },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
  pub id: String,
  pub role: Role,
  pub blocks: Vec<Block>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub timestamp: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
  pub agent: Agent,
  pub session_id: String,
  pub file_path: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub cwd: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub model: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub cli_version: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub title: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub created_at: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub updated_at: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub turn_count: Option<usize>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub git_branch: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub is_sidechain: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub subagents: Option<Vec<String>>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub parse_error: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub archived: Option<bool>,
}

pub type SessionIndexEntry = SessionMeta;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct UnifiedSession {
  pub meta: SessionMeta,
  pub turns: Vec<Turn>,
}
