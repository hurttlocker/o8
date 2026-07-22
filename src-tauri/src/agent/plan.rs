//! Native, immutable execution plans for Symon's chained voice tasks.
//!
//! The model can propose only a bounded list of ordinary tool calls. Native
//! code validates the exact provider-visible catalog and each argument schema,
//! derives a canonical fingerprint and redacted read-back, then creates an
//! opaque grant only after the confirmation card resolves. The grant is never
//! serialized into model-visible arguments.

use serde_json::{json, Value};

use super::plan_validation::{
    canonical_step, fingerprint_for_canonical_steps, spoken_plan_readback, validate_plan,
    ValidatedPlan,
};
use super::{
    confirm_with_receipt, emit_agent_event, execution, ledger, safety, ConfirmCorrelation, TaskCtx,
};

pub(super) const PLAN_TOOL_NAME: &str = "symon_execute_plan";
const PLAN_GRANT_TTL_MS: u64 = 15 * 60 * 1_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum PlanSurface {
    Cascaded,
    Realtime,
}

/// Opaque native authority created only after the exact plan card is approved.
/// A grant is bound to the full canonical plan, an expiry, and the approved
/// order. It can waive duplicate cards only for non-destructive exact steps.
#[derive(Debug)]
pub(super) struct PlanGrant {
    plan_id: String,
    fingerprint: String,
    exact_steps: Vec<String>,
    task_id: String,
    session_id: Option<String>,
    confirmation_id: Option<String>,
    expires_at_ms: u64,
}

impl PlanGrant {
    fn from_approved(
        plan: &ValidatedPlan,
        task_id: &str,
        session_id: Option<&str>,
        confirmation_id: Option<String>,
    ) -> Self {
        Self {
            plan_id: plan.plan_id.clone(),
            fingerprint: plan.fingerprint.clone(),
            exact_steps: plan
                .steps
                .iter()
                .map(|step| step.canonical.clone())
                .collect(),
            task_id: task_id.to_string(),
            session_id: session_id.map(str::to_string),
            confirmation_id,
            expires_at_ms: epoch_millis().saturating_add(PLAN_GRANT_TTL_MS),
        }
    }

    pub(super) fn plan_id(&self) -> &str {
        &self.plan_id
    }

    pub(super) fn confirmation_id(&self) -> Option<&str> {
        self.confirmation_id.as_deref()
    }

    pub(super) fn matches_exact(
        &self,
        task_id: &str,
        session_id: Option<&str>,
        step_index: usize,
        tool: &str,
        args: &Value,
    ) -> bool {
        if epoch_millis() > self.expires_at_ms || step_index == 0 {
            return false;
        }
        let Some(expected) = self.exact_steps.get(step_index - 1) else {
            return false;
        };
        let current = canonical_step(tool, args);
        self.confirmation_id.is_some()
            && self.task_id == task_id
            && self.session_id.as_deref() == session_id
            && expected == &current
            && self.fingerprint == fingerprint_for_canonical_steps(&self.exact_steps)
    }

    pub(super) fn authorizes_safe_step(
        &self,
        task_id: &str,
        session_id: Option<&str>,
        step_index: usize,
        tool: &str,
        args: &Value,
    ) -> bool {
        !safety::requires_individual_plan_confirmation(tool)
            && self.matches_exact(task_id, session_id, step_index, tool, args)
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn execute_plan(
    ctx: &TaskCtx,
    args: Value,
    surface: PlanSurface,
    speak: bool,
    correlation: Option<ConfirmCorrelation>,
    source: &str,
    utterance: Option<&str>,
    mut spoke_filler: Option<&mut bool>,
) -> Value {
    let plan = match validate_plan(args, surface) {
        Ok(plan) => plan,
        Err(detail) => {
            return json!({
                "ok": false,
                "error": "invalid_plan",
                "detail": detail,
                "invalid_plan": true,
            })
        }
    };
    let step_count = plan.steps.len();
    let plan_summary = format!(
        "Run this {step_count}-step plan: {}",
        plan.steps
            .iter()
            .enumerate()
            .map(|(index, step)| format!("{}. {}", index + 1, step.summary))
            .collect::<Vec<_>>()
            .join("; ")
    );
    let spoken_readback = spoken_plan_readback(&plan.steps);
    let plan_steps = plan
        .steps
        .iter()
        .enumerate()
        .map(|(index, step)| json!({ "index": index + 1, "summary": step.summary }))
        .collect::<Vec<_>>();

    if let Err(error) = record_lifecycle(
        ctx,
        source,
        &plan.plan_id,
        "proposed",
        &plan_summary,
        "pending",
        None,
        step_count,
    ) {
        return json!({
            "ok": false,
            "error": "plan_ledger_unavailable",
            "detail": format!("The plan ledger is unavailable, so no plan was run: {error}"),
            "ledger_error": true,
        });
    }

    let approval_args = json!({
        "_symonPlanId": plan.plan_id,
        "_symonPlanFingerprint": plan.fingerprint,
        "_symonPlanSummary": plan_summary,
        "_symonPlanSpokenReadback": spoken_readback,
        "_symonPlanSteps": plan_steps,
    });
    let confirmation = confirm_with_receipt(
        ctx,
        PLAN_TOOL_NAME,
        &approval_args,
        speak,
        correlation.clone(),
    )
    .await;
    if !confirmation.approved() {
        let outcome = confirmation.outcome.as_str();
        let _ = record_lifecycle(
            ctx,
            source,
            &plan.plan_id,
            "rejected",
            "Plan did not receive approval",
            outcome,
            None,
            step_count,
        );
        return json!({
            "ok": false,
            "error": "confirmation_declined",
            "detail": "The plan was not approved, so no steps ran",
            "declined_by_user": true,
            "confirmation_outcome": outcome,
            "planId": plan.plan_id,
        });
    }
    if ctx.is_cancelled() {
        let _ = record_lifecycle(
            ctx,
            source,
            &plan.plan_id,
            "cancelled",
            "Plan stopped before its first step",
            "cancelled",
            None,
            step_count,
        );
        let mut outcomes = Vec::new();
        mark_remaining_skipped(
            ctx,
            source,
            &plan,
            1,
            "Plan stopped by the operator",
            &mut outcomes,
        );
        emit_progress(
            ctx,
            &plan,
            1,
            "cancelled",
            plan.steps.first().map(|step| step.summary.as_str()),
            Some("Plan stopped before its first step"),
        );
        return cancelled_plan_result(&plan, 0, outcomes);
    }
    if let Err(error) = record_lifecycle(
        ctx,
        source,
        &plan.plan_id,
        "approved",
        "Exact plan approved",
        "approved",
        None,
        step_count,
    ) {
        return json!({
            "ok": false,
            "error": "plan_ledger_unavailable",
            "detail": format!("The plan approval could not be checkpointed, so no steps ran: {error}"),
            "ledger_error": true,
            "planId": plan.plan_id,
        });
    }

    let grant = PlanGrant::from_approved(
        &plan,
        &ctx.task_id,
        ctx.ledger_session_id.as_deref(),
        confirmation.confirmation_id.clone(),
    );
    let mut outcomes = Vec::with_capacity(step_count);
    for (offset, step) in plan.steps.iter().enumerate() {
        let step_index = offset + 1;
        if ctx.is_cancelled() {
            mark_remaining_skipped(
                ctx,
                source,
                &plan,
                step_index,
                "Plan stopped by the operator",
                &mut outcomes,
            );
            let _ = record_lifecycle(
                ctx,
                source,
                &plan.plan_id,
                "cancelled",
                "Plan stopped between steps",
                "cancelled",
                None,
                step_count,
            );
            emit_progress(
                ctx,
                &plan,
                step_index,
                "cancelled",
                Some(&plan.steps[step_index - 1].summary),
                Some("Plan stopped by the operator"),
            );
            return cancelled_plan_result(&plan, step_index - 1, outcomes);
        }

        if let Err(error) = record_lifecycle(
            ctx,
            source,
            &plan.plan_id,
            "step_running",
            &step.summary,
            "running",
            Some(step_index),
            step_count,
        ) {
            mark_remaining_skipped(
                ctx,
                source,
                &plan,
                step_index,
                "Plan ledger failed before this step",
                &mut outcomes,
            );
            return json!({
                "ok": false,
                "error": "plan_ledger_unavailable",
                "detail": format!("The plan ledger failed before step {step_index}, so execution stopped: {error}"),
                "ledger_error": true,
                "planId": plan.plan_id,
                "steps": outcomes,
            });
        }
        emit_progress(ctx, &plan, step_index, "running", Some(&step.summary), None);

        let result = execution::execute_plan_step(
            ctx,
            &grant,
            step_index,
            step_count,
            &step.tool,
            step.args.clone(),
            speak,
            correlation.clone(),
            source,
            utterance,
            spoke_filler.as_deref_mut(),
        )
        .await;
        if result_failed(&result) {
            let cancelled =
                result.get("cancelled") == Some(&Value::Bool(true)) || ctx.is_cancelled();
            let status = if cancelled { "cancelled" } else { "failed" };
            let result_summary = if cancelled {
                "Stopped before this step ran"
            } else {
                "This step returned an error"
            };
            let _ = record_lifecycle(
                ctx,
                source,
                &plan.plan_id,
                if cancelled {
                    "step_cancelled"
                } else {
                    "step_failed"
                },
                &step.summary,
                status,
                Some(step_index),
                step_count,
            );
            emit_progress(
                ctx,
                &plan,
                step_index,
                status,
                Some(&step.summary),
                Some(result_summary),
            );
            outcomes.push(json!({
                "index": step_index,
                "tool": step.tool,
                "summary": step.summary,
                "status": status,
                "result": result,
            }));
            mark_remaining_skipped(
                ctx,
                source,
                &plan,
                step_index + 1,
                if cancelled {
                    "Plan stopped by the operator"
                } else {
                    "Skipped after the preceding step failed"
                },
                &mut outcomes,
            );
            // Synthesized skipped rows are useful history, but the stable UI
            // key is the plan id. Re-emit the actual terminal step last so the
            // glint settles on failed/cancelled rather than a later skip.
            emit_progress(
                ctx,
                &plan,
                step_index,
                status,
                Some(&step.summary),
                Some(result_summary),
            );
            let _ = record_lifecycle(
                ctx,
                source,
                &plan.plan_id,
                if cancelled { "cancelled" } else { "failed" },
                if cancelled {
                    "Plan stopped before completion"
                } else {
                    "Plan stopped on its first failed step"
                },
                status,
                None,
                step_count,
            );
            return failed_plan_result(&plan, cancelled, step_index, outcomes);
        }

        let _ = record_lifecycle(
            ctx,
            source,
            &plan.plan_id,
            "step_completed",
            &step.summary,
            "completed",
            Some(step_index),
            step_count,
        );
        emit_progress(
            ctx,
            &plan,
            step_index,
            "completed",
            Some(&step.summary),
            Some("Completed"),
        );
        outcomes.push(json!({
            "index": step_index,
            "tool": step.tool,
            "summary": step.summary,
            "status": "completed",
            "result": result,
        }));
    }

    let report = format!("Completed all {step_count} approved plan steps.");
    let _ = record_lifecycle(
        ctx,
        source,
        &plan.plan_id,
        "completed",
        &report,
        "completed",
        None,
        step_count,
    );
    json!({
        "ok": true,
        "planId": plan.plan_id,
        "fingerprint": plan.fingerprint,
        "completedSteps": step_count,
        "stepCount": step_count,
        "steps": outcomes,
        "report": report,
    })
}

#[allow(clippy::too_many_arguments)]
fn record_lifecycle(
    ctx: &TaskCtx,
    source: &str,
    plan_id: &str,
    phase: &str,
    redacted_summary: &str,
    outcome: &str,
    step_index: Option<usize>,
    step_count: usize,
) -> Result<(), String> {
    ledger::record_plan_lifecycle(ledger::PlanLifecycleRecord {
        plan_id,
        task_id: &ctx.task_id,
        source,
        phase,
        redacted_summary,
        outcome,
        session_id: ctx.ledger_session_id.as_deref(),
        step_index,
        step_count,
    })
}

fn emit_progress(
    ctx: &TaskCtx,
    plan: &ValidatedPlan,
    step_index: usize,
    status: &str,
    summary: Option<&str>,
    result: Option<&str>,
) {
    let Some(app) = ctx.app.as_ref() else {
        return;
    };
    emit_agent_event(
        app,
        plan_progress_payload(&ctx.task_id, plan, step_index, status, summary, result),
    );
}

fn plan_progress_payload(
    task_id: &str,
    plan: &ValidatedPlan,
    step_index: usize,
    status: &str,
    summary: Option<&str>,
    result: Option<&str>,
) -> Value {
    json!({
        "kind": "plan_progress",
        "planId": plan.plan_id,
        "taskId": task_id,
        "stepIndex": step_index,
        "stepCount": plan.steps.len(),
        "status": status,
        "summary": summary,
        "result": result,
    })
}

fn mark_remaining_skipped(
    ctx: &TaskCtx,
    source: &str,
    plan: &ValidatedPlan,
    from_step: usize,
    reason: &str,
    outcomes: &mut Vec<Value>,
) {
    for (offset, step) in plan
        .steps
        .iter()
        .enumerate()
        .skip(from_step.saturating_sub(1))
    {
        let step_index = offset + 1;
        let _ = record_lifecycle(
            ctx,
            source,
            &plan.plan_id,
            "step_skipped",
            &step.summary,
            "skipped",
            Some(step_index),
            plan.steps.len(),
        );
        emit_progress(
            ctx,
            plan,
            step_index,
            "skipped",
            Some(&step.summary),
            Some(reason),
        );
        outcomes.push(json!({
            "index": step_index,
            "tool": step.tool,
            "summary": step.summary,
            "status": "skipped",
            "reason": reason,
        }));
    }
}

fn cancelled_plan_result(plan: &ValidatedPlan, completed: usize, outcomes: Vec<Value>) -> Value {
    json!({
        "ok": false,
        // Existing relay semantics map this stable error to a stopped action.
        "error": "session_stopped",
        "cancelled": true,
        "planId": plan.plan_id,
        "fingerprint": plan.fingerprint,
        "completedSteps": completed,
        "stepCount": plan.steps.len(),
        "steps": outcomes,
        "report": format!("Stopped the plan after {completed} of {} steps.", plan.steps.len()),
    })
}

fn failed_plan_result(
    plan: &ValidatedPlan,
    cancelled: bool,
    step_index: usize,
    outcomes: Vec<Value>,
) -> Value {
    let step_count = plan.steps.len();
    json!({
        "ok": false,
        "error": if cancelled { "session_stopped" } else { "plan_failed" },
        "cancelled": cancelled,
        "planId": plan.plan_id,
        "fingerprint": plan.fingerprint,
        "completedSteps": step_index.saturating_sub(1),
        "stepCount": step_count,
        "steps": outcomes,
        "report": if cancelled {
            format!("Stopped the plan at step {step_index} of {step_count}.")
        } else {
            format!("Stopped the plan because step {step_index} of {step_count} failed.")
        },
    })
}

fn result_failed(result: &Value) -> bool {
    result.get("error").is_some()
        || result.get("success") == Some(&Value::Bool(false))
        || result.get("ok") == Some(&Value::Bool(false))
        || result.get("accepted") == Some(&Value::Bool(false))
}

fn epoch_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn validated_plan(steps: Vec<Value>) -> ValidatedPlan {
        validate_plan(json!({ "steps": steps }), PlanSurface::Realtime).expect("valid plan")
    }

    #[test]
    fn grant_is_task_session_step_and_safety_bound() {
        let plan = validated_plan(vec![
            json!({ "tool": "mac_shortcuts_run", "args": { "name": "Lock Screen" } }),
            json!({ "tool": "mac_weather", "args": {} }),
        ]);
        let grant = PlanGrant::from_approved(
            &plan,
            "task-1",
            Some("session-1"),
            Some("confirm-plan".to_string()),
        );
        assert!(grant.matches_exact(
            "task-1",
            Some("session-1"),
            1,
            &plan.steps[0].tool,
            &plan.steps[0].args,
        ));
        assert!(!grant.authorizes_safe_step(
            "task-1",
            Some("session-1"),
            1,
            &plan.steps[0].tool,
            &plan.steps[0].args,
        ));
        assert!(grant.authorizes_safe_step(
            "task-1",
            Some("session-1"),
            2,
            &plan.steps[1].tool,
            &plan.steps[1].args,
        ));
        assert!(!grant.matches_exact(
            "another-task",
            Some("session-1"),
            2,
            &plan.steps[1].tool,
            &plan.steps[1].args,
        ));
        assert!(!grant.matches_exact(
            "task-1",
            Some("another-session"),
            2,
            &plan.steps[1].tool,
            &plan.steps[1].args,
        ));
        assert!(!grant.matches_exact(
            "task-1",
            Some("session-1"),
            2,
            "mac_weather",
            &json!({ "unexpected": true }),
        ));
        assert_eq!(grant.confirmation_id(), Some("confirm-plan"));
    }

    #[test]
    fn expired_grant_fails_exact_match() {
        let plan = validated_plan(vec![
            json!({ "tool": "mac_weather", "args": {} }),
            json!({ "tool": "mac_reminders_list", "args": {} }),
        ]);
        let mut grant =
            PlanGrant::from_approved(&plan, "task-1", None, Some("confirm-plan".to_string()));
        grant.expires_at_ms = 0;
        assert!(!grant.matches_exact("task-1", None, 1, &plan.steps[0].tool, &plan.steps[0].args,));
    }

    #[test]
    fn terminal_steps_keep_their_individual_confirmation() {
        let plan = validated_plan(vec![
            json!({
                "tool": "term_send",
                "args": { "id": "t:1", "command": "npm test", "title": "o8 shell" }
            }),
            json!({ "tool": "mac_weather", "args": {} }),
        ]);
        let grant =
            PlanGrant::from_approved(&plan, "task-1", None, Some("confirm-plan".to_string()));
        assert!(grant.matches_exact("task-1", None, 1, &plan.steps[0].tool, &plan.steps[0].args,));
        assert!(!grant.authorizes_safe_step(
            "task-1",
            None,
            1,
            &plan.steps[0].tool,
            &plan.steps[0].args,
        ));
    }

    #[test]
    fn cancelled_result_does_not_duplicate_precomputed_skips() {
        let plan = validated_plan(vec![
            json!({ "tool": "mac_weather", "args": {} }),
            json!({ "tool": "mac_reminders_list", "args": {} }),
        ]);
        let outcomes = vec![
            json!({ "index": 1, "status": "skipped" }),
            json!({ "index": 2, "status": "skipped" }),
        ];
        let result = cancelled_plan_result(&plan, 0, outcomes);
        assert_eq!(result["steps"].as_array().map(Vec::len), Some(2));
        assert_eq!(result["completedSteps"], json!(0));
        assert_eq!(result["error"], json!("session_stopped"));
        assert_eq!(result["cancelled"], json!(true));
    }

    #[test]
    fn failed_result_has_stable_top_level_error_code() {
        let plan = validated_plan(vec![
            json!({ "tool": "mac_weather", "args": {} }),
            json!({ "tool": "mac_reminders_list", "args": {} }),
        ]);
        let result = failed_plan_result(
            &plan,
            false,
            2,
            vec![
                json!({ "index": 1, "status": "completed" }),
                json!({ "index": 2, "status": "failed" }),
            ],
        );
        assert_eq!(result["ok"], json!(false));
        assert_eq!(result["error"], json!("plan_failed"));
        assert_eq!(result["completedSteps"], json!(1));
        assert_eq!(result["cancelled"], json!(false));
    }

    #[test]
    fn terminal_progress_is_last_after_synthesized_skips() {
        let plan = validated_plan(vec![
            json!({ "tool": "mac_weather", "args": {} }),
            json!({ "tool": "mac_reminders_list", "args": {} }),
            json!({ "tool": "mac_notes_search", "args": { "query": "trip" } }),
        ]);
        let sequence = [
            plan_progress_payload("task-1", &plan, 2, "skipped", None, None),
            plan_progress_payload("task-1", &plan, 3, "skipped", None, None),
            plan_progress_payload(
                "task-1",
                &plan,
                1,
                "failed",
                Some("Check the weather"),
                Some("This step returned an error"),
            ),
        ];
        assert_eq!(
            sequence.last().and_then(|event| event["status"].as_str()),
            Some("failed")
        );
        assert_eq!(
            sequence.last().and_then(|event| event["planId"].as_str()),
            Some(plan.plan_id.as_str())
        );
    }
}
