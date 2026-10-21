//! Bound text terminal metadata survives planner errors and blocking-task teardown.
use super::{machine, LoopResult};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub(crate) struct EffectiveTextSelection(Arc<Mutex<(String, String)>>);

impl EffectiveTextSelection {
    pub(crate) fn new(model: &str, effort: &str) -> Self {
        Self(Arc::new(Mutex::new((
            model.to_string(),
            effort.to_string(),
        ))))
    }

    pub(crate) fn bind(&self, model: &str, effort: &str) {
        *self.0.lock().unwrap_or_else(|error| error.into_inner()) =
            (model.to_string(), effort.to_string());
    }

    pub(crate) fn finish(
        &self,
        result: Result<LoopResult, String>,
        interrupted: bool,
        active_machine: machine::MachineIdentity,
    ) -> SymonTextTurnResult {
        let (mut model, effort) = self
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        let (status, text, detail) = match result {
            Ok(value) if !interrupted => {
                model = value.model_used;
                ("done", value.result_text, None)
            }
            Ok(_) => ("interrupted", String::new(), None),
            Err(error) => (
                if interrupted { "interrupted" } else { "error" },
                String::new(),
                Some(error),
            ),
        };
        SymonTextTurnResult {
            status,
            model,
            effort,
            text,
            detail,
            active_machine,
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymonTextTurnResult {
    pub(crate) status: &'static str,
    pub(crate) model: String,
    pub(crate) effort: String,
    pub(crate) text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) detail: Option<String>,
    pub(crate) active_machine: machine::MachineIdentity,
}
