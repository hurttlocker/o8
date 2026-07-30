//! Pre-read cleanup for tauri-plugin-window-state.
//!
//! Symon's overlay frames are derived from live monitor geometry and must
//! never participate in the plugin's physical-pixel persistence round trip.

pub const DERIVED_OVERLAY_WINDOW_LABELS: &[&str] = &["dock", "agent-partials", "spatial-ink"];

#[derive(Debug, Eq, PartialEq)]
pub enum SanitizedWindowState {
    Unchanged,
    Rewrite(String),
    Discard,
}

pub fn sanitize_window_state_json(content: &str) -> SanitizedWindowState {
    let Ok(mut json) = serde_json::from_str::<serde_json::Value>(content) else {
        return SanitizedWindowState::Discard;
    };
    let Some(windows) = json.as_object_mut() else {
        return SanitizedWindowState::Discard;
    };
    if !windows.contains_key("main") {
        return SanitizedWindowState::Discard;
    }

    let mut changed = false;
    for label in DERIVED_OVERLAY_WINDOW_LABELS {
        changed |= windows.remove(*label).is_some();
    }
    if !changed {
        return SanitizedWindowState::Unchanged;
    }

    match serde_json::to_string(&json) {
        Ok(cleaned) => SanitizedWindowState::Rewrite(cleaned),
        Err(_) => SanitizedWindowState::Discard,
    }
}

#[cfg(test)]
mod tests {
    use super::{sanitize_window_state_json, SanitizedWindowState};

    #[test]
    fn strips_poisoned_overlays_and_preserves_main() {
        let poisoned = serde_json::json!({
            "main": {
                "x": 100,
                "y": 80,
                "width": 2520,
                "height": 1800
            },
            "dock": {
                "width": 8320,
                "height": 1920
            },
            "agent-partials": {
                "width": 6560,
                "height": 1760
            },
            "spatial-ink": {
                "width": 102400,
                "height": 76800
            }
        })
        .to_string();

        let SanitizedWindowState::Rewrite(cleaned) = sanitize_window_state_json(&poisoned) else {
            panic!("poisoned state should be rewritten");
        };
        let value: serde_json::Value = serde_json::from_str(&cleaned).unwrap();
        assert_eq!(value["main"]["width"], 2520);
        assert_eq!(value["main"]["height"], 1800);
        assert!(value.get("dock").is_none());
        assert!(value.get("agent-partials").is_none());
        assert!(value.get("spatial-ink").is_none());
        assert_eq!(
            sanitize_window_state_json(&cleaned),
            SanitizedWindowState::Unchanged
        );
    }

    #[test]
    fn clean_state_is_unchanged() {
        let clean = r#"{"main":{"x":100,"y":80,"width":2520,"height":1800}}"#;
        assert_eq!(
            sanitize_window_state_json(clean),
            SanitizedWindowState::Unchanged
        );
    }

    #[test]
    fn malformed_state_is_discarded_like_the_existing_hook() {
        assert_eq!(
            sanitize_window_state_json("{not json"),
            SanitizedWindowState::Discard
        );
        assert_eq!(
            sanitize_window_state_json(r#"{"dock":{"width":8320}}"#),
            SanitizedWindowState::Discard
        );
    }
}
