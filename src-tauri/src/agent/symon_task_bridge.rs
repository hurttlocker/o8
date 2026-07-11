//! Best-effort delivery of background Claude task completions to phone Symon.
//!
//! The task ledger and dock event remain authoritative. This small internal
//! bridge only adds a live-phone notification when ws-server has an active
//! `symon` session to receive it.

use serde_json::json;
use std::time::Duration;

const SPOKEN_RESULT_LIMIT: usize = 600;

pub async fn send_task_complete(task_id: &str, status: &str, intent_text: &str, result_text: &str) {
    let (result_text, truncated) = truncate_for_speech(result_text);
    let port = std::env::var("O8_WS_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .or_else(|| {
            std::fs::read_to_string(super::agent_data_dir().join("ws-port"))
                .ok()
                .and_then(|value| value.trim().parse::<u16>().ok())
        })
        .unwrap_or(47105);
    let token =
        std::fs::read_to_string(super::agent_data_dir().join("ws-token")).unwrap_or_default();
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            log::warn!("[symon-agent] task completion bridge client failed: {error}");
            return;
        }
    };
    let response = client
        .post(format!("http://127.0.0.1:{port}/symon-task-complete"))
        .bearer_auth(token.trim())
        .json(&json!({
            "taskId": task_id,
            "status": status,
            "intentText": intent_text,
            "resultText": result_text,
            "truncated": truncated,
        }))
        .send()
        .await;
    match response {
        Ok(response) if response.status().is_success() => {}
        Ok(response) => log::warn!(
            "[symon-agent] task completion bridge returned {}",
            response.status()
        ),
        Err(error) => log::warn!("[symon-agent] task completion bridge failed: {error}"),
    }
}

fn truncate_for_speech(text: &str) -> (String, bool) {
    let mut chars = text.chars();
    let spoken: String = chars.by_ref().take(SPOKEN_RESULT_LIMIT).collect();
    if chars.next().is_none() {
        return (spoken, false);
    }
    (format!("{spoken}…"), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncates_at_a_unicode_character_boundary() {
        let input = "é".repeat(SPOKEN_RESULT_LIMIT + 1);
        let (text, truncated) = truncate_for_speech(&input);
        assert!(truncated);
        assert_eq!(text.chars().count(), SPOKEN_RESULT_LIMIT + 1);
        assert!(text.ends_with('…'));
    }
}
