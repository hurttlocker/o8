use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use uuid::Uuid;

const DIRECTORY: &str = "cli-operation-admission";
const PREPARE_TTL: Duration = Duration::from_secs(30);

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Operation {
    version: u8,
    id: String,
    kind: String,
    pid: u32,
    #[serde(default)]
    runtime: Option<String>,
    started_at: String,
    stage: String,
}

struct Pending {
    id: String,
    deadline: Instant,
    committed: bool,
    force: bool,
}

/// The app supplies its canonical data directory and existing child cleanup.
/// Node installers and both native restart entries share this persisted slot.
#[derive(Clone)]
pub struct RestartSafety {
    data_dir: PathBuf,
    pending: Arc<Mutex<Option<Pending>>>,
    before_restart: Arc<dyn Fn() + Send + Sync>,
    inspect_work: Arc<dyn Fn(&str, bool) -> Result<(), String> + Send + Sync>,
}

fn refusal(detail: &str) -> String {
    format!("cli_operation_blocked: {detail} No sessions were stopped.")
}

fn read_operation(directory: &Path) -> Option<Operation> {
    let metadata = fs::symlink_metadata(directory).ok()?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() { return None; }
    let entries: Vec<_> = fs::read_dir(directory).ok()?.collect::<Result<_, _>>().ok()?;
    if entries.len() != 1 { return None; }
    let owner_metadata = fs::symlink_metadata(entries[0].path()).ok()?;
    if !owner_metadata.is_file() || owner_metadata.file_type().is_symlink() { return None; }
    let operation: Operation = serde_json::from_slice(&fs::read(entries[0].path()).ok()?).ok()?;
    if operation.version != 1 || operation.pid == 0
        || Uuid::parse_str(&operation.id).is_err()
        || entries[0].file_name().to_str()? != format!("{}.json", operation.id)
    { return None; }
    Some(operation)
}

fn release(directory: &Path, id: &str) -> bool {
    let Some(operation) = read_operation(directory) else { return false; };
    if operation.id != id { return false; }
    // Unlink a unique owner file first. A stale cleanup cannot unlink the
    // replacement owner's name, and a nonempty directory is never removed.
    fs::remove_file(directory.join(format!("{id}.json"))).is_ok()
        && fs::remove_dir(directory).is_ok()
}

#[cfg(unix)]
fn owner_is_dead(pid: u32) -> bool {
    extern "C" { fn kill(pid: i32, signal: i32) -> i32; }
    if pid > i32::MAX as u32 { return false; }
    // ESRCH is the only proof of absence; permission failures remain held.
    unsafe { kill(pid as i32, 0) != 0 && std::io::Error::last_os_error().raw_os_error() == Some(3) }
}

#[cfg(not(unix))]
fn owner_is_dead(_pid: u32) -> bool { false }

/// Resolve once in the native process and pass this absolute path to sidecars.
/// Empty overrides follow the same fallback rule as the Node data resolver.
pub fn resolve_data_directory(primary: Option<&str>, legacy: Option<&str>, home: &Path, cwd: &Path) -> Result<PathBuf, &'static str> {
    let selected = primary.filter(|value| !value.is_empty()).or_else(|| legacy.filter(|value| !value.is_empty()))
        .map(PathBuf::from).unwrap_or_else(|| home.join(".o8"));
    let absolute = if selected.is_absolute() { selected } else {
        if !cwd.is_absolute() { return Err("A relative data directory needs an absolute native working directory."); }
        cwd.join(selected)
    };
    if !absolute.is_absolute() { return Err("The native data directory could not be resolved to an absolute path."); }
    // Match Node's lexical path joining before filesystem traversal. Resolving
    // symlinks first would send `link/../state` to a different admission slot.
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {},
            Component::ParentDir => { normalized.pop(); },
            other => normalized.push(other.as_os_str()),
        }
    }
    Ok(normalized)
}

impl RestartSafety {
    pub fn new(data_dir: PathBuf, before_restart: impl Fn() + Send + Sync + 'static) -> Self {
        Self { data_dir, pending: Arc::new(Mutex::new(None)), before_restart: Arc::new(before_restart), inspect_work: Arc::new(|_, _| Ok(())) }
    }

    pub fn with_work_inspection(mut self, inspect: impl Fn(&str, bool) -> Result<(), String> + Send + Sync + 'static) -> Self {
        self.inspect_work = Arc::new(inspect);
        self
    }

    fn check_launches(&self, force: bool) -> Result<(), String> {
        let entries = match fs::read_dir(self.data_dir.join("work-launches")) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err(refusal("Work launch inventory is unavailable.")),
        };
        for entry in entries {
            let entry = entry.map_err(|_| refusal("Work launch ownership is unavailable."))?;
            let metadata = fs::symlink_metadata(entry.path()).map_err(|_| refusal("Work launch ownership changed."))?;
            if !metadata.is_file() || metadata.file_type().is_symlink() { return Err(refusal("Work launch ownership is unconfirmed.")); }
            let work: serde_json::Value = serde_json::from_slice(&fs::read(entry.path()).map_err(|_| refusal("Work launch ownership is unavailable."))?)
                .map_err(|_| refusal("Work launch ownership is unconfirmed."))?;
            let id = work["id"].as_str().ok_or_else(|| refusal("Work launch ownership is unconfirmed."))?;
            if Uuid::parse_str(id).is_err() || entry.file_name().to_str() != Some(&format!("{id}.json")) {
                return Err(refusal("Work launch ownership is unconfirmed."));
            }
            let pid = work["pid"].as_u64().filter(|pid| *pid > 0 && *pid <= i32::MAX as u64);
            if pid.is_some_and(|pid| owner_is_dead(pid as u32)) { continue; }
            let label = work["label"].as_str().unwrap_or("Starting process");
            // An unacknowledged spawn cannot be interrupted safely, even by force.
            if !force || pid.is_none() { return Err(refusal(&format!("Waiting for {label}."))); }
        }
        Ok(())
    }

    pub fn data_directory(&self) -> PathBuf { self.data_dir.clone() }

    pub fn prepare(&self) -> Result<String, String> { self.prepare_with_work(false) }

    pub fn prepare_with_work(&self, force: bool) -> Result<String, String> {
        let mut pending = self.pending.lock().map_err(|_| refusal("Restart ownership is unavailable."))?;
        if let Some(existing) = pending.as_ref() {
            if existing.committed || existing.deadline > Instant::now() {
                return Err(refusal("A restart is already reserved."));
            }
            release(&self.data_dir.join(DIRECTORY), &existing.id);
            *pending = None;
        }
        fs::create_dir_all(&self.data_dir).map_err(|_| refusal("CLI update ownership could not be checked."))?;
        let directory = self.data_dir.join(DIRECTORY);
        if let Some(previous) = read_operation(&directory) {
            if previous.kind == "restart" && owner_is_dead(previous.pid) { release(&directory, &previous.id); }
        }
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        builder.mode(0o700);
        builder.create(&directory).map_err(|_| refusal("A CLI update or restart is active, interrupted, or needs ownership recovery."))?;
        let id = Uuid::new_v4().to_string();
        let operation = Operation { version: 1, id: id.clone(), kind: "restart".into(),
            pid: std::process::id(), runtime: None,
            started_at: format!("{:?}", std::time::SystemTime::now()), stage: "preparing".into() };
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let saved = options.open(directory.join(format!("{id}.json")))
            .and_then(|mut file| file.write_all(&serde_json::to_vec(&operation).unwrap()));
        if saved.is_err() { let _ = fs::remove_dir(&directory); return Err(refusal("Restart ownership could not be recorded.")); }
        let legacy = match fs::read_dir(&self.data_dir) {
            Ok(mut entries) => entries.any(|entry| entry.map(|entry| entry.file_name().to_string_lossy().ends_with("-cli-update.lock")).unwrap_or(true)),
            Err(_) => {
                release(&directory, &id);
                return Err(refusal("CLI update ownership could not be checked."));
            }
        };
        if legacy {
            release(&directory, &id);
            return Err(refusal("A CLI update lock needs completion or verified recovery."));
        }
        if let Err(error) = self.check_launches(force) { release(&directory, &id); return Err(error); }
        *pending = Some(Pending { id: id.clone(), deadline: Instant::now() + PREPARE_TTL, committed: false, force });
        let state = self.clone();
        let expiring = id.clone();
        std::thread::spawn(move || { std::thread::sleep(PREPARE_TTL); let _ = state.cancel(&expiring); });
        Ok(id)
    }

    pub fn cancel(&self, id: &str) -> Result<(), String> {
        let mut pending = self.pending.lock().map_err(|_| refusal("Restart ownership is unavailable."))?;
        let Some(current) = pending.as_ref() else { return Err(refusal("The restart reservation is no longer current.")); };
        if current.id != id || current.committed { return Err(refusal("The restart reservation is no longer cancellable.")); }
        release(&self.data_dir.join(DIRECTORY), id);
        *pending = None;
        Ok(())
    }

    pub fn before_restart(&self, reservation: Option<&str>) -> Result<(), String> {
        let id = match reservation { Some(id) => id.to_string(), None => self.prepare()? };
        let mut pending = self.pending.lock().map_err(|_| refusal("Restart ownership is unavailable."))?;
        let Some(current) = pending.as_mut() else { return Err(refusal("The restart reservation expired.")); };
        let operation = read_operation(&self.data_dir.join(DIRECTORY));
        if current.id != id || current.committed || current.deadline <= Instant::now()
            || !operation.as_ref().is_some_and(|owner| owner.id == id && owner.kind == "restart" && owner.pid == std::process::id())
        { return Err(refusal("Restart ownership changed or expired. Retry from the current window.")); }
        let legacy = fs::read_dir(&self.data_dir).map_err(|_| refusal("CLI update ownership could not be checked."))?
            .any(|entry| entry.map(|entry| entry.file_name().to_string_lossy().ends_with("-cli-update.lock")).unwrap_or(true));
        if legacy { return Err(refusal("A CLI update lock appeared before restart; verify its completion or recovery.")); }
        self.check_launches(current.force)?;
        (self.inspect_work)(&id, current.force)?;
        // Inspection crosses the server boundary. Legacy installers may predate
        // shared admission, so recheck their holds immediately before cleanup.
        self.check_launches(current.force)?;
        let legacy = fs::read_dir(&self.data_dir).map_err(|_| refusal("CLI update ownership could not be checked."))?
            .any(|entry| entry.map(|entry| entry.file_name().to_string_lossy().ends_with("-cli-update.lock")).unwrap_or(true));
        if legacy { return Err(refusal("A CLI update appeared during final inspection.")); }
        if current.deadline <= Instant::now() { return Err(refusal("Restart inspection exceeded its reservation. Retry.")); }
        current.committed = true;
        drop(pending);
        (self.before_restart)();
        std::thread::sleep(Duration::from_millis(300));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn fixture() -> (PathBuf, RestartSafety, Arc<AtomicUsize>) {
        let root = std::env::temp_dir().join(format!("o8-restart-safety-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let calls = Arc::new(AtomicUsize::new(0)); let recorded = calls.clone();
        let state = RestartSafety::new(root.clone(), move || { recorded.fetch_add(1, Ordering::SeqCst); });
        (root, state, calls)
    }

    #[test]
    fn directory_selection_ignores_blank_primary_and_anchors_relative_overrides() {
        let cwd = std::env::temp_dir().join("o8-native-cwd");
        let home = std::env::temp_dir().join("o8-test-home");
        assert_eq!(resolve_data_directory(Some(""), Some("legacy"), &home, &cwd).unwrap(), cwd.join("legacy"));
        assert_eq!(resolve_data_directory(Some(""), Some(""), &home, &cwd).unwrap(), home.join(".o8"));
        assert_eq!(resolve_data_directory(Some("state"), Some("legacy"), &home, &cwd).unwrap(), cwd.join("state"));
        assert_eq!(resolve_data_directory(Some(home.to_str().unwrap()), None, &home, Path::new("")).unwrap(), home);
    }

    #[test]
    fn directory_selection_normalizes_dot_segments_without_crossing_the_root() {
        let cwd = std::env::temp_dir().join("o8-native-cwd");
        let home = std::env::temp_dir().join("o8-test-home");
        assert_eq!(resolve_data_directory(Some("./one/../state"), None, &home, &cwd).unwrap(), cwd.join("state"));
        let root = cwd.ancestors().last().unwrap();
        assert_eq!(resolve_data_directory(Some(root.join("../state").to_str().unwrap()), None, &home, &cwd).unwrap(), root.join("state"));
        assert!(resolve_data_directory(Some("state"), None, &home, Path::new("")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_parent_override_uses_the_same_lexical_installer_slot() {
        let root = std::env::temp_dir().join(format!("o8-restart-root-{}", Uuid::new_v4()));
        let expected = root.join("left/state");
        let traversed = root.join("other/state");
        fs::create_dir_all(&expected).unwrap();
        fs::create_dir_all(root.join("other/tree")).unwrap();
        fs::create_dir_all(&traversed).unwrap();
        std::os::unix::fs::symlink(root.join("other/tree"), root.join("left/link")).unwrap();
        fs::write(expected.join("codex-cli-update.lock"), "installer at Node's lexical root").unwrap();
        let selected = root.join("left/link/../state");
        let resolved = resolve_data_directory(Some(selected.to_str().unwrap()), None, &root, &root).unwrap();
        assert_eq!(resolved, expected);
        let calls = Arc::new(AtomicUsize::new(0));
        let recorded = calls.clone();
        let state = RestartSafety::new(resolved, move || { recorded.fetch_add(1, Ordering::SeqCst); });
        assert!(state.before_restart(None).is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(!traversed.join(DIRECTORY).exists());
        assert_eq!(fs::read_to_string(expected.join("codex-cli-update.lock")).unwrap(), "installer at Node's lexical root");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn installer_and_legacy_locks_refuse_before_child_cleanup() {
        let (root, state, calls) = fixture();
        fs::create_dir(root.join(DIRECTORY)).unwrap();
        assert!(state.before_restart(None).is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        fs::remove_dir(root.join(DIRECTORY)).unwrap();
        fs::write(root.join("codex-cli-update.lock"), "legacy owner").unwrap();
        assert!(state.before_restart(None).is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(fs::read_to_string(root.join("codex-cli-update.lock")).unwrap(), "legacy owner");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reservation_survives_checks_until_native_commit() {
        let (root, state, calls) = fixture();
        let id = state.prepare().unwrap();
        assert!(state.prepare().is_err());
        assert!(root.join(DIRECTORY).exists());
        state.before_restart(Some(&id)).unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(state.cancel(&id).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_legacy_installer_appearing_after_prepare_refuses_before_cleanup() {
        let (root, state, calls) = fixture();
        let id = state.prepare().unwrap();
        fs::write(root.join("codex-cli-update.lock"), "later legacy owner").unwrap();
        assert!(state.before_restart(Some(&id)).is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        state.cancel(&id).unwrap();
        assert_eq!(fs::read_to_string(root.join("codex-cli-update.lock")).unwrap(), "later legacy owner");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn expired_preparation_never_runs_restart_side_effects() {
        let (root, state, calls) = fixture();
        let id = state.prepare().unwrap();
        state.pending.lock().unwrap().as_mut().unwrap().deadline = Instant::now() - Duration::from_secs(1);
        assert!(state.before_restart(Some(&id)).is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        state.cancel(&id).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cancelled_or_replaced_reservations_never_terminate_children() {
        let (root, state, calls) = fixture();
        let id = state.prepare().unwrap(); state.cancel(&id).unwrap();
        assert!(state.before_restart(Some(&id)).is_err());
        let other = state.prepare().unwrap();
        fs::rename(root.join(DIRECTORY), root.join("old-owner")).unwrap();
        fs::create_dir(root.join(DIRECTORY)).unwrap();
        fs::write(root.join(DIRECTORY).join("replacement"), "preserve").unwrap();
        assert!(state.before_restart(Some(&other)).is_err());
        state.cancel(&other).unwrap();
        assert!(root.join(DIRECTORY).join("replacement").exists());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn a_process_starting_after_an_earlier_idle_snapshot_refuses_cleanup() {
        let (root, state, calls) = fixture();
        fs::create_dir(root.join("work-launches")).unwrap();
        let id = Uuid::new_v4().to_string();
        fs::write(root.join("work-launches").join(format!("{id}.json")),
            serde_json::json!({"id": id, "label": "Late terminal", "ownerPid": std::process::id(), "pid": std::process::id()}).to_string()).unwrap();
        assert!(state.before_restart(None).is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn force_never_interrupts_cli_installers_or_unacknowledged_starts() {
        let (root, state, calls) = fixture();
        fs::write(root.join("codex-cli-update.lock"), "CLI installer").unwrap();
        assert!(state.prepare_with_work(true).is_err());
        fs::remove_file(root.join("codex-cli-update.lock")).unwrap();
        fs::create_dir(root.join("work-launches")).unwrap();
        let id = Uuid::new_v4().to_string();
        let file = root.join("work-launches").join(format!("{id}.json"));
        fs::write(&file, serde_json::json!({"id": id, "label": "Queued terminal", "ownerPid": std::process::id(), "pid": null}).to_string()).unwrap();
        assert!(state.prepare_with_work(true).is_err());
        fs::write(&file, serde_json::json!({"id": id, "label": "Live terminal", "ownerPid": std::process::id(), "pid": std::process::id()}).to_string()).unwrap();
        let reservation = state.prepare_with_work(true).unwrap();
        state.before_restart(Some(&reservation)).unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn final_inspection_is_under_reservation_and_refuses_before_cleanup() {
        let (root, state, calls) = fixture();
        let directory = root.clone();
        let state = state.with_work_inspection(move |id, _| {
            assert_eq!(read_operation(&directory.join(DIRECTORY)).unwrap().id, id);
            Err("Late managed run".into())
        });
        let id = state.prepare().unwrap();
        assert!(state.before_restart(Some(&id)).is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        state.cancel(&id).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_legacy_installer_appearing_during_final_inspection_still_refuses_force() {
        let (root, state, calls) = fixture();
        let directory = root.clone();
        let state = state.with_work_inspection(move |_, force| {
            assert!(force);
            fs::write(directory.join("codex-cli-update.lock"), "installer started during inspection").unwrap();
            Ok(())
        });
        let id = state.prepare_with_work(true).unwrap();
        assert!(state.before_restart(Some(&id)).is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        state.cancel(&id).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

}
