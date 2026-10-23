//! Nonsecret global launch epoch. The caller already owns .provider-keys.lock.
use std::{fs, io::{Read, Write}, path::{Path, PathBuf}};
use aes_gcm::aead::rand_core::RngCore;
const ERROR: &str = "Provider launch policy unavailable or unsafe; previous state preserved";
fn parents(file: &Path, system_aliases: bool) -> Result<Vec<(PathBuf, fs::Metadata)>, String> {
    let mut observed = vec![]; let mut current = file.parent();
    while let Some(path) = current {
        let stat = fs::symlink_metadata(path).map_err(|_| ERROR.to_string())?;
        if !stat.is_dir() && !(system_aliases && stat.file_type().is_symlink() && matches!(path.to_str(), Some("/var" | "/tmp" | "/etc"))) { return Err(ERROR.into()); }
        observed.push((path.into(), stat)); current = path.parent();
    }
    Ok(observed)
}
fn same(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    #[cfg(unix)] { use std::os::unix::fs::MetadataExt; left.dev() == right.dev() && left.ino() == right.ino() }
    #[cfg(not(unix))] { left.is_dir() == right.is_dir() && left.file_type().is_symlink() == right.file_type().is_symlink() }
}
fn unchanged(observed: &[(PathBuf, fs::Metadata)]) -> Result<(), String> {
    for (path, before) in observed {
        let current = fs::symlink_metadata(path).map_err(|_| ERROR.to_string())?;
        if !same(before, &current) || before.is_dir() != current.is_dir() || before.file_type().is_symlink() != current.file_type().is_symlink() { return Err(ERROR.into()); }
    }
    Ok(())
}
fn optional(file: &Path) -> Result<Option<fs::Metadata>, String> {
    match fs::symlink_metadata(file) { Ok(stat) => Ok(Some(stat)), Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None), _ => Err(ERROR.into()) }
}
fn regular(stat: &fs::Metadata) -> Result<(), String> {
    if !stat.is_file() { return Err(ERROR.into()); }
    #[cfg(unix)] { use std::os::unix::fs::MetadataExt; if stat.nlink() != 1 || stat.uid() != unsafe { libc::geteuid() } || stat.mode() & 0o077 != 0 { return Err(ERROR.into()); } }
    Ok(())
}
fn validate(file: &Path, observed: &[(PathBuf, fs::Metadata)]) -> Result<Option<fs::Metadata>, String> {
    let Some(before) = optional(file)? else { unchanged(observed)?; return Ok(None); };
    regular(&before)?;
    let mut options = fs::OpenOptions::new(); options.read(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK); }
    let mut opened = options.open(file).map_err(|_| ERROR.to_string())?;
    let metadata = opened.metadata().map_err(|_| ERROR.to_string())?; regular(&metadata)?;
    if !same(&before, &metadata) || metadata.len() > 4096 { return Err(ERROR.into()); }
    unchanged(observed)?;
    let mut raw = String::new(); opened.read_to_string(&mut raw).map_err(|_| ERROR.to_string())?;
    unchanged(observed)?;
    let value: serde_json::Value = serde_json::from_str(&raw).map_err(|_| ERROR.to_string())?;
    let epoch = value["epoch"].as_str().ok_or(ERROR)?;
    if value["version"] != 1 || !(32..=64).contains(&epoch.len()) || !epoch.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase() || c == b'-') { return Err(ERROR.into()); }
    Ok(Some(before))
}
pub(crate) fn invalidate(dir: &Path) -> Result<(), String> {
    let initial = parents(&dir.join("provider-launch-policy.json"), true)?;
    let directory = fs::canonicalize(dir).map_err(|_| ERROR.to_string())?;
    unchanged(&initial)?;
    let file = directory.join("provider-launch-policy.json");
    let mut observed = initial; observed.extend(parents(&file, false)?);
    let before = validate(&file, &observed)?;
    let mut epoch = [0u8; 32]; super::OsRng.fill_bytes(&mut epoch);
    let raw = format!("{{\"version\":1,\"epoch\":\"{}\"}}\n", hex::encode(epoch));
    let mut nonce = [0u8; 12]; super::OsRng.fill_bytes(&mut nonce);
    let temporary = directory.join(format!(".provider-launch-policy.{}.tmp", hex::encode(nonce)));
    let mut options = fs::OpenOptions::new(); options.write(true).create_new(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600).custom_flags(libc::O_NOFOLLOW); }
    let mut output = options.open(&temporary).map_err(|_| ERROR.to_string())?;
    let result = (|| {
        regular(&output.metadata().map_err(|_| ERROR.to_string())?)?;
        unchanged(&observed)?; output.write_all(raw.as_bytes()).map_err(|_| ERROR.to_string())?;
        unchanged(&observed)?;
        let current = optional(&file)?; if let Some(stat) = current.as_ref() { regular(stat)?; }
        if match (&before, &current) { (Some(left), Some(right)) => !same(left, right), (None, None) => false, _ => true } { return Err(ERROR.into()); }
        fs::rename(&temporary, &file).map_err(|_| ERROR.to_string())?; unchanged(&observed)
    })();
    if result.is_err() && unchanged(&observed).is_ok() { let _ = fs::remove_file(&temporary); }
    result
}
