use o8d::EventBus;
use serde_json::{json, Value};

fn event(seq: u64, stream: &str) -> Value {
    json!({"protocol":1,"seq":seq,"stream":stream,"channel":"mutation",
        "event":"mutation.settled","ts":"2026-01-01T00:00:00.000Z",
        "data":{"nested":{"preserved":true}},"additive":"preserved"})
}

#[tokio::test]
async fn fanout_preserves_every_envelope_and_reconnect_replays() {
    let bus = EventBus::new("epoch".into(), 4);
    let mut one = bus.listen();
    let mut twenty = (0..20).map(|_| bus.listen()).collect::<Vec<_>>();
    let payload = vec![event(1, "global"), event(2, "session:fixture")];
    bus.publish(payload.clone()).await.unwrap();
    assert_eq!(one.recv().await.unwrap(), payload);
    for client in &mut twenty {
        assert_eq!(client.recv().await.unwrap(), payload);
    }
    drop(one);
    assert_eq!(
        bus.replay("global", Some(0.0), Some("epoch")).await.events,
        vec![payload[0].clone()]
    );
}

#[tokio::test]
async fn retention_is_global_and_bootstrap_is_not_retained() {
    let bus = EventBus::new("epoch".into(), 4);
    let mut bootstrap = event(5, "global");
    bootstrap["delivery"] = json!("bootstrap");
    bus.publish(vec![
        event(1, "global"),
        event(2, "session:a"),
        event(3, "global"),
        event(4, "session:b"),
        bootstrap,
        event(6, "session:b"),
    ])
    .await
    .unwrap();
    let replay = bus.replay("global", Some(1.0), Some("epoch")).await;
    assert_eq!(
        replay.gap,
        Some(json!({"requestedSince":1.0,"earliestAvailable":3}))
    );
    assert_eq!(bus.latest().await, 6);
    assert_eq!(
        bus.replay("global", None, None).await.events,
        vec![event(3, "global")]
    );
}

#[tokio::test]
async fn epochless_stale_ahead_and_empty_stream_cursors_require_resync() {
    let bus = EventBus::new("epoch".into(), 4);
    bus.publish(vec![event(1, "global")]).await.unwrap();
    for (stream, since, epoch) in [
        ("global", 0.0, None),
        ("global", 0.0, Some("old")),
        ("global", 2.0, Some("epoch")),
        ("session:empty", 1.0, Some("epoch")),
    ] {
        let replay = bus.replay(stream, Some(since), epoch).await;
        assert!(replay.gap.is_some());
        assert!(replay.events.is_empty());
    }
    assert!(bus
        .replay("global", Some(0.0), Some("epoch"))
        .await
        .gap
        .is_none());
}

#[tokio::test]
async fn invalid_producer_batches_leave_no_partial_persisted_replay() {
    let bus = EventBus::new("epoch".into(), 4);
    assert!(bus
        .publish(vec![event(1, "global"), event(1, "global")])
        .await
        .is_err());
    assert_eq!(bus.latest().await, 0);
    assert!(bus.replay("global", None, None).await.events.is_empty());
}

#[tokio::test]
async fn private_bootstrap_advances_seq_without_live_or_replay_leakage() {
    let bus = EventBus::new("epoch".into(), 4);
    let mut observer = bus.listen();
    let mut bootstrap = event(1, "global");
    bootstrap["delivery"] = json!("bootstrap");
    bus.publish(vec![bootstrap, event(2, "global")])
        .await
        .unwrap();
    assert_eq!(observer.recv().await.unwrap(), vec![event(2, "global")]);
    assert_eq!(
        bus.replay("global", None, None).await.events,
        vec![event(2, "global")]
    );
    assert_eq!(bus.latest().await, 2);
}
