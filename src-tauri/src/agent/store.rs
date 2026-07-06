//! Symon voice-agent task persistence — `~/.o8/agent.db` (rusqlite).
//!
//! Best-effort: every write swallows its error (logged, never fatal) so a DB
//! hiccup can't break a voice turn. Matches o8's "never throw" house style.
//! Each call opens a fresh connection (no pool) — the tables are tiny and the
//! agent runs at human speed.

use rusqlite::{params, Connection};

fn open_db() -> Result<Connection, String> {
    let path = super::agent_data_dir().join("agent.db");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = Connection::open(&path).map_err(|e| format!("agent.db open failed: {e}"))?;
    conn.pragma_update(None, "journal_mode", "WAL").ok();
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_tasks (
            id TEXT PRIMARY KEY,
            created_at INTEGER NOT NULL,
            finished_at INTEGER,
            status TEXT NOT NULL DEFAULT 'queued',
            intent_text TEXT NOT NULL,
            model_used TEXT,
            tool_calls_json TEXT,
            result_text TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_agent_tasks_created_at
            ON agent_tasks (created_at DESC);",
    )
    .map_err(|e| format!("agent.db migrate failed: {e}"))?;
    Ok(conn)
}

/// Unix epoch seconds.
pub fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Record a task as it starts.
pub fn insert_task(id: &str, intent: &str) {
    match open_db() {
        Ok(conn) => {
            if let Err(e) = conn.execute(
                "INSERT INTO agent_tasks (id, created_at, status, intent_text)
                 VALUES (?1, ?2, 'running', ?3)",
                params![id, now_ts(), intent],
            ) {
                log::warn!("[symon-agent] insert_task failed: {e}");
            }
        }
        Err(e) => log::warn!("[symon-agent] {e}"),
    }
}

/// Record a task's terminal state + outputs.
pub fn finish_task(
    id: &str,
    status: &str,
    result_text: &str,
    model_used: &str,
    tool_calls_json: &str,
) {
    match open_db() {
        Ok(conn) => {
            if let Err(e) = conn.execute(
                "UPDATE agent_tasks
                 SET status = ?2, finished_at = ?3, result_text = ?4,
                     model_used = ?5, tool_calls_json = ?6
                 WHERE id = ?1",
                params![id, status, now_ts(), result_text, model_used, tool_calls_json],
            ) {
                log::warn!("[symon-agent] finish_task failed: {e}");
            }
        }
        Err(e) => log::warn!("[symon-agent] {e}"),
    }
}

/// Recent finished exchanges (intent, spoken reply), OLDEST FIRST, for the
/// rolling conversation context. Only `done` tasks with a non-empty reply
/// inside the age window count — a denied card or a crash is not conversation.
pub fn recent_exchanges(max_age_secs: i64, limit: usize) -> Vec<(String, String)> {
    let Ok(conn) = open_db() else { return Vec::new() };
    let cutoff = now_ts() - max_age_secs;
    let Ok(mut stmt) = conn.prepare(
        "SELECT intent_text, result_text FROM agent_tasks
         WHERE status = 'done' AND finished_at >= ?1
           AND result_text IS NOT NULL AND result_text != ''
         ORDER BY created_at DESC LIMIT ?2",
    ) else {
        return Vec::new();
    };
    let rows = stmt
        .query_map(params![cutoff, limit as i64], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map(|r| r.flatten().collect::<Vec<_>>())
        .unwrap_or_default();
    rows.into_iter().rev().collect()
}

/// The most recent task as a small JSON object (drives `agent_task_status`).
pub fn latest_task() -> Option<serde_json::Value> {
    let conn = open_db().ok()?;
    conn.query_row(
        "SELECT id, status, intent_text, result_text, model_used, created_at, finished_at
         FROM agent_tasks ORDER BY created_at DESC LIMIT 1",
        [],
        |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "status": row.get::<_, String>(1)?,
                "intent": row.get::<_, String>(2)?,
                "result": row.get::<_, Option<String>>(3)?,
                "model": row.get::<_, Option<String>>(4)?,
                "createdAt": row.get::<_, i64>(5)?,
                "finishedAt": row.get::<_, Option<i64>>(6)?,
            }))
        },
    )
    .ok()
}
