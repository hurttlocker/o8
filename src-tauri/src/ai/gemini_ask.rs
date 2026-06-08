//! Gemini "Ask" transport (voice P4 phase C, ported from aqua/Symon
//! `ai/gemini_ask.rs`, de-Symonized to the DIRECT Gemini path only — no proxy,
//! no license token, no cards/streaming). Asks one question, returns the answer.
//!
//! Gemini ONLY — NEVER Anthropic (the billing rule: Anthropic is reachable only
//! via the Claude REPL spawn, never a direct provider call from o8's backend).

use serde::Deserialize;

/// Direct-key model (goes straight into the URL). Matches aqua's DIRECT_MODEL.
const DIRECT_MODEL: &str = "gemini-3.1-pro-preview";
const MAX_OUTPUT_TOKENS: u32 = 2048;

const SYSTEM_PROMPT: &str = "You are o8, a compact macOS assistant for answering questions about the user's current screen, selection, and recent context.\n\
\n\
Use only the context provided in this request. Do not imply you can see, read, or control anything that was not provided.\n\
\n\
What you can do:\n\
- Explain what is visible on screen or in selected text\n\
- Answer follow-up questions using the recent context\n\
- Help summarize, compare, rewrite, troubleshoot, or identify the next obvious step\n\
\n\
What you CANNOT do:\n\
- Execute commands or scripts\n\
- Write, create, or modify files\n\
- Open applications\n\
- Type into or control other windows\n\
- Access the internet\n\
- Read file contents that are not on screen or included in the prompt\n\
\n\
Style: concise, direct, and practical. Prefer 1-4 short paragraphs or a tight list. No marketing language, no provider/model names, no \"I'd be happy to\". The answer will be SPOKEN ALOUD, so avoid markdown, code fences, and long lists. If the user asks for an action you cannot perform, say that plainly and give the closest useful instruction.";

#[derive(Deserialize)]
struct GeminiResponse {
    candidates: Option<Vec<GeminiCandidate>>,
}

#[derive(Deserialize)]
struct GeminiCandidate {
    content: GeminiContent,
}

#[derive(Deserialize)]
struct GeminiContent {
    parts: Vec<GeminiPart>,
}

#[derive(Deserialize)]
struct GeminiPart {
    text: Option<String>,
}

/// Ask Gemini a question (direct). `context` is optional extra system context
/// (selection / on-screen text) appended to the base prompt. Returns the
/// answer text, or an error string.
pub async fn ask(question: &str, context: Option<&str>) -> Result<String, String> {
    let api_key = crate::stt::keys::get_gemini_key()
        .ok_or_else(|| "Missing GEMINI_API_KEY for Ask".to_string())?;

    // Fold the system prompt + optional context + question into a single user
    // turn (avoids systemInstruction API-shape uncertainty; matches aqua's
    // prepend-context approach).
    let mut prompt = SYSTEM_PROMPT.to_string();
    if let Some(ctx) = context {
        let ctx = ctx.trim();
        if !ctx.is_empty() {
            prompt.push_str("\n\n[On-screen context]\n");
            prompt.push_str(ctx);
        }
    }
    prompt.push_str("\n\n---\n\nQuestion: ");
    prompt.push_str(question.trim());

    let body = serde_json::json!({
        "contents": [{ "role": "user", "parts": [{ "text": prompt }] }],
        "generationConfig": {
            "maxOutputTokens": MAX_OUTPUT_TOKENS,
            "temperature": 0.3
        }
    });

    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{DIRECT_MODEL}:generateContent?key={api_key}"
    );

    let response = reqwest::Client::new()
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Ask request failed: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let snippet = &body[..body.len().min(300)];
        return Err(format!("Ask API error ({status}): {snippet}"));
    }

    let result: GeminiResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Ask response: {e}"))?;

    let answer = result
        .candidates
        .as_ref()
        .and_then(|c| c.first())
        .map(|cand| {
            cand.content
                .parts
                .iter()
                .filter_map(|p| p.text.clone())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();

    if answer.trim().is_empty() {
        return Err("Ask returned an empty response".to_string());
    }
    Ok(answer)
}
