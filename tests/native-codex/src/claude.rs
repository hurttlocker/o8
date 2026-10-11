use super::*;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
const MAX_TURNS: usize = 10;
const TURN_TIMEOUT_SECS: u64 = 2;
const FIRST_TURN_MODEL_UNAVAILABLE_PREFIX: &str = "claude first turn model unavailable: ";
const PREMATURE_DONE_NUDGE: &str = "fixture nudge";
fn is_model_unavailable_error(_: &str) -> bool {
    false
}
fn looks_like_action_request(_: &str) -> bool {
    false
}
fn say_is_question_or_refusal(_: &str) -> bool {
    false
}
fn extract_action(text: &str) -> Option<Value> {
    serde_json::from_str(text).ok()
}
fn text_tool_result_message(tool: &str, result: &Value) -> String {
    format!("{tool}: {result}")
}
mod planner_payload {
    use super::*;
    pub const TOOL_LOOKUP: &str = "fixture_lookup";
    pub const MAX_TOOL_LOOKUPS: usize = 3;
    pub struct Prompt {
        pub prompt: String,
        pub tool_defs: usize,
    }
    pub fn build_first_prompt(intent: &str, _: &TaskCtx) -> Prompt {
        Prompt {
            prompt: intent.into(),
            tool_defs: 0,
        }
    }
    pub fn requested_lookup_names(_: &Value) -> Vec<String> {
        vec![]
    }
    pub fn lookup_budget_spent_message() -> String {
        "budget spent".into()
    }
    pub fn tool_lookup_message(_: &[String]) -> String {
        "tools".into()
    }
}
pub(crate) trait TextPlannerSession: Send + 'static {
    fn effective_model(&self) -> Option<&str> {
        None
    }
    fn send_planner_turn(&mut self, prompt: &str, image: Option<&str>) -> Result<String, String>;
}
pub fn path_with_node_runtime() -> String {
    std::env::var("PATH").unwrap_or_default()
}
#[path = "../../../src-tauri/src/agent/claude/text_loop.rs"]
mod text_loop;
pub(crate) use text_loop::{run_text_planner_loop, run_text_planner_loop_correlated};
