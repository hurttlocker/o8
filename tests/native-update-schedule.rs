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
