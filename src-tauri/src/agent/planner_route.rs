//! Symon planner selection from the shared native CLI inventory.

use std::sync::atomic::{AtomicBool, Ordering};

pub(crate) const NO_AGENT_CLI_MESSAGE: &str = "no agent CLI found — install claude or codex";
const INVALID_PLANNER_SELECTION_MESSAGE: &str = "invalid or unavailable Symon planner selection";
static CLAUDE_FABLE_UNAVAILABLE: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PlannerProvider {
    Claude,
    Codex,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PlannerSelection {
    pub provider: PlannerProvider,
    pub binary: String,
    pub model: &'static str,
    pub effort: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PlannerRouting {
    Selected(PlannerSelection),
    Unavailable { message: &'static str },
}

pub(crate) fn resolve() -> PlannerRouting {
    resolve_with_claude_model(
        effective_claude_model(crate::models::CLAUDE_FABLE_5),
        |binary| match binary {
            "claude" => {
                crate::cli_locate::resolve_binary("claude", &["O8_CLAUDE_CODE_BIN", "CLAUDE_BIN"])
            }
            "codex" => crate::cli_locate::resolve_binary("codex", &["O8_CODEX_BIN", "CODEX_BIN"]),
            _ => None,
        },
    )
}

pub(crate) fn resolve_bound(engine: &str, model: &str, effort: &str) -> PlannerRouting {
    resolve_bound_with(
        engine,
        effective_claude_model(model),
        effort,
        |binary| match binary {
            "claude" => {
                crate::cli_locate::resolve_binary("claude", &["O8_CLAUDE_CODE_BIN", "CLAUDE_BIN"])
            }
            "codex" => crate::cli_locate::resolve_binary("codex", &["O8_CODEX_BIN", "CODEX_BIN"]),
            _ => None,
        },
    )
}

pub(crate) fn effective_claude_model(model: &str) -> &str {
    if model == crate::models::CLAUDE_FABLE_5 && CLAUDE_FABLE_UNAVAILABLE.load(Ordering::Relaxed) {
        crate::models::CLAUDE_OPUS_4_8
    } else {
        model
    }
}

pub(crate) fn claude_fallback_selection(binary: &str, model: &str) -> Option<PlannerSelection> {
    (model == crate::models::CLAUDE_FABLE_5).then(|| PlannerSelection {
        provider: PlannerProvider::Claude,
        binary: binary.to_string(),
        model: crate::models::CLAUDE_OPUS_4_8,
        effort: "high",
    })
}

pub(crate) fn remember_claude_fable_unavailable() {
    CLAUDE_FABLE_UNAVAILABLE.store(true, Ordering::Relaxed);
}

fn resolve_bound_with<F>(engine: &str, model: &str, effort: &str, mut locate: F) -> PlannerRouting
where
    F: FnMut(&str) -> Option<String>,
{
    let provider = match (engine, model) {
        ("claude", crate::models::CLAUDE_OPUS_4_8)
        | ("claude", crate::models::CLAUDE_OPUS_5)
        | ("claude", crate::models::CLAUDE_SONNET_5)
        | ("claude", crate::models::CLAUDE_HAIKU_4_5_DATED)
        | ("claude", crate::models::CLAUDE_FABLE_5) => PlannerProvider::Claude,
        ("codex", crate::models::CODEX_GPT_5_6_SOL)
        | ("codex", crate::models::CODEX_GPT_5_6_TERRA) => PlannerProvider::Codex,
        _ => {
            return PlannerRouting::Unavailable {
                message: INVALID_PLANNER_SELECTION_MESSAGE,
            }
        }
    };
    let effort = match effort {
        "low" => "low",
        "medium" => "medium",
        "high" => "high",
        "xhigh" => "xhigh",
        _ => {
            return PlannerRouting::Unavailable {
                message: INVALID_PLANNER_SELECTION_MESSAGE,
            }
        }
    };
    let binary_name = match provider {
        PlannerProvider::Claude => "claude",
        PlannerProvider::Codex => "codex",
    };
    let Some(binary) = locate(binary_name) else {
        return PlannerRouting::Unavailable {
            message: INVALID_PLANNER_SELECTION_MESSAGE,
        };
    };
    let model = match model {
        crate::models::CLAUDE_OPUS_4_8 => crate::models::CLAUDE_OPUS_4_8,
        crate::models::CLAUDE_OPUS_5 => crate::models::CLAUDE_OPUS_5,
        crate::models::CLAUDE_SONNET_5 => crate::models::CLAUDE_SONNET_5,
        crate::models::CLAUDE_HAIKU_4_5_DATED => crate::models::CLAUDE_HAIKU_4_5_DATED,
        crate::models::CLAUDE_FABLE_5 => crate::models::CLAUDE_FABLE_5,
        crate::models::CODEX_GPT_5_6_SOL => crate::models::CODEX_GPT_5_6_SOL,
        crate::models::CODEX_GPT_5_6_TERRA => crate::models::CODEX_GPT_5_6_TERRA,
        _ => unreachable!("model was allow-listed above"),
    };
    PlannerRouting::Selected(PlannerSelection {
        provider,
        binary,
        model,
        effort,
    })
}

fn resolve_with_claude_model<F>(claude_model: &'static str, mut locate: F) -> PlannerRouting
where
    F: FnMut(&str) -> Option<String>,
{
    if let Some(binary) = locate("claude") {
        return PlannerRouting::Selected(PlannerSelection {
            provider: PlannerProvider::Claude,
            binary,
            model: claude_model,
            effort: "high",
        });
    }
    if let Some(binary) = locate("codex") {
        return PlannerRouting::Selected(PlannerSelection {
            provider: PlannerProvider::Codex,
            binary,
            model: crate::models::CODEX_GPT_5_6_SOL,
            effort: "medium",
        });
    }
    PlannerRouting::Unavailable {
        message: NO_AGENT_CLI_MESSAGE,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn planner_routing_prefers_claude_then_codex_and_reports_no_cli() {
        let both = resolve_with_claude_model(crate::models::CLAUDE_FABLE_5, |name| {
            Some(format!("/mock/{name}"))
        });
        assert_eq!(
            both,
            PlannerRouting::Selected(PlannerSelection {
                provider: PlannerProvider::Claude,
                binary: "/mock/claude".to_string(),
                model: crate::models::CLAUDE_FABLE_5,
                effort: "high",
            })
        );

        let codex_only = resolve_with_claude_model(crate::models::CLAUDE_FABLE_5, |name| {
            (name == "codex").then(|| "/mock/codex".to_string())
        });
        assert_eq!(
            codex_only,
            PlannerRouting::Selected(PlannerSelection {
                provider: PlannerProvider::Codex,
                binary: "/mock/codex".to_string(),
                model: crate::models::CODEX_GPT_5_6_SOL,
                effort: "medium",
            })
        );

        assert_eq!(
            resolve_with_claude_model(crate::models::CLAUDE_FABLE_5, |_| None),
            PlannerRouting::Unavailable {
                message: NO_AGENT_CLI_MESSAGE,
            }
        );
    }

    #[test]
    fn bound_selection_accepts_catalog_models_and_rejects_raw_cli_values() {
        assert_eq!(
            resolve_bound_with("codex", crate::models::CODEX_GPT_5_6_SOL, "xhigh", |name| {
                (name == "codex").then(|| "/mock/codex".to_string())
            }),
            PlannerRouting::Selected(PlannerSelection {
                provider: PlannerProvider::Codex,
                binary: "/mock/codex".to_string(),
                model: crate::models::CODEX_GPT_5_6_SOL,
                effort: "xhigh",
            })
        );
        assert_eq!(
            resolve_bound_with("codex", "gpt-unknown", "xhigh", |_| Some(
                "/mock/codex".into()
            )),
            PlannerRouting::Unavailable {
                message: INVALID_PLANNER_SELECTION_MESSAGE,
            }
        );
        assert_eq!(
            resolve_bound_with("claude", crate::models::CLAUDE_OPUS_5, "ultra", |_| {
                Some("/mock/claude".into())
            }),
            PlannerRouting::Unavailable {
                message: INVALID_PLANNER_SELECTION_MESSAGE,
            }
        );
    }

    #[test]
    fn unavailable_fable_falls_back_to_opus_high() {
        assert_eq!(
            claude_fallback_selection("/mock/claude", crate::models::CLAUDE_FABLE_5),
            Some(PlannerSelection {
                provider: PlannerProvider::Claude,
                binary: "/mock/claude".to_string(),
                model: crate::models::CLAUDE_OPUS_4_8,
                effort: "high",
            })
        );
        assert_eq!(
            claude_fallback_selection("/mock/claude", crate::models::CLAUDE_OPUS_4_8),
            None
        );
    }
}
