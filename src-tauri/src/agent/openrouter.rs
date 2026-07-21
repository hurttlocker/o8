//! Symon voice-agent tool-calling loop — OpenRouter (OpenAI chat-completions
//! protocol). Lifted from aqua's `openrouter.rs`, de-Symonized, error type
//! switched to `String` to match o8's `gemini_ask` house style. Selected when
//! the configured model id contains `/` (e.g. `openai/gpt-4o-mini`).
//!
//! The loop: build [system, user] messages → ask the model with the full tool
//! schema → if it returns `tool_calls`, gate each on the SafetyClass confirm
//! card, dispatch it, feed the result back as a `role:"tool"` message → repeat
//! up to MAX_TURNS → the first turn with no tool_calls is the final answer.

use super::{tools, LoopResult, TaskCtx};
use serde_json::{json, Value};

const MAX_TURNS: usize = 10;
const REQUEST_TIMEOUT_SECS: u64 = 180; // 3 min per turn
const ENDPOINT: &str = "https://openrouter.ai/api/v1/chat/completions";

pub async fn run_loop(model: &str, intent: &str, ctx: &TaskCtx) -> Result<LoopResult, String> {
    let api_key = crate::stt::keys::get_openrouter_key().ok_or_else(|| {
        "Missing OPENROUTER_API_KEY — add it in Voice settings to use an OpenRouter agent model"
            .to_string()
    })?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("reqwest build failed: {e}"))?;

    // Gemini-format specs {name, description, parameters} wrap cleanly into
    // OpenAI's {type:"function", function:{...}} — `parameters` == the schema.
    let escalation = super::router::load_config().voice_escalation;
    let tools_json: Vec<Value> = tools::enabled_tools_for(&escalation)
        .iter()
        .map(|spec| json!({ "type": "function", "function": spec }))
        .collect();

    let mut system_text = super::system_prompt();
    if let Some(suffix) = super::escalation_prompt_suffix(&escalation) {
        system_text.push_str(suffix);
    }
    if let Some(convo) = super::conversation_context() {
        system_text.push_str("\n\n");
        system_text.push_str(&convo);
    }
    // Every captured screen rides a known vision model. Spatial turns add the
    // marked-region crop; ordinary screen questions still need the screenshot
    // and exact Accessibility catalog instead of silently becoming text-only.
    let screen_vision = ctx.screen.is_some() && super::model_can_see_images(model);
    if screen_vision {
        if let Some(screen) = &ctx.screen {
            system_text.push_str("\n\n");
            system_text.push_str(&super::screen_prompt_section(screen));
        }
    }
    if screen_vision && ctx.spatial {
        system_text.push_str("\n\n");
        system_text.push_str(&super::spatial_prompt_section(ctx.crop_png_base64.is_some()));
    }
    let user_msg = if screen_vision {
        let mut parts: Vec<Value> = vec![json!({ "type": "text", "text": intent })];
        if let Some(screen) = &ctx.screen {
            parts.push(json!({
                "type": "image_url",
                "image_url": { "url": format!("data:image/png;base64,{}", screen.png_base64) }
            }));
        }
        if ctx.spatial {
            if let Some(crop) = &ctx.crop_png_base64 {
                parts.push(json!({
                    "type": "image_url",
                    "image_url": { "url": format!("data:image/png;base64,{}", crop) }
                }));
            }
        }
        json!({ "role": "user", "content": parts })
    } else {
        json!({ "role": "user", "content": intent })
    };
    let mut messages: Vec<Value> = vec![
        json!({ "role": "system", "content": system_text }),
        user_msg,
    ];

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
        let body = json!({
            "model": model,
            "messages": messages,
            "tools": tools_json,
            "tool_choice": "auto",
            "temperature": 0.3,
        });

        let resp = client
            .post(ENDPOINT)
            .header("Authorization", format!("Bearer {api_key}"))
            .header("HTTP-Referer", "https://o8.run")
            .header("X-Title", "o8 Symon")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("OpenRouter request failed: {e}"))?;

        let status = resp.status();
        if !status.is_success() {
            let err_body = resp.text().await.unwrap_or_default();
            let snippet = crate::utf8_head(&err_body, 300);
            return Err(format!("OpenRouter API error ({status}): {snippet}"));
        }

        let resp_json: Value = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse OpenRouter response: {e}"))?;

        let message = resp_json
            .pointer("/choices/0/message")
            .cloned()
            .ok_or_else(|| "No message in OpenRouter response".to_string())?;

        let tool_calls = message
            .get("tool_calls")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        if tool_calls.is_empty() {
            // No tool calls — this is the final spoken answer.
            result_text = message
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            break;
        }

        // Echo the assistant message (carrying tool_calls) BEFORE the results —
        // required by the OpenAI protocol.
        messages.push(message.clone());

        for call in &tool_calls {
            let call_id = call.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let func = call.get("function").cloned().unwrap_or(json!({}));
            let tool_name = func.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
            // OpenAI passes tool arguments as a JSON-encoded STRING.
            let tool_args: Value = func
                .get("arguments")
                .and_then(|v| v.as_str())
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or_else(|| json!({}));

            if let Some(app) = ctx.app.as_ref() {
                super::emit_agent_event(
                    app,
                    json!({ "taskId": ctx.task_id, "kind": "tool_call", "tool": tool_name, "args": tool_args }),
                );
            }

            let tool_result: Value = super::execute_cascaded_tool_call(
                ctx,
                &tool_name,
                tool_args.clone(),
                &mut spoke_filler,
            )
            .await;
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

            if let Some(app) = ctx.app.as_ref() {
                super::emit_agent_event(
                    app,
                    json!({ "taskId": ctx.task_id, "kind": "tool_result", "tool": tool_name, "result": tool_result }),
                );
            }

            // OpenAI's `tool` role expects a STRING content.
            messages.push(json!({
                "role": "tool",
                "tool_call_id": call_id,
                "content": tool_result.to_string(),
            }));
        }
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
