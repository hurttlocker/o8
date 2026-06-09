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

    let resp = o8_http::post_json("/api/cortex/ask/answer", body).await?;
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
    let citation_count = resp
        .get("citations")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);

    Ok(json!({ "answer": answer, "citations": citation_count }))
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

    Ok(json!({
        "dispatched": true,
        "packet_id": packet_id,
        "lane_id": lane_id,
        "repo": repo,
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
