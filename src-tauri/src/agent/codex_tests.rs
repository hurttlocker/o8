use super::*;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

/// One fixture binary that answers BOTH Codex planner protocols: the resident
/// `app-server` NDJSON JSON-RPC handshake, and the legacy per-turn `exec`
/// stream. `FIXTURE_APP_SERVER=0` makes the app-server subcommand fail so the
/// session degrades onto `exec`, which is how the fallback path is exercised.
/// Every invocation appends `__SPAWN__` + its argv to `$FIXTURE_CAPTURE`, and
/// the app-server branch also records each request line — so a test can count
/// process starts and read back what was actually sent.
const CODEX_FIXTURE: &str = r#"#!/bin/sh
printf '%s\n' '__SPAWN__' >> "$FIXTURE_CAPTURE"
for arg in "$@"; do printf 'argv %s\n' "$arg" >> "$FIXTURE_CAPTURE"; done
if [ "$1" = "app-server" ]; then
  if [ "$FIXTURE_APP_SERVER" = "0" ]; then
    printf '%s\n' 'app-server unsupported in this fixture' >&2
    exit 1
  fi
  while IFS= read -r line; do
    printf 'in %s\n' "$line" >> "$FIXTURE_CAPTURE"
    id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
    case "$line" in
      *'"initialize"'*)
        printf '{"id":%s,"result":{"userAgent":"fixture"}}\n' "$id"
        ;;
      *'"thread/start"'*)
        printf '{"id":%s,"result":{"thread":{"id":"thread-fixture"}}}\n' "$id"
        ;;
      *'"turn/start"'*)
        printf '{"id":%s,"result":{"turn":{"id":"turn-fixture"}}}\n' "$id"
        printf '%s\n' '{"method":"item/started","params":{"item":{"type":"agentMessage","text":""}}}'
        printf '%s\n' '{"method":"item/completed","params":{"item":{"type":"agentMessage","text":"{\"done\":true,\"say\":\"Ready.\"}"}}}'
        printf '%s\n' '{"method":"turn/completed","params":{}}'
        ;;
    esac
  done
  exit 0
fi
has_skip=0
for arg in "$@"; do
  if [ "$arg" = "--skip-git-repo-check" ]; then has_skip=1; fi
done
printf '%s\n' '__END__' >> "$FIXTURE_CAPTURE"
if [ "$has_skip" -ne 1 ]; then
  printf '%s\n' 'Not inside a trusted directory and --skip-git-repo-check was not specified.' >&2
  exit 1
fi
printf '%s\n' '{"type":"thread.started","thread_id":"thread-1"}'
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"{\"done\":true,\"say\":\"Ready.\"}"}}'
"#;

#[cfg(unix)]
struct CodexFixture {
    dir: std::path::PathBuf,
    binary: std::path::PathBuf,
    capture: std::path::PathBuf,
    previous_app_server: Option<std::ffi::OsString>,
    previous_capture: Option<std::ffi::OsString>,
    _guard: std::sync::MutexGuard<'static, ()>,
}

#[cfg(unix)]
impl CodexFixture {
    /// Build the fixture binary and point the capture file at a throwaway path.
    /// The planner writes nothing to disk, so no data dir or Codex home is
    /// swapped here — the fixture binary never reads either.
    fn new(app_server: bool) -> Self {
        let guard = crate::DATA_DIR_ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir = std::env::temp_dir().join(format!(
            "o8-codex-planner-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let binary = dir.join("codex-fixture");
        let capture = dir.join("capture.txt");
        std::fs::write(&binary, CODEX_FIXTURE).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();

        let fixture = Self {
            previous_app_server: std::env::var_os("FIXTURE_APP_SERVER"),
            previous_capture: std::env::var_os("FIXTURE_CAPTURE"),
            dir: dir.clone(),
            binary,
            capture: capture.clone(),
            _guard: guard,
        };
        std::env::set_var("FIXTURE_APP_SERVER", if app_server { "1" } else { "0" });
        std::env::set_var("FIXTURE_CAPTURE", &capture);
        fixture
    }

    fn binary(&self) -> &str {
        self.binary.to_str().unwrap()
    }

    fn captured(&self) -> String {
        std::fs::read_to_string(&self.capture).unwrap_or_default()
    }

    fn spawn_count(&self) -> usize {
        self.captured()
            .lines()
            .filter(|line| *line == "__SPAWN__")
            .count()
    }

    /// Argv of every recorded process start, in order.
    fn invocations(&self) -> Vec<Vec<String>> {
        self.captured()
            .split("__SPAWN__\n")
            .skip(1)
            .map(|chunk| {
                chunk
                    .lines()
                    .filter_map(|line| line.strip_prefix("argv ").map(str::to_string))
                    .collect()
            })
            .collect()
    }
}

#[cfg(unix)]
impl Drop for CodexFixture {
    fn drop(&mut self) {
        for (key, value) in [
            ("FIXTURE_APP_SERVER", &self.previous_app_server),
            ("FIXTURE_CAPTURE", &self.previous_capture),
        ] {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn parses_codex_thread_and_agent_message() {
    let mut session = CodexSession::new("/mock/codex", "gpt-5.6-sol", "high");
    let answer = session
        .parse_output(
            "{\"type\":\"thread.started\",\"thread_id\":\"thread-1\"}\n\
             {\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"{\\\"done\\\":true,\\\"say\\\":\\\"Ready.\\\"}\"}}",
        )
        .unwrap();
    assert_eq!(session.thread_id.as_deref(), Some("thread-1"));
    assert_eq!(answer, r#"{"done":true,"say":"Ready."}"#);
}

#[cfg(unix)]
#[test]
fn resident_app_server_serves_both_turns_from_one_process() {
    let fixture = CodexFixture::new(true);
    let mut session = CodexSession::new(fixture.binary(), "gpt-5.6-sol", "high");

    assert_eq!(
        session.send_turn("First user turn", None).unwrap(),
        r#"{"done":true,"say":"Ready."}"#
    );
    assert_eq!(
        session.send_turn("Tool result follow-up", None).unwrap(),
        r#"{"done":true,"say":"Ready."}"#
    );

    let captured = fixture.captured();
    assert_eq!(
        fixture.spawn_count(),
        1,
        "turn 2 must reuse the resident child, not spawn again:\n{captured}"
    );
    let invocations = fixture.invocations();
    assert_eq!(invocations[0][0], "app-server");
    assert!(
        !invocations.iter().any(|argv| argv[0] == "exec"),
        "the resident path must not fall back to per-turn exec:\n{captured}"
    );

    // The seat is pinned on the thread, not on a per-turn command line.
    let thread_start = captured
        .lines()
        .find(|line| line.contains("\"thread/start\""))
        .expect("thread/start request recorded");
    assert!(thread_start.contains("\"model\":\"gpt-5.6-sol\""), "{thread_start}");
    assert!(
        thread_start.contains("\"model_reasoning_effort\":\"high\""),
        "{thread_start}"
    );
    let turns = captured
        .lines()
        .filter(|line| line.contains("\"turn/start\""))
        .count();
    assert_eq!(turns, 2, "both turns ride the one thread:\n{captured}");

    // `-c` overrides — not a copied Codex home — are what keep the resident
    // child off the operator's own model pins and sandbox mode. The empty
    // `mcp_servers` table and the plugin/apps disables ride the same list.
    let argv = &invocations[0];
    for expected in [
        "model=\"gpt-5.6-sol\"",
        "model_reasoning_effort=\"high\"",
        "approval_policy=\"never\"",
        "sandbox_mode=\"read-only\"",
        "tools.image_generation=false",
        "mcp_servers={}",
    ] {
        // Each override must ride its own `-c`, or the CLI never sees it.
        assert!(
            argv.windows(2).any(|pair| pair[0] == "-c" && pair[1] == expected),
            "missing `-c {expected}`: {argv:?}"
        );
    }
    assert!(argv.windows(2).any(|pair| pair == ["--disable", "plugins"]));
    assert!(argv.windows(2).any(|pair| pair == ["--disable", "apps"]));
    assert!(
        !argv.iter().any(|arg| arg.contains("auth.json")),
        "the planner must never touch Codex credentials: {argv:?}"
    );
}

#[cfg(unix)]
#[test]
fn app_server_boot_failure_degrades_to_per_turn_exec_and_resumes() {
    let fixture = CodexFixture::new(false);
    let mut session = CodexSession::new(fixture.binary(), "gpt-5.6-sol", "xhigh");

    session.send_turn("First user turn", None).unwrap();
    session.send_turn("Tool result follow-up", None).unwrap();

    let captured = fixture.captured();
    let all = fixture.invocations();
    // Boot is attempted once, not once per turn, and then the session degrades.
    assert_eq!(
        all.iter().filter(|argv| argv[0] == "app-server").count(),
        1,
        "{captured}"
    );
    let execs: Vec<&Vec<String>> = all.iter().filter(|argv| argv[0] == "exec").collect();
    assert_eq!(execs.len(), 2, "one exec per turn:\n{captured}");
    assert!(execs[0].iter().any(|arg| arg == "--skip-git-repo-check"));
    assert!(execs[0].iter().any(|arg| arg == "--ignore-user-config"));
    assert_eq!(execs[1][..3], ["exec", "resume", "thread-1"]);
    assert!(execs[1].iter().any(|arg| arg == "--skip-git-repo-check"));
    assert!(execs[1]
        .iter()
        .any(|arg| arg == "model_reasoning_effort=xhigh"));
}
