//! Tests for the durable Symon action ledger.

use super::*;

fn memory_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    super::super::store::migrate_connection(&conn).unwrap();
    conn
}

#[test]
fn migration_keeps_legacy_task_history() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE agent_tasks (
                id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, finished_at INTEGER,
                status TEXT NOT NULL DEFAULT 'queued', intent_text TEXT NOT NULL,
                model_used TEXT, tool_calls_json TEXT, result_text TEXT
             );
             INSERT INTO agent_tasks (id, created_at, status, intent_text)
             VALUES ('legacy', 1, 'done', 'old request');",
    )
    .unwrap();
    super::super::store::migrate_connection(&conn).unwrap();
    let intent: String = conn
        .query_row(
            "SELECT intent_text FROM agent_tasks WHERE id = 'legacy'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(intent, "old request");
}

#[test]
fn migration_adds_plan_linkage_without_rewriting_legacy_actions() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE agent_action_events (
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
            call_id TEXT
         );
         INSERT INTO agent_action_events (
            action_id, task_id, source, created_at, phase, tool, args_summary,
            confirmation_outcome, outcome, result_summary
         ) VALUES (
            'legacy-action', 'legacy-task', 'cascaded', 1, 'terminal',
            'open_app', '{}', 'not_required', 'succeeded', '{\"status\":\"succeeded\"}'
         );
         CREATE TRIGGER agent_action_events_no_update
            BEFORE UPDATE ON agent_action_events
            BEGIN SELECT RAISE(ABORT, 'agent action events are append-only'); END;
         CREATE TRIGGER agent_action_events_no_delete
            BEFORE DELETE ON agent_action_events
            BEGIN SELECT RAISE(ABORT, 'agent action events are append-only'); END;",
    )
    .unwrap();

    super::super::store::migrate_connection(&conn).unwrap();
    let legacy: (String, Option<String>, Option<i64>, Option<i64>) = conn
        .query_row(
            "SELECT action_id, plan_id, plan_step_index, plan_step_count
             FROM agent_action_events WHERE action_id = 'legacy-action'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(legacy, ("legacy-action".to_string(), None, None, None));

    // The migration is idempotent and does not duplicate or rewrite history.
    super::super::store::migrate_connection(&conn).unwrap();
    let row_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM agent_action_events", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(row_count, 1);
}

#[test]
fn linked_plan_steps_and_lifecycle_can_be_reconstructed_without_raw_args() {
    let mut conn = memory_db();
    for (phase, summary, outcome, step_index) in [
        ("proposed", "Two-step Notes plan", "pending", None),
        ("approved", "Two-step Notes plan", "approved", None),
        (
            "step_completed",
            "Step 1 of 2 completed",
            "succeeded",
            Some(1),
        ),
        (
            "step_completed",
            "Step 2 of 2 completed",
            "succeeded",
            Some(2),
        ),
        (
            "completed",
            "Both approved steps completed",
            "succeeded",
            None,
        ),
    ] {
        record_plan_lifecycle_with_conn(
            &conn,
            &PlanLifecycleRecord {
                plan_id: "plan-one",
                task_id: "task-one",
                source: "desktop_realtime",
                phase,
                redacted_summary: summary,
                outcome,
                session_id: Some("session-one"),
                step_index,
                step_count: 2,
            },
        )
        .unwrap();
    }

    for (action_id, step_index, tool, args) in [
        (
            "action-plan-one",
            1,
            "mac_notes_create",
            json!({ "title": "Trip", "body": "private itinerary" }),
        ),
        (
            "action-plan-two",
            2,
            "mac_notes_append",
            json!({ "title": "Trip", "text": "secret confirmation number" }),
        ),
    ] {
        record_with_conn(
            &mut conn,
            &ActionRecord {
                action_id,
                task_id: "task-one",
                source: "desktop_realtime",
                phase: "terminal",
                utterance: None,
                tool,
                args: &args,
                confirmation_id: Some("plan-confirm"),
                confirmation_outcome: "approved",
                outcome: "succeeded",
                session_id: Some("session-one"),
                call_id: None,
                plan: Some(PlanStepContext {
                    plan_id: "plan-one",
                    step_index,
                    step_count: 2,
                }),
                inverse: None,
            },
        )
        .unwrap();
    }

    let history = plan_history_with_conn(&conn, "plan-one", Some("session-one")).unwrap();
    assert_eq!(history["events"].as_array().unwrap().len(), 5);
    assert_eq!(history["events"][2]["step_index"], 1);
    assert_eq!(history["steps"].as_array().unwrap().len(), 2);
    assert_eq!(history["steps"][0]["step_index"], 1);
    assert_eq!(history["steps"][1]["tool"], "mac_notes_append");
    let encoded = history.to_string();
    assert!(!encoded.contains("private itinerary"));
    assert!(!encoded.contains("secret confirmation number"));

    let recent = recent_with_conn(&conn, 2, Some("session-one")).unwrap();
    assert_eq!(recent["actions"][0]["plan"]["plan_id"], "plan-one");
    assert_eq!(recent["actions"][0]["plan"]["step_index"], 2);
    assert_eq!(recent["actions"][1]["plan"]["step_count"], 2);
    assert!(
        plan_history_with_conn(&conn, "plan-one", Some("another-session")).unwrap()["events"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        plan_history_with_conn(&conn, "plan-one", Some("another-session")).unwrap()["steps"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn plan_lifecycle_is_append_only_and_rejects_invalid_positions() {
    let conn = memory_db();
    let record = PlanLifecycleRecord {
        plan_id: "plan-two",
        task_id: "task-two",
        source: "cascaded",
        phase: "step_started",
        redacted_summary: "Step 1 of 2 started",
        outcome: "executing",
        session_id: None,
        step_index: Some(1),
        step_count: 2,
    };
    record_plan_lifecycle_with_conn(&conn, &record).unwrap();
    assert!(conn
        .execute(
            "UPDATE agent_plan_events SET outcome = 'succeeded' WHERE plan_id = 'plan-two'",
            [],
        )
        .is_err());
    assert!(conn
        .execute(
            "DELETE FROM agent_plan_events WHERE plan_id = 'plan-two'",
            []
        )
        .is_err());

    let invalid = PlanLifecycleRecord {
        step_index: Some(3),
        ..record
    };
    assert!(record_plan_lifecycle_with_conn(&conn, &invalid)
        .unwrap_err()
        .contains("within the plan"));
}

#[test]
fn transient_process_invalidation_failure_can_retry() {
    let conn = Connection::open_in_memory().unwrap();
    let initialized = OnceLock::new();
    assert!(ensure_process_invalidations_with(&conn, &initialized).is_err());
    super::super::store::migrate_connection(&conn).unwrap();
    assert!(ensure_process_invalidations_with(&conn, &initialized).is_ok());
    assert!(initialized.get().is_some());
}

#[test]
fn action_rows_are_redacted_and_report_undoability() {
    let mut conn = memory_db();
    let inverse = Inverse::RestoreFile {
        path: "/tmp/example".to_string(),
        existed: false,
        previous_base64: String::new(),
        expected_sha256: "abc".to_string(),
        created_dirs: Vec::new(),
    };
    record_with_conn(
        &mut conn,
        &ActionRecord {
            action_id: "action-1",
            task_id: "task-1",
            source: "phone_realtime",
            phase: "terminal",
            utterance: Some("write that down"),
            tool: "fs_write_text",
            args: &json!({ "path": "/tmp/example", "content": "private words" }),
            confirmation_id: Some("confirm-1"),
            confirmation_outcome: "approved",
            outcome: "succeeded",
            session_id: Some("session-1"),
            call_id: Some("call-1"),
            plan: None,
            inverse: Some(&inverse),
        },
    )
    .unwrap();
    let recent = recent_with_conn(&conn, 5, None).unwrap();
    let action = &recent["actions"][0];
    assert!(action["args_summary"].get("content").is_none());
    assert_eq!(action["args_summary"]["path"], "/tmp/example");
    assert_eq!(action["undoable"], true);
    assert_eq!(action["confirmation"], "approved");
    assert_eq!(action["source"], "phone_realtime");
    assert_eq!(action["session_id"], "session-1");
    assert_eq!(action["call_id"], "call-1");
    assert_eq!(
        describe_action_with_conn(&conn, "action-1", None).as_deref(),
        Some("wrote file '/tmp/example'")
    );
}

#[test]
fn undo_tokens_can_only_be_claimed_once() {
    let mut conn = memory_db();
    let inverse = Inverse::RestoreFile {
        path: "/tmp/example".to_string(),
        existed: false,
        previous_base64: String::new(),
        expected_sha256: "abc".to_string(),
        created_dirs: Vec::new(),
    };
    record_with_conn(
        &mut conn,
        &ActionRecord {
            action_id: "action-2",
            task_id: "task-2",
            source: "desktop_realtime",
            phase: "terminal",
            utterance: None,
            tool: "fs_write_text",
            args: &json!({ "path": "/tmp/example" }),
            confirmation_id: None,
            confirmation_outcome: "not_required",
            outcome: "succeeded",
            session_id: None,
            call_id: None,
            plan: None,
            inverse: Some(&inverse),
        },
    )
    .unwrap();
    assert!(claim_inverse(&mut conn, "action-2").is_ok());
    assert!(claim_inverse(&mut conn, "action-2").is_err());
}

#[test]
fn action_events_are_append_only() {
    let conn = memory_db();
    conn.execute(
        "INSERT INTO agent_action_events (
                action_id, task_id, source, created_at, phase, tool, args_summary,
                confirmation_outcome, outcome, result_summary
             ) VALUES ('a', 't', 'cascaded', 1, 'attempted', 'open_app', '{}',
                       'pending', 'pending', '{\"status\":\"pending\"}')",
        [],
    )
    .unwrap();
    assert!(conn
        .execute(
            "UPDATE agent_action_events SET outcome = 'succeeded' WHERE action_id = 'a'",
            [],
        )
        .is_err());
    assert!(conn
        .execute("DELETE FROM agent_action_events WHERE action_id = 'a'", [])
        .is_err());
}

#[test]
fn recent_reports_latest_durable_phase_when_terminal_event_is_missing() {
    let mut conn = memory_db();
    for (phase, outcome) in [("attempted", "pending"), ("executing", "executing")] {
        record_with_conn(
            &mut conn,
            &ActionRecord {
                action_id: "action-crashed",
                task_id: "task-crashed",
                source: "cascaded",
                phase,
                utterance: Some("open Notes"),
                tool: "open_app",
                args: &json!({ "name": "Notes" }),
                confirmation_id: None,
                confirmation_outcome: "not_required",
                outcome,
                session_id: None,
                call_id: None,
                plan: None,
                inverse: None,
            },
        )
        .unwrap();
    }
    let recent = recent_with_conn(&conn, 5, None).unwrap();
    assert_eq!(recent["actions"][0]["phase"], "executing");
    assert_eq!(recent["actions"][0]["outcome"], "executing");
    assert_eq!(recent["actions"].as_array().unwrap().len(), 1);
}

#[test]
fn phone_sessions_cannot_read_or_describe_each_others_actions() {
    let mut conn = memory_db();
    for (action_id, session_id) in [("action-one", "session-one"), ("action-two", "session-two")] {
        record_with_conn(
            &mut conn,
            &ActionRecord {
                action_id,
                task_id: action_id,
                source: "phone_realtime",
                phase: "terminal",
                utterance: None,
                tool: "open_app",
                args: &json!({ "name": "Notes" }),
                confirmation_id: None,
                confirmation_outcome: "not_required",
                outcome: "succeeded",
                session_id: Some(session_id),
                call_id: None,
                plan: None,
                inverse: None,
            },
        )
        .unwrap();
    }
    let recent = recent_with_conn(&conn, 5, Some("session-one")).unwrap();
    assert_eq!(recent["actions"].as_array().unwrap().len(), 1);
    assert_eq!(recent["actions"][0]["action_id"], "action-one");
    assert!(describe_action_with_conn(&conn, "action-two", Some("session-one")).is_none());
    assert!(!action_in_session(&conn, "action-two", Some("session-one")));
}

#[test]
fn direct_edit_revert_retires_the_matching_ledger_token() {
    let mut conn = memory_db();
    let inverse = Inverse::RevertEdit {
        edit_id: "edit-one".to_string(),
    };
    record_with_conn(
        &mut conn,
        &ActionRecord {
            action_id: "action-edit",
            task_id: "task-edit",
            source: "cascaded",
            phase: "terminal",
            utterance: None,
            tool: "apply_text_edit",
            args: &json!({}),
            confirmation_id: None,
            confirmation_outcome: "not_required",
            outcome: "succeeded",
            session_id: None,
            call_id: None,
            plan: None,
            inverse: Some(&inverse),
        },
    )
    .unwrap();
    assert_eq!(
        recent_with_conn(&conn, 1, None).unwrap()["actions"][0]["undoable"],
        true
    );
    assert_eq!(
        invalidate_edit_inverse_with_conn(&conn, "edit-one").unwrap(),
        1
    );
    assert_eq!(
        recent_with_conn(&conn, 1, None).unwrap()["actions"][0]["undoable"],
        false
    );
}

#[test]
fn direct_edit_revert_before_terminal_record_never_mints_a_stale_token() {
    let mut conn = memory_db();
    let edit_id = "edit-consumed-before-terminal";
    consumed_edit_ids()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(edit_id.to_string());
    let inverse = Inverse::RevertEdit {
        edit_id: edit_id.to_string(),
    };
    record_with_conn(
        &mut conn,
        &ActionRecord {
            action_id: "action-consumed-edit",
            task_id: "task-consumed-edit",
            source: "cascaded",
            phase: "terminal",
            utterance: None,
            tool: "apply_text_edit",
            args: &json!({}),
            confirmation_id: None,
            confirmation_outcome: "not_required",
            outcome: "succeeded",
            session_id: None,
            call_id: None,
            plan: None,
            inverse: Some(&inverse),
        },
    )
    .unwrap();
    assert_eq!(
        recent_with_conn(&conn, 1, None).unwrap()["actions"][0]["undoable"],
        false
    );
}

#[test]
fn consumed_edit_is_hidden_and_unclaimable_after_db_invalidation_failure() {
    let mut conn = memory_db();
    let edit_id = "edit-consumed-after-terminal";
    let inverse = Inverse::RevertEdit {
        edit_id: edit_id.to_string(),
    };
    record_with_conn(
        &mut conn,
        &ActionRecord {
            action_id: "action-consumed-after-terminal",
            task_id: "task-consumed-after-terminal",
            source: "cascaded",
            phase: "terminal",
            utterance: None,
            tool: "apply_text_edit",
            args: &json!({}),
            confirmation_id: None,
            confirmation_outcome: "not_required",
            outcome: "succeeded",
            session_id: None,
            call_id: None,
            plan: None,
            inverse: Some(&inverse),
        },
    )
    .unwrap();
    consumed_edit_ids()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(edit_id.to_string());

    assert_eq!(
        recent_with_conn(&conn, 1, None).unwrap()["actions"][0]["undoable"],
        false
    );
    assert!(claim_inverse(&mut conn, "action-consumed-after-terminal")
        .unwrap_err()
        .contains("already reverted"));
}

#[test]
fn orchestrator_dispatch_summary_names_the_repo() {
    assert_eq!(
        action_summary(
            "o8_dispatch",
            &json!({ "repoPath": "/Users/operator/o8" }),
            "succeeded",
        ),
        "dispatched work in '/Users/operator/o8'"
    );
    assert_eq!(
        action_summary("o8_dispatch", &json!({ "repo": "o8" }), "succeeded"),
        "dispatched work in 'o8'"
    );
    assert_eq!(
        action_summary(
            "o8_dispatch",
            &json!({ "repoPath": "/Users/operator/o8" }),
            "queued",
        ),
        "queued work in '/Users/operator/o8' pending approval"
    );
}
