//! Symon voice-agent tool-calling loop — CLAUDE brain, "text-planner" protocol.
//!
//! The second brain (epic: `docs/symon-port/two-tier-brain-epic.md`). Selected
//! when the configured model id starts with `claude` (e.g. `claude-sonnet-4-6`),
//! and the async escalation target for Gemini's `escalate(target:"claude_brain")`.
//!
//! ## Why "text-planner" and not native tool-use
//! Live fixtures (`claude` 2.1.179, 2026-06-16) proved Claude Code OWNS tool
//! execution: a `tool_use` is followed by a CLI-produced `tool_result` with no
//! caller injection, and the CLI reaches *external* tools only via MCP. So we
//! can NOT hand Claude o8's 47 native Rust tools over stdin. Instead we run
//! Claude as a pure text-in/text-out PLANNER (tools OFF via an empty
//! `--strict-mcp-config`): it replies with the next action as a single JSON
//! object, and THIS loop executes that action through the exact same Rust
//! machinery the Gemini loop uses — `confirm_if_needed` → `dispatch_tool_call`,
//! `emit_agent_event`, `tts`. Tools never leave Rust; the confirm gate is
//! untouched. Same billing as the chat tab / QA warm pool (no `--print`, so it
//! draws the user's Claude subscription pool, not the metered SDK pool).
//!
//! ## Spawn gotcha (from the fixtures)
//! stdin must stay OPEN until the `result` event arrives — closing it at EOF
//! immediately makes the CLI run its SessionStart hooks and exit WITHOUT
//! processing the turn. The per-turn helper holds the stdin handle across the
//! whole read, then drops it.
//!
//! ## V1 shape / known follow-ups
//! One fresh `claude` process per loop turn (stateless), re-sending the running
//! transcript — mirrors how `gemini.rs` re-sends `contents`. Simple + robust;
//! the cost is a per-turn bootstrap + re-sent tool schema. The documented
//! optimization is a persistent REPL (one spawn, schema sent once) — deferred
//! until the path is proven. Built-in tools are held off by the planner
//! contract (a `--disallowed-tools` hard lock is a follow-up).

use super::{tools, LoopResult, TaskCtx};
use serde_json::{json, Value};
use std::time::Duration;

const MAX_TURNS: usize = 10;
/// Per-turn ceiling. A real model hang is rare; on timeout the turn errors and
/// the loop surfaces a failure rather than hanging the task forever.
const TURN_TIMEOUT_SECS: u64 = 150;

/// The planner protocol, prepended to the tool schema. Kept blunt: Claude
/// follows strong format instructions well, and "JSON only, no built-in tools"
/// is what keeps it emitting actions instead of trying to act directly.
const PLANNER_CONTRACT: &str = "\n\n--- HOW YOU ACT ---\n\
You are operating as a PLANNER. You do NOT have direct access to any tools and \
you must NOT use any built-in tools (no Bash, no file reads, no web). To take \
an action you reply with EXACTLY ONE JSON object and NOTHING else — no prose, \
no markdown, no code fences:\n\
  • To call a tool:  {\"tool\": \"<tool_name>\", \"args\": { ... }}\n\
  • When the request is fully handled:  {\"done\": true, \"say\": \"<one short spoken sentence>\"}\n\
The system executes the tool you name and replies with its result; then you \
choose the next action the same way. Call ONE tool per reply. Your `say` is \
spoken aloud — one or two short conversational sentences, no markdown. If no \
tool fits the request, reply with a `done` action that briefly says so.";

/// Resolve the `claude` binary — mirrors `one-shot-repl.ts::defaultClaudeBin`.
fn claude_bin() -> String {
    if let Ok(b) = std::env::var("O8_CLAUDE_CODE_BIN") {
        if !b.is_empty() {
            return b;
        }
    }
    if let Ok(b) = std::env::var("CLAUDE_BIN") {
        if !b.is_empty() {
            return b;
        }
    }
    let home = std::env::var("HOME").unwrap_or_default();
    format!("{home}/.local/bin/claude")
}

/// Write (once) an empty MCP config so `--strict-mcp-config` gives Claude NO
/// tools — the same "brain never uses tools" posture as the QA warm pool.
fn ensure_empty_mcp_config() -> Result<String, String> {
    let path = super::agent_data_dir().join("claude-empty-mcp.json");
    if !path.exists() {
        std::fs::write(&path, "{\"mcpServers\":{}}")
            .map_err(|e| format!("failed to write empty mcp config: {e}"))?;
    }
    Ok(path.to_string_lossy().to_string())
}

/// Build the first planner prompt: persona + (conversation / edit / SCREEN)
/// context + the tool schema + the JSON-action contract + the user's request.
/// When a screenshot rides the turn it is sent as an image block (see
/// `claude_text_turn_blocking`) and this prompt teaches the screen + draw
/// protocol — Opus 4.8 sees the screen directly (#1252), no Gemini middleman.
fn build_first_prompt(intent: &str, ctx: &TaskCtx) -> String {
    let mut s = super::system_prompt();
    if let Some(convo) = super::conversation_context() {
        s.push_str("\n\n");
        s.push_str(&convo);
    }
    if let Some(edit) = &ctx.edit {
        s.push_str("\n\n");
        s.push_str(&super::edit_prompt_section(edit));
    }
    if let Some(screen) = &ctx.screen {
        s.push_str("\n\n");
        s.push_str(&super::screen_prompt_section(screen.img_w, screen.img_h));
        // Planner-path rule: the [POINT]/[DRAW] tags must ride INSIDE the `say`
        // string of the final {"done": true, "say": "..."} action — never as
        // loose text outside the JSON, or extract_action won't see them.
        s.push_str(
            "\n\n(You CAN see the attached screenshot. When you point or draw, put the \
             [POINT]/[GUIDE]/[DRAW] tags INSIDE the \"say\" string of your final \
             {\"done\": true, \"say\": \"...\"} action — never outside the JSON object.)",
        );
    }
    // The background brain DOES the work — strip `escalate` so it can't re-hand
    // the task back to another Claude task (infinite-handoff guard).
    let tool_specs: Vec<Value> = tools::enabled_tools()
        .into_iter()
        .filter(|t| t.get("name").and_then(|n| n.as_str()) != Some("escalate"))
        .collect();
    let tools_json =
        serde_json::to_string_pretty(&tool_specs).unwrap_or_else(|_| "[]".to_string());
    s.push_str(PLANNER_CONTRACT);
    s.push_str(&format!("\n\nAVAILABLE TOOLS (JSON Schema):\n{tools_json}"));
    s.push_str(&format!("\n\nUser request: {intent}"));
    s
}

/// Pull the next-action JSON out of Claude's reply — tolerant of stray code
/// fences or a stray sentence around the object.
fn extract_action(text: &str) -> Option<Value> {
    let mut t = text.trim();
    if let Some(rest) = t.strip_prefix("```json") {
        t = rest.trim();
    } else if let Some(rest) = t.strip_prefix("```") {
        t = rest.trim();
    }
    if let Some(rest) = t.strip_suffix("```") {
        t = rest.trim();
    }
    if let Ok(v) = serde_json::from_str::<Value>(t) {
        return Some(v);
    }
    // Fall back to the first {...last} span.
    let start = t.find('{')?;
    let end = t.rfind('}')?;
    if end <= start {
        return None;
    }
    serde_json::from_str::<Value>(&t[start..=end]).ok()
}

/// One planner turn: spawn `claude` (tools OFF), send `prompt` as a single user
/// frame, read stream-json until the `result` event, return its text. Fully
/// synchronous — runs inside `spawn_blocking` so it never blocks the runtime.
/// Holds stdin open across the read (the spawn gotcha), then tears the process
/// down.
fn claude_text_turn_blocking(
    bin: &str,
    model: &str,
    mcp_cfg: &str,
    prompt: &str,
    // base64 PNG of the screen, present ONLY on the first turn (the image is
    // seen once; re-sending on follow-ups wastes tokens + latency). #1252.
    image_b64: Option<String>,
) -> Result<String, String> {
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Command, Stdio};

    let mut child = Command::new(bin)
        .args([
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--permission-mode",
            "bypassPermissions",
            "--strict-mcp-config",
            "--mcp-config",
            mcp_cfg,
            "--model",
            model,
        ])
        .env("FORCE_COLOR", "0")
        .env("NO_COLOR", "1")
        // Same subscription-billing posture as the chat tab / warm pool: no
        // `--print`, so this draws the user's Claude pool, not the SDK pool.
        // Scrub ANTHROPIC_API_KEY from the child so an env key can't silently
        // flip billing to the API pool (it takes precedence over the sub).
        .env_remove("ANTHROPIC_API_KEY")
        .env("O8_MANAGED_SESSION", "1")
        // Neutral cwd — a project `.claude/` / `.mcp.json` would otherwise bleed
        // tools back in, defeating `--strict-mcp-config`.
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // Drop stderr — keeps the pipe from filling and deadlocking the read;
        // the `result` event carries success/error.
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("claude spawn failed: {e}"))?;

    // Hold stdin OPEN until after the result is read (closing at EOF makes the
    // CLI run session hooks and exit without processing the turn).
    let mut stdin = child.stdin.take().ok_or("claude: no stdin handle")?;
    // Text-only string content by default; on the first turn with a screenshot,
    // a content ARRAY carrying the image block so Opus sees the screen (#1252).
    let content = match &image_b64 {
        Some(b64) => json!([
            { "type": "text", "text": prompt },
            { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": b64 } },
        ]),
        None => json!(prompt),
    };
    let frame = json!({ "type": "user", "message": { "role": "user", "content": content } });
    writeln!(stdin, "{frame}").map_err(|e| format!("claude stdin write: {e}"))?;
    let _ = stdin.flush();

    let stdout = child.stdout.take().ok_or("claude: no stdout handle")?;
    let reader = BufReader::new(stdout);
    let mut answer = String::new();
    let mut got_result = false;

    for line in reader.lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(ev) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match ev.get("type").and_then(|t| t.as_str()) {
            Some("result") => {
                answer = ev
                    .get("result")
                    .and_then(|r| r.as_str())
                    .unwrap_or("")
                    .to_string();
                got_result = true;
                break;
            }
            // Fallback: if the `result` text is ever empty, the last assistant
            // text block is the answer.
            Some("assistant") => {
                if let Some(content) = ev.pointer("/message/content").and_then(|c| c.as_array()) {
                    for block in content {
                        if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                            if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                                if !t.trim().is_empty() {
                                    answer = t.to_string();
                                }
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    // Read done — close stdin and reap the process.
    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();

    if !got_result && answer.trim().is_empty() {
        return Err("claude produced no result for this turn".to_string());
    }
    Ok(answer)
}

/// Run the Claude planner loop to completion. Same `LoopResult` contract as
/// `gemini::run_loop` / `openrouter::run_loop`.
pub async fn run_loop(model: &str, intent: &str, ctx: &TaskCtx) -> Result<LoopResult, String> {
    let bin = claude_bin();
    let mcp_cfg = ensure_empty_mcp_config()?;

    // The running transcript re-sent each turn (V1; a persistent REPL would
    // send the schema once — deferred).
    let mut transcript = build_first_prompt(intent, ctx);

    let mut tool_call_log: Vec<Value> = Vec::new();
    let mut brain_sources: Vec<Value> = Vec::new();
    let mut result_text = String::new();
    // Spoken-filler latch — a quick "one sec" so the slow tool/turn isn't dead air.
    let mut spoke_filler = false;
    // Opus is slower than Gemini, so the all-Claude FRONT voice path opens with
    // an immediate filler (the live mic shouldn't sit silent while Opus thinks).
    // Background escalation tasks (`claude-task-*`) already had a front ack, so
    // they stay quiet here. #1252.
    if !ctx.task_id.starts_with("claude-task") {
        super::speak_filler_now();
        spoke_filler = true;
    }
    // The screenshot rides the FIRST turn only (Opus sees it once); `.take()`
    // hands it to turn 1 and leaves None for every follow-up. #1252.
    let mut first_image: Option<String> = ctx.screen.as_ref().map(|s| s.png_base64.clone());

    for _turn in 0..MAX_TURNS {
        // User interrupted (Escape / tap-to-stop) — stop before the next turn.
        // run_agent_inner sees the cancel flag and goes quiet.
        if ctx.is_cancelled() {
            break;
        }
        let (b, m, c, t) = (bin.clone(), model.to_string(), mcp_cfg.clone(), transcript.clone());
        let img = first_image.take();
        let raw = tokio::time::timeout(
            Duration::from_secs(TURN_TIMEOUT_SECS),
            tokio::task::spawn_blocking(move || claude_text_turn_blocking(&b, &m, &c, &t, img)),
        )
        .await
        .map_err(|_| "claude turn timed out".to_string())?
        .map_err(|e| format!("claude turn join error: {e}"))??;

        let Some(action) = extract_action(&raw) else {
            // Not parseable as an action — take the reply as the final answer
            // rather than looping blindly.
            result_text = raw.trim().to_string();
            break;
        };

        if action.get("done").and_then(|d| d.as_bool()) == Some(true) {
            result_text = action
                .get("say")
                .and_then(|s| s.as_str())
                .unwrap_or("Done.")
                .trim()
                .to_string();
            break;
        }

        let Some(tool_name) = action.get("tool").and_then(|t| t.as_str()).map(|s| s.to_string())
        else {
            // No tool, no done — treat any prose as the answer.
            result_text = raw.trim().to_string();
            break;
        };
        let tool_args = action.get("args").cloned().unwrap_or(json!({}));

        super::emit_agent_event(
            &ctx.app,
            json!({ "taskId": ctx.task_id, "kind": "tool_call", "tool": tool_name, "args": tool_args }),
        );

        let tool_result: Value = if !super::confirm_if_needed(ctx, &tool_name, &tool_args).await {
            log::info!("[symon-agent] tool {tool_name} declined by user");
            json!({ "error": "User declined this action", "declined_by_user": true })
        } else {
            super::maybe_speak_filler(&mut spoke_filler, &tool_name);
            match tools::dispatch_tool_call(&tool_name, tool_args.clone(), ctx).await {
                Ok(output) => output,
                Err(e) => {
                    log::warn!("[symon-agent] tool {tool_name} error: {e}");
                    json!({ "error": e })
                }
            }
        };

        tool_call_log.push(json!({
            "tool": tool_name,
            "args": tool_args,
            "ok": tool_result.get("error").is_none(),
        }));

        // Collect titled Brain sources for the dock answer panel.
        if tool_name == "o8_ask" {
            if let Some(srcs) = tool_result.get("sources").and_then(|v| v.as_array()) {
                brain_sources.extend(srcs.iter().take(5).cloned());
                brain_sources.truncate(8);
            }
        }

        super::emit_agent_event(
            &ctx.app,
            json!({ "taskId": ctx.task_id, "kind": "tool_result", "tool": tool_name, "result": tool_result }),
        );

        // Feed the result back into the transcript and ask for the next action.
        let result_str =
            serde_json::to_string(&tool_result).unwrap_or_else(|_| "{}".to_string());
        transcript.push_str(&format!(
            "\n\n[SYSTEM] You called `{tool_name}`. It returned:\n{result_str}\n\n\
             Now respond with your NEXT action as a single JSON object — a tool \
             call, or {{\"done\": true, \"say\": \"...\"}} when the request is \
             fully handled."
        ));
    }

    if result_text.is_empty() {
        result_text = "Done.".to_string();
    }

    Ok(LoopResult {
        result_text,
        model_used: model.to_string(),
        tool_calls_json: Value::Array(tool_call_log).to_string(),
        brain_sources,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_action_plain_json() {
        let a = extract_action(r#"{"tool":"mac_weather","args":{}}"#).unwrap();
        assert_eq!(a.get("tool").unwrap(), "mac_weather");
    }

    #[test]
    fn extract_action_fenced() {
        let a = extract_action("```json\n{\"done\":true,\"say\":\"All set.\"}\n```").unwrap();
        assert_eq!(a.get("done").unwrap(), true);
        assert_eq!(a.get("say").unwrap(), "All set.");
    }

    #[test]
    fn extract_action_with_prose() {
        let a = extract_action("Sure, here is my action:\n{\"tool\":\"o8_status\",\"args\":{}}\nLet me know!")
            .unwrap();
        assert_eq!(a.get("tool").unwrap(), "o8_status");
    }

    #[test]
    fn extract_action_garbage_is_none() {
        assert!(extract_action("no json here at all").is_none());
    }
}
