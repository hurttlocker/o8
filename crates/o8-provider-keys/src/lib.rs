//! Shared encrypted provider store. Wire-compatible with src/lib/providers/key-store.ts.
mod artifacts;
use aes_gcm::{
    aead::{rand_core::RngCore, Aead, OsRng},
    Aes256Gcm, KeyInit, Nonce,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

pub const PROVIDERS: [&str; 8] = [
    "OPENROUTER_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "DEEPSEEK_API_KEY",
    "GEMINI_API_KEY",
    "GROQ_API_KEY",
    "ELEVENLABS_API_KEY",
    "GOOGLE_TTS_API_KEY",
];
pub fn data_dir() -> PathBuf {
    std::env::var_os("O8_DATA_DIR")
        .or_else(|| std::env::var_os("CORTEX_IDE_DATA_DIR"))
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(
                std::env::var_os("HOME")
                    .or_else(|| std::env::var_os("USERPROFILE"))
                    .unwrap_or_default(),
            )
            .join(".o8")
        })
}
fn read(path: &Path) -> Result<String, String> {
    match fs::read_to_string(path) {
        Ok(raw) => Ok(raw),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(_) => Err("Credential store unavailable".into()),
    }
}
fn values(raw: &str) -> BTreeMap<String, String> {
    raw.lines()
        .filter_map(|line| {
            let (key, value) = line.trim().split_once('=')?;
            if key.starts_with('#') {
                return None;
            }
            Some((
                key.trim().into(),
                value.trim().trim_matches(|c| c == '\'' || c == '"').into(),
            ))
        })
        .collect()
}
fn allow_master_key_creation(create: bool, raw: &str) -> Result<(), String> {
    if !create || values(raw).values().any(|value| value.starts_with("enc:")) {
        return Err("Master key unavailable".into());
    }
    Ok(())
}
fn valid_key(raw: &str) -> Result<[u8; 32], String> {
    let normalized = raw.trim().replace('-', "+").replace('_', "/");
    let padded = format!(
        "{}{}",
        normalized.trim_end_matches('='),
        "=".repeat((4 - normalized.trim_end_matches('=').len() % 4) % 4)
    );
    base64::engine::general_purpose::STANDARD
        .decode(padded)
        .map_err(|_| "Invalid master key".to_string())?
        .try_into()
        .map_err(|_| "Invalid master key".to_string())
}
fn create_private(path: &Path, raw: &[u8]) -> Result<(), String> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| "Credential store unavailable".to_string())?;
    file.write_all(raw)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Credential store unavailable".to_string())
}
/// Read the file fallback only after tightening both directory and file permissions.
pub fn read_master_key_file(path: &Path) -> Result<String, String> {
    let directory = path
        .parent()
        .ok_or_else(|| "Unsafe master key path".to_string())?;
    for (target, is_directory, mode) in [(directory, true, 0o700), (path, false, 0o600)] {
        let metadata =
            fs::symlink_metadata(target).map_err(|_| "Master key unavailable".to_string())?;
        if metadata.file_type().is_symlink()
            || if is_directory {
                !metadata.is_dir()
            } else {
                !metadata.is_file()
            }
        {
            return Err("Unsafe master key path".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(target, fs::Permissions::from_mode(mode))
                .map_err(|_| "Unsafe master key permissions".to_string())?;
            if fs::metadata(target)
                .map_err(|_| "Master key unavailable".to_string())?
                .permissions()
                .mode()
                & 0o777
                != mode
            {
                return Err("Unsafe master key permissions".into());
            }
        }
    }
    let raw = read(path)?;
    valid_key(&raw)?;
    Ok(raw.trim().into())
}

/// Never replace a denied, malformed or unreadable existing master key.
pub fn master_key(create: bool) -> Result<String, String> {
    if let Ok(raw) = std::env::var("O8_MASTER_KEY") {
        valid_key(&raw)?;
        return Ok(raw);
    }
    let fallback = data_dir().join("master-key");
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("/usr/bin/security")
            .args([
                "find-generic-password",
                "-s",
                "ai.o8.master-key",
                "-a",
                "default",
                "-w",
            ])
            .output()
            .map_err(|_| "Keychain unavailable".to_string())?;
        if output.status.success() {
            let raw =
                String::from_utf8(output.stdout).map_err(|_| "Invalid master key".to_string())?;
            valid_key(&raw)?;
            return Ok(raw.trim().into());
        }
        if output.status.code() != Some(44) {
            return Err("Keychain unavailable; previous state preserved".into());
        }
    }
    if fallback
        .try_exists()
        .map_err(|_| "Master key unavailable".to_string())?
    {
        return read_master_key_file(&fallback);
    }
    allow_master_key_creation(create, &read(&data_dir().join(".env.local"))?)?;
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let raw = URL_SAFE_NO_PAD.encode(bytes);
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("/usr/bin/security")
            .args([
                "add-generic-password",
                "-s",
                "ai.o8.master-key",
                "-a",
                "default",
                "-w",
                &raw,
            ])
            .output()
            .map_err(|_| "Keychain unavailable".to_string())?;
        if output.status.success() {
            return Ok(raw);
        }
        return master_key(false);
    }
    #[cfg(not(target_os = "macos"))]
    {
        fs::create_dir_all(data_dir()).map_err(|_| "Credential store unavailable".to_string())?;
        if create_private(&fallback, raw.as_bytes()).is_err() {
            return master_key(false);
        }
        read_master_key_file(&fallback)
    }
}
fn decrypt(raw: &str) -> Result<String, String> {
    if !raw.starts_with("enc:") {
        return Ok(raw.trim().into());
    }
    let fields: Vec<_> = raw.split(':').collect();
    if fields.len() != 3 {
        return Err("Invalid encrypted credential".into());
    }
    let iv = hex::decode(fields[1]).map_err(|_| "Invalid IV".to_string())?;
    if iv.len() != 12 {
        return Err("Invalid IV".into());
    }
    let payload = hex::decode(fields[2]).map_err(|_| "Invalid ciphertext".to_string())?;
    let cipher = Aes256Gcm::new_from_slice(&valid_key(&master_key(false)?)?).unwrap();
    let plain = cipher
        .decrypt(Nonce::from_slice(&iv), payload.as_ref())
        .map_err(|_| "Credential store unavailable".to_string())?;
    String::from_utf8(plain).map_err(|_| "Invalid credential".into())
}
fn encrypt(raw: &str) -> Result<String, String> {
    let cipher = Aes256Gcm::new_from_slice(&valid_key(&master_key(true)?)?).unwrap();
    let mut iv = [0u8; 12];
    OsRng.fill_bytes(&mut iv);
    let payload = cipher
        .encrypt(Nonce::from_slice(&iv), raw.as_bytes())
        .map_err(|_| "Credential encryption failed".to_string())?;
    Ok(format!("enc:{}:{}", hex::encode(iv), hex::encode(payload)))
}
pub fn managed(name: &str) -> Result<bool, String> {
    Ok(values(&read(&data_dir().join(".env.local"))?)
        .get(&format!("O8_KEY_MANAGED_{name}"))
        .is_some_and(|v| v == "1"))
}
pub fn present(name: &str) -> Result<bool, String> {
    Ok(values(&read(&data_dir().join(".env.local"))?)
        .get(name)
        .is_some_and(|v| !v.is_empty()))
}
pub fn enabled(name: &str) -> Result<bool, String> {
    let map = values(&read(&data_dir().join(".env.local"))?);
    if let Some(flag) = map.get(&format!("O8_KEY_DISABLED_{name}")) {
        return Ok(flag != "1");
    }
    if name == "OPENROUTER_API_KEY" {
        let raw = read(&data_dir().join("providers/openrouter.json"))?;
        if !raw.is_empty() {
            let value: serde_json::Value = serde_json::from_str(&raw)
                .map_err(|_| "Connection store unavailable".to_string())?;
            return Ok(value
                .get("enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(true));
        }
    }
    Ok(true)
}
pub fn resolve(name: &str) -> Result<Option<String>, String> {
    let map = values(&read(&data_dir().join(".env.local"))?);
    if !enabled(name)? {
        return Ok(None);
    }
    if !map
        .get(&format!("O8_KEY_MANAGED_{name}"))
        .is_some_and(|v| v == "1")
    {
        if let Ok(raw) = std::env::var(name) {
            if !raw.trim().is_empty() {
                return Ok(Some(raw.trim().into()));
            }
        }
    }
    map.get(name)
        .map(|raw| decrypt(raw))
        .transpose()
        .map(|v| v.filter(|s| !s.trim().is_empty()))
}
/// None leaves the key unchanged; Some(None) is a durable removal tombstone.
pub fn mutate(name: &str, key: Option<Option<&str>>, enabled: Option<bool>) -> Result<(), String> {
    mutate_inner(name, key, enabled, false)
}
/// Eligibility and secure persistence share the same cross-process transaction lock.
pub fn migrate_legacy(name: &str, key: &str) -> Result<Option<String>, String> {
    mutate_inner(name, Some(Some(key)), None, true)?;
    resolve(name)
}
fn mutate_inner(
    name: &str,
    key: Option<Option<&str>>,
    enabled: Option<bool>,
    migration: bool,
) -> Result<(), String> {
    if !PROVIDERS.contains(&name) {
        return Err("Unsupported provider key".into());
    }
    let dir = data_dir();
    fs::create_dir_all(&dir).map_err(|_| "Credential store unavailable".to_string())?;
    let lock = rusqlite::Connection::open(dir.join(".provider-keys.lock"))
        .map_err(|_| "Credential store unavailable".to_string())?;
    lock.busy_timeout(std::time::Duration::ZERO)
        .map_err(|_| "Credential store unavailable".to_string())?;
    lock.execute_batch("BEGIN EXCLUSIVE")
        .map_err(|_| "Credential store busy or unavailable".to_string())?;
    let path = dir.join(".env.local");
    let raw = read(&path)?;
    let map = values(&raw);
    if migration
        && (map.get(name).is_some_and(|value| !value.trim().is_empty())
            || map
                .get(&format!("O8_KEY_MANAGED_{name}"))
                .is_some_and(|v| v == "1")
            || !self::enabled(name)?)
    {
        return Ok(());
    }
    for provider in PROVIDERS {
        if let Some(value) = map.get(provider) {
            decrypt(value)?;
        }
    }
    let mut updates: BTreeMap<String, Option<String>> = BTreeMap::new();
    for provider in PROVIDERS {
        if let Some(value) = map.get(provider) {
            if !value.trim().is_empty() && !value.starts_with("enc:") {
                updates.insert(provider.into(), Some(encrypt(value)?));
            }
        }
    }
    if let Some(key) = key {
        updates.insert(
            name.into(),
            key.filter(|v| !v.trim().is_empty())
                .map(|v| encrypt(v.trim()))
                .transpose()?,
        );
        updates.insert(format!("O8_KEY_MANAGED_{name}"), Some("1".into()));
    }
    if let Some(enabled) = enabled {
        updates.insert(
            format!("O8_KEY_DISABLED_{name}"),
            Some(if enabled { "0" } else { "1" }.into()),
        );
    }
    let mut lines: Vec<String> = raw
        .split('\n')
        .filter(|line| !updates.contains_key(line.split('=').next().unwrap_or("").trim()))
        .map(str::to_owned)
        .collect();
    for (key, value) in updates {
        if let Some(value) = value {
            lines.push(format!("{key}={value}"));
        }
    }
    let mut nonce = [0u8; 12];
    artifacts::purge(&dir)?;
    OsRng.fill_bytes(&mut nonce);
    let temporary = dir.join(format!(".provider-keys.{}.tmp", hex::encode(nonce)));
    let result = create_private(&temporary, lines.join("\n").as_bytes()).and_then(|_| {
        fs::rename(&temporary, &path).map_err(|_| "Credential store unavailable".to_string())
    });
    let _ = fs::remove_file(temporary);
    result
}

#[cfg(all(test, unix))]
mod fallback_tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    #[test]
    fn fallback_read_tightens_file_and_directory_permissions() {
        let dir =
            std::env::temp_dir().join(format!("o8-master-permissions-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("master-key");
        let key = URL_SAFE_NO_PAD.encode([51u8; 32]);
        fs::write(&path, &key).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(read_master_key_file(&path).unwrap(), key);
        assert_eq!(
            fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn fallback_read_refuses_symbolic_link_without_touching_target() {
        let dir = std::env::temp_dir().join(format!("o8-master-symlink-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("target");
        fs::write(&target, URL_SAFE_NO_PAD.encode([52u8; 32])).unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o644)).unwrap();
        symlink(&target, dir.join("master-key")).unwrap();
        assert!(read_master_key_file(&dir.join("master-key")).is_err());
        assert_eq!(
            fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o644
        );
        fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(test)]
mod cold_master_tests {
    use super::*;
    #[test]
    fn missing_master_creation_refuses_quoted_ciphertext() {
        for quote in ['\"', '\''] {
            let raw = format!("OPENROUTER_API_KEY={quote}enc:fixture:fixture{quote}\n");
            assert!(allow_master_key_creation(true, &raw).is_err());
        }
    }
    #[test]
    fn missing_master_creation_refuses_spaced_ciphertext() {
        assert!(
            allow_master_key_creation(true, "  OPENROUTER_API_KEY =  enc:fixture:fixture  ")
                .is_err()
        );
    }
}
