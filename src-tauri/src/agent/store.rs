//! Symon voice-agent task persistence — `~/.o8/agent.db` (rusqlite).
//!
//! Best-effort: every write swallows its error (logged, never fatal) so a DB
//! hiccup can't break a voice turn. Matches o8's "never throw" house style.
//! Each call opens a fresh connection (no pool) — the tables are tiny and the
//! agent runs at human speed.

use rusqlite::{params, Connection};

fn table_has_column(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut statement = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| format!("agent.db inspect {table} failed: {error}"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| format!("agent.db list {table} columns failed: {error}"))?;
    for existing in columns {
        if existing.map_err(|error| format!("agent.db read {table} column failed: {error}"))?
            == column
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn ensure_table_column(
    conn: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), String> {
    if table_has_column(conn, table, column)? {
        return Ok(());
    }
    if let Err(error) = conn.execute(
        &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
        [],
    ) {
        // Multiple fresh connections can migrate concurrently. If another
        // connection won the additive-column race, the desired state exists.
        if table_has_column(conn, table, column)? {
            return Ok(());
        }
        return Err(format!("agent.db add {column} failed: {error}"));
    }
    Ok(())
}

#[cfg(test)]
thread_local! {
    static TEST_DATA_DIR: std::cell::RefCell<Option<std::path::PathBuf>> = const {
        std::cell::RefCell::new(None)
    };
}

#[cfg(test)]
pub(crate) fn with_test_data_dir<T>(path: std::path::PathBuf, run: impl FnOnce() -> T) -> T {
    TEST_DATA_DIR.with(|slot| {
        let previous = slot.replace(Some(path));
        let result = run();
        slot.replace(previous);
        result
    })
}

fn data_dir() -> std::path::PathBuf {
    #[cfg(test)]
    if let Some(path) = TEST_DATA_DIR.with(|slot| slot.borrow().clone()) {
        return path;
    }
    super::agent_data_dir()
}

pub(crate) fn migrate_connection(conn: &Connection) -> Result<(), String> {
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
            ON agent_tasks (created_at DESC);

        CREATE TABLE IF NOT EXISTS agent_action_events (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            action_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            source TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            phase TEXT NOT NULL,
            utterance TEXT,
            tool TEXT NOT NULL,
            args_summary TEXT NOT NULL,
            confirmation_id TEXT,
            confirmation_outcome TEXT NOT NULL,
            outcome TEXT NOT NULL,
            result_summary TEXT NOT NULL,
            undo_token TEXT,
            session_id TEXT,
            call_id TEXT,
            plan_id TEXT,
            plan_step_index INTEGER,
            plan_step_count INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_agent_action_events_created_at
            ON agent_action_events (created_at DESC, seq DESC);
        CREATE INDEX IF NOT EXISTS idx_agent_action_events_action_id
            ON agent_action_events (action_id, seq DESC);
        CREATE INDEX IF NOT EXISTS idx_agent_action_events_task_id
            ON agent_action_events (task_id, seq);
        CREATE TRIGGER IF NOT EXISTS agent_action_events_no_update
            BEFORE UPDATE ON agent_action_events
            BEGIN SELECT RAISE(ABORT, 'agent action events are append-only'); END;
        CREATE TRIGGER IF NOT EXISTS agent_action_events_no_delete
            BEFORE DELETE ON agent_action_events
            BEGIN SELECT RAISE(ABORT, 'agent action events are append-only'); END;

        CREATE TABLE IF NOT EXISTS agent_undo_tokens (
            token TEXT PRIMARY KEY,
            action_id TEXT NOT NULL UNIQUE,
            inverse_json TEXT NOT NULL,
            scope TEXT,
            created_at INTEGER NOT NULL,
            claimed_at INTEGER,
            consumed_at INTEGER,
            invalidated_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS agent_personal_memory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fact TEXT NOT NULL,
            normalized_fact TEXT NOT NULL UNIQUE,
            state TEXT NOT NULL CHECK (state IN ('active', 'pending')),
            source TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_personal_memory_state_updated
            ON agent_personal_memory (state, updated_at DESC, id DESC);",
    )
    .map_err(|e| format!("agent.db migrate failed: {e}"))?;

    // `agent_action_events` predates chained plans. Additive columns preserve
    // every immutable action row and keep existing #1217 databases readable.
    for (column, definition) in [
        ("plan_id", "TEXT"),
        ("plan_step_index", "INTEGER"),
        ("plan_step_count", "INTEGER"),
    ] {
        ensure_table_column(conn, "agent_action_events", column, definition)?;
    }

    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_agent_action_events_plan_id
            ON agent_action_events (plan_id, plan_step_index, seq);

        CREATE TABLE IF NOT EXISTS agent_plan_events (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            plan_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            source TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            phase TEXT NOT NULL,
            redacted_summary TEXT NOT NULL,
            outcome TEXT NOT NULL,
            session_id TEXT,
            step_index INTEGER,
            step_count INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_plan_events_plan_id
            ON agent_plan_events (plan_id, seq);
        CREATE INDEX IF NOT EXISTS idx_agent_plan_events_task_id
            ON agent_plan_events (task_id, seq);
        CREATE TRIGGER IF NOT EXISTS agent_plan_events_no_update
            BEFORE UPDATE ON agent_plan_events
            BEGIN SELECT RAISE(ABORT, 'agent plan events are append-only'); END;
        CREATE TRIGGER IF NOT EXISTS agent_plan_events_no_delete
            BEFORE DELETE ON agent_plan_events
            BEGIN SELECT RAISE(ABORT, 'agent plan events are append-only'); END;",
    )
    .map_err(|error| format!("agent.db plan migration failed: {error}"))?;
    Ok(())
}

pub(crate) fn open_db() -> Result<Connection, String> {
    let path = data_dir().join("agent.db");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = Connection::open(&path).map_err(|e| format!("agent.db open failed: {e}"))?;
    conn.pragma_update(None, "journal_mode", "WAL").ok();
    conn.busy_timeout(std::time::Duration::from_secs(2))
        .map_err(|e| format!("agent.db busy timeout failed: {e}"))?;
    migrate_connection(&conn)?;
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
                params![
                    id,
                    status,
                    now_ts(),
                    result_text,
                    model_used,
                    tool_calls_json
                ],
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
    let Ok(conn) = open_db() else {
        return Vec::new();
    };
    let cutoff = now_ts() - max_age_secs;
    let Ok(mut stmt) = conn.prepare(
        "SELECT intent_text, result_text FROM agent_tasks
         WHERE status = 'done' AND finished_at >= ?1
           AND result_text IS NOT NULL AND result_text != ''
           AND COALESCE(model_used, '') != 'claude-code-transcript'
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

/// One task by exact id. `agent_turn_result` uses this existing persisted seam
/// so a complete Claude reply remains available after the 600-character phone
/// report-back has been spoken.
pub fn task_by_id(id: &str) -> Option<serde_json::Value> {
    let conn = open_db().ok()?;
    conn.query_row(
        "SELECT id, status, intent_text, result_text, model_used, created_at, finished_at
         FROM agent_tasks WHERE id = ?1",
        params![id],
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
