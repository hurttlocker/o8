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
    pub page: Option<crate::model::Page>,
    backfilled: bool,
    boot: Option<String>,
}
impl Transcript {
    /// HTTP send receipts can expose a persisted operator echo before the next
    /// WebSocket batch. Merge only operators so an older HTTP snapshot cannot
    /// overwrite newer streamed agent content or advance its sequence fence.
    pub fn operator_echoes(&mut self, history: History) -> bool {
        if history.session_key != self.key {
            return false;
        }
        let mut next = self.entries.clone();
        for entry in history
            .transcript
            .into_iter()
            .filter(|entry| entry.role == "user")
        {
            if next.iter().any(|current| current.id == entry.id) {
                continue;
            }
            let timestamp = entry.extra.get("timestamp").and_then(Value::as_f64);
            let index = timestamp
                .and_then(|timestamp| {
                    next.iter().position(|current| {
                        current
                            .extra
                            .get("timestamp")
                            .and_then(Value::as_f64)
                            .is_some_and(|time| time > timestamp)
                    })
                })
                .unwrap_or(next.len());
            next.insert(index, entry);
        }
        self.merge(next, true)
    }
    pub fn new(history: History) -> Self {
        let mut this = Self {
            key: history.session_key,
            entries: vec![],
            rows: vec![],
            seq: 0,
            page: history.page,
            backfilled: false,
            boot: None,
        };
        this.merge(history.transcript, true);
        this
    }
    fn merge(&mut self, incoming: Vec<Entry>, replace: bool) -> bool {
        let prefix = if self.backfilled && !replace {
            incoming
                .first()
                .and_then(|first| self.entries.iter().position(|entry| entry.id == first.id))
                .map(|index| self.entries[..index].to_vec())
                .unwrap_or_else(|| self.entries.clone())
        } else {
            vec![]
        };
        let mut next = if replace {
            incoming
        } else {
            crate::merge::entries(&self.entries, incoming)
        };
        if self.backfilled && !replace {
            let mut retained = prefix;
            retained.retain(|entry| !next.iter().any(|current| current.id == entry.id));
            retained.extend(next);
            next = retained;
        } else if !self.backfilled && next.len() > 200 {
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
    pub fn prepend(&mut self, history: History) -> bool {
        if history.session_key != self.key {
            return false;
        }
        self.page = history.page;
        let mut next = history.transcript;
        next.retain(|entry| !self.entries.iter().any(|current| current.id == entry.id));
        next.extend(self.entries.clone());
        self.backfilled = true;
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
        let overlaps = entries
            .iter()
            .any(|entry| self.entries.iter().any(|current| current.id == entry.id));
        if replace && !overlaps {
            self.backfilled = false;
            self.page = None;
        }
        if entries.is_empty() && !replace {
            return false;
        }
        // A bootstrap/reconnect checkpoint replaces its live window. Earlier
        // explicitly loaded pages remain outside that window while ids overlap.
        self.merge(entries, replace && !(self.backfilled && overlaps))
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
            page: None,
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
