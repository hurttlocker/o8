//! Delivery-only prototype: TypeScript remains the authority for stamped envelopes.
use serde_json::{json, Value};
use std::collections::VecDeque;
use tokio::sync::{broadcast, Mutex};

#[cfg(feature = "experimental-ws")]
pub mod websocket;

#[cfg(feature = "experimental-mcp")]
pub mod mcp;

struct State {
    latest: u64,
    log: VecDeque<Value>,
}

pub struct EventBus {
    epoch: String,
    limit: usize,
    state: Mutex<State>,
    live: broadcast::Sender<Vec<Value>>,
}

pub struct Replay {
    pub events: Vec<Value>,
    pub gap: Option<Value>,
    pub latest: u64,
}

impl EventBus {
    pub fn new(epoch: String, limit: usize) -> Self {
        let (live, _) = broadcast::channel(limit.max(4));
        Self {
            epoch,
            limit: limit.max(4),
            state: Mutex::new(State {
                latest: 0,
                log: VecDeque::new(),
            }),
            live,
        }
    }

    pub fn epoch(&self) -> &str {
        &self.epoch
    }

    pub fn listen(&self) -> broadcast::Receiver<Vec<Value>> {
        self.live.subscribe()
    }

    pub async fn latest(&self) -> u64 {
        self.state.lock().await.latest
    }

    /// Atomic producer batch. Never stamps payloads, reads accounts, or executes commands.
    pub async fn publish(&self, events: Vec<Value>) -> Result<(), &'static str> {
        let mut state = self.state.lock().await;
        let mut previous = state.latest;
        for event in &events {
            let seq = event["seq"].as_u64().ok_or("invalid seq")?;
            let stream = event["stream"].as_str().ok_or("invalid stream")?;
            if seq <= previous
                || event["protocol"] != 1
                || !(stream == "global" || stream.starts_with("session:"))
                || !event["channel"].is_string()
                || !event["event"].is_string()
                || !event["ts"].is_string()
                || event.get("data").is_none()
            {
                return Err("invalid producer envelope");
            }
            previous = seq;
        }
        state.latest = previous;
        for event in &events {
            if event["delivery"] != "bootstrap" {
                state.log.push_back(event.clone());
            }
        }
        while state.log.len() > self.limit {
            state.log.pop_front();
        }
        // Send under the same lock so publication and replay cannot reorder the log.
        let public = events
            .into_iter()
            .filter(|event| event["delivery"] != "bootstrap")
            .collect::<Vec<_>>();
        if !public.is_empty() {
            let _ = self.live.send(public);
        }
        Ok(())
    }

    pub async fn replay(&self, stream: &str, since: Option<f64>, epoch: Option<&str>) -> Replay {
        let state = self.state.lock().await;
        let cursor = since.unwrap_or(0.0);
        let earliest = state
            .log
            .iter()
            .find(|event| event["stream"] == stream)
            .and_then(|event| event["seq"].as_u64());
        let gap = since.is_some()
            && (epoch != Some(self.epoch())
                || cursor > state.latest as f64
                || (cursor > 0.0 && earliest.is_none_or(|seq| cursor < seq as f64 - 1.0)));
        Replay {
            events: if gap {
                vec![]
            } else {
                state
                    .log
                    .iter()
                    .filter(|event| {
                        event["stream"] == stream
                            && event["seq"].as_u64().unwrap_or(0) as f64 > cursor
                    })
                    .cloned()
                    .collect()
            },
            gap: gap.then(|| {
                json!({"requestedSince": cursor,
                "earliestAvailable": earliest.unwrap_or(state.latest + 1)})
            }),
            latest: state.latest,
        }
    }
}
