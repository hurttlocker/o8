mod lease_owner;
mod monotonic;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use uuid::Uuid;

#[cfg(test)]
thread_local! {
    static SETTLE_WRITER: std::cell::RefCell<Option<Box<dyn FnOnce(&Path)>>> = std::cell::RefCell::new(None);
}

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
    #[serde(default)]
    owner_pid: u32,
    #[serde(default)]
    owner_identity: serde_json::Value,
    #[serde(default)]
    created_at_ms: u128,
    #[serde(default)]
    created_monotonic_ms: Option<f64>,
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

#[cfg(test)]
fn read_operation(directory: &Path) -> Option<Operation> {
    let metadata = fs::symlink_metadata(directory).ok()?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return None;
    }
    let entries: Vec<_> = fs::read_dir(directory)
        .ok()?
        .collect::<Result<_, _>>()
        .ok()?;
    if entries.len() != 1 {
        return None;
    }
    let owner_metadata = fs::symlink_metadata(entries[0].path()).ok()?;
    if !owner_metadata.is_file() || owner_metadata.file_type().is_symlink() {
        return None;
    }
    let operation: Operation = serde_json::from_slice(&fs::read(entries[0].path()).ok()?).ok()?;
    if operation.version != 1
        || operation.pid == 0
        || Uuid::parse_str(&operation.id).is_err()
        || entries[0].file_name().to_str()? != format!("{}.json", operation.id)
    {
        return None;
    }
    Some(operation)
}

fn release(directory: &Path, id: &str) -> bool {
    let path = directory.join(format!("{id}.json"));
    let operation = fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Operation>(&bytes).ok());
    if !operation.is_some_and(|owner| owner.id == id) {
        return false;
    }
    if fs::remove_file(path).is_err() {
        return false;
    }
    let _ = fs::remove_dir(directory);
    true
}

/// Resolve once in the native process and pass this absolute path to sidecars.
/// Empty overrides follow the same fallback rule as the Node data resolver.
pub fn resolve_data_directory(
    primary: Option<&str>,
    legacy: Option<&str>,
    home: &Path,
    cwd: &Path,
) -> Result<PathBuf, &'static str> {
    let selected = primary
        .filter(|value| !value.is_empty())
        .or_else(|| legacy.filter(|value| !value.is_empty()))
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".o8"));
    let absolute = if selected.is_absolute() {
        selected
    } else {
        if !cwd.is_absolute() {
            return Err("A relative data directory needs an absolute native working directory.");
        }
        cwd.join(selected)
    };
    if !absolute.is_absolute() {
        return Err("The native data directory could not be resolved to an absolute path.");
    }
    // Match Node's lexical path joining before filesystem traversal. Resolving
    // symlinks first would send `link/../state` to a different admission slot.
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    Ok(normalized)
}

impl RestartSafety {
    pub fn new(data_dir: PathBuf, before_restart: impl Fn() + Send + Sync + 'static) -> Self {
        Self {
            data_dir,
            pending: Arc::new(Mutex::new(None)),
            before_restart: Arc::new(before_restart),
            inspect_work: Arc::new(|_, _| Ok(())),
        }
    }

    pub fn with_work_inspection(
        mut self,
        inspect: impl Fn(&str, bool) -> Result<(), String> + Send + Sync + 'static,
    ) -> Self {
        self.inspect_work = Arc::new(inspect);
        self
    }

    /// Recover every lease using the same owner and bounded-unbound protocol.
    fn check_leases(&self, force: bool) -> Result<(), String> {
        // Force records all owners instead of waiting for process probes. A slow
        // or unavailable liveness provider cannot turn a lease into a force veto.
        if force {
            return Ok(());
        }
        let mut paths = Vec::new();
        let launch_directory = self.data_dir.join("work-launches");
        if fs::symlink_metadata(&launch_directory)
            .is_ok_and(|m| !m.is_dir() || m.file_type().is_symlink())
        {
            return if force {
                Ok(())
            } else {
                Err(refusal("Work inventory is unconfirmed."))
            };
        }
        if let Ok(entries) = fs::read_dir(self.data_dir.join("work-launches")) {
            for entry in entries {
                paths.push(
                    entry
                        .map_err(|_| refusal("Work ownership unavailable."))?
                        .path(),
                );
            }
        } else if self.data_dir.join("work-launches").exists() && !force {
            return Err(refusal("Work inventory unavailable."));
        }
        for entry in
            fs::read_dir(&self.data_dir).map_err(|_| refusal("Work inventory unavailable."))?
        {
            let entry = entry.map_err(|_| refusal("Work ownership unavailable."))?;
            if entry
                .file_name()
                .to_string_lossy()
                .ends_with("-cli-update.lock")
            {
                paths.push(entry.path());
            }
        }
        let mut blocked = None;
        for path in paths {
            let value = lease_owner::read(&path);
            if lease_owner::stale(&value, &path) {
                let _ = fs::remove_file(&path);
                continue;
            }
            if !force {
                blocked.get_or_insert_with(|| {
                    refusal(&format!(
                        "Waiting for {}.",
                        value["label"].as_str().unwrap_or("work owner")
                    ))
                });
            }
        }
        blocked.map_or(Ok(()), Err)
    }

    fn recover_operations(&self) {
        let directory = self.data_dir.join(DIRECTORY);
        if !fs::symlink_metadata(&directory)
            .is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink())
        {
            return;
        }
        let empty_expired = lease_owner::stale(&serde_json::Value::Null, &directory);
        let mut recovered = false;
        if let Ok(entries) = fs::read_dir(&directory) {
            for entry in entries.flatten() {
                let path = entry.path();
                let value = lease_owner::read(&path);
                if lease_owner::stale(&value, &path) {
                    recovered |= fs::remove_file(path).is_ok();
                }
            }
            if recovered || empty_expired {
                let _ = fs::remove_dir(directory);
            }
        }
    }

    /// Save all observed owners, including unreadable records, before forced effects.
    fn record_force(
        &self,
        id: &str,
        phase: &str,
        inspection: Option<String>,
    ) -> Result<(), String> {
        let mut live = Vec::new();
        for directory in [
            self.data_dir.clone(),
            self.data_dir.join("work-launches"),
            self.data_dir.join(DIRECTORY),
        ] {
            if directory != self.data_dir
                && !fs::symlink_metadata(&directory)
                    .is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink())
            {
                if fs::symlink_metadata(&directory).is_ok() {
                    live.push(serde_json::json!({"name":directory.file_name(),"unavailable":"unconfirmed admission directory"}));
                }
                continue;
            }
            match fs::read_dir(&directory) {
                Ok(entries) => {
                    for entry in entries {
                        match entry {
                            Ok(entry) => {
                                let name = entry.file_name().to_string_lossy().to_string();
                                if directory == self.data_dir && !name.ends_with("-cli-update.lock")
                                {
                                    continue;
                                }
                                live.push(serde_json::json!({"name":name,"record": if fs::symlink_metadata(entry.path()).is_ok_and(|m| m.is_file() && !m.file_type().is_symlink()) { fs::read_to_string(entry.path()).unwrap_or_else(|error| format!("unavailable: {error}")) } else { "unconfirmed owner".into() }}));
                            }
                            Err(error) => {
                                live.push(serde_json::json!({"unavailable":error.to_string()}))
                            }
                        }
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => live.push(serde_json::json!({"unavailable":error.to_string()})),
            }
        }
        let directory = self.data_dir.join("forced-restarts");
        fs::create_dir_all(&directory)
            .map_err(|e| format!("Forced restart receipt unavailable: {e}"))?;
        let path = directory.join(format!("{id}.json"));
        let mut receipt = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Vec<serde_json::Value>>(&bytes).ok())
            .unwrap_or_default();
        receipt.push(serde_json::json!({"phase":phase,"atMs":lease_owner::now_ms(),"live":live,"inspection":inspection}));
        let temporary = directory.join(format!("{id}.tmp"));
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(&temporary).map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec(&receipt).unwrap())
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        fs::rename(temporary, path).map_err(|e| e.to_string())
    }

    pub fn data_directory(&self) -> PathBuf {
        self.data_dir.clone()
    }

    pub fn prepare(&self) -> Result<String, String> {
        self.prepare_with_work(false)
    }

    pub fn prepare_with_work(&self, force: bool) -> Result<String, String> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| refusal("Restart ownership is unavailable."))?;
        if force {
            if let Some(existing) = pending.as_ref() {
                self.record_force(&existing.id, "force-replaced", None)?;
                release(&self.data_dir.join(DIRECTORY), &existing.id);
                *pending = None;
            }
        }
        if let Some(existing) = pending.as_ref() {
            if existing.committed || existing.deadline > Instant::now() {
                return Err(refusal("A restart is already reserved."));
            }
            release(&self.data_dir.join(DIRECTORY), &existing.id);
            *pending = None;
        }
        fs::create_dir_all(&self.data_dir)
            .map_err(|_| refusal("CLI update ownership could not be checked."))?;
        let directory = self.data_dir.join(DIRECTORY);
        if !force {
            self.recover_operations();
        }
        let id = Uuid::new_v4().to_string();
        if force {
            self.record_force(&id, "prepare", None)?;
        }
        let owner_identity = match lease_owner::identity(std::process::id()) {
            Some(identity) => identity,
            None if force => {
                self.record_force(
                    &id,
                    "identity-unavailable",
                    Some("Restart process identity unavailable.".into()),
                )?;
                serde_json::Value::Null
            }
            None => return Err(refusal("Restart process identity unavailable.")),
        };
        let operation = Operation {
            version: 1,
            id: id.clone(),
            kind: "restart".into(),
            pid: std::process::id(),
            runtime: None,
            owner_pid: std::process::id(),
            owner_identity,
            created_at_ms: lease_owner::now_ms(),
            created_monotonic_ms: monotonic::now_ms(),
            started_at: format!("{:?}", std::time::SystemTime::now()),
            stage: "preparing".into(),
        };
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        builder.mode(0o700);
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        loop {
            if let Err(error) = builder.create(&directory) {
                if !force {
                    return Err(refusal(&format!("Work admission unavailable: {error}")));
                }
                match fs::symlink_metadata(&directory) {
                    Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(format!("Forced admission unavailable: {error}")),
                    Ok(_) => {
                        // Move the entry itself; never traverse an unknown target.
                        let displaced = self
                            .data_dir
                            .join("forced-restarts")
                            .join(format!("{id}-{}.admission", Uuid::new_v4()));
                        match fs::rename(&directory, displaced) {
                            Ok(()) => continue,
                            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                            Err(error) => {
                                return Err(format!(
                                    "Forced admission recovery unavailable: {error}"
                                ))
                            }
                        }
                    }
                }
            }
            #[cfg(test)]
            SETTLE_WRITER.with(|hook| {
                if let Some(settle) = hook.borrow_mut().take() {
                    settle(&directory);
                }
            });
            match options.open(directory.join(format!("{id}.json"))) {
                // Installer settlement may unlink its owner and empty directory
                // at any point before our unique owner file exists. Republish.
                Err(error) if force && error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    return Err(format!("Restart ownership could not be recorded: {error}"))
                }
                Ok(mut file) => {
                    if let Err(error) = file
                        .write_all(&serde_json::to_vec(&operation).unwrap())
                        .and_then(|_| file.sync_all())
                    {
                        let _ = fs::remove_file(directory.join(format!("{id}.json")));
                        let _ = fs::remove_dir(&directory);
                        return Err(format!("Restart ownership could not be recorded: {error}"));
                    }
                    break;
                }
            }
        }
        if let Err(error) = self.check_leases(force) {
            if !force {
                release(&directory, &id);
                return Err(error);
            }
            self.record_force(&id, "inventory-unavailable", Some(error))?;
        }
        *pending = Some(Pending {
            id: id.clone(),
            deadline: Instant::now() + PREPARE_TTL,
            committed: false,
            force,
        });
        let state = self.clone();
        let expiring = id.clone();
        std::thread::spawn(move || {
            std::thread::sleep(PREPARE_TTL);
            let _ = state.cancel(&expiring);
        });
        Ok(id)
    }

    pub fn cancel(&self, id: &str) -> Result<(), String> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| refusal("Restart ownership is unavailable."))?;
        let Some(current) = pending.as_ref() else {
            return Err(refusal("The restart reservation is no longer current."));
        };
        if current.id != id || current.committed {
            return Err(refusal("The restart reservation is no longer cancellable."));
        }
        release(&self.data_dir.join(DIRECTORY), id);
        *pending = None;
        Ok(())
    }

    pub fn before_restart(&self, reservation: Option<&str>) -> Result<(), String> {
        let id = match reservation {
            Some(id) => id.to_string(),
            None => self.prepare()?,
        };
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| refusal("Restart ownership is unavailable."))?;
        let Some(current) = pending.as_mut() else {
            return Err(refusal("The restart reservation expired."));
        };
        let operation = fs::read(self.data_dir.join(DIRECTORY).join(format!("{id}.json")))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Operation>(&bytes).ok());
        if current.id != id
            || current.committed
            || current.deadline <= Instant::now()
            || !operation.as_ref().is_some_and(|owner| {
                owner.id == id && owner.kind == "restart" && owner.pid == std::process::id()
            })
        {
            return Err(refusal(
                "Restart ownership changed or expired. Retry from the current window.",
            ));
        }
        let inspection = self
            .check_leases(current.force)
            .and_then(|_| (self.inspect_work)(&id, current.force))
            .and_then(|_| self.check_leases(current.force));
        if current.force {
            self.record_force(&id, "before-cleanup", inspection.err())?;
        } else {
            inspection?;
        }
        if current.deadline <= Instant::now() {
            return Err(refusal(
                "Restart inspection exceeded its reservation. Retry.",
            ));
        }
        current.committed = true;
        drop(pending);
        (self.before_restart)();
        std::thread::sleep(Duration::from_millis(300));
        Ok(())
    }
}

#[cfg(test)]
mod tests;
