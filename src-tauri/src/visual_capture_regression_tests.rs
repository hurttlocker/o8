//! The native admission and navigation entry coordinators, with real owned files.
//! Screen/microphone hardware and Wry webview acceptance remain separate.
use super::*;

fn owner(id: &str, generation: u64) -> Owner {
    let directory =
        std::env::temp_dir().join(format!("o8-visual-lifecycle-{}", uuid::Uuid::new_v4()));
    create_private_directory(&directory).unwrap();
    std::fs::write(directory.join("recording.mp4"), b"owned video").unwrap();
    Owner {
        id: id.into(),
        generation,
        ready: false,
        finishing: false,
        finished: false,
        session: None,
        shared: None,
        artifacts: Artifacts::new(directory.clone()),
        directory,
        cancelled: Arc::new(AtomicBool::new(false)),
        transcribing: false,
    }
}

#[test]
fn native_admission_tracks_pending_active_and_released_input() {
    let _serial = crate::voice_input::TEST_CLAIMS.lock().unwrap();
    struct Fence(u64);
    impl Drop for Fence {
        fn drop(&mut self) {
            crate::stt_engine::seed_test_session_id(self.0);
        }
    }
    // A finished dictation retains this nonzero teardown fence in production.
    let _fence = Fence(crate::stt_engine::seed_test_session_id(880));
    assert!(
        ensure_idle(&None, false).is_ok(),
        "historical dictation fence must not block capture"
    );
    let first = crate::voice_input::reserve_native(901).unwrap();
    assert!(
        ensure_idle(&None, false).is_err(),
        "pending input must block capture"
    );
    first.activate().unwrap();
    drop(first);
    assert!(ensure_idle(&None, false).is_err());
    crate::voice_input::release_native(901);
    assert!(
        ensure_idle(&None, false).is_ok(),
        "completed dictation must allow capture"
    );
    let replacement = crate::voice_input::reserve_native(902).unwrap();
    replacement.activate().unwrap();
    drop(replacement);
    crate::voice_input::release_native(901);
    assert!(
        ensure_idle(&None, false).is_err(),
        "stale teardown must not release replacement"
    );
    crate::voice_input::release_native(902);
    assert!(ensure_idle(&None, false).is_ok());
    assert!(ensure_idle(&None, true).is_err());
}

#[test]
fn navigation_detaches_start_and_finish_in_flight_without_deleting_replacement() {
    let _serial = super::tests::TEST_OWNER.lock().unwrap();
    for finishing in [false, true] {
        let mut capture = owner("reused-id", 41);
        capture.finishing = finishing;
        let directory = capture.directory.clone();
        let cancelled = capture.cancelled.clone();
        // The production startup/finish/transcription/snapshot workers hold this lease.
        let writer = capture.artifacts.clone();
        *lock_owner() = Some(capture);
        let detached = detach_on_main_navigation().expect("navigation must take the old owner");
        assert!(
            lock_owner().is_none(),
            "navigation must unblock admission immediately"
        );
        assert!(cancelled.load(Ordering::Acquire));
        let replacement = owner("reused-id", 42);
        let replacement_path = replacement.directory.clone();
        let replacement_cancelled = replacement.cancelled.clone();
        *lock_owner() = Some(replacement);
        drop(detached);
        assert!(
            directory.exists(),
            "in-flight writer must retain its directory"
        );
        // A delayed owned writer can finish, then cleanup removes exactly its files.
        std::fs::write(directory.join("late-frame.png"), b"late frame").unwrap();
        drop(writer);
        assert!(!directory.exists());
        assert!(take_owner("reused-id", Some(41)).is_none());
        assert!(finish_result("reused-id", 41, Ok(serde_json::json!({"frames": []}))).is_err());
        assert!(
            !lock_owner().as_ref().unwrap().finished,
            "stale finish must not retain replacement artifacts"
        );
        assert!(!replacement_cancelled.load(Ordering::Acquire));
        assert!(replacement_path.join("recording.mp4").exists());
        let current = take_owner("reused-id", Some(42)).unwrap();
        stop_owner(&current, true);
        drop(current);
        assert!(!replacement_path.exists());
    }
}

#[test]
fn navigation_preserves_completed_packet_and_explicit_retention() {
    let _serial = super::tests::TEST_OWNER.lock().unwrap();
    let capture = owner("complete", 51);
    let directory = capture.directory.clone();
    *lock_owner() = Some(capture);
    finish_result("complete", 51, Ok(serde_json::json!({"frames": []}))).unwrap();
    drop(detach_on_main_navigation().unwrap());
    assert!(directory.join("recording.mp4").exists());
    let retained = owner("retained", 52);
    let retained_path = retained.directory.clone();
    stop_owner(&retained, false);
    drop(retained);
    assert!(retained_path.join("recording.mp4").exists());
    std::fs::remove_dir_all(directory).unwrap();
    std::fs::remove_dir_all(retained_path).unwrap();
}

#[test]
fn unsupported_recording_api_has_an_actionable_attachment_path() {
    let error = crate::visual_capture_session::recording_output_available(false).unwrap_err();
    assert!(error.contains("macOS 15"));
    assert!(error.contains("attach an image"));
    assert!(crate::visual_capture_session::recording_output_available(true).is_ok());
}
