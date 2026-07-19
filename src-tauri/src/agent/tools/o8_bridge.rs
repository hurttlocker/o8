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

async fn terminal_host_request(path: &str, body: Option<Value>) -> Result<Value, String> {
    let port = std::env::var("O8_WS_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .or_else(|| {
            std::fs::read_to_string(crate::agent::agent_data_dir().join("ws-port"))
                .ok()
                .and_then(|value| value.trim().parse::<u16>().ok())
        })
        .unwrap_or(47105);
    let token = std::fs::read_to_string(crate::agent::agent_data_dir().join("ws-token"))
        .unwrap_or_default();
    let client = reqwest::Client::new();
    let request = match body {
        Some(body) => client.post(format!("http://127.0.0.1:{port}{path}")).json(&body),
        None => client.get(format!("http://127.0.0.1:{port}{path}")),
    }
    .bearer_auth(token.trim());
    let response = request.send().await.map_err(|error| format!("o8 terminal bridge {path} failed: {error}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|error| format!("o8 terminal bridge {path} read failed: {error}"))?;
    if !status.is_success() {
        return Err(format!("o8 terminal bridge {path} error ({status}): {}", crate::utf8_head(&text, 300)));
    }
    serde_json::from_str(&text).map_err(|error| format!("o8 terminal bridge {path} returned bad JSON: {error}"))
}

/// List live PTYs hosted by o8 itself. Never surveys or controls foreign apps.
pub async fn terminal_list(_args: Value) -> Result<Value, String> {
    terminal_host_request("/terminal-voice-sessions", None).await
}

/// Write one payload to a named o8-hosted PTY; ordinary text submits by default.
pub async fn terminal_send(args: Value) -> Result<Value, String> {
    let session_name = args.get("session_name").and_then(|value| value.as_str()).unwrap_or("").trim();
    let text = args.get("text").and_then(|value| value.as_str()).unwrap_or("");
    if session_name.is_empty() || text.is_empty() {
        return Err("terminal_send requires a session_name and non-empty text".to_string());
    }
    let raw = args.get("raw").and_then(|value| value.as_bool()).unwrap_or(false);
    terminal_host_request("/terminal-voice-input", Some(json!({
        "sessionName": session_name,
        "text": text,
        "raw": raw,
    }))).await
}

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
            // The agent's memorable canvas name — say it back ("Atlas is on the
            // auth refactor") and use it to address the agent via o8_agent_task.
            "name": lane.get("codename").and_then(|v| v.as_str()).unwrap_or(""),
            "label": lane.get("label").and_then(|v| v.as_str()).unwrap_or("Untitled"),
            "status": lane.get("status").and_then(|v| v.as_str()).unwrap_or("unknown"),
            "repo": repo,
            "runtime": lane.get("runtime").and_then(|v| v.as_str()).unwrap_or(""),
            "branch": lane.get("branch").and_then(|v| v.as_str()).unwrap_or(""),
        }));
    }

    // o8 team peers — the OTHER agents/operators driving o8 right now (the
    // top-level sessions, named by the same canonical codename as the lanes
    // above). Lets Symon be peer-aware ("Atlas and Nova are both driving o8").
    // Best-effort: a missing/empty coordination room just yields [].
    let peers: Vec<Value> = o8_http::get_json("/api/team/presence")
        .await
        .ok()
        .and_then(|p| p.get("peers").and_then(|v| v.as_array()).cloned())
        .unwrap_or_default()
        .into_iter()
        .filter(|p| match &repo_filter {
            Some(f) => p
                .get("repo")
                .and_then(|v| v.as_str())
                .map(|r| r.to_lowercase().contains(f))
                .unwrap_or(false),
            None => true,
        })
        .collect();

    Ok(json!({
        "active_count": items.len(),
        "lanes": items,
        "peers": peers,
    }))
}

/// `o8_team_tell` — relay a message to a running agent by handle (the voice path:
/// "tell Nova to hold the ship"). The server resolves the codename to the repo
/// the agent is in and drops a durable message; the agent's guard hook surfaces
/// it on its next tool call. No repo mutation → Symon does it directly.
pub async fn team_tell(args: Value) -> Result<Value, String> {
    let to = args
        .get("agent")
        .and_then(|v| v.as_str())
        .or_else(|| args.get("to").and_then(|v| v.as_str()))
        .unwrap_or("")
        .trim();
    let text = args
        .get("message")
        .and_then(|v| v.as_str())
        .or_else(|| args.get("text").and_then(|v| v.as_str()))
        .unwrap_or("")
        .trim();
    if to.is_empty() || text.is_empty() {
        return Err("Tell whom what? Give the agent's name and a message — e.g. tell Nova to hold the ship.".to_string());
    }
    let resp = o8_http::post_json("/api/team/tell", json!({ "to": to, "text": text, "from": "Symon" })).await?;
    if resp.get("ok").and_then(|v| v.as_bool()) == Some(true) {
        let who = resp.get("to").and_then(|v| v.as_str()).unwrap_or(to);
        let repo = resp.get("repo").and_then(|v| v.as_str()).unwrap_or("");
        let spoken = if repo.is_empty() { format!("Sent to {who}.") } else { format!("Sent to {who} on {repo}.") };
        Ok(json!({ "ok": true, "delivered_to": who, "repo": repo, "spoken": spoken }))
    } else {
        let err = resp.get("error").and_then(|v| v.as_str()).unwrap_or("No agent by that name is running.");
        Ok(json!({ "ok": false, "spoken": err }))
    }
}

/// `o8_team_inbox` — recent agent-to-agent messages across the operator's repos
/// (oversight: "what are the agents saying to each other?"). Read-through.
pub async fn team_inbox(_args: Value) -> Result<Value, String> {
    let resp = o8_http::get_json("/api/team/messages?limit=10").await?;
    let messages = resp.get("messages").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    Ok(json!({ "count": messages.len(), "messages": messages }))
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
    // The name on the agent's canvas card (server computes codename(laneId) —
    // single source of truth). Symon must announce THIS name, never invent one
    // (2026-07-08: voice said "Pigeon", the card said "Pike").
    let card_name = resp.get("codename").and_then(|v| v.as_str()).unwrap_or("");

    if !ok {
        // 202 path: launch is queued behind a policy gate / approval card.
        let approval = resp.get("approvalId").and_then(|v| v.as_str()).unwrap_or("");
        return Ok(json!({
            "dispatched": false,
            "packet_id": packet_id,
            "codename": card_name,
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
        "codename": card_name,
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

/// `o8_agent_task` — address a WORKING agent by the memorable codename on its
/// canvas card (Atlas, Nova…) and steer it: "Atlas, also run the tests". The
/// name is resolved SERVER-side against the live lanes (codename.ts is the single
/// source of truth — the name on the card is the name you say), so there is no
/// codename table to keep in lockstep here. The route returns 200 for every
/// spoken outcome (steered / no-such-agent / ambiguous), so a clean message
/// rides back for Symon to read instead of a raw HTTP error string.
pub async fn agent_task(args: Value) -> Result<Value, String> {
    let name = args.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();
    let task = args
        .get("task")
        .and_then(|v| v.as_str())
        .or_else(|| args.get("message").and_then(|v| v.as_str()))
        .unwrap_or("")
        .trim();
    if name.is_empty() {
        return Err("o8_agent_task needs the agent's canvas name (e.g. 'Atlas')".into());
    }
    if task.is_empty() {
        return Err("o8_agent_task needs a 'task' — what to tell the agent".into());
    }
    let resp = o8_http::post_json(
        "/api/orchestrator/agent-task",
        json!({ "name": name, "task": task }),
    )
    .await?;
    // Spoken-ready failure (no match / ambiguous / no session) → surface the
    // message as the tool error so Symon reads it back verbatim.
    if resp.get("ok").and_then(|v| v.as_bool()) == Some(false) {
        let msg = resp
            .get("error")
            .and_then(|e| e.get("message").and_then(|v| v.as_str()))
            .unwrap_or("o8 could not steer that agent");
        return Err(msg.to_string());
    }
    Ok(resp.get("result").cloned().unwrap_or(resp))
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

/// `o8_packet_reset` — recover a STUCK packet by wiping its worktree + archiving
/// the lane, then relaunching ("reset the stuck packet and try again"). Distinct
/// from o8_packet_rerun, which KEEPS the worktree — reset is for when the
/// worktree itself is wedged. `keep_worktree:true` = "retry" (preserve + resume).
/// Reuses the operator's reset-packet → dispatch flow.
pub async fn packet_reset(args: Value) -> Result<Value, String> {
    let which = args.get("packet").and_then(|v| v.as_str()).unwrap_or("");
    let keep_worktree = args.get("keep_worktree").and_then(|v| v.as_bool()).unwrap_or(false);
    let (packet_id, _session, label) = resolve_lane(which).await?;

    let mut body = json!({ "packetId": packet_id, "clearWorktree": !keep_worktree });
    if let Some(r) = args.get("reason").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()) {
        body["reason"] = json!(r);
    }
    // o8_http returns Err on a non-2xx, so a clean return means the lane was
    // archived (+ worktree wiped unless kept).
    o8_http::post_json("/api/orchestrator/reset-packet", body)
        .await
        .map_err(|e| format!("Couldn't reset \u{201c}{label}\u{201d}: {e}"))?;

    // Relaunch via the standard reset → dispatch flow (mission-level dispatch
    // re-runs the now-pending packet). Best-effort — the archive already
    // succeeded, so report partial success if the relaunch hiccups.
    let redispatched = o8_http::post_json("/api/orchestrator/dispatch", json!({})).await.is_ok();
    crate::agent::worker_pulse::nudge();

    Ok(json!({
        "ok": true,
        "packet": label,
        "worktree": if keep_worktree { "kept" } else { "wiped" },
        "redispatched": redispatched,
        "note": if redispatched {
            "reset and relaunched it"
        } else {
            "reset it — say 'dispatch' or tell the orchestrator to relaunch"
        },
    }))
}

/// `o8_stop_agent` — KILL/STOP an agent (the symmetric counterpart to spawn).
/// Reaps the live runtime PROCESS and archives the lane + prunes the worktree,
/// with NO relaunch — distinct from o8_packet_reset, which relaunches and can
/// leave an orphaned `codex exec` churning against a pruned worktree (#1286).
/// `all:true` stops every active agent (clean slate), optionally scoped to a repo.
pub async fn stop_agent(args: Value) -> Result<Value, String> {
    let all = args.get("all").and_then(|v| v.as_bool()).unwrap_or(false);

    if all {
        let mut body = json!({ "all": true });
        if let Some(repo) = args
            .get("repo")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let repo_path = resolve_repo_path(repo).await?;
            body["repoPath"] = json!(repo_path);
        }
        let resp = o8_http::post_json("/api/orchestrator/stop-packet", body)
            .await
            .map_err(|e| format!("Couldn't stop the agents: {e}"))?;
        crate::agent::worker_pulse::nudge();
        let result = resp.get("result").cloned().unwrap_or_else(|| json!({}));
        let reaped = result.get("interruptedSessions").and_then(|v| v.as_i64()).unwrap_or(0);
        let archived = result.get("archivedLanes").and_then(|v| v.as_i64()).unwrap_or(0);
        let packets = result.get("stoppedPackets").and_then(|v| v.as_i64()).unwrap_or(0);
        return Ok(json!({
            "ok": true,
            "scope": "all",
            "reaped": reaped,
            "archived": archived,
            "packets": packets,
            "note": format!("stopped everything — killed {reaped} live session(s) and archived {archived} agent(s); nothing relaunched"),
        }));
    }

    let which = args.get("packet").and_then(|v| v.as_str()).unwrap_or("");
    let (packet_id, _session, label) = resolve_lane(which).await?;
    let resp = o8_http::post_json(
        "/api/orchestrator/stop-packet",
        json!({ "packetId": packet_id }),
    )
    .await
    .map_err(|e| format!("Couldn't stop \u{201c}{label}\u{201d}: {e}"))?;
    crate::agent::worker_pulse::nudge();
    let result = resp.get("result").cloned().unwrap_or_else(|| json!({}));
    let reaped = result.get("interruptedSessions").and_then(|v| v.as_i64()).unwrap_or(0);
    Ok(json!({
        "ok": true,
        "packet": label,
        "reaped": reaped,
        "note": format!("stopped \u{201c}{label}\u{201d} — killed the process and archived it; not relaunched"),
    }))
}

/// `o8_packet_wait` — wait for a packet to leave the "working" state and report
/// where it landed (ready-to-merge / needs-revision / merged / failed). A short
/// bounded poll (~12s) so a live voice turn doesn't hang; if it's still working,
/// say so and the model can ask again. ReadOnly.
pub async fn packet_wait(args: Value) -> Result<Value, String> {
    let which = args.get("packet").and_then(|v| v.as_str()).unwrap_or("");
    let (packet_id, _session, label) = resolve_lane(which).await?;

    let mut last = String::from("working");
    for _ in 0..6u32 {
        if let Ok(resp) =
            o8_http::get_json(&format!("/api/orchestrator/review-state?packetId={packet_id}")).await
        {
            if let Some(state) = resp.get("state").and_then(|v| v.as_str()) {
                last = state.to_string();
                if state != "working" {
                    return Ok(json!({
                        "ok": true,
                        "packet": label,
                        "state": state,
                        "ready": state == "ready-to-merge",
                    }));
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
    }
    Ok(json!({
        "ok": true,
        "packet": label,
        "state": last,
        "ready": false,
        "note": "still working after ~12s — ask again to keep waiting",
    }))
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
    "grid",
    // Card sight + lifecycle (parity with external Claude's o8_canvas).
    "list",
    "center-on-card",
    "pan",
    "read-card",
    "move-card",
    "resize-card",
    "focus-card",
    "close-card",
    "render",
    // Image lifecycle (parity with the human drag/tap interactions).
    "add-image",
    "stack",
    "flip",
    "separate",
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
        "grid" => carry("on"),
        "center-on-card" => {
            carry("kind");
            carry("id");
            carry("zoom");
        }
        "pan" => {
            carry("dx");
            carry("dy");
            carry("x");
            carry("y");
        }
        "read-card" => {
            carry("kind");
            carry("id");
            carry("lines");
        }
        "render" => {
            carry("title");
            carry("markdown");
        }
        "move-card" => {
            carry("kind");
            carry("id");
            carry("x");
            carry("y");
        }
        "resize-card" => {
            carry("kind");
            carry("id");
            carry("w");
            carry("h");
        }
        "focus-card" | "close-card" => {
            carry("kind");
            carry("id");
        }
        "add-image" => {
            carry("src");
            carry("url");
            carry("name");
            carry("x");
            carry("y");
        }
        "stack" => {
            carry("ids");
            carry("id");
            carry("ontoId");
        }
        "flip" => {
            carry("id");
            carry("dir");
        }
        "separate" => carry("id"),
        // enter / open-spec / spawn-terminal / list take no args — for `enter`, the
        // route's `ensure:true` navigation IS the action (just bring the Canvas up).
        _ => {}
    }
    json!({ "verb": verb, "args": inner, "ensure": true, "origin": "symon" })
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
    let spawn_probe = if verb == "spawn-agents" {
        o8_http::get_json_timeout("/api/lanes?active=true", 2)
            .await
            .ok()
            .map(|response| super::canvas_spawn_recovery::LaneSnapshot::from_response(&response))
    } else {
        None
    };
    // The route SPA-navigates to the canvas and waits (≤10s) for the intent
    // listener to mount before dispatching — give it headroom past that.
    let resp = match o8_http::post_json_timeout("/api/canvas/intent", body, 15).await {
        Ok(response) => response,
        Err(error) if verb == "spawn-agents" && o8_http::is_timeout_error(&error) => {
            let task = args.get("task").and_then(Value::as_str).unwrap_or("");
            let repo = args.get("repo").and_then(Value::as_str);
            if let Some(before) = spawn_probe {
                for attempt in 0..5 {
                    if let Ok(current) = o8_http::get_json_timeout("/api/lanes?active=true", 3).await {
                        let lane_ids = before.confirmed_spawned_lane_ids(&current, repo, task);
                        if !lane_ids.is_empty() {
                            return Ok(json!({
                                "ok": true,
                                "verb": verb,
                                "verifiedAfterTimeout": true,
                                "laneIds": lane_ids,
                                "note": "spawn request timed out, but new matching lanes confirm it landed"
                            }));
                        }
                    }
                    if attempt < 4 {
                        tokio::time::sleep(std::time::Duration::from_millis(600)).await;
                    }
                }
            }
            return Err(format!(
                "{error}; no new matching lane appeared, so the non-idempotent spawn was not retried"
            ));
        }
        Err(error) => return Err(error),
    };

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
        "note": resp.get("note").cloned().unwrap_or(Value::Null),
        "data": resp.get("data").cloned().unwrap_or(Value::Null),
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

// ── o8.md spec annotation (annotate the operator's living spec by voice) ───────

/// Percent-encode a query-string VALUE per RFC 3986 (everything except the
/// unreserved set ALPHA / DIGIT / - . _ ~). Needed for the `repoPath` query param
/// on /api/repo-spec, which can contain '/' and spaces. std-only, no dep.
fn qenc(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Resolve the repo path for a spec action: an explicit `repo` (name or path) via
/// resolve_repo_path, else the single registered repo, else ask which.
async fn resolve_spec_repo(args: &Value) -> Result<String, String> {
    if let Some(repo) = args
        .get("repo")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return resolve_repo_path(repo).await;
    }
    let resp = o8_http::get_json("/api/panel/repos").await?;
    let paths: Vec<String> = resp
        .get("repos")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|r| {
                    r.get("localPath").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default();
    match paths.len() {
        1 => Ok(paths.into_iter().next().unwrap()),
        0 => Err("No repos are registered in o8 yet.".into()),
        _ => Err("Which repo's spec? You have more than one — name the repo.".into()),
    }
}

fn spec_ok(resp: Value, done: &str) -> Result<Value, String> {
    if resp.get("ok").and_then(|v| v.as_bool()) == Some(false) {
        let err = resp.get("error").and_then(|v| v.as_str()).unwrap_or("o8 returned an error");
        return Err(format!("Couldn't annotate the spec: {err}"));
    }
    Ok(json!({ "ok": true, "done": done }))
}

/// `o8_spec_annotate` — annotate the operator's o8.md (the living spec/scratchpad)
/// by voice: leave a comment, reply to a thread, or resolve an item. Reversible —
/// each writes to the spec, so it cards first. Per the o8 review inversion the
/// operator AUTHORS o8.md; voice only ANNOTATES (no overwrite verb). Thin call to
/// /api/repo-spec, the same route the o8_spec_* MCP tools + the spec panel use.
pub async fn spec_annotate(args: Value) -> Result<Value, String> {
    let verb = args.get("verb").and_then(|v| v.as_str()).unwrap_or("").trim();
    let repo_path = resolve_spec_repo(&args).await?;
    let base = format!("/api/repo-spec?repoPath={}", qenc(&repo_path));
    match verb {
        "comment" => {
            let body = args.get("body").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
            if body.is_empty() {
                return Err("o8_spec_annotate verb 'comment' needs a 'body' — what's the comment?".into());
            }
            let mut payload = json!({ "body": body, "author": "Symon" });
            if let Some(a) = args.get("anchor").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()) {
                payload["anchor"] = json!(a);
            }
            spec_ok(o8_http::post_json(&format!("{base}&action=comment"), payload).await?, "commented on the spec")
        }
        "reply" => {
            let parent = args.get("parentId").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
            let message = args.get("message").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
            if parent.is_empty() || message.is_empty() {
                return Err("o8_spec_annotate verb 'reply' needs 'parentId' and 'message'.".into());
            }
            let payload = json!({ "parentId": parent, "message": message, "author": "Symon" });
            spec_ok(o8_http::post_json(&format!("{base}&action=reply"), payload).await?, "replied on the spec")
        }
        "resolve" => {
            let target = args.get("targetId").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
            if target.is_empty() {
                return Err("o8_spec_annotate verb 'resolve' needs a 'targetId'.".into());
            }
            let mut payload = json!({ "targetId": target });
            if let Some(s) = args.get("summary").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()) {
                payload["summary"] = json!(s);
            }
            spec_ok(o8_http::post_json(&format!("{base}&action=resolve"), payload).await?, "resolved the spec item")
        }
        other => Err(format!("o8_spec_annotate verb must be 'comment', 'reply', or 'resolve' — got '{other}'.")),
    }
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
        assert_eq!(body["origin"], "symon");
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

    #[test]
    fn grid_carries_on_flag_and_is_known() {
        // "put them in grid mode" → on:true; "free the canvas" → on:false; bare
        // "grid mode" omits `on` and the page toggles. Only `on` rides through.
        let body = canvas_intent_body("grid", &json!({ "on": true, "text": "ignored" }));
        assert_eq!(body["verb"], "grid");
        assert_eq!(body["args"]["on"], true);
        assert!(body["args"].get("text").is_none(), "unrelated keys must not leak through");

        let toggle = canvas_intent_body("grid", &json!({}));
        assert_eq!(toggle["args"], json!({}), "no `on` → empty args, page toggles");

        assert!(CANVAS_VERBS.contains(&"grid"));
    }

    #[test]
    fn camera_and_read_verbs_are_known_and_carry_flat_args() {
        let center = canvas_intent_body("center-on-card", &json!({ "kind": "agent", "id": 7, "zoom": 0.7, "x": 999 }));
        assert_eq!(center["args"], json!({ "kind": "agent", "id": 7, "zoom": 0.7 }));
        let pan = canvas_intent_body("pan", &json!({ "dx": 20, "dy": -8, "x": 4, "y": 5, "kind": "ignored" }));
        assert_eq!(pan["args"], json!({ "dx": 20, "dy": -8, "x": 4, "y": 5 }));
        let read = canvas_intent_body("read-card", &json!({ "kind": "term", "id": 2, "lines": 12, "text": "ignored" }));
        assert_eq!(read["args"], json!({ "kind": "term", "id": 2, "lines": 12 }));
        assert!(CANVAS_VERBS.contains(&"center-on-card"));
        assert!(CANVAS_VERBS.contains(&"pan"));
        assert!(CANVAS_VERBS.contains(&"read-card"));
    }

    #[test]
    fn qenc_encodes_path_query_value() {
        // Slashes + spaces must percent-encode for the repoPath query param;
        // RFC 3986 unreserved chars pass through untouched.
        assert_eq!(qenc("/Users/q/My Repo"), "%2FUsers%2Fq%2FMy%20Repo");
        assert_eq!(qenc("a-b_c.d~e"), "a-b_c.d~e");
    }
}
