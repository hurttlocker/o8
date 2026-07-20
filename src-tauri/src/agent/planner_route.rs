//! Symon planner selection from the shared native CLI inventory.

pub(crate) const NO_AGENT_CLI_MESSAGE: &str = "no agent CLI found — install claude or codex";

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
    resolve_with(|binary| match binary {
        "claude" => {
            crate::cli_locate::resolve_binary("claude", &["O8_CLAUDE_CODE_BIN", "CLAUDE_BIN"])
        }
        "codex" => crate::cli_locate::resolve_binary("codex", &["O8_CODEX_BIN", "CODEX_BIN"]),
        _ => None,
    })
}

pub(crate) fn resolve_with<F>(mut locate: F) -> PlannerRouting
where
    F: FnMut(&str) -> Option<String>,
{
    if let Some(binary) = locate("claude") {
        return PlannerRouting::Selected(PlannerSelection {
            provider: PlannerProvider::Claude,
            binary,
            model: crate::models::CLAUDE_OPUS_4_8,
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
        let both = resolve_with(|name| Some(format!("/mock/{name}")));
        assert_eq!(
            both,
            PlannerRouting::Selected(PlannerSelection {
                provider: PlannerProvider::Claude,
                binary: "/mock/claude".to_string(),
                model: crate::models::CLAUDE_OPUS_4_8,
                effort: "high",
            })
        );

        let codex_only = resolve_with(|name| (name == "codex").then(|| "/mock/codex".to_string()));
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
            resolve_with(|_| None),
            PlannerRouting::Unavailable {
                message: NO_AGENT_CLI_MESSAGE,
            }
        );
    }
}
