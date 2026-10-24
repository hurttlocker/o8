//! One owned, cancellable socket per selected session. No OS or app discovery.
use crate::client::Client;
use serde_json::{Value, json};
use std::{
    io::ErrorKind,
    net::TcpStream,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender, TrySendError},
    },
    thread,
    time::{Duration, Instant},
};
use tungstenite::{Message, client::IntoClientRequest, protocol::WebSocketConfig};

pub enum Incoming {
    Frame(Value),
    Status(&'static str),
}
pub struct Subscription {
    pub receiver: Receiver<Incoming>,
    cancel: Arc<AtomicBool>,
}
impl Drop for Subscription {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
    }
}

fn pause(cancel: &AtomicBool, duration: Duration) {
    let start = Instant::now();
    while !cancel.load(Ordering::Relaxed) && start.elapsed() < duration {
        thread::sleep(Duration::from_millis(25));
    }
}
fn emit(sender: &SyncSender<Incoming>, cancel: &AtomicBool, mut message: Incoming) -> bool {
    loop {
        if cancel.load(Ordering::Relaxed) {
            return false;
        }
        match sender.try_send(message) {
            Ok(()) => return true,
            Err(TrySendError::Disconnected(_)) => return false,
            Err(TrySendError::Full(value)) => {
                message = value;
                pause(cancel, Duration::from_millis(10));
            }
        }
    }
}
fn run(
    client: &Client,
    key: &str,
    sender: &SyncSender<Incoming>,
    cancel: &AtomicBool,
    backoff: &mut u64,
) -> Result<(), ()> {
    let (url, address) = client.websocket().map_err(|_| ())?;
    if cancel.load(Ordering::Relaxed) {
        return Ok(());
    }
    // A numeric address is derived from the validated explicit HTTP origin.
    // Direct TCP avoids proxies; the handshake follows no redirects.
    let tcp = TcpStream::connect_timeout(&address, Duration::from_secs(2)).map_err(|_| ())?;
    tcp.set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|_| ())?;
    tcp.set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|_| ())?;
    let request = url.as_str().into_client_request().map_err(|_| ())?;
    let config = WebSocketConfig::default()
        .max_message_size(Some(16 * 1024 * 1024))
        .max_frame_size(Some(16 * 1024 * 1024));
    let (mut socket, _) =
        tungstenite::client::client_with_config(request, tcp, Some(config)).map_err(|_| ())?;
    socket
        .get_mut()
        .set_read_timeout(Some(Duration::from_millis(100)))
        .map_err(|_| ())?;
    // Omitting since, including after reconnect, requests a fresh checkpoint,
    // exactly as DesktopWebSocketContext does for a reopened transport.
    socket.send(Message::Text(json!({"type":"realtime-subscribe","subscriptions":[{"stream":format!("session:{key}")}]}).to_string().into())).map_err(|_| ())?;
    if !emit(sender, cancel, Incoming::Status("Live · read-only")) {
        return Ok(());
    }
    let mut ping = Instant::now();
    while !cancel.load(Ordering::Relaxed) {
        match socket.read() {
            Ok(Message::Text(text)) => {
                if let Ok(frame) = serde_json::from_str::<Value>(&text) {
                    if frame["channel"] == "system" && frame["event"] == "connected" {
                        *backoff = 1;
                    }
                    if frame["channel"] == "realtime" && frame["event"] == "incompatible" {
                        return Err(());
                    }
                    if !emit(sender, cancel, Incoming::Frame(frame)) {
                        break;
                    }
                }
            }
            Ok(Message::Close(_)) => return Err(()),
            Ok(_) => {}
            Err(tungstenite::Error::Io(e))
                if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(_) => return Err(()),
        }
        if ping.elapsed() >= Duration::from_secs(20) {
            socket
                .send(Message::Text(json!({"type":"ping"}).to_string().into()))
                .map_err(|_| ())?;
            ping = Instant::now();
        }
    }
    let _ = socket.close(None);
    Ok(())
}
pub fn subscribe(client: Client, key: String) -> Subscription {
    let (sender, receiver) = mpsc::sync_channel(64);
    let cancel = Arc::new(AtomicBool::new(false));
    let stopped = cancel.clone();
    thread::spawn(move || {
        let mut backoff = 1;
        while !stopped.load(Ordering::Relaxed) {
            let _ = run(&client, &key, &sender, &stopped, &mut backoff);
            if stopped.load(Ordering::Relaxed) {
                break;
            }
            if !emit(
                &sender,
                &stopped,
                Incoming::Status("Reconnecting · saved history retained"),
            ) {
                break;
            }
            pause(&stopped, Duration::from_secs(backoff));
            backoff = (backoff * 2).min(30);
        }
    });
    Subscription { receiver, cancel }
}
