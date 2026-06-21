use std::path::PathBuf;

use crate::xfer::paths::normalize_project_cwd;

pub fn env_var(name: &str) -> Option<String> {
  std::env::var(name).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

pub fn storage_root() -> Option<String> {
  env_var("XFER_STORAGE_ROOT")
}

pub fn state_root() -> Option<String> {
  env_var("XFER_STATE_ROOT").or_else(storage_root)
}

pub fn archive_root() -> PathBuf {
  if let Some(path) = env_var("XFER_ARCHIVE_ROOT") {
    return PathBuf::from(path);
  }
  if let Some(root) = storage_root() {
    return PathBuf::from(root).join("archive");
  }
  portable_data_root().unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))).join("archive")
}

pub fn encode_cwd(cwd: &str) -> String {
  let resolved = normalize_project_cwd(&PathBuf::from(cwd)
    .canonicalize()
    .unwrap_or_else(|_| PathBuf::from(cwd))
    .to_string_lossy()
    .to_string());
  let mut chars: Vec<char> = resolved.chars().collect();
  if chars.len() >= 2 && chars[1] == ':' && chars[0].is_ascii_alphabetic() {
    chars[0] = chars[0].to_ascii_uppercase();
  }
  chars
    .into_iter()
    .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '-' })
    .collect()
}

pub fn configured_state_path(cwd: &str) -> Option<PathBuf> {
  let root = state_root()?;
  Some(PathBuf::from(root).join(encode_cwd(cwd)).join("state.json"))
}

pub fn portable_data_root() -> Option<PathBuf> {
  let exe = std::env::current_exe().ok()?;
  let dir = exe.parent()?;
  Some(dir.join("data"))
}

pub fn database_path() -> PathBuf {
  if let Some(path) = env_var("XFER_DB_PATH") {
    return PathBuf::from(path);
  }
  if let Some(root) = state_root() {
    return PathBuf::from(root).join("xfer.db");
  }
  portable_data_root().unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))).join("xfer.db")
}
