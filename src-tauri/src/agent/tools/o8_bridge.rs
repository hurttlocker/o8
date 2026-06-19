//! Symon Tier-2 tools — the o8 bridge (the moat).
//!
//! These let Symon (the voice life-layer) read what o8's autonomous coding
//! agents are doing and ask o8's Engineering Brain — by calling o8's own
//! loopback API via `super::super::o8_http`, the same routes the operator MCP
//! wraps. Read-through only (PR1): no mission state is cached here. Gated WRITE
//! delegation (`o8_dispatch`) lands in PR2.
//!
//! Decision rule for the whole bridge: *if it mutates a git repo → it's the
//! orchestrator's job (delegate); everything else Symon does directly.* These
//! read tools never mutate, so they're tagged ReadOnly in `super::super::safety`.

use crate::agent::o8_http;
use serde_json::{json, Value};

/// `o8_status` — what's shipping / in progress across the fleet right now.
///
/// Reads the active lanes (the same data the tray + AgentPanel use) and projects
/// a compact list the model can speak. Optional `repo` filter (substring match
/// on the repo folder name) scopes it to one project.
pub async fn status(args: Value) -> Result<Value, String> {
    let repo_filter = args
        .get("repo")
        .and_then(|v| v.as_str())
        .map(|s| s.to_lowercase());

    let resp = o8_http::get_json("/api/lanes?active=true").await?;
    let lanes = resp
        .get("lanes")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut items: Vec<Value> = Vec::new();
    for lane in &lanes {
        let repo_path = lane.get("repoPath").and_then(|v| v.as_str()).unwrap_or("");
        let repo = repo_path
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or("")
            .to_string();
        if let Some(ref f) = repo_filter {
            if !repo.to_lowercase().contains(f) {
                continue;
            }
        }
        items.push(json!({
            "label": lane.get("label").and_then(|v| v.as_str()).unwrap_or("Untitled"),
            "status": lane.get("status").and_then(|v| v.as_str()).unwrap_or("unknown"),
            "repo": repo,
            "runtime": lane.get("runtime").and_then(|v| v.as_str()).unwrap_or(""),
            "branch": lane.get("branch").and_then(|v| v.as_str()).unwrap_or(""),
        }));
    }

    Ok(json!({
        "active_count": items.len(),
        "lanes": items,
    }))
}

/// Lane states that won't move without the operator (or at least someone)
/// looking — the "needs attention" half of `o8_needs_me`. Mirrors `LaneStatus`
/// in `src/lib/lane/types.ts`.
const ATTENTION_STATUSES: &[&str] = &[
    "awaiting_input",
    "awaiting_orchestrator",
    "recovering",
    "reviewing",
    "failed",
];

/// `o8_needs_me` — everything waiting on the OPERATOR right now (magic
/// roadmap #2: voice approval triage). Two signals, both read-through:
/// pending approval cards (`/api/panel/approvals`) and lanes stuck in an
/// attention state (`/api/lanes?active=true`). Projects a compact,
/// spoken-friendly list; the model reads exact titles from here before any
/// `o8_approve_item` / `o8_reject_item` call.
pub async fn needs_me(_args: Value) -> Result<Value, String> {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let resp = o8_http::get_json("/api/panel/approvals").await?;
    let approvals = resp
        .get("approvals")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut cards: Vec<Value> = Vec::new();
    for a in &approvals {
        let title = a.get("title").and_then(|v| v.as_str()).unwrap_or("Untitled");
        let summary = a.get("summary").and_then(|v| v.as_str()).unwrap_or("");
        let mut card = json!({
            "title": title,
            "agent": a.get("agent").and_then(|v| v.as_str()).unwrap_or(""),
            "risk": a.get("risk").and_then(|v| v.as_str()).unwrap_or("low"),
            "summary": summary.chars().take(160).collect::<String>(),
        });
        // createdAt is a ms epoch — surface age so the model can say "from
        // twenty minutes ago". Guard the range so a seconds-epoch or zero
        // value never produces a nonsense age.
        if let Some(created) = a.get("createdAt").and_then(|v| v.as_i64()) {
            if created > 1_000_000_000_000 && now_ms > created {
                card["age_minutes"] = json!((now_ms - created) / 60_000);
            }
        }
        cards.push(card);
    }

    let lanes_resp = o8_http::get_json("/api/lanes?active=true").await?;
    let lanes = lanes_resp
        .get("lanes")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut stuck: Vec<Value> = Vec::new();
    for lane in &lanes {
        let status = lane.get("status").and_then(|v| v.as_str()).unwrap_or("");
        if !ATTENTION_STATUSES.contains(&status) {
            continue;
        }
        let repo_path = lane.get("repoPath").and_then(|v| v.as_str()).unwrap_or("");
        let repo = repo_path.trim_end_matches('/').rsplit('/').next().unwrap_or("");
        stuck.push(json!({
            "label": lane.get("label").and_then(|v| v.as_str()).unwrap_or("Untitled"),
            "status": status,
            "repo": repo,
        }));
    }

    let all_clear = cards.is_empty() && stuck.is_empty();
    let mut out = json!({
        "approval_count": cards.len(),
        "approvals": cards,
        "attention_count": stuck.len(),
        "attention_lanes": stuck,
    });
    if all_clear {
        out["note"] = json!("Nothing is waiting on the user right now.");
    }
    Ok(out)
}

/// Resolve a spoken/near title to exactly one PENDING approval `(id, title)`.
///
/// The agent loop is stateless between asks, so the id can't be remembered —
/// it has to re-resolve against the live queue at decision time (which also
/// means an approval resolved elsewhere in the meantime is a safe miss, not a
/// double-fire). Ladder: exact case-insensitive title → title substring →
/// summary/agent substring. Anything other than exactly one match errors with
/// a spoken-friendly message the model relays.
async fn resolve_pending_approval(which: &str) -> Result<(String, String), String> {
    let resp = o8_http::get_json("/api/panel/approvals").await?;
    let approvals = resp
        .get("approvals")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let pending: Vec<(String, String, String, String)> = approvals
        .iter()
        .filter_map(|a| {
            let id = a.get("id").and_then(|v| v.as_str())?.to_string();
            let title = a.get("title").and_then(|v| v.as_str()).unwrap_or("Untitled").to_string();
            let summary = a.get("summary").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
            let agent = a.get("agent").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
            Some((id, title, summary, agent))
        })
        .collect();

    if pending.is_empty() {
        return Err("There are no pending approvals in o8 right now.".into());
    }

    let needle = which.trim().to_lowercase();
    if needle.is_empty() {
        if pending.len() == 1 {
            let (id, title, _, _) = pending.into_iter().next().unwrap();
            return Ok((id, title));
        }
        let titles: Vec<&str> = pending.iter().take(3).map(|(_, t, _, _)| t.as_str()).collect();
        return Err(format!(
            "There are {} pending approvals — say which one: {}.",
            pending.len(),
            titles.join("; ")
        ));
    }

    if let Some((id, title, _, _)) = pending.iter().find(|(_, t, _, _)| t.to_lowercase() == needle) {
        return Ok((id.clone(), title.clone()));
    }

    let mut matches: Vec<&(String, String, String, String)> = pending
        .iter()
        .filter(|(_, t, _, _)| t.to_lowercase().contains(&needle))
        .collect();
    if matches.is_empty() {
        matches = pending
            .iter()
            .filter(|(_, _, s, a)| s.contains(&needle) || a.contains(&needle))
            .collect();
    }

    match matches.len() {
        1 => {
            let (id, title, _, _) = matches[0];
            Ok((id.clone(), title.clone()))
        }
        0 => {
            let titles: Vec<&str> = pending.iter().take(3).map(|(_, t, _, _)| t.as_str()).collect();
            Err(format!(
                "Nothing pending matches '{which}'. The queue has: {}.",
                titles.join("; ")
            ))
        }
        _ => {
            let titles: Vec<&str> = matches.iter().take(3).map(|(_, t, _, _)| t.as_str()).collect();
            Err(format!(
                "'{which}' matches more than one pending approval — say which: {}.",
                titles.join("; ")
            ))
        }
    }
}

/// `o8_approve_item` — approve one pending o8 approval card by (near-)title.
/// Reversible in `super::super::safety`, so the loop speaks the proposal and
/// shows the dock confirm card BEFORE this runs — the card is the binding
/// gate; this just executes the operator's decision against the same endpoint
/// the desktop Approve button uses.
pub async fn approve_item(args: Value) -> Result<Value, String> {
    let which = args.get("title").and_then(|v| v.as_str()).unwrap_or("");
    let (id, title) = resolve_pending_approval(which).await?;

    let resp = o8_http::post_json(
        "/api/panel/approvals",
        json!({ "action": "approve", "id": id }),
    )
    .await?;
    if resp.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        let err = resp.get("error").and_then(|v| v.as_str()).unwrap_or("o8 returned an error");
        return Err(format!("Couldn't approve \u{201c}{title}\u{201d}: {err}"));
    }

    Ok(json!({
        "approved": true,
        "title": title,
        "note": resp.get("note").and_then(|v| v.as_str()).unwrap_or(""),
    }))
}

/// `o8_reject_item` — reject one pending o8 approval card by (near-)title.
/// Same resolve + gate story as `o8_approve_item`. The optional spoken reason
/// rides the request body for the audit trail.
pub async fn reject_item(args: Value) -> Result<Value, String> {
    let which = args.get("title").and_then(|v| v.as_str()).unwrap_or("");
    let (id, title) = resolve_pending_approval(which).await?;

    let mut body = json!({ "action": "reject", "id": id });
    if let Some(reason) = args
        .get("reason")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
    {
        body["reason"] = json!(reason.trim());
    }

    let resp = o8_http::post_json("/api/panel/approvals", body).await?;
    if resp.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        let err = resp.get("error").and_then(|v| v.as_str()).unwrap_or("o8 returned an error");
        return Err(format!("Couldn't reject \u{201c}{title}\u{201d}: {err}"));
    }

    Ok(json!({
        "rejected": true,
        "title": title,
        "note": resp.get("note").and_then(|v| v.as_str()).unwrap_or(""),
    }))
}

/// `o8_ask` — ask o8's Engineering Brain about the code, recent work, or the
/// fleet ("what did Codex do today?", "how does dispatch work?"). POSTs to the
/// same Brain Q&A endpoint as the desktop "Ask the Brain" composer + the
/// `cortex_ask` MCP tool. Returns the synthesized answer to speak.
pub async fn ask(args: Value) -> Result<Value, String> {
    let question = args
        .get("question")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if question.is_empty() {
        return Err("o8_ask needs a 'question'".into());
    }

    let mut body = json!({ "question": question });
    if let Some(repo) = args
        .get("repo_path")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        body["repoPath"] = json!(repo);
    }

    let resp = o8_http::post_json_timeout("/api/cortex/ask/answer", body, 90).await?;
    if resp.get("ok").and_then(|v| v.as_bool()) == Some(false) {
        let err = resp
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("the Brain returned an error");
        return Err(err.to_string());
    }

    let answer = resp
        .get("answer")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    // Sources-parity pass (2026-06-11): keep the titled citations instead of
    // collapsing them to a count. The model can name its sources naturally
    // ("per the CLAUDE.md critical-rules directive…"), and the agent loop
    // forwards them to the dock answer panel.
    let sources: Vec<Value> = resp
        .get("citations")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .take(5)
                .map(|c| {
                    let mut s = json!({
                        "kind": c.get("kind").and_then(|v| v.as_str()).unwrap_or("source"),
                        "title": c
                            .get("title")
                            .and_then(|v| v.as_str())
                            .unwrap_or_else(|| c.get("rowId").and_then(|v| v.as_str()).unwrap_or("")),
                    });
                    if let Some(url) = c.get("url").and_then(|v| v.as_str()) {
                        s["url"] = json!(url);
                    }
                    s
                })
                .collect()
        })
        .unwrap_or_default();
    let sources_considered = resp
        .get("sourcesConsidered")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);

    Ok(json!({
        "answer": answer,
        "sources": sources,
        "sources_considered": sources_considered,
    }))
}

/// `o8_dispatch` — delegate a CODING task to o8's orchestrator (Tier-2 WRITE).
///
/// Symon is not the coder: this hands the work to the orchestrator, which spawns
/// an isolated Codex worker, reviews the diff, and surfaces a packet for the
/// operator's approval. Tagged Reversible in `super::super::safety`, so the loop
/// fires a SPOKEN proposal + dock confirm card BEFORE this runs — closing the
/// governance gap where `/api/orchestrator/delegate` would otherwise launch a
/// worker pre-approval. A misheard / unknown repo is a safe no-op error: nothing
/// is dispatched until the repo resolves to a registered path.
pub async fn dispatch(args: Value) -> Result<Value, String> {
    let repo = args.get("repo").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let task = args.get("task").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if repo.is_empty() || task.is_empty() {
        return Err("o8_dispatch needs a 'repo' and a 'task'".into());
    }

    let repo_path = resolve_repo_path(&repo).await?;

    let mut body = json!({
        "prompt": task,
        "repoPath": repo_path,
        "taskName": task.chars().take(60).collect::<String>(),
    });
    if let Some(base) = args
        .get("base_branch")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        body["baseBranch"] = json!(base);
    }

    let resp = o8_http::post_json("/api/orchestrator/delegate", body).await?;
    let ok = resp.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    let packet_id = resp.get("packetId").and_then(|v| v.as_str()).unwrap_or("");
    let lane_id = resp.get("laneId").and_then(|v| v.as_str()).unwrap_or("");
    let note = resp.get("note").and_then(|v| v.as_str()).unwrap_or("");

    if !ok {
        // 202 path: launch is queued behind a policy gate / approval card.
        let approval = resp.get("approvalId").and_then(|v| v.as_str()).unwrap_or("");
        return Ok(json!({
            "dispatched": false,
            "packet_id": packet_id,
            "approval_id": approval,
            "note": if note.is_empty() { "The orchestrator queued the task pending approval." } else { note },
        }));
    }

    // Wake the worker-pulse poller so the dock's orbit + count appears within
    // ~2s of the dispatch instead of the next scheduled poll.
    crate::agent::worker_pulse::nudge();

    Ok(json!({
        "dispatched": true,
        "packet_id": packet_id,
        "lane_id": lane_id,
        "repo": repo,
    }))
}

/// `o8_recap` — what happened across the fleet in the last N hours: packets
/// that completed / failed / went to review, what's still running, and which
/// approvals got resolved. The "what happened while I was gone?" answer —
/// reads the same lanes + approvals stores the desktop renders, no new state.
pub async fn recap(args: Value) -> Result<Value, String> {
    let hours = args.get("hours").and_then(|v| v.as_i64()).unwrap_or(8).clamp(1, 72);
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let cutoff_ms = now_ms - hours * 3_600_000;

    let lanes_resp = o8_http::get_json("/api/lanes?active=false").await?;
    let lanes = lanes_resp
        .get("lanes")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut completed: Vec<Value> = Vec::new();
    let mut failed: Vec<Value> = Vec::new();
    let mut reviewing: Vec<Value> = Vec::new();
    let mut needs_attention: Vec<Value> = Vec::new();
    let mut running = 0usize;
    for lane in &lanes {
        let status = lane.get("status").and_then(|v| v.as_str()).unwrap_or("");
        let updated = lane
            .get("updatedAt")
            .and_then(|v| {
                v.as_str()
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                    .map(|d| d.timestamp_millis())
                    .or_else(|| v.as_i64())
            })
            .unwrap_or(0);
        if matches!(status, "running" | "launching" | "merging") {
            running += 1;
        }
        if updated < cutoff_ms {
            continue;
        }
        let repo = lane
            .get("repoPath")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or("")
            .to_string();
        let item = json!({
            "label": lane.get("label").and_then(|v| v.as_str()).unwrap_or("Untitled"),
            "repo": repo,
        });
        match status {
            "completed" => completed.push(item),
            "failed" => failed.push(item),
            "reviewing" => reviewing.push(item),
            "awaiting_input" | "awaiting_orchestrator" | "recovering" => needs_attention.push(item),
            _ => {}
        }
    }

    let approvals_resp = o8_http::get_json("/api/panel/approvals?status=all").await?;
    let approvals = approvals_resp
        .get("approvals")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let resolved: Vec<Value> = approvals
        .iter()
        .filter(|a| {
            a.get("resolvedAt").and_then(|v| v.as_i64()).is_some_and(|t| t >= cutoff_ms)
        })
        .map(|a| {
            json!({
                "title": a.get("title").and_then(|v| v.as_str()).unwrap_or("Untitled"),
                "action": a.get("status").and_then(|v| v.as_str()).unwrap_or(""),
            })
        })
        .collect();

    let quiet = completed.is_empty()
        && failed.is_empty()
        && reviewing.is_empty()
        && needs_attention.is_empty()
        && resolved.is_empty();
    let mut out = json!({
        "window_hours": hours,
        "completed": completed,
        "failed": failed,
        "reviewing": reviewing,
        "needs_attention": needs_attention,
        "still_running": running,
        "approvals_resolved": resolved,
    });
    if quiet {
        out["note"] = json!("A quiet stretch — nothing finished, failed, or got resolved in that window.");
    }
    Ok(out)
}

/// `o8_usage` — how much CLI quota is left (Claude / Codex rate windows), from
/// the same snapshot the desktop settings drawer shows.
pub async fn usage(_args: Value) -> Result<Value, String> {
    let resp = o8_http::get_json("/api/panel/cli-usage").await?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let project = |runtime: &Value| -> Value {
        let window = |w: &Value| -> Value {
            let mut o = json!({});
            if let Some(mins) = w.get("windowMinutes").and_then(|v| v.as_i64()) {
                o["window_hours"] = json!(mins as f64 / 60.0);
            }
            if let Some(p) = w.get("usedPercent").and_then(|v| v.as_f64()) {
                o["used_percent"] = json!(p.round());
            }
            if let Some(t) = w.get("tokens").and_then(|v| v.as_i64()) {
                o["tokens_used"] = json!(t);
            }
            if let Some(r) = w.get("resetsAt").and_then(|v| v.as_i64()) {
                if r > now_ms {
                    o["resets_in_minutes"] = json!((r - now_ms) / 60_000);
                }
            }
            o
        };
        let mut o = json!({});
        if let Some(p) = runtime.get("primary").filter(|v| !v.is_null()) {
            o["session_window"] = window(p);
        }
        if let Some(s) = runtime.get("secondary").filter(|v| !v.is_null()) {
            o["weekly_window"] = window(s);
        }
        if o.as_object().map(|m| m.is_empty()).unwrap_or(true) {
            o["note"] = json!("no usage data available right now");
        }
        o
    };

    Ok(json!({
        "claude": project(resp.get("claude").unwrap_or(&Value::Null)),
        "codex": project(resp.get("codex").unwrap_or(&Value::Null)),
    }))
}

/// `o8_panel_read` — what's CONFIGURED inside o8: automations, projects, or
/// connected repos. Read-through loopback projections, spoken-friendly. (PRs,
/// issues, and commits stay with the per-repo git/gh tools — no overlap.)
pub async fn panel_read(args: Value) -> Result<Value, String> {
    let kind = args
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_lowercase();
    match kind.as_str() {
        "automations" => {
            let resp = o8_http::get_json("/api/automations").await?;
            let autos = resp
                .get("automations")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let items: Vec<Value> = autos
                .iter()
                .map(|a| {
                    let repo = a
                        .get("repoPath")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim_end_matches('/')
                        .rsplit('/')
                        .next()
                        .unwrap_or("")
                        .to_string();
                    json!({
                        "name": a.get("name").and_then(|v| v.as_str()).unwrap_or("Untitled"),
                        "enabled": a.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false),
                        "trigger": a.get("cronExpr").and_then(|v| v.as_str())
                            .or_else(|| a.get("triggerKind").and_then(|v| v.as_str()))
                            .unwrap_or(""),
                        "last_run_status": a.get("lastRunStatus").and_then(|v| v.as_str()).unwrap_or(""),
                        "repo": repo,
                    })
                })
                .collect();
            Ok(json!({ "count": items.len(), "automations": items }))
        }
        "projects" => {
            let resp = o8_http::get_json("/api/projects").await?;
            let projects = resp
                .get("projects")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let items: Vec<Value> = projects
                .iter()
                .map(|p| {
                    json!({
                        "name": p.get("name").and_then(|v| v.as_str()).unwrap_or("Untitled"),
                        "repo_count": p.get("repos").and_then(|v| v.as_array()).map(|r| r.len()).unwrap_or(0),
                    })
                })
                .collect();
            Ok(json!({ "count": items.len(), "projects": items }))
        }
        "repos" => {
            let resp = o8_http::get_json("/api/panel/repos").await?;
            let repos = resp
                .get("repos")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let items: Vec<Value> = repos
                .iter()
                .filter_map(|r| r.get("name").and_then(|v| v.as_str()))
                .map(|n| json!(n))
                .collect();
            Ok(json!({ "count": items.len(), "repos": items }))
        }
        other => Err(format!(
            "o8_panel_read kind must be 'automations', 'projects', or 'repos' — got '{other}'."
        )),
    }
}

/// Resolve a spoken packet/lane descriptor to exactly one lane
/// `(packet_id, session_key, label)` — same stateless re-resolve story as the
/// approval resolver: label substring against all lanes, most recently
/// updated match wins ties ONLY when one candidate is clearly current;
/// otherwise a spoken ambiguity error.
async fn resolve_lane(which: &str) -> Result<(String, Option<String>, String), String> {
    let resp = o8_http::get_json("/api/lanes?active=false").await?;
    let lanes = resp
        .get("lanes")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let needle = which.trim().to_lowercase();
    if needle.is_empty() {
        return Err("Say which packet — give me part of its name.".into());
    }
    let mut matches: Vec<&Value> = lanes
        .iter()
        .filter(|l| {
            l.get("packetId").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false)
                && l.get("status").and_then(|v| v.as_str()) != Some("archived")
                && l.get("label")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_lowercase().contains(&needle))
                    .unwrap_or(false)
        })
        .collect();
    // Newest first — a packet redispatched twice shares its label.
    matches.sort_by_key(|l| {
        std::cmp::Reverse(
            l.get("updatedAt")
                .and_then(|v| {
                    v.as_str()
                        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                        .map(|d| d.timestamp_millis())
                        .or_else(|| v.as_i64())
                })
                .unwrap_or(0),
        )
    });

    match matches.len() {
        0 => Err(format!("No packet matches '{which}'. Ask me what's shipping to hear the names.")),
        1 => {
            let l = matches[0];
            Ok((
                l.get("packetId").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                l.get("sessionKey").and_then(|v| v.as_str()).map(|s| s.to_string()),
                l.get("label").and_then(|v| v.as_str()).unwrap_or("Untitled").to_string(),
            ))
        }
        _ => {
            // Distinct labels → ambiguous; same label → take the newest.
            let first_label = matches[0].get("label").and_then(|v| v.as_str()).unwrap_or("");
            if matches.iter().all(|l| l.get("label").and_then(|v| v.as_str()) == Some(first_label)) {
                let l = matches[0];
                return Ok((
                    l.get("packetId").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    l.get("sessionKey").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    first_label.to_string(),
                ));
            }
            let names: Vec<&str> = matches
                .iter()
                .take(3)
                .filter_map(|l| l.get("label").and_then(|v| v.as_str()))
                .collect();
            Err(format!("'{which}' matches more than one packet — say which: {}.", names.join("; ")))
        }
    }
}

/// `o8_packet_steer` — get a spoken message to a packet's worker: steer the
/// warm session when one exists, else redispatch fresh with the message as
/// feedback. One verb for "tell the tooltip packet to also fix X".
pub async fn packet_steer(args: Value) -> Result<Value, String> {
    let which = args.get("packet").and_then(|v| v.as_str()).unwrap_or("");
    let message = args.get("message").and_then(|v| v.as_str()).unwrap_or("").trim();
    if message.is_empty() {
        return Err("o8_packet_steer needs a 'message'".into());
    }
    let (packet_id, session_key, label) = resolve_lane(which).await?;

    if let Some(session_key) = session_key.filter(|s| !s.is_empty()) {
        // Steer the warm session. Do NOT `?` here: a failed steer (session
        // gone → non-2xx → Err, OR a 2xx with ok:false) must fall through to
        // the reliable rerun path, not abort the tool. Only an explicit
        // ok:true counts as a warm-session success.
        let steer = o8_http::post_json(
            "/api/runtime/action",
            json!({ "action": "steer", "surfaceId": session_key, "message": message }),
        )
        .await;
        if let Ok(resp) = &steer {
            if resp.get("ok").and_then(|v| v.as_bool()) == Some(true) {
                return Ok(json!({ "steered": true, "packet": label, "how": "warm session" }));
            }
        }
        // Steer refused or errored — fall through to a fresh rerun.
    }
    let resp = o8_http::post_json(
        "/api/orchestrator/rerun-with-feedback",
        json!({ "packetId": packet_id, "feedback": message }),
    )
    .await?;
    if resp.get("ok").and_then(|v| v.as_bool()) == Some(false) {
        let err = resp.get("error").and_then(|v| v.as_str()).unwrap_or("o8 returned an error");
        return Err(format!("Couldn't reach the \u{201c}{label}\u{201d} worker: {err}"));
    }
    Ok(json!({ "steered": true, "packet": label, "how": "fresh worker with the message as feedback" }))
}

/// `o8_packet_rerun` — restart a packet fresh ("retry the failed packet"),
/// optionally with spoken feedback about what went wrong.
pub async fn packet_rerun(args: Value) -> Result<Value, String> {
    let which = args.get("packet").and_then(|v| v.as_str()).unwrap_or("");
    let feedback = args
        .get("feedback")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Retry: the previous attempt did not land. Re-read the task and try again carefully.");
    let (packet_id, _, label) = resolve_lane(which).await?;

    let resp = o8_http::post_json(
        "/api/orchestrator/rerun-with-feedback",
        json!({ "packetId": packet_id, "feedback": feedback }),
    )
    .await?;
    if resp.get("ok").and_then(|v| v.as_bool()) == Some(false) {
        let err = resp.get("error").and_then(|v| v.as_str()).unwrap_or("o8 returned an error");
        return Err(format!("Couldn't restart \u{201c}{label}\u{201d}: {err}"));
    }
    crate::agent::worker_pulse::nudge();
    Ok(json!({ "restarted": true, "packet": label }))
}

/// Resolve a repo folder name (or an absolute path) to a registered absolute
/// path via `/api/panel/repos`. Exact name match wins; otherwise a substring
/// match. Returns a spoken-friendly error when nothing matches. Shared with the
/// Tier-3 git/gh tools.
pub async fn resolve_repo_path(repo: &str) -> Result<String, String> {
    if repo.starts_with('/') {
        return Ok(repo.to_string());
    }
    let resp = o8_http::get_json("/api/panel/repos").await?;
    let repos = resp.get("repos").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let needle = repo.to_lowercase();

    let mut fallback: Option<String> = None;
    for r in &repos {
        let name = r.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let path = r.get("localPath").and_then(|v| v.as_str()).unwrap_or("");
        if path.is_empty() {
            continue;
        }
        if name.to_lowercase() == needle {
            return Ok(path.to_string());
        }
        if fallback.is_none() && name.to_lowercase().contains(&needle) {
            fallback = Some(path.to_string());
        }
    }
    fallback.ok_or_else(|| format!("I couldn't find a repo named '{repo}' in o8."))
}

/// `o8_add_repo` — register an existing local git repo in o8 (and optionally
/// drop it into a named project). Same route the sidebar + button and the
/// operator MCP's `o8_register_repo` use: POST `/api/panel/repos`
/// `{action:'add'}` — o8's DB stays the single source of truth and the
/// sidebar picks it up live. Project assignment patches the project ledger's
/// `repoPaths` exactly like the desktop project drawer.
pub async fn add_repo(args: Value) -> Result<Value, String> {
    let raw = args
        .get("path")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if raw.is_empty() {
        return Err("o8_add_repo needs the folder 'path' — find it with fs_spotlight first.".into());
    }
    let path = if raw == "~" || raw.starts_with("~/") {
        let home = std::env::var("HOME").unwrap_or_default();
        raw.replacen('~', &home, 1)
    } else {
        raw
    };

    let resp = o8_http::post_json("/api/panel/repos", json!({ "action": "add", "localPath": path })).await?;
    if let Some(err) = resp.get("error").and_then(|v| v.as_str()) {
        return Err(format!("o8 couldn't add that repo: {err}"));
    }
    let repo_path = resp
        .get("repo")
        .and_then(|r| r.get("localPath"))
        .and_then(|v| v.as_str())
        .unwrap_or(&path)
        .to_string();

    let project = args
        .get("project")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let Some(project) = project else {
        return Ok(json!({ "added": true, "path": repo_path }));
    };

    // Assign to a project by spoken name — exact match first, then substring.
    let ledger = o8_http::get_json("/api/panel/projects").await?;
    let projects = ledger
        .get("projects")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let needle = project.to_lowercase();
    let name_of = |p: &Value| p.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
    let hit = projects
        .iter()
        .find(|p| name_of(p).to_lowercase() == needle)
        .or_else(|| projects.iter().find(|p| name_of(p).to_lowercase().contains(&needle)));
    let Some(hit) = hit else {
        let names: Vec<String> = projects.iter().map(|p| name_of(p)).filter(|n| !n.is_empty()).collect();
        return Ok(json!({
            "added": true,
            "path": repo_path,
            "project_assigned": false,
            "note": format!(
                "The repo is added, but no project matched '{project}'. Projects: {}.",
                if names.is_empty() { "none yet".to_string() } else { names.join(", ") }
            ),
        }));
    };

    let project_id = hit.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let project_name = name_of(hit);
    let mut paths: Vec<String> = hit
        .get("repoPaths")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let target = repo_path.trim_end_matches('/');
    if !paths.iter().any(|x| x.trim_end_matches('/') == target) {
        paths.push(repo_path.clone());
    }
    let patched = o8_http::patch_json(
        &format!("/api/panel/projects/{project_id}"),
        json!({ "repoPaths": paths }),
    )
    .await;
    match patched {
        Ok(_) => Ok(json!({
            "added": true,
            "path": repo_path,
            "project_assigned": true,
            "project": project_name,
        })),
        Err(e) => Ok(json!({
            "added": true,
            "path": repo_path,
            "project_assigned": false,
            "note": format!("The repo is added, but assigning it to '{project_name}' failed: {e}"),
        })),
    }
}

/// Canvas verbs Symon can drive — the enum the `/api/canvas/intent` route accepts
/// (kept in lockstep with `docs/symon-port/canvas-intent-bus.md`).
const CANVAS_VERBS: &[&str] = &[
    "enter",
    "send-prompt",
    "ask-brain",
    "open-browser",
    "open-spec",
    "spawn-terminal",
    "search",
    "zoom",
    "dock",
    "spawn-agents",
];

/// Build the `/api/canvas/intent` POST body from the model's FLAT params.
///
/// The model sees one verb-enum'd tool with flat properties (`text`, `question`,
/// `url`, `query`, `level`, `direction`, `open`); the route wants `{ verb, args,
/// ensure }` with the verb-specific params nested under `args`. This pure mapper
/// makes that translation unit-testable (no I/O).
pub fn canvas_intent_body(verb: &str, args: &Value) -> Value {
    let mut inner = json!({});
    let mut carry = |key: &str| {
        if let Some(v) = args.get(key) {
            if !v.is_null() {
                inner[key] = v.clone();
            }
        }
    };
    match verb {
        "send-prompt" => carry("text"),
        "ask-brain" => carry("question"),
        "open-browser" => carry("url"),
        "search" => carry("query"),
        "zoom" => {
            carry("level");
            carry("direction");
        }
        "dock" => carry("open"),
        "spawn-agents" => {
            carry("task");
            carry("count");
            carry("repo");
        }
        // enter / open-spec / spawn-terminal take no args — for `enter`, the
        // route's `ensure:true` navigation IS the action (just bring the Canvas up).
        _ => {}
    }
    json!({ "verb": verb, "args": inner, "ensure": true })
}

/// `o8_canvas` — drive o8's Canvas surface by voice. POSTs to the SAME
/// `/api/canvas/intent` route the canvas rail buttons call, so behavior never
/// forks from a click: message the orchestrator (`send-prompt`), ask the
/// Engineering Brain (`ask-brain`), open the browser/spec/terminal, search,
/// zoom, or toggle the dock. Classed ReadOnly in `super::super::safety` — it
/// only changes what's on the operator's SCREEN, never repo state; the
/// orchestrator's own mutations (worker spawn, merge) stay gated downstream by
/// o8's review/approval pipeline, exactly as when the operator types in the
/// composer.
pub async fn canvas_intent(verb: &str, args: Value) -> Result<Value, String> {
    if !CANVAS_VERBS.contains(&verb) {
        return Err(format!(
            "o8_canvas verb must be one of {} — got '{verb}'.",
            CANVAS_VERBS.join(", ")
        ));
    }
    let body = canvas_intent_body(verb, &args);
    // The route SPA-navigates to the canvas and waits (≤10s) for the intent
    // listener to mount before dispatching — give it headroom past that.
    let resp = o8_http::post_json_timeout("/api/canvas/intent", body, 15).await?;

    if resp.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        // Soft page-side failure (`note`) or hard miss (`error`, e.g. the canvas
        // never mounted) — relay the page's reason for the model to speak.
        let why = resp
            .get("note")
            .and_then(|v| v.as_str())
            .or_else(|| resp.get("error").and_then(|v| v.as_str()))
            .unwrap_or("the canvas didn't accept that");
        return Err(format!("Couldn't run the canvas {verb}: {why}"));
    }

    Ok(json!({
        "ok": true,
        "verb": verb,
        "navigated": resp.get("navigated").and_then(|v| v.as_bool()).unwrap_or(false),
    }))
}

// ── Browser driving (drive a web page by voice) ───────────────────────────────

/// POST one verb to o8's browser-agent bridge (`/api/browser/agent`) — the same
/// gated route the `o8 browser` CLI and the operator MCP browser tools use. The
/// route runs the verb against o8's embedded browser surface (or the headless
/// engine tier for external URLs); we shape the body and relay the parsed result
/// for the model to speak. An explicit page-side `error` surfaces as a spoken
/// failure; probe's `ok:false`+`pending` (element not present yet) is NOT an
/// error — callers that care inspect the envelope themselves.
async fn browser_verb(verb: &str, inner: Value) -> Result<Value, String> {
    let resp = o8_http::post_json_timeout(
        "/api/browser/agent",
        json!({ "verb": verb, "args": inner }),
        20,
    )
    .await?;
    if resp.get("ok").and_then(|v| v.as_bool()) == Some(false) {
        if let Some(err) = resp.get("error").and_then(|v| v.as_str()) {
            return Err(format!("Browser {verb} failed: {err}"));
        }
    }
    Ok(resp)
}

/// `o8_browser_read` — read what o8's browser is showing, or wait for an element
/// to appear. ReadOnly: never changes the page, so it never shows a confirm card.
pub async fn browser_read(args: Value) -> Result<Value, String> {
    let verb = args.get("verb").and_then(|v| v.as_str()).unwrap_or("read").trim();
    match verb {
        "" | "read" => {
            let mut inner = json!({});
            if let Some(sel) = args
                .get("selector")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                inner["selector"] = json!(sel);
            }
            if let Some(n) = args.get("max_chars").and_then(|v| v.as_u64()) {
                inner["maxChars"] = json!(n);
            }
            let resp = browser_verb("read", inner).await?;
            Ok(json!({
                "ok": true,
                "url": resp.get("url").cloned().unwrap_or(Value::Null),
                "title": resp.get("title").cloned().unwrap_or(Value::Null),
                "text": resp.get("text").cloned().unwrap_or(Value::Null),
                "interactive": resp.get("interactive").cloned().unwrap_or(Value::Null),
            }))
        }
        "wait" => {
            let selector = args.get("selector").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
            if selector.is_empty() {
                return Err("o8_browser_read verb 'wait' needs a 'selector'.".into());
            }
            let mut inner = json!({ "selector": selector });
            if let Some(t) = args
                .get("text")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                inner["text"] = json!(t);
            }
            // Bounded poll (~8s) so "wait for the login form" actually waits.
            // probe returns {ok:true, found} when present, {ok:false, pending}
            // while absent (a hard error still aborts via browser_verb).
            for attempt in 0..10u32 {
                let resp = browser_verb("probe", inner.clone()).await?;
                if resp.get("ok").and_then(|v| v.as_bool()) == Some(true) {
                    return Ok(json!({ "ok": true, "found": true, "selector": selector, "attempts": attempt + 1 }));
                }
                tokio::time::sleep(std::time::Duration::from_millis(800)).await;
            }
            Ok(json!({ "ok": true, "found": false, "selector": selector, "note": "still not present after ~8s of waiting" }))
        }
        other => Err(format!("o8_browser_read verb must be 'read' or 'wait' — got '{other}'.")),
    }
}

/// `o8_browser_act` — act on the page o8's browser is showing: click an element,
/// type into a field, or open a URL. Reversible: each action shows a confirm card
/// (the page can be a real logged-in site), the same posture as term_send.
pub async fn browser_act(args: Value) -> Result<Value, String> {
    let verb = args.get("verb").and_then(|v| v.as_str()).unwrap_or("").trim();
    match verb {
        "click" => {
            let selector = args.get("selector").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
            if selector.is_empty() {
                return Err("o8_browser_act verb 'click' needs a 'selector'.".into());
            }
            let resp = browser_verb("click", json!({ "selector": selector })).await?;
            Ok(json!({
                "ok": true,
                "clicked": resp.get("clicked").cloned().unwrap_or(json!(selector)),
                "label": resp.get("label").cloned().unwrap_or(Value::Null),
            }))
        }
        "type" => {
            let selector = args.get("selector").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
            let text = args.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if selector.is_empty() {
                return Err("o8_browser_act verb 'type' needs a 'selector'.".into());
            }
            let mut inner = json!({ "selector": selector, "text": text });
            if args.get("submit").and_then(|v| v.as_bool()) == Some(true) {
                inner["submit"] = json!(true);
            }
            let resp = browser_verb("type", inner).await?;
            Ok(json!({
                "ok": true,
                "typed": resp.get("typed").cloned().unwrap_or(Value::Null),
                "into": resp.get("into").cloned().unwrap_or(json!(selector)),
            }))
        }
        "open" => {
            let url = args.get("url").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
            if url.is_empty() {
                return Err("o8_browser_act verb 'open' needs a 'url'.".into());
            }
            let resp = browser_verb("open", json!({ "url": url })).await?;
            Ok(json!({ "ok": true, "opened": resp.get("url").cloned().unwrap_or(json!(url)) }))
        }
        other => Err(format!("o8_browser_act verb must be 'click', 'type', or 'open' — got '{other}'.")),
    }
}

// ── Review (inspect a packet's diff before approving) ──────────────────────────

/// `o8_review_diff` — inspect what a packet's worktree changed before approving:
/// the diffstat (files + insertions/deletions, speakable) plus the canonical
/// review state (working / ready-to-merge / needs-revision / merged / failed).
/// ReadOnly — the operator still releases the merge via o8_approve_item; this
/// just lets voice SEE the diff instead of approving blind. `packet` matches a
/// lane the same fuzzy way o8_packet_steer does (omit for the only active lane).
pub async fn review_diff(args: Value) -> Result<Value, String> {
    let which = args.get("packet").and_then(|v| v.as_str()).unwrap_or("");
    let (packet_id, _session, label) = resolve_lane(which).await?;

    // Diffstat only — small cap; we want the spoken summary, not the full patch.
    // packet_id is a url-safe slug (pkt-…), so direct interpolation is safe.
    let diff = o8_http::get_json(&format!("/api/lanes/{packet_id}/diff?maxBytes=2000")).await?;
    if diff.get("ok").and_then(|v| v.as_bool()) == Some(false) {
        let note = diff.get("note").and_then(|v| v.as_str()).unwrap_or("no diff available");
        return Err(format!("Couldn't read the diff for \u{201c}{label}\u{201d}: {note}"));
    }
    let stat = diff.get("stat").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let branch = diff.get("branch").and_then(|v| v.as_str()).unwrap_or("").to_string();

    // Review state — best-effort; the diffstat is the primary payload.
    let state = o8_http::get_json(&format!("/api/orchestrator/review-state?packetId={packet_id}"))
        .await
        .ok()
        .and_then(|r| r.get("state").and_then(|v| v.as_str()).map(str::to_string));

    Ok(json!({
        "ok": true,
        "packet": label,
        "branch": branch,
        "state": state,
        "stat": if stat.is_empty() { "no changes".to_string() } else { stat },
    }))
}

// ── Conductor delegation (hand a task to the live agent engine) ────────────────

/// `o8_delegate` — hand an arbitrary, multi-step task to o8's LIVE in-app agent
/// (the Claude REPL / orchestrator "agent mode") so it ACTS on it now — on the
/// canvas / screen — while Symon keeps talking. This is the conductor move:
/// gpt-realtime is a great voice but a weaker doer, so deep / multi-step /
/// on-screen / "figure this out" work goes to the agent engine and Symon
/// narrates. Distinct from o8_dispatch (which spawns a tracked Codex CODING
/// worker in a worktree); delegate drives the LIVE session for immediate,
/// arbitrary action. Reuses the canvas send-prompt path the operator's composer
/// uses — so the canvas is the stage the operator watches, and the agent's own
/// mutations stay gated downstream by o8's review/approval pipeline.
pub async fn delegate(args: Value) -> Result<Value, String> {
    let task = args.get("task").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if task.is_empty() {
        return Err("o8_delegate needs a 'task' — what should the agent do?".into());
    }
    // Bring the Canvas up and inject the task into the live orchestrator, which
    // runs it as a real turn (tools + screen actions). canvas_intent surfaces a
    // spoken-friendly error if the orchestrator isn't ready (no repo scoped /
    // busy / not connected).
    let resp = canvas_intent("send-prompt", json!({ "text": task })).await?;
    let navigated = resp.get("navigated").and_then(|v| v.as_bool()).unwrap_or(false);
    Ok(json!({
        "ok": true,
        "delegated": true,
        "task": task,
        "to": "the live agent (in-app orchestrator)",
        "note": if navigated { "opened the canvas and handed it to the agent — it's working on it now" } else { "handed it to the agent on the canvas — it's working on it now" },
    }))
}

#[cfg(test)]
mod canvas_tests {
    use super::*;

    #[test]
    fn maps_send_prompt_text_under_args() {
        let body = canvas_intent_body("send-prompt", &json!({ "text": "fix the failing test" }));
        assert_eq!(body["verb"], "send-prompt");
        assert_eq!(body["args"]["text"], "fix the failing test");
        assert_eq!(body["ensure"], true);
    }

    #[test]
    fn ask_brain_carries_only_question() {
        let body = canvas_intent_body("ask-brain", &json!({ "question": "why the merge gate?", "text": "ignored" }));
        assert_eq!(body["args"]["question"], "why the merge gate?");
        assert!(body["args"].get("text").is_none(), "unrelated keys must not leak through");
    }

    #[test]
    fn zoom_carries_both_level_and_direction() {
        let body = canvas_intent_body("zoom", &json!({ "direction": "out" }));
        assert_eq!(body["args"]["direction"], "out");
        assert!(body["args"].get("level").is_none());
    }

    #[test]
    fn argless_verbs_send_empty_args() {
        let body = canvas_intent_body("open-spec", &json!({ "text": "nope" }));
        assert_eq!(body["verb"], "open-spec");
        assert_eq!(body["args"], json!({}));
        assert_eq!(body["ensure"], true);
    }

    #[test]
    fn enter_navigates_with_no_args() {
        // "open / enter / show the canvas" — navigation IS the action, so the
        // body carries an empty args bag and relies on ensure:true.
        let body = canvas_intent_body("enter", &json!({ "text": "ignored" }));
        assert_eq!(body["verb"], "enter");
        assert_eq!(body["args"], json!({}));
        assert_eq!(body["ensure"], true);
    }

    #[test]
    fn enter_is_a_known_verb() {
        assert!(CANVAS_VERBS.contains(&"enter"));
    }

    #[test]
    fn spawn_agents_carries_task_count_and_repo() {
        let body = canvas_intent_body(
            "spawn-agents",
            &json!({ "task": "the auth refactor", "count": 2, "repo": "o8", "text": "ignored" }),
        );
        assert_eq!(body["verb"], "spawn-agents");
        assert_eq!(body["args"]["task"], "the auth refactor");
        assert_eq!(body["args"]["count"], 2);
        assert_eq!(body["args"]["repo"], "o8");
        assert!(body["args"].get("text").is_none(), "unrelated keys must not leak through");
    }

    #[test]
    fn spawn_agents_is_a_known_verb() {
        assert!(CANVAS_VERBS.contains(&"spawn-agents"));
    }
}
