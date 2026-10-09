use super::*;
use codex::tests::{rejection_fixture, UNSUPPORTED};
use text_turn::EffectiveTextSelection;

async fn terminal_case(terminal: &str) {
    let fixture = rejection_fixture(true, false, UNSUPPORTED);
    let original = std::fs::read_to_string(&fixture.binary).unwrap();
    let tool = if terminal == "interrupted" {
        "fixture_interrupt"
    } else {
        "fixture_tool"
    };
    let script = original.replace(
        r#"        printf '{"id":%s,"result":{"turn":{"id":"turn-fixture"}}}\n' "$id""#,
        &format!(r#"        turn_count=$(( ${{turn_count:-0}} + 1 ))
        if [ "$turn_count" -gt 1 ]; then
          {}
          printf '%s\n' '{{"method":"turn/completed","params":{{"turn":{{"error":{{"message":"fixture later planner failure"}}}}}}}}'
          continue
        fi
        printf '{{"id":%s,"result":{{"turn":{{"id":"turn-fixture"}}}}}}\n' "$id""#,
        if terminal == "timeout" { "sleep 3" } else { "" }),
    ).replace(r#"{\"done\":true,\"say\":\"Ready.\"}"#,
        &format!(r#"{{\"tool\":\"{tool}\",\"args\":{{}}}}"#));
    assert_ne!(script, original);
    std::fs::write(&fixture.binary, script).unwrap();
    let ctx = TaskCtx::default();
    let selection = EffectiveTextSelection::new("gpt-6.1-sol", "high");
    let result = codex::run_phone_text_loop(
        fixture.binary(),
        "gpt-6.1-sol",
        "high",
        "Hello",
        &ctx,
        ConfirmCorrelation,
        true,
        selection.clone(),
    )
    .await;
    let outcome = selection.finish(result, ctx.is_cancelled(), machine::MachineIdentity);
    let wire = serde_json::to_value(outcome).unwrap();
    assert_eq!(
        wire["status"],
        if terminal == "interrupted" {
            "interrupted"
        } else {
            "error"
        }
    );
    assert_eq!(wire["model"], "gpt-5.6-sol");
    assert_eq!(wire["effort"], "high");
    if terminal == "error" {
        assert!(wire["detail"]
            .as_str()
            .unwrap()
            .contains("fixture later planner failure"));
    } else if terminal == "timeout" {
        assert!(wire["detail"].as_str().unwrap().contains("timed out"));
    }
    assert_eq!(
        fixture.spawn_count(),
        2,
        "no replay on later failure/interruption"
    );
    // The next bound turn receives terminal metadata with compatibility consumed.
    std::fs::write(&fixture.binary, original).unwrap();
    let bound = EffectiveTextSelection::new(
        wire["model"].as_str().unwrap(),
        wire["effort"].as_str().unwrap(),
    );
    let next = codex::run_phone_text_loop(
        fixture.binary(),
        wire["model"].as_str().unwrap(),
        wire["effort"].as_str().unwrap(),
        "Next",
        &TaskCtx::default(),
        ConfirmCorrelation,
        false,
        bound.clone(),
    )
    .await;
    let next = bound.finish(next, false, machine::MachineIdentity);
    assert_eq!(next.status, "done");
    assert_eq!(next.model, "gpt-5.6-sol");
    let capture = fixture.captured();
    let last_spawn = capture.rsplit("__SPAWN__").next().unwrap();
    assert!(last_spawn.contains("model=\"gpt-5.6-sol\""));
    assert!(last_spawn.contains("model_reasoning_effort=\"high\""));
    assert!(!last_spawn.contains("gpt-6.1-sol"));
}

#[tokio::test]
async fn fallback_then_planner_failure_keeps_terminal_selection() {
    terminal_case("error").await;
}
#[tokio::test]
async fn fallback_then_interruption_keeps_terminal_selection() {
    terminal_case("interrupted").await;
}
#[tokio::test]
async fn fallback_then_blocking_timeout_keeps_terminal_selection() {
    terminal_case("timeout").await;
}
