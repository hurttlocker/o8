//! Symon FRONT brain selection — the Right-Option seat (#2164).
//!
//! ## What the front brain is
//! Right-Option drives two lanes. **Agent mode** runs a tool-calling loop over
//! the native Mac tool catalog; **Ask mode** answers one question with no tools
//! at all. Both were provider-shaped rather than registry-shaped: Ask always
//! called Gemini, and Agent mode could only take a planner seat — a machine
//! with no agent CLI had no front brain at all, and the Gemini loop it used to
//! run was unreachable.
//!
//! This module gives the front seat the same seam the background brain reads
//! (`planner_route`, #2156) and adds the one entry that registry cannot carry:
//! the built-in Gemini loop, which needs no binary, only a key or a plan.
//!
//! ## The setting
//! `symon_front_brain` in the voice pref store (`~/.o8/dictation.json`, written
//! by `voice_prefs_set` exactly like the `symon_brain_*` keys):
//!
//! * `auto` (default, and the value of an absent key) — the route the front
//!   seat already ran: whatever `planner_route::resolve()` seats, which is the
//!   operator's Symon brain setting. The one thing `auto` adds is a floor: a
//!   machine with no planner CLI falls to the Gemini loop instead of failing
//!   the gesture.
//! * `gemini` — the built-in loop, explicitly.
//! * a planner adapter id (`claude` / `codex` / `opencode`) — that seat, at the
//!   WORKER rung unless `symon_brain_tier` says otherwise, honoring
//!   `symon_brain_model` the same way the background seat does. The front brain
//!   is the fast lane, so it never inherits a builder default the operator did
//!   not ask for.
//!
//! A chosen adapter whose binary is missing never fails silently: it falls to
//! Gemini (or, with no Gemini credential, to any other installed seat), says so
//! in the log, and the settings status line names the pick it could not honor.
//!
//! ## Escalation
//! `escalate` hands the task to `spawn_background_brain_task`, which resolves
//! through `planner_route` — so when the front seat and the background seat are
//! the SAME seat there is nothing to escalate to, and the tool is withheld.
//! That is exactly what the front seat already did on a planner seat (the
//! planner prompt has always stripped `escalate`), so the default is unchanged;
//! the rule only opens the handoff back up when the two seats genuinely differ.

use super::planner_route::{self, PlannerRouting, PlannerSelection, PlannerTransport};
use serde_json::Value;
use std::time::Duration;

/// Voice-pref key for the front-brain choice.
pub(crate) const FRONT_BRAIN_PREF: &str = "symon_front_brain";

/// The built-in loop's id — not a planner adapter: it has no binary and speaks
/// Gemini's own `functionCall` protocol rather than the JSON-action contract.
pub(crate) const GEMINI_ID: &str = "gemini";
const GEMINI_LABEL: &str = "Gemini";

/// The model the built-in loop runs when the operator has not configured one.
/// A flash-tier model: the front seat is the fast lane.
const GEMINI_FRONT_MODEL: &str = crate::models::GEMINI_3_FLASH_PREVIEW;

/// Ceiling for the single tools-withheld Ask turn on a planner seat. Ask is a
/// one-shot question, so it never needs the multi-turn planner budget.
const ASK_TURN_TIMEOUT_SECS: u64 = 90;

/// What the Right-Option gesture runs this turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum FrontBrain {
    /// The built-in Gemini loop (Agent) / Gemini ask (Ask).
    Gemini { model: String },
    /// A planner-registry seat speaking the JSON-action protocol.
    Planner(PlannerSelection),
}

impl FrontBrain {
    pub(crate) fn id(&self) -> &str {
        match self {
            FrontBrain::Gemini { .. } => GEMINI_ID,
            FrontBrain::Planner(selection) => selection.provider.id,
        }
    }

    pub(crate) fn label(&self) -> &str {
        match self {
            FrontBrain::Gemini { .. } => GEMINI_LABEL,
            FrontBrain::Planner(selection) => selection.provider.label,
        }
    }

    /// Model name for logs and the settings status line.
    pub(crate) fn model_label(&self) -> &str {
        match self {
            FrontBrain::Gemini { model } => model,
            FrontBrain::Planner(selection) => selection.model_label(),
        }
    }

    /// Seat identity for the escalate rule. A seat is the adapter AND the rung
    /// it runs: a worker-tier front brain handing off to a builder-tier
    /// background brain is a real escalation, so only an identical triple
    /// counts as "nothing to escalate to".
    fn seat_key(&self) -> String {
        match self {
            FrontBrain::Gemini { model } => format!("gemini|{model}|"),
            FrontBrain::Planner(selection) => format!(
                "{}|{}|{}",
                selection.provider.id,
                selection.model_label(),
                selection.effort
            ),
        }
    }
}

fn background_seat_key(selection: &PlannerSelection) -> String {
    format!(
        "{}|{}|{}",
        selection.provider.id,
        selection.model_label(),
        selection.effort
    )
}

/// The resolved front seat plus the two facts the surfaces need: which pick we
/// could not honor, and whether `escalate` is offered this turn.
#[derive(Debug, Clone)]
pub(crate) struct FrontRouting {
    pub brain: FrontBrain,
    /// The chosen id whose binary was missing, when the route fell through.
    pub fell_back_from: Option<String>,
    pub escalate_available: bool,
}

impl FrontRouting {
    /// The planner seat to run, or `None` when the built-in loop takes the turn.
    pub(crate) fn planner_selection(&self) -> Option<&PlannerSelection> {
        match &self.brain {
            FrontBrain::Planner(selection) => Some(selection),
            FrontBrain::Gemini { .. } => None,
        }
    }

    pub(crate) fn gemini_model(&self) -> Option<&str> {
        match &self.brain {
            FrontBrain::Gemini { model } => Some(model),
            FrontBrain::Planner(_) => None,
        }
    }

    /// One line per task naming the seat the gesture actually took — the
    /// operator's receipt, and the only place a silent fallback would hide.
    pub(crate) fn log_seat(&self, lane: &str) {
        match &self.fell_back_from {
            Some(missing) => log::warn!(
                "[symon-front-brain] {lane}: {missing} is not installed — falling back to {} {}",
                self.brain.id(),
                self.brain.model_label()
            ),
            None => log::info!(
                "[symon-front-brain] {lane}: {} {} (escalate {})",
                self.brain.id(),
                self.brain.model_label(),
                if self.escalate_available { "on" } else { "withheld" }
            ),
        }
    }
}

/// The stored choice, or `None` for `auto` (which is also an absent key).
pub(crate) fn read_choice() -> Option<String> {
    choice_from(planner_route::read_voice_prefs().as_ref())
}

fn choice_from(prefs: Option<&Value>) -> Option<String> {
    prefs?
        .get(FRONT_BRAIN_PREF)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "auto")
        .map(str::to_string)
}

/// True when the built-in loop can actually run: the operator's own Gemini key
/// or an active o8 plan.
fn gemini_available() -> bool {
    crate::entitlement::resolve_gemini(GEMINI_FRONT_MODEL).is_some()
}

/// The built-in seat. The legacy `mac_native_action` config stays an escape
/// hatch for a different Gemini id; anything else (it defaults to a Claude id)
/// does not belong on this seat and is ignored in favor of the flash default.
fn gemini_brain() -> FrontBrain {
    let configured = super::router::load_config().mac_native_action;
    let model = if configured.contains("gemini") {
        configured
    } else {
        GEMINI_FRONT_MODEL.to_string()
    };
    FrontBrain::Gemini { model }
}

pub(crate) fn resolve() -> FrontRouting {
    resolve_with(
        read_choice().as_deref(),
        planner_route::resolve(),
        super::router::load_config().voice_escalation.as_str(),
        gemini_available(),
        planner_route::locate_planner_binary,
    )
}

/// The route itself, with the binary locator injected so a "chosen CLI missing"
/// case is reachable on a machine that has every CLI installed.
pub(crate) fn resolve_with<F>(
    choice: Option<&str>,
    background: PlannerRouting,
    escalation: &str,
    gemini_ready: bool,
    locate: F,
) -> FrontRouting
where
    F: FnMut(&planner_route::PlannerAdapter) -> Option<String>,
{
    let setting = planner_route::read_brain_setting();
    let background_selection = match &background {
        PlannerRouting::Selected(selection) => Some(selection.clone()),
        PlannerRouting::Unavailable { .. } => None,
    };

    let (brain, fell_back_from) = match choice {
        // Auto is the route the front seat already ran, with one floor added:
        // no planner CLI no longer means no front brain.
        None => match background_selection.clone() {
            Some(selection) => (FrontBrain::Planner(selection), None),
            None => (gemini_brain(), None),
        },
        Some(GEMINI_ID) => (gemini_brain(), None),
        Some(id) => match planner_route::seat_front_adapter_with(
            id,
            setting.tier,
            setting.model.as_deref(),
            locate,
        ) {
            Some(selection) => (FrontBrain::Planner(selection), None),
            // A pick we cannot honor falls to the built-in loop, then to any
            // other installed seat — never to nothing.
            None => {
                let fallback = if gemini_ready {
                    gemini_brain()
                } else {
                    match background_selection.clone() {
                        Some(selection) => FrontBrain::Planner(selection),
                        None => gemini_brain(),
                    }
                };
                (fallback, Some(id.to_string()))
            }
        },
    };

    // Nothing to escalate TO when the handoff would land on the same seat, and
    // nothing to escalate to at all when no background seat resolves.
    let escalate_available = escalation != "off"
        && background_selection
            .as_ref()
            .is_some_and(|selection| background_seat_key(selection) != brain.seat_key());

    FrontRouting {
        brain,
        fell_back_from,
        escalate_available,
    }
}

// ── Ask mode ────────────────────────────────────────────────────────────────

/// Answer one question on the front seat with NO tools.
///
/// The Gemini seat keeps the exact call it always made. A planner seat takes a
/// single turn carrying the Ask persona and the question — no planner contract,
/// no tool catalog — on top of the read-only posture each adapter already
/// spawns with (`--tools ""`, read-only sandbox, `--pure --agent plan`). So
/// "tools withheld" holds twice over: nothing is offered, and nothing could run.
pub(crate) async fn ask(question: &str, context: Option<&str>) -> Result<String, String> {
    let routing = resolve();
    routing.log_seat("ask");
    match routing.brain {
        FrontBrain::Gemini { .. } => crate::ai::gemini_ask::ask(question, context).await,
        FrontBrain::Planner(selection) => ask_on_seat(&selection, question, context).await,
    }
}

pub(crate) fn build_ask_prompt(question: &str, context: Option<&str>) -> String {
    let mut prompt = crate::ai::gemini_ask::ASK_SYSTEM_PROMPT.to_string();
    if let Some(extra) = context.map(str::trim).filter(|c| !c.is_empty()) {
        prompt.push_str("\n\n[On-screen context]\n");
        prompt.push_str(extra);
    }
    prompt.push_str(
        "\n\nAnswer this question directly in plain spoken prose. You have no tools \
         on this turn and must not emit JSON, an action object, or a tool call.",
    );
    prompt.push_str("\n\n---\n\nQuestion: ");
    prompt.push_str(question.trim());
    prompt
}

/// A planner CLI that ignores the "plain prose" instruction and answers with a
/// `{"done": true, "say": "..."}` action still has a spoken answer inside it —
/// take it rather than reading JSON aloud.
pub(crate) fn plain_answer(reply: &str) -> String {
    let trimmed = reply.trim().trim_start_matches("```json").trim_matches('`').trim();
    if let Ok(Value::Object(object)) = serde_json::from_str::<Value>(trimmed) {
        if let Some(say) = object.get("say").and_then(Value::as_str) {
            return say.trim().to_string();
        }
    }
    trimmed.to_string()
}

async fn ask_on_seat(
    selection: &PlannerSelection,
    question: &str,
    context: Option<&str>,
) -> Result<String, String> {
    let prompt = build_ask_prompt(question, context);
    let transport = selection.provider.transport;
    let provider_id = selection.provider.id;
    let binary = selection.binary.clone();
    let model = selection.model.clone();
    let effort = selection.effort;

    let reply = tokio::time::timeout(
        Duration::from_secs(ASK_TURN_TIMEOUT_SECS),
        tokio::task::spawn_blocking(move || ask_turn(transport, &binary, model, effort, &prompt)),
    )
    .await
    .map_err(|_| format!("{provider_id} ask turn timed out"))?
    .map_err(|error| format!("{provider_id} ask turn join error: {error}"))??;

    let answer = plain_answer(&reply);
    if answer.is_empty() {
        return Err(format!("{provider_id} returned no answer"));
    }
    Ok(answer)
}

fn ask_turn(
    transport: PlannerTransport,
    binary: &str,
    model: Option<String>,
    effort: &str,
    prompt: &str,
) -> Result<String, String> {
    use super::claude::TextPlannerSession;
    match transport {
        PlannerTransport::ClaudeStreamJson => {
            let mcp_cfg = super::claude::ensure_empty_mcp_config()?;
            let model = model.unwrap_or_else(|| crate::models::CLAUDE_SONNET_5.to_string());
            let mut session = super::claude_pool::acquire(binary, &model, &mcp_cfg)
                .ok_or_else(|| "claude session unavailable (spawn failed)".to_string())?;
            session.send_planner_turn(prompt, None)
        }
        PlannerTransport::CodexAppServer => {
            let model = model.unwrap_or_else(|| crate::models::CODEX_GPT_5_6_TERRA.to_string());
            let mut session = super::codex::CodexSession::new(binary, &model, effort);
            session.send_planner_turn(prompt, None)
        }
        PlannerTransport::OpencodeRun => {
            let mut session = super::opencode::OpencodeSession::new(binary, model.as_deref());
            session.send_planner_turn(prompt, None)
        }
    }
}

// ── settings surface ────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontBrainOptionState {
    pub id: String,
    pub label: String,
    pub installed: bool,
}

/// What Settings → Voice renders for the Front brain segment: the stored
/// choice, which seats this machine can actually take, and the seat the next
/// Right-Option gesture will run.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymonFrontBrainState {
    pub choice: String,
    pub options: Vec<FrontBrainOptionState>,
    pub resolved_id: Option<String>,
    pub resolved_label: Option<String>,
    pub resolved_model: Option<String>,
    pub fell_back_from: Option<String>,
    pub escalate_available: bool,
}

impl Default for SymonFrontBrainState {
    fn default() -> Self {
        Self {
            choice: "auto".to_string(),
            options: Vec::new(),
            resolved_id: None,
            resolved_label: None,
            resolved_model: None,
            fell_back_from: None,
            escalate_available: false,
        }
    }
}

pub(crate) fn state() -> SymonFrontBrainState {
    let routing = resolve();
    let mut options = vec![FrontBrainOptionState {
        id: GEMINI_ID.to_string(),
        label: GEMINI_LABEL.to_string(),
        installed: gemini_available(),
    }];
    options.extend(
        planner_route::PLANNER_ADAPTERS
            .iter()
            .map(|adapter| FrontBrainOptionState {
                id: adapter.id.to_string(),
                label: adapter.label.to_string(),
                installed: planner_route::locate_planner_binary(adapter).is_some(),
            }),
    );
    SymonFrontBrainState {
        choice: read_choice().unwrap_or_else(|| "auto".to_string()),
        options,
        resolved_id: Some(routing.brain.id().to_string()),
        resolved_label: Some(routing.brain.label().to_string()),
        resolved_model: Some(routing.brain.model_label().to_string()),
        fell_back_from: routing.fell_back_from,
        escalate_available: routing.escalate_available,
    }
}
