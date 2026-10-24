use crate::client::Session;
use serde::Serialize;

// Same attention bands as desktop/repo-focus/tabs/chats/sections.ts.
pub fn rank(s: &Session) -> u8 {
    let status = s.status.trim().to_lowercase();
    let outcome = s.outcome.as_deref().unwrap_or("").trim().to_lowercase();
    let outcome = outcome.as_str();
    match status.as_str() {
        "blocked" | "error" | "failed" | "recovering" => 5,
        _ if s.rejected || status == "rejected" => 4,
        "awaiting_human" | "awaiting_input" | "input" | "waiting" => 3,
        _ if outcome == "asked" => 3,
        "approval" | "awaiting_review" | "review" | "reviewing" => 2,
        _ if outcome == "pr_opened" => 2,
        _ if s.unread
            && (matches!(status.as_str(), "merged" | "released" | "completed")
                || matches!(outcome, "merged" | "no_changes" | "discarded")) =>
        {
            1
        }
        _ => 0,
    }
}
pub fn working(s: &Session) -> bool {
    s.outcome.is_none()
        && matches!(
            s.status.as_str(),
            "running" | "working" | "active" | "launching" | "merging" | "huddling"
        )
}
#[derive(Debug, Serialize, PartialEq)]
pub struct SidebarRow {
    pub id: String,
    pub title: String,
    pub status: String,
    pub selected: bool,
}
#[derive(Debug, Serialize, PartialEq)]
pub struct Group {
    pub kind: &'static str,
    pub rows: Vec<SidebarRow>,
}
pub fn tree(sessions: &[Session], selected: Option<&str>) -> Vec<Group> {
    ["working", "review", "recent"]
        .into_iter()
        .filter_map(|kind| {
            let mut rows: Vec<_> = sessions
                .iter()
                .filter(|s| {
                    (if rank(s) > 0 {
                        "review"
                    } else if working(s) {
                        "working"
                    } else {
                        "recent"
                    }) == kind
                })
                .collect();
            // The HTTP contract emits normalized UTC ISO timestamps. Stable ties
            // retain server order, as Array.sort does in the web sidebar.
            rows.sort_by(|a, b| {
                (if kind == "review" {
                    rank(b).cmp(&rank(a))
                } else {
                    std::cmp::Ordering::Equal
                })
                .then_with(|| b.last_message_at.cmp(&a.last_message_at))
            });
            (!rows.is_empty()).then(|| Group {
                kind,
                rows: rows
                    .into_iter()
                    .map(|s| SidebarRow {
                        id: s.id.clone(),
                        title: s.title.clone(),
                        status: s.status.clone(),
                        selected: selected == Some(&s.id),
                    })
                    .collect(),
            })
        })
        .collect()
}
