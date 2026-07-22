//! One governed execution seam shared by every Symon planner and Realtime.

use serde_json::{json, Value};

use super::{
    confirm_with_receipt, ledger, maybe_speak_filler, tools, undo, ConfirmCorrelation, TaskCtx,
};

async fn execute_tracked_tool_call(
    ctx: &TaskCtx,
    tool_name: &str,
    args: Value,
    speak: bool,
    correlation: Option<ConfirmCorrelation>,
    source: &str,
    utterance: Option<&str>,
    mut spoke_filler: Option<&mut bool>,
) -> Value {
    let action_id = ledger::next_action_id();
    let session_id = correlation.as_ref().map(|value| value.session_id.clone());
    let call_id = correlation.as_ref().map(|value| value.call_id.clone());
    if let Err(error) = ledger::record(ledger::ActionRecord {
        action_id: &action_id,
        task_id: &ctx.task_id,
        source,
        phase: "attempted",
        utterance: utterance.filter(|value| !value.trim().is_empty()),
        tool: tool_name,
        args: &args,
        confirmation_id: None,
        confirmation_outcome: "pending",
        outcome: "pending",
        session_id: session_id.as_deref(),
        call_id: call_id.as_deref(),
        inverse: None,
    }) {
        log::warn!("[symon-ledger] refused unrecorded action: {error}");
        return json!({
            "error": "The action ledger is unavailable, so no action was run",
            "ledger_error": true,
        });
    }

    let nested_orchestrator_dispatch = tool_name == "escalate"
        && args.get("target").and_then(Value::as_str) == Some("orchestrator");
    let packet_approval_action = matches!(tool_name, "o8_approve_item" | "o8_reject_item");
    let (effective_tool, effective_args, preflight_error) = if nested_orchestrator_dispatch {
        match tools::o8_bridge::canonical_dispatch_args(&args).await {
            Ok(normalized) => ("o8_dispatch", normalized, None),
            Err(error) => ("o8_dispatch", args.clone(), Some(error)),
        }
    } else if packet_approval_action {
        match tools::o8_bridge::preflight_approval_review_receipt(&args).await {
            Ok(normalized) => (tool_name, normalized, None),
            Err(error) => (tool_name, args.clone(), Some(error)),
        }
    } else {
        (tool_name, args.clone(), None)
    };
    let confirmation = if preflight_error.is_none() {
        confirm_with_receipt(ctx, effective_tool, &effective_args, speak, correlation).await
    } else {
        super::ConfirmationReceipt {
            confirmation_id: None,
            outcome: super::ConfirmationOutcome::NotRequired,
        }
    };

    let mut prepared_undo = None;
    let mut result = if let Some(error) = preflight_error {
        json!({ "error": error })
    } else if !confirmation.approved() {
        log::info!(
            "[symon-agent] tool {tool_name} did not run: {}",
            confirmation.outcome.as_str()
        );
        let error = if matches!(
            confirmation.outcome,
            super::ConfirmationOutcome::SpeechInterrupted
        ) {
            "The spoken review was interrupted, so no confirmation card was shown and no action ran"
        } else {
            "User declined this action"
        };
        json!({
            "error": error,
            "declined_by_user": true,
            "confirmation_outcome": confirmation.outcome.as_str(),
        })
    } else {
        // Capture the inverse immediately before execution, after any confirm
        // wait. Snapshotting before a two-minute card could overwrite a user's
        // intervening file change when the action is later undone.
        if undo::capability(tool_name) == undo::UndoCapability::Automatic {
            prepared_undo = undo::prepare(tool_name, &args);
        }
        if let Err(error) = ledger::record(ledger::ActionRecord {
            action_id: &action_id,
            task_id: &ctx.task_id,
            source,
            phase: "executing",
            utterance: utterance.filter(|value| !value.trim().is_empty()),
            tool: effective_tool,
            args: &effective_args,
            confirmation_id: confirmation.confirmation_id.as_deref(),
            confirmation_outcome: confirmation.outcome.as_str(),
            outcome: "executing",
            session_id: session_id.as_deref(),
            call_id: call_id.as_deref(),
            inverse: None,
        }) {
            log::warn!("[symon-ledger] refused action without execution checkpoint: {error}");
            return json!({
                "error": "The action ledger could not checkpoint execution, so no action was run",
                "ledger_error": true,
            });
        }
        if let Some(latch) = spoke_filler.as_deref_mut() {
            maybe_speak_filler(latch, effective_tool);
        }
        let mut dispatch_args = effective_args.clone();
        if nested_orchestrator_dispatch {
            dispatch_args["_symon_ledger_preconfirmed"] = Value::Bool(true);
        }
        match tools::dispatch_tool_call(tool_name, dispatch_args, ctx).await {
            Ok(output) => output,
            Err(error) => {
                log::warn!("[symon-agent] tool {tool_name} error: {error}");
                json!({ "error": error })
            }
        }
    };

    let outcome = action_outcome(&result);
    let inverse = if outcome == ActionOutcome::Succeeded {
        prepared_undo.and_then(|prepared| undo::finalize(prepared, &result))
    } else {
        None
    };
    if let Err(error) = ledger::record(ledger::ActionRecord {
        action_id: &action_id,
        task_id: &ctx.task_id,
        source,
        phase: "terminal",
        utterance: utterance.filter(|value| !value.trim().is_empty()),
        tool: effective_tool,
        args: &effective_args,
        confirmation_id: confirmation.confirmation_id.as_deref(),
        confirmation_outcome: confirmation.outcome.as_str(),
        outcome: outcome.as_str(),
        session_id: session_id.as_deref(),
        call_id: call_id.as_deref(),
        inverse: inverse.as_ref(),
    }) {
        // Attempted + executing events are already durable, so a crash or DB
        // failure here leaves an honest "execution outcome unknown" record.
        log::warn!("[symon-ledger] terminal action event failed: {error}");
    }
    strip_internal_result_fields(&mut result);
    result
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ActionOutcome {
    Succeeded,
    Queued,
    Failed,
}

impl ActionOutcome {
    fn as_str(self) -> &'static str {
        match self {
            Self::Succeeded => "succeeded",
            Self::Queued => "queued",
            Self::Failed => "failed",
        }
    }
}

fn action_outcome(result: &Value) -> ActionOutcome {
    if result.get("error").is_some()
        || result.get("success") == Some(&Value::Bool(false))
        || result.get("ok") == Some(&Value::Bool(false))
        || result.get("accepted") == Some(&Value::Bool(false))
    {
        ActionOutcome::Failed
    } else if result.get("dispatched") == Some(&Value::Bool(false)) {
        ActionOutcome::Queued
    } else {
        ActionOutcome::Succeeded
    }
}

fn strip_internal_result_fields(result: &mut Value) {
    if let Some(object) = result.as_object_mut() {
        object.retain(|key, _| !key.starts_with("_ledger_"));
    }
}

/// Execute a cascaded planner action through one safety/ledger seam shared by
/// Claude, Codex, Gemini, and OpenRouter.
pub(crate) async fn execute_cascaded_tool_call(
    ctx: &TaskCtx,
    tool_name: &str,
    args: Value,
    spoke_filler: &mut bool,
) -> Value {
    execute_tracked_tool_call(
        ctx,
        tool_name,
        args,
        true,
        None,
        "cascaded",
        Some(&ctx.utterance),
        Some(spoke_filler),
    )
    .await
}

/// Execute a desktop- or phone-hosted Realtime action through the same seam.
pub(crate) async fn execute_realtime_tool_call(
    ctx: &TaskCtx,
    tool_name: &str,
    args: Value,
    correlation: Option<ConfirmCorrelation>,
) -> Value {
    let source = if correlation.is_some() {
        "phone_realtime"
    } else {
        "desktop_realtime"
    };
    execute_tracked_tool_call(
        ctx,
        tool_name,
        args,
        false,
        correlation,
        source,
        Some(&ctx.utterance),
        None,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_outcome_respects_false_and_queued_results() {
        assert_eq!(
            action_outcome(&json!({ "ok": false })),
            ActionOutcome::Failed
        );
        assert_eq!(
            action_outcome(&json!({ "success": false })),
            ActionOutcome::Failed
        );
        assert_eq!(
            action_outcome(&json!({ "accepted": false })),
            ActionOutcome::Failed
        );
        assert_eq!(
            action_outcome(&json!({ "error": "failed" })),
            ActionOutcome::Failed
        );
        assert_eq!(
            action_outcome(&json!({ "dispatched": false, "approvalId": "approval-1" })),
            ActionOutcome::Queued
        );
        assert_eq!(
            action_outcome(&json!({ "dispatched": false, "error": "transport failed" })),
            ActionOutcome::Failed
        );
        assert_eq!(
            action_outcome(&json!({ "ok": true })),
            ActionOutcome::Succeeded
        );
    }

    #[test]
    fn opaque_inverse_metadata_never_returns_to_the_model() {
        let mut result = json!({
            "success": true,
            "reminder_id": "public-stable-id",
            "_ledger_fingerprint": "private body and post-state",
        });
        strip_internal_result_fields(&mut result);
        assert_eq!(result["reminder_id"], "public-stable-id");
        assert!(result.get("_ledger_fingerprint").is_none());
    }
}
