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
    let tools_json: Vec<Value> = tools::enabled_tools()
        .iter()
        .map(|spec| json!({ "type": "function", "function": spec }))
        .collect();

    let mut messages: Vec<Value> = vec![
        json!({ "role": "system", "content": super::system_prompt() }),
        json!({ "role": "user", "content": intent }),
    ];

    let mut tool_call_log: Vec<Value> = Vec::new();
    let mut result_text = String::new();
    // Spoken-filler latch — "Let me check." before the first read tool runs.
    let mut spoke_filler = false;

    for _turn in 0..MAX_TURNS {
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
    })
}
