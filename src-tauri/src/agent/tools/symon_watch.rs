//! Standing intents — `symon_watch` and friends.
//!
//! Symon can act inside a turn and can run a short ordered plan, but until now
//! nothing survived the turn ending. A watch is a durable standing intent: o8's
//! existing automation watch engine holds the condition, and when it becomes
//! true the desktop either speaks a report to the phone or offers the saved
//! plan behind the ordinary confirmation card.
//!
//! These tools are thin. Every durable decision (checkpointing, fan-out limits,
//! the deadline, parking while the phone is away) belongs to o8's backend; this
//! module only shapes the model's arguments and reads the receipt back.

use serde_json::{json, Value};

use super::super::o8_http;
use super::super::TaskCtx;

fn trimmed<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

/// Register one standing watch. `condition` names an observable o8 already
/// tracks; `then` is either a spoken report or a saved plan body.
pub async fn register(args: Value, ctx: &TaskCtx) -> Result<Value, String> {
    let condition = args
        .get("condition")
        .filter(|value| value.is_object())
        .ok_or_else(|| "condition must be an object".to_string())?;
    let text = trimmed(condition, "text")
        .ok_or_else(|| "condition.text must say, in the operator's words, what you are waiting for".to_string())?;
    let source = trimmed(condition, "source")
        .ok_or_else(|| "condition.source must be packet, repository, or managed_run".to_string())?;
    let then = args
        .get("then")
        .filter(|value| value.is_object())
        .ok_or_else(|| "then must be an object with kind 'report' or 'plan'".to_string())?;

    let deadline_ms = args
        .get("deadline_minutes")
        .and_then(Value::as_i64)
        .map(|minutes| minutes.clamp(1, 7 * 24 * 60) * 60_000)
        .unwrap_or(24 * 60 * 60 * 1_000);

    // A plan body that cannot be read back can never run, so it never becomes a
    // durable watch. This is the same validator the run card uses.
    if then.get("kind").and_then(Value::as_str) == Some("plan") {
        let steps = then
            .get("steps")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        super::super::plan::watch_body_readback(&steps)
            .map_err(|error| format!("This watch's plan cannot run: {error}"))?;
    }

    let body = json!({
        "sessionId": ctx.ledger_session_id,
        "condition": {
            "text": text,
            "source": source,
            "id": condition.get("id").and_then(Value::as_str),
            "events": condition.get("events").cloned().unwrap_or_else(|| json!([])),
            "repoPath": condition.get("repo_path").and_then(Value::as_str),
        },
        "then": then,
        "deadlineMs": deadline_ms,
    });
    let response = o8_http::post_json("/api/symon/watches", body).await?;
    let watch = response.get("watch").cloned().unwrap_or(response);
    Ok(json!({
        "ok": true,
        "watch": watch,
        "spoken_confirmation": format!("I'll watch for that: {text}."),
    }))
}

/// What is Symon still waiting on?
pub async fn list(_args: Value, ctx: &TaskCtx) -> Result<Value, String> {
    let path = match ctx.ledger_session_id.as_deref() {
        Some(session) => format!(
            "/api/symon/watches?sessionId={}",
            urlencoding_minimal(session)
        ),
        None => "/api/symon/watches".to_string(),
    };
    let response = o8_http::get_json(&path).await?;
    let watches = response
        .get("watches")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    // The cancel and run cards read the operator's own wording from here, so a
    // card never has to say a bare id back to them.
    super::super::remember_watch_conditions(&watches);
    Ok(json!({
        "ok": true,
        "count": watches.len(),
        "watches": watches,
    }))
}

/// Clear one watch by its exact id.
pub async fn cancel(args: Value, _ctx: &TaskCtx) -> Result<Value, String> {
    let id = trimmed(&args, "id")
        .ok_or_else(|| "id must be an exact watch id from symon_watch_list".to_string())?;
    let response = o8_http::delete_json(&format!(
        "/api/symon/watches/{}",
        urlencoding_minimal(id)
    ))
    .await?;
    Ok(json!({
        "ok": true,
        "cancelled": true,
        "watch": response.get("watch").cloned().unwrap_or(Value::Null),
    }))
}

/// Read one watch's saved plan body. Used by the governed run path, never by
/// the model directly.
pub async fn plan_body(id: &str) -> Result<(String, Vec<Value>), String> {
    // `claim=1` takes the body for exactly one run, so two concurrent calls
    // cannot raise two cards for the same saved plan.
    let response = o8_http::get_json(&format!(
        "/api/symon/watches/{}?claim=1",
        urlencoding_minimal(id)
    ))
    .await?;
    if let Some(error) = response.get("planError").and_then(Value::as_str) {
        return Err(error.to_string());
    }
    let plan = response
        .get("plan")
        .filter(|value| value.is_object())
        .ok_or_else(|| "this watch has no plan waiting".to_string())?;
    let condition = plan
        .get("condition")
        .and_then(Value::as_str)
        .unwrap_or("this watch")
        .to_string();
    let steps = plan
        .get("steps")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if steps.is_empty() {
        return Err("the saved plan body is empty".to_string());
    }
    Ok((condition, steps))
}

/// Record how the confirmation card resolved. Best effort: the durable watch
/// row is authoritative and a lost receipt never re-runs the plan.
pub async fn settle_run(id: &str, outcome: &str, detail: &str) {
    let path = format!("/api/symon/watches/{}", urlencoding_minimal(id));
    if let Err(error) = o8_http::patch_json(
        &path,
        json!({ "runOutcome": outcome, "detail": detail }),
    )
    .await
    {
        log::warn!("[symon-watch] run outcome not recorded: {error}");
    }
}

/// Percent-encode the few characters that can appear in an id or session name
/// and would otherwise change the path. Ids are generated by o8 and are already
/// URL-safe; this keeps a hand-typed one from escaping the path segment.
fn urlencoding_minimal(value: &str) -> String {
    value
        .chars()
        .map(|character| match character {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => character.to_string(),
            other => other
                .to_string()
                .as_bytes()
                .iter()
                .map(|byte| format!("%{byte:02X}"))
                .collect::<String>(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_segments_cannot_escape_their_segment() {
        assert_eq!(urlencoding_minimal("watch_abc-1"), "watch_abc-1");
        assert_eq!(urlencoding_minimal("../panel"), "..%2Fpanel");
        assert_eq!(urlencoding_minimal("a b"), "a%20b");
    }
}
