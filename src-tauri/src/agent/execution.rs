//! One governed execution seam shared by every Symon planner and Realtime.

use serde_json::{json, Value};

use super::{
    confirm_with_receipt, ledger, maybe_speak_filler, plan, tools, undo, ConfirmCorrelation,
    TaskCtx,
};

#[derive(Clone, Copy)]
struct TrackedPlanStep<'a> {
    grant: &'a plan::PlanGrant,
    step_index: usize,
    step_count: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PlanConfirmationRoute {
    Invalid,
    Aggregate,
    Individual,
}

fn plan_confirmation_route(
    has_plan_step: bool,
    plan_exact: bool,
    aggregate_authorized: bool,
) -> PlanConfirmationRoute {
    if has_plan_step && !plan_exact {
        PlanConfirmationRoute::Invalid
    } else if aggregate_authorized {
        PlanConfirmationRoute::Aggregate
    } else {
        PlanConfirmationRoute::Individual
    }
}

impl<'a> TrackedPlanStep<'a> {
    fn ledger_context(self) -> ledger::PlanStepContext<'a> {
        ledger::PlanStepContext {
            plan_id: self.grant.plan_id(),
            step_index: self.step_index,
            step_count: self.step_count,
        }
    }
}

async fn execute_tracked_tool_call(
    ctx: &TaskCtx,
    tool_name: &str,
    args: Value,
    speak: bool,
    correlation: Option<ConfirmCorrelation>,
    source: &str,
    utterance: Option<&str>,
    mut spoke_filler: Option<&mut bool>,
    plan_step: Option<TrackedPlanStep<'_>>,
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
        plan: plan_step.map(|step| step.ledger_context()),
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
    let plan_exact = match plan_step {
        Some(step) => step.grant.matches_exact(
            &ctx.task_id,
            ctx.ledger_session_id.as_deref(),
            step.step_index,
            effective_tool,
            &effective_args,
        ),
        None => true,
    };
    let plan_authorized = plan_step.is_some_and(|step| {
        step.grant.authorizes_safe_step(
            &ctx.task_id,
            ctx.ledger_session_id.as_deref(),
            step.step_index,
            effective_tool,
            &effective_args,
        )
    });
    let plan_confirmation =
        plan_confirmation_route(plan_step.is_some(), plan_exact, plan_authorized);
    let confirmation = if ctx.is_cancelled() {
        super::ConfirmationReceipt {
            confirmation_id: None,
            outcome: super::ConfirmationOutcome::Preempted,
        }
    } else if plan_confirmation == PlanConfirmationRoute::Invalid || preflight_error.is_some() {
        super::ConfirmationReceipt {
            confirmation_id: None,
            outcome: super::ConfirmationOutcome::NotRequired,
        }
    } else if plan_confirmation == PlanConfirmationRoute::Aggregate {
        super::ConfirmationReceipt {
            confirmation_id: plan_step
                .and_then(|step| step.grant.confirmation_id())
                .map(str::to_string),
            outcome: super::ConfirmationOutcome::Approved,
        }
    } else {
        confirm_with_receipt(ctx, effective_tool, &effective_args, speak, correlation).await
    };

    let mut prepared_undo = None;
    let mut result = if !plan_exact {
        json!({
            "error": "The approved plan no longer matches this step, so it was not run",
            "plan_grant_mismatch": true,
        })
    } else if let Some(error) = preflight_error {
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
    } else if ctx.is_cancelled() {
        json!({
            "error": "The plan was stopped before this step ran",
            "cancelled": true,
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
            plan: plan_step.map(|step| step.ledger_context()),
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
        // Phone correlation is server-owned execution metadata, never part of
        // model-authored arguments or a plan fingerprint. Inject it only after
        // validation/confirmation and only for the delegate handler that needs
        // to correlate its WS-host task.
        if tool_name == "o8_delegate" {
            if let Some(value) = session_id.as_deref() {
                dispatch_args["__symonSessionId"] = json!(value);
            }
            if let Some(value) = call_id.as_deref() {
                dispatch_args["__symonCallId"] = json!(value);
            }
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
        plan: plan_step.map(|step| step.ledger_context()),
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
    if tool_name == plan::PLAN_TOOL_NAME {
        return plan::execute_plan(
            ctx,
            args,
            plan::PlanSurface::Cascaded,
            true,
            None,
            "cascaded",
            Some(&ctx.utterance),
            Some(spoke_filler),
        )
        .await;
    }
    execute_tracked_tool_call(
        ctx,
        tool_name,
        args,
        true,
        None,
        "cascaded",
        Some(&ctx.utterance),
        Some(spoke_filler),
        None,
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
    if tool_name == plan::PLAN_TOOL_NAME {
        return plan::execute_plan(
            ctx,
            args,
            plan::PlanSurface::Realtime,
            false,
            correlation,
            source,
            Some(&ctx.utterance),
            None,
        )
        .await;
    }
    execute_tracked_tool_call(
        ctx,
        tool_name,
        args,
        false,
        correlation,
        source,
        Some(&ctx.utterance),
        None,
        None,
    )
    .await
}

/// Execute one exact, native-approved plan step through the same action-ledger,
/// confirmation, undo, and dispatch seam as an ordinary provider tool call.
/// The grant is an opaque Rust value created only after the plan card resolves;
/// no model argument can manufacture or widen it.
pub(super) async fn execute_plan_step(
    ctx: &TaskCtx,
    grant: &plan::PlanGrant,
    step_index: usize,
    step_count: usize,
    tool_name: &str,
    args: Value,
    speak: bool,
    correlation: Option<ConfirmCorrelation>,
    source: &str,
    utterance: Option<&str>,
    spoke_filler: Option<&mut bool>,
) -> Value {
    execute_tracked_tool_call(
        ctx,
        tool_name,
        args,
        speak,
        correlation,
        source,
        utterance,
        spoke_filler,
        Some(TrackedPlanStep {
            grant,
            step_index,
            step_count,
        }),
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
    fn exact_always_carded_plan_step_routes_to_individual_confirmation() {
        assert!(crate::agent::safety::requires_individual_plan_confirmation(
            "term_send"
        ));
        assert_eq!(
            plan_confirmation_route(true, true, false),
            PlanConfirmationRoute::Individual,
        );
        assert_eq!(
            plan_confirmation_route(true, false, false),
            PlanConfirmationRoute::Invalid,
        );
        assert_eq!(
            plan_confirmation_route(true, true, true),
            PlanConfirmationRoute::Aggregate,
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
