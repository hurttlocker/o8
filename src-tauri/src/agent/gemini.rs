//! Symon voice-agent tool-calling loop — DIRECT Gemini (functionCall protocol).
//! Lifted from aqua's `providers/gemini.rs`, de-Symonized: direct Google API
//! only (no license proxy), `String` errors, o8's `get_gemini_key`. Selected
//! when the configured model id has no `/` (e.g. `gemini-3-flash-preview`).
//!
//! This is the V1 default — o8 already holds a working Gemini key for the Ask
//! path, so the loop runs with zero extra setup and no OpenRouter credits.

use super::{tools, LoopResult, TaskCtx};
use serde_json::{json, Value};

const MAX_TURNS: usize = 10;
const REQUEST_TIMEOUT_SECS: u64 = 60;

pub async fn run_loop(model: &str, intent: &str, ctx: &TaskCtx) -> Result<LoopResult, String> {
    let api_key = crate::stt::keys::get_gemini_key()
        .ok_or_else(|| "Missing GEMINI_API_KEY for the Symon agent".to_string())?;
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("reqwest build failed: {e}"))?;

    let tool_specs = tools::enabled_tools();

    // Gemini folds the system prompt into the first user turn (matches
    // gemini_ask.rs — avoids systemInstruction shape uncertainty). When the
    // task carries screen context (dossier #2), the screenshot rides the same
    // turn as inline_data and the prompt gains the POINT-tag teaching section.
    let mut first_parts: Vec<Value> = Vec::new();
    let mut first_text = super::system_prompt();
    if let Some(convo) = super::conversation_context() {
        first_text.push_str("\n\n");
        first_text.push_str(&convo);
    }
    if let Some(screen) = &ctx.screen {
        first_text.push_str("\n\n");
        first_text.push_str(&super::screen_prompt_section(screen.img_w, screen.img_h));
    }
    if let Some(edit) = &ctx.edit {
        first_text.push_str("\n\n");
        first_text.push_str(&super::edit_prompt_section(edit));
    }
    first_text.push_str(&format!("\n\nUser request: {intent}"));
    first_parts.push(json!({ "text": first_text }));
    if let Some(screen) = &ctx.screen {
        first_parts.push(json!({
            "inline_data": { "mime_type": "image/png", "data": screen.png_base64 }
        }));
    }
    let mut contents: Vec<Value> = vec![json!({ "role": "user", "parts": first_parts })];

    let mut tool_call_log: Vec<Value> = Vec::new();
    let mut result_text = String::new();
    // Spoken-filler latch — "Let me check." before the first read tool runs.
    let mut spoke_filler = false;

    for _turn in 0..MAX_TURNS {
        let body = json!({
            "contents": contents,
            "tools": [{ "function_declarations": tool_specs }],
            "generationConfig": { "temperature": 0.3, "maxOutputTokens": 2048 },
        });

        let resp = client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Gemini request failed: {e}"))?;

        let status = resp.status();
        if !status.is_success() {
            let err_body = resp.text().await.unwrap_or_default();
            let snippet = crate::utf8_head(&err_body, 300);
            return Err(format!("Gemini API error ({status}): {snippet}"));
        }

        let resp_json: Value = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse Gemini response: {e}"))?;

        let candidate = resp_json
            .pointer("/candidates/0/content")
            .cloned()
            .ok_or_else(|| "No candidate in Gemini response".to_string())?;

        // Echo the model's turn back into history before the tool results.
        contents.push(json!({ "role": "model", "parts": candidate["parts"].clone() }));

        let parts = candidate["parts"].as_array().cloned().unwrap_or_default();
        let mut function_responses: Vec<Value> = Vec::new();
        let mut has_function_calls = false;

        for part in &parts {
            if let Some(fc) = part.get("functionCall") {
                has_function_calls = true;
                let tool_name = fc.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let tool_args = fc.get("args").cloned().unwrap_or(json!({}));

                super::emit_agent_event(
                    &ctx.app,
                    json!({ "taskId": ctx.task_id, "kind": "tool_call", "tool": tool_name, "args": tool_args }),
                );

                let tool_result: Value =
                    if !super::confirm_if_needed(ctx, &tool_name, &tool_args).await {
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
                // Logged AFTER the result so the ledger records the outcome —
                // the glint derivation (remembered / recovered) reads `ok`.
                tool_call_log.push(json!({
                    "tool": tool_name,
                    "args": tool_args,
                    "ok": tool_result.get("error").is_none(),
                }));

                super::emit_agent_event(
                    &ctx.app,
                    json!({ "taskId": ctx.task_id, "kind": "tool_result", "tool": tool_name, "result": tool_result }),
                );

                function_responses.push(json!({
                    "functionResponse": { "name": tool_name, "response": tool_result }
                }));
            } else if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                if !text.trim().is_empty() {
                    result_text = text.trim().to_string();
                }
            }
        }

        if has_function_calls {
            contents.push(json!({ "role": "user", "parts": function_responses }));
            continue;
        }

        // No tool calls this turn. If the model also produced no text and no
        // tools ran at any point, this is a failed/blocked response (safety
        // block, empty candidate) — surface it instead of letting the loop
        // fall through to a false "Done."
        if result_text.is_empty() && tool_call_log.is_empty() {
            let finish = resp_json
                .pointer("/candidates/0/finishReason")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            let block = resp_json
                .pointer("/promptFeedback/blockReason")
                .and_then(|v| v.as_str());
            return Err(match block {
                Some(reason) => {
                    format!("Gemini returned no answer (blocked: {reason}, finishReason: {finish})")
                }
                None => format!("Gemini returned no answer (finishReason: {finish})"),
            });
        }
        break;
    }

    if result_text.is_empty() {
        result_text = "Done.".to_string();
    }

    Ok(LoopResult {
        result_text,
        model_used: model.to_string(),
        tool_calls_json: Value::Array(tool_call_log).to_string(),
    })
}
