//! Persistent dictation history (Symon parity).
//!
//! Every completed system dictation (Fn push-to-talk, double-tap long-form) and
//! Ask question is appended to `~/.o8/dictation-history.json` so the operator
//! can retrieve EXACTLY what they said when a paste lands in the wrong place —
//! the safety net that cuts down lost-dictation pain. Newest-trimmed to a cap.
//!
//! Plain JSON (no DB dep). Writes are atomic (temp + rename) so a concurrent
//! settings read never sees a half-written file. Records are serial (one per
//! finalize), so no lock is needed on the write side.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_ENTRIES: usize = 200;

#[derive(Serialize, Deserialize, Clone)]
pub struct HistoryEntry {
    /// Unique id (nanosecond stamp) for the React key + delete targeting.
    pub id: String,
    /// Unix seconds.
    pub ts: i64,
    /// "dictation" | "ask" | "speak-selection".
    pub mode: String,
    /// The polished text that was pasted / the question that was asked.
    pub text: String,
    /// Best-effort target app bundle id (where it pasted), empty if unknown.
    pub app: String,
}

/// `~/.o8` (env-overridable), mirroring the STT key resolver — kept dependency-
/// free so it never triggers the cortex-ide → o8 migration.
fn data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("O8_DATA_DIR") {
        return PathBuf::from(dir);
    }
    if let Ok(dir) = std::env::var("CORTEX_IDE_DATA_DIR") {
        return PathBuf::from(dir);
    }
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".o8")
}

fn history_path() -> PathBuf {
    data_dir().join("dictation-history.json")
}

fn load() -> Vec<HistoryEntry> {
    std::fs::read_to_string(history_path())
        .ok()
        .and_then(|raw| serde_json::from_str::<Vec<HistoryEntry>>(&raw).ok())
        .unwrap_or_default()
}

fn save(entries: &[HistoryEntry]) {
    let path = history_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let Ok(serialized) = serde_json::to_string_pretty(entries) else {
        return;
    };
    // Atomic write: temp + rename so a reader never sees a partial file.
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, serialized).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn new_id() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

/// Append one entry (no-op for empty text). Trims oldest past the cap.
pub fn record(mode: &str, text: &str, app: Option<String>) {
    if text.trim().is_empty() {
        return;
    }
    let mut entries = load();
    entries.push(HistoryEntry {
        id: new_id(),
        ts: now_secs(),
        mode: mode.to_string(),
        text: text.trim().to_string(),
        app: app.unwrap_or_default(),
    });
    if entries.len() > MAX_ENTRIES {
        let excess = entries.len() - MAX_ENTRIES;
        entries.drain(0..excess);
    }
    save(&entries);
}

/// All entries, NEWEST FIRST (for the settings list).
pub fn list() -> Vec<HistoryEntry> {
    let mut entries = load();
    entries.reverse();
    entries
}

/// Clear the whole history.
pub fn clear() {
    save(&[]);
}

/// Delete a single entry by id.
pub fn delete(id: &str) {
    let mut entries = load();
    entries.retain(|e| e.id != id);
    save(&entries);
}
