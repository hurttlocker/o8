//! Read retained lifecycle ownership before allowing an app-owned backend.

use serde::Deserialize;
use std::path::Path;

#[derive(Deserialize)]
struct ProcessClaim {
    pid: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RetainedOwner {
    schema: String,
    pid: Option<u32>,
    supervisor_pid: Option<u32>,
    children: Option<Vec<ProcessClaim>>,
    shutdown_processes: Option<Vec<ProcessClaim>>,
    shutdown_owner: Option<String>,
}

pub(crate) fn retained_owner_reason(data_dir: &str, alive: impl Fn(u32) -> bool) -> Option<String> {
    let directory = Path::new(data_dir);
    for name in ["serve-operation.lock", "serve-state.json.lock"] {
        match std::fs::symlink_metadata(directory.join(name)) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            _ => return Some("a lifecycle operation still owns this profile".to_string()),
        }
    }
    let state_path = directory.join("serve-state.json");
    match std::fs::symlink_metadata(&state_path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(_) => return Some("retained lifecycle state cannot be inspected".to_string()),
    }
    let raw = match std::fs::read_to_string(&state_path) {
        Ok(raw) => raw,
        Err(_) => return Some("retained lifecycle state cannot be read".to_string()),
    };
    let state = match serde_json::from_str::<RetainedOwner>(&raw) {
        Ok(state) if state.schema == "o8/serve-state/v1" => state,
        _ => return Some("retained lifecycle state cannot be verified".to_string()),
    };
    if state.shutdown_owner.is_some()
        || state
            .shutdown_processes
            .as_ref()
            .is_some_and(|claims| !claims.is_empty())
    {
        return Some("unfinished shutdown retains this profile's ownership".to_string());
    }
    let pids: Vec<u32> = state
        .pid
        .into_iter()
        .chain(state.supervisor_pid)
        .chain(
            state
                .children
                .unwrap_or_default()
                .into_iter()
                .map(|child| child.pid),
        )
        .collect();
    if pids.is_empty() || pids.contains(&0) {
        return Some("retained lifecycle state has no verifiable process claims".to_string());
    }
    if pids.into_iter().any(alive) {
        return Some("a background server or supervisor still owns this profile".to_string());
    }
    None
}
