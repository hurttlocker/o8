//! The planner's first-turn payload (#2157).
//!
//! Follow-up turns are cheap because the session holds the context, but every
//! escalation pays turn 1 in full: the persona, the planner contract and the
//! tool catalog all ride ahead of the task. Two things keep that bill down.
//!
//! **A stable prefix.** Persona (no clock) → planner contract → tool catalog,
//! in that order, with the tools in a deterministic order and every per-task
//! string — the time, the operator's memory, the conversation, the edit
//! target, the screen — after it, and the request strictly last. The prefix is
//! the same bytes on every task, which is the thing a provider prompt cache
//! can hit on. Anything with a clock or a task id in it breaks that, so it
//! stays on the far side of the boundary.
//!
//! **A compact catalog.** Descriptions choose a tool; parameter schemas call
//! one. So the catalog carries every tool's name and description on one line
//! each — the planner can still reach all of them — and prints parameters only
//! for the few tools real runs call most (`UP_FRONT_FULL_SCHEMA`). For anything
//! else the planner asks with a `tool_lookup` action and gets the full
//! description and the exact schema back inside the same session, one turn
//! later. Long descriptions are cut to whole leading sentences
//! (`DESCRIPTION_BUDGET`), and the same lookup returns the rest.

use serde_json::{json, Value};

use crate::agent::TaskCtx;

/// The planner-loop verb that trades one turn for a tool's full schema. It is
/// NOT a dispatchable tool: `run_text_planner_loop_inner` answers it before the
/// execution seam, so it never reaches the ledger, the confirm gate, or a
/// handler.
pub(crate) const TOOL_LOOKUP: &str = "tool_lookup";

/// Lookups per task. A lookup changes nothing, but it spends a turn out of
/// `MAX_TURNS`, so a planner that keeps reading instead of acting gets told to
/// act.
pub(crate) const MAX_TOOL_LOOKUPS: usize = 3;

/// Tools per lookup. Enough to cover a multi-step plan in one ask; not enough
/// to pull the whole catalog back in through the side door.
const MAX_LOOKUP_NAMES: usize = 8;

/// Tools whose full JSON Schema rides the first turn. Picked off the task
/// ledger — these are what real planner runs call most — plus
/// `symon_execute_plan`, which the planner contract names directly and so must
/// be callable without a lookup. Frequent tools that take no arguments
/// (`term_list`) stay compact: `{}` is the whole call. So does the one frequent
/// tool with a very large schema (`o8_canvas`, ~6 KB), because a lookup on the
/// runs that need it is cheaper than those bytes on every run that does not.
pub(crate) const UP_FRONT_FULL_SCHEMA: &[&str] = &[
    "symon_execute_plan",
    "o8_ui_set",
    "o8_ui_open",
    "o8_status",
    "mac_reminders_create",
    "mac_reminders_list",
    "mac_calendar_list_events",
];

/// The first turn as sent, with the numbers the `[symon-planner]` log line
/// reports.
pub(crate) struct FirstTurn {
    pub(crate) prompt: String,
    /// Full JSON-Schema tool definitions carried in the prompt. Every other
    /// tool is reachable by name from the compact catalog.
    pub(crate) tool_defs: usize,
}

fn tool_name(tool: &Value) -> &str {
    tool.get("name").and_then(Value::as_str).unwrap_or_default()
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Every tool the planner may call, in deterministic order.
///
/// `escalate` is stripped: the background brain DOES the work, and handing the
/// task to another background brain is the infinite-handoff loop. Name order
/// (rather than source order) is what keeps the prefix byte-stable — the MCP
/// tools on the tail arrive over HTTP and carry no order of their own.
pub(crate) fn catalog_tools() -> Vec<Value> {
    let mut tools: Vec<Value> = crate::agent::tools::enabled_tools()
        .into_iter()
        .filter(|tool| tool_name(tool) != "escalate")
        .collect();
    tools.sort_by(|left, right| tool_name(left).cmp(tool_name(right)));
    tools
}

/// Compact-catalog description budget, in bytes. Sentence-aware: a longer
/// description keeps whole leading sentences and ends in an ellipsis, and
/// `tool_lookup` hands back the full text along with the parameters — so the
/// rest is deferred, not lost.
const DESCRIPTION_BUDGET: usize = 240;

fn trimmed_description(description: &str) -> String {
    let text = one_line(description);
    if text.len() <= DESCRIPTION_BUDGET {
        return text;
    }
    let bytes = text.as_bytes();
    let mut first_end: Option<usize> = None;
    let mut last_end: Option<usize> = None;
    for (at, character) in text.char_indices() {
        if !matches!(character, '.' | '!' | '?') || bytes.get(at + 1) != Some(&b' ') {
            continue;
        }
        let end = at + 1;
        first_end.get_or_insert(end);
        if end <= DESCRIPTION_BUDGET {
            last_end = Some(end);
        } else {
            break;
        }
    }
    let end = last_end.or(first_end).unwrap_or_else(|| {
        // No sentence to cut on: fall back to the budget, on a char boundary.
        text.char_indices()
            .take_while(|(at, _)| *at <= DESCRIPTION_BUDGET)
            .last()
            .map(|(at, _)| at)
            .unwrap_or(text.len())
    });
    format!("{} …", &text[..end])
}

/// `name — what it does`, on one line, parameters omitted.
fn compact_line(tool: &Value) -> String {
    let name = tool_name(tool);
    match tool.get("description").and_then(Value::as_str) {
        Some(description) if !description.trim().is_empty() => {
            format!("{name} — {}", trimmed_description(description))
        }
        _ => name.to_string(),
    }
}

/// An up-front schema without its description — the catalog line right above it
/// already carries that, and the duplicate is pure weight.
fn schema_only(tool: &Value) -> Value {
    let mut object = serde_json::Map::new();
    object.insert("name".to_string(), json!(tool_name(tool)));
    if let Some(parameters) = tool.get("parameters") {
        object.insert("parameters".to_string(), parameters.clone());
    }
    Value::Object(object)
}

/// The tool half of the invariant prefix, and the number of full schemas in it.
fn catalog_block(tools: &[Value]) -> (String, usize) {
    let mut block = String::from(
        "\n\n--- TOOLS ---\n\
         You can call EVERY tool listed below by name. The list gives each tool's name and a \
         shortened description; their ARGUMENTS are not printed here, and a description ending \
         in … has more to it. Before calling a tool whose parameters are not printed further \
         down, ask for them:\n  \
         {\"tool\": \"tool_lookup\", \"args\": {\"names\": [\"mac_notes_create\"]}}\n\
         The system replies with those tools' full description and exact JSON Schema, and you \
         then call the tool normally. A lookup is not an action — it changes nothing and costs \
         one turn — so ask whenever you are unsure of an argument name instead of guessing one. \
         A tool that takes no arguments is called with {} and needs no lookup.\n\n\
         TOOLS (name — what it does):\n",
    );
    for tool in tools {
        block.push_str(&compact_line(tool));
        block.push('\n');
    }

    let full: Vec<&Value> = tools
        .iter()
        .filter(|tool| UP_FRONT_FULL_SCHEMA.contains(&tool_name(tool)))
        .collect();
    if !full.is_empty() {
        block.push_str(
            "\nPARAMETERS for the tools below — call these directly, no lookup needed:\n",
        );
        for tool in &full {
            block.push_str(&serde_json::to_string(&schema_only(tool)).unwrap_or_default());
            block.push('\n');
        }
    }
    (block, full.len())
}

/// Persona → planner contract → tool catalog. The same bytes on every task.
pub(crate) fn invariant_prefix() -> (String, usize) {
    let tools = catalog_tools();
    let (catalog, tool_defs) = catalog_block(&tools);
    let mut prefix = crate::agent::system_prompt_invariant();
    prefix.push_str(super::PLANNER_CONTRACT);
    prefix.push_str(&catalog);
    (prefix, tool_defs)
}

/// Build the first planner prompt: the invariant prefix, then this task's
/// context (clock / skill / memory, conversation, edit target, screen), then
/// the request last. When a screenshot rides the turn it is sent as an image
/// block (see `ClaudeSession::send_turn`) and this prompt teaches the screen +
/// draw protocol.
pub(crate) fn build_first_prompt(intent: &str, ctx: &TaskCtx) -> FirstTurn {
    let (mut prompt, tool_defs) = invariant_prefix();

    // ---- everything below here is per-task; nothing above it may be ----
    prompt.push_str("\n\n--- RIGHT NOW ---\n");
    prompt.push_str(&crate::agent::system_prompt_task_context());
    if let Some(convo) = crate::agent::conversation_context() {
        prompt.push_str("\n\n");
        prompt.push_str(&convo);
    }
    if let Some(edit) = &ctx.edit {
        prompt.push_str("\n\n");
        prompt.push_str(&crate::agent::edit_prompt_section(edit));
    }
    if let Some(screen) = &ctx.screen {
        prompt.push_str("\n\n");
        prompt.push_str(&crate::agent::screen_prompt_section(screen));
        // Planner-path rule: the [POINT]/[DRAW] tags must ride INSIDE the `say`
        // string of the final {"done": true, "say": "..."} action — never as
        // loose text outside the JSON, or extract_action won't see them.
        prompt.push_str(
            "\n\n(You CAN see the attached screenshot. When you point or draw, put the \
             [POINT]/[GUIDE]/[DRAW] tags INSIDE the \"say\" string of your final \
             {\"done\": true, \"say\": \"...\"} action — never outside the JSON object.)",
        );
        // Additive teaching diagrams (#1251): if a drawing session is live, give
        // the brain back the exact tags it just drew so it re-emits + extends
        // them instead of starting a fresh figure.
        if let Some(feedback) = crate::agent::last_drawing_feedback() {
            prompt.push_str(&feedback);
        }
    }
    prompt.push_str(&format!("\n\nUser request: {intent}"));
    FirstTurn { prompt, tool_defs }
}

/// Tool names off a `tool_lookup` action. Takes `names: [...]` and tolerates a
/// single `name: "..."`, because that is the other way a model writes it.
pub(crate) fn requested_lookup_names(args: &Value) -> Vec<String> {
    let mut names: Vec<String> = match args.get("names") {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect(),
        Some(Value::String(single)) => vec![single.clone()],
        _ => Vec::new(),
    };
    if names.is_empty() {
        if let Some(single) = args
            .get("name")
            .or_else(|| args.get("tool"))
            .and_then(Value::as_str)
        {
            names.push(single.to_string());
        }
    }
    names.retain(|name| !name.trim().is_empty());
    names.truncate(MAX_LOOKUP_NAMES);
    names
}

const NEXT_ACTION_TAIL: &str = "\n\nNow respond with your NEXT action as a single JSON object — a \
                                tool call, or {\"done\": true, \"say\": \"...\"} when the request \
                                is fully handled.";

/// The `[SYSTEM]` reply to a `tool_lookup`: exact schemas for the names the
/// planner asked for, and a plain miss for anything not in the catalog.
pub(crate) fn tool_lookup_message(names: &[String]) -> String {
    if names.is_empty() {
        return format!(
            "[SYSTEM] tool_lookup needs the tool names you want, for example \
             {{\"tool\": \"tool_lookup\", \"args\": {{\"names\": [\"mac_notes_create\"]}}}}.\
             {NEXT_ACTION_TAIL}"
        );
    }
    let catalog = catalog_tools();
    let mut found: Vec<&Value> = Vec::new();
    let mut missing: Vec<&str> = Vec::new();
    for name in names {
        match catalog.iter().find(|tool| tool_name(tool) == name.as_str()) {
            Some(tool) => found.push(tool),
            None => missing.push(name.as_str()),
        }
    }
    let mut message = format!(
        "[SYSTEM] tool_lookup returned the full JSON Schema for {} of {} requested tool(s).",
        found.len(),
        names.len()
    );
    for tool in found {
        message.push('\n');
        message.push_str(&serde_json::to_string(tool).unwrap_or_default());
    }
    if !missing.is_empty() {
        message.push_str(&format!(
            "\nNot in the catalog (no such tool — use a name exactly as listed): {}",
            missing.join(", ")
        ));
    }
    message.push_str(NEXT_ACTION_TAIL);
    message
}

/// Said once the lookup budget is gone: read enough, now act.
pub(crate) fn lookup_budget_spent_message() -> String {
    format!(
        "[SYSTEM] You have used all {MAX_TOOL_LOOKUPS} tool_lookup turns for this task. Call a \
         tool now with the schemas you already have, or finish with {{\"done\": true, \"say\": \
         \"...\"}} if you cannot.{NEXT_ACTION_TAIL}"
    )
}

#[cfg(test)]
#[path = "planner_payload_tests.rs"]
mod planner_payload_tests;
