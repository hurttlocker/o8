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

/// Shared keep-alive HTTP client — built once and reused across calls so each
/// Gemini request (vision / front-brain) skips a fresh TLS handshake.
/// `reqwest::Client` is internally Arc'd, so cloning is cheap. (#1252 speed pass)
fn http_client() -> reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
                .build()
                .unwrap_or_default()
        })
        .clone()
}

pub async fn run_loop(model: &str, intent: &str, ctx: &TaskCtx) -> Result<LoopResult, String> {
    // local Gemini key → direct Google; else an active o8 plan → managed proxy.
    let target = crate::entitlement::resolve_gemini(model).ok_or_else(|| {
        "Symon's agent needs a Gemini key or an active o8 plan — add a key or sign in to o8"
            .to_string()
    })?;

    let client = http_client();

    let escalation = super::router::load_config().voice_escalation;
    let tool_specs = tools::enabled_tools_for(&escalation);

    // Gemini folds the system prompt into the first user turn (matches
    // gemini_ask.rs — avoids systemInstruction shape uncertainty). When the
    // task carries screen context (dossier #2), the screenshot rides the same
    // turn as inline_data and the prompt gains the POINT-tag teaching section.
    let mut first_parts: Vec<Value> = Vec::new();
    let mut first_text = super::system_prompt();
    if let Some(suffix) = super::escalation_prompt_suffix(&escalation) {
        first_text.push_str(suffix);
    }
    if let Some(convo) = super::conversation_context() {
        first_text.push_str("\n\n");
        first_text.push_str(&convo);
    }
    if let Some(screen) = &ctx.screen {
        first_text.push_str("\n\n");
        first_text.push_str(&super::screen_prompt_section(screen.img_w, screen.img_h));
    }
    // Symon Spatial Context: teach the two-image + "this/here = marked region"
    // scaffold when the operator drew on the screen this turn.
    if ctx.spatial {
        first_text.push_str("\n\n");
        first_text.push_str(&super::spatial_prompt_section(ctx.crop_png_base64.is_some()));
    }
    if let Some(edit) = &ctx.edit {
        first_text.push_str("\n\n");
        first_text.push_str(&super::edit_prompt_section(edit));
    }
    first_text.push_str(&format!("\n\nUser request: {intent}"));
    first_parts.push(json!({ "text": first_text }));
    if let Some(screen) = &ctx.screen {
        // Image 1 — full screen (composite with strokes burned in on a spatial turn).
        first_parts.push(json!({
            "inline_data": { "mime_type": "image/png", "data": screen.png_base64 }
        }));
    }
    // Image 2 — full-res close-up of the marked region (spatial turn only).
    if ctx.spatial {
        if let Some(crop) = &ctx.crop_png_base64 {
            first_parts.push(json!({
                "inline_data": { "mime_type": "image/png", "data": crop }
            }));
        }
    }
    let mut contents: Vec<Value> = vec![json!({ "role": "user", "parts": first_parts })];

    let mut tool_call_log: Vec<Value> = Vec::new();
    let mut brain_sources: Vec<Value> = Vec::new();
    let mut result_text = String::new();
    // Spoken-filler latch — "Let me check." before the first read tool runs.
    let mut spoke_filler = false;

    for _turn in 0..MAX_TURNS {
        // User interrupted (Escape / tap-to-stop) — stop before the next model
        // call. run_agent_inner sees the cancel flag and goes quiet.
        if ctx.is_cancelled() {
            break;
        }
        let mut body = json!({
            "contents": contents,
            "tools": [{ "function_declarations": tool_specs }],
            "generationConfig": { "temperature": 0.3, "maxOutputTokens": 2048 },
        });

        let req = match &target {
            crate::entitlement::GeminiTarget::Direct { url, api_key } => client
                .post(url)
                .header("x-goog-api-key", api_key)
                .json(&body),
            crate::entitlement::GeminiTarget::Proxy { url, token } => {
                // The proxy owns the model in the URL — pass it in the body.
                body["model"] = json!(model);
                client.post(url).bearer_auth(token).json(&body)
            }
        };
        let resp = req
            .send()
            .await
            .map_err(|e| format!("Gemini request failed: {e}"))?;

        let status = resp.status();
        if !status.is_success() {
            let err_body = resp.text().await.unwrap_or_default();
            let snippet = crate::utf8_head(&err_body, 200);
            // Say WHY, not just the code, and whether it's the user's OWN key
            // (Direct) or the o8 managed plan (Proxy). The bare "API error 401"
            // left operators with no next step — Sydney hit exactly this and
            // couldn't tell if it was her key, the model, or her plan. (2026-06-22)
            let via = match &target {
                crate::entitlement::GeminiTarget::Direct { .. } => "your Gemini API key",
                crate::entitlement::GeminiTarget::Proxy { .. } => "your o8 plan (managed inference)",
            };
            let hint = match status.as_u16() {
                401 | 403 => format!(
                    "{via} was rejected — it's invalid or has no access to model `{model}`. Open Settings → Voice and check the Gemini key, or check your o8 plan."
                ),
                404 => format!(
                    "model `{model}` isn't available to {via}. Set a different model in ~/.o8/agent_models.json."
                ),
                429 => format!("{via} is rate-limited — wait a moment, or add billing in Google AI Studio."),
                500..=599 => "Gemini had a server error — try again shortly.".to_string(),
                _ => format!("{via} rejected the request."),
            };
            return Err(format!("Symon agent couldn't reach Gemini ({status}): {hint} [{snippet}]"));
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
        brain_sources,
    })
}

/// One-shot Gemini VISION call — no tools, no loop. Given a PNG (base64) and an
/// extract prompt, returns the model's text. This is how the text-only Claude
/// background brain (and any caller) gets SIGHT: the `read_screen` tool routes a
/// screenshot through here. Reuses `resolve_gemini` so it honors the user's
/// Direct key or the managed o8-plan proxy exactly like the front-brain loop.
pub async fn vision_extract(model: &str, prompt: &str, png_base64: &str) -> Result<String, String> {
    let target = crate::entitlement::resolve_gemini(model).ok_or_else(|| {
        "Reading the screen needs a Gemini key or an active o8 plan — add a key or sign in to o8"
            .to_string()
    })?;

    let client = http_client();

    let mut body = json!({
        "contents": [{
            "role": "user",
            "parts": [
                { "text": prompt },
                { "inline_data": { "mime_type": "image/png", "data": png_base64 } }
            ]
        }],
        "generationConfig": { "temperature": 0.2, "maxOutputTokens": 1024 },
    });

    let req = match &target {
        crate::entitlement::GeminiTarget::Direct { url, api_key } => client
            .post(url)
            .header("x-goog-api-key", api_key)
            .json(&body),
        crate::entitlement::GeminiTarget::Proxy { url, token } => {
            body["model"] = json!(model);
            client.post(url).bearer_auth(token).json(&body)
        }
    };

    let resp = req
        .send()
        .await
        .map_err(|e| format!("Gemini vision request failed: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let err_body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "Gemini vision error ({status}): {}",
            crate::utf8_head(&err_body, 300)
        ));
    }

    let resp_json: Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse Gemini vision response: {e}"))?;

    // Concatenate every text part (Gemini may split a long read).
    let text = resp_json
        .pointer("/candidates/0/content/parts")
        .and_then(|v| v.as_array())
        .map(|parts| {
            parts
                .iter()
                .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
        .trim()
        .to_string();

    if text.is_empty() {
        let finish = resp_json
            .pointer("/candidates/0/finishReason")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        return Err(format!(
            "Gemini returned no text from the screen (finishReason: {finish})"
        ));
    }
    Ok(text)
}
