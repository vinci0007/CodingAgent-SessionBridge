use crate::xfer::model::Agent;
use crate::xfer::paths::normalize_cwd;
use crate::xfer::settings::database_path;
use crate::xfer::sync_state::SessionMapEntry;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::PathBuf;

fn agent_from_db(value: String) -> rusqlite::Result<Agent> {
  match value.as_str() {
    "claude" => Ok(Agent::Claude),
    "codex" => Ok(Agent::Codex),
    _ => Err(rusqlite::Error::InvalidQuery),
  }
}

pub fn path() -> PathBuf {
  database_path()
}

pub fn path_string() -> String {
  path().to_string_lossy().to_string()
}

pub fn init() -> Result<String, String> {
  let _ = open()?;
  Ok(path_string())
}

fn open() -> Result<Connection, String> {
  let db = path();
  if let Some(dir) = db.parent() {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
  }
  let conn = Connection::open(db).map_err(|e| e.to_string())?;
  conn
    .execute_batch(
      "
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS migration_mappings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cwd TEXT NOT NULL,
        normalized_cwd TEXT NOT NULL,
        source_agent TEXT NOT NULL,
        source_project_cwd TEXT NOT NULL,
        source_session_id TEXT NOT NULL,
        target_agent TEXT NOT NULL,
        target_project_cwd TEXT NOT NULL,
        target_session_id TEXT NOT NULL,
        target_file_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        source_updated_at TEXT,
        status TEXT NOT NULL DEFAULT 'success',
        undone_at TEXT,
        UNIQUE(source_agent, source_project_cwd, source_session_id, target_agent, target_project_cwd)
      );

      CREATE INDEX IF NOT EXISTS idx_migration_mappings_cwd
        ON migration_mappings(normalized_cwd, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_migration_mappings_source
        ON migration_mappings(source_agent, source_project_cwd, source_session_id);
      CREATE INDEX IF NOT EXISTS idx_migration_mappings_target
        ON migration_mappings(target_agent, target_project_cwd, target_session_id);
      ",
    )
    .map_err(|e| e.to_string())?;
  Ok(conn)
}

pub fn upsert_mapping(entry: &SessionMapEntry) -> Result<(), String> {
  let conn = open()?;
  let project_cwd = normalize_cwd(&entry.cwd);
  conn
    .execute(
      "
      INSERT INTO migration_mappings (
        cwd, normalized_cwd, source_agent, source_project_cwd, source_session_id,
        target_agent, target_project_cwd, target_session_id, target_file_path,
        created_at, source_updated_at, status, undone_at
      ) VALUES (?1, ?2, ?3, ?2, ?4, ?5, ?2, ?6, ?7, ?8, ?9, 'success', NULL)
      ON CONFLICT(source_agent, source_project_cwd, source_session_id, target_agent, target_project_cwd)
      DO UPDATE SET
        cwd = excluded.cwd,
        normalized_cwd = excluded.normalized_cwd,
        target_session_id = excluded.target_session_id,
        target_file_path = excluded.target_file_path,
        created_at = excluded.created_at,
        source_updated_at = excluded.source_updated_at,
        status = 'success',
        undone_at = NULL
      ",
      params![
        entry.cwd,
        project_cwd,
        entry.source_agent.as_str(),
        entry.source_session_id,
        entry.target_agent.as_str(),
        entry.target_session_id,
        entry.target_file_path,
        entry.created_at,
        entry.source_updated_at,
      ],
    )
    .map_err(|e| e.to_string())?;
  Ok(())
}

pub fn list_mappings(cwd: &str) -> Result<Vec<SessionMapEntry>, String> {
  let conn = open()?;
  let project_cwd = normalize_cwd(cwd);
  let mut stmt = conn
    .prepare(
      "
      SELECT cwd, source_agent, source_session_id, target_agent, target_session_id,
             target_file_path, created_at, source_updated_at
      FROM migration_mappings
      WHERE normalized_cwd = ?1 AND status = 'success'
      ORDER BY created_at DESC
      ",
    )
    .map_err(|e| e.to_string())?;
  let rows = stmt
    .query_map(params![project_cwd], |row| {
      Ok(SessionMapEntry {
        cwd: row.get(0)?,
        source_agent: agent_from_db(row.get(1)?)?,
        source_session_id: row.get(2)?,
        target_agent: agent_from_db(row.get(3)?)?,
        target_session_id: row.get(4)?,
        target_file_path: row.get(5)?,
        created_at: row.get(6)?,
        source_updated_at: row.get(7)?,
      })
    })
    .map_err(|e| e.to_string())?;

  let mut mappings = Vec::new();
  for row in rows {
    mappings.push(row.map_err(|e| e.to_string())?);
  }
  Ok(mappings)
}

pub fn find_active_mapping(source_session_id: Option<&str>, target_session_id: Option<&str>) -> Result<Option<SessionMapEntry>, String> {
  let conn = open()?;
  let filter = match (source_session_id, target_session_id) {
    (Some(_), Some(_)) => "source_session_id = ?1 OR target_session_id = ?2",
    (Some(_), None) => "source_session_id = ?1",
    (None, Some(_)) => "target_session_id = ?2",
    (None, None) => return Ok(None),
  };
  let sql = format!(
    "
      SELECT cwd, source_agent, source_session_id, target_agent, target_session_id,
             target_file_path, created_at, source_updated_at
      FROM migration_mappings
      WHERE status = 'success'
        AND ({filter})
      ORDER BY created_at DESC
      LIMIT 1
      "
  );
  conn
    .query_row(&sql, params![source_session_id, target_session_id], |row| {
      Ok(SessionMapEntry {
        cwd: row.get(0)?,
        source_agent: agent_from_db(row.get(1)?)?,
        source_session_id: row.get(2)?,
        target_agent: agent_from_db(row.get(3)?)?,
        target_session_id: row.get(4)?,
        target_file_path: row.get(5)?,
        created_at: row.get(6)?,
        source_updated_at: row.get(7)?,
      })
    })
    .optional()
    .map_err(|e| e.to_string())
}

pub fn mark_mapping_undone(cwd: &str, source_session_id: Option<&str>, target_session_id: Option<&str>, undone_at: &str) -> Result<bool, String> {
  let conn = open()?;
  let project_cwd = normalize_cwd(cwd);
  let filter = match (source_session_id, target_session_id) {
    (Some(_), Some(_)) => "source_session_id = ?2 AND target_session_id = ?3",
    (Some(_), None) => "source_session_id = ?2",
    (None, Some(_)) => "target_session_id = ?3",
    (None, None) => return Ok(false),
  };
  let sql = format!(
    "
      SELECT id
      FROM migration_mappings
      WHERE normalized_cwd = ?1
        AND status = 'success'
        AND {filter}
      ORDER BY created_at DESC
      LIMIT 1
      "
  );
  let row_id: Option<i64> = conn
    .query_row(
      &sql,
      params![project_cwd, source_session_id, target_session_id],
      |row| row.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())?;

  let Some(id) = row_id else {
    return Ok(false);
  };

  conn
    .execute(
      "UPDATE migration_mappings SET status = 'undone', undone_at = ?1 WHERE id = ?2",
      params![undone_at, id],
    )
    .map_err(|e| e.to_string())?;
  Ok(true)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::Mutex;

  static TEST_ENV_LOCK: Mutex<()> = Mutex::new(());

  fn mapping(cwd: &str, target_session_id: &str) -> SessionMapEntry {
    SessionMapEntry {
      cwd: cwd.to_string(),
      source_agent: Agent::Claude,
      source_session_id: "source-1".to_string(),
      target_agent: Agent::Codex,
      target_session_id: target_session_id.to_string(),
      target_file_path: format!("{target_session_id}.jsonl"),
      created_at: "2026-06-21T00:00:00.000Z".to_string(),
      source_updated_at: Some("2026-06-21T00:00:00.000Z".to_string()),
    }
  }

  #[test]
  fn mapping_lifecycle_is_project_scoped() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    let db_path = std::env::temp_dir().join(format!("xfer-test-{}-{}.db", std::process::id(), chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()));
    std::env::set_var("XFER_DB_PATH", &db_path);

    upsert_mapping(&mapping("E:/project-a", "target-1")).unwrap();
    upsert_mapping(&mapping("E:/project-b", "target-other")).unwrap();
    upsert_mapping(&mapping("E:/project-a", "target-2")).unwrap();

    let a = list_mappings("e:\\project-a\\").unwrap();
    assert_eq!(a.len(), 1);
    assert_eq!(a[0].target_session_id, "target-2");

    let b = list_mappings("E:/project-b").unwrap();
    assert_eq!(b.len(), 1);
    assert_eq!(b[0].target_session_id, "target-other");

    assert!(mark_mapping_undone("E:/project-a", Some("source-1"), Some("target-other"), "2026-06-21T00:01:00.000Z").unwrap() == false);
    assert!(mark_mapping_undone("E:/project-a", Some("source-1"), Some("target-2"), "2026-06-21T00:01:00.000Z").unwrap());
    assert!(list_mappings("E:/project-a").unwrap().is_empty());
    assert_eq!(list_mappings("E:/project-b").unwrap().len(), 1);

    std::env::remove_var("XFER_DB_PATH");
    let _ = std::fs::remove_file(&db_path);
    let _ = std::fs::remove_file(db_path.with_extension("db-wal"));
    let _ = std::fs::remove_file(db_path.with_extension("db-shm"));
  }
}
