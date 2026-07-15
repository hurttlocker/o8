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
//! stdin must stay OPEN for the proc's whole life — closing it at EOF makes the
//! CLI run its SessionStart hooks and exit WITHOUT processing. `ClaudeSession`
//! holds the stdin handle until the session is dropped at task end.
//!
//! ## Process shape (#1252 speed pass)
//! ONE persistent `claude` session per task — not a fresh spawn per turn. The
//! proc boots once (pre-warmed on the Option keydown via `claude_pool`, so even
//! turn 1 skips the ~1-2s CLI bootstrap), and each turn sends a single user
//! frame while the model keeps its context. Turn 1 carries the full system
//! prompt + tool schema + screenshot; follow-ups carry only the tool result — no
//! re-boot, no transcript re-prefill. Built-in tools are held off by the planner
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
choose the next action the same way. Call ONE tool per reply.\n\
CRITICAL: your ENTIRE reply is that one JSON object — STOP at its closing brace. \
Do NOT write the tool's result yourself, do NOT simulate the system's reply, and \
do NOT add a second action or a 'system'/'assistant' turn. The real system runs \
the tool and sends you the result, so wait for it. NEVER invent or guess the \
user's real data: for ANYTHING about their actual reminders, calendar, notes, \
mail, files, terminals, screen, or the o8 fleet you MUST call the matching tool \
and use ITS result — never answer from memory or assumption.\n\
If the request has SEVERAL parts (e.g. \"switch to dark mode AND make it glass\"), \
make a SEPARATE tool call for EACH part across turns, and only say done once \
every part is actually done — never claim a change you did not make a tool call for.\n\
Your `say` is spoken aloud — one or two short conversational sentences, no \
markdown. If no tool fits the request, reply with a `done` action that briefly \
says so.";

/// Resolve the `claude` binary — mirrors `one-shot-repl.ts::defaultClaudeBin`.
pub(crate) fn claude_bin() -> String {
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
    // Scan the well-known install dirs instead of assuming the native
    // installer's ~/.local/bin — that hardcoded fallback was iMac-only and
    // Symon died "spawn failed" on every npm/brew install (#1551 walkdown,
    // round 5, 2026-07-12). ~/.o8/bin first: o8 symlinks detected CLIs there
    // itself, so it is the freshest pointer when present. Mirrors the TS
    // scanForBinary order; last resort keeps the legacy default so the error
    // message still names a concrete path.
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        format!("{home}/.o8/bin/claude"),
        format!("{home}/.local/bin/claude"),
        format!("{home}/.npm-global/bin/claude"),
        "/usr/local/bin/claude".to_string(),
        "/opt/homebrew/bin/claude".to_string(),
        format!("{home}/.claude/local/claude"),
    ];
    for c in candidates {
        if std::path::Path::new(&c).exists() {
            return c;
        }
    }
    format!("{home}/.local/bin/claude")
}

/// PATH with the sidecar-resolved node runtime guaranteed present. The claude
/// binary is a `#!/usr/bin/env node` shim on npm installs — on an nvm-only
/// machine the ambient PATH has no node and the shim dies instantly even when
/// the path to it is right (same class as the TS-side fix in 0.1.588). The
/// sidecar already resolved a working node into O8_NODE_BIN at boot.
pub(crate) fn path_with_node_runtime() -> String {
    let base = std::env::var("PATH").unwrap_or_default();
    let Ok(node_bin) = std::env::var("O8_NODE_BIN") else {
        return base;
    };
    let Some(dir) = std::path::Path::new(&node_bin).parent() else {
        return base;
    };
    let dir = dir.to_string_lossy();
    if base.split(':').any(|p| p == dir) {
        return base;
    }
    format!("{dir}:{base}")
}

/// Write (once) an empty MCP config so `--strict-mcp-config` gives Claude NO
/// tools — the same "brain never uses tools" posture as the QA warm pool.
pub(crate) fn ensure_empty_mcp_config() -> Result<String, String> {
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
/// `ClaudeSession::send_turn`) and this prompt teaches the screen + draw
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
        // Additive teaching diagrams (#1251): if a drawing session is live, give
        // the brain back the exact tags it just drew so it re-emits + extends
        // them instead of starting a fresh figure.
        if let Some(feedback) = super::last_drawing_feedback() {
            s.push_str(&feedback);
        }
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
    // Fall back to the FIRST complete brace-balanced object — NOT first '{'..last '}'.
    // When the model "runs ahead" and emits the whole turn in one reply
    // ({"tool":..} system{..} assistant{"done":..}), a first..last span is invalid
    // JSON (bare `system`/`assistant`/`main` words between objects) and parsing it
    // fails — dropping the real action and causing a silent false success. Taking the
    // first balanced object recovers the action so the loop dispatches it for real.
    let bytes = t.as_bytes();
    let start = t.find('{')?;
    let mut depth = 0usize;
    let mut in_str = false;
    let mut escaped = false;
    let mut end = None;
    for (i, &c) in bytes.iter().enumerate().skip(start) {
        if in_str {
            if escaped {
                escaped = false;
            } else if c == b'\\' {
                escaped = true;
            } else if c == b'"' {
                in_str = false;
            }
        } else {
            match c {
                b'"' => in_str = true,
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = Some(i);
                        break;
                    }
                }
                _ => {}
            }
        }
    }
    serde_json::from_str::<Value>(&t[start..=end?]).ok()
}

/// A LIVE `claude` planner process kept open across a task's turns. Spawned once
/// (tools OFF, stream-json), it holds stdin + a persistent reader so each turn is
/// one user frame in / `result` out WITHOUT re-spawning or re-sending the system
/// prompt + tool schema — the model keeps its own context between turns (#1252
/// speed pass; replaces the old spawn-per-turn helper). The warm pool
/// (`claude_pool`) pre-boots these on the Option keydown so turn 1 skips the
/// ~1-2s CLI bootstrap. Same flags + subscription billing as before (no `--print`).
pub(crate) struct ClaudeSession {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    reader: std::io::BufReader<std::process::ChildStdout>,
    /// Model this proc booted for — the pool keys warm reuse on it.
    pub(crate) model: String,
}

impl ClaudeSession {
    /// Boot a `claude` proc ready to receive turns. Returns as soon as the
    /// process is started; the CLI bootstrap runs in the child (overlap it via
    /// the warm pool). stdin stays OPEN for the proc's life — closing at EOF
    /// makes the CLI run its SessionStart hooks and exit without processing.
    pub(crate) fn spawn(bin: &str, model: &str, mcp_cfg: &str) -> Result<Self, String> {
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
            // npm-installed claude is a node shim — see path_with_node_runtime.
            .env("PATH", path_with_node_runtime())
            // No `--print` → draws the user's Claude subscription pool, not the
            // metered SDK pool. Scrub ANTHROPIC_API_KEY so an env key can't flip
            // billing to the API pool (it takes precedence over the sub).
            .env_remove("ANTHROPIC_API_KEY")
            .env("O8_MANAGED_SESSION", "1")
            // Neutral cwd — a project `.claude/` / `.mcp.json` would otherwise
            // bleed tools back in, defeating `--strict-mcp-config`.
            .current_dir(std::env::temp_dir())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Drop stderr — keeps the pipe from filling and deadlocking the read;
            // the `result` event carries success/error.
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("claude spawn failed: {e}"))?;
        let stdin = child.stdin.take().ok_or("claude: no stdin handle")?;
        let stdout = child.stdout.take().ok_or("claude: no stdout handle")?;
        Ok(Self {
            child,
            stdin,
            reader: std::io::BufReader::new(stdout),
            model: model.to_string(),
        })
    }

    /// Still running? The pool discards dead warm sessions instead of handing
    /// one out (a stale CLI may have idle-exited).
    pub(crate) fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// Send ONE planner turn and read stream-json until the `result` event;
    /// return its text. The proc STAYS ALIVE for the next turn (the model keeps
    /// its context, so follow-ups send only the tool result — no re-prefill). On
    /// the first turn a screenshot may ride along as an image block; later turns
    /// pass None. Blocking — call from `spawn_blocking`.
    pub(crate) fn send_turn(
        &mut self,
        prompt: &str,
        image_b64: Option<&str>,
    ) -> Result<String, String> {
        use std::io::{BufRead, Write};
        let content = match image_b64 {
            Some(b64) => json!([
                { "type": "text", "text": prompt },
                { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": b64 } },
            ]),
            None => json!(prompt),
        };
        let frame = json!({ "type": "user", "message": { "role": "user", "content": content } });
        writeln!(self.stdin, "{frame}").map_err(|e| format!("claude stdin write: {e}"))?;
        self.stdin.flush().map_err(|e| format!("claude stdin flush: {e}"))?;

        let mut answer = String::new();
        let mut got_result = false;
        let mut line = String::new();
        loop {
            line.clear();
            match self.reader.read_line(&mut line) {
                Ok(0) => break, // EOF — the proc exited
                Ok(_) => {}
                Err(e) => return Err(format!("claude read: {e}")),
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(ev) = serde_json::from_str::<Value>(trimmed) else {
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
                    if let Some(blocks) = ev.pointer("/message/content").and_then(|c| c.as_array()) {
                        for block in blocks {
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
        if !got_result && answer.trim().is_empty() {
            return Err("claude produced no result for this turn".to_string());
        }
        Ok(answer)
    }
}

impl Drop for ClaudeSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Corrective injected ONCE when the planner says `done` on an action request
/// without ever dispatching a tool — the signature-B fabrication guard. Forces a
/// real tool call or an honest "I didn't do it" instead of a fabricated success.
const PREMATURE_DONE_NUDGE: &str = "You replied done, but you have NOT called any \
tool yet — so NOTHING has actually happened on the user's Mac. Never claim something \
is done that you did not do. If this needs an action, reply NOW with the tool call \
({\"tool\": \"...\", \"args\": { ... }}) to really perform it. If you genuinely cannot \
with the available tools, reply done with a `say` that HONESTLY states you did not do \
it (and why) — not a success claim.";

/// Verbs that mean "DO something on the Mac / in o8" — a mutation or action that
/// REQUIRES a tool. Lowercased substring match (same cheap style as
/// `screen::wants_screen`). Pure questions ("how many reminders") aren't here —
/// those reliably call their tool already; the fabrication risk is on actions.
const ACTION_CUES: &[&str] = &[
    "create", "add ", "make ", "set a", "set up", "set my", "set the", "schedule",
    "remind ", "delete", "remove", "clear ", "complete", "mark ", "check off",
    "finish", "rename", "reschedule", "move ", "update", "change", "edit ",
    "send", "draft", "turn on", "turn off", "enable", "disable", "switch", "toggle",
    "open ", "launch", "run ", "save ", "write ",
];

/// Does the request ask Symon to take an ACTION (not just answer)? Gates the
/// anti-fabrication nudge so pure Q&A is never second-guessed. Questions are
/// excluded FIRST — they reliably call their own tool, and the question-gate
/// also dodges verb/noun collisions ("how many REMINDers", "what's my SCHEDULE")
/// that a bare substring match would trip on.
fn looks_like_action_request(intent: &str) -> bool {
    let p = intent.trim().to_lowercase();
    const QUESTION_STARTS: &[&str] = &[
        "how ", "how many", "how much", "what", "when ", "where", "who ", "whose",
        "why", "which", "is ", "are ", "am ", "do ", "does ", "did ", "can ",
        "could ", "would ", "will ", "should ", "have ", "has ", "was ", "were ",
        "tell me", "show me", "list ", "give me",
    ];
    if p.contains('?') || QUESTION_STARTS.iter().any(|q| p.starts_with(q)) {
        return false;
    }
    ACTION_CUES.iter().any(|cue| p.contains(cue))
}

/// True when a `done` say is plainly an honest non-completion — a question
/// (clarification) or a refusal / inability. Suppresses the nudge for these:
/// they are legitimate no-tool dones, not fabricated success claims.
fn say_is_question_or_refusal(say: &str) -> bool {
    if say.contains('?') {
        return true;
    }
    let s = say.to_lowercase();
    const NONCLAIM: &[&str] = &[
        "can't", "cannot", "won't", "will not", "not going to", "unable",
        "not able", "don't have", "do not have", "there's no", "there is no",
        "i need", "need more", "let me know", "just say", "which one",
        "what would you like", "didn't catch", "not sure what", "couldn't find",
        "no developer mode",
    ];
    NONCLAIM.iter().any(|t| s.contains(t))
}

/// Run the Claude planner loop to completion. Same `LoopResult` contract as
/// `gemini::run_loop` / `openrouter::run_loop`.
pub async fn run_loop(model: &str, intent: &str, ctx: &TaskCtx) -> Result<LoopResult, String> {
    let bin = claude_bin();
    let mcp_cfg = ensure_empty_mcp_config()?;

    // ONE live session for the whole task (#1252 speed pass): turn 1 sends the
    // full planner prompt (system + tool schema + screen), follow-ups send ONLY
    // the tool result — the model keeps its context, so no per-turn re-boot and
    // no growing-transcript re-prefill. The pool hands back a warm proc that was
    // pre-booted on the Option keydown, so even turn 1 skips the CLI bootstrap.
    let mut session = super::claude_pool::acquire(&bin, model, &mcp_cfg)
        .ok_or_else(|| "claude session unavailable (spawn failed)".to_string())?;

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
    // Turn 1 carries the full planner prompt; the screenshot rides it ONCE (Opus
    // sees it then keeps it in context). Each follow-up replaces `next_message`
    // with just the tool-result block built at the loop foot.
    let mut next_message = build_first_prompt(intent, ctx);
    let mut next_image: Option<String> = ctx.screen.as_ref().map(|s| s.png_base64.clone());

    // Anti-fabrication guard state: does the request ask Symon to DO something
    // (an action, not a pure question)? If so and the loop ends `done` with ZERO
    // tools dispatched, the model is about to claim a success it never performed
    // — nudge it once (in the done branch below). Fires at most once per task.
    let action_intent = looks_like_action_request(intent);
    let mut nudged_premature_done = false;

    for _turn in 0..MAX_TURNS {
        // User interrupted (Escape / tap-to-stop) — stop before the next turn.
        // run_agent_inner sees the cancel flag and goes quiet.
        if ctx.is_cancelled() {
            break;
        }
        // Move the session into the blocking turn and get it back with the reply
        // (it must stay alive across turns). On timeout the session is lost to
        // the orphaned blocking task and reaped when that finishes — the task
        // errors out either way.
        let msg = next_message;
        let img = next_image.take();
        let mut sess = session;
        let joined = tokio::time::timeout(
            Duration::from_secs(TURN_TIMEOUT_SECS),
            tokio::task::spawn_blocking(move || {
                let r = sess.send_turn(&msg, img.as_deref());
                (sess, r)
            }),
        )
        .await
        .map_err(|_| "claude turn timed out".to_string())?
        .map_err(|e| format!("claude turn join error: {e}"))?;
        session = joined.0;
        let raw = joined.1?;

        let Some(action) = extract_action(&raw) else {
            // Not parseable as an action — take the reply as the final answer
            // rather than looping blindly.
            result_text = raw.trim().to_string();
            break;
        };

        if action.get("done").and_then(|d| d.as_bool()) == Some(true) {
            let say = action
                .get("say")
                .and_then(|s| s.as_str())
                .unwrap_or("Done.")
                .trim()
                .to_string();
            // The model said done on an ACTION request but dispatched no tool —
            // it's about to claim something it didn't do (signature-B fabrication).
            // Nudge ONCE to force a real tool call (or an honest "I can't"). Skip
            // when the say is plainly a question or refusal — those are legit
            // no-tool dones (clarification / safety refusal), not fabrications.
            if action_intent
                && tool_call_log.is_empty()
                && !nudged_premature_done
                && !say_is_question_or_refusal(&say)
            {
                nudged_premature_done = true;
                log::warn!(
                    "[symon-agent] premature done (no tool on an action request) — nudging once to prevent a fabricated success"
                );
                next_message = PREMATURE_DONE_NUDGE.to_string();
                next_image = None;
                continue;
            }
            result_text = say;
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

        // Feed ONLY the result back — the live session still holds the system
        // prompt, the tool schema, and every prior turn, so this is all the model
        // needs for the next action (no transcript re-send → smaller prefill).
        let result_str =
            serde_json::to_string(&tool_result).unwrap_or_else(|_| "{}".to_string());
        next_message = format!(
            "[SYSTEM] You called `{tool_name}`. It returned:\n{result_str}\n\n\
             Now respond with your NEXT action as a single JSON object — a tool \
             call, or {{\"done\": true, \"say\": \"...\"}} when the request is \
             fully handled."
        );
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

/// One subscription-billed, tool-free Claude turn for Smart Compose. The
/// caller owns the target transaction; this function only returns insertion
/// text and cannot execute a command or mutate the Mac.
pub(crate) fn compose_once(
    model: &str,
    prompt: &str,
    image_b64: Option<&str>,
) -> Result<String, String> {
    let bin = claude_bin();
    let mcp_cfg = ensure_empty_mcp_config()?;
    let mut session = super::claude_pool::acquire(&bin, model, &mcp_cfg)
        .ok_or_else(|| "claude session unavailable (spawn failed)".to_string())?;
    session.send_turn(prompt, image_b64)
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

    #[test]
    fn extract_action_salvages_run_ahead() {
        // The model "runs ahead" and emits the whole turn in one reply. We must
        // recover the FIRST action object (with its nested args braces intact),
        // not choke on the first..last span — otherwise the tool never dispatches
        // and the fabricated `say` is spoken as a silent false success.
        let raw = "{\"tool\": \"o8_ui_set\", \"args\": {\"key\": \"surface\", \"value\": \"solid\"}} \
                   system{\"ok\": true, \"applied\": true, \"previous\": \"glass\"} \
                   assistant{\"done\": true, \"say\": \"Done — switched to solid.\"}";
        let a = extract_action(raw).unwrap();
        assert_eq!(a.get("tool").unwrap(), "o8_ui_set");
        assert_eq!(a.get("args").unwrap().get("key").unwrap(), "surface");
        assert!(a.get("done").is_none(), "must take the first action, not the run-ahead done");
    }

    #[test]
    fn extract_action_ignores_brace_inside_string() {
        // A `}` inside a string value must not be mistaken for the object's close.
        let a = extract_action("{\"tool\":\"mac_notes_create\",\"args\":{\"body\":\"a } brace\"}}").unwrap();
        assert_eq!(a.get("tool").unwrap(), "mac_notes_create");
        assert_eq!(a.get("args").unwrap().get("body").unwrap(), "a } brace");
    }

    #[test]
    fn action_request_detects_mutations_not_questions() {
        // Mutations / actions → gated for the anti-fabrication nudge.
        assert!(looks_like_action_request("Create a reminder to call mom at 5"));
        assert!(looks_like_action_request("switch to dark mode"));
        assert!(looks_like_action_request("delete that note"));
        assert!(looks_like_action_request("schedule a meeting tomorrow"));
        assert!(looks_like_action_request("open Safari"));
        // Pure questions → never nudged (they reliably call their own tool).
        assert!(!looks_like_action_request("how many reminders do I have"));
        assert!(!looks_like_action_request("what time is it"));
        assert!(!looks_like_action_request("what's on my calendar today"));
    }

    #[test]
    fn question_or_refusal_suppresses_the_nudge() {
        // Clarifications + refusals are legit no-tool dones — must NOT be nudged.
        assert!(say_is_question_or_refusal("When should I remind you?"));
        assert!(say_is_question_or_refusal("I'm not going to do that."));
        assert!(say_is_question_or_refusal("I can't run that command."));
        assert!(say_is_question_or_refusal("There's no developer mode."));
        assert!(say_is_question_or_refusal("Which one did you mean?"));
        // A bare success claim with no tool dispatched IS a fabrication → nudge.
        assert!(!say_is_question_or_refusal("Done — I set it for tomorrow at 5 PM."));
        assert!(!say_is_question_or_refusal("All set, added to your list."));
    }
}
