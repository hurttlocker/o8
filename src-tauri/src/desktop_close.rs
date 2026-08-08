#[cfg(any(target_os = "windows", target_os = "linux"))]
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DesktopClosePreference {
    Ask,
    Background,
    Quit,
}

impl DesktopClosePreference {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "ask" => Some(Self::Ask),
            "background" => Some(Self::Background),
            "quit" => Some(Self::Quit),
            _ => None,
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::Background => "background",
            Self::Quit => "quit",
        }
    }
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopCloseRequest {
    pub(crate) working_count: Option<usize>,
}

/// Count lanes whose worker may still be producing work or waiting for a
/// response. Review-only, failed, paused, idle, and completed lanes are durable
/// state and do not justify keeping a windowless desktop process alive.
pub(crate) fn working_lane_count(body: &str) -> Option<usize> {
    let json = serde_json::from_str::<serde_json::Value>(body).ok()?;
    let lanes = json.get("lanes")?.as_array()?;
    Some(
        lanes
            .iter()
            .filter(|lane| {
                matches!(
                    lane.get("status").and_then(|status| status.as_str()),
                    Some(
                        "launching"
                            | "running"
                            | "awaiting_input"
                            | "awaiting_orchestrator"
                            | "awaiting_human"
                            | "recovering"
                            | "merging"
                    )
                )
            })
            .count(),
    )
}

#[cfg(test)]
mod tests {
    use super::{working_lane_count, DesktopClosePreference};

    #[test]
    fn close_preferences_round_trip() {
        for value in ["ask", "background", "quit"] {
            let preference = DesktopClosePreference::parse(value).expect("valid preference");
            assert_eq!(preference.as_str(), value);
        }
        assert_eq!(DesktopClosePreference::parse("silently-hide"), None);
    }

    #[test]
    fn counts_only_workers_that_can_still_be_live() {
        let body = serde_json::json!({
            "lanes": [
                { "status": "running" },
                { "status": "awaiting_input" },
                { "status": "recovering" },
                { "status": "reviewing" },
                { "status": "paused" },
                { "status": "failed" }
            ]
        })
        .to_string();
        assert_eq!(working_lane_count(&body), Some(3));
    }

    #[test]
    fn malformed_lane_payload_is_unknown_instead_of_zero() {
        assert_eq!(working_lane_count("not-json"), None);
        assert_eq!(working_lane_count(r#"{"ok":true}"#), None);
    }
}
