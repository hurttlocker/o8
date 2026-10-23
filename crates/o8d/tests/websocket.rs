#![cfg(feature = "experimental-ws")]
use futures_util::{SinkExt, StreamExt};
use o8d::{
    websocket::{serve, ServerConfig},
    EventBus,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[tokio::test]
async fn real_websocket_auth_fanout_reconnect_replay_and_unsubscribe() {
    let bus = Arc::new(EventBus::new("fixture-epoch".into(), 4));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(serve(
        listener,
        ServerConfig {
            token: "fixture-credential".into(),
            instance_id: "fixture-instance".into(),
            boot_id: "fixture-boot".into(),
            server_version: "fixture-version".into(),
            initial: vec![],
        },
        bus.clone(),
    ));
    let rejected = connect_async(format!("ws://{address}/ws?token=invalid"))
        .await
        .unwrap_err();
    match rejected {
        tokio_tungstenite::tungstenite::Error::Http(response) => assert_eq!(response.status(), 401),
        _ => panic!("expected HTTP upgrade rejection"),
    }
    let url = format!("ws://{address}/ws?token=fixture-credential");
    let (mut socket, _) = connect_async(&url).await.unwrap();
    let welcome: Value =
        serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(welcome["event"], "connected");
    socket
        .send(Message::text(
            json!({"type":"realtime-subscribe","subscriptions":[
        {"stream":"global","epoch":"fixture-epoch","since":0}]})
            .to_string(),
        ))
        .await
        .unwrap();
    // Application pong is a barrier: subscription has been installed before publication.
    socket
        .send(Message::text("{\"type\":\"ping\"}"))
        .await
        .unwrap();
    let pong: Value =
        serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(pong["channel"], "pong");
    let envelope = json!({"protocol":1,"seq":1,"stream":"global","channel":"mutation",
        "event":"mutation.settled","ts":"2026-01-01T00:00:00.000Z","data":{"fixture":true}});
    bus.publish(vec![envelope.clone()]).await.unwrap();
    let live: Value =
        serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(
        live,
        json!({"channel":"realtime","event":"batch","data":{
        "delivery":"live","stream":"global","events":[envelope],"epoch":"fixture-epoch","latestSeq":1}})
    );
    socket.close(None).await.unwrap();
    let (mut reconnected, _) = connect_async(&url).await.unwrap();
    reconnected.next().await.unwrap().unwrap();
    reconnected
        .send(Message::text(
            json!({"type":"realtime-subscribe","subscriptions":[
        {"stream":"global","epoch":"fixture-epoch","since":0}]})
            .to_string(),
        ))
        .await
        .unwrap();
    let replay: Value = serde_json::from_str(
        reconnected
            .next()
            .await
            .unwrap()
            .unwrap()
            .to_text()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(replay["data"]["delivery"], "replay");
    assert_eq!(replay["data"]["events"], live["data"]["events"]);
    reconnected
        .send(Message::text(
            "{\"type\":\"realtime-subscribe\",\"subscriptions\":[]}",
        ))
        .await
        .unwrap();
    reconnected
        .send(Message::text("{\"type\":\"ping\"}"))
        .await
        .unwrap();
    reconnected.next().await.unwrap().unwrap();
    let mut next = envelope;
    next["seq"] = json!(2);
    bus.publish(vec![next]).await.unwrap();
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(100), reconnected.next())
            .await
            .is_err()
    );
    reconnected.close(None).await.unwrap();
    server.abort();
}
