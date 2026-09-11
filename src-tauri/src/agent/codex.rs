//! Symon voice-agent text planner backed by the Codex subscription CLI.
//!
//! ## Process shape (#2155)
//! Turn 1 boots ONE resident `codex app-server --stdio` child and keeps it for
//! the whole task: `initialize` → `thread/start` → one `turn/start` per planner
//! turn, so turn 2+ pays no process start. (The Claude planner has held a
//! resident stream-json child since #1252; this closes the same gap on the
//! Codex side, where every turn used to cold-spawn `codex exec`.)
//!
//! The child runs against a MANAGED `CODEX_HOME` under the agent data dir — a
//! minimal `config.toml` plus the operator's copied auth files — because
//! `app-server` has no `--ignore-user-config` flag and would otherwise inherit
//! the operator's own model pins and MCP servers. Codex plugins installed
//! globally still register their MCP servers; that exposure is unchanged from
//! the `codex exec` path, and what keeps the seat safe is the same pair as
//! before: the read-only sandbox and the JSON-only planner contract.
//!
//! `codex exec` stays as the fallback. `app-server` is flagged experimental, so
//! if the handshake fails (an older CLI, a protocol change) the session
//! degrades to the previous per-turn `codex exec` / `exec resume` spawn instead
//! of failing the task.

use super::{claude::TextPlannerSession, ConfirmCorrelation, LoopResult, TaskCtx};
use base64::Engine;
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};

const APP_SERVER_CLIENT_NAME: &str = "o8-symon-planner";

pub(crate) struct CodexSession {
    binary: String,
    model: String,
    effort: String,
    /// Live app-server child. `None` before the first turn and after a boot
    /// failure has dropped this session onto the `codex exec` fallback.
    resident: Option<AppServerSession>,
    /// Boot is attempted exactly once per session; a failure is not retried on
    /// every turn.
    resident_attempted: bool,
    /// `codex exec` fallback thread id, used by `exec resume`.
    thread_id: Option<String>,
}

impl CodexSession {
    fn new(binary: &str, model: &str, effort: &str) -> Self {
        Self {
            binary: binary.to_string(),
            model: model.to_string(),
            effort: effort.to_string(),
            resident: None,
            resident_attempted: false,
            thread_id: None,
        }
    }

    fn image_path(image_b64: Option<&str>) -> Result<Option<PathBuf>, String> {
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
        if !self.resident_attempted {
            self.resident_attempted = true;
            match AppServerSession::start(&self.binary, &self.model, &self.effort) {
                Ok(session) => {
                    log::info!(
                        "[symon-agent] codex planner resident on {} (effort {})",
                        self.model,
                        self.effort
                    );
                    self.resident = Some(session);
                }
                Err(error) => log::warn!(
                    "[symon-agent] codex app-server unavailable ({error}) — falling back to per-turn exec"
                ),
            }
        }
        let image_path = Self::image_path(image_b64)?;
        let result = match self.resident.as_mut() {
            Some(session) => {
                let turn = session.send_turn(prompt, image_path.as_deref());
                if turn.is_err() {
                    // A broken child is dropped (its Drop kills the proc) so a
                    // later turn re-boots or falls back instead of writing into
                    // a dead pipe.
                    self.resident = None;
                }
                turn
            }
            None => self.send_turn_exec(prompt, image_path.as_deref()),
        };
        if let Some(path) = image_path {
            let _ = std::fs::remove_file(path);
        }
        result
    }

    /// Per-turn `codex exec` spawn — the pre-#2155 shape, kept as the fallback
    /// for CLIs whose `app-server` handshake does not come up.
    fn send_turn_exec(
        &mut self,
        prompt: &str,
        image_path: Option<&std::path::Path>,
    ) -> Result<String, String> {
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
        if let Some(path) = image_path {
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
            .map_err(|error| format!("codex planner spawn failed: {error}"))?;
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

/// The operator's own Codex home — the source of the auth files copied into the
/// managed planner home.
fn user_codex_home() -> PathBuf {
    if let Ok(home) = std::env::var("CODEX_HOME") {
        if !home.trim().is_empty() {
            return PathBuf::from(home);
        }
    }
    PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".codex")
}

/// Materialize the managed `CODEX_HOME` for the resident planner: a minimal
/// `config.toml` pinning the seat plus the operator's auth files, re-synced on
/// every boot so a refreshed token is picked up. `model` and `effort` come from
/// `planner_route`'s allow-listed catalog constants, never from free text.
fn ensure_planner_codex_home(model: &str, effort: &str) -> Result<PathBuf, String> {
    let home = super::agent_data_dir().join("codex-planner-home");
    std::fs::create_dir_all(&home)
        .map_err(|error| format!("codex planner home create failed: {error}"))?;
    std::fs::write(
        home.join("config.toml"),
        format!(
            "model = \"{model}\"\n\
             model_reasoning_effort = \"{effort}\"\n\
             approval_policy = \"never\"\n\
             sandbox_mode = \"read-only\"\n\
             \n\
             [tools]\n\
             image_generation = false\n"
        ),
    )
    .map_err(|error| format!("codex planner config write failed: {error}"))?;
    let source_home = user_codex_home();
    for name in ["auth.json", "installation_id", "version.json"] {
        let source = source_home.join(name);
        if !source.exists() {
            continue;
        }
        let destination = home.join(name);
        if std::fs::copy(&source, &destination).is_err() {
            continue;
        }
        #[cfg(unix)]
        if name == "auth.json" {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&destination, std::fs::Permissions::from_mode(0o600));
        }
    }
    Ok(home)
}

/// A LIVE `codex app-server` child held across a task's turns. NDJSON JSON-RPC
/// over stdio: one `turn/start` request per planner turn, pumped until this
/// thread's `turn/completed` notification arrives.
struct AppServerSession {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    reader: std::io::BufReader<std::process::ChildStdout>,
    thread_id: String,
    next_id: u64,
}

impl AppServerSession {
    fn start(binary: &str, model: &str, effort: &str) -> Result<Self, String> {
        let home = ensure_planner_codex_home(model, effort)?;
        let mut child = Command::new(binary)
            .args([
                "app-server",
                "--stdio",
                "-c",
                "sandbox_mode=read-only",
                "-c",
                "tools.image_generation=false",
                "-c",
                "mcp_servers={}",
            ])
            .current_dir(std::env::temp_dir())
            .env("CODEX_HOME", &home)
            .env("PATH", super::claude::path_with_node_runtime())
            .env("FORCE_COLOR", "0")
            .env("NO_COLOR", "1")
            .env("O8_MANAGED_SESSION", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Drop stderr — an unread pipe fills and deadlocks the read loop;
            // JSON-RPC errors come back on stdout.
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("codex app-server spawn failed: {error}"))?;
        let stdin = child.stdin.take().ok_or("codex app-server: no stdin handle")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("codex app-server: no stdout handle")?;
        let mut session = Self {
            child,
            stdin,
            reader: std::io::BufReader::new(stdout),
            thread_id: String::new(),
            next_id: 1,
        };
        session.request(
            "initialize",
            json!({
                "clientInfo": { "name": APP_SERVER_CLIENT_NAME, "version": "1" },
            }),
        )?;
        session.write(json!({ "method": "initialized", "params": {} }))?;
        let started = session.request(
            "thread/start",
            json!({
                "model": model,
                "cwd": std::env::temp_dir().to_string_lossy(),
                "approvalPolicy": "never",
                "config": {
                    "model_reasoning_effort": effort,
                    "sandbox_mode": "read-only",
                },
            }),
        )?;
        let thread_id = started
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .ok_or("codex app-server returned no thread id")?;
        session.thread_id = thread_id.to_string();
        Ok(session)
    }

    fn write(&mut self, message: Value) -> Result<(), String> {
        writeln!(self.stdin, "{message}")
            .map_err(|error| format!("codex app-server stdin write: {error}"))?;
        self.stdin
            .flush()
            .map_err(|error| format!("codex app-server stdin flush: {error}"))
    }

    /// Read stdout until `visit` claims a message. Server→client requests are
    /// refused inline (the planner grants no approvals) so an unanswered
    /// request can never wedge the turn.
    fn pump<T>(
        &mut self,
        mut visit: impl FnMut(&Value) -> Option<Result<T, String>>,
    ) -> Result<T, String> {
        let mut line = String::new();
        loop {
            line.clear();
            match self.reader.read_line(&mut line) {
                Ok(0) => return Err("codex app-server exited".to_string()),
                Ok(_) => {}
                Err(error) => return Err(format!("codex app-server read: {error}")),
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(message) = serde_json::from_str::<Value>(trimmed) else {
                continue;
            };
            if let Some(outcome) = visit(&message) {
                return outcome;
            }
            let is_server_request = message.get("id").is_some()
                && message.get("method").is_some()
                && message.get("result").is_none()
                && message.get("error").is_none();
            if is_server_request {
                let id = message.get("id").cloned().unwrap_or(Value::Null);
                self.write(json!({
                    "id": id,
                    "error": { "code": -32601, "message": "the Symon planner grants no approvals" },
                }))?;
            }
        }
    }

    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.write(json!({ "id": id, "method": method, "params": params }))?;
        self.pump(|message| {
            if message.get("id").and_then(Value::as_u64) != Some(id) {
                return None;
            }
            if let Some(error) = message.get("error") {
                return Some(Err(format!("codex app-server {method}: {error}")));
            }
            message.get("result").map(|result| Ok(result.clone()))
        })
    }

    fn send_turn(
        &mut self,
        prompt: &str,
        image_path: Option<&std::path::Path>,
    ) -> Result<String, String> {
        let mut input = vec![json!({ "type": "text", "text": prompt })];
        if let Some(path) = image_path {
            input.push(json!({ "type": "localImage", "path": path.to_string_lossy() }));
        }
        let id = self.next_id;
        self.next_id += 1;
        self.write(json!({
            "id": id,
            "method": "turn/start",
            "params": { "threadId": self.thread_id, "input": input },
        }))?;
        let mut answer = String::new();
        self.pump(|message| {
            if message.get("id").and_then(Value::as_u64) == Some(id) {
                if let Some(error) = message.get("error") {
                    return Some(Err(format!("codex app-server turn/start: {error}")));
                }
                return None;
            }
            match message.get("method").and_then(Value::as_str) {
                Some("item/completed") => {
                    let item = message.pointer("/params/item").unwrap_or(&Value::Null);
                    if item.get("type").and_then(Value::as_str) == Some("agentMessage") {
                        if let Some(text) = item.get("text").and_then(Value::as_str) {
                            answer = text.to_string();
                        }
                    }
                    None
                }
                Some("turn/completed") => Some(Ok(())),
                Some("error") => Some(Err(format!(
                    "codex app-server error: {}",
                    message
                        .pointer("/params/message")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                ))),
                _ => None,
            }
        })?;
        if answer.trim().is_empty() {
            return Err("codex planner produced no answer".to_string());
        }
        Ok(answer)
    }
}

impl Drop for AppServerSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
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
#[path = "codex_tests.rs"]
mod tests;
