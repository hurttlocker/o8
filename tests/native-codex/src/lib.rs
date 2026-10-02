//! Bounded transport harness: compiles the production Codex source and its tests.
//! The desktop action loop is stubbed; no model, tools or credentials are used.
#![allow(dead_code)]
static DATA_DIR_ENV_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
#[path = "../../../src-tauri/src/models.rs"]
mod models;
struct ConfirmCorrelation;
struct LoopResult;
struct TaskCtx;
mod claude {
    use super::*;
    pub(crate) trait TextPlannerSession: Send + 'static {
        fn effective_model(&self) -> Option<&str> {
            None
        }
        fn send_planner_turn(
            &mut self,
            prompt: &str,
            image: Option<&str>,
        ) -> Result<String, String>;
    }
    pub fn path_with_node_runtime() -> String {
        std::env::var("PATH").unwrap_or_default()
    }
    pub async fn run_text_planner_loop<S: TextPlannerSession>(
        _: S,
        _: &str,
        _: &str,
        _: &TaskCtx,
        _: &str,
    ) -> Result<LoopResult, String> {
        unreachable!()
    }
    pub async fn run_text_planner_loop_correlated<S: TextPlannerSession>(
        _: S,
        _: &str,
        _: &str,
        _: &TaskCtx,
        _: &str,
        _: ConfirmCorrelation,
    ) -> Result<LoopResult, String> {
        unreachable!()
    }
}
#[path = "../../../src-tauri/src/agent/codex.rs"]
mod codex;

mod cli_locate {
    pub fn resolve_binary(_: &str, _: &[&str]) -> Option<String> {
        None
    }
}
fn agent_data_dir() -> std::path::PathBuf {
    panic!("use injected routing in harness")
}
mod front_brain {
    #[derive(Default, serde::Serialize)]
    pub struct SymonFrontBrainState;
    pub fn state() -> SymonFrontBrainState {
        SymonFrontBrainState
    }
}
#[path = "../../../src-tauri/src/agent/planner_route.rs"]
mod planner_route;
