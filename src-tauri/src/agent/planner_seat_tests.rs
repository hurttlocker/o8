//! Real-path coverage for the background planner seat (#2155, #2156).
//!
//! The `escalate` handoff used to pin the frontier orchestrator model, and
//! before that it could only reach two CLIs. These tests drive the REAL entry
//! points — the tool dispatch, the env-backed planner registry, and the process
//! spawn — rather than the resolver helper on its own, because the resolver
//! being right proves nothing if the spawn site never asks it.

use super::*;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

/// Headless task context. `app: None` is the persisted read-only seam the tool
/// dispatch already supports — every app-dependent action fails closed.
fn headless_ctx() -> TaskCtx {
    TaskCtx {
        task_id: "planner-seat-test".into(),
        utterance: "go through my calendar and draft the summary".into(),
        ledger_session_id: None,
        machine_session_id: "desktop".into(),
        app: None,
        screen: None,
        spatial: false,
        crop_png_base64: None,
        edit: None,
        cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
    }
}

#[tokio::test]
async fn escalate_reaches_the_background_planner_handoff_without_naming_a_vendor() {
    let ctx = headless_ctx();

    // Guard first: an empty task never reaches the handoff at all.
    let empty = tools::dispatch_tool_call(
        "escalate",
        json!({ "task": "   ", "target": "claude_brain" }),
        &ctx,
    )
    .await;
    assert_eq!(
        empty.unwrap_err(),
        "escalate requires a non-empty `task`",
        "the empty-task guard must fire before any handoff"
    );

    // The real dispatch takes the background-brain branch, whose only remaining
    // dependency headless is the desktop handle `spawn_background_brain_task`
    // needs. That spawn resolves its seat through `planner_route::resolve()` —
    // with no model override — which the seat tests below pin down.
    let handed_off = tools::dispatch_tool_call(
        "escalate",
        json!({ "task": "summarize this week's calendar", "target": "claude_brain" }),
        &ctx,
    )
    .await;
    assert_eq!(
        handed_off.unwrap_err(),
        "This action requires the live o8 desktop app"
    );
}

#[cfg(unix)]
struct SeatFixture {
    dir: std::path::PathBuf,
    capture: std::path::PathBuf,
    previous: Vec<(&'static str, Option<std::ffi::OsString>)>,
    _guard: std::sync::MutexGuard<'static, ()>,
}

#[cfg(unix)]
impl SeatFixture {
    /// Point the planner at fixture binaries for every registry entry and a
    /// throwaway data dir carrying the operator defaults under test. Nothing
    /// real in `~/.o8` is read or written.
    fn new(orchestrator_backend: &str) -> Self {
        Self::with_brain_setting(orchestrator_backend, None)
    }

    /// Same, plus the operator's Symon brain setting written into the voice
    /// pref file the way `voice_prefs_set` writes it.
    fn with_brain_setting(orchestrator_backend: &str, brain: Option<serde_json::Value>) -> Self {
        let guard = crate::DATA_DIR_ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir = std::env::temp_dir().join(format!(
            "o8-planner-seat-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let capture = dir.join("capture.txt");
        // Records argv, then holds stdin open the way the real CLIs do so the
        // spawned session stays alive until it is dropped.
        let script = "#!/bin/sh\n\
                      for arg in \"$@\"; do printf 'argv %s\\n' \"$arg\" >> \"$SEAT_CAPTURE\"; done\n\
                      printf '%s\\n' '__END__' >> \"$SEAT_CAPTURE\"\n\
                      cat > /dev/null\n";
        for name in ["claude-fixture", "codex-fixture"] {
            let path = dir.join(name);
            std::fs::write(&path, script).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        // The opencode transport is one process PER TURN rather than a held
        // child, so its fixture records argv and then answers on stdout in the
        // NDJSON shape the real CLI emits — enough for the adapter to parse a
        // session id and a planner action back out of a real spawn.
        let opencode_fixture = dir.join("opencode-fixture");
        std::fs::write(
            &opencode_fixture,
            "#!/bin/sh\n\
             for arg in \"$@\"; do printf 'argv %s\\n' \"$arg\" >> \"$SEAT_CAPTURE\"; done\n\
             printf '%s\\n' '__END__' >> \"$SEAT_CAPTURE\"\n\
             printf '%s\\n' '{\"type\":\"text\",\"sessionID\":\"ses_fixture\",\"part\":{\"type\":\"text\",\"text\":\"{\\\"done\\\":true,\\\"say\\\":\\\"All set.\\\"}\"}}'\n",
        )
        .unwrap();
        std::fs::set_permissions(&opencode_fixture, std::fs::Permissions::from_mode(0o755))
            .unwrap();
        std::fs::write(
            dir.join("operator-defaults.json"),
            format!("{{\"orchestratorBackend\":\"{orchestrator_backend}\"}}"),
        )
        .unwrap();
        if let Some(brain) = brain {
            std::fs::write(dir.join("dictation.json"), brain.to_string()).unwrap();
        }

        let previous = [
            "O8_DATA_DIR",
            "CORTEX_IDE_DATA_DIR",
            "O8_CLAUDE_CODE_BIN",
            "CLAUDE_BIN",
            "O8_CODEX_BIN",
            "CODEX_BIN",
            "O8_OPENCODE_BIN",
            "OPENCODE_BIN",
            "SEAT_CAPTURE",
        ]
        .into_iter()
        .map(|key| (key, std::env::var_os(key)))
        .collect();
        std::env::set_var("O8_DATA_DIR", &dir);
        std::env::remove_var("CORTEX_IDE_DATA_DIR");
        std::env::set_var("O8_CLAUDE_CODE_BIN", dir.join("claude-fixture"));
        std::env::remove_var("CLAUDE_BIN");
        std::env::set_var("O8_CODEX_BIN", dir.join("codex-fixture"));
        std::env::remove_var("CODEX_BIN");
        std::env::set_var("O8_OPENCODE_BIN", &opencode_fixture);
        std::env::remove_var("OPENCODE_BIN");
        std::env::set_var("SEAT_CAPTURE", &capture);
        Self {
            dir,
            capture,
            previous,
            _guard: guard,
        }
    }

    /// Wait for the spawned fixture to finish writing its argv.
    fn captured_argv(&self) -> Vec<String> {
        for _ in 0..200 {
            let captured = std::fs::read_to_string(&self.capture).unwrap_or_default();
            if captured.contains("__END__") {
                return captured
                    .lines()
                    .filter_map(|line| line.strip_prefix("argv ").map(str::to_string))
                    .collect();
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        panic!("fixture never recorded its argv");
    }
}

#[cfg(unix)]
impl Drop for SeatFixture {
    fn drop(&mut self) {
        for (key, value) in &self.previous {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[cfg(unix)]
#[test]
fn claude_backend_seats_the_worker_tier_and_spawns_it_without_an_effort_flag() {
    let fixture = SeatFixture::new("claude");
    let planner_route::PlannerRouting::Selected(selection) = planner_route::resolve() else {
        panic!("both fixture CLIs are installed, so the route must select one");
    };
    assert_eq!(selection.provider.id, "claude");
    assert_eq!(selection.model.as_deref(), Some(crate::models::CLAUDE_SONNET_5));
    assert_eq!(selection.effort, "medium");

    // The constructed command, not the resolver: spawn the planner exactly the
    // way `claude::run_loop_with_binary` does and read back its argv.
    let mcp_cfg = claude::ensure_empty_mcp_config().unwrap();
    let session = claude::ClaudeSession::spawn(&selection.binary, selection.model_label(), &mcp_cfg)
        .expect("planner session spawns");
    let argv = fixture.captured_argv();
    drop(session);

    let model_at = argv.iter().position(|arg| arg == "--model").unwrap();
    assert_eq!(argv[model_at + 1], crate::models::CLAUDE_SONNET_5);
    assert!(
        !argv.iter().any(|arg| arg == "--effort"),
        "the worker tier runs at the CLI default — no --effort flag: {argv:?}"
    );
    // Tools stay hard-locked off on the planner seat.
    assert!(argv.iter().any(|arg| arg == "--strict-mcp-config"));
    assert!(argv.iter().any(|arg| arg == "--tools"));
}

#[cfg(unix)]
#[test]
fn builder_tier_pin_still_carries_the_high_effort_flag() {
    let fixture = SeatFixture::new("claude");
    let planner_route::PlannerRouting::Selected(selection) = planner_route::resolve_bound(
        "claude",
        planner_route::BUILDER_CLAUDE_PLANNER_MODEL,
        "high",
    ) else {
        panic!("an explicit builder pin must resolve");
    };
    assert_eq!(selection.model.as_deref(), Some(crate::models::CLAUDE_OPUS_5));
    assert_eq!(selection.effort, "high");

    let mcp_cfg = claude::ensure_empty_mcp_config().unwrap();
    let session = claude::ClaudeSession::spawn(&selection.binary, selection.model_label(), &mcp_cfg)
        .expect("planner session spawns");
    let argv = fixture.captured_argv();
    drop(session);

    let effort_at = argv
        .iter()
        .position(|arg| arg == "--effort")
        .expect("the builder tier carries --effort");
    assert_eq!(argv[effort_at + 1], "high");
    let model_at = argv.iter().position(|arg| arg == "--model").unwrap();
    assert_eq!(argv[model_at + 1], crate::models::CLAUDE_OPUS_5);
}

#[cfg(unix)]
#[test]
fn codex_backend_seats_the_codex_builder_tier() {
    let _fixture = SeatFixture::new("codex");
    let planner_route::PlannerRouting::Selected(selection) = planner_route::resolve() else {
        panic!("both fixture CLIs are installed, so the route must select one");
    };
    assert_eq!(selection.provider.id, "codex");
    assert_eq!(
        selection.model.as_deref(),
        Some(planner_route::DEFAULT_CODEX_PLANNER_MODEL)
    );
    assert_eq!(selection.effort, "high");
}

#[cfg(unix)]
#[test]
fn every_backend_setting_resolves_off_the_frontier_tier() {
    for backend in ["auto", "codex", "claude", "collide", "fable", "openclaw", "hermes"] {
        let _fixture = SeatFixture::new(backend);
        let planner_route::PlannerRouting::Selected(selection) = planner_route::resolve() else {
            panic!("both fixture CLIs are installed, so the route must select one ({backend})");
        };
        assert_ne!(
            selection.model.as_deref(),
            Some(crate::models::CLAUDE_FABLE_5),
            "backend {backend} must not seat the frontier orchestrator model"
        );
        assert!(
            matches!(
                selection.model.as_deref(),
                Some(crate::models::CLAUDE_SONNET_5) | Some(crate::models::CODEX_GPT_5_6_SOL)
            ),
            "backend {backend} seated {}",
            selection.model_label()
        );
    }
}

/// The operator's Symon brain setting, written the way `voice_prefs_set` writes
/// it, must reach the seat the very next task resolves — no relaunch. The keys
/// are spelled out here on purpose: this is the on-disk contract with the
/// settings panel, and `planner_route` asserts the constants match.
#[cfg(unix)]
#[test]
fn the_brain_setting_picks_the_seat_on_the_next_resolve() {
    // Orchestrator backend says Claude; the operator's brain setting says
    // otherwise, and the setting wins.
    let fixture =
        SeatFixture::with_brain_setting("claude", Some(json!({ "symon_brain_provider": "codex" })));
    let planner_route::PlannerRouting::Selected(selection) = planner_route::resolve() else {
        panic!("the chosen provider's fixture binary is installed");
    };
    assert_eq!(selection.provider.id, "codex");
    assert_eq!(
        selection.model.as_deref(),
        Some(planner_route::DEFAULT_CODEX_PLANNER_MODEL)
    );

    // The same file, rewritten in place, moves the seat on the next read.
    std::fs::write(
        fixture.dir.join("dictation.json"),
        json!({ "symon_brain_provider": "claude", "symon_brain_tier": "builder" }).to_string(),
    )
    .unwrap();
    let planner_route::PlannerRouting::Selected(selection) = planner_route::resolve() else {
        panic!("the chosen provider's fixture binary is installed");
    };
    assert_eq!(selection.provider.id, "claude");
    assert_eq!(
        selection.model.as_deref(),
        Some(planner_route::BUILDER_CLAUDE_PLANNER_MODEL)
    );
    assert_eq!(selection.effort, "high");
}

/// The open seat end to end through a REAL process: the env-backed registry
/// resolves it, the adapter spawns it, and a planner action is parsed back out.
/// Asserts the argv the spawn actually used.
#[cfg(unix)]
#[test]
fn the_open_seat_spawns_a_read_only_run_and_carries_its_thread() {
    let fixture = SeatFixture::with_brain_setting(
        "codex",
        Some(json!({ "symon_brain_provider": "opencode" })),
    );
    let planner_route::PlannerRouting::Selected(selection) = planner_route::resolve() else {
        panic!("the opencode fixture binary is installed");
    };
    assert_eq!(selection.provider.id, "opencode");
    assert_eq!(
        selection.provider.transport,
        planner_route::PlannerTransport::OpencodeRun
    );
    // o8 pins no model for an open runtime, and reports the effort as the
    // operator's own rather than inventing one.
    assert_eq!(selection.model, None);
    assert_eq!(selection.effort, planner_route::RUNTIME_CONFIGURED_EFFORT);

    // Spawn it the way `opencode::run_loop` does and read back the real argv.
    let mut session = opencode::OpencodeSession::new(&selection.binary, selection.model.as_deref());
    let answer = claude::TextPlannerSession::send_planner_turn(&mut session, "plan this", None)
        .expect("the fixture answers one turn");
    assert_eq!(answer, r#"{"done":true,"say":"All set."}"#);

    let argv = fixture.captured_argv();
    assert_eq!(argv[0], "run");
    assert!(argv.windows(2).any(|pair| pair == ["--format", "json"]));
    // Read-only agent + no plugins: the enforced backstop behind the planner
    // contract, matching the other two seats' tool locks.
    assert!(argv.windows(2).any(|pair| pair == ["--agent", "plan"]));
    assert!(argv.iter().any(|arg| arg == "--pure"));
    assert!(
        !argv.iter().any(|arg| arg == "--auto"),
        "the planner seat never auto-approves permissions: {argv:?}"
    );
    assert!(
        !argv.iter().any(|arg| arg == "--model"),
        "no operator pin means no o8-chosen model: {argv:?}"
    );
    assert_eq!(argv[argv.len() - 2], "--");
    assert_eq!(argv[argv.len() - 1], "plan this");
}

/// An operator model pin rides the open seat's real spawn.
#[cfg(unix)]
#[test]
fn an_operator_model_pin_reaches_the_open_seat_spawn() {
    let fixture = SeatFixture::with_brain_setting(
        "codex",
        Some(json!({
            "symon_brain_provider": "opencode",
            "symon_brain_model": "openrouter/some-model",
        })),
    );
    let planner_route::PlannerRouting::Selected(selection) = planner_route::resolve() else {
        panic!("the opencode fixture binary is installed");
    };
    assert_eq!(
        selection.model.as_deref(),
        Some("openrouter/some-model"),
        "an operator pin overrides the runtime's configured model"
    );

    let mut session = opencode::OpencodeSession::new(&selection.binary, selection.model.as_deref());
    claude::TextPlannerSession::send_planner_turn(&mut session, "plan this", None).unwrap();
    let argv = fixture.captured_argv();
    let model_at = argv
        .iter()
        .position(|arg| arg == "--model")
        .expect("the pin is passed");
    assert_eq!(argv[model_at + 1], "openrouter/some-model");
}

/// The bound text surface (phone / managed messages) resumes from an
/// `(engine, model, effort)` triple. A seat whose model comes from the runtime's
/// own config cannot supply one, so the info call says exactly that instead of
/// handing down a half-filled triple that reads as "nothing installed".
#[cfg(unix)]
#[test]
fn a_runtime_configured_seat_is_reported_unbindable_to_the_text_surface() {
    let _fixture = SeatFixture::with_brain_setting(
        "codex",
        Some(json!({ "symon_brain_provider": "opencode" })),
    );
    // The voice path takes this seat.
    let planner_route::PlannerRouting::Selected(selection) = planner_route::resolve() else {
        panic!("the opencode fixture binary is installed");
    };
    assert_eq!(selection.provider.id, "opencode");

    // The bound surface does not, and says why.
    let info = symon_text_planner_info(None, None, None);
    let rendered = serde_json::to_value(&info).unwrap();
    assert_eq!(rendered["available"], serde_json::Value::Bool(false));
    assert_eq!(rendered["detail"], UNBINDABLE_TEXT_PLANNER_MESSAGE);

    // A seat that DOES carry a model id is still reported available.
    std::fs::write(
        _fixture.dir.join("dictation.json"),
        json!({ "symon_brain_provider": "codex" }).to_string(),
    )
    .unwrap();
    let rendered = serde_json::to_value(symon_text_planner_info(None, None, None)).unwrap();
    assert_eq!(rendered["available"], serde_json::Value::Bool(true));
    assert_eq!(rendered["engine"], "codex");
    assert_eq!(rendered["model"], planner_route::DEFAULT_CODEX_PLANNER_MODEL);
}
