use std::path::{Path, PathBuf};
use walkdir::WalkDir;

pub fn home_dir() -> PathBuf {
  dirs::home_dir().unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

pub fn claude_home() -> PathBuf {
  std::env::var_os("CLAUDE_CONFIG_DIR")
    .or_else(|| std::env::var_os("CLAUDE_HOME"))
    .map(PathBuf::from)
    .unwrap_or_else(|| home_dir().join(".claude"))
}

pub fn codex_home() -> PathBuf {
  std::env::var_os("CODEX_HOME")
    .map(PathBuf::from)
    .unwrap_or_else(|| home_dir().join(".codex"))
}

/// Split an OS path-list env value into trimmed, non-empty roots.
pub fn split_roots(value: Option<std::ffi::OsString>) -> Vec<PathBuf> {
  let Some(value) = value else { return Vec::new() };
  std::env::split_paths(&value).filter(|p| !p.as_os_str().is_empty()).collect()
}

/// All Claude roots: the primary home plus any extra configured roots.
pub fn claude_roots() -> Vec<PathBuf> {
  let mut roots = vec![claude_home()];
  roots.extend(split_roots(std::env::var_os("XFER_CLAUDE_EXTRA_ROOTS")));
  roots
}

/// All Codex roots: the primary home plus any extra configured roots.
pub fn codex_roots() -> Vec<PathBuf> {
  let mut roots = vec![codex_home()];
  roots.extend(split_roots(std::env::var_os("XFER_CODEX_EXTRA_ROOTS")));
  roots
}

pub fn claude_projects_dir() -> PathBuf {
  claude_home().join("projects")
}

pub fn codex_sessions_dir() -> PathBuf {
  codex_home().join("sessions")
}

/// Every Claude `projects` dir across all roots (for read/index scanning).
pub fn claude_project_dirs() -> Vec<PathBuf> {
  claude_roots().into_iter().map(|r| r.join("projects")).collect()
}

/// Every Codex `sessions` dir across all roots (for read/index scanning).
pub fn codex_session_dirs() -> Vec<PathBuf> {
  codex_roots().into_iter().map(|r| r.join("sessions")).collect()
}

pub fn encode_claude_project_dir(cwd: &str) -> String {
  normalize_project_cwd(cwd)
    .chars()
    .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
    .collect()
}

pub fn normalize_project_cwd(cwd: &str) -> String {
  strip_windows_verbatim_prefix(cwd)
}

pub fn strip_windows_verbatim_prefix(path: &str) -> String {
  if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
    return format!(r"\\{rest}");
  }
  if let Some(rest) = path.strip_prefix(r"\\?\") {
    return rest.to_string();
  }
  path.to_string()
}

pub fn extract_uuid(input: &str) -> Option<String> {
  let bytes = input.as_bytes();
  for i in 0..bytes.len().saturating_sub(35) {
    let s = &input[i..i + 36];
    if is_uuid_like(s) {
      return Some(s.to_string());
    }
  }
  None
}

fn is_uuid_like(s: &str) -> bool {
  let bs = s.as_bytes();
  if bs.len() != 36 {
    return false;
  }
  for (i, b) in bs.iter().enumerate() {
    if matches!(i, 8 | 13 | 18 | 23) {
      if *b != b'-' {
        return false;
      }
    } else if !b.is_ascii_hexdigit() {
      return false;
    }
  }
  true
}

pub fn walk_jsonl(dir: &Path) -> Vec<PathBuf> {
  if !dir.exists() {
    return Vec::new();
  }
  WalkDir::new(dir)
    .into_iter()
    .filter_map(Result::ok)
    .filter(|entry| entry.file_type().is_file())
    .map(|entry| entry.into_path())
    .filter(|path| path.extension().and_then(|s| s.to_str()) == Some("jsonl"))
    .collect()
}

pub fn normalize_cwd(cwd: &str) -> String {
  normalize_project_cwd(cwd).replace('\\', "/").trim_end_matches('/').to_lowercase()
}

pub fn default_project_cwd(cwd: Option<&str>) -> String {
  let path = cwd.map(PathBuf::from).unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
  normalize_project_cwd(&path.canonicalize().unwrap_or(path).to_string_lossy())
}
