//! Rich events use MobileTranscriptEntry metadata, never guessed text receipts.
use crate::{
    model::Entry,
    text::{Node, markdown},
};
use serde_json::Value;

pub fn packet_prompt(text: &str) -> bool {
    text.chars().count() >= 400 && regex::Regex::new(r"(?im)##\s*Project\s+(Brief|Scope|Directives)\b|(^|\n)\s*Packet:\s|(^|\n)\s*STRICT SCOPE:").unwrap().is_match(text)
}
pub fn nodes(entry: &Entry) -> Vec<Node> {
    let kind = entry
        .extra
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("message");
    let mut nodes = if matches!(kind, "handoff" | "compaction")
        && entry.extra.get(kind).is_some_and(Value::is_object)
    {
        vec![Node {
            kind: kind.into(),
            runs: vec![],
            language: None,
            data: entry.extra.get(kind).cloned(),
        }]
    } else if entry.text.is_empty() {
        vec![]
    } else {
        markdown(&entry.text)
    };
    for media in entry
        .extra
        .get("media")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        nodes.push(Node {
            kind: "media".into(),
            runs: vec![],
            language: None,
            data: Some(media.clone()),
        });
    }
    nodes
}
