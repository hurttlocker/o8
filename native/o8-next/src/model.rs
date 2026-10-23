//! Presentation of the existing MobileHistoryResponse. No server state is written.
use crate::{
    activity::{Step, activity},
    text::{Node, markdown},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Clone, Debug, Deserialize)]
pub struct Entry {
    pub id: String,
    pub role: String,
    pub text: String,
    #[serde(rename = "toolCalls", default)]
    pub tools: Vec<Value>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

#[derive(Debug, Deserialize)]
pub struct History {
    #[serde(rename = "sessionKey")]
    pub session_key: String,
    pub transcript: Vec<Entry>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Row {
    Message {
        id: String,
        role: String,
        nodes: Vec<Node>,
    },
    Activity {
        id: String,
        steps: Vec<Step>,
    },
}

impl Row {
    pub fn id(&self) -> &str {
        match self {
            Self::Message { id, .. } | Self::Activity { id, .. } => id,
        }
    }
}

/// The ordering/deduplication boundary in workerTranscriptBlocks. Tools preceding
/// prose form a block; a result with the same id updates its original step.
pub fn render_tree(entries: &[Entry]) -> Vec<Row> {
    let mut rows = Vec::new();
    let mut pending = Vec::new();
    let mut indices = HashMap::<String, usize>::new();
    let mut steps = Vec::<Step>::new();
    let flush = |rows: &mut Vec<Row>, pending: &mut Vec<usize>, steps: &[Step]| {
        if !pending.is_empty() {
            rows.push(Row::Activity {
                id: steps[pending[0]].id.clone(),
                steps: pending.drain(..).map(|i| steps[i].clone()).collect(),
            });
        }
    };
    // Retain step indices until all result-only updates have arrived.
    let mut blocks = Vec::<(usize, Vec<usize>)>::new();
    for entry in entries {
        for (index, tool) in entry.tools.iter().enumerate() {
            let id = tool["id"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("{}:tool:{index}", entry.id));
            let step = activity(&id, tool, &entry.text);
            if let Some(&i) = indices.get(&id) {
                if tool["args"].is_object() {
                    steps[i] = step;
                } else {
                    steps[i].status = step.status;
                    steps[i].reason = step.reason;
                }
            } else {
                indices.insert(id, steps.len());
                pending.push(steps.len());
                steps.push(step);
            }
        }
        let extras = ["media", "claudeCodeEvents"].iter().any(|key| {
            entry
                .extra
                .get(*key)
                .and_then(Value::as_array)
                .is_some_and(|v| !v.is_empty())
        });
        if entry.role != "tool" && (!entry.text.trim().is_empty() || extras) {
            if !pending.is_empty() {
                blocks.push((rows.len(), pending.clone()));
            }
            flush(&mut rows, &mut pending, &steps);
            let special = entry
                .extra
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|t| t != "message");
            let mut nodes = markdown(&entry.text);
            if special || extras {
                // Never silently discard unsupported receipts/media in this slice.
                nodes.push(Node::notice(
                    "Additional event or media details are available in the web transcript.",
                ));
            }
            rows.push(Row::Message {
                id: entry.id.clone(),
                role: entry.role.clone(),
                nodes,
            });
        }
    }
    if !pending.is_empty() {
        blocks.push((rows.len(), pending.clone()));
    }
    flush(&mut rows, &mut pending, &steps);
    for (row, ids) in blocks {
        if let Row::Activity { steps: target, .. } = &mut rows[row] {
            *target = ids.into_iter().map(|i| steps[i].clone()).collect();
        }
    }
    for row in &mut rows {
        if let Row::Activity { steps, .. } = row {
            crate::activity::group(steps);
        }
    }
    rows
}
