//! Opt-in shared-credential delivery surface. No device authentication or command execution.
use crate::EventBus;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::{
    accept_hdr_async,
    tungstenite::{
        handshake::server::{Request, Response},
        http::StatusCode,
        Message,
    },
    WebSocketStream,
};
use uuid::Uuid;

#[derive(Clone)]
pub struct ServerConfig {
    pub token: String,
    pub instance_id: String,
    pub boot_id: String,
    pub server_version: String,
    /// TypeScript-produced legacy initial envelopes; no Rust snapshot generation.
    pub initial: Vec<Value>,
}

struct Subscription {
    stream: String,
    watermark: u64,
}

fn features(message: &Value) -> Vec<String> {
    message["capabilities"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|feature| feature.as_str() == Some("mobile-inbox-delta-v1"))
        .map(|_| "mobile-inbox-delta-v1".into())
        .collect()
}

fn visible(event: &Value, selected: &[String]) -> bool {
    let capable = selected
        .iter()
        .any(|feature| feature == "mobile-inbox-delta-v1");
    match event["audience"].as_str() {
        Some("mobile-inbox-legacy") => !capable,
        Some("mobile-inbox-delta-v1") => capable,
        _ => true,
    }
}

fn incompatible(reason: String, config: &ServerConfig) -> Value {
    json!({"channel":"realtime","event":"incompatible","data":{
        "reason":reason,"updateRequired":true,"supportedProtocol":{"min":1,"max":1},
        "serverVersion":config.server_version}})
}

fn batch(
    bus: &EventBus,
    stream: &str,
    delivery: &str,
    events: Vec<Value>,
    latest: u64,
    gap: Option<Value>,
) -> Value {
    let mut data = json!({"delivery":delivery,"stream":stream,
        "latestSeq":events.last().and_then(|event| event["seq"].as_u64()).unwrap_or(latest),
        "epoch":bus.epoch(),"events":events});
    if let Some(gap) = gap {
        data["gap"] = gap;
    }
    json!({"channel":"realtime","event":"batch","data":data})
}

async fn send(socket: &mut WebSocketStream<TcpStream>, frame: Value) -> Result<(), ()> {
    socket
        .send(Message::text(frame.to_string()))
        .await
        .map_err(|_| ())
}

pub async fn serve(
    listener: TcpListener,
    config: ServerConfig,
    bus: Arc<EventBus>,
) -> std::io::Result<()> {
    if config.token.is_empty() {
        return Err(std::io::Error::other("credential required"));
    }
    let config = Arc::new(config);
    loop {
        let (stream, _) = listener.accept().await?;
        let config = config.clone();
        let bus = bus.clone();
        tokio::spawn(async move {
            let _ = connection(stream, config, bus).await;
        });
    }
}

async fn connection(
    stream: TcpStream,
    config: Arc<ServerConfig>,
    bus: Arc<EventBus>,
) -> Result<(), ()> {
    let auth = config.clone();
    let mut socket = accept_hdr_async(stream, move |request: &Request, response: Response| {
        let token = form_urlencoded::parse(request.uri().query().unwrap_or("").as_bytes())
            .find(|(key, _)| key == "token")
            .map(|(_, value)| value.into_owned())
            .unwrap_or_default();
        if request.uri().path() == "/ws"
            && !token.is_empty()
            && bool::from(token.as_bytes().ct_eq(auth.token.as_bytes()))
        {
            return Ok(response);
        }
        let mut rejected =
            tokio_tungstenite::tungstenite::http::Response::new(Some("Unauthorized".into()));
        *rejected.status_mut() = StatusCode::UNAUTHORIZED;
        Err(rejected)
    })
    .await
    .map_err(|_| ())?;
    let mut live = bus.listen();
    send(
        &mut socket,
        json!({"channel":"system","event":"connected","data":{
        "clientId":Uuid::new_v4().to_string(),"gateway":"disabled","realtimeSeq":bus.latest().await,
        "instanceId":config.instance_id,"bootId":config.boot_id}}),
    )
    .await?;
    for initial in &config.initial {
        send(&mut socket, initial.clone()).await?;
    }
    let mut subscriptions: Vec<Subscription> = vec![];
    let mut selected: Vec<String> = vec![];
    let mut negotiation = "pending";
    let mut alive = true;
    let mut heartbeat = tokio::time::interval_at(
        tokio::time::Instant::now() + Duration::from_secs(25),
        Duration::from_secs(25),
    );
    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                if !alive { return Ok(()); }
                alive = false;
                socket.send(Message::Ping(vec![].into())).await.map_err(|_| ())?;
            }
            publication = live.recv() => {
                // A lagged receiver cannot claim exact parity with TS backpressure.
                // Drop the transport; reconnect can resume using the retained cursor.
                let events = publication.map_err(|_| ())?;
                for subscription in &subscriptions {
                    let matching = events.iter().filter(|event| event["stream"] == subscription.stream
                        && event["seq"].as_u64().unwrap_or(0) > subscription.watermark
                        && visible(event, &selected)).cloned().collect::<Vec<_>>();
                    if !matching.is_empty() {
                        send(&mut socket, batch(&bus, &subscription.stream, "live", matching, 0, None)).await?;
                    }
                }
            }
            incoming = socket.next() => {
                let Some(Ok(incoming)) = incoming else { return Ok(()); };
                let raw = match incoming {
                    Message::Pong(_) => { alive = true; continue; }
                    Message::Ping(_) => { socket.flush().await.map_err(|_| ())?; continue; }
                    Message::Close(_) => { let _ = socket.flush().await; return Ok(()); }
                    Message::Text(text) => text.to_string(),
                    Message::Binary(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
                    _ => continue,
                };
                let Ok(message) = serde_json::from_str::<Value>(&raw) else { continue; };
                match message["type"].as_str() {
                    Some("ping") => {
                        let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| ())?.as_millis() as u64;
                        send(&mut socket, json!({"channel":"pong","ts":now})).await?;
                    }
                    Some("realtime-negotiate") => {
                        if negotiation == "incompatible" { continue; }
                        let min = message["protocol"]["min"].as_f64();
                        let max = message["protocol"]["max"].as_f64();
                        let valid_range = min.zip(max).is_some_and(|(min,max)| min.fract() == 0.0 && max.fract() == 0.0 && min <= max);
                        let valid_required = message.get("requiredCapabilities").is_none_or(|required|
                            required.as_array().is_some_and(|required| required.iter().all(|item| item == "mobile-inbox-delta-v1")));
                        let valid = valid_range && valid_required
                            && message["appVersion"].as_str().is_some_and(|value| !value.trim().is_empty())
                            && matches!(message["clientKind"].as_str(), Some("desktop"|"mobile"|"web"|"test"));
                        if !valid {
                            negotiation = "incompatible";
                            send(&mut socket, incompatible("This client sent an invalid realtime protocol hello. Update o8 mobile and reconnect.".into(), &config)).await?;
                        } else if min.unwrap() > 1.0 || max.unwrap() < 1.0 {
                            negotiation = "incompatible";
                            send(&mut socket, incompatible(format!("Realtime protocol {}-{} is unsupported. Update o8 mobile to continue.", min.unwrap(), max.unwrap()), &config)).await?;
                        } else {
                            negotiation = "negotiated";
                            selected = features(&message);
                            send(&mut socket, json!({"channel":"realtime","event":"welcome","data":{
                                "protocol":1,"serverVersion":config.server_version,"epoch":bus.epoch(),"features":selected,
                                "legacyFallback":{"supported":true,"protocol":1,"removalDate":"2027-08-12","removalProtocol":2}}})).await?;
                        }
                    }
                    Some("realtime-subscribe") => {
                        if negotiation == "incompatible" {
                            send(&mut socket, incompatible("Realtime subscription was rejected because this client is incompatible. Update o8 mobile and reconnect.".into(), &config)).await?;
                            continue;
                        }
                        if negotiation == "pending" { negotiation = "legacy"; selected = features(&message); }
                        subscriptions.clear();
                        for item in message["subscriptions"].as_array().into_iter().flatten() {
                            let raw = item["stream"].as_str().unwrap_or("");
                            let stream = if raw == "session" || raw == "session:*" {
                                let Some(key) = item["sessionKey"].as_str().filter(|value| !value.is_empty()) else { continue; };
                                format!("session:{key}")
                            } else if raw == "global" || raw.starts_with("session:") { raw.into() } else { continue; };
                            let since = item["since"].as_f64().filter(|value| value.is_finite());
                            let epoch = item["epoch"].as_str().map(str::trim).filter(|value| !value.is_empty());
                            let replay = bus.replay(&stream, since, epoch).await;
                            subscriptions.push(Subscription { stream: stream.clone(), watermark: replay.latest });
                            let events = replay.events.into_iter().filter(|event| visible(event, &selected)).collect::<Vec<_>>();
                            if !events.is_empty() || replay.gap.is_some() {
                                let delivery = if replay.gap.is_some() { "bootstrap" } else { "replay" };
                                send(&mut socket, batch(&bus, &stream, delivery, events, replay.latest, replay.gap)).await?;
                            }
                            // Snapshot generation needs the future TypeScript checkpoint bridge.
                        }
                    }
                    Some("packet-tail-subscribe") if message["packetId"].as_str().unwrap_or("").trim().is_empty() => {
                        send(&mut socket, json!({"channel":"packet-tail","type":"error","error":"packetId is required"})).await?;
                    }
                    _ => {} // Commands stay with TypeScript; this prototype does not execute them.
                }
            }
        }
    }
}
