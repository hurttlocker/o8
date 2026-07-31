//! Symon voice-agent text planner backed by the Codex subscription CLI.

use super::{claude::TextPlannerSession, ConfirmCorrelation, LoopResult, TaskCtx};
use base64::Engine;
use serde_json::Value;
use std::process::Command;

pub(crate) struct CodexSession {
    binary: String,
    model: String,
    effort: String,
    thread_id: Option<String>,
}

impl CodexSession {
    fn new(binary: &str, model: &str, effort: &str) -> Self {
        Self {
            binary: binary.to_string(),
            model: model.to_string(),
            effort: effort.to_string(),
            thread_id: None,
        }
    }

    fn image_path(image_b64: Option<&str>) -> Result<Option<std::path::PathBuf>, String> {
        let Some(encoded) = image_b64 else {
            return Ok(None);
        };
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|error| format!("codex planner image decode failed: {error}"))?;
        let path = std::env::temp_dir().join(format!(
            "o8-symon-codex-{}-{}.png",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::write(&path, bytes)
            .map_err(|error| format!("codex planner image write failed: {error}"))?;
        Ok(Some(path))
    }

    fn parse_output(&mut self, stdout: &str) -> Result<String, String> {
        let mut answer = String::new();
        for line in stdout
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
        {
            let Ok(event) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            match event.get("type").and_then(Value::as_str) {
                Some("thread.started") => {
                    if let Some(thread_id) = event.get("thread_id").and_then(Value::as_str) {
                        self.thread_id = Some(thread_id.to_string());
                    }
                }
                Some("item.completed") => {
                    let item = event.get("item").unwrap_or(&Value::Null);
                    if item.get("type").and_then(Value::as_str) == Some("agent_message") {
                        if let Some(text) = item.get("text").and_then(Value::as_str) {
                            answer = text.to_string();
                        }
                    }
                }
                Some("event_msg") => {
                    let payload = event.get("payload").unwrap_or(&Value::Null);
                    if payload.get("type").and_then(Value::as_str) == Some("agent_message") {
                        if let Some(text) = payload.get("message").and_then(Value::as_str) {
                            answer = text.to_string();
                        }
                    }
                }
                _ => {}
            }
        }
        if self.thread_id.is_none() {
            return Err("codex planner produced no thread id".to_string());
        }
        if answer.trim().is_empty() {
            return Err("codex planner produced no answer".to_string());
        }
        Ok(answer)
    }

    fn send_turn(&mut self, prompt: &str, image_b64: Option<&str>) -> Result<String, String> {
        let image_path = Self::image_path(image_b64)?;
        let mut args = vec!["exec".to_string()];
        if let Some(thread_id) = &self.thread_id {
            args.extend(["resume".to_string(), thread_id.clone()]);
        }
        args.extend([
            "--json".to_string(),
            "-c".to_string(),
            "sandbox_mode=read-only".to_string(),
            "-c".to_string(),
            format!("model={}", self.model),
            "-c".to_string(),
            format!("model_reasoning_effort={}", self.effort),
            "-c".to_string(),
            "tools.image_generation=false".to_string(),
            "--ignore-user-config".to_string(),
        ]);
        // Every planner process runs from the system temp directory. The first
        // process starts the Codex thread, while later tool-result turns use
        // `exec resume`; both commands enforce repository trust independently.
        args.push("--skip-git-repo-check".to_string());
        if let Some(path) = &image_path {
            args.extend(["--image".to_string(), path.to_string_lossy().to_string()]);
        }
        args.extend(["--".to_string(), prompt.to_string()]);

        let output = Command::new(&self.binary)
            .args(&args)
            .current_dir(std::env::temp_dir())
            .env("PATH", super::claude::path_with_node_runtime())
            .env("FORCE_COLOR", "0")
            .env("NO_COLOR", "1")
            .env("O8_MANAGED_SESSION", "1")
            .output()
            .map_err(|error| format!("codex planner spawn failed: {error}"));
        if let Some(path) = image_path {
            let _ = std::fs::remove_file(path);
        }
        let output = output?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "codex planner exited {}: {}",
                output.status.code().unwrap_or(-1),
                stderr.trim().chars().take(500).collect::<String>()
            ));
        }
        self.parse_output(&String::from_utf8_lossy(&output.stdout))
    }
}

impl TextPlannerSession for CodexSession {
    fn send_planner_turn(
        &mut self,
        prompt: &str,
        image_b64: Option<&str>,
    ) -> Result<String, String> {
        self.send_turn(prompt, image_b64)
    }
}

pub async fn run_loop(
    binary: &str,
    model: &str,
    effort: &str,
    intent: &str,
    ctx: &TaskCtx,
) -> Result<LoopResult, String> {
    super::claude::run_text_planner_loop(
        CodexSession::new(binary, model, effort),
        model,
        intent,
        ctx,
        "codex",
    )
    .await
}

pub async fn run_phone_text_loop(
    binary: &str,
    model: &str,
    effort: &str,
    intent: &str,
    ctx: &TaskCtx,
    correlation: ConfirmCorrelation,
) -> Result<LoopResult, String> {
    super::claude::run_text_planner_loop_correlated(
        CodexSession::new(binary, model, effort),
        model,
        intent,
        ctx,
        "codex",
        correlation,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn parses_codex_thread_and_agent_message() {
        let mut session = CodexSession::new("/mock/codex", "gpt-5.6-sol", "medium");
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
    fn fresh_text_session_trusts_temp_workdir_on_initial_and_resumed_turns() {
        let fixture_dir = std::env::temp_dir().join(format!(
            "o8-codex-planner-args-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&fixture_dir).unwrap();
        let capture_path = fixture_dir.join("args.txt");
        let binary_path = fixture_dir.join("codex-fixture");
        let script = format!(
            r#"#!/bin/sh
has_skip=0
for arg in "$@"; do
  printf '%s\n' "$arg" >> '{}'
  if [ "$arg" = "--skip-git-repo-check" ]; then has_skip=1; fi
done
printf '%s\n' '__END__' >> '{}'
if [ "$has_skip" -ne 1 ]; then
  printf '%s\n' 'Not inside a trusted directory and --skip-git-repo-check was not specified.' >&2
  exit 1
fi
printf '%s\n' '{{"type":"thread.started","thread_id":"thread-1"}}'
printf '%s\n' '{{"type":"item.completed","item":{{"type":"agent_message","text":"{{\"done\":true,\"say\":\"Ready.\"}}"}}}}'
"#,
            capture_path.display(),
            capture_path.display()
        );
        std::fs::write(&binary_path, script).unwrap();
        std::fs::set_permissions(&binary_path, std::fs::Permissions::from_mode(0o755)).unwrap();

        let mut session = CodexSession::new(binary_path.to_str().unwrap(), "gpt-5.6-sol", "xhigh");
        session.send_turn("First user turn", None).unwrap();
        session.send_turn("Tool result follow-up", None).unwrap();

        let captured = std::fs::read_to_string(&capture_path).unwrap();
        let invocations = captured
            .split("__END__\n")
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>();
        assert_eq!(invocations.len(), 2);
        assert!(invocations[0]
            .lines()
            .any(|arg| arg == "--skip-git-repo-check"));
        assert_eq!(
            invocations[1].lines().take(3).collect::<Vec<_>>(),
            ["exec", "resume", "thread-1",]
        );
        assert!(invocations[1]
            .lines()
            .any(|arg| arg == "--skip-git-repo-check"));

        std::fs::remove_dir_all(fixture_dir).unwrap();
    }
}
