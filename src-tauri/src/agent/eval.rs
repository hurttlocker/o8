//! Symon agent — live model-eval harness (the moat, PR4).
//!
//! Honors the operator bar "build it to see what gives best performance" with a
//! SMALL, LIVE probe — not a mocked scoreboard. Runs a handful of READ-ONLY
//! commands (no side effects, no confirm-gating, safe to repeat) through the
//! REAL agent loop (`run_loop` → real model → real o8 HTTP / osascript reads)
//! for each model in a matrix, scoring two things that match the actual product
//! bar:
//!   1. tool_correct — did the loop pick the expected tool?
//!   2. latency_ms   — wall-clock for the real round-trip.
//! The winner flips `mac_native_action` in `~/.o8/agent_models.json`.
//!
//! Triggered by the `agent_eval` Tauri command. Writes the markdown scoreboard
//! to `~/.o8/agent-eval-latest.md` and returns it.

use super::{router, TaskCtx};
use std::time::Instant;

struct Fixture {
    label: &'static str,
    intent: &'static str,
    /// Tool we expect the loop to call. `None` = should answer WITHOUT a tool
    /// (chat / straight from the system prompt).
    expected_tool: Option<&'static str>,
}

/// The ~10 read-only commands the operator would actually say. All side-effect
/// free, so the harness is safe to run as often as we like.
fn fixtures() -> Vec<Fixture> {
    vec![
        Fixture { label: "whats-shipping", intent: "What's shipping right now?", expected_tool: Some("o8_status") },
        Fixture { label: "agents-in-repo", intent: "What are my agents working on in o8?", expected_tool: Some("o8_status") },
        Fixture { label: "ask-brain", intent: "What did Codex do today?", expected_tool: Some("o8_ask") },
        Fixture { label: "open-prs", intent: "Any open pull requests on o8?", expected_tool: Some("gh_pr_list") },
        Fixture { label: "open-issues", intent: "What issues are open on o8?", expected_tool: Some("gh_issue_list") },
        Fixture { label: "git-status", intent: "What's the git status of o8?", expected_tool: Some("git_status") },
        Fixture { label: "recent-commits", intent: "What are the recent commits on o8?", expected_tool: Some("git_log") },
        Fixture { label: "list-reminders", intent: "What's on my reminders list?", expected_tool: Some("mac_reminders_list") },
        Fixture { label: "calendar", intent: "What's on my calendar this week?", expected_tool: Some("mac_calendar_list_events") },
        Fixture { label: "chat-time", intent: "What time is it right now?", expected_tool: None },
    ]
}

/// Run the eval over `models` (empty → just the configured brain), returning a
/// markdown scoreboard that's also persisted to `~/.o8/agent-eval-latest.md`.
pub async fn run_eval(app: tauri::AppHandle, models: Vec<String>) -> String {
    let models = if models.is_empty() {
        vec![router::load_config().mac_native_action]
    } else {
        models
    };
    let fx = fixtures();

    let mut report = String::new();
    report.push_str("# Symon model eval — live round-trip\n\n");
    report.push_str(&format!(
        "Fixtures: {} · Models: {}\n\n",
        fx.len(),
        models.join(", ")
    ));

    for model in &models {
        report.push_str(&format!("## {model}\n\n"));
        report.push_str("| fixture | expected | called | result | latency |\n");
        report.push_str("|---|---|---|---|---|\n");

        let mut correct = 0usize;
        let mut total_ms = 0u128;

        for (i, f) in fx.iter().enumerate() {
            let ctx = TaskCtx {
                task_id: format!("eval-{i}-{model}"),
                utterance: f.intent.to_string(),
                ledger_session_id: None,
                app: Some(app.clone()),
                screen: None,
                spatial: false,
                crop_png_base64: None,
                edit: None,
                cancel: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            };
            let started = Instant::now();
            let result = if model.contains('/') {
                super::openrouter::run_loop(model, f.intent, &ctx).await
            } else {
                super::gemini::run_loop(model, f.intent, &ctx).await
            };
            let ms = started.elapsed().as_millis();
            total_ms += ms;

            let (called, ok) = match &result {
                Ok(r) => {
                    let first = first_tool(&r.tool_calls_json);
                    let ok = match f.expected_tool {
                        Some(exp) => first.as_deref() == Some(exp),
                        None => first.is_none(),
                    };
                    (first.unwrap_or_else(|| "—".into()), ok)
                }
                Err(e) => (format!("ERR: {}", crate::utf8_head(&e, 40)), false),
            };
            if ok {
                correct += 1;
            }
            report.push_str(&format!(
                "| {} | {} | {} | {} | {}ms |\n",
                f.label,
                f.expected_tool.unwrap_or("(none)"),
                called,
                if ok { "PASS" } else { "FAIL" },
                ms,
            ));
        }

        let n = fx.len().max(1) as u128;
        report.push_str(&format!(
            "\n**tool-correct: {}/{} ({}%) · avg latency: {}ms**\n\n",
            correct,
            fx.len(),
            correct as u128 * 100 / n,
            total_ms / n,
        ));
    }

    let path = super::agent_data_dir().join("agent-eval-latest.md");
    let _ = std::fs::write(&path, &report);
    report
}

/// First tool name from a `[{tool,args}]` JSON log, if any.
fn first_tool(tool_calls_json: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(tool_calls_json).ok()?;
    v.as_array()?
        .first()?
        .get("tool")?
        .as_str()
        .map(|s| s.to_string())
}
