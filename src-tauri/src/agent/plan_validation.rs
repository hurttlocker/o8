//! Pure validation, canonicalization, and redacted presentation for Symon plans.

use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use super::{plan::PlanSurface, safety, tools};

const MIN_PLAN_STEPS: usize = 2;
const MAX_PLAN_STEPS: usize = 5;
static PLAN_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PlanInput {
    steps: Vec<PlanInputStep>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PlanInputStep {
    tool: String,
    args: Value,
}

#[derive(Clone, Debug)]
pub(super) struct PlanStep {
    pub tool: String,
    pub args: Value,
    pub canonical: String,
    pub summary: String,
}

#[derive(Debug)]
pub(super) struct ValidatedPlan {
    pub plan_id: String,
    pub fingerprint: String,
    pub steps: Vec<PlanStep>,
}

pub(super) fn validate_plan(args: Value, surface: PlanSurface) -> Result<ValidatedPlan, String> {
    let input: PlanInput =
        serde_json::from_value(args).map_err(|error| format!("Invalid plan shape: {error}"))?;
    if !(MIN_PLAN_STEPS..=MAX_PLAN_STEPS).contains(&input.steps.len()) {
        return Err(format!(
            "A plan must contain {MIN_PLAN_STEPS} to {MAX_PLAN_STEPS} steps"
        ));
    }

    let all_schemas = schema_map(tools::all_tools());
    let available_schemas = match surface {
        PlanSurface::Cascaded => schema_map(tools::enabled_tools()),
        PlanSurface::Realtime => all_schemas.clone(),
    };
    let mut steps = Vec::with_capacity(input.steps.len());
    for (offset, input_step) in input.steps.into_iter().enumerate() {
        let step_index = offset + 1;
        let tool = input_step.tool.trim();
        if tool.is_empty() {
            return Err(format!("Plan step {step_index} has no tool name"));
        }
        if safety::is_plan_control_tool(tool) {
            return Err(format!(
                "Plan step {step_index} uses control tool '{tool}', which cannot be nested in a plan"
            ));
        }
        if !all_schemas.contains_key(tool) {
            return Err(format!("Plan step {step_index} uses unknown tool '{tool}'"));
        }
        let Some(schema) = available_schemas.get(tool) else {
            return Err(format!(
                "Plan step {step_index} uses tool '{tool}', which is not available to this runtime"
            ));
        };
        validate_tool_args(tool, &input_step.args, schema)
            .map_err(|error| format!("Plan step {step_index}: {error}"))?;
        steps.push(PlanStep {
            tool: tool.to_string(),
            canonical: canonical_step(tool, &input_step.args),
            summary: redacted_step_summary(tool, &input_step.args, schema),
            args: input_step.args,
        });
    }

    let exact_steps = steps
        .iter()
        .map(|step| step.canonical.clone())
        .collect::<Vec<_>>();
    Ok(ValidatedPlan {
        plan_id: format!(
            "plan-{}-{}",
            epoch_millis(),
            PLAN_COUNTER.fetch_add(1, Ordering::Relaxed)
        ),
        fingerprint: fingerprint_for_canonical_steps(&exact_steps),
        steps,
    })
}

fn schema_map(schemas: Vec<Value>) -> HashMap<String, Value> {
    schemas
        .into_iter()
        .filter_map(|schema| {
            let name = schema.get("name")?.as_str()?.to_string();
            Some((name, schema))
        })
        .collect()
}

fn validate_tool_args(tool: &str, args: &Value, tool_schema: &Value) -> Result<(), String> {
    let Some(args_object) = args.as_object() else {
        return Err(format!("arguments for '{tool}' must be an object"));
    };
    let parameters = tool_schema
        .get("parameters")
        .ok_or_else(|| format!("tool '{tool}' has no argument schema"))?;
    let properties = parameters
        .get("properties")
        .and_then(Value::as_object)
        .ok_or_else(|| format!("tool '{tool}' has an invalid argument schema"))?;
    for key in args_object.keys() {
        if key.starts_with("_symon") || !properties.contains_key(key) {
            return Err(format!("tool '{tool}' does not accept argument '{key}'"));
        }
    }
    if let Some(required) = parameters.get("required").and_then(Value::as_array) {
        for field in required.iter().filter_map(Value::as_str) {
            let value = args_object
                .get(field)
                .ok_or_else(|| format!("tool '{tool}' requires argument '{field}'"))?;
            if value.as_str().is_some_and(|value| value.trim().is_empty()) {
                return Err(format!(
                    "tool '{tool}' requires non-empty argument '{field}'"
                ));
            }
        }
    }
    for (key, value) in args_object {
        validate_schema_value(tool, key, value, &properties[key])?;
    }
    Ok(())
}

fn validate_schema_value(
    tool: &str,
    key: &str,
    value: &Value,
    schema: &Value,
) -> Result<(), String> {
    let valid_type = match schema.get("type").and_then(Value::as_str) {
        Some("string") => value.is_string(),
        Some("boolean") => value.is_boolean(),
        Some("integer") => value.as_i64().is_some() || value.as_u64().is_some(),
        Some("number") => value.is_number(),
        Some("object") => value.is_object(),
        Some("array") => value.is_array(),
        Some("null") => value.is_null(),
        Some(_) | None => true,
    };
    if !valid_type {
        return Err(format!("tool '{tool}' argument '{key}' has the wrong type"));
    }
    if let Some(choices) = schema.get("enum").and_then(Value::as_array) {
        if !choices.iter().any(|choice| choice == value) {
            return Err(format!(
                "tool '{tool}' argument '{key}' is not an allowed value"
            ));
        }
    }
    Ok(())
}

pub(super) fn canonical_step(tool: &str, args: &Value) -> String {
    canonical_json(&json!({ "tool": tool, "args": args }))
}

pub(super) fn fingerprint_for_canonical_steps(steps: &[String]) -> String {
    let canonical = format!("[{}]", steps.join(","));
    hex::encode(Sha256::digest(canonical.as_bytes()))
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string()),
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort_unstable();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string()),
                        canonical_json(&values[key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

fn safe_arg(args: &Value, key: &str) -> Option<String> {
    let value = args.get(key)?.as_str()?.trim();
    if value.is_empty() {
        return None;
    }
    let cleaned = value
        .chars()
        .filter(|character| !character.is_control())
        .take(100)
        .collect::<String>();
    (!cleaned.is_empty()).then_some(cleaned)
}

fn redacted_step_summary(tool: &str, args: &Value, schema: &Value) -> String {
    let quoted = |key: &str| safe_arg(args, key).map(|value| format!(" “{value}”"));
    match tool {
        "open_app" => format!(
            "Open{}",
            quoted("name").unwrap_or_else(|| " the requested app".to_string())
        ),
        "list_apps" => "List installed apps".to_string(),
        "mac_reminders_list" => "Review reminders".to_string(),
        "mac_reminders_create" => {
            format!("Create reminder{}", quoted("title").unwrap_or_default())
        }
        "mac_reminders_complete" => {
            format!("Complete reminder{}", quoted("title").unwrap_or_default())
        }
        "mac_reminders_update" => {
            format!("Update reminder{}", quoted("title").unwrap_or_default())
        }
        "mac_calendar_list_events" => "Review upcoming calendar events".to_string(),
        "mac_calendar_create_event" => format!(
            "Create calendar event{}",
            quoted("title").unwrap_or_default()
        ),
        "mac_calendar_update_event" => format!(
            "Update calendar event{}",
            quoted("title").unwrap_or_default()
        ),
        "mac_calendar_delete_event" => format!(
            "Delete calendar event{}",
            quoted("title").unwrap_or_default()
        ),
        "mac_notes_search" => "Search notes".to_string(),
        "mac_notes_create" => {
            format!("Create note{}", quoted("title").unwrap_or_default())
        }
        "mac_notes_append" => {
            format!("Append to note{}", quoted("title").unwrap_or_default())
        }
        "mac_contacts_search" => "Search contacts".to_string(),
        "mac_mail_search" => "Search mail".to_string(),
        "mac_mail_read" => "Read the selected email".to_string(),
        "mac_mail_draft" => {
            format!("Draft email{}", quoted("subject").unwrap_or_default())
        }
        "mac_mail_send_draft" => {
            format!("Send draft email{}", quoted("subject").unwrap_or_default())
        }
        "fs_read_text" => format!("Read file{}", quoted("path").unwrap_or_default()),
        "fs_write_text" => format!("Write file{}", quoted("path").unwrap_or_default()),
        "fs_spotlight" => "Search local files".to_string(),
        "csv_read" => format!("Read CSV{}", quoted("filename").unwrap_or_default()),
        "csv_write" => format!("Write CSV{}", quoted("filename").unwrap_or_default()),
        "apply_text_edit" => "Edit the currently selected text".to_string(),
        "mac_shortcuts_list" => "List Shortcuts".to_string(),
        "mac_shortcuts_run" => {
            format!("Run Shortcut{}", quoted("name").unwrap_or_default())
        }
        "term_send" | "terminal_send" | "agent_turn" => {
            "Send a command to the selected terminal".to_string()
        }
        "o8_browser_act" => "Act on the current browser page".to_string(),
        "gh_issue_create" => format!("Create GitHub issue{}", quoted("title").unwrap_or_default()),
        "gh_comment" => format!(
            "Comment on GitHub {} #{} in{}",
            safe_arg(args, "kind").unwrap_or_else(|| "item".to_string()),
            args.get("number").and_then(Value::as_u64).unwrap_or(0),
            quoted("repo").unwrap_or_else(|| " the requested repo".to_string()),
        ),
        "mac_weather" => "Check the weather".to_string(),
        "mac_music_play" => "Start the requested music".to_string(),
        "mac_music_pause" => "Pause music".to_string(),
        "mac_music_next" => "Skip to the next song".to_string(),
        "mac_music_previous" => "Return to the previous song".to_string(),
        "mac_volume" => "Adjust system volume".to_string(),
        _ => schema
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(tool)
            .replace('_', " "),
    }
}

pub(super) fn spoken_plan_readback(steps: &[PlanStep]) -> String {
    let mut parts = Vec::with_capacity(steps.len());
    for (index, step) in steps.iter().enumerate() {
        let lead = match index {
            0 => "First",
            value if value + 1 == steps.len() => "Finally",
            _ => "Then",
        };
        parts.push(format!("{lead}, {}.", step.summary));
    }
    format!(
        "Here is the plan. {} Approve this plan to run its safe steps. Any destructive step will still ask separately.",
        parts.join(" ")
    )
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
    use crate::agent::plan::PLAN_TOOL_NAME;

    fn plan_args(steps: Vec<Value>) -> Value {
        json!({ "steps": steps })
    }

    #[test]
    fn fingerprint_is_key_order_stable_but_step_order_sensitive() {
        let first = canonical_step(
            "mac_reminders_create",
            &json!({ "title": "Buy milk", "notes": "2%" }),
        );
        let same = canonical_step(
            "mac_reminders_create",
            &json!({ "notes": "2%", "title": "Buy milk" }),
        );
        assert_eq!(first, same);
        let weather = canonical_step("mac_weather", &json!({}));
        assert_ne!(
            fingerprint_for_canonical_steps(&[first.clone(), weather.clone()]),
            fingerprint_for_canonical_steps(&[weather, first])
        );
    }

    #[test]
    fn shape_is_bounded_and_rejects_model_authority_fields() {
        assert!(validate_plan(
            plan_args(vec![json!({ "tool": "mac_weather", "args": {} })]),
            PlanSurface::Cascaded
        )
        .is_err());
        assert!(validate_plan(
            json!({
                "steps": [
                    { "tool": "mac_weather", "args": {} },
                    { "tool": "mac_reminders_list", "args": {} }
                ],
                "preconfirmed": true
            }),
            PlanSurface::Cascaded
        )
        .is_err());
        assert!(validate_plan(
            plan_args(vec![
                json!({ "tool": "mac_weather", "args": { "_symonPlanGrant": true } }),
                json!({ "tool": "mac_reminders_list", "args": {} }),
            ]),
            PlanSurface::Cascaded
        )
        .is_err());
    }

    #[test]
    fn unavailable_destructive_and_control_tools_are_rejected() {
        let destructive = validate_plan(
            plan_args(vec![
                json!({ "tool": "mac_mail_send_draft", "args": { "subject": "Hello" } }),
                json!({ "tool": "mac_weather", "args": {} }),
            ]),
            PlanSurface::Cascaded,
        );
        assert!(destructive.unwrap_err().contains("not available"));
        let recursive = validate_plan(
            plan_args(vec![
                json!({ "tool": PLAN_TOOL_NAME, "args": {} }),
                json!({ "tool": "mac_weather", "args": {} }),
            ]),
            PlanSurface::Realtime,
        );
        assert!(recursive.unwrap_err().contains("control tool"));
    }

    #[test]
    fn argument_schema_is_checked_before_readback() {
        let missing = validate_plan(
            plan_args(vec![
                json!({ "tool": "mac_reminders_create", "args": {} }),
                json!({ "tool": "mac_weather", "args": {} }),
            ]),
            PlanSurface::Cascaded,
        );
        assert!(missing.unwrap_err().contains("requires argument 'title'"));
        let wrong_enum = validate_plan(
            plan_args(vec![
                json!({ "tool": "mac_volume", "args": { "action": "explode" } }),
                json!({ "tool": "mac_weather", "args": {} }),
            ]),
            PlanSurface::Cascaded,
        );
        assert!(wrong_enum.unwrap_err().contains("not an allowed value"));
    }

    #[test]
    fn readback_omits_sensitive_bodies_and_commands() {
        let plan = validate_plan(
            plan_args(vec![
                json!({ "tool": "mac_mail_draft", "args": { "to": "a@example.com", "subject": "Hello", "body": "secret body" } }),
                json!({ "tool": "term_send", "args": { "id": "t:1", "command": "secret command", "title": "shell" } }),
                json!({ "tool": "agent_turn", "args": { "id": "t:2", "title": "Claude", "prompt": "secret agent prompt" } }),
                json!({ "tool": "gh_comment", "args": { "repo": "o8", "kind": "issue", "number": 52, "body": "secret GitHub body" } }),
            ]),
            PlanSurface::Cascaded,
        )
        .expect("valid plan");
        let readback = spoken_plan_readback(&plan.steps);
        assert!(!readback.contains("secret body"));
        assert!(!readback.contains("secret command"));
        assert!(!readback.contains("secret agent prompt"));
        assert!(!readback.contains("secret GitHub body"));
        assert!(readback.contains("Draft email “Hello”"));
        assert!(readback.contains("Comment on GitHub issue #52 in “o8”"));
    }
}
