use super::{absolute, Process, Reply, MAX_FRAME};
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub(super) fn private_directory(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::DirBuilder::new().mode(0o700).create(path)?;
        }
        Err(error) => return Err(error),
        Ok(_) => {}
    }
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err(io::Error::other("private directory required"));
    }
    Ok(())
}

use std::os::unix::fs::DirBuilderExt;

pub(super) fn regular(path: &Path, output: bool) -> io::Result<File> {
    let file = OpenOptions::new()
        .read(!output)
        .write(output)
        .append(output)
        .create(output)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.uid() != unsafe { libc::geteuid() } {
        return Err(io::Error::other("owned regular file required"));
    }
    Ok(file)
}

pub(super) fn read_record(path: &Path) -> Reply {
    let file = regular(path, false).map_err(|_| "ownership-unverifiable")?;
    if file
        .metadata()
        .map_err(|_| "ownership-unverifiable")?
        .mode()
        & 0o077
        != 0
    {
        return Err("ownership-unverifiable");
    }
    serde_json::from_reader(std::io::Read::take(file, MAX_FRAME as u64))
        .map_err(|_| "ownership-unverifiable")
}

pub(super) fn persist(directory: &Path, record: &Value) -> Result<(), &'static str> {
    let id = record["id"].as_str().ok_or("ownership-unverifiable")?;
    let temporary = directory.join(format!(".{}.tmp", Uuid::new_v4()));
    let result = (|| -> io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&temporary)?;
        file.write_all(record.to_string().as_bytes())?;
        file.sync_all()?;
        fs::rename(&temporary, directory.join(format!("{id}.owner.json")))?;
        File::open(directory)?.sync_all()
    })();
    let _ = fs::remove_file(temporary);
    result.map_err(|_| "ownership-persistence-failed")
}

fn process_identity(pid: u32) -> Option<Value> {
    let boot = fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?;
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let fields: Vec<_> = stat.rsplit_once(") ")?.1.split_whitespace().collect();
    Some(json!({"version":1,"platform":"linux","bootId":boot.trim(),"startId":fields.get(19)?}))
}

pub(super) fn identity(pid: u32) -> Option<Value> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let fields: Vec<_> = stat.rsplit_once(") ")?.1.split_whitespace().collect();
    if fields.get(2)?.parse::<u32>().ok()? != pid || fields.get(3)?.parse::<u32>().ok()? != pid {
        return None;
    }
    // Boot/start identity matches o8-restart-safety and the owned-session source.
    process_identity(pid)
}

pub(super) fn group_empty(pid: u32) -> bool {
    if pid == 0 || pid > i32::MAX as u32 {
        return false;
    }
    // Signal zero is a kernel existence query; it delivers no signal. Only
    // ESRCH proves absence. EPERM and all other errors preserve the hold.
    unsafe {
        libc::kill(-(pid as i32), 0) != 0
            && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
    }
}

pub(super) fn descendants_drained(pid: u32) -> bool {
    let Ok(entries) = fs::read_dir("/proc") else {
        return false;
    };
    for entry in entries {
        let Ok(entry) = entry else {
            return false;
        };
        let Ok(member) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        if member == pid {
            continue;
        }
        let stat = match fs::read_to_string(entry.path().join("stat")) {
            Ok(stat) => stat,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(_) => return false,
        };
        let Some((_, fields)) = stat.rsplit_once(") ") else {
            return false;
        };
        let fields: Vec<_> = fields.split_whitespace().collect();
        if fields.get(2).and_then(|p| p.parse::<u32>().ok()) != Some(pid) {
            continue;
        }
        // Subreaping gives this actor explicit wait authority over orphaned
        // descendants; never reap another supervised leader or an unknown pid.
        if fields.first() == Some(&"Z")
            && fields.get(1).and_then(|p| p.parse::<u32>().ok()) == Some(std::process::id())
        {
            if unsafe { libc::waitpid(member as i32, std::ptr::null_mut(), libc::WNOHANG) }
                == member as i32
            {
                continue;
            }
        }
        return false;
    }
    true
}

// Transfer the existing launch reader to this independent owner before exec.
// A server crash cannot make native restart admission forget a live worker.
pub(super) fn take_admission(request: &Value) -> Result<Option<(PathBuf, Value)>, &'static str> {
    if request.get("admissionPath").is_none() {
        return Ok(None);
    }
    let path = absolute(request, "admissionPath")?;
    let mut lease = read_record(&path)?;
    let lease_id = lease["id"].as_str().ok_or("admission-refused")?;
    if Uuid::parse_str(lease_id).is_err()
        || path.file_name().and_then(|n| n.to_str()) != Some(&format!("{lease_id}.json"))
        || path
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            != Some("work-launches")
    {
        return Err("admission-refused");
    }
    let parent = path.parent().ok_or("admission-refused")?;
    private_directory(parent).map_err(|_| "admission-refused")?;
    let original = lease.clone();
    lease["ownerPid"] = json!(std::process::id());
    lease["ownerIdentity"] = process_identity(std::process::id()).ok_or("admission-refused")?;
    lease["pid"] = json!(std::process::id());
    replace_admission(&path, &original, &lease)?;
    if parent
        .parent()
        .ok_or("admission-refused")?
        .join("cli-operation-admission")
        .try_exists()
        .map_err(|_| "admission-refused")?
    {
        let _ = replace_admission(&path, &lease, &original);
        return Err("admission-refused");
    }
    Ok(Some((path, lease)))
}

pub(super) fn replace_admission(
    path: &Path,
    expected: &Value,
    next: &Value,
) -> Result<(), &'static str> {
    if read_record(path)? != *expected {
        return Err("admission-refused");
    }
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let result = (|| -> io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&temporary)?;
        file.write_all(next.to_string().as_bytes())?;
        file.sync_all()?;
        fs::rename(&temporary, path)
    })();
    let _ = fs::remove_file(temporary);
    result.map_err(|_| "admission-refused")
}

pub(super) fn verified(
    directory: &Path,
    process: &Process,
    live: bool,
) -> Result<(), &'static str> {
    let id = process.record["id"]
        .as_str()
        .ok_or("ownership-unverifiable")?;
    let saved = read_record(&directory.join(format!("{id}.owner.json")))?;
    if saved != process.record {
        return Err("ownership-mismatch");
    }
    if live {
        let pid = process.record["pid"]
            .as_u64()
            .filter(|pid| *pid > 0 && *pid <= i32::MAX as u64)
            .ok_or("ownership-unverifiable")? as u32;
        if process.record["identity"].is_null()
            || identity(pid).as_ref() != Some(&process.record["identity"])
        {
            return Err("ownership-unverifiable");
        }
    }
    Ok(())
}
