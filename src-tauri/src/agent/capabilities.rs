//! Truthful, user-facing Symon capability discovery.
//!
//! The model schemas remain the executable contract. This module groups those
//! registered tools into jobs a person recognizes and refuses to mark a group
//! ready when a required tool is missing.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;

use super::{safety, tools};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityAvailability {
    Ready,
    SetupRequired,
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityApproval {
    ReadOnly,
    MayRequireApproval,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymonCapability {
    pub id: String,
    pub category: String,
    pub title: String,
    pub summary: String,
    pub examples: Vec<String>,
    pub tool_names: Vec<String>,
    pub availability: CapabilityAvailability,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub availability_detail: Option<String>,
    pub approval: CapabilityApproval,
}

struct CapabilitySpec {
    id: &'static str,
    category: &'static str,
    title: &'static str,
    summary: &'static str,
    examples: &'static [&'static str],
    tool_names: &'static [&'static str],
    requires_screen_recording: bool,
}

const SPECS: &[CapabilitySpec] = &[
    CapabilitySpec {
        id: "screen_guidance",
        category: "This screen",
        title: "Understand and point at your screen",
        summary: "Ask what is visible, explain an interface, or point to the next place to act.",
        examples: &[
            "What am I looking at?",
            "Show me where to change this setting.",
        ],
        tool_names: &["read_screen"],
        requires_screen_recording: true,
    },
    CapabilitySpec {
        id: "operator_attention",
        category: "o8 work",
        title: "Tell you what needs attention",
        summary: "Read the live fleet, approval queue, and work waiting on an operator decision.",
        examples: &["What needs me right now?", "What is shipping?"],
        tool_names: &["o8_needs_me", "o8_status"],
        requires_screen_recording: false,
    },
    CapabilitySpec {
        id: "governed_repository_work",
        category: "o8 work",
        title: "Start and review governed repository work",
        summary: "Dispatch bounded work, wait for the result, and inspect the diff before approval.",
        examples: &[
            "Fix the failing test in this repository.",
            "Review the current packet before I approve it.",
        ],
        tool_names: &["o8_dispatch", "o8_packet_wait", "o8_review_diff"],
        requires_screen_recording: false,
    },
    CapabilitySpec {
        id: "browser_terminal",
        category: "Tools",
        title: "Use the browser and terminal",
        summary: "Read a page, act in the browser, or control a watched terminal without leaving o8.",
        examples: &[
            "Read the page I have open and summarize it.",
            "Run the tests and tell me where they fail.",
        ],
        tool_names: &["o8_browser_read", "o8_browser_act", "term_read", "term_send"],
        requires_screen_recording: false,
    },
    CapabilitySpec {
        id: "planning_apps",
        category: "Mac apps",
        title: "Manage your calendar and reminders",
        summary: "Read or update plans with the same approval cards used for other side effects.",
        examples: &[
            "What is on my calendar tomorrow?",
            "Remind me to review the release at 4 PM.",
        ],
        tool_names: &[
            "mac_calendar_list_events",
            "mac_calendar_create_event",
            "mac_reminders_list",
            "mac_reminders_create",
        ],
        requires_screen_recording: false,
    },
    CapabilitySpec {
        id: "mail_notes",
        category: "Mac apps",
        title: "Work with Mail and Notes",
        summary: "Find mail, prepare a draft, search notes, or capture a new note.",
        examples: &[
            "Find the latest email about the release.",
            "Create a note with the decisions from this conversation.",
        ],
        tool_names: &[
            "mac_mail_search",
            "mac_mail_draft",
            "mac_notes_search",
            "mac_notes_create",
        ],
        requires_screen_recording: false,
    },
    CapabilitySpec {
        id: "messages",
        category: "Mac apps",
        title: "Send an approved message",
        summary: "Resolve one exact contact handle, show the complete text for approval, and send only after confirmation.",
        examples: &["Send a text to contact@example.com saying I'm running ten minutes late."],
        tool_names: &["mac_contacts_search", "mac_messages_send"],
        requires_screen_recording: false,
    },
    CapabilitySpec {
        id: "code_and_github",
        category: "Repositories",
        title: "Inspect code and GitHub",
        summary: "Read repository state, commits, issues, pull requests, and exact commit diffs.",
        examples: &[
            "What changed in the latest commit?",
            "Read the open pull requests for this repository.",
        ],
        tool_names: &["git_status", "repo_commit_diff", "gh_issue_list", "gh_pr_list"],
        requires_screen_recording: false,
    },
    CapabilitySpec {
        id: "skills",
        category: "Customize",
        title: "Use your saved skills",
        summary: "List and activate local instructions for recurring work without changing Symon itself.",
        examples: &["What Symon skills do I have?"],
        tool_names: &["symon_skills_list", "symon_skill_activate"],
        requires_screen_recording: false,
    },
    CapabilitySpec {
        id: "multi_step_plans",
        category: "Tools",
        title: "Handle a reviewed sequence",
        summary: "Read back a short plan, confirm it once, then run the validated steps in order.",
        examples: &[
            "Check tomorrow's calendar, create a note for the day, then tell me what needs me in o8.",
        ],
        tool_names: &["symon_execute_plan"],
        requires_screen_recording: false,
    },
];

fn registered_tool_names() -> HashSet<String> {
    tools::all_tools()
        .into_iter()
        .filter_map(|tool| tool.get("name").and_then(Value::as_str).map(str::to_string))
        .collect()
}

fn approval_for(tool_names: &[&str]) -> CapabilityApproval {
    if tool_names
        .iter()
        .any(|name| safety::tool_safety_class(name) != safety::SafetyClass::ReadOnly)
    {
        CapabilityApproval::MayRequireApproval
    } else {
        CapabilityApproval::ReadOnly
    }
}

fn build_catalog(
    available_tools: &HashSet<String>,
    screen_recording_granted: bool,
) -> Vec<SymonCapability> {
    let mut catalog = SPECS
        .iter()
        .map(|spec| {
            let missing_tools = spec
                .tool_names
                .iter()
                .filter(|name| !available_tools.contains(**name))
                .copied()
                .collect::<Vec<_>>();
            let (availability, availability_detail) = if !missing_tools.is_empty() {
                (
                    CapabilityAvailability::Unavailable,
                    Some("This build does not include every required action.".to_string()),
                )
            } else if spec.requires_screen_recording && !screen_recording_granted {
                (
                    CapabilityAvailability::SetupRequired,
                    Some(
                        "Allow Screen Recording in System Settings to use this capability."
                            .to_string(),
                    ),
                )
            } else {
                (CapabilityAvailability::Ready, None)
            };
            SymonCapability {
                id: spec.id.to_string(),
                category: spec.category.to_string(),
                title: spec.title.to_string(),
                summary: spec.summary.to_string(),
                examples: spec
                    .examples
                    .iter()
                    .map(|example| (*example).to_string())
                    .collect(),
                tool_names: spec
                    .tool_names
                    .iter()
                    .map(|name| (*name).to_string())
                    .collect(),
                availability,
                availability_detail,
                approval: approval_for(spec.tool_names),
            }
        })
        .collect::<Vec<_>>();
    catalog.sort_by_key(|capability| match capability.availability {
        CapabilityAvailability::Ready => 0,
        CapabilityAvailability::SetupRequired => 1,
        CapabilityAvailability::Unavailable => 2,
    });
    catalog
}

pub fn catalog() -> Vec<SymonCapability> {
    build_catalog(
        &registered_tool_names(),
        crate::mac_perms::screen_capture_granted_cmd(),
    )
}

pub fn catalog_json() -> Value {
    json!({ "capabilities": catalog() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_advertised_example_is_backed_by_registered_tools() {
        let available = registered_tool_names();
        assert!(available.contains("symon_capabilities"));
        assert!(crate::agent::system_prompt().contains("call `symon_capabilities`"));
        let catalog = build_catalog(&available, true);
        assert!(!catalog.is_empty());
        for capability in catalog {
            assert!(
                !capability.examples.is_empty(),
                "{} has no examples",
                capability.id
            );
            assert_eq!(
                capability.availability,
                CapabilityAvailability::Ready,
                "{} is not backed by the tool registry",
                capability.id
            );
        }
    }

    #[test]
    fn missing_tool_makes_the_capability_unavailable() {
        let mut available = registered_tool_names();
        available.remove("o8_status");
        let capability = build_catalog(&available, true)
            .into_iter()
            .find(|item| item.id == "operator_attention")
            .expect("operator attention capability");
        assert_eq!(capability.availability, CapabilityAvailability::Unavailable);
    }

    #[test]
    fn missing_screen_permission_is_a_setup_state() {
        let capability = build_catalog(&registered_tool_names(), false)
            .into_iter()
            .find(|item| item.id == "screen_guidance")
            .expect("screen guidance capability");
        assert_eq!(
            capability.availability,
            CapabilityAvailability::SetupRequired
        );
        assert!(capability.availability_detail.is_some());
    }
}
