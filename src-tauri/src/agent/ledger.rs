//! Durable, append-only action history for Symon (#1217).
//!
//! `agent_tasks` remains the conversation-level history. This module records
//! one immutable row per attempted tool action and keeps opaque, single-use
//! inverse tokens in a separate table. Reads never expose inverse payloads.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex, OnceLock,
};

use super::undo::Inverse;

static ACTION_COUNTER: AtomicU64 = AtomicU64::new(0);
static TOKEN_COUNTER: AtomicU64 = AtomicU64::new(0);
static PROCESS_INVALIDATIONS: OnceLock<()> = OnceLock::new();
static CONSUMED_EDIT_IDS: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();

fn consumed_edit_ids() -> &'static Mutex<std::collections::HashSet<String>> {
    CONSUMED_EDIT_IDS.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}

fn edit_inverse_was_consumed(inverse: &Inverse) -> bool {
    let Inverse::RevertEdit { edit_id } = inverse else {
        return false;
    };
    consumed_edit_ids()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .contains(edit_id)
}

fn epoch_nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0)
}

#[derive(Debug)]
pub struct ActionRecord<'a> {
    pub action_id: &'a str,
    pub task_id: &'a str,
    pub source: &'a str,
    pub phase: &'a str,
    pub utterance: Option<&'a str>,
    pub tool: &'a str,
    pub args: &'a Value,
    pub confirmation_id: Option<&'a str>,
    pub confirmation_outcome: &'a str,
    pub outcome: &'a str,
    pub session_id: Option<&'a str>,
    pub call_id: Option<&'a str>,
    pub plan: Option<PlanStepContext<'a>>,
    pub inverse: Option<&'a Inverse>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PlanStepContext<'a> {
    pub plan_id: &'a str,
    /// One-based position in the immutable plan shown to the operator.
    pub step_index: usize,
    pub step_count: usize,
}

#[derive(Debug)]
pub struct PlanLifecycleRecord<'a> {
    pub plan_id: &'a str,
    pub task_id: &'a str,
    pub source: &'a str,
    pub phase: &'a str,
    /// A caller-authored, trusted description. Never pass model args or tool
    /// results here; those can contain note bodies, commands, or form values.
    pub redacted_summary: &'a str,
    pub outcome: &'a str,
    pub session_id: Option<&'a str>,
    /// One-based for step lifecycle events and `None` for plan-level events.
    pub step_index: Option<usize>,
    pub step_count: usize,
}

pub fn next_action_id() -> String {
    format!(
        "action-{}-{}",
        epoch_nanos(),
        ACTION_COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

fn next_undo_token() -> String {
    format!(
        "undo-{}-{}",
        epoch_nanos(),
        TOKEN_COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

fn safe_scalar(value: &Value) -> Option<Value> {
    match value {
        Value::String(value) => Some(json!(value.chars().take(200).collect::<String>())),
        Value::Bool(_) | Value::Number(_) | Value::Null => Some(value.clone()),
        _ => None,
    }
}

/// Persist only tool-specific identifying metadata. Raw model args often hold
/// note bodies, terminal commands, browser form values, email text, or whole
/// CSV row arrays; none of that belongs in the queryable audit summary.
fn args_summary(tool: &str, args: &Value) -> Value {
    let keys: &[&str] = match tool {
        "apply_text_edit" => &[],
        "csv_write" => &["filename"],
        "fs_write_text" | "fs_read_text" => &["path"],
        "mac_calendar_create_event" | "mac_calendar_update_event" => {
            &["title", "calendar_name", "repeat"]
        }
        "mac_notes_create" | "mac_notes_append" => &["title", "folder"],
        "mac_messages_send" => &["recipient"],
        "mac_reminders_create" | "mac_reminders_complete" | "mac_reminders_update" => {
            &["title", "list_name"]
        }
        "o8_dispatch" | "o8_delegate" => &["repoId", "repoPath", "repo"],
        "o8_packet_reset" | "o8_packet_rerun" | "o8_packet_steer" => &["packetId"],
        "o8_agent_task" | "o8_stop_agent" => &["laneId", "packetId"],
        "o8_approve_item" | "o8_reject_item" => &["approvalId"],
        "symon_ledger_undo" => &["action_id"],
        _ => &[],
    };
    let mut summary = serde_json::Map::new();
    for key in keys {
        if let Some(value) = args.get(*key).and_then(safe_scalar) {
            summary.insert((*key).to_string(), value);
        }
    }
    Value::Object(summary)
}

fn result_summary(outcome: &str) -> Value {
    json!({ "status": outcome })
}

fn action_summary(tool: &str, args: &Value, outcome: &str) -> String {
    let string = |key: &str| args.get(key).and_then(Value::as_str).unwrap_or("");
    let subject = match tool {
        "mac_reminders_create" => format!("created reminder '{}'", string("title")),
        "mac_reminders_complete" => format!("completed reminder '{}'", string("title")),
        "mac_reminders_update" => format!("updated reminder '{}'", string("title")),
        "mac_calendar_create_event" => format!("created calendar event '{}'", string("title")),
        "mac_calendar_update_event" => format!("updated calendar event '{}'", string("title")),
        "mac_notes_create" => format!("created note '{}'", string("title")),
        "mac_notes_append" => format!("appended to note '{}'", string("title")),
        "mac_messages_send" => format!("sent a message to '{}'", string("recipient")),
        "symon_memory_remember" => "saved a personal memory".to_string(),
        "symon_memory_suggest" => "proposed a personal memory for review".to_string(),
        "symon_memory_forget" => "forgot a personal memory".to_string(),
        "fs_write_text" => format!("wrote file '{}'", string("path")),
        "csv_write" => format!("wrote CSV '{}'", string("filename")),
        "apply_text_edit" => "edited the focused text".to_string(),
        "o8_dispatch" => {
            let repo = if string("repoPath").is_empty() {
                string("repo")
            } else {
                string("repoPath")
            };
            format!("dispatched work in '{repo}'")
        }
        "symon_ledger_undo" => format!("undid action '{}'", string("action_id")),
        _ => tool.replace('_', " "),
    };
    match outcome {
        "succeeded" => subject,
        "queued" if tool == "o8_dispatch" => {
            let repo = if string("repoPath").is_empty() {
                string("repo")
            } else {
                string("repoPath")
            };
            format!("queued work in '{repo}' pending approval")
        }
        "queued" => format!("{} was queued", tool.replace('_', " ")),
        "pending" => format!("{} was requested", tool.replace('_', " ")),
        "executing" => format!(
            "{} started, but its final outcome was not recorded",
            tool.replace('_', " ")
        ),
        _ => format!("{} did not complete", tool.replace('_', " ")),
    }
}

fn validate_plan_position(
    plan_id: &str,
    step_index: Option<usize>,
    step_count: usize,
) -> Result<(), String> {
    if plan_id.trim().is_empty() {
        return Err("plan id cannot be empty".to_string());
    }
    if !(2..=5).contains(&step_count) {
        return Err("plan step count must be between 2 and 5".to_string());
    }
    if let Some(step_index) = step_index {
        if !(1..=step_count).contains(&step_index) {
            return Err("plan step index must be one-based and within the plan".to_string());
        }
    }
    Ok(())
}

fn record_with_conn(conn: &mut Connection, record: &ActionRecord<'_>) -> Result<(), String> {
    let args_summary = args_summary(record.tool, record.args).to_string();
    let result_summary = result_summary(record.outcome).to_string();
    let utterance = record
        .utterance
        .map(|value| value.chars().take(8_000).collect::<String>());
    let record_inverse = record
        .inverse
        .filter(|inverse| !edit_inverse_was_consumed(inverse));
    let token = record_inverse.map(|_| next_undo_token());
    let inverse_json = record_inverse
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| format!("serialize undo token failed: {error}"))?;
    let (plan_id, plan_step_index, plan_step_count) = if let Some(plan) = record.plan {
        validate_plan_position(plan.plan_id, Some(plan.step_index), plan.step_count)?;
        (
            Some(plan.plan_id),
            Some(plan.step_index as i64),
            Some(plan.step_count as i64),
        )
    } else {
        (None, None, None)
    };
    let tx = conn
        .transaction()
        .map_err(|error| format!("agent action transaction failed: {error}"))?;
    tx.execute(
        "INSERT INTO agent_action_events (
            action_id, task_id, source, created_at, phase, utterance, tool, args_summary,
            confirmation_id, confirmation_outcome, outcome, result_summary,
            undo_token, session_id, call_id, plan_id, plan_step_index, plan_step_count
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                   ?16, ?17, ?18)",
        params![
            record.action_id,
            record.task_id,
            record.source,
            super::store::now_ts(),
            record.phase,
            utterance,
            record.tool,
            args_summary,
            record.confirmation_id,
            record.confirmation_outcome,
            record.outcome,
            result_summary,
            token,
            record.session_id,
            record.call_id,
            plan_id,
            plan_step_index,
            plan_step_count,
        ],
    )
    .map_err(|error| format!("insert agent action failed: {error}"))?;
    if let (Some(token), Some(inverse_json)) = (token.as_deref(), inverse_json.as_deref()) {
        let scope = record_inverse.map(Inverse::scope);
        if scope == Some("edit_buffer") {
            tx.execute(
                "UPDATE agent_undo_tokens SET invalidated_at = ?1
                 WHERE scope = 'edit_buffer' AND claimed_at IS NULL
                   AND consumed_at IS NULL AND invalidated_at IS NULL",
                params![super::store::now_ts()],
            )
            .map_err(|error| format!("invalidate prior edit undo failed: {error}"))?;
        }
        tx.execute(
            "INSERT INTO agent_undo_tokens (
                token, action_id, inverse_json, scope, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                token,
                record.action_id,
                inverse_json,
                scope,
                super::store::now_ts()
            ],
        )
        .map_err(|error| format!("insert agent undo token failed: {error}"))?;
    }
    tx.commit()
        .map_err(|error| format!("commit agent action failed: {error}"))?;
    Ok(())
}

pub fn record(record: ActionRecord<'_>) -> Result<(), String> {
    super::store::open_db().and_then(|mut conn| {
        ensure_process_invalidations(&conn)?;
        record_with_conn(&mut conn, &record)
    })
}

fn record_plan_lifecycle_with_conn(
    conn: &Connection,
    record: &PlanLifecycleRecord<'_>,
) -> Result<(), String> {
    validate_plan_position(record.plan_id, record.step_index, record.step_count)?;
    let redacted_summary = record
        .redacted_summary
        .chars()
        .take(2_000)
        .collect::<String>();
    conn.execute(
        "INSERT INTO agent_plan_events (
            plan_id, task_id, source, created_at, phase, redacted_summary,
            outcome, session_id, step_index, step_count
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            record.plan_id,
            record.task_id,
            record.source,
            super::store::now_ts(),
            record.phase,
            redacted_summary,
            record.outcome,
            record.session_id,
            record.step_index.map(|value| value as i64),
            record.step_count as i64,
        ],
    )
    .map_err(|error| format!("insert agent plan event failed: {error}"))?;
    Ok(())
}

/// Append a trusted, redacted lifecycle checkpoint for one immutable plan.
pub fn record_plan_lifecycle(record: PlanLifecycleRecord<'_>) -> Result<(), String> {
    super::store::open_db().and_then(|conn| record_plan_lifecycle_with_conn(&conn, &record))
}

/// Text-edit inverses point at an in-memory AX/webview restore buffer. They are
/// durable within one running app process, but cannot survive a restart. The
/// first ledger access in each process invalidates only those stale tokens.
fn ensure_process_invalidations_with(
    conn: &Connection,
    initialized: &OnceLock<()>,
) -> Result<(), String> {
    if initialized.get().is_some() {
        return Ok(());
    }
    conn.execute(
        "UPDATE agent_undo_tokens SET invalidated_at = ?1
         WHERE scope = 'edit_buffer' AND claimed_at IS NULL
           AND consumed_at IS NULL AND invalidated_at IS NULL",
        params![super::store::now_ts()],
    )
    .map_err(|error| format!("invalidate stale edit undo tokens failed: {error}"))?;
    let _ = initialized.set(());
    Ok(())
}

fn ensure_process_invalidations(conn: &Connection) -> Result<(), String> {
    ensure_process_invalidations_with(conn, &PROCESS_INVALIDATIONS)
}

fn recent_with_conn(
    conn: &Connection,
    limit: usize,
    session_id: Option<&str>,
) -> Result<Value, String> {
    let mut stmt = conn
        .prepare(
            "WITH latest AS (
                SELECT event.* FROM agent_action_events event
                INNER JOIN (
                    SELECT action_id, MAX(seq) AS seq
                    FROM agent_action_events GROUP BY action_id
                ) terminal ON terminal.seq = event.seq
             )
             SELECT a.action_id, a.created_at, a.utterance, a.tool,
                    a.args_summary, a.confirmation_id, a.confirmation_outcome,
                    a.outcome, a.result_summary, a.source, a.session_id, a.call_id, a.phase,
                    a.plan_id, a.plan_step_index, a.plan_step_count,
                    CASE WHEN u.token IS NOT NULL AND u.claimed_at IS NULL
                                   AND u.consumed_at IS NULL
                                   AND u.invalidated_at IS NULL THEN 1 ELSE 0 END,
                    u.inverse_json
             FROM latest a
             LEFT JOIN agent_undo_tokens u ON u.action_id = a.action_id
             WHERE a.tool != 'symon_ledger_recent'
               AND (?2 IS NULL OR a.session_id = ?2)
             ORDER BY a.created_at DESC, a.seq DESC
             LIMIT ?1",
        )
        .map_err(|error| format!("prepare recent actions failed: {error}"))?;
    let rows = stmt
        .query_map(params![limit.clamp(1, 20) as i64, session_id], |row| {
            let args_text: String = row.get(4)?;
            let result_text: String = row.get(8)?;
            let tool: String = row.get(3)?;
            let outcome: String = row.get(7)?;
            let args = serde_json::from_str::<Value>(&args_text).unwrap_or_else(|_| json!({}));
            let summary = action_summary(&tool, &args, &outcome);
            let plan_id = row.get::<_, Option<String>>(13)?;
            let plan_step_index = row.get::<_, Option<i64>>(14)?;
            let plan_step_count = row.get::<_, Option<i64>>(15)?;
            let sql_undoable = row.get::<_, i64>(16)? == 1;
            let inverse_consumed = row
                .get::<_, Option<String>>(17)?
                .and_then(|text| serde_json::from_str::<Inverse>(&text).ok())
                .as_ref()
                .map(edit_inverse_was_consumed)
                .unwrap_or(false);
            Ok(json!({
                "action_id": row.get::<_, String>(0)?,
                "timestamp": row.get::<_, i64>(1)?,
                "utterance": row.get::<_, Option<String>>(2)?,
                "tool": tool.clone(),
                "args_summary": args,
                "confirmation_id": row.get::<_, Option<String>>(5)?,
                "confirmation": row.get::<_, String>(6)?,
                "outcome": outcome,
                "result_summary": serde_json::from_str::<Value>(&result_text)
                    .unwrap_or_else(|_| json!({})),
                "summary": summary,
                "source": row.get::<_, String>(9)?,
                "session_id": row.get::<_, Option<String>>(10)?,
                "call_id": row.get::<_, Option<String>>(11)?,
                "phase": row.get::<_, String>(12)?,
                "plan": plan_id.map(|plan_id| json!({
                    "plan_id": plan_id,
                    "step_index": plan_step_index,
                    "step_count": plan_step_count,
                })),
                "undoable": sql_undoable && !inverse_consumed,
            }))
        })
        .map_err(|error| format!("query recent actions failed: {error}"))?;
    let actions = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read recent action failed: {error}"))?;
    Ok(json!({ "actions": actions }))
}

pub fn recent(limit: usize, session_id: Option<&str>) -> Result<Value, String> {
    let conn = super::store::open_db()?;
    ensure_process_invalidations(&conn)?;
    recent_with_conn(&conn, limit, session_id)
}

fn plan_history_with_conn(
    conn: &Connection,
    plan_id: &str,
    session_id: Option<&str>,
) -> Result<Value, String> {
    let mut event_statement = conn
        .prepare(
            "SELECT created_at, phase, redacted_summary, outcome, source,
                    session_id, step_index, step_count
             FROM agent_plan_events
             WHERE plan_id = ?1 AND (?2 IS NULL OR session_id = ?2)
             ORDER BY seq ASC",
        )
        .map_err(|error| format!("prepare plan history failed: {error}"))?;
    let events = event_statement
        .query_map(params![plan_id, session_id], |row| {
            Ok(json!({
                "timestamp": row.get::<_, i64>(0)?,
                "phase": row.get::<_, String>(1)?,
                "summary": row.get::<_, String>(2)?,
                "outcome": row.get::<_, String>(3)?,
                "source": row.get::<_, String>(4)?,
                "session_id": row.get::<_, Option<String>>(5)?,
                "step_index": row.get::<_, Option<i64>>(6)?,
                "step_count": row.get::<_, i64>(7)?,
            }))
        })
        .map_err(|error| format!("query plan history failed: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read plan history failed: {error}"))?;

    let mut step_statement = conn
        .prepare(
            "WITH latest AS (
                SELECT event.* FROM agent_action_events event
                INNER JOIN (
                    SELECT action_id, MAX(seq) AS seq
                    FROM agent_action_events
                    WHERE plan_id = ?1
                    GROUP BY action_id
                ) final ON final.seq = event.seq
             )
             SELECT action_id, plan_step_index, plan_step_count, phase, tool,
                    outcome, result_summary, confirmation_outcome
             FROM latest
             WHERE (?2 IS NULL OR session_id = ?2)
             ORDER BY plan_step_index ASC, seq ASC",
        )
        .map_err(|error| format!("prepare plan steps failed: {error}"))?;
    let steps = step_statement
        .query_map(params![plan_id, session_id], |row| {
            let result_summary: String = row.get(6)?;
            Ok(json!({
                "action_id": row.get::<_, String>(0)?,
                "step_index": row.get::<_, i64>(1)?,
                "step_count": row.get::<_, i64>(2)?,
                "phase": row.get::<_, String>(3)?,
                "tool": row.get::<_, String>(4)?,
                "outcome": row.get::<_, String>(5)?,
                "result_summary": serde_json::from_str::<Value>(&result_summary)
                    .unwrap_or_else(|_| json!({})),
                "confirmation": row.get::<_, String>(7)?,
            }))
        })
        .map_err(|error| format!("query plan steps failed: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read plan step failed: {error}"))?;

    Ok(json!({
        "plan_id": plan_id,
        "events": events,
        "steps": steps,
    }))
}

/// Reconstruct one plan from redacted lifecycle checkpoints and the latest
/// durable phase for each linked action. Session-scoped callers cannot cross
/// the same boundary enforced by the action ledger.
pub fn plan_history(plan_id: &str, session_id: Option<&str>) -> Result<Value, String> {
    let conn = super::store::open_db()?;
    plan_history_with_conn(&conn, plan_id, session_id)
}

fn describe_action_with_conn(
    conn: &Connection,
    action_id: &str,
    session_id: Option<&str>,
) -> Option<String> {
    conn.query_row(
        "SELECT tool, args_summary, outcome
         FROM agent_action_events
         WHERE action_id = ?1 AND (?2 IS NULL OR session_id = ?2)
         ORDER BY seq DESC LIMIT 1",
        params![action_id, session_id],
        |row| {
            let tool: String = row.get(0)?;
            let args_text: String = row.get(1)?;
            let outcome: String = row.get(2)?;
            let args = serde_json::from_str::<Value>(&args_text).unwrap_or_else(|_| json!({}));
            Ok(action_summary(&tool, &args, &outcome))
        },
    )
    .optional()
    .ok()
    .flatten()
}

pub fn describe_action(action_id: &str, session_id: Option<&str>) -> Option<String> {
    let conn = super::store::open_db().ok()?;
    ensure_process_invalidations(&conn).ok()?;
    describe_action_with_conn(&conn, action_id, session_id)
}

fn action_in_session(conn: &Connection, action_id: &str, session_id: Option<&str>) -> bool {
    let Some(session_id) = session_id else {
        return true;
    };
    conn.query_row(
        "SELECT 1 FROM agent_action_events
         WHERE action_id = ?1 AND session_id = ?2 LIMIT 1",
        params![action_id, session_id],
        |_| Ok(()),
    )
    .optional()
    .ok()
    .flatten()
    .is_some()
}

fn claim_inverse(conn: &mut Connection, action_id: &str) -> Result<(String, Inverse), String> {
    let tx = conn
        .transaction()
        .map_err(|error| format!("undo transaction failed: {error}"))?;
    let token_and_json = tx
        .query_row(
            "SELECT token, inverse_json FROM agent_undo_tokens
             WHERE action_id = ?1 AND claimed_at IS NULL AND consumed_at IS NULL
               AND invalidated_at IS NULL",
            params![action_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|error| format!("load undo token failed: {error}"))?
        .ok_or_else(|| {
            "That action is not undoable, was superseded, or was already undone".to_string()
        })?;
    let inverse = serde_json::from_str(&token_and_json.1)
        .map_err(|error| format!("stored undo token is invalid: {error}"))?;
    if edit_inverse_was_consumed(&inverse) {
        tx.execute(
            "UPDATE agent_undo_tokens SET invalidated_at = ?2
             WHERE token = ?1 AND claimed_at IS NULL AND consumed_at IS NULL
               AND invalidated_at IS NULL",
            params![token_and_json.0, super::store::now_ts()],
        )
        .map_err(|error| format!("retire consumed edit undo failed: {error}"))?;
        tx.commit()
            .map_err(|error| format!("commit consumed edit retirement failed: {error}"))?;
        return Err("That edit was already reverted from the dock".to_string());
    }
    let changed = tx
        .execute(
            "UPDATE agent_undo_tokens SET claimed_at = ?2
             WHERE token = ?1 AND claimed_at IS NULL AND consumed_at IS NULL
               AND invalidated_at IS NULL",
            params![token_and_json.0, super::store::now_ts()],
        )
        .map_err(|error| format!("claim undo token failed: {error}"))?;
    if changed != 1 {
        return Err("That undo is already in progress".to_string());
    }
    tx.commit()
        .map_err(|error| format!("commit undo claim failed: {error}"))?;
    Ok((token_and_json.0, inverse))
}

enum ClaimFinish {
    Consumed,
    Invalidated,
}

fn finish_claim(token: &str, finish: ClaimFinish) {
    let Ok(conn) = super::store::open_db() else {
        return;
    };
    let result = match finish {
        ClaimFinish::Consumed => conn.execute(
            "UPDATE agent_undo_tokens SET consumed_at = ?2 WHERE token = ?1",
            params![token, super::store::now_ts()],
        ),
        ClaimFinish::Invalidated => conn.execute(
            "UPDATE agent_undo_tokens SET invalidated_at = ?2 WHERE token = ?1",
            params![token, super::store::now_ts()],
        ),
    };
    if let Err(error) = result {
        log::warn!("[symon-ledger] finish undo claim failed: {error}");
    }
}

fn invalidate_edit_inverse_with_conn(conn: &Connection, edit_id: &str) -> Result<usize, String> {
    let mut stmt = conn
        .prepare(
            "SELECT token, inverse_json FROM agent_undo_tokens
             WHERE scope = 'edit_buffer' AND claimed_at IS NULL
               AND consumed_at IS NULL AND invalidated_at IS NULL",
        )
        .map_err(|error| format!("prepare edit undo invalidation failed: {error}"))?;
    let tokens = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("query edit undo invalidation failed: {error}"))?
        .filter_map(Result::ok)
        .filter_map(|(token, inverse_json)| {
            let inverse = serde_json::from_str::<Inverse>(&inverse_json).ok()?;
            matches!(inverse, Inverse::RevertEdit { edit_id: stored } if stored == edit_id)
                .then_some(token)
        })
        .collect::<Vec<_>>();
    drop(stmt);

    let mut invalidated = 0;
    for token in tokens {
        invalidated += conn
            .execute(
                "UPDATE agent_undo_tokens SET invalidated_at = ?2
                 WHERE token = ?1 AND claimed_at IS NULL AND consumed_at IS NULL
                   AND invalidated_at IS NULL",
                params![token, super::store::now_ts()],
            )
            .map_err(|error| format!("invalidate edit undo failed: {error}"))?;
    }
    Ok(invalidated)
}

/// The dock's direct Revert and spoken ledger undo consume the same edit
/// buffer. Retire the durable token when the dock gets there first.
pub fn invalidate_edit_inverse(edit_id: &str) -> Result<bool, String> {
    consumed_edit_ids()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(edit_id.to_string());
    let conn = super::store::open_db()?;
    ensure_process_invalidations(&conn)?;
    invalidate_edit_inverse_with_conn(&conn, edit_id).map(|count| count > 0)
}

pub async fn undo_action(
    action_id: &str,
    session_id: Option<&str>,
    app: &tauri::AppHandle,
) -> Result<Value, String> {
    let (token, inverse) = {
        let mut conn = super::store::open_db()?;
        ensure_process_invalidations(&conn)?;
        if !action_in_session(&conn, action_id, session_id) {
            return Err("That action is not available in this Symon session".to_string());
        }
        claim_inverse(&mut conn, action_id)?
    };
    match super::undo::execute(&inverse, app).await {
        Ok(result) => {
            finish_claim(&token, ClaimFinish::Consumed);
            Ok(json!({
                "undone": true,
                "action_id": action_id,
                "result": result,
            }))
        }
        Err(error) => {
            // A semantic inverse is single-use. If its guarded execution fails
            // (post-state changed, target disappeared, or edit fell back to the
            // clipboard), hide the token instead of advertising a stale undo.
            finish_claim(&token, ClaimFinish::Invalidated);
            Err(error)
        }
    }
}

#[cfg(test)]
#[path = "ledger_tests.rs"]
mod tests;
