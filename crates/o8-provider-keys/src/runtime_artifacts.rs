//! Credential-free owned profiles. Caller owns the cross-language credential-store lock.
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use aes_gcm::aead::rand_core::RngCore;
use std::{collections::BTreeMap, fs, io::{Read, Seek, SeekFrom, Write}, path::{Path, PathBuf}};
const ERROR: &str = "Owned runtime credential artifacts unavailable or unsafe; previous state preserved";
struct Materials { values: Vec<String>, hashes: std::collections::HashSet<String>, lengths: std::collections::BTreeSet<usize> }
impl Materials {
    fn read(dir: &Path) -> Result<Self, String> {
        let values = super::values(&super::read(&dir.join(".env.local"))?);
        let mut result = Self { values: vec![], hashes: Default::default(), lengths: Default::default() };
        for name in super::PROVIDERS {
            if let Some(raw) = values.get(&format!("O8_KEY_HASHES_{name}")) { result.hashes.extend(serde_json::from_str::<Vec<String>>(raw).map_err(|_| ERROR.to_string())?); }
            if let Some(raw) = values.get(&format!("O8_KEY_LENGTHS_{name}")) { result.lengths.extend(serde_json::from_str::<Vec<usize>>(raw).map_err(|_| ERROR.to_string())?.into_iter().filter(|length| *length > 0)); }
            if let Some(raw) = values.get(name) {
                let plain = super::decrypt(raw)?;
                if !plain.is_empty() { result.hashes.insert(hex::encode(Sha256::digest(plain.as_bytes()))); result.lengths.insert(plain.len()); result.values.push(plain); }
            }
        }
        Ok(result)
    }
    fn contains(&self, raw: &str) -> bool {
        if self.values.iter().any(|secret| raw.contains(secret)) { return true; }
        for length in &self.lengths { if *length <= raw.len() {
            for value in raw.as_bytes().windows(*length) { if self.hashes.contains(&hex::encode(Sha256::digest(value))) { return true; } }
        } }
        false
    }
}
fn credential(name: &str) -> bool {
    name.ends_with("_API_KEY") || matches!(name, "ANTHROPIC_AUTH_TOKEN" | "GOOGLE_API_KEY" | "COPILOT_PROVIDER_BEARER_TOKEN")
}
fn reference(name: &str) -> bool {
    matches!(name, "OPENROUTER_API_KEY" | "OPENAI_API_KEY" | "CODEX_API_KEY" | "ANTHROPIC_API_KEY" | "ANTHROPIC_AUTH_TOKEN" | "DEEPSEEK_API_KEY" | "GEMINI_API_KEY" | "GOOGLE_AI_API_KEY" | "GOOGLE_GENERATIVE_AI_API_KEY" | "GOOGLE_API_KEY" | "GROQ_API_KEY" | "ELEVENLABS_API_KEY" | "GOOGLE_TTS_API_KEY")
}
fn header(name: &str) -> bool {
    matches!(name.to_ascii_lowercase().as_str(), "authorization" | "proxy-authorization" | "x-api-key" | "api-key" | "apikey" | "x-goog-api-key" | "xi-api-key" | "x-auth-token" | "x-access-token")
}
fn provider(name: &str) -> Option<&'static str> {
    match name { "openai" | "codex" | "openai-codex" => Some("OPENAI_API_KEY"), "anthropic" | "claude-code" => Some("ANTHROPIC_API_KEY"), "openrouter" => Some("OPENROUTER_API_KEY"), "google" | "gemini" => Some("GEMINI_API_KEY"), "groq" => Some("GROQ_API_KEY"), "deepseek" => Some("DEEPSEEK_API_KEY"), _ => None }
}
fn sanitize(value: &mut Value, runtime: &str, selected: &str, location: &[String], materials: &Materials) -> bool {
    if let Value::String(raw) = value { return !materials.contains(raw); }
    if let Value::Array(items) = value { items.retain_mut(|item| sanitize(item, runtime, selected, location, materials)); return true; }
    let Value::Object(record) = value else { return true; };
    let selected = record.get("provider").and_then(Value::as_str).unwrap_or(selected).to_owned();
    let api_auth = matches!(record.get("type").and_then(Value::as_str), Some("api_key" | "api-key"));
    record.retain(|name, _| !credential(name) && !(location.last().map(String::as_str) != Some("headers") && matches!(name.to_ascii_lowercase().as_str(), "apikey" | "api_key" | "experimental_bearer_token")) && !(api_auth && matches!(name.as_str(), "key" | "token")));
    let model_providers = location.iter().rposition(|part| part == "model_providers");
    let models = location.iter().rposition(|part| part == "models");
    let provider_headers = model_providers.is_some_and(|index| location.len() > index + 1)
        || models.is_some_and(|index| location.get(index + 1).map(String::as_str) == Some("providers") && location.len() > index + 2);
    let mut references = Map::new();
    let mut removed = vec![];
    for (name, item) in record.iter_mut() {
        if provider_headers && matches!(name.as_str(), "headers" | "http_headers" | "env_http_headers") {
            if let Value::Object(headers) = item {
                headers.retain(|key, raw| {
                    if raw.as_str().is_some_and(|raw| materials.contains(raw)) {
                        if name != "env_http_headers" && header(key) && runtime == "codex" && model_providers.is_some() {
                            if let Some(canonical) = provider(&selected) { references.insert(key.clone(), canonical.into()); }
                        }
                        return false;
                    }
                    if !header(key) { return true; }
                    if name == "env_http_headers" { return raw.as_str().is_some_and(reference); }
                    if runtime == "codex" && model_providers.is_some() {
                        if let Some(canonical) = provider(&selected) { references.insert(key.clone(), canonical.into()); }
                    }
                    false
                });
            } else { *item = Value::Object(Map::new()); }
        } else {
            let mut path = location.to_vec(); path.push(name.clone());
            let next = if provider(name).is_some() { name.as_str() } else if location == ["model_providers"] || location == ["models", "providers"] { "" } else { &selected };
            if !sanitize(item, runtime, next, &path, materials) { removed.push(name.clone()); }
        }
    }
    for name in removed { record.remove(&name); }
    if !references.is_empty() {
        if let Some(Value::Object(existing)) = record.get("env_http_headers") { references.extend(existing.clone()); }
        record.insert("env_http_headers".into(), Value::Object(references));
    }
    if runtime == "codex" && record.get("auth_mode").and_then(Value::as_str) == Some("apikey") { record.remove("auth_mode"); }
    true
}
fn clean(path: &Path, raw: &str, runtime: &str, materials: &Materials) -> Result<String, String> {
    let extension = path.extension().and_then(|s| s.to_str()).unwrap_or("");
    if !matches!(extension, "json" | "toml" | "yaml" | "yml") {
        return Ok(raw.split('\n').filter(|line| {
            let left = line.trim_start().strip_prefix("export ").unwrap_or(line.trim_start());
            !left.split_once('=').is_some_and(|(name, _)| credential(name.trim())) && !materials.contains(line)
        }).collect::<Vec<_>>().join("\n"));
    }
    let mut value: Value = match extension {
        "json" => serde_json::from_str(raw).map_err(|_| ERROR.to_string())?,
        "toml" => serde_json::to_value(toml::from_str::<toml::Value>(raw).map_err(|_| ERROR.to_string())?).map_err(|_| ERROR.to_string())?,
        _ => serde_yaml::from_str(raw).map_err(|_| ERROR.to_string())?,
    };
    if !sanitize(&mut value, runtime, runtime, &[], materials) { value = Value::Null; }
    match extension {
        "json" => serde_json::to_string_pretty(&value).map(|s| format!("{s}\n")).map_err(|_| ERROR.into()),
        "toml" => toml::to_string(&value).map_err(|_| ERROR.into()),
        _ => serde_yaml::to_string(&value).map_err(|_| ERROR.into()),
    }
}
fn regular(path: &Path) -> Result<bool, String> {
    let mut parent = path.parent();
    while let Some(directory) = parent {
        if directory.as_os_str().is_empty() { break; }
        match fs::symlink_metadata(directory) {
            Ok(stat) if stat.is_dir() && !stat.file_type().is_symlink() => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            _ => return Err(ERROR.into()),
        }
        parent = directory.parent();
    }
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(ERROR.into()),
        Ok(stat) => {
            if !stat.is_file() { return Err(ERROR.into()); }
            #[cfg(unix)] { use std::os::unix::fs::MetadataExt; if stat.nlink() != 1 || stat.uid() != unsafe { libc::geteuid() } { return Err(ERROR.into()); } }
            Ok(true)
        }
    }
}
fn parent_snapshot(path: &Path) -> Result<Vec<(PathBuf, fs::Metadata)>, String> {
    let mut result = vec![];
    let mut parent = path.parent();
    while let Some(directory) = parent {
        if directory.as_os_str().is_empty() { break; }
        let stat = fs::symlink_metadata(directory).map_err(|_| ERROR.to_string())?;
        if !stat.is_dir() || stat.file_type().is_symlink() { return Err(ERROR.into()); }
        result.push((directory.into(), stat)); parent = directory.parent();
    }
    Ok(result)
}
fn assert_parents(parents: &[(PathBuf, fs::Metadata)]) -> Result<(), String> {
    for (path, before) in parents {
        let current = fs::symlink_metadata(path).map_err(|_| ERROR.to_string())?;
        if !current.is_dir() || current.file_type().is_symlink() { return Err(ERROR.into()); }
        #[cfg(unix)] { use std::os::unix::fs::MetadataExt; if before.dev() != current.dev() || before.ino() != current.ino() { return Err(ERROR.into()); } }
    }
    Ok(())
}
fn write_prepared(mut file: fs::File, safe: &str, parents: &[(PathBuf, fs::Metadata)]) -> Result<(), String> {
    assert_parents(parents)?;
    file.seek(SeekFrom::Start(0)).map_err(|_| ERROR.to_string())?;
    file.set_len(0).map_err(|_| ERROR.to_string())?;
    file.write_all(safe.as_bytes()).map_err(|_| ERROR.to_string())
}
fn selected(name: &str) -> bool {
    matches!(name, "auth.json" | "auth-profiles.json" | "auth-state.json" | "config.toml" | "config.yaml" | "config.yml" | "config.json" | "openclaw.json" | ".env" | "models_dev_cache.json") || (name.starts_with("orchestrator-") || name.starts_with("o8-codex-app-")) && name.ends_with(".json")
}
fn walk(dir: &Path, runtime: &str, depth: usize, seen: &mut usize, found: &mut BTreeMap<PathBuf, String>) -> Result<(), String> {
    let stat = match fs::symlink_metadata(dir) { Ok(s) => s, Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()), _ => return Err(ERROR.into()) };
    if !stat.is_dir() { return Err(ERROR.into()); }
    let canonical = fs::canonicalize(dir).map_err(|_| ERROR.to_string())?;
    let dir = canonical.as_path();
    for entry in fs::read_dir(dir).map_err(|_| ERROR.to_string())? {
        *seen += 1; if *seen > 100_000 { return Err(ERROR.into()); }
        let entry = entry.map_err(|_| ERROR.to_string())?; let kind = entry.file_type().map_err(|_| ERROR.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if kind.is_symlink() { continue; }
        if kind.is_dir() && depth > 0 && !matches!(name.as_str(), "sessions" | "npm" | "plugins" | "node_modules" | ".git") { walk(&entry.path(), runtime, depth - 1, seen, found)?; }
        else if kind.is_file() && (selected(&name) || (runtime == "openclaw" && dir.components().any(|p| p.as_os_str() == "credentials") && name.ends_with(".json"))) { found.insert(entry.path(), runtime.into()); }
    }
    Ok(())
}
pub(crate) fn purge(dir: &Path) -> Result<(), String> {
    let canonical = fs::canonicalize(dir).map_err(|_| ERROR.to_string())?;
    let dir = canonical.as_path();
    let materials = Materials::read(dir)?;
    let registry = dir.join("owned-credential-artifacts.json");
    let mut found = BTreeMap::new();
    if regular(&registry)? {
        let records: Value = serde_json::from_str(&fs::read_to_string(&registry).map_err(|_| ERROR.to_string())?).map_err(|_| ERROR.to_string())?;
        let records = records.as_array().ok_or(ERROR)?; if records.len() > 100_000 { return Err(ERROR.into()); }
        for record in records {
            let path = PathBuf::from(record["path"].as_str().ok_or(ERROR)?); if !path.is_absolute() { return Err(ERROR.into()); }
            // Authenticate the shared protocol before trusting any cleanup record.
            let plain = super::decrypt(record["replacement"].as_str().filter(|s| s.starts_with("enc:")).ok_or(ERROR)?)?;
            let payload: Value = serde_json::from_str(&plain).map_err(|_| ERROR.to_string())?;
            if record["owner"] != "o8" || payload["owner"] != "o8" || payload["path"] != record["path"] || payload["runtime"] != record["runtime"] || !payload["contents"].is_string() { return Err(ERROR.into()); }
            found.insert(path, record["runtime"].as_str().ok_or(ERROR)?.into());
        }
    }
    let mut seen = 0;
    for (name, runtime, depth) in [("codex-orchestrator", "codex", 6), ("hermes-o8", "hermes", 3), ("mcp", "claude-code", 1)] { walk(&dir.join(name), runtime, depth, &mut seen, &mut found)?; }
    for entry in fs::read_dir(dir).map_err(|_| ERROR.to_string())? {
        let entry = entry.map_err(|_| ERROR.to_string())?; let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with("owned-") && name.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-') { walk(&entry.path(), if name.contains("hermes") { "hermes" } else { "codex" }, 6, &mut seen, &mut found)?; }
    }
    for (name, value) in std::env::vars() { if (name.starts_with("O8_OWNED_") || name.starts_with("CORTEX_IDE_OWNED_")) && name.ends_with("_ROOT") && !value.is_empty() {
        let root = PathBuf::from(&value); if !root.is_absolute() { return Err(ERROR.into()); }
        let runtime = if name.contains("HERMES") { "hermes" } else { "codex" };
        walk(&root, runtime, 6, &mut seen, &mut found)?; walk(&PathBuf::from(format!("{}-archive", value.trim_end_matches('/'))), runtime, 6, &mut seen, &mut found)?;
    } }
    let home = std::env::var_os("HOME").filter(|value| !value.is_empty())
        .or_else(|| std::env::var_os("USERPROFILE").filter(|value| !value.is_empty()));
    if let Some(home) = home { walk(&PathBuf::from(home).join(".openclaw-o8"), "openclaw", 5, &mut seen, &mut found)?; }
    for entry in fs::read_dir(std::env::temp_dir()).map_err(|_| ERROR.to_string())? { let entry = entry.map_err(|_| ERROR.to_string())?; let name = entry.file_name().to_string_lossy().into_owned(); if name.starts_with("o8-codex-app-") && name.ends_with(".json") { found.insert(entry.path(), "codex".into()); } }
    let mut prepared = Vec::new(); let mut records = Vec::new();
    for (path, runtime) in found {
        if !regular(&path)? { continue; }
        // Snapshot ancestry before either reading or opening the leaf. The read
        // and later scrub use one descriptor, so parent replacement cannot redirect them.
        let parents = parent_snapshot(&path)?;
        let before = fs::symlink_metadata(&path).map_err(|_| ERROR.to_string())?;
        let mut options = fs::OpenOptions::new(); options.read(true).write(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK); }
        let mut file = options.open(&path).map_err(|_| ERROR.to_string())?;
        let opened = file.metadata().map_err(|_| ERROR.to_string())?;
        if !opened.is_file() { return Err(ERROR.into()); }
        #[cfg(unix)] { use std::os::unix::fs::MetadataExt; if before.dev() != opened.dev() || before.ino() != opened.ino() || opened.nlink() != 1 || opened.uid() != unsafe { libc::geteuid() } { return Err(ERROR.into()); } }
        assert_parents(&parents)?;
        let mut raw = String::new(); file.read_to_string(&mut raw).map_err(|_| ERROR.to_string())?;
        assert_parents(&parents)?;
        let safe = clean(&path, &raw, &runtime, &materials)?;
        let payload = serde_json::json!({"path": path, "runtime": runtime, "owner": "o8", "contents": safe});
        records.push(serde_json::json!({"path": path, "runtime": runtime, "owner": "o8", "replacement": super::encrypt(&payload.to_string())?}));
        prepared.push((file, safe, parents));
    }
    let mut nonce = [0u8; 12]; super::OsRng.fill_bytes(&mut nonce);
    let temporary = dir.join(format!(".owned-credential-artifacts-{}.tmp", hex::encode(nonce)));
    super::create_private(&temporary, serde_json::to_string(&records).map_err(|_| ERROR.to_string())?.as_bytes())?;
    fs::rename(&temporary, &registry).map_err(|_| ERROR.to_string())?;
    for (file, safe, parents) in prepared { write_prepared(file, &safe, &parents)?; }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    #[test]
    fn parent_replacement_cannot_redirect_prepared_native_scrub() {
        let root = std::env::temp_dir().join(format!("o8-runtime-artifact-race-{}", std::process::id()));
        let root = { fs::create_dir_all(&root).unwrap(); fs::canonicalize(root).unwrap() };
        let owned = root.join("owned"); let moved = root.join("moved"); let outside = root.join("outside");
        fs::create_dir(&owned).unwrap(); fs::create_dir(&outside).unwrap();
        let file = owned.join("auth.json"); fs::write(&file, "owned").unwrap(); fs::write(outside.join("auth.json"), "operator").unwrap();
        let parents = parent_snapshot(&file).unwrap();
        let opened = fs::OpenOptions::new().read(true).write(true).open(&file).unwrap();
        fs::rename(&owned, &moved).unwrap(); symlink(&outside, &owned).unwrap();
        assert!(write_prepared(opened, "safe", &parents).is_err());
        assert_eq!(fs::read_to_string(outside.join("auth.json")).unwrap(), "operator");
        assert_eq!(fs::read_to_string(moved.join("auth.json")).unwrap(), "owned");
        fs::remove_dir_all(root).unwrap();
    }
}
