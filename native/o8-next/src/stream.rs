//! Desktop sequence/capture rules + the dashboard transcript merger.
use crate::model::{Entry, History, Row, render_tree_cached};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
pub struct Replay {
    pub initial: History,
    pub frames: Vec<Value>,
}

pub struct Transcript {
    pub key: String,
    pub entries: Vec<Entry>,
    pub rows: Vec<Row>,
    pub seq: u64,
    boot: Option<String>,
}
impl Transcript {
    pub fn new(history: History) -> Self {
        let mut this = Self {
            key: history.session_key,
            entries: vec![],
            rows: vec![],
            seq: 0,
            boot: None,
        };
        this.merge(history.transcript, true);
        this
    }
    fn merge(&mut self, incoming: Vec<Entry>, replace: bool) -> bool {
        let mut next = if replace {
            incoming
        } else {
            crate::merge::entries(&self.entries, incoming)
        };
        if next.len() > 200 {
            next.drain(..next.len() - 200);
        }
        if next == self.entries {
            return false;
        }
        let rows = render_tree_cached(&next, &self.entries, &self.rows);
        self.entries = next;
        self.rows = rows;
        true
    }
    fn history(&mut self, payload: &Value) -> bool {
        if payload["sessionKey"].as_str() != Some(&self.key) {
            return false;
        }
        let Ok(entries) = serde_json::from_value::<Vec<Entry>>(payload["entries"].clone()) else {
            return false;
        };
        let replace = payload["replace"].as_bool().unwrap_or(false);
        if entries.is_empty() && !replace {
            return false;
        }
        self.merge(entries, replace)
    }
    pub fn apply(&mut self, message: &Value) -> bool {
        let data = &message["data"];
        match (message["channel"].as_str(), message["event"].as_str()) {
            (Some("system"), Some("connected")) => {
                if let Some(boot) = data["bootId"].as_str() {
                    if self.boot.as_deref().is_some_and(|old| old != boot) {
                        self.seq = 0;
                    }
                    self.boot = Some(boot.into());
                }
                false
            }
            (Some("realtime"), Some("batch")) => {
                let mut changed = false;
                if let Some(events) = data["events"].as_array() {
                    for event in events {
                        if event["stream"].as_str() != Some(&format!("session:{}", self.key)) {
                            continue;
                        }
                        let Some(seq) = event["seq"].as_u64() else {
                            continue;
                        };
                        let previous = self.seq;
                        self.seq = self.seq.max(seq);
                        if seq <= previous
                            || event["capturedSeq"].as_u64().is_some_and(|s| previous > s)
                        {
                            continue;
                        }
                        if event["event"] == "history.snapshot" {
                            changed |= self.history(&event["data"]);
                        }
                    }
                }
                changed
            }
            (Some("history"), Some("update")) => self.history(data),
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recorded_streams_match_web() {
        for case in ["stream", "stream-edges"] {
            let base = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures");
            let replay: Replay = serde_json::from_slice(
                &std::fs::read(base.join(format!("{case}.replay.json"))).unwrap(),
            )
            .unwrap();
            let mut transcript = Transcript::new(replay.initial);
            for message in replay.frames {
                transcript.apply(&message);
            }
            let expected: Value = serde_json::from_slice(
                &std::fs::read(base.join(format!("{case}.tree.json"))).unwrap(),
            )
            .unwrap();
            assert_eq!(
                serde_json::to_value(&transcript.rows).unwrap(),
                expected,
                "{case}"
            );
        }
    }
    #[test]
    fn retention_matches_web_store() {
        let mut transcript = Transcript::new(History {
            session_key: "llm-chat:test".into(),
            transcript: vec![],
        });
        let entries: Vec<Entry> = (0..205)
            .map(|i| {
                serde_json::from_value(
                    serde_json::json!({"id":i.to_string(),"role":"user","text":"x"}),
                )
                .unwrap()
            })
            .collect();
        transcript.merge(entries, true);
        assert_eq!(transcript.entries.len(), 200);
        assert_eq!(transcript.entries[0].id, "5");
    }
}
