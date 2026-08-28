//! Send-only Messages control.
//!
//! Symon never reads Messages. A send is model-reachable only through the
//! shared per-action confirmation gate, whose card shows the exact recipient
//! and text before this dispatcher can run.

use super::{as_escape, run_applescript};
use serde_json::{json, Value};

const MAX_RECIPIENT_CHARS: usize = 320;
const MAX_MESSAGE_CHARS: usize = 10_000;

fn exact_recipient(value: &str) -> bool {
    if value.is_empty() || value.chars().count() > MAX_RECIPIENT_CHARS {
        return false;
    }
    if let Some((local, domain)) = value.split_once('@') {
        return !local.is_empty()
            && !domain.is_empty()
            && !domain.contains('@')
            && !value.chars().any(char::is_whitespace);
    }
    let digit_count = value.chars().filter(char::is_ascii_digit).count();
    (7..=15).contains(&digit_count)
        && value.chars().all(|character| {
            character.is_ascii_digit() || matches!(character, '+' | '-' | '(' | ')' | '.' | ' ')
        })
}

fn send_script(recipient: &str, message: &str) -> String {
    let recipient = as_escape(recipient);
    let message = as_escape(message);
    format!(
        r#"tell application "Messages"
    set targetService to first service whose service type = iMessage
    set targetParticipant to participant "{recipient}" of targetService
    send "{message}" to targetParticipant
    return "sent"
end tell"#
    )
}

pub async fn send(args: Value) -> Result<Value, String> {
    let recipient = args
        .get("recipient")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    if !exact_recipient(&recipient) {
        return Err(
            "recipient must be one exact phone number or email address; search Contacts first when given a name"
                .into(),
        );
    }
    let message = args
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if message.trim().is_empty() {
        return Err("message is required".into());
    }
    if message.chars().count() > MAX_MESSAGE_CHARS {
        return Err(format!(
            "message must be at most {MAX_MESSAGE_CHARS} characters"
        ));
    }

    let script = send_script(&recipient, &message);
    tokio::task::spawn_blocking(move || run_applescript(&script))
        .await
        .map_err(|error| format!("Messages task failed: {error}"))??;

    Ok(json!({ "success": true, "recipient": recipient }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recipient_must_be_an_exact_handle() {
        for valid in ["+1 (215) 555-0100", "2155550100", "person@example.com"] {
            assert!(exact_recipient(valid), "expected {valid:?} to be valid");
        }
        for invalid in ["", "my wife", "person @example.com", "555"] {
            assert!(
                !exact_recipient(invalid),
                "expected {invalid:?} to be invalid"
            );
        }
    }

    #[test]
    fn script_preserves_text_as_one_escaped_literal() {
        let script = send_script(
            "person@example.com",
            "First line\nSecond \"quoted\" line\\tail",
        );
        assert!(script.contains("participant \"person@example.com\""));
        assert!(script.contains("send \"First line\\nSecond \\\"quoted\\\" line\\\\tail\""));
        assert_eq!(script.matches("send \"").count(), 1);
    }
}
