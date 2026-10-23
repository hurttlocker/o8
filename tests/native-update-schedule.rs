use super::UpdateSchedule;

#[test]
fn checks_on_launch_and_every_thirty_minutes_without_a_webview() {
    let mut schedule = UpdateSchedule::default();
    assert!(schedule.due(0, false));
    assert!(!schedule.due(1_000, false));
    // Heartbeats continue while the window is hidden or no card is mounted.
    for now in (2_000..1_800_000).step_by(1_000) {
        assert!(!schedule.due(now, false));
    }
    assert!(schedule.due(1_800_000, false));
}

#[test]
fn checks_on_wake_and_on_server_request() {
    let mut schedule = UpdateSchedule::default();
    assert!(schedule.due(0, false));
    assert!(!schedule.due(1_000, false));
    assert!(schedule.due(61_000, false));
    assert!(schedule.due(62_000, true));
    assert!(!schedule.due(63_000, false));
}

#[test]
fn network_check_duration_does_not_trigger_a_false_wake_loop() {
    let mut schedule = UpdateSchedule::default();
    assert!(schedule.due(0, false));
    schedule.completed(17_000);
    assert!(!schedule.due(18_000, false));
}

#[test]
fn repeated_short_sleep_gaps_are_debounced_but_manual_requests_are_not() {
    let mut schedule = UpdateSchedule::default();
    assert!(schedule.due(0, false));
    assert!(schedule.due(60_000, false));
    assert!(
        !schedule.due(66_000, false),
        "a second gap must not repeat the wake check"
    );
    assert!(schedule.due(67_000, true));
}

#[test]
fn awaited_transport_and_installation_do_not_count_as_sleep() {
    let mut schedule = UpdateSchedule::default();
    assert!(schedule.due(0, false));
    schedule.completed(2_000);
    // Slow GET, POST, download and installation all finish before deliberate sleep.
    schedule.awake(90_000);
    assert!(!schedule.due(91_000, false));
    schedule.awake(140_000);
    assert!(!schedule.due(141_000, false));
    assert!(schedule.due(1_900_000, false));
}
