//! Per-session Symon machine routing and the SSH transport boundary.

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Emitter;

use super::{tools, TaskCtx};

const LOCAL_MACHINE_ID: &str = "local";
const SWITCH_SETTLE_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineIdentity {
    pub id: String,
    pub display_name: String,
}

#[derive(Clone, Copy)]
struct MachineConfig {
    id: &'static str,
    display_name: &'static str,
    ssh_target: Option<&'static str>,
}

const MACHINES: [MachineConfig; 2] = [
    MachineConfig {
        id: LOCAL_MACHINE_ID,
        display_name: "This Mac",
        ssh_target: None,
    },
    MachineConfig {
        id: "macbook",
        display_name: "MacBook",
        ssh_target: Some("coldgame@macbook"),
    },
];

#[derive(Default)]
struct SessionMachineState {
    machine_id: String,
    in_flight: usize,
    switching: bool,
}

static SESSION_STATES: OnceLock<Mutex<HashMap<String, SessionMachineState>>> = OnceLock::new();

fn states() -> &'static Mutex<HashMap<String, SessionMachineState>> {
    SESSION_STATES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn config(machine_id: &str) -> Option<MachineConfig> {
    MACHINES
        .iter()
        .copied()
        .find(|machine| machine.id == machine_id)
}

fn identity(machine_id: &str) -> MachineIdentity {
    let machine = config(machine_id).unwrap_or(MACHINES[0]);
    MachineIdentity {
        id: machine.id.to_string(),
        display_name: machine.display_name.to_string(),
    }
}

pub fn active_machine(session_id: &str) -> MachineIdentity {
    let mut all = states()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let state = all.entry(session_id.to_string()).or_default();
    if state.machine_id.is_empty() {
        state.machine_id = LOCAL_MACHINE_ID.to_string();
    }
    identity(&state.machine_id)
}

struct ExecutionLease {
    session_id: String,
    machine: MachineConfig,
}

impl Drop for ExecutionLease {
    fn drop(&mut self) {
        let mut all = states()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(state) = all.get_mut(&self.session_id) {
            state.in_flight = state.in_flight.saturating_sub(1);
        }
    }
}

fn acquire_execution(session_id: &str) -> Result<ExecutionLease, String> {
    let mut all = states()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let state = all.entry(session_id.to_string()).or_default();
    if state.machine_id.is_empty() {
        state.machine_id = LOCAL_MACHINE_ID.to_string();
    }
    if state.switching {
        return Err("Symon is switching machines; wait for the handoff to finish".to_string());
    }
    let machine = config(&state.machine_id)
        .ok_or_else(|| "The active Symon machine is no longer registered".to_string())?;
    state.in_flight += 1;
    Ok(ExecutionLease {
        session_id: session_id.to_string(),
        machine,
    })
}

pub async fn switch_machine(session_id: &str, machine_id: &str) -> Result<Value, String> {
    let target =
        config(machine_id.trim()).ok_or_else(|| format!("Unknown Symon machine: {machine_id}"))?;
    if super::has_pending_confirmations() {
        return Err("Resolve the pending confirmation card before switching machines".to_string());
    }
    {
        let mut all = states()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let state = all.entry(session_id.to_string()).or_default();
        if state.machine_id.is_empty() {
            state.machine_id = LOCAL_MACHINE_ID.to_string();
        }
        if state.machine_id == target.id {
            return Ok(json!({ "switched": false, "activeMachine": identity(target.id) }));
        }
        if state.switching {
            return Err("A Symon machine handoff is already in progress".to_string());
        }
        state.switching = true;
    }

    let deadline = Instant::now() + SWITCH_SETTLE_TIMEOUT;
    loop {
        let settled = {
            let all = states()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            all.get(session_id).is_none_or(|state| state.in_flight == 0)
        };
        if settled {
            break;
        }
        if Instant::now() >= deadline {
            let mut all = states()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(state) = all.get_mut(session_id) {
                state.switching = false;
            }
            return Err(
                "Active work did not settle; Symon stayed on the current machine".to_string(),
            );
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    let active = {
        let mut all = states()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let state = all.entry(session_id.to_string()).or_default();
        state.machine_id = target.id.to_string();
        state.switching = false;
        identity(target.id)
    };
    Ok(json!({ "switched": true, "activeMachine": active }))
}

fn local_control_tool(name: &str) -> bool {
    matches!(name, "symon_machine_list" | "symon_machine_switch")
}

fn unsupported_remotely(name: &str) -> bool {
    matches!(
        name,
        "apply_text_edit"
            | "read_screen"
            | "o8_ui_open"
            | "o8_ui_set"
            | "o8_canvas"
            | "o8_orchestrator_draft"
            | "term_watch"
            | "symon_ledger_recent"
            | "symon_ledger_undo"
    )
}

pub async fn dispatch_tool_call(name: &str, args: Value, ctx: &TaskCtx) -> Result<Value, String> {
    dispatch_tool_call_with_spawner(name, args, ctx, Arc::new(SystemProcessSpawner)).await
}

async fn dispatch_tool_call_with_spawner(
    name: &str,
    args: Value,
    ctx: &TaskCtx,
    spawner: Arc<dyn ProcessSpawner>,
) -> Result<Value, String> {
    if name == "symon_machine_list" {
        return Ok(machine_list(&ctx.machine_session_id).await);
    }
    if name == "symon_machine_switch" {
        let machine_id = args.get("machine_id").and_then(Value::as_str).unwrap_or("");
        let result = switch_machine(&ctx.machine_session_id, machine_id).await?;
        if ctx.machine_session_id == "desktop" {
            if let Some(app) = ctx.app.as_ref() {
                if let Ok(active) =
                    serde_json::from_value::<MachineIdentity>(result["activeMachine"].clone())
                {
                    let _ = app.emit("o8:symon-machine", &active);
                }
            }
        }
        return Ok(result);
    }
    if local_control_tool(name) {
        return tools::dispatch_tool_call(name, args, ctx).await;
    }

    let lease = acquire_execution(&ctx.machine_session_id)?;
    if lease.machine.ssh_target.is_none() {
        return tools::dispatch_tool_call(name, args, ctx).await;
    }
    if unsupported_remotely(name) {
        return Err(format!(
            "{name} cannot honestly run on {}; switch Symon to This Mac first",
            lease.machine.display_name
        ));
    }
    let mut result = invoke_remote(&lease.machine, name, args, ctx, spawner).await?;
    if let Some(object) = result.as_object_mut() {
        object.insert("_symon_remote_execution".to_string(), Value::Bool(true));
    }
    Ok(result)
}

async fn machine_list(session_id: &str) -> Value {
    let remote = config("macbook").expect("static macbook config");
    let available = tokio::task::spawn_blocking(move || {
        SystemProcessSpawner
            .output("/usr/bin/ssh", &ssh_args(&remote, "/usr/bin/true"), &[])
            .is_ok_and(|output| output.success)
    })
    .await
    .unwrap_or(false);
    json!({
        "activeMachine": active_machine(session_id),
        "machines": [
            { "id": "local", "displayName": "This Mac", "transport": "local", "available": true },
            { "id": "macbook", "displayName": "MacBook", "transport": "ssh", "available": available },
        ]
    })
}

#[tauri::command]
pub fn symon_machine_status(session_id: Option<String>) -> MachineIdentity {
    active_machine(session_id.as_deref().unwrap_or("desktop"))
}

#[tauri::command]
pub async fn symon_machine_list(session_id: Option<String>) -> Value {
    machine_list(session_id.as_deref().unwrap_or("desktop")).await
}

#[tauri::command]
pub async fn symon_machine_switch(
    app: tauri::AppHandle,
    session_id: Option<String>,
    machine_id: String,
) -> Result<MachineIdentity, String> {
    let session_id = session_id.as_deref().unwrap_or("desktop");
    let result = switch_machine(session_id, &machine_id).await?;
    let active = serde_json::from_value::<MachineIdentity>(result["activeMachine"].clone())
        .map_err(|error| format!("Machine handoff returned invalid state: {error}"))?;
    let _ = app.emit("o8:symon-machine", &active);
    Ok(active)
}

#[derive(Debug)]
struct ProcessOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

trait ProcessSpawner: Send + Sync {
    fn output(&self, program: &str, args: &[String], stdin: &[u8])
        -> Result<ProcessOutput, String>;
}

struct SystemProcessSpawner;

impl ProcessSpawner for SystemProcessSpawner {
    fn output(
        &self,
        program: &str,
        args: &[String],
        stdin: &[u8],
    ) -> Result<ProcessOutput, String> {
        let mut child = Command::new(program)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("SSH transport could not start: {error}"))?;
        child
            .stdin
            .as_mut()
            .ok_or_else(|| "SSH transport stdin was unavailable".to_string())?
            .write_all(stdin)
            .map_err(|error| format!("SSH transport payload failed: {error}"))?;
        let output = child
            .wait_with_output()
            .map_err(|error| format!("SSH transport failed: {error}"))?;
        Ok(ProcessOutput {
            success: output.status.success(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}

fn ssh_args(machine: &MachineConfig, remote_script: &str) -> Vec<String> {
    vec![
        "-o".into(),
        "BatchMode=yes".into(),
        "-o".into(),
        "ConnectTimeout=3".into(),
        "-o".into(),
        "ConnectionAttempts=1".into(),
        machine.ssh_target.unwrap_or_default().into(),
        "/bin/zsh".into(),
        "-lc".into(),
        remote_script.into(),
    ]
}

const REMOTE_TOOL_SCRIPT: &str = r#"payload=$(/usr/bin/base64 -D); port=$(/bin/cat "$HOME/.o8/api-port"); token=$(/bin/cat "$HOME/.o8/ws-token"); /usr/bin/curl --fail-with-body --silent --show-error --max-time 125 -H "Authorization: Bearer $token" -H "Content-Type: application/json" --data "$payload" "http://127.0.0.1:$port/api/symon/transport/tool""#;

async fn invoke_remote(
    machine: &MachineConfig,
    name: &str,
    args: Value,
    ctx: &TaskCtx,
    spawner: Arc<dyn ProcessSpawner>,
) -> Result<Value, String> {
    let payload = serde_json::to_vec(&json!({
        "sessionId": ctx.machine_session_id,
        "callId": ctx.task_id,
        "tool": name,
        "args": args,
    }))
    .map_err(|error| format!("Remote tool payload could not be encoded: {error}"))?;
    let stdin = base64::engine::general_purpose::STANDARD
        .encode(payload)
        .into_bytes();
    let machine = *machine;
    let output = tokio::task::spawn_blocking(move || {
        run_remote_transport(spawner.as_ref(), &machine, &stdin)
    })
    .await
    .map_err(|error| format!("SSH transport task failed: {error}"))??;
    decode_remote_output(&machine, output)
}

fn run_remote_transport(
    spawner: &dyn ProcessSpawner,
    machine: &MachineConfig,
    stdin: &[u8],
) -> Result<ProcessOutput, String> {
    spawner.output(
        "/usr/bin/ssh",
        &ssh_args(machine, REMOTE_TOOL_SCRIPT),
        stdin,
    )
}

fn decode_remote_output(machine: &MachineConfig, output: ProcessOutput) -> Result<Value, String> {
    if !output.success {
        return Err(format!(
            "{} is unavailable over SSH: {}",
            machine.display_name,
            output.stderr.trim()
        ));
    }
    let response: Value = serde_json::from_str(output.stdout.trim())
        .map_err(|_| format!("{} returned an invalid tool response", machine.display_name))?;
    if response.get("ok") == Some(&Value::Bool(true)) {
        Ok(response.get("result").cloned().unwrap_or(Value::Null))
    } else {
        let result = response.get("result");
        Err(response
            .get("detail")
            .or_else(|| response.get("error"))
            .or_else(|| result.and_then(|value| value.get("detail")))
            .or_else(|| result.and_then(|value| value.get("error")))
            .and_then(Value::as_str)
            .unwrap_or("Remote tool execution failed")
            .to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    static MACHINE_TEST_LOCK: Mutex<()> = Mutex::new(());
    struct CaptureSpawner {
        seen: Arc<Mutex<Vec<(String, Vec<String>)>>>,
    }

    impl ProcessSpawner for CaptureSpawner {
        fn output(
            &self,
            program: &str,
            args: &[String],
            _stdin: &[u8],
        ) -> Result<ProcessOutput, String> {
            self.seen
                .lock()
                .unwrap()
                .push((program.to_string(), args.to_vec()));
            Ok(ProcessOutput {
                success: true,
                stdout: r#"{"ok":true,"result":{"spawned":true}}"#.into(),
                stderr: String::new(),
            })
        }
    }

    #[tokio::test]
    async fn active_remote_tool_uses_ssh_at_the_process_spawn_seam() {
        let _test_lock = MACHINE_TEST_LOCK.lock().unwrap();
        super::super::clear_confirmations_for_test();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let spawner = Arc::new(CaptureSpawner { seen: seen.clone() });
        let session_id = "test-remote-routing";
        switch_machine(session_id, "macbook").await.unwrap();
        let ctx = TaskCtx {
            task_id: "call-remote-routing".into(),
            utterance: "send this work to the MacBook".into(),
            ledger_session_id: Some(session_id.into()),
            machine_session_id: session_id.into(),
            app: None,
            screen: None,
            spatial: false,
            crop_png_base64: None,
            edit: None,
            cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        };
        let result = dispatch_tool_call_with_spawner(
            "agent_turn",
            json!({ "id": "t:101:1", "title": "MacBook work", "prompt": "inspect the repo" }),
            &ctx,
            spawner,
        )
        .await
        .unwrap();
        assert_eq!(result["spawned"], true);
        let captured = seen.lock().unwrap();
        assert_eq!(captured[0].0, "/usr/bin/ssh");
        assert!(captured[0].1.iter().any(|arg| arg == "coldgame@macbook"));
        assert!(captured[0]
            .1
            .windows(2)
            .any(|pair| pair == ["/bin/zsh", "-lc"]));
        let script = captured[0].1.last().unwrap();
        assert!(script.contains("/api/symon/transport/tool"));
        assert!(script.contains("/usr/bin/curl"));
        assert!(!captured[0].1.iter().any(|arg| arg == "node" || arg == "gh"));
        drop(captured);
        switch_machine(session_id, "local").await.unwrap();
    }

    #[tokio::test]
    async fn switch_refuses_while_a_confirmation_is_pending() {
        let _test_lock = MACHINE_TEST_LOCK.lock().unwrap();
        super::super::clear_confirmations_for_test();
        super::super::insert_pending_confirmation_for_test("switch-pending");
        let result = switch_machine("test-pending-session", "macbook").await;
        super::super::clear_confirmations_for_test();
        assert!(result.unwrap_err().contains("pending confirmation"));
        assert_eq!(active_machine("test-pending-session").id, LOCAL_MACHINE_ID);
    }

    #[tokio::test]
    async fn switch_waits_for_active_execution_before_flipping() {
        let _test_lock = MACHINE_TEST_LOCK.lock().unwrap();
        super::super::clear_confirmations_for_test();
        let session_id = "test-settled-switch";
        let lease = acquire_execution(session_id).unwrap();
        let release = async move {
            tokio::time::sleep(Duration::from_millis(40)).await;
            drop(lease);
        };
        let switching = switch_machine(session_id, "macbook");
        let (_, result) = tokio::join!(release, switching);
        assert!(result.unwrap()["switched"].as_bool().unwrap());
        assert_eq!(active_machine(session_id).id, "macbook");
        switch_machine(session_id, "local").await.unwrap();
    }
}
