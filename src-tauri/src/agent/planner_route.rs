//! Symon planner selection from the shared native CLI inventory.
//!
//! ## Tier discipline (#2155)
//! The planner runs bounded multi-step Mac tasks over the native tool catalog.
//! That is a worker/builder seat, so the FRONTIER orchestrator model is never
//! the default here — a background seat that inherits the orchestrator tier is
//! the same footgun as a subagent inheriting its parent's model. With no
//! operator pin the route seats:
//!
//! * Claude → Sonnet 5 (worker tier) at the CLI's default reasoning — the
//!   `--effort` flag rides the BUILDER tier only.
//! * Codex → `gpt-5.6-sol` (builder tier) at `high`.
//!
//! The other rung of each ladder (Claude Opus 5 at `high`, Codex
//! `gpt-5.6-terra` at `medium`) and the frontier id itself stay reachable
//! through `resolve_bound`, so an explicit operator pin can still choose any
//! catalog model, Fable included.
//!
//! ## Provider preference
//! When both CLIs are installed the route follows the operator's orchestrator
//! backend (`~/.o8/operator-defaults.json`), falling back to Codex. See
//! `preferred_provider_from` for the mapping.

use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};

pub(crate) const NO_AGENT_CLI_MESSAGE: &str = "no agent CLI found — install claude or codex";
const INVALID_PLANNER_SELECTION_MESSAGE: &str = "invalid or unavailable Symon planner selection";
static CLAUDE_FABLE_UNAVAILABLE: AtomicBool = AtomicBool::new(false);
static CLAUDE_OPUS_5_UNAVAILABLE: AtomicBool = AtomicBool::new(false);

/// Worker-tier Claude planner — the no-pin default. Runs at the CLI's own
/// reasoning setting (no `--effort`), which is what keeps this seat cheap.
pub(crate) const DEFAULT_CLAUDE_PLANNER_MODEL: &str = crate::models::CLAUDE_SONNET_5;
/// Builder-tier Claude planner, reachable through an operator pin.
pub(crate) const BUILDER_CLAUDE_PLANNER_MODEL: &str = crate::models::CLAUDE_OPUS_5;
/// Builder-tier Codex planner — the no-pin default on the Codex side.
pub(crate) const DEFAULT_CODEX_PLANNER_MODEL: &str = crate::models::CODEX_GPT_5_6_SOL;
/// Worker-tier Codex planner, reachable through an operator pin.
pub(crate) const WORKER_CODEX_PLANNER_MODEL: &str = crate::models::CODEX_GPT_5_6_TERRA;

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
    /// The reasoning tier this seat actually runs at. On the Codex path it is
    /// passed straight through as `model_reasoning_effort`. On the Claude path
    /// the CLI only receives an `--effort` flag for the builder tier, so a
    /// worker-tier seat reports `medium` — the CLI default it runs at — rather
    /// than a flag value nothing passes.
    pub effort: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PlannerRouting {
    Selected(PlannerSelection),
    Unavailable { message: &'static str },
}

fn locate_planner_binary(binary: &str) -> Option<String> {
    match binary {
        "claude" => crate::cli_locate::resolve_binary("claude", &["O8_CLAUDE_CODE_BIN", "CLAUDE_BIN"]),
        "codex" => crate::cli_locate::resolve_binary("codex", &["O8_CODEX_BIN", "CODEX_BIN"]),
        _ => None,
    }
}

pub(crate) fn resolve() -> PlannerRouting {
    resolve_with(
        preferred_provider(),
        effective_claude_model(DEFAULT_CLAUDE_PLANNER_MODEL),
        locate_planner_binary,
    )
}

pub(crate) fn resolve_bound(engine: &str, model: &str, effort: &str) -> PlannerRouting {
    resolve_bound_with(
        engine,
        effective_claude_model(model),
        effort,
        locate_planner_binary,
    )
}

/// The `--effort` flag a Claude planner model is spawned with, or `None` to
/// leave the CLI at its own default. Builder tier (Opus / Fable) only: the
/// Sonnet worker default and the Smart Compose lane stay on the CLI default for
/// latency. A pure function of the model, so the model-keyed warm pool in
/// `claude_pool` cannot hand back a session booted at a different effort.
pub(crate) fn claude_effort_flag(model: &str) -> Option<&'static str> {
    (model.starts_with("claude-opus") || model == crate::models::CLAUDE_FABLE_5).then_some("high")
}

/// Reasoning tier reported for a Claude seat — the flag when one is passed, and
/// the CLI's own default (`medium`) when the seat runs flag-free.
fn claude_planner_effort(model: &str) -> &'static str {
    claude_effort_flag(model).unwrap_or("medium")
}

/// Reasoning tier for a Codex seat: `high` for the builder default,
/// `medium` for the worker rung.
fn codex_planner_effort(model: &str) -> &'static str {
    match model {
        WORKER_CODEX_PLANNER_MODEL => "medium",
        _ => "high",
    }
}

/// The provider the route reaches for first when both CLIs are installed.
pub(crate) fn preferred_provider() -> PlannerProvider {
    preferred_provider_from(read_operator_defaults().as_ref())
}

/// `~/.o8/operator-defaults.json`, the same file the native shell already reads
/// for the crash-report toggle (`telemetry.rs`). Reading it here keeps the
/// planner's provider choice aligned with the operator's orchestrator backend
/// without an HTTP hop into the Next server. Missing or malformed resolves to
/// `None` and the Codex fallback below.
fn read_operator_defaults() -> Option<Value> {
    let raw = std::fs::read_to_string(super::agent_data_dir().join("operator-defaults.json")).ok()?;
    serde_json::from_str::<Value>(&raw).ok()
}

/// Map the operator's `orchestratorBackend` onto a planner provider.
///
/// `claude`, `collide` and `fable` all run the Claude harness, so they seat the
/// Claude planner. `auto` defers to the legacy `inAppOrchestratorEnabled`
/// toggle exactly as the orchestrator backend registry does. `openclaw` and
/// `hermes` carry no local-CLI signal (they are governed profiles that only
/// dispatch), so they take the default with everything else: **Codex**, because
/// the Codex seat is subscription-billed and is the orchestrator default.
fn preferred_provider_from(defaults: Option<&Value>) -> PlannerProvider {
    let Some(defaults) = defaults else {
        return PlannerProvider::Codex;
    };
    match defaults.get("orchestratorBackend").and_then(Value::as_str) {
        Some("claude") | Some("collide") | Some("fable") => PlannerProvider::Claude,
        Some("codex") => PlannerProvider::Codex,
        Some("auto") => match defaults.get("inAppOrchestratorEnabled").and_then(Value::as_bool) {
            Some(true) => PlannerProvider::Claude,
            _ => PlannerProvider::Codex,
        },
        _ => PlannerProvider::Codex,
    }
}

pub(crate) fn effective_claude_model(model: &str) -> &str {
    effective_claude_model_with_availability(
        model,
        CLAUDE_FABLE_UNAVAILABLE.load(Ordering::Relaxed),
        CLAUDE_OPUS_5_UNAVAILABLE.load(Ordering::Relaxed),
    )
}

fn effective_claude_model_with_availability(
    model: &str,
    fable_unavailable: bool,
    opus_5_unavailable: bool,
) -> &str {
    match model {
        crate::models::CLAUDE_FABLE_5 if fable_unavailable && opus_5_unavailable => {
            crate::models::CLAUDE_OPUS_4_8
        }
        crate::models::CLAUDE_FABLE_5 if fable_unavailable => crate::models::CLAUDE_OPUS_5,
        crate::models::CLAUDE_OPUS_5 if opus_5_unavailable => crate::models::CLAUDE_OPUS_4_8,
        _ => model,
    }
}

pub(crate) fn claude_fallback_selection(binary: &str, model: &str) -> Option<PlannerSelection> {
    let model = match model {
        crate::models::CLAUDE_FABLE_5 => crate::models::CLAUDE_OPUS_5,
        crate::models::CLAUDE_OPUS_5 => crate::models::CLAUDE_OPUS_4_8,
        _ => return None,
    };
    Some(claude_selection(binary.to_string(), model))
}

pub(crate) fn remember_claude_model_unavailable(model: &str) {
    match model {
        crate::models::CLAUDE_FABLE_5 => CLAUDE_FABLE_UNAVAILABLE.store(true, Ordering::Relaxed),
        crate::models::CLAUDE_OPUS_5 => CLAUDE_OPUS_5_UNAVAILABLE.store(true, Ordering::Relaxed),
        _ => {}
    }
}

fn claude_selection(binary: String, model: &'static str) -> PlannerSelection {
    PlannerSelection {
        provider: PlannerProvider::Claude,
        binary,
        model,
        effort: claude_planner_effort(model),
    }
}

fn codex_selection(binary: String, model: &'static str) -> PlannerSelection {
    PlannerSelection {
        provider: PlannerProvider::Codex,
        binary,
        model,
        effort: codex_planner_effort(model),
    }
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
        // A pinned Claude seat still only gets `--effort` on the builder tier,
        // so report the tier the spawn actually uses rather than the requested
        // value. The Codex path applies the request verbatim.
        effort: match provider {
            PlannerProvider::Claude => claude_planner_effort(model),
            PlannerProvider::Codex => effort,
        },
        model,
    })
}

fn resolve_with<F>(
    preferred: PlannerProvider,
    claude_model: &'static str,
    mut locate: F,
) -> PlannerRouting
where
    F: FnMut(&str) -> Option<String>,
{
    let order = match preferred {
        PlannerProvider::Codex => [PlannerProvider::Codex, PlannerProvider::Claude],
        PlannerProvider::Claude => [PlannerProvider::Claude, PlannerProvider::Codex],
    };
    for provider in order {
        match provider {
            PlannerProvider::Claude => {
                if let Some(binary) = locate("claude") {
                    return PlannerRouting::Selected(claude_selection(binary, claude_model));
                }
            }
            PlannerProvider::Codex => {
                if let Some(binary) = locate("codex") {
                    return PlannerRouting::Selected(codex_selection(
                        binary,
                        DEFAULT_CODEX_PLANNER_MODEL,
                    ));
                }
            }
        }
    }
    PlannerRouting::Unavailable {
        message: NO_AGENT_CLI_MESSAGE,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn both_installed(name: &str) -> Option<String> {
        Some(format!("/mock/{name}"))
    }

    fn default_claude_model() -> &'static str {
        effective_claude_model_with_availability(DEFAULT_CLAUDE_PLANNER_MODEL, false, false)
    }

    #[test]
    fn no_pin_never_seats_the_frontier_orchestrator_model() {
        for preferred in [PlannerProvider::Claude, PlannerProvider::Codex] {
            let PlannerRouting::Selected(selection) =
                resolve_with(preferred, default_claude_model(), both_installed)
            else {
                panic!("both CLIs installed must resolve");
            };
            assert_ne!(
                selection.model,
                crate::models::CLAUDE_FABLE_5,
                "the background planner must never default to the frontier orchestrator id"
            );
            assert_ne!(selection.model, crate::models::CLAUDE_OPUS_4_8);
        }
    }

    #[test]
    fn default_tiers_are_sonnet_flag_free_and_codex_sol_high() {
        assert_eq!(
            resolve_with(PlannerProvider::Claude, default_claude_model(), both_installed),
            PlannerRouting::Selected(PlannerSelection {
                provider: PlannerProvider::Claude,
                binary: "/mock/claude".to_string(),
                model: crate::models::CLAUDE_SONNET_5,
                effort: "medium",
            })
        );
        // The Claude worker tier is spawned WITHOUT an `--effort` flag; only the
        // builder tier carries one.
        assert_eq!(claude_effort_flag(crate::models::CLAUDE_SONNET_5), None);
        assert_eq!(
            claude_effort_flag(BUILDER_CLAUDE_PLANNER_MODEL),
            Some("high")
        );
        assert_eq!(claude_effort_flag(crate::models::CLAUDE_FABLE_5), Some("high"));

        assert_eq!(
            resolve_with(PlannerProvider::Codex, default_claude_model(), both_installed),
            PlannerRouting::Selected(PlannerSelection {
                provider: PlannerProvider::Codex,
                binary: "/mock/codex".to_string(),
                model: DEFAULT_CODEX_PLANNER_MODEL,
                effort: "high",
            })
        );
        assert_eq!(codex_planner_effort(WORKER_CODEX_PLANNER_MODEL), "medium");
    }

    #[test]
    fn preference_falls_through_to_the_installed_cli_and_reports_no_cli() {
        // Codex preferred but absent → the Claude worker seat still wins.
        assert_eq!(
            resolve_with(PlannerProvider::Codex, default_claude_model(), |name| {
                (name == "claude").then(|| "/mock/claude".to_string())
            }),
            PlannerRouting::Selected(PlannerSelection {
                provider: PlannerProvider::Claude,
                binary: "/mock/claude".to_string(),
                model: crate::models::CLAUDE_SONNET_5,
                effort: "medium",
            })
        );
        // Claude preferred but absent → Codex builder seat.
        assert_eq!(
            resolve_with(PlannerProvider::Claude, default_claude_model(), |name| {
                (name == "codex").then(|| "/mock/codex".to_string())
            }),
            PlannerRouting::Selected(PlannerSelection {
                provider: PlannerProvider::Codex,
                binary: "/mock/codex".to_string(),
                model: DEFAULT_CODEX_PLANNER_MODEL,
                effort: "high",
            })
        );
        assert_eq!(
            resolve_with(PlannerProvider::Claude, default_claude_model(), |_| None),
            PlannerRouting::Unavailable {
                message: NO_AGENT_CLI_MESSAGE,
            }
        );
    }

    #[test]
    fn orchestrator_backend_setting_picks_the_planner_provider() {
        for (backend, expected) in [
            ("codex", PlannerProvider::Codex),
            ("claude", PlannerProvider::Claude),
            ("collide", PlannerProvider::Claude),
            ("fable", PlannerProvider::Claude),
            ("openclaw", PlannerProvider::Codex),
            ("hermes", PlannerProvider::Codex),
            ("something-new", PlannerProvider::Codex),
        ] {
            assert_eq!(
                preferred_provider_from(Some(&json!({ "orchestratorBackend": backend }))),
                expected,
                "backend {backend}"
            );
        }
        assert_eq!(
            preferred_provider_from(Some(
                &json!({ "orchestratorBackend": "auto", "inAppOrchestratorEnabled": true })
            )),
            PlannerProvider::Claude
        );
        assert_eq!(
            preferred_provider_from(Some(
                &json!({ "orchestratorBackend": "auto", "inAppOrchestratorEnabled": false })
            )),
            PlannerProvider::Codex
        );
        assert_eq!(preferred_provider_from(Some(&json!({}))), PlannerProvider::Codex);
        assert_eq!(preferred_provider_from(None), PlannerProvider::Codex);
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
        // An explicit pin may still seat the frontier model.
        assert_eq!(
            resolve_bound_with("claude", crate::models::CLAUDE_FABLE_5, "high", |_| Some(
                "/mock/claude".into()
            )),
            PlannerRouting::Selected(PlannerSelection {
                provider: PlannerProvider::Claude,
                binary: "/mock/claude".to_string(),
                model: crate::models::CLAUDE_FABLE_5,
                effort: "high",
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
    fn unavailable_models_advance_the_high_effort_fallback_chain() {
        assert_eq!(
            claude_fallback_selection("/mock/claude", crate::models::CLAUDE_FABLE_5),
            Some(PlannerSelection {
                provider: PlannerProvider::Claude,
                binary: "/mock/claude".to_string(),
                model: crate::models::CLAUDE_OPUS_5,
                effort: "high",
            })
        );
        assert_eq!(
            claude_fallback_selection("/mock/claude", crate::models::CLAUDE_OPUS_5),
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

        assert_eq!(
            effective_claude_model_with_availability(crate::models::CLAUDE_FABLE_5, false, false),
            crate::models::CLAUDE_FABLE_5
        );
        assert_eq!(
            effective_claude_model_with_availability(crate::models::CLAUDE_FABLE_5, true, false),
            crate::models::CLAUDE_OPUS_5
        );
        assert_eq!(
            effective_claude_model_with_availability(crate::models::CLAUDE_FABLE_5, true, true),
            crate::models::CLAUDE_OPUS_4_8
        );
        assert_eq!(
            effective_claude_model_with_availability(crate::models::CLAUDE_OPUS_5, false, true),
            crate::models::CLAUDE_OPUS_4_8
        );
        // The worker default is the base rung — it has no lower fallback and is
        // never rewritten by the degrade chain.
        assert_eq!(
            effective_claude_model_with_availability(DEFAULT_CLAUDE_PLANNER_MODEL, true, true),
            crate::models::CLAUDE_SONNET_5
        );
    }
}
