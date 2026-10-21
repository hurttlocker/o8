//! Shared planner control flow, also compiled by the bounded native harness.
use super::super::{
    emit_agent_event, execute_cascaded_tool_call, execute_text_tool_call, speak_filler_now,
};
use super::*;

pub(crate) async fn run_text_planner_loop<S: TextPlannerSession>(
    session: S,
    model: &str,
    intent: &str,
    ctx: &TaskCtx,
    provider: &'static str,
) -> Result<LoopResult, String> {
    run_text_planner_loop_inner(session, model, intent, ctx, provider, None)
        .await
        .map(|(result, _session)| result)
}

pub(crate) async fn run_text_planner_loop_correlated<S: TextPlannerSession>(
    session: S,
    model: &str,
    intent: &str,
    ctx: &TaskCtx,
    provider: &'static str,
    correlation: ConfirmCorrelation,
) -> Result<LoopResult, String> {
    run_text_planner_loop_inner(session, model, intent, ctx, provider, Some(correlation))
        .await
        .map(|(result, _session)| result)
}

/// The correlated loop, handing the session back with the result so the caller
/// can read the adapter's resume handle off it (#2176). A failed turn keeps
/// today's shape — the error is returned and the session is dropped, because
/// there is no thread worth carrying forward from one.
pub(crate) async fn run_text_planner_loop_correlated_resumable<S: TextPlannerSession>(
    session: S,
    model: &str,
    intent: &str,
    ctx: &TaskCtx,
    provider: &'static str,
    correlation: ConfirmCorrelation,
) -> Result<(LoopResult, S), String> {
    run_text_planner_loop_inner(session, model, intent, ctx, provider, Some(correlation)).await
}

async fn run_text_planner_loop_inner<S: TextPlannerSession>(
    mut session: S,
    model: &str,
    intent: &str,
    ctx: &TaskCtx,
    provider: &'static str,
    correlation: Option<ConfirmCorrelation>,
) -> Result<(LoopResult, S), String> {
    let mut tool_call_log: Vec<Value> = Vec::new();
    let mut brain_sources: Vec<Value> = Vec::new();
    let mut result_text = String::new();
    // Spoken-filler latch — a quick "one sec" so the slow tool/turn isn't dead air.
    let mut spoke_filler = false;
    // Subscription planner turns can take a beat, so the front voice path opens
    // with an immediate filler rather than leaving the live mic silent.
    // Background escalation tasks (`claude-task-*`) already had a front ack, so
    // they stay quiet here. #1252.
    if correlation.is_none() && !ctx.task_id.starts_with("claude-task") {
        speak_filler_now();
        spoke_filler = true;
    }
    // Turn 1 carries the full planner prompt; the screenshot rides it once and
    // remains in session context. Each follow-up replaces `next_message`
    // with just the tool-result block built at the loop foot.
    let first_turn = planner_payload::build_first_prompt(intent, ctx);
    let first_turn_bytes = first_turn.prompt.len();
    let tool_defs = first_turn.tool_defs;
    // What the first turn cost, measured from here — the session is already
    // spawned (or pooled), so this is the model's own time to a usable action.
    let first_turn_started = Instant::now();
    let mut next_message = first_turn.prompt;
    let mut next_image: Option<String> = ctx.screen.as_ref().map(|s| s.png_base64.clone());
    // Schema lookups spent on this task (`planner_payload::TOOL_LOOKUP`).
    let mut lookups = 0usize;

    // Anti-fabrication guard state: does the request ask Symon to DO something
    // (an action, not a pure question)? If so and the loop ends `done` with ZERO
    // tools dispatched, the model is about to claim a success it never performed
    // — nudge it once (in the done branch below). Fires at most once per task.
    let action_intent = looks_like_action_request(intent);
    let mut nudged_premature_done = false;

    for turn in 0..MAX_TURNS {
        // User interrupted (Escape / tap-to-stop) — stop before the next turn.
        // run_agent_inner sees the cancel flag and goes quiet.
        if ctx.is_cancelled() {
            break;
        }
        // Move the session into the blocking turn and get it back with the reply
        // (it must stay alive across turns). On timeout the session is lost to
        // the orphaned blocking task and reaped when that finishes — the task
        // errors out either way.
        let msg = next_message;
        let img = next_image.take();
        let mut sess = session;
        let joined = tokio::time::timeout(
            Duration::from_secs(TURN_TIMEOUT_SECS),
            tokio::task::spawn_blocking(move || {
                let r = sess.send_planner_turn(&msg, img.as_deref());
                (sess, r)
            }),
        )
        .await
        .map_err(|_| format!("{provider} turn timed out"))?
        .map_err(|e| format!("{provider} turn join error: {e}"))?;
        session = joined.0;
        let raw = match joined.1 {
            Err(error) if turn == 0 && is_model_unavailable_error(&error) => {
                return Err(format!("{FIRST_TURN_MODEL_UNAVAILABLE_PREFIX}{error}"));
            }
            result => result?,
        };

        let model = session.effective_model().unwrap_or(model);
        let parsed = extract_action(&raw);
        if turn == 0 {
            // One stable line per planner task — what the first turn carried and
            // what it bought. Keep the field names: a dashboard may parse them.
            log::info!(
                "[symon-planner] seat={provider}/{model} first_turn_bytes={first_turn_bytes} \
                 tool_defs={tool_defs} first_action_ms={}",
                first_turn_started.elapsed().as_millis()
            );
        }
        let Some(action) = parsed else {
            // Not parseable as an action — take the reply as the final answer
            // rather than looping blindly.
            result_text = raw.trim().to_string();
            break;
        };

        if action.get("done").and_then(|d| d.as_bool()) == Some(true) {
            let say = action
                .get("say")
                .and_then(|s| s.as_str())
                .unwrap_or("Done.")
                .trim()
                .to_string();
            // The model said done on an ACTION request but dispatched no tool —
            // it's about to claim something it didn't do (signature-B fabrication).
            // Nudge ONCE to force a real tool call (or an honest "I can't"). Skip
            // when the say is plainly a question or refusal — those are legit
            // no-tool dones (clarification / safety refusal), not fabrications.
            if action_intent
                && tool_call_log.is_empty()
                && !nudged_premature_done
                && !say_is_question_or_refusal(&say)
            {
                nudged_premature_done = true;
                log::warn!(
                    "[symon-agent] premature done (no tool on an action request) — nudging once to prevent a fabricated success"
                );
                next_message = PREMATURE_DONE_NUDGE.to_string();
                next_image = None;
                continue;
            }
            result_text = say;
            break;
        }

        let Some(tool_name) = action
            .get("tool")
            .and_then(|t| t.as_str())
            .map(|s| s.to_string())
        else {
            // No tool, no done — treat any prose as the answer.
            result_text = raw.trim().to_string();
            break;
        };
        let tool_args = action.get("args").cloned().unwrap_or(json!({}));

        // A schema lookup, not an action: the first turn carries the tool
        // catalog compact, so this is how the planner reaches the parameters of
        // anything whose full schema did not ride along. Answered here, ahead of
        // the execution seam — it never reaches the ledger or the confirm gate.
        if tool_name == planner_payload::TOOL_LOOKUP {
            lookups += 1;
            let names = planner_payload::requested_lookup_names(&tool_args);
            log::info!(
                "[symon-planner] tool_lookup {}/{} {names:?}",
                lookups,
                planner_payload::MAX_TOOL_LOOKUPS
            );
            next_message = if lookups > planner_payload::MAX_TOOL_LOOKUPS {
                planner_payload::lookup_budget_spent_message()
            } else {
                planner_payload::tool_lookup_message(&names)
            };
            next_image = None;
            continue;
        }

        if let Some(app) = ctx.app.as_ref() {
            emit_agent_event(
                app,
                json!({ "taskId": ctx.task_id, "kind": "tool_call", "tool": tool_name, "args": tool_args }),
            );
        }

        let tool_result: Value = if let Some(correlation) = correlation.clone() {
            execute_text_tool_call(ctx, &tool_name, tool_args.clone(), correlation).await
        } else {
            execute_cascaded_tool_call(ctx, &tool_name, tool_args.clone(), &mut spoke_filler).await
        };

        tool_call_log.push(json!({
            "tool": tool_name,
            "args": tool_args,
            "ok": tool_result.get("error").is_none(),
        }));

        // Collect titled Brain sources for the dock answer panel.
        if tool_name == "o8_ask" {
            if let Some(srcs) = tool_result.get("sources").and_then(|v| v.as_array()) {
                brain_sources.extend(srcs.iter().take(5).cloned());
                brain_sources.truncate(8);
            }
        }

        if let Some(app) = ctx.app.as_ref() {
            emit_agent_event(
                app,
                json!({ "taskId": ctx.task_id, "kind": "tool_result", "tool": tool_name, "result": tool_result }),
            );
        }

        // Feed ONLY the result back — the live session still holds the system
        // prompt, the tool schema, and every prior turn, so this is all the model
        // needs for the next action (no transcript re-send → smaller prefill).
        next_message = text_tool_result_message(&tool_name, &tool_result);
    }

    if result_text.is_empty() {
        result_text = "Done.".to_string();
    }

    Ok((
        LoopResult {
            result_text,
            model_used: session.effective_model().unwrap_or(model).to_string(),
            tool_calls_json: Value::Array(tool_call_log).to_string(),
            brain_sources,
        },
        session,
    ))
}
