mod audio_ducker;
mod background;
mod dev_frontend;
mod dictation_history;
mod dock_window;
mod fn_hotkey;
mod launch_updater;
mod mac_perms;
mod paste;
mod sidecar_lifecycle;
mod sound;
mod speech_text;
#[cfg(target_os = "macos")]
mod stt;
#[cfg(target_os = "macos")]
mod tts;
#[cfg(target_os = "macos")]
mod ai;
mod webview_latch;

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::collections::VecDeque;
use std::path::Path;
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, RunEvent,
};
use tauri_plugin_notification::NotificationExt;
use webview_latch::WebviewLatch;
#[cfg(target_os = "macos")]
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
#[cfg(target_os = "windows")]
use window_vibrancy::apply_blur;

// ── macOS Keychain integration ──
//
// The AES-256-GCM master key that protects API keys at rest is stored in the
// macOS Keychain under a well-known service / account pair. We shell out to
// the `security` CLI (always present on macOS) rather than pulling in a
// keychain crate, keeping the dependency tree minimal.
//
// On non-macOS platforms these functions are not compiled. The TypeScript
// layer falls back to an env-var / config-file key on those platforms.

/// Keychain service name — identifies the o8 application.
const KEYCHAIN_SERVICE: &str = "ai.o8.master-key";
/// Keychain account name — a single per-install master key slot.
const KEYCHAIN_ACCOUNT: &str = "default";

fn env_flag_enabled(name: &str) -> bool {
    matches!(std::env::var(name).as_deref(), Ok("1"))
}

/// Minimal URL-safe base64 encoder (no padding, no external crate).
/// Used only for the 32-byte master key.
fn base64_encode_url(data: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity((data.len() * 4 + 2) / 3);
    let mut i = 0;
    while i < data.len() {
        let b0 = data[i] as u32;
        let b1 = if i + 1 < data.len() { data[i + 1] as u32 } else { 0 };
        let b2 = if i + 2 < data.len() { data[i + 2] as u32 } else { 0 };
        out.push(TABLE[((b0 >> 2) & 0x3f) as usize] as char);
        out.push(TABLE[(((b0 << 4) | (b1 >> 4)) & 0x3f) as usize] as char);
        if i + 1 < data.len() {
            out.push(TABLE[(((b1 << 2) | (b2 >> 6)) & 0x3f) as usize] as char);
        }
        if i + 2 < data.len() {
            out.push(TABLE[(b2 & 0x3f) as usize] as char);
        }
        i += 3;
    }
    out
}

#[cfg(target_os = "macos")]
fn keychain_find_password() -> Option<String> {
    let out = Command::new("security")
        .args([
            "find-generic-password",
            "-s", KEYCHAIN_SERVICE,
            "-a", KEYCHAIN_ACCOUNT,
            "-w",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let pw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if pw.is_empty() { None } else { Some(pw) }
}

#[cfg(target_os = "macos")]
fn keychain_add_password(password: &str) -> bool {
    // -U updates an existing entry if one already exists.
    Command::new("security")
        .args([
            "add-generic-password",
            "-s", KEYCHAIN_SERVICE,
            "-a", KEYCHAIN_ACCOUNT,
            "-w", password,
            "-U",
        ])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Generate a cryptographically random 256-bit key encoded as URL-safe base64.
#[cfg(target_os = "macos")]
fn generate_master_key() -> String {
    use std::io::Read;
    let mut bytes = [0u8; 32];
    // /dev/urandom is always available on macOS.
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let _ = f.read_exact(&mut bytes);
    }
    base64_encode_url(&bytes)
}

/// Retrieve the master encryption key from the Keychain.
/// Returns Err("keychain-miss") if the entry does not exist.
#[cfg(target_os = "macos")]
#[tauri::command]
fn master_key_get() -> Result<String, String> {
    keychain_find_password().ok_or_else(|| "keychain-miss".to_string())
}

/// Retrieve the master key, creating and storing a new one if absent.
/// Idempotent — multiple calls return the same key.
#[cfg(target_os = "macos")]
#[tauri::command]
fn master_key_ensure() -> Result<String, String> {
    if env_flag_enabled("O8_PRESHIP_GATE") {
        return Err("preship-gate-keychain-disabled".to_string());
    }
    if let Some(existing) = keychain_find_password() {
        return Ok(existing);
    }
    let key = generate_master_key();
    if keychain_add_password(&key) {
        log::info!("[keychain] Master key created and stored (service={} account={})", KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
        Ok(key)
    } else {
        Err("keychain-write-failed".to_string())
    }
}

// ── Data directory resolution ──
//
// Canonical location: ~/.o8 (was ~/.cortex-ide before the April 13 rebrand).
// On first launch of the renamed binary we copy the old dir into the new
// location once, drop a marker file, and never touch it again. The old dir
// is left in place so rolling back to an older installer still works.
//
// Priority:
//   1. O8_DATA_DIR      — explicit override, no migration
//   2. CORTEX_IDE_DATA_DIR — legacy override, also no migration
//   3. ~/.o8           — default, auto-migrate from ~/.cortex-ide on first use

fn o8_data_dir() -> String {
    if let Ok(dir) = std::env::var("O8_DATA_DIR") {
        return dir;
    }
    if let Ok(dir) = std::env::var("CORTEX_IDE_DATA_DIR") {
        return dir;
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let new_dir = format!("{}/.o8", home);
    migrate_data_dir_once(&home, &new_dir);
    new_dir
}

fn migrate_data_dir_once(home: &str, new_dir: &str) {
    let marker = format!("{}/.migrated-from-cortex-ide", new_dir);
    if std::path::Path::new(&marker).exists() {
        return;
    }
    let old_dir = format!("{}/.cortex-ide", home);
    let old_exists = std::path::Path::new(&old_dir).exists();
    let new_exists = std::path::Path::new(new_dir).exists();

    if !new_exists && !old_exists {
        let _ = std::fs::create_dir_all(new_dir);
        let _ = std::fs::write(&marker, format!("Fresh install on {:?}\n", std::time::SystemTime::now()));
        return;
    }
    if new_exists {
        let has_content = std::fs::read_dir(new_dir)
            .map(|mut entries| entries.next().is_some())
            .unwrap_or(false);
        if has_content {
            let _ = std::fs::write(&marker, format!("Existing dir on {:?}\n", std::time::SystemTime::now()));
            return;
        }
    }
    if old_exists {
        log::info!("[data-dir] Migrating {} → {}", old_dir, new_dir);
        let _ = std::fs::create_dir_all(new_dir);
        if let Err(e) = copy_dir_recursive(&old_dir, new_dir) {
            log::warn!("[data-dir] Migration failed: {}", e);
        } else {
            let _ = std::fs::write(&marker, format!("Migrated from {} on {:?}\n", old_dir, std::time::SystemTime::now()));
            log::info!("[data-dir] Migration complete. Old dir left at {} for rollback.", old_dir);
        }
    }
}

fn copy_dir_recursive(src: &str, dst: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let file_name = entry.file_name();
        let dst_path = std::path::Path::new(dst).join(&file_name);
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(src_path.to_str().unwrap_or(""), dst_path.to_str().unwrap_or(""))?;
        } else {
            std::fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

// ── Codebase Memory MCP runtime download (issue #755 / #739) ──
//
// The Context Engine v2 (epic #738) ships a static `codebase-memory-mcp`
// binary so the production app can index repos and answer recall queries
// without a separate install step. Each architecture's binary is ~161 MB
// — bundling it would balloon the installer (148 MB → 309 MB on disk),
// so we download it on first launch into `~/.o8/bin/` instead. Every
// subsequent launch re-uses the cached binary.
//
// Strategy:
//   1. If `~/.o8/bin/codebase-memory-mcp` exists with the expected SHA →
//      set `O8_CODEBASE_MEMORY_BIN` and return immediately. No network.
//   2. Otherwise download the matching-arch tarball from the upstream
//      DeusData release, verify SHA-256 against the pinned constant,
//      extract the binary, chmod +x, set the env var.
//   3. On any failure: log + emit `codebase-memory:status` = "error" +
//      set `O8_CODEBASE_MEMORY_BIN=""` so #740's MCP registration sees
//      the variable but skips the entry gracefully.
//
// The whole flow runs on a background thread so it never blocks the
// Tauri builder's `setup` callback. By the time #740's MCP registration
// runs (orchestrator-session.ts spawns Claude Code), the env var is
// either populated (binary cached or freshly downloaded) or empty
// (download failed). Either way startup is unblocked.
//
// Pin: bump `CODEBASE_MEMORY_VERSION` and the matching `CODEBASE_MEMORY_CHECKSUMS`
// entries to upgrade. SHA-256 values come from the upstream release
// `checksums.txt` for that tag. See `docs/codebase-memory-build.md`.

const CODEBASE_MEMORY_VERSION: &str = "0.6.0";
const CODEBASE_MEMORY_REPO: &str = "DeusData/codebase-memory-mcp";

/// SHA-256 of the upstream archive (tar.gz / zip) — the binary inside
/// inherits its integrity from the verified archive. Bump these together
/// with `CODEBASE_MEMORY_VERSION`.
fn codebase_memory_archive_sha(asset: &str) -> Option<&'static str> {
    match asset {
        "codebase-memory-mcp-darwin-amd64.tar.gz" => Some("a4d09d97fe1f47e1a0a23309bc34d9937f74c61950bed3259f9576800cc78727"),
        "codebase-memory-mcp-darwin-arm64.tar.gz" => Some("a1d3f8a4c353ab94ea8fe1fb60159758020f2f256c9652699a0bd6725189a439"),
        "codebase-memory-mcp-linux-amd64.tar.gz"  => Some("0dfd70f73337219925f3ec6a572fe776dbbe1c4c8c6ab546ab214fe16e56a426"),
        "codebase-memory-mcp-linux-arm64.tar.gz"  => Some("f1fad27262fe7af4a356af128e43942355cb2189491079b6790ecc5ae3af069c"),
        "codebase-memory-mcp-windows-amd64.zip"   => Some("da3d7d7bd6f687b697145457ff9d113ecf6daffe173d236457a43223e89a5e9c"),
        _ => None,
    }
}

/// (asset_name, binary_name, is_zip) for the running host. Returns None
/// when the host doesn't match any upstream prebuilt — in that case we
/// skip silently and let #740 omit the MCP entry.
fn detect_codebase_memory_asset() -> Option<(&'static str, &'static str, bool)> {
    if cfg!(target_os = "macos") {
        if cfg!(target_arch = "x86_64") {
            return Some(("codebase-memory-mcp-darwin-amd64.tar.gz", "codebase-memory-mcp", false));
        }
        if cfg!(target_arch = "aarch64") {
            return Some(("codebase-memory-mcp-darwin-arm64.tar.gz", "codebase-memory-mcp", false));
        }
    } else if cfg!(target_os = "linux") {
        if cfg!(target_arch = "x86_64") {
            return Some(("codebase-memory-mcp-linux-amd64.tar.gz", "codebase-memory-mcp", false));
        }
        if cfg!(target_arch = "aarch64") {
            return Some(("codebase-memory-mcp-linux-arm64.tar.gz", "codebase-memory-mcp", false));
        }
    } else if cfg!(target_os = "windows") && cfg!(target_arch = "x86_64") {
        return Some(("codebase-memory-mcp-windows-amd64.zip", "codebase-memory-mcp.exe", true));
    }
    None
}

/// Hash a local file with SHA-256, returned as lowercase hex.
fn sha256_file(path: &std::path::Path) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 { break; }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Spawn a background thread that ensures the codebase-memory-mcp binary
/// is available at `~/.o8/bin/codebase-memory-mcp`. On success sets the
/// `O8_CODEBASE_MEMORY_BIN` env var on the parent process so any later
/// child inherits it (mirrors the `O8_NODE_BIN` pattern). On failure
/// sets the var to an empty string — downstream MCP registration in
/// #740 treats empty/unset as "feature unavailable".
fn ensure_codebase_memory_binary(app: AppHandle) {
    std::thread::spawn(move || {
        let Some((asset_name, binary_name, is_zip)) = detect_codebase_memory_asset() else {
            log::info!(
                "[codebase-memory] no prebuilt for {}/{} — skipping",
                std::env::consts::OS, std::env::consts::ARCH
            );
            std::env::set_var("O8_CODEBASE_MEMORY_BIN", "");
            return;
        };
        let Some(expected_sha) = codebase_memory_archive_sha(asset_name) else {
            log::warn!("[codebase-memory] no checksum pinned for {}", asset_name);
            std::env::set_var("O8_CODEBASE_MEMORY_BIN", "");
            return;
        };

        let bin_dir = format!("{}/bin", o8_data_dir());
        if let Err(e) = std::fs::create_dir_all(&bin_dir) {
            log::warn!("[codebase-memory] mkdir {} failed: {}", bin_dir, e);
            std::env::set_var("O8_CODEBASE_MEMORY_BIN", "");
            return;
        }
        let bin_path = std::path::PathBuf::from(&bin_dir).join(binary_name);
        let sentinel_path = std::path::PathBuf::from(&bin_dir).join(".codebase-memory-mcp.version");

        // Cache hit: existing binary + matching version sentinel = ready.
        // Skipping the hash on cache hit keeps re-launches snappy
        // (~150 MB hash takes meaningful time on slow disks). The
        // sentinel encodes both version + asset so a partial re-extract
        // or arch mismatch fails the check.
        let expected_tag = format!("{}-{}", CODEBASE_MEMORY_VERSION, asset_name);
        if bin_path.exists() {
            if let Ok(tag) = std::fs::read_to_string(&sentinel_path) {
                if tag.trim() == expected_tag {
                    log::info!("[codebase-memory] cached: {} v{}", binary_name, CODEBASE_MEMORY_VERSION);
                    let bin_str = bin_path.to_string_lossy().to_string();
                    std::env::set_var("O8_CODEBASE_MEMORY_BIN", &bin_str);
                    let _ = app.emit("codebase-memory:status", "ready");
                    return;
                }
            }
        }

        let _ = app.emit("codebase-memory:status", "downloading");

        // Materialise the archive into a tmp file, verify SHA, extract,
        // move the binary into place. Any failure on this path leaves
        // the env var empty so downstream code skips the MCP entry.
        let url = format!(
            "https://github.com/{}/releases/download/v{}/{}",
            CODEBASE_MEMORY_REPO, CODEBASE_MEMORY_VERSION, asset_name
        );
        let tmp_root = std::env::temp_dir().join(format!("o8-cmm-{}", std::process::id()));
        if let Err(e) = std::fs::create_dir_all(&tmp_root) {
            log::warn!("[codebase-memory] mkdir tmp failed: {}", e);
            std::env::set_var("O8_CODEBASE_MEMORY_BIN", "");
            let _ = app.emit("codebase-memory:status", "error");
            return;
        }
        let archive_path = tmp_root.join(asset_name);

        log::info!("[codebase-memory] fetching {} v{}", asset_name, CODEBASE_MEMORY_VERSION);
        let download_result: Result<(), String> = (|| {
            let client = reqwest::blocking::Client::builder()
                .timeout(std::time::Duration::from_secs(120))
                .build()
                .map_err(|e| format!("client build: {}", e))?;
            let mut resp = client.get(&url).send().map_err(|e| format!("send: {}", e))?;
            if !resp.status().is_success() {
                return Err(format!("HTTP {}", resp.status()));
            }
            let mut out = std::fs::File::create(&archive_path).map_err(|e| format!("create archive: {}", e))?;
            std::io::copy(&mut resp, &mut out).map_err(|e| format!("write archive: {}", e))?;
            Ok(())
        })();

        if let Err(e) = download_result {
            log::warn!("[codebase-memory] download failed (non-fatal): {}", e);
            std::env::set_var("O8_CODEBASE_MEMORY_BIN", "");
            let _ = app.emit("codebase-memory:status", "error");
            let _ = std::fs::remove_dir_all(&tmp_root);
            return;
        }

        let actual_sha = match sha256_file(&archive_path) {
            Ok(s) => s,
            Err(e) => {
                log::warn!("[codebase-memory] hash failed: {}", e);
                std::env::set_var("O8_CODEBASE_MEMORY_BIN", "");
                let _ = app.emit("codebase-memory:status", "error");
                let _ = std::fs::remove_dir_all(&tmp_root);
                return;
            }
        };
        if actual_sha != expected_sha {
            log::warn!(
                "[codebase-memory] SHA mismatch: expected {}, got {}",
                expected_sha, actual_sha
            );
            std::env::set_var("O8_CODEBASE_MEMORY_BIN", "");
            let _ = app.emit("codebase-memory:status", "error");
            let _ = std::fs::remove_dir_all(&tmp_root);
            return;
        }

        // Extract via system `tar` / `unzip`. Both ship on every macOS
        // and Linux host; Windows ships unzip via PowerShell's
        // Expand-Archive but we don't ship a Windows installer today.
        let extract_result: Result<(), String> = (|| {
            let archive_str = archive_path.to_string_lossy();
            let tmp_str = tmp_root.to_string_lossy();
            if is_zip {
                let status = Command::new("unzip")
                    .args(["-o", &archive_str, "-d", &tmp_str])
                    .status()
                    .map_err(|e| format!("unzip spawn: {}", e))?;
                if !status.success() {
                    return Err(format!("unzip exit {}", status));
                }
            } else {
                let status = Command::new("tar")
                    .args(["-xzf", &archive_str, "-C", &tmp_str])
                    .status()
                    .map_err(|e| format!("tar spawn: {}", e))?;
                if !status.success() {
                    return Err(format!("tar exit {}", status));
                }
            }
            Ok(())
        })();

        if let Err(e) = extract_result {
            log::warn!("[codebase-memory] extract failed: {}", e);
            std::env::set_var("O8_CODEBASE_MEMORY_BIN", "");
            let _ = app.emit("codebase-memory:status", "error");
            let _ = std::fs::remove_dir_all(&tmp_root);
            return;
        }

        let extracted = tmp_root.join(binary_name);
        if !extracted.exists() {
            log::warn!("[codebase-memory] binary not found in archive: {:?}", extracted);
            std::env::set_var("O8_CODEBASE_MEMORY_BIN", "");
            let _ = app.emit("codebase-memory:status", "error");
            let _ = std::fs::remove_dir_all(&tmp_root);
            return;
        }

        // copy + rename into place. fs::rename can fail across tmpfs ↔
        // home-dir filesystem boundaries, so copy + remove keeps it
        // robust.
        if let Err(e) = std::fs::copy(&extracted, &bin_path) {
            log::warn!("[codebase-memory] install failed: {}", e);
            std::env::set_var("O8_CODEBASE_MEMORY_BIN", "");
            let _ = app.emit("codebase-memory:status", "error");
            let _ = std::fs::remove_dir_all(&tmp_root);
            return;
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&bin_path, std::fs::Permissions::from_mode(0o755));
        }

        if let Err(e) = std::fs::write(&sentinel_path, &expected_tag) {
            log::warn!("[codebase-memory] sentinel write failed: {}", e);
            // Not fatal — next launch will re-verify and re-extract.
        }
        let _ = std::fs::remove_dir_all(&tmp_root);

        let bin_str = bin_path.to_string_lossy().to_string();
        log::info!("[codebase-memory] installed at {}", bin_str);
        std::env::set_var("O8_CODEBASE_MEMORY_BIN", &bin_str);
        let _ = app.emit("codebase-memory:status", "ready");
    });
}

// ── Dynamic port allocation ──
//
// A packaged Tauri app can't assume port 3001 is free — another dev tool,
// a running o8 dev server, or an unrelated service may already own it.
// `find_free_port(preferred)` probes from the preferred port upward and
// returns the first one that binds successfully. The result is persisted
// to `~/.cortex-ide/api-port` so downstream consumers (the MCP server,
// `/api/setup/mcp-config`, the orchestrator session config writer) all
// agree on where the backend actually lives.

const API_PORT_RANGE: std::ops::Range<u16> = 3001..3050;
const WS_PORT_RANGE: std::ops::Range<u16> = 3002..3100;

/// Returns the first port in the range that can be bound to on 127.0.0.1.
/// `skip` lets the caller avoid picking the same port for API and WS.
fn find_free_port(range: std::ops::Range<u16>, skip: Option<u16>) -> Option<u16> {
    for port in range {
        if Some(port) == skip {
            continue;
        }
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Some(port);
        }
    }
    None
}

/// Persist the chosen ports to the data dir so child processes (MCP server,
/// generators) can read the same values without guessing.
fn write_port_file(name: &str, port: u16) -> std::io::Result<()> {
    let dir = o8_data_dir();
    let _ = std::fs::create_dir_all(&dir);
    let path = format!("{}/{}", dir, name);
    std::fs::write(path, port.to_string())
}

// ── Orphan bundled-server detection (issue #509) ──
//
// When the Tauri shell is force-quit (kill -9) or crashes, its child Node
// process (the bundled Next server) can be reparented to launchd (pid 1)
// and keep holding port 3001. The naive `TcpStream::connect(...)` probe
// used to think any listener on :3001 was a legitimate `npm run
// desktop:dev` server and defer to it, leaving the user with a half-dead
// app (orphan Next but no ws-server, stale state, silent hangs).
//
// We now classify the listener before deciding:
//   1. Free      → spawn bundled as normal.
//   2. Active o8 → defer (a dev server or another live sidecar owns it).
//   3. Orphan    → SIGKILL, wait for port release, spawn bundled fresh.
//
// On macOS we shell out to `lsof` / `ps` / `kill` because they're part of
// the base system and avoid pulling in a new crate. On other platforms
// the orphan path is a no-op (tracked for #548 cross-platform work).

/// Lookup result for a port listener classification.
#[derive(Debug)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
enum PortListener {
    /// Nothing listening on the port.
    Free,
    /// Legitimate listener. Defer only when it looks o8-owned.
    Legit {
        pid: u32,
        command: String,
        o8_owned: bool,
    },
    /// Orphan reparented to launchd that still owns the bundled server.
    Orphan { pid: u32, command: String },
}

#[cfg(target_os = "macos")]
fn classify_port_listener(port: u16) -> PortListener {
    // First: quick TCP connect probe. Cheap check — if nothing answers we
    // skip lsof entirely.
    if std::net::TcpStream::connect(format!("127.0.0.1:{}", port)).is_err() {
        return PortListener::Free;
    }

    // Find the owning PID via lsof. `-t` prints only the pid, `-sTCP:LISTEN`
    // filters to listeners, and we scope to the port to keep output tiny.
    let lsof = Command::new("lsof")
        .args([
            "-nP",
            &format!("-iTCP:{}", port),
            "-sTCP:LISTEN",
            "-t",
        ])
        .output();
    let pid = match lsof {
        Ok(out) if out.status.success() => {
            let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
            // lsof can return multiple pids on separate lines when IPv4 and
            // IPv6 share the same listener — take the first.
            raw.lines().next().and_then(|s| s.trim().parse::<u32>().ok())
        }
        _ => None,
    };

    let Some(pid) = pid else {
        // Something is listening per TCP connect, but lsof couldn't tell us
        // who. Treat as legit to stay conservative.
        log::warn!("[orphan-check] Port :{} is bound but lsof returned no pid", port);
        return PortListener::Legit {
            pid: 0,
            command: "<unknown>".to_string(),
            o8_owned: false,
        };
    };

    // Grab the owner's ppid + command line with `ps`. `-o` fields are comma
    // separated in BSD ps; `command` gives the full argv.
    let ps = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "ppid=,command="])
        .output();
    let (ppid, command) = match ps {
        Ok(out) if out.status.success() => {
            let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
            // The first whitespace-separated token is ppid; the rest is the
            // full command line (which may itself contain spaces).
            let mut parts = raw.splitn(2, char::is_whitespace);
            let ppid = parts.next().and_then(|s| s.trim().parse::<u32>().ok()).unwrap_or(0);
            let command = parts.next().unwrap_or("").trim().to_string();
            (ppid, command)
        }
        _ => (0, String::new()),
    };

    let cwd = sidecar_lifecycle::process_cwd(pid);
    log::info!(
        "[orphan-check] :{} bound by pid={} ppid={} cwd={:?} cmd={:?}",
        port, pid, ppid, cwd, command
    );

    // Orphan signature: parent is launchd (pid 1) AND the binary path
    // points into the packaged app's server bundle. We accept either
    // `/Applications/o8.app/Contents/Resources/server/server.js` (signed
    // install) or the more general `.app/Contents/Resources/server`
    // substring in case someone installed under a different prefix.
    let looks_bundled =
        command.contains(".app/Contents/Resources/server")
        || command.contains("/Resources/server/server.js")
        || cwd.contains(".app/Contents/Resources/server")
        || (command.ends_with("server.js") && sidecar_lifecycle::cwd_looks_o8_owned(&cwd));

    if ppid == 1 && looks_bundled {
        PortListener::Orphan { pid, command }
    } else {
        PortListener::Legit {
            pid,
            command,
            o8_owned: sidecar_lifecycle::cwd_looks_o8_owned(&cwd),
        }
    }
}

#[cfg(not(target_os = "macos"))]
#[allow(dead_code)]
fn classify_port_listener(port: u16) -> PortListener {
    // TODO(#548): implement Windows/Linux orphan detection. Until then we
    // fall back to dynamic bundled-port allocation instead of killing or
    // deferring to an unclassified listener.
    if std::net::TcpStream::connect(format!("127.0.0.1:{}", port)).is_ok() {
        PortListener::Legit {
            pid: 0,
            command: "<unsupported-platform>".to_string(),
            o8_owned: false,
        }
    } else {
        PortListener::Free
    }
}

// ── Child process log capture ──
//
// The bundled Next.js server and WS server each get their own log file
// under `~/.cortex-ide/logs/`. On each boot the previous log is rotated to
// `<name>.prev` so we always have the last two runs available for
// post-mortem. Without this, silent production failures (like the hung
// Next.js loop from 2026-04-11) are impossible to diagnose because stderr
// is discarded and there are no devtools in release builds.
//
/// Open a truncating log file at `~/.cortex-ide/logs/<name>`, rotating any
/// prior run to `<name>.prev` first. Returns `None` if the filesystem is
/// unwritable (we prefer to keep the app bootable rather than failing loud).
fn open_child_log(name: &str) -> Option<std::fs::File> {
    let dir = format!("{}/logs", o8_data_dir());
    if let Err(e) = std::fs::create_dir_all(&dir) {
        log::warn!("Could not create log dir {}: {}", dir, e);
        return None;
    }
    let path = format!("{}/{}", dir, name);
    let prev = format!("{}.prev", path);
    let _ = std::fs::rename(&path, &prev);
    match std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
    {
        Ok(f) => {
            log::info!("Child log → {}", path);
            Some(f)
        }
        Err(e) => {
            log::warn!("Could not open child log {}: {}", path, e);
            None
        }
    }
}

/// Build a `Stdio` suitable for piping a child's output to a log file,
/// falling back to discarding the stream if the file couldn't be opened.
fn child_stdio(file: Option<&std::fs::File>) -> std::process::Stdio {
    match file {
        Some(f) => match f.try_clone() {
            Ok(clone) => std::process::Stdio::from(clone),
            Err(_) => std::process::Stdio::null(),
        },
        None => std::process::Stdio::null(),
    }
}

fn prewarm_bundled_next_server(app: AppHandle, api_port: u16) {
    std::thread::spawn(move || {
        let url = format!("http://127.0.0.1:{}/dashboard", api_port);
        std::thread::sleep(std::time::Duration::from_millis(150));

        let client = match reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_millis(1500))
            .build()
        {
            Ok(client) => client,
            Err(_) => return,
        };

        // Poll the bundled server until it answers. The dock pill window
        // (system-wide Symon fold P3) is created only AFTER the server is
        // confirmed up — it navigates to /dictation-pill on the same port, so
        // it must not be built against a dead listener (same reason main waits
        // via the loader before /dashboard). The longer cap here (vs the old
        // 4-attempt warm-only loop) gives a cold next-server time to bind.
        let mut server_up = false;
        for attempt in 0..40 {
            if client.get(&url).header("Connection", "close").send().is_ok() {
                server_up = true;
                break;
            }
            if attempt < 39 {
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
        }

        if !server_up {
            log::warn!("[dock-window] bundled Next server never answered; skipping dock pill");
            return;
        }

        // Window creation must run on the main thread.
        let app_main = app.clone();
        let _ = app.run_on_main_thread(move || {
            dock_window::create(&app_main, api_port);
        });
    });
}

fn spawn_bundled_ws_server(
    node_bin: &str,
    server_dir: &std::path::Path,
    ws_port: u16,
    next_origin: &str,
    ws_log: Option<&std::fs::File>,
    ai_keys: &[(String, String)],
) {
    let ws_server_js = server_dir.join("ws-server.mjs");
    if ws_server_js.exists() {
        log::info!("Starting WS server: {} {:?} on :{}", node_bin, ws_server_js, ws_port);
        let mut ws_cmd = Command::new(node_bin);
        ws_cmd
            .arg(&ws_server_js)
            .current_dir(server_dir)
            .env("O8_NODE_BIN", node_bin)
            .env("WS_PORT", ws_port.to_string())
            .env("NEXT_ORIGIN", next_origin)
            // Issue #776: same sidecar marker as the next-server child.
            .env("O8_SIDECAR_PID", std::process::id().to_string());
        // Issue #935: same AI key forward for ws-server children.
        for (k, v) in ai_keys {
            ws_cmd.env(k, v);
        }
        match ws_cmd
            .stdout(child_stdio(ws_log))
            .stderr(child_stdio(ws_log))
            .spawn()
        {
            Ok(child) => {
                let pid = child.id();
                log::info!("WS server started (pid: {})", pid);
                sidecar_lifecycle::register_child(pid);
            }
            Err(e) => {
                log::error!("Failed to start WS server: {}", e);
            }
        }
    } else {
        log::error!(
            "ws-server.mjs missing from bundle at {:?} — this will break the WebSocket bridge and may hang the Next.js server",
            ws_server_js
        );
    }
}

// ── Node.js pre-flight ──
//
// Finder-launched Tauri apps inherit a minimal PATH (`/usr/bin:/bin`) that
// does not include `~/.nvm/...`, `~/.fnm/...`, `~/.volta/bin`, etc. A user
// can have Node perfectly installed in their terminal but the bundled
// server fails to spawn with a cryptic ENOENT.
//
// `resolve_node_via_login_shell()` runs a login shell (zsh → bash → sh) and
// asks it where `node` lives, yielding the real absolute path a terminal
// would see. If nothing works, returns None and the caller shows a dialog.

const MIN_NODE_MAJOR: u32 = 22;
// F40 (#1032): better-sqlite3 native binding is compiled against Node 22's
// ABI (NODE_MODULE_VERSION 127). Newer Node majors load the binding and
// throw NODE_MODULE_VERSION mismatch — next-server dies on first DB import,
// the HTTP listener never binds, the user sees "app up but not working."
// We prefer Node 22.x specifically when available, even if the user's
// login-shell default is a newer Node.
const PREFERRED_NODE_MAJOR: u32 = 22;

/// Look in well-known places for a Node 22.x install regardless of the user's
/// nvm/fnm/volta default. Order matches the rough population of users on each.
fn find_preferred_node_22() -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let glob_dirs: [(String, &str); 5] = [
        (format!("{}/.nvm/versions/node", home), "v22"),
        (format!("{}/.fnm/node-versions", home), "v22"),
        (format!("{}/.volta/tools/image/node", home), "22"),
        ("/opt/homebrew/opt/node@22".to_string(), ""),
        ("/usr/local/opt/node@22".to_string(), ""),
    ];
    for (dir, prefix) in glob_dirs {
        // Homebrew's node@22 keg has node directly at <keg>/bin/node — no
        // version-dir traversal needed.
        if prefix.is_empty() {
            let candidate = format!("{}/bin/node", dir);
            if let Some((22, _)) = check_node_version(&candidate) {
                return Some(candidate);
            }
            continue;
        }
        // nvm / fnm / volta lay out as <root>/<version>/bin/node or
        // <root>/<version>/installation/bin/node (fnm). Scan the version dirs.
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name_str = name.to_string_lossy();
                if !name_str.starts_with(prefix) {
                    continue;
                }
                let bases = [
                    entry.path().join("bin").join("node"),
                    entry.path().join("installation").join("bin").join("node"),
                ];
                for base in bases {
                    if let Some(p) = base.to_str() {
                        if let Some((22, _)) = check_node_version(p) {
                            return Some(p.to_string());
                        }
                    }
                }
            }
        }
    }
    None
}

fn resolve_node_via_login_shell() -> Option<String> {
    let shells: [(&str, &[&str]); 3] = [
        ("zsh", &["-l", "-c", "command -v node"]),
        ("bash", &["-l", "-c", "command -v node"]),
        ("sh", &["-l", "-c", "command -v node"]),
    ];
    for (shell, args) in shells {
        if let Ok(out) = Command::new(shell).args(args).output() {
            if out.status.success() {
                let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !path.is_empty() && std::path::Path::new(&path).exists() {
                    return Some(path);
                }
            }
        }
    }
    // Last resort: raw PATH lookup (in case the user really has it in
    // /usr/local/bin and Finder's PATH is fine).
    if let Ok(out) = Command::new("which").arg("node").output() {
        if out.status.success() {
            let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !path.is_empty() && std::path::Path::new(&path).exists() {
                return Some(path);
            }
        }
    }
    None
}

/// Finder-launched apps inherit a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`)
/// that omits the user's CLI dirs (`~/.npm-global/bin`, Homebrew, `~/.local/bin`,
/// pnpm/volta shims). The bundled Next server then can't find `codex`/`claude`/
/// `gh`/`pnpm`: setup detect shows "No tools detected", Codex dispatch spawn
/// ENOENTs, and worktree `pnpm install` fails. Mirror the node/key login-shell
/// resolution — ask a login shell for its PATH.
fn resolve_login_shell_path() -> Option<String> {
    let shells: [(&str, &[&str]); 3] = [
        ("zsh", &["-l", "-c", "printf %s \"$PATH\""]),
        ("bash", &["-l", "-c", "printf %s \"$PATH\""]),
        ("sh", &["-l", "-c", "printf %s \"$PATH\""]),
    ];
    for (shell, args) in shells {
        if let Ok(out) = Command::new(shell).args(args).output() {
            if out.status.success() {
                let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !path.is_empty() {
                    return Some(path);
                }
            }
        }
    }
    None
}

/// Prepend the login-shell PATH onto this process's PATH so every child we
/// spawn (Next server, ws-server, MCP, dispatched Codex workers) sees the same
/// PATH a terminal would. The sidecar still launches on the explicit Node 22
/// binary (`O8_NODE_BIN`), so this never disturbs the better-sqlite3 ABI pin —
/// it only widens what children can find. Dedup'd; minimal PATH kept as fallback.
fn augment_process_path_from_login_shell() {
    let login_path = match resolve_login_shell_path() {
        Some(p) => p,
        None => {
            log::warn!(
                "Could not resolve login-shell PATH; sidecar children keep the minimal \
                 Finder PATH — CLI detection (codex/claude/gh) and worktree installs may fail"
            );
            return;
        }
    };
    let current = std::env::var("PATH").unwrap_or_default();
    let mut merged: Vec<&str> = Vec::new();
    for entry in login_path.split(':').chain(current.split(':')) {
        if !entry.is_empty() && !merged.contains(&entry) {
            merged.push(entry);
        }
    }
    let merged = merged.join(":");
    log::info!(
        "Augmented PATH from login shell ({} entries) for sidecar children",
        merged.split(':').count()
    );
    std::env::set_var("PATH", merged);
}

/// Pulls AI provider API keys from the user's login shell (~/.zshenv etc.)
/// so Finder-launched packaged builds inherit keys the user already has.
/// Returns a Vec of (KEY, VALUE) pairs for whichever known AI vars exist.
/// Issue #935: Gemini-backed features (Suggest Projects, classifier) were
/// dead in the installed app because GUI launches don't read .zshenv.
fn load_ai_keys_from_login_shell() -> Vec<(String, String)> {
    const KEYS: &[&str] = &[
        "GOOGLE_AI_API_KEY",
        "GOOGLE_GENERATIVE_AI_API_KEY",
        "GEMINI_API_KEY",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "OPENROUTER_API_KEY",
        "XAI_API_KEY",
    ];
    // Shell-print the keys we care about; absent vars print as empty so we
    // can skip them. Wrapped in `:;` so a missing var doesn't make the
    // shell exit with non-zero.
    let script = KEYS
        .iter()
        .map(|k| format!("printf '%s=%s\\n' {} \"${{{}:-}}\"", k, k))
        .collect::<Vec<_>>()
        .join("; ");
    let shells: [(&str, &[&str]); 3] = [
        ("zsh", &["-l", "-c", &script]),
        ("bash", &["-l", "-c", &script]),
        ("sh", &["-l", "-c", &script]),
    ];
    for (shell, _args) in shells {
        if let Ok(out) = Command::new(shell)
            .args(["-l", "-c", &script])
            .output()
        {
            if out.status.success() {
                let mut pairs = Vec::new();
                for line in String::from_utf8_lossy(&out.stdout).lines() {
                    if let Some(eq) = line.find('=') {
                        let (k, v) = line.split_at(eq);
                        let v = &v[1..]; // strip leading '='
                        if !v.is_empty() && KEYS.contains(&k) {
                            pairs.push((k.to_string(), v.to_string()));
                        }
                    }
                }
                if !pairs.is_empty() {
                    return pairs;
                }
            }
        }
    }
    Vec::new()
}

/// Returns Some((major, raw_version)) on success, None on failure.
fn check_node_version(node_bin: &str) -> Option<(u32, String)> {
    let out = Command::new(node_bin).arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let trimmed = raw.trim_start_matches('v');
    let major_str = trimmed.split('.').next()?;
    let major = major_str.parse::<u32>().ok()?;
    Some((major, raw))
}

#[derive(Debug)]
enum NodePreflightError {
    Missing,
    TooOld { raw: String },
}

/// Full pre-flight: returns the resolved node path on success, or an error
/// describing what to tell the user.
fn run_node_preflight() -> Result<String, NodePreflightError> {
    // F40 (#1032): prefer Node 22.x specifically when available. Avoids
    // silent better-sqlite3 ABI failures when the user's login-shell default
    // is Node 23+. Sydney's MacBook hit this with nvm default = 25.
    if let Some(node22) = find_preferred_node_22() {
        if let Some((22, raw)) = check_node_version(&node22) {
            log::info!(
                "Node.js pre-flight OK: {} ({}) — preferred {} for native module ABI",
                raw,
                node22,
                PREFERRED_NODE_MAJOR
            );
            return Ok(node22);
        }
    }

    let node_bin = resolve_node_via_login_shell().ok_or(NodePreflightError::Missing)?;
    let (major, raw) = check_node_version(&node_bin).ok_or(NodePreflightError::Missing)?;
    if major < MIN_NODE_MAJOR {
        return Err(NodePreflightError::TooOld { raw });
    }
    if major != PREFERRED_NODE_MAJOR {
        log::warn!(
            "Node.js pre-flight: using {} at {} — Node {}.x preferred for native module ABI; \
             install via `nvm install {} && nvm alias default {}` if you hit a NODE_MODULE_VERSION error",
            raw,
            node_bin,
            PREFERRED_NODE_MAJOR,
            PREFERRED_NODE_MAJOR,
            PREFERRED_NODE_MAJOR
        );
    } else {
        log::info!("Node.js pre-flight OK: {} ({})", raw, node_bin);
    }
    Ok(node_bin)
}

/// Show a native error dialog and exit. Uses platform-native tools so we
/// don't need to pull in tauri-plugin-dialog.
fn show_node_error_and_exit(err: NodePreflightError) -> ! {
    let (title, body) = match err {
        NodePreflightError::Missing => (
            "Node.js not found",
            format!(
                "o8 needs Node.js v{}+ to run its backend.\n\n\
                 Install the latest LTS from https://nodejs.org and launch o8 again.\n\n\
                 If Node.js is already installed via nvm, fnm, or Volta, make sure it is\n\
                 available to a login shell (zsh/bash with -l flag).",
                MIN_NODE_MAJOR
            ),
        ),
        NodePreflightError::TooOld { raw } => (
            "Node.js is too old",
            format!(
                "o8 needs Node.js v{}+ but found {}.\n\n\
                 Upgrade from https://nodejs.org and launch o8 again.",
                MIN_NODE_MAJOR, raw
            ),
        ),
    };

    log::error!("{}: {}", title, body);

    #[cfg(target_os = "macos")]
    {
        // osascript is always available on macOS. Escape quotes for AppleScript.
        let escape = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
        let script = format!(
            r#"display dialog "{}" with title "{}" buttons {{"Download Node.js", "Quit"}} default button "Download Node.js" with icon stop"#,
            escape(&body),
            escape(title)
        );
        let out = Command::new("osascript").args(["-e", &script]).output();
        let clicked_download = out
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.contains("Download Node.js"))
            .unwrap_or(false);
        if clicked_download {
            let _ = Command::new("open").arg("https://nodejs.org").spawn();
        }
    }

    #[cfg(target_os = "windows")]
    {
        // mshta shows a VBScript message box without extra deps.
        let escape = |s: &str| s.replace('"', "\"\"").replace('\n', " ");
        let script = format!(
            r#"javascript:var r=confirm("{}\n\nClick OK to open nodejs.org.");if(r)new ActiveXObject("WScript.Shell").Run("cmd /c start https://nodejs.org",1,false);window.close();"#,
            escape(&format!("{}: {}", title, body))
        );
        let _ = Command::new("mshta").arg(script).spawn();
    }

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        // Linux fallback — try zenity / kdialog, otherwise just stderr.
        let full = format!("{}\n\n{}", title, body);
        let _ = Command::new("zenity")
            .args(["--error", "--title", title, "--text", &full])
            .status()
            .or_else(|_| {
                Command::new("kdialog")
                    .args(["--error", &full])
                    .status()
            });
        eprintln!("{}: {}", title, body);
    }

    std::process::exit(1);
}

/// Desktop info exposed to the React frontend via invoke
#[derive(Serialize)]
pub struct DesktopInfo {
    pub is_desktop: bool,
    pub platform: String,
    pub version: String,
    pub arch: String,
}

/// Result from spawning the WS server sidecar
#[derive(Serialize)]
pub struct SidecarResult {
    pub ok: bool,
    pub pid: Option<u32>,
    pub error: Option<String>,
}

/// Get desktop environment info
#[tauri::command]
fn get_desktop_info() -> DesktopInfo {
    DesktopInfo {
        is_desktop: true,
        platform: std::env::consts::OS.to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        arch: std::env::consts::ARCH.to_string(),
    }
}

/// Check if a process is listening on a given port
#[tauri::command]
fn check_port(port: u16) -> bool {
    std::net::TcpStream::connect(format!("127.0.0.1:{}", port)).is_ok()
}

/// Start the WebSocket server as a background process
#[tauri::command]
fn start_ws_server(project_dir: String) -> SidecarResult {
    match Command::new("npx")
        .args(["tsx", "src/ws-server.ts"])
        .current_dir(&project_dir)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(child) => SidecarResult {
            ok: true,
            pid: Some(child.id()),
            error: None,
        },
        Err(e) => SidecarResult {
            ok: false,
            pid: None,
            error: Some(e.to_string()),
        },
    }
}

/// Check if Cortex binary is available
#[tauri::command]
fn cortex_available() -> bool {
    let home = std::env::var("HOME").unwrap_or_default();
    let cortex_path = format!("{}/bin/cortex", home);
    std::path::Path::new(&cortex_path).exists()
}

/// Get the app data directory for persistent storage
#[tauri::command]
fn get_app_data_dir(app: tauri::AppHandle) -> Option<String> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|p| p.to_string_lossy().to_string())
}

// ── IPC-accelerated data commands ──
// These bypass HTTP, serving data directly via Tauri IPC (~0.5ms vs ~5-10ms).

/// Read the repo registry from disk. Returns { repos: [...] }.
/// Equivalent to GET /api/panel/repos but without readiness enrichment.
#[tauri::command]
fn read_repos() -> Result<serde_json::Value, String> {
    let repos_path = format!("{}/repos.json", o8_data_dir());
    let content = std::fs::read_to_string(&repos_path)
        .map_err(|e| format!("Failed to read repos.json: {}", e))?;
    let store: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse repos.json: {}", e))?;
    // repos.json has { repos: [...], ... } — return the whole store
    Ok(store)
}

/// Read recent git commits for a local repo path.
/// Equivalent to GET /api/panel/commits?workspace=<path>&limit=<n>
#[tauri::command]
fn read_local_commits(repo: String, limit: Option<u32>) -> Result<serde_json::Value, String> {
    let limit = limit.unwrap_or(10).min(50);
    let output = Command::new("git")
        .args([
            "log",
            &format!("--max-count={}", limit),
            "--date=iso-strict",
            "--format=%H\x1f%an\x1f%aI\x1f%s",
        ])
        .current_dir(&repo)
        .output()
        .map_err(|e| format!("git log failed: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git log error: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let commits: Vec<serde_json::Value> = stdout
        .lines()
        .filter(|l| !l.is_empty())
        .map(|line| {
            let parts: Vec<&str> = line.splitn(4, '\x1f').collect();
            serde_json::json!({
                "hash": parts.first().unwrap_or(&""),
                "author": parts.get(1).unwrap_or(&""),
                "date": parts.get(2).unwrap_or(&""),
                "message": parts.get(3).unwrap_or(&""),
            })
        })
        .collect();

    Ok(serde_json::json!({ "commits": commits, "workspace": repo }))
}

/// Read git worktrees for a local repo path.
/// Equivalent to GET /api/worktrees?repo=<path>
#[tauri::command]
fn read_worktrees(repo: String) -> Result<serde_json::Value, String> {
    let output = Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(&repo)
        .output()
        .map_err(|e| format!("git worktree list failed: {}", e))?;

    if !output.status.success() {
        return Ok(serde_json::json!({ "worktrees": [] }));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut worktrees: Vec<serde_json::Value> = Vec::new();
    let mut path = String::new();
    let mut head = String::new();
    let mut branch = String::new();
    let mut is_bare = false;

    for line in stdout.lines() {
        if line.starts_with("worktree ") {
            // Flush previous entry
            if !path.is_empty() {
                worktrees.push(serde_json::json!({
                    "path": path,
                    "head": head,
                    "branch": branch,
                    "bare": is_bare,
                }));
            }
            path = line[9..].to_string();
            head.clear();
            branch.clear();
            is_bare = false;
        } else if line.starts_with("HEAD ") {
            head = line[5..].to_string();
        } else if line.starts_with("branch ") {
            branch = line[7..].trim_start_matches("refs/heads/").to_string();
        } else if line == "bare" {
            is_bare = true;
        }
    }
    // Flush last entry
    if !path.is_empty() {
        worktrees.push(serde_json::json!({
            "path": path,
            "head": head,
            "branch": branch,
            "bare": is_bare,
        }));
    }

    Ok(serde_json::json!({ "worktrees": worktrees }))
}

/// Read the current git branch for a repo.
#[tauri::command]
fn read_current_branch(repo: String) -> Result<serde_json::Value, String> {
    let output = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&repo)
        .output()
        .map_err(|e| format!("git rev-parse failed: {}", e))?;

    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(serde_json::json!({ "branch": branch }))
}

/// Read git status (changed files count) for a repo.
#[tauri::command]
fn read_git_status(repo: String) -> Result<serde_json::Value, String> {
    let output = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&repo)
        .output()
        .map_err(|e| format!("git status failed: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let changed_files: usize = stdout.lines().filter(|l| !l.is_empty()).count();
    Ok(serde_json::json!({ "changedFiles": changed_files, "clean": changed_files == 0 }))
}

// ── MCP loop observability (issues #793, #794) ──
//
// Two MCP tools that close gaps in the autonomous dogfood loop's
// observability when the webview's JS thread is busy. Both keep their
// state on the Rust side so the data is captured / queried even when
// page-side eval calls are slow:
//
//   - `o8_view_console_errors`: an in-process ring buffer (cap 100, FIFO
//     eviction) populated by an injected JS hook that wraps `console.error`
//     + listens for `error` / `unhandledrejection` events and posts each
//     one back through `__TAURI_INTERNALS__.invoke('record_console_error', …)`.
//     The MCP read returns `{ errors, count, sinceLastFetch }` and resets
//     the per-fetch counter on every call.
//
//   - `o8_view_active_route`: returns the main webview's current URL parts
//     by calling `webview.url()` directly (no JS-thread crossing on the
//     read side; the MCP transport still goes through the plugin's
//     execute_js bridge — see operator-mcp-server.ts). The Next.js
//     router segment is intentionally returned as `null` for now;
//     extracting it requires JS-side state that is harder to reach
//     without an eval round-trip.

const CONSOLE_ERROR_BUFFER_CAP: usize = 100;

#[derive(Clone, Serialize)]
struct ConsoleError {
    message: String,
    source: String,
    lineno: u32,
    timestamp: u64,
}

struct ConsoleErrorBuffer {
    errors: VecDeque<ConsoleError>,
    /// Errors recorded since the last `o8_view_console_errors` call. Counter
    /// resets on every read, so consecutive calls show only the delta.
    since_last_fetch: u32,
}

fn console_errors() -> &'static Mutex<ConsoleErrorBuffer> {
    static BUFFER: OnceLock<Mutex<ConsoleErrorBuffer>> = OnceLock::new();
    BUFFER.get_or_init(|| {
        Mutex::new(ConsoleErrorBuffer {
            errors: VecDeque::with_capacity(CONSOLE_ERROR_BUFFER_CAP),
            since_last_fetch: 0,
        })
    })
}

fn now_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Tauri command invoked by the injected JS hook. Pushes one error onto the
/// ring buffer, evicting the oldest entry when capacity is reached, and
/// bumps the per-fetch counter that `o8_view_console_errors` resets on read.
#[tauri::command]
fn record_console_error(message: String, source: String, lineno: u32) {
    // #932: also log to sidecar so the ring buffer is visible without going
    // through o8_view_console_errors (which goes through the broken eval path).
    log::info!(
        "[webview-console] {} (source={} line={})",
        message.chars().take(400).collect::<String>(),
        source,
        lineno
    );
    let Ok(mut buffer) = console_errors().lock() else {
        return;
    };
    if buffer.errors.len() >= CONSOLE_ERROR_BUFFER_CAP {
        buffer.errors.pop_front();
    }
    buffer.errors.push_back(ConsoleError {
        message,
        source,
        lineno,
        timestamp: now_unix_ms(),
    });
    buffer.since_last_fetch = buffer.since_last_fetch.saturating_add(1);
}

// ── #1136 read_dropped_file ──
//
// Backing command for the Tauri drag-drop bridge. The frontend receives
// paths via the `o8:tauri-file-drop` window event (emitted from
// on_window_event below), then calls this command to read the bytes.
// Done in Rust (not behind an HTTP route) so there is no auth surface
// to abuse — invokes are scoped to the webview origin.

const DROPPED_FILE_MAX_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Serialize)]
struct DroppedFileResult {
    name: String,
    #[serde(rename = "mimeType")]
    mime_type: String,
    #[serde(rename = "contentBase64")]
    content_base64: String,
    size: u64,
}

fn base64_encode_standard(data: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    let mut i = 0;
    while i < data.len() {
        let b0 = data[i] as u32;
        let b1 = if i + 1 < data.len() { data[i + 1] as u32 } else { 0 };
        let b2 = if i + 2 < data.len() { data[i + 2] as u32 } else { 0 };
        out.push(TABLE[((b0 >> 2) & 0x3f) as usize] as char);
        out.push(TABLE[(((b0 << 4) | (b1 >> 4)) & 0x3f) as usize] as char);
        if i + 1 < data.len() {
            out.push(TABLE[(((b1 << 2) | (b2 >> 6)) & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
        if i + 2 < data.len() {
            out.push(TABLE[(b2 & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
        i += 3;
    }
    out
}

fn mime_for_extension(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "heic" | "heif" => "image/heic",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "pdf" => "application/pdf",
        "json" => "application/json",
        "md" | "markdown" | "mdx" => "text/markdown",
        "txt" | "log" | "csv" | "tsv" => "text/plain",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" | "cjs" => "application/javascript",
        "ts" | "tsx" | "jsx" => "text/typescript",
        "py" => "text/x-python",
        "rs" => "text/x-rust",
        "go" => "text/x-go",
        "java" => "text/x-java",
        "rb" => "text/x-ruby",
        "sh" | "bash" | "zsh" => "application/x-sh",
        "yaml" | "yml" => "application/yaml",
        "toml" => "application/toml",
        "xml" => "application/xml",
        _ => "application/octet-stream",
    }
}

#[tauri::command]
fn read_dropped_file(path: String) -> Result<DroppedFileResult, String> {
    // Whitelist: must be a regular file within $HOME. Blocks /etc/*,
    // /var/log/*, /private/var/db/*, and anything an operator could be
    // tricked into "dropping" via a malicious link or page.
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let path_buf = std::path::PathBuf::from(&path);
    let canonical = path_buf
        .canonicalize()
        .map_err(|e| format!("canonicalize failed: {}", e))?;
    let home_canonical = std::path::PathBuf::from(&home)
        .canonicalize()
        .map_err(|e| format!("canonicalize $HOME failed: {}", e))?;
    if !canonical.starts_with(&home_canonical) {
        return Err(format!("path outside $HOME: {}", canonical.display()));
    }

    let metadata = std::fs::metadata(&canonical)
        .map_err(|e| format!("stat failed: {}", e))?;
    if !metadata.is_file() {
        return Err("path is not a regular file".to_string());
    }
    if metadata.len() > DROPPED_FILE_MAX_BYTES {
        return Err(format!(
            "file too large: {} bytes (max {})",
            metadata.len(),
            DROPPED_FILE_MAX_BYTES
        ));
    }

    let bytes = std::fs::read(&canonical).map_err(|e| format!("read failed: {}", e))?;
    let name = canonical
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "dropped".to_string());
    let mime_type = mime_for_extension(&name).to_string();
    let content_base64 = base64_encode_standard(&bytes);

    Ok(DroppedFileResult {
        name,
        mime_type,
        content_base64,
        size: metadata.len(),
    })
}

/// #932 — host-app `mcp_result` command. Lives in the main app (NOT the
/// plugin) because plugin invokes were silently denied by the ACL across
/// every capability scoping we tried. The main-app `record_console_error`
/// uses the same un-prefixed pattern and is empirically working.
///
/// JS calls: `__TAURI_INTERNALS__.invoke('mcp_result', { correlationId, ok, data, error })`
///
/// Note: separate params (not a struct) — Tauri command framework wraps
/// struct params in an `args` key, but separate params get individually
/// JSON-mapped from JS. `rename_all = "camelCase"` lets JS send camelCase
/// keys while Rust uses snake_case. This works for host-app commands
/// because there's no permission file to fight with — only plugin commands
/// have the rename-renames-the-command-name problem.
#[tauri::command(rename_all = "camelCase")]
fn mcp_result(
    correlation_id: String,
    ok: bool,
    data: Option<serde_json::Value>,
    error: Option<String>,
) {
    log::info!(
        "[mcp_result] cid={} ok={} has_data={} has_error={}",
        correlation_id,
        ok,
        data.is_some(),
        error.is_some()
    );
    let payload = serde_json::json!({
        "ok": ok,
        "data": data,
        "error": error,
    });
    #[cfg(feature = "dev-mcp-plugin")]
    tauri_plugin_mcp::tools::webview::PendingResults::complete(&correlation_id, payload);
    #[cfg(not(feature = "dev-mcp-plugin"))]
    {
        let _ = payload;
        log::warn!("[mcp_result] dev-mcp-plugin disabled; dropping result");
    }
}

/// MCP read path. Returns the full ring buffer plus the count since the
/// previous call (which resets to zero after this returns).
#[tauri::command]
fn o8_view_console_errors() -> serde_json::Value {
    let Ok(mut buffer) = console_errors().lock() else {
        return serde_json::json!({ "errors": [], "count": 0, "sinceLastFetch": 0 });
    };
    let errors: Vec<ConsoleError> = buffer.errors.iter().cloned().collect();
    let count = errors.len();
    let since_last_fetch = buffer.since_last_fetch;
    buffer.since_last_fetch = 0;
    serde_json::json!({
        "errors": errors,
        "count": count,
        "sinceLastFetch": since_last_fetch,
    })
}

/// Read the main webview's current URL via `webview.url()` and split it into
/// pathname / search / hash. `routerState` is intentionally `null` — the
/// Next.js segment isn't reachable without a JS-side eval, which we defer.
#[tauri::command]
fn o8_view_active_route(app: AppHandle) -> Result<serde_json::Value, String> {
    let Some(window) = app.get_webview_window("main") else {
        return Err("main webview not found".to_string());
    };
    let url = window.url().map_err(|e| format!("webview.url() failed: {}", e))?;
    let pathname = url.path().to_string();
    let search = match url.query() {
        Some(q) if !q.is_empty() => format!("?{}", q),
        _ => String::new(),
    };
    let hash = match url.fragment() {
        Some(f) if !f.is_empty() => format!("#{}", f),
        _ => String::new(),
    };
    Ok(serde_json::json!({
        "pathname": pathname,
        "search": search,
        "hash": hash,
        "routerState": serde_json::Value::Null,
    }))
}

// ── SQLite helper (read-only, WAL mode) ──

fn open_cortex_db() -> Result<Connection, String> {
    let db_path = format!("{}/cortex-ide.db", o8_data_dir());
    if !std::path::Path::new(&db_path).exists() {
        return Err("db_not_found".to_string());
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = Connection::open_with_flags(&db_path, flags)
        .map_err(|e| format!("Failed to open DB: {}", e))?;
    conn.pragma_update(None, "journal_mode", "wal")
        .map_err(|e| format!("Failed to set WAL: {}", e))?;
    Ok(conn)
}

/// Read pending approvals from SQLite. Returns { approvals: [...] }.
/// Equivalent to GET /api/panel/approvals (pending only, no session filter).
#[tauri::command]
fn read_approvals(status: Option<String>) -> Result<serde_json::Value, String> {
    let conn = match open_cortex_db() {
        Ok(c) => c,
        Err(e) if e == "db_not_found" => {
            return Ok(serde_json::json!({ "approvals": [] }));
        }
        Err(e) => return Err(e),
    };

    let filter_status = status.unwrap_or_else(|| "pending".to_string());
    let use_filter = filter_status != "all";

    let approvals: Vec<serde_json::Value> = if use_filter {
        let mut stmt = conn
            .prepare(
                "SELECT id, source, runtime, agent, session_key, title, description, summary,
                        tool_name, args_json, command, editable, diff_json, risk,
                        metadata_json, packet_id, lane_id, policy_rule_id,
                        status, created_at, updated_at, resolved_at,
                        resolution_json, audit_json, fingerprint, continuation_json
                 FROM approvals
                 WHERE status = ?1
                 ORDER BY created_at DESC",
            )
            .map_err(|e| format!("SQL prepare failed: {}", e))?;
        let result: Vec<serde_json::Value> = stmt
            .query_map(rusqlite::params![filter_status], |row| {
                Ok(map_approval_row(row))
            })
            .map_err(|e| format!("Query failed: {}", e))?
            .filter_map(|r| r.ok())
            .collect();
        result
    } else {
        let mut stmt = conn
            .prepare(
                "SELECT id, source, runtime, agent, session_key, title, description, summary,
                        tool_name, args_json, command, editable, diff_json, risk,
                        metadata_json, packet_id, lane_id, policy_rule_id,
                        status, created_at, updated_at, resolved_at,
                        resolution_json, audit_json, fingerprint, continuation_json
                 FROM approvals
                 ORDER BY created_at DESC",
            )
            .map_err(|e| format!("SQL prepare failed: {}", e))?;
        let result: Vec<serde_json::Value> = stmt
            .query_map([], |row| Ok(map_approval_row(row)))
            .map_err(|e| format!("Query failed: {}", e))?
            .filter_map(|r| r.ok())
            .collect();
        result
    };

    Ok(serde_json::json!({ "approvals": approvals }))
}

fn map_approval_row(row: &rusqlite::Row) -> serde_json::Value {
    let id: String = row.get(0).unwrap_or_default();
    let source: String = row.get(1).unwrap_or_default();
    let runtime: String = row.get(2).unwrap_or_default();
    let agent: String = row.get(3).unwrap_or_default();
    let session_key: String = row.get(4).unwrap_or_default();
    let title: String = row.get(5).unwrap_or_default();
    let description: String = row.get(6).unwrap_or_default();
    let summary: String = row.get(7).unwrap_or_default();
    let tool_name: Option<String> = row.get(8).ok();
    let args_json: Option<String> = row.get(9).ok();
    let command: Option<String> = row.get(10).ok();
    let editable: Option<bool> = row.get(11).ok();
    let diff_json: Option<String> = row.get(12).ok();
    let risk: String = row.get(13).unwrap_or_default();
    let metadata_json: Option<String> = row.get(14).ok();
    let _packet_id: Option<String> = row.get::<_, Option<String>>(15).ok().flatten();
    let _lane_id: Option<String> = row.get::<_, Option<String>>(16).ok().flatten();
    let policy_rule_id: Option<String> = row.get(17).ok();
    let status: String = row.get(18).unwrap_or_default();
    let created_at: i64 = row.get(19).unwrap_or(0);
    let updated_at: i64 = row.get(20).unwrap_or(0);
    let resolved_at: Option<i64> = row.get(21).ok();
    let resolution_json: Option<String> = row.get(22).ok();
    let audit_json: String = row.get(23).unwrap_or_else(|_| "[]".to_string());
    let fingerprint: String = row.get(24).unwrap_or_default();
    let continuation_json: Option<String> = row.get(25).ok();

    let args = args_json
        .as_deref()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());
    let diff = diff_json
        .as_deref()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());
    let metadata = metadata_json
        .as_deref()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());
    let resolution = resolution_json
        .as_deref()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());
    let audit: serde_json::Value =
        serde_json::from_str(&audit_json).unwrap_or(serde_json::json!([]));
    let continuation = continuation_json
        .as_deref()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());

    serde_json::json!({
        "id": id,
        "source": source,
        "runtime": runtime,
        "agent": agent,
        "sessionKey": session_key,
        "title": title,
        "description": description,
        "summary": summary,
        "toolName": tool_name,
        "args": args,
        "command": command,
        "editable": editable,
        "diff": diff,
        "risk": risk,
        "metadata": metadata,
        "policyRuleId": policy_rule_id,
        "status": status,
        "createdAt": created_at,
        "updatedAt": updated_at,
        "resolvedAt": resolved_at,
        "resolution": resolution,
        "audit": audit,
        "fingerprint": fingerprint,
        "continuation": continuation,
    })
}

/// Read watched agents from SQLite. Returns { workspaces: [...] }.
/// Lightweight IPC snapshot of durable supervisor state.
#[tauri::command]
fn read_workspaces() -> Result<serde_json::Value, String> {
    let conn = match open_cortex_db() {
        Ok(c) => c,
        Err(e) if e == "db_not_found" => {
            return Ok(serde_json::json!({ "workspaces": [] }));
        }
        Err(e) => return Err(e),
    };

    let mut stmt = conn
        .prepare(
            "SELECT surface_id, repo_path, name, prompt, registered_at,
                    last_status, retry_count, steer_count,
                    completion_reported, last_event_at, last_activity_at
             FROM watched_agents
             ORDER BY last_activity_at DESC",
        )
        .map_err(|e| format!("SQL prepare failed: {}", e))?;

    let rows = stmt
        .query_map([], |row| {
            let surface_id: String = row.get(0).unwrap_or_default();
            let repo_path: String = row.get(1).unwrap_or_default();
            let name: String = row.get(2).unwrap_or_default();
            let prompt: String = row.get(3).unwrap_or_default();
            let registered_at: i64 = row.get(4).unwrap_or(0);
            let last_status: String = row.get(5).unwrap_or_default();
            let retry_count: i64 = row.get(6).unwrap_or(0);
            let steer_count: i64 = row.get(7).unwrap_or(0);
            let completion_reported: bool = row.get(8).unwrap_or(false);
            let last_event_at: i64 = row.get(9).unwrap_or(0);
            let last_activity_at: i64 = row.get(10).unwrap_or(0);

            Ok(serde_json::json!({
                "surfaceId": surface_id,
                "repoPath": repo_path,
                "name": name,
                "prompt": prompt,
                "registeredAt": registered_at,
                "lastStatus": last_status,
                "retryCount": retry_count,
                "steerCount": steer_count,
                "completionReported": completion_reported,
                "lastEventAt": last_event_at,
                "lastActivityAt": last_activity_at,
            }))
        })
        .map_err(|e| format!("Query failed: {}", e))?;

    let workspaces: Vec<serde_json::Value> = rows.filter_map(|r| r.ok()).collect();

    Ok(serde_json::json!({ "workspaces": workspaces }))
}

// ── Tray badge + native weapons (issue #731) ──
//
// Two native macOS features that differentiate o8 from web/Electron rivals:
//
//   1. Native notifications when a packet flips to `awaiting_review`. Fired
//      from the frontend (which already holds the WS lane stream) via the
//      `notify_review_ready` Tauri command. The macOS notification plugin
//      doesn't expose action buttons natively (notify-rust limitation), so
//      clicking the notification raises the app focused on the review card —
//      "Approve / Reject" stay as in-app affordances for v1.
//
//   2. Menu bar tray with live "[N]" badge for pending reviews. The tray
//      already exists; we now keep its title in sync by polling the lanes
//      API every 5s. `set_tray_badge` is also exposed as a Tauri command so
//      the frontend can push exact counts when WS lane events arrive (faster
//      than waiting for the next poll tick).

/// Shared handle to the menu bar tray icon. Stored once on `setup()` so
/// background polls and frontend commands can update its title without
/// re-creating the tray.
fn tray_handle() -> &'static Mutex<Option<TrayIcon>> {
    static HANDLE: OnceLock<Mutex<Option<TrayIcon>>> = OnceLock::new();
    HANDLE.get_or_init(|| Mutex::new(None))
}

fn store_tray(tray: TrayIcon) {
    if let Ok(mut guard) = tray_handle().lock() {
        *guard = Some(tray);
    }
}

/// Update the macOS menu bar tray title with a count badge. Hides the badge
/// (sets to None) when count is 0 so the icon sits clean. macOS only — on
/// other platforms `set_title` is a no-op, which is fine: we still update the
/// tooltip elsewhere.
fn apply_tray_badge(count: u32) {
    let Ok(guard) = tray_handle().lock() else { return };
    let Some(tray) = guard.as_ref() else { return };
    let title = if count == 0 { None } else { Some(format!("[{}]", count)) };
    if let Err(err) = tray.set_title(title.as_deref()) {
        log::warn!("[tray-badge] set_title failed: {}", err);
    }
    // Tooltip mirrors the count so accessibility tools report it too.
    let tooltip = if count == 0 {
        "o8".to_string()
    } else {
        format!("o8 — {} awaiting review", count)
    };
    let _ = tray.set_tooltip(Some(tooltip));
}

/// Read a UTF-8 file from the o8 data dir, trimming whitespace. Used to pick
/// up the dynamic API port and ws-token written by the sidecar.
fn read_data_file(name: &str) -> Option<String> {
    let path = format!("{}/{}", o8_data_dir(), name);
    std::fs::read_to_string(&path).ok().map(|s| s.trim().to_string())
}

/// Resolve the API port the Next server is bound to. Mirrors the precedence
/// in `src/lib/panel/api-port.ts` — env var first, on-disk file second,
/// default 3001 last.
fn resolve_api_port() -> u16 {
    if let Ok(p) = std::env::var("O8_API_PORT") {
        if let Ok(parsed) = p.parse() { return parsed; }
    }
    if let Some(raw) = read_data_file("api-port") {
        if let Ok(parsed) = raw.parse() { return parsed; }
    }
    3001
}

/// Read the cross-origin auth token. Empty string if missing — the loopback
/// origin path (which we use here) doesn't strictly need it but we send it
/// when present so the request also works under future hardenings.
fn resolve_ws_token() -> String {
    read_data_file("ws-token").unwrap_or_default()
}

/// Background HTTP GET against the local Next server. Uses a raw TCP write so
/// we don't pull in a new HTTP crate. The response body is small (lanes JSON,
/// hundreds of bytes per active lane). Bounded read keeps us safe from a
/// runaway server. Returns `None` on any error — callers fall back to the
/// previous count.
fn http_get_local(path: &str) -> Option<String> {
    use std::io::{Read, Write};
    use std::time::Duration;
    let port = resolve_api_port();
    let token = resolve_ws_token();
    let addr = format!("127.0.0.1:{}", port);
    let mut stream = std::net::TcpStream::connect_timeout(
        &addr.parse().ok()?,
        Duration::from_millis(750),
    ).ok()?;
    stream.set_read_timeout(Some(Duration::from_millis(1500))).ok();
    stream.set_write_timeout(Some(Duration::from_millis(1500))).ok();
    let auth = if token.is_empty() {
        String::new()
    } else {
        format!("Authorization: Bearer {}\r\n", token)
    };
    let req = format!(
        "GET {} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n{}Connection: close\r\nAccept: application/json\r\n\r\n",
        path, port, auth
    );
    stream.write_all(req.as_bytes()).ok()?;
    let mut buf = Vec::with_capacity(64 * 1024);
    let mut chunk = [0u8; 4096];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() > 1024 * 1024 { break; } // 1 MiB cap
            }
            Err(_) => break,
        }
    }
    let raw = String::from_utf8_lossy(&buf).to_string();
    // Split off HTTP headers — body starts after the first \r\n\r\n.
    let body_start = raw.find("\r\n\r\n").map(|i| i + 4).unwrap_or(0);
    Some(raw[body_start..].to_string())
}

/// One awaiting-review lane projected for the tray dropdown. `id` is the
/// lane id so the click handler can route back through `tray:focus-lane`.
#[derive(Clone)]
struct AwaitingLane {
    id: String,
    label: String,
    repo: String,
}

/// Fetch lanes whose status is `reviewing`, projected for the tray dropdown.
/// Falls back to an empty list on any parse / network error so the menu
/// degrades to the static `Show / Quit` entries.
fn fetch_awaiting_lanes() -> Vec<AwaitingLane> {
    let Some(body) = http_get_local("/api/lanes?active=true") else { return Vec::new() };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) else { return Vec::new() };
    let Some(lanes) = json.get("lanes").and_then(|v| v.as_array()) else { return Vec::new() };
    lanes
        .iter()
        .filter_map(|lane| {
            let status = lane.get("status").and_then(|s| s.as_str())?;
            if status != "reviewing" { return None; }
            let id = lane.get("id").and_then(|s| s.as_str())?.to_string();
            let label = lane.get("label").and_then(|s| s.as_str()).unwrap_or("Untitled").to_string();
            let repo_path = lane.get("repoPath").and_then(|s| s.as_str()).unwrap_or("");
            let repo = repo_path.trim_end_matches('/').rsplit('/').next().unwrap_or("").to_string();
            Some(AwaitingLane { id, label, repo })
        })
        .collect()
}

/// Truncate a label for the tray menu. macOS menus render long titles fine
/// but the dropdown gets unwieldy past ~60 chars — pull back to 48 with an
/// ellipsis so each row stays scannable.
fn truncate_label(label: &str) -> String {
    const MAX: usize = 48;
    if label.chars().count() <= MAX { return label.to_string() }
    let truncated: String = label.chars().take(MAX - 1).collect();
    format!("{}…", truncated.trim_end())
}

/// Build the tray dropdown menu given the current awaiting-review set.
/// Layout: `<packet> · <repo>` rows, separator, `Show o8`, separator, `Quit`.
/// When the set is empty the per-packet rows are skipped and the menu collapses
/// to the static two.
fn build_tray_menu(app: &AppHandle, lanes: &[AwaitingLane]) -> tauri::Result<Menu<tauri::Wry>> {
    let show = MenuItem::with_id(app, "show", "Show o8", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit o8", true, None::<&str>)?;

    if lanes.is_empty() {
        return Menu::with_items(app, &[&show, &separator, &quit]);
    }

    let menu = Menu::new(app)?;
    for lane in lanes {
        let title = if lane.repo.is_empty() {
            truncate_label(&lane.label)
        } else {
            format!("{} · {}", truncate_label(&lane.label), lane.repo)
        };
        let item = MenuItem::with_id(app, format!("lane:{}", lane.id), title, true, None::<&str>)?;
        menu.append(&item)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&show)?;
    menu.append(&separator)?;
    menu.append(&quit)?;
    Ok(menu)
}

/// Swap the tray's menu to reflect the current awaiting-review set.
/// Called from the poller when the set changes. Errors are logged + skipped
/// so a transient menu-build hiccup never kills the poller thread.
fn apply_tray_menu(app: &AppHandle, lanes: &[AwaitingLane]) {
    let Ok(guard) = tray_handle().lock() else { return };
    let Some(tray) = guard.as_ref() else { return };
    match build_tray_menu(app, lanes) {
        Ok(menu) => {
            if let Err(err) = tray.set_menu(Some(menu)) {
                log::warn!("[tray-menu] set_menu failed: {}", err);
            }
        }
        Err(err) => log::warn!("[tray-menu] build_tray_menu failed: {}", err),
    }
}

/// Spawn a long-lived background thread that polls the lanes API every 5s,
/// updates the badge count, and rebuilds the tray dropdown to list each
/// awaiting-review packet by title + repo. Light enough to run continuously
/// — one tiny HTTP request per tick.
fn spawn_tray_badge_poller(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_signature: Option<String> = None;
        loop {
            let lanes = fetch_awaiting_lanes();
            let count = lanes.len() as u32;
            // Signature = count + sorted lane id list. Rebuild menu only when
            // the set itself changes — avoids churn when nothing happened.
            let mut ids: Vec<&str> = lanes.iter().map(|l| l.id.as_str()).collect();
            ids.sort();
            let signature = format!("{}:{}", count, ids.join(","));

            if Some(&signature) != last_signature.as_ref() {
                apply_tray_badge(count);
                apply_tray_menu(&app, &lanes);
                let _ = app.emit("tray-badge-changed", count);
                last_signature = Some(signature);
            }
            std::thread::sleep(std::time::Duration::from_secs(5));
        }
    });
}

/// Tauri command: push an exact awaiting-review count to the tray badge.
/// Frontend calls this when a WS lane event flips a packet's status, so the
/// badge updates instantly instead of waiting for the 5s poll.
#[tauri::command]
fn set_tray_badge(count: u32) {
    apply_tray_badge(count);
}

/// Tauri command: fire a native notification when a packet flips to
/// awaiting_review. Frontend invokes this from the WS lane event handler.
/// We also raise the tray badge by 0 (no-op for count) just to refresh the
/// tooltip in case the poller hasn't ticked yet.
#[tauri::command]
fn notify_review_ready(
    app: AppHandle,
    title: String,
    body: String,
    packet_id: Option<String>,
) -> Result<(), String> {
    let display_title = if title.is_empty() { "Awaiting review".to_string() } else { title };
    let display_body = if body.is_empty() {
        "A packet is ready for review".to_string()
    } else {
        body
    };
    app.notification()
        .builder()
        .title(&display_title)
        .body(&display_body)
        .show()
        .map_err(|e| e.to_string())?;
    // Frontend can listen for this if it wants to scroll to the packet card
    // when the notification is clicked. We can't intercept the click on
    // macOS through the notify-rust path, but emitting here means anything
    // listening on `notification-fired` knows the most recent packet.
    let _ = app.emit("notification-fired", serde_json::json!({
        "title": display_title,
        "body": display_body,
        "packetId": packet_id,
    }));
    Ok(())
}

// Sanity-bounds the saved window-state.json before tauri-plugin-window-state restores
// from it. Multi-monitor reconfigs or virtual-desktop bugs can save dimensions like
// 17000x2820 — wider than any real screen — and the plugin restores them blindly.
// Drop the file if its main window size is outside reasonable bounds; the plugin then
// falls back to the configured defaults from tauri.conf.json.
fn sanitize_window_state() {
    let Some(home) = std::env::var_os("HOME") else { return };
    let path = std::path::PathBuf::from(home)
        .join("Library/Application Support/ai.o8.desktop/.window-state.json");
    let Ok(content) = std::fs::read_to_string(&path) else { return };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) else {
        let _ = std::fs::remove_file(&path);
        return;
    };
    let main = json.get("main");
    let width = main.and_then(|m| m.get("width")).and_then(|v| v.as_f64()).unwrap_or(0.0);
    let height = main.and_then(|m| m.get("height")).and_then(|v| v.as_f64()).unwrap_or(0.0);
    if width > 6000.0 || height > 4000.0 || width < 400.0 || height < 300.0 {
        eprintln!("[o8] discarding off-bounds window state ({}x{})", width, height);
        let _ = std::fs::remove_file(&path);
    }
}

/// Ensure `o8` is on PATH by symlinking the bundled CLI into the first writable
/// well-known bin directory. Best-effort — logs and returns on any error so a
/// permission failure never blocks app startup.
///
/// Priority: /usr/local/bin (Homebrew-style, most common) → ~/.local/bin.
/// We refuse to clobber a non-symlink at the target. If an existing symlink
/// points at any /Applications/o8.app path, we replace it (assume stale o8
/// from a previous install).
#[cfg(target_os = "macos")]
fn ensure_cli_on_path(cli_source: &Path) {
    if !cli_source.exists() {
        eprintln!("[cli-symlink] bundled CLI missing at {}", cli_source.display());
        return;
    }

    let home = match std::env::var_os("HOME") {
        Some(h) => std::path::PathBuf::from(h),
        None => {
            eprintln!("[cli-symlink] $HOME unset — skipping");
            return;
        }
    };

    let candidates: [std::path::PathBuf; 2] = [
        std::path::PathBuf::from("/usr/local/bin/o8"),
        home.join(".local").join("bin").join("o8"),
    ];

    for target in &candidates {
        if let Some(parent) = target.parent() {
            if !parent.exists() {
                if std::fs::create_dir_all(parent).is_err() {
                    continue;
                }
            }
        }

        match std::fs::symlink_metadata(target) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    match std::fs::read_link(target) {
                        Ok(existing) if existing == cli_source => {
                            // Already pointing where we want — nothing to do.
                            return;
                        }
                        Ok(existing) if existing.to_string_lossy().contains("/Applications/o8.app/") => {
                            // Stale symlink from a previous install — replace.
                            let _ = std::fs::remove_file(target);
                        }
                        Ok(existing) if existing.to_string_lossy().contains("/server/bin/o8") => {
                            // Stale dev-target symlink (e.g. a prior `cargo tauri dev`
                            // left /usr/local/bin/o8 pointing at
                            // <repo>/src-tauri/target/{debug,release}/server/bin/o8).
                            // Those bundles go stale once the user runs the production
                            // app — replace with the current bundled CLI. Phase 6 of
                            // SHIP_5_PLAN.md (#1104 hardening).
                            let _ = std::fs::remove_file(target);
                        }
                        Ok(_) => {
                            // User-owned symlink to something else — leave alone.
                            return;
                        }
                        Err(_) => {
                            let _ = std::fs::remove_file(target);
                        }
                    }
                } else {
                    // Regular file or directory — never clobber.
                    eprintln!("[cli-symlink] {} exists and is not a symlink — leaving alone", target.display());
                    return;
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                // No existing entry — fall through to create.
            }
            Err(err) => {
                eprintln!("[cli-symlink] stat {} failed: {}", target.display(), err);
                continue;
            }
        }

        match std::os::unix::fs::symlink(cli_source, target) {
            Ok(()) => {
                eprintln!("[cli-symlink] linked {} -> {}", target.display(), cli_source.display());
                return;
            }
            Err(err) => {
                eprintln!("[cli-symlink] {} failed: {}", target.display(), err);
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn ensure_cli_on_path(_cli_source: &Path) {
    // Windows + Linux symlink semantics differ enough to warrant a separate
    // pass when those platforms come online. For now, the macOS .app is the
    // only shipping surface that needs the symlink.
}

// ── Voice STT engine wiring (lifted from aqua/Symon, de-Symonized) ──
//
// The Swift `speech_recognizer` sidecar streams Apple-Speech partials over
// stdout; the Rust `LiveRecognizer` (src/stt/mod.rs) owns the daemon and hands
// us a `TranscriptEvent` receiver. We spawn it ONCE in setup(), forward every
// event to the webview as `o8:stt-event`, and on stop run the finalize chain
// (Whisper re-transcribe → Gemini polish) before emitting the polished result.
//
// Anthropic is intentionally NOT a provider here — polish is Gemini-only,
// transcription is Whisper-via-OpenRouter. Both bill outside the Anthropic
// subscription pool, so this engine never touches the Claude REPL path.
#[cfg(target_os = "macos")]
mod stt_engine {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Mutex, OnceLock};

    /// The single long-lived recognizer daemon. `start`/`stop`/`set_locale`
    /// take `&mut self`, so the global is a Mutex (mirrors `tray_handle`).
    fn recognizer() -> &'static Mutex<crate::stt::LiveRecognizer> {
        static REC: OnceLock<Mutex<crate::stt::LiveRecognizer>> = OnceLock::new();
        REC.get_or_init(|| Mutex::new(crate::stt::LiveRecognizer::new()))
    }

    /// Per-process monotonically increasing session id, handed to the Swift
    /// helper so its rapid-tap fencing can discard stale sessions.
    ///
    /// MUST stay strictly monotonic and never reuse ids: `stop_session`'s
    /// id-fence (and the voice P3 long-form brush/finish/cancel races it closes)
    /// rely on `active_session()` only ever advancing, so a stale stop no-ops.
    /// Wrapping or resetting this would silently break every fence.
    fn next_session_id() -> u64 {
        static SEQ: AtomicU64 = AtomicU64::new(1);
        SEQ.fetch_add(1, Ordering::SeqCst)
    }

    /// The session id of the currently-active dictation (set on start, read on
    /// stop so the command layer doesn't need to thread it through JS).
    fn active_session() -> &'static AtomicU64 {
        static ACTIVE: AtomicU64 = AtomicU64::new(0);
        &ACTIVE
    }

    /// The currently-active session id (0 = none). Used by the Right-Option Ask
    /// path to force-stop a competing Fn / long-form session before it takes the
    /// mic — the three voice modes share this one recognizer.
    pub fn active_session_id() -> u64 {
        active_session().load(Ordering::SeqCst)
    }

    /// Spawn the daemon once and install the stdout→webview router thread.
    /// Safe to call once from setup(); a second call is a no-op (the daemon
    /// reports "already running").
    pub fn spawn(app: AppHandle) {
        let rx = {
            let mut guard = match recognizer().lock() {
                Ok(g) => g,
                Err(_) => {
                    log::warn!("[stt] recognizer mutex poisoned; skipping daemon spawn");
                    return;
                }
            };
            match guard.spawn_daemon() {
                Ok(rx) => rx,
                Err(e) => {
                    // Missing helper / spawn failure is non-fatal — the existing
                    // webkitSpeechRecognition + HTTP dictation path still works.
                    log::warn!("[stt] daemon spawn failed (non-fatal): {}", e);
                    return;
                }
            }
        };

        std::thread::spawn(move || {
            for event in rx {
                forward_event(&app, event);
            }
            log::info!("[stt] event router thread exiting (daemon stopped)");
        });

        // Warm the Gemini TLS handshake in the background so the first polish
        // call doesn't pay the cold-start cost.
        std::thread::spawn(crate::stt::polish::warmup);
    }

    /// Origin discriminator for the active dictation (system-wide Symon fold
    /// P3 review HIGH). `o8:stt-event` is broadcast to ALL windows; this lets
    /// the screen `dock` pill react only to global-Fn (`system`) sessions and
    /// the in-window DictationHost react only to mic-button (`in-window`)
    /// sessions, so neither double-renders. `is_system_origin()` is set at
    /// Fn-down BEFORE `start()`, so it is stable for the whole session here.
    fn origin_str() -> &'static str {
        if crate::fn_hotkey::is_system_origin() {
            "system"
        } else {
            "in-window"
        }
    }

    /// Emit one `o8:stt-event` payload. Always broadcasts (the in-window pill
    /// listens on the broadcast); for SYSTEM-origin events it ALSO emits
    /// directly to the screen `dock` window via `emit_to(DOCK_LABEL, …)` so the
    /// live morph (recording waveform + transcript + paste flash) reliably lands
    /// in the second webview — `app.emit` broadcast can miss the dock.
    fn emit_stt(app: &AppHandle, origin: &str, payload: serde_json::Value) {
        if origin == "system" {
            let _ = app.emit_to(
                crate::dock_window::DOCK_LABEL,
                "o8:stt-event",
                payload.clone(),
            );
        }
        let _ = app.emit("o8:stt-event", payload);
    }

    /// Forward one TranscriptEvent to the webview. Partial/Level events are
    /// passed straight through for live UI; Final triggers the finalize chain.
    fn forward_event(app: &AppHandle, event: crate::stt::TranscriptEvent) {
        use crate::stt::TranscriptEvent as TE;
        let origin = origin_str();
        match event {
            TE::Partial { session_id, text } => {
                emit_stt(app, origin, serde_json::json!({ "type": "partial", "origin": origin, "sessionId": session_id, "text": text }));
            }
            TE::Level { session_id, level } => {
                emit_stt(app, origin, serde_json::json!({ "type": "level", "origin": origin, "sessionId": session_id, "level": level }));
            }
            TE::Final { session_id, text } => {
                // Stash Apple's transcript; the polished result is emitted once
                // the AudioFile event lands (so polish can ground on the WAV).
                stash_final(session_id, text.clone());
                emit_stt(app, origin, serde_json::json!({ "type": "final", "origin": origin, "sessionId": session_id, "text": text }));
            }
            TE::AudioFile { session_id, path } => {
                emit_stt(app, origin, serde_json::json!({ "type": "audio_file", "origin": origin, "sessionId": session_id, "path": path }));
                run_finalize(app.clone(), session_id, path);
            }
            TE::Status { session_id, text } => {
                emit_stt(app, origin, serde_json::json!({ "type": "status", "origin": origin, "sessionId": session_id, "text": text }));
            }
            TE::Error { session_id, text } => {
                emit_stt(app, origin, serde_json::json!({ "type": "error", "origin": origin, "sessionId": session_id, "text": text }));
            }
            TE::Complete { session_id } => {
                emit_stt(app, origin, serde_json::json!({ "type": "complete", "origin": origin, "sessionId": session_id }));
            }
            TE::Ready => {
                emit_stt(app, origin, serde_json::json!({ "type": "ready", "origin": origin }));
            }
        }
    }

    /// The most recent Apple-Speech final transcript keyed by session id, held
    /// until the AudioFile event arrives so the finalize chain can pair them.
    fn final_store() -> &'static Mutex<Option<(u64, String)>> {
        static STORE: OnceLock<Mutex<Option<(u64, String)>>> = OnceLock::new();
        STORE.get_or_init(|| Mutex::new(None))
    }

    fn stash_final(session_id: u64, text: String) {
        if let Ok(mut guard) = final_store().lock() {
            *guard = Some((session_id, text));
        }
    }

    fn take_final(session_id: u64) -> Option<String> {
        let mut guard = final_store().lock().ok()?;
        match guard.take() {
            Some((sid, text)) if sid == session_id => Some(text),
            other => {
                // Mismatched session — put it back so a later matching AudioFile
                // can still pair with it (rapid-tap ordering safety).
                *guard = other;
                None
            }
        }
    }

    /// Run the finalize chain on a background thread: Whisper re-transcribe
    /// (default-on, OpenRouter) → Gemini polish (audio-grounded). The polished
    /// result is emitted as `o8:stt-event` type `polished`. On any failure we
    /// fall back to Apple's transcript so the user always gets text.
    fn run_finalize(app: AppHandle, session_id: u64, audio_file: String) {
        std::thread::spawn(move || {
            // Long-form Escape-cancel: drop THIS session's finalize entirely — no
            // Whisper, no polish, no paste, no composer emit. Matched by session id
            // so a concurrent (non-cancelled) finalize can't eat the discard. The
            // cancel path already cleared the origin + morphed the dock to idle;
            // just clear the stashed final + temp WAV and bail.
            #[cfg(target_os = "macos")]
            if crate::fn_hotkey::take_discard_finalize(session_id) {
                let _ = take_final(session_id);
                let _ = std::fs::remove_file(&audio_file);
                return;
            }

            // Capture + CONSUME the Right-Option Ask flag at the TOP — before any
            // early return below (discard / voice-command Cancel) could strand it
            // true and mis-route the NEXT dictation to Ask. Routed at the bottom
            // (after polish) via this local. Always false off the macOS Ask path.
            let is_ask = crate::fn_hotkey::take_ask_mode();

            let apple_text = take_final(session_id).unwrap_or_default();

            // Whisper re-transcribes the recorded WAV BEFORE polish; on
            // failure/empty it falls back to Apple's transcript.
            let (raw_text, whisper_used) =
                match (crate::stt::whisper::enabled(), audio_file.as_str()) {
                    (true, path) if !path.is_empty() => {
                        match crate::stt::whisper::transcribe_file(path) {
                            Some(result) => {
                                log::info!(
                                    "[stt] whisper used (latency={}ms model={})",
                                    result.latency_ms,
                                    result.model
                                );
                                (result.text, true)
                            }
                            None => {
                                log::warn!("[stt] whisper failed/empty; using Apple transcript");
                                (apple_text.clone(), false)
                            }
                        }
                    }
                    _ => (apple_text.clone(), false),
                };

            // ── Voice commands (system-Fn path ONLY) ──
            // Deterministic command phrases at the END of the transcript, run on
            // the RAW text BEFORE polish (zero-latency, no LLM). "scratch that" /
            // "cancel" / "never mind" discard the whole dictation; "remove that" /
            // "undo" strips the last word; "new line" / "new paragraph" insert
            // breaks. Gated to origin==system: the in-window composer path has its
            // own TS processor (`voice-commands.ts`), so we must NOT double-process
            // it. `is_system_origin()` is always false off the macOS system path.
            // Also skipped for an Ask question (`!is_ask`) — a spoken question
            // must reach Gemini verbatim, not be mangled by the command parser.
            let raw_text = if crate::fn_hotkey::is_system_origin() && !is_ask {
                match crate::stt::commands::process(&raw_text) {
                    crate::stt::commands::CommandResult::Text(t) => t,
                    crate::stt::commands::CommandResult::Cancel => {
                        // Cancelled — clear origin + morph the dock back to idle,
                        // no paste, no composer emit.
                        crate::fn_hotkey::set_system_origin(false);
                        let _ = std::fs::remove_file(&audio_file);
                        #[cfg(target_os = "macos")]
                        {
                            let idle = serde_json::json!({ "type": "system-idle", "origin": "system" });
                            let _ = app.emit_to(crate::dock_window::DOCK_LABEL, "o8:stt-event", idle.clone());
                            let _ = app.emit("o8:stt-event", idle);
                        }
                        return;
                    }
                    crate::stt::commands::CommandResult::Speak(t) => {
                        // "say <text>" — speak it aloud, don't paste. Clear origin
                        // + morph the dock back to idle.
                        crate::fn_hotkey::set_system_origin(false);
                        let _ = std::fs::remove_file(&audio_file);
                        #[cfg(target_os = "macos")]
                        {
                            if !t.trim().is_empty() {
                                crate::tts::playback::play_thread(t, crate::tts::load_config());
                            }
                            let idle = serde_json::json!({ "type": "system-idle", "origin": "system" });
                            let _ = app.emit_to(crate::dock_window::DOCK_LABEL, "o8:stt-event", idle.clone());
                            let _ = app.emit("o8:stt-event", idle);
                        }
                        #[cfg(not(target_os = "macos"))]
                        let _ = t;
                        return;
                    }
                }
            } else {
                raw_text
            };

            // Read the recorded WAV so Gemini can hear what was actually said.
            let audio_wav = std::fs::read(&audio_file).ok();

            // Pure-accuracy upgrade: walk the focused app's Accessibility tree so
            // polish can spell on-screen proper nouns, resolve pronouns, and match
            // the surrounding window's tone. Best-effort — empty/None for canvas /
            // Electron apps that don't expose AX text. (System-wide Symon fold P1.)
            let window_ctx = crate::paste::gather_window_context();

            let ctx = crate::stt::polish::PolishContext {
                transcript: &raw_text,
                audio_wav: audio_wav.as_deref(),
                frontmost_app: None,
                window_title: window_ctx.window_title,
                selected_text: window_ctx.selected_text,
                ax_excerpt: window_ctx.ax_excerpt,
                // Custom dictionary + polish instructions from the Voice settings
                // (`~/.o8/dictation.json`) — so the operator's proper nouns spell
                // right and their guidance shapes the cleanup (#1209).
                dictionary: crate::stt::keys::config_string_list("dictionary"),
                instructions: crate::stt::keys::config_string("polish_instructions")
                    .unwrap_or_default(),
                replacements: Vec::new(),
            };

            let polished = if crate::stt::polish::is_available()
                && !crate::stt::polish::should_skip_polish(&ctx)
            {
                crate::stt::polish::polish(&ctx)
            } else {
                raw_text.clone()
            };

            // Diagnostic: WHERE does emptiness enter the pipeline? Lengths only
            // (never the text — privacy). apple = Apple SFSpeech final, raw =
            // post-Whisper, polished = post-Gemini. Empty `polished` with a
            // non-empty `raw` means polish ate it (Gemini key/failure); empty
            // `apple` AND `raw` means STT produced nothing at all (Microphone /
            // Speech-Recognition permission, not Accessibility).
            log::info!(
                "[stt] finalize lengths: apple={} raw={} whisper_used={} polished={}",
                apple_text.chars().count(),
                raw_text.chars().count(),
                whisper_used,
                polished.chars().count()
            );

            // Best-effort cleanup of the temp WAV.
            let _ = std::fs::remove_file(&audio_file);

            // ── Ask mode (Right-Option) — the polished text is a QUESTION ──
            // Route it to Gemini + speak the answer; do NOT paste or emit to the
            // composer. Checked AFTER polish so the question is cleaned up, and
            // BEFORE the paste/composer origin branch. The flag was already
            // consumed at the top (`is_ask`) so a stray re-finalize can't re-ask.
            #[cfg(target_os = "macos")]
            if is_ask {
                // Ask ran as a system-origin session (for the live dock
                // transcript) — reset the flag so the next dictation isn't
                // mistaken for system-origin.
                crate::fn_hotkey::set_system_origin(false);
                // The dock was morphed to 'recording' on ask-start; return it to
                // idle now — the Ask answer panel takes over when the answer lands.
                let idle = serde_json::json!({ "type": "system-idle", "origin": "system" });
                let _ = app.emit_to(crate::dock_window::DOCK_LABEL, "o8:stt-event", idle.clone());
                let _ = app.emit("o8:stt-event", idle);
                crate::dictation_history::record("ask", &polished, None);
                crate::spawn_ask_and_speak(app.clone(), polished);
                return;
            }

            // ── Origin branch (system-wide Symon fold P2) ──
            // A dictation started by the GLOBAL Fn hotkey pastes the polished text
            // at the system caret and does NOT emit the composer-bound `polished`
            // event (which would double-fire into the in-window composer). A
            // dictation started by the in-window mic button emits as before. These
            // are mutually exclusive — never paste AND emit.
            if crate::fn_hotkey::is_system_origin() {
                // Clear the flag first so a daemon hiccup can't re-paste a stale
                // session, then paste into whatever app the user is focused on.
                crate::fn_hotkey::set_system_origin(false);
                if polished.trim().is_empty() {
                    // Nothing transcribed (silence / STT miss) — morph the
                    // always-on dock back to its idle capsule rather than flash a
                    // false "Pasted". Symon parity: never claim a paste it didn't
                    // make. emit_to(DOCK_LABEL) + broadcast (same reliable path).
                    let idle = serde_json::json!({ "type": "system-idle", "origin": "system" });
                    let _ = app.emit_to(crate::dock_window::DOCK_LABEL, "o8:stt-event", idle.clone());
                    let _ = app.emit("o8:stt-event", idle);
                } else {
                    crate::paste::paste_text(&polished);
                    // Persist to dictation history so the operator can retrieve
                    // what they said if the paste landed in the wrong place.
                    crate::dictation_history::record(
                        "dictation",
                        &polished,
                        crate::paste::get_frontmost_bundle_id(),
                    );
                    // Remember the polished text so the ⌘⌥V global shortcut can
                    // re-paste the last dictation (voice P3 paste-last).
                    crate::fn_hotkey::set_last_voice_transcript(&polished);
                    // Dock-only success signal carrying the ACTUAL pasted words so
                    // the notch dock shows the text (Symon parity), not a generic
                    // "Pasted". The in-window DictationHost ignores system-origin,
                    // so this never double-fires into the composer. The dock is
                    // ALWAYS-ON: it MORPHS (success flash → idle capsule) in place;
                    // the /dictation-pill route collapses to idle after
                    // SUCCESS_FLASH_MS. Emit DIRECTLY to the dock (emit_to
                    // DOCK_LABEL) so the flash always lands, plus the broadcast.
                    let char_count = polished.chars().count();
                    let pasted = serde_json::json!({
                        "type": "system-pasted",
                        "origin": "system",
                        "sessionId": session_id,
                        "text": polished,
                        "chars": char_count,
                    });
                    let _ = app.emit_to(crate::dock_window::DOCK_LABEL, "o8:stt-event", pasted.clone());
                    let _ = app.emit("o8:stt-event", pasted);
                    // Cue: paste landed (#1208).
                    crate::sound::play_sound("Done");
                }
            } else {
                let _ = app.emit(
                    "o8:stt-event",
                    serde_json::json!({
                        "type": "polished",
                        "origin": "in-window",
                        "sessionId": session_id,
                        "text": polished,
                        "rawText": raw_text,
                        "appleText": apple_text,
                        "whisperUsed": whisper_used,
                    }),
                );
            }
        });
    }

    /// Begin a dictation. Returns the new session id so the JS side can match
    /// subsequent `o8:stt-event` payloads.
    pub fn start() -> Result<u64, String> {
        let sid = next_session_id();
        active_session().store(sid, Ordering::SeqCst);
        let mut guard = recognizer()
            .lock()
            .map_err(|_| "STT recognizer unavailable".to_string())?;
        // Respawn if the daemon died between sessions.
        if !guard.is_running() {
            log::warn!("[stt] daemon not running on start; respawning");
            let _ = guard.respawn();
        }
        guard.start(sid)?;
        Ok(sid)
    }

    /// End the active dictation. The finalize chain fires off the daemon's
    /// final/audio_file stdout events.
    pub fn stop() -> Result<(), String> {
        let sid = active_session().load(Ordering::SeqCst);
        let mut guard = recognizer()
            .lock()
            .map_err(|_| "STT recognizer unavailable".to_string())?;
        guard.stop(sid);
        Ok(())
    }

    /// Stop a SPECIFIC dictation session — no-op if a newer session has already
    /// superseded it (`active_session() != expected`). This fences the teardown
    /// so a late stop (a long-form finish, or a brush teardown that raced a
    /// long-form start) can never kill a session the user started afterwards.
    /// `expected == 0` ("unknown") is always a no-op. (Voice P3 long-form.)
    pub fn stop_session(expected: u64) -> Result<(), String> {
        if expected == 0 || active_session().load(Ordering::SeqCst) != expected {
            return Ok(());
        }
        let mut guard = recognizer()
            .lock()
            .map_err(|_| "STT recognizer unavailable".to_string())?;
        // Re-check under the lock: a session could have superseded between the
        // unlocked check above and acquiring the recognizer.
        if active_session().load(Ordering::SeqCst) == expected {
            guard.stop(expected);
        }
        Ok(())
    }

    /// Set the recognition locale (e.g. "en-US").
    pub fn set_locale(locale: &str) -> Result<(), String> {
        let mut guard = recognizer()
            .lock()
            .map_err(|_| "STT recognizer unavailable".to_string())?;
        guard.set_locale(locale)
    }
}

/// Begin a dictation via the native Apple-Speech sidecar. Returns the session
/// id so the frontend can correlate `o8:stt-event` payloads. macOS only.
#[cfg(target_os = "macos")]
#[tauri::command]
fn o8_stt_start() -> Result<u64, String> {
    stt_engine::start()
}

/// End the active native dictation; triggers the finalize chain. macOS only.
#[cfg(target_os = "macos")]
#[tauri::command]
fn o8_stt_stop() -> Result<(), String> {
    stt_engine::stop()
}

/// Set the native recognizer locale (e.g. "en-US"). macOS only.
#[cfg(target_os = "macos")]
#[tauri::command]
fn o8_stt_locale(locale: String) -> Result<(), String> {
    stt_engine::set_locale(&locale)
}

/// Speak `text` aloud via the native TTS engine (voice P4): ElevenLabs/Google →
/// macOS `say` fallback. Fire-and-forget on a dedicated OS thread (rodio is
/// `!Send`), so it returns immediately and never blocks the webview. macOS only.
#[cfg(target_os = "macos")]
#[tauri::command]
fn tts_speak(text: String) {
    tts::playback::play_thread(text, tts::load_config());
}

/// Stop any active TTS playback immediately (the "say"/Ask voice). Single-flight
/// stop — safe no-op when nothing is speaking. macOS only.
#[cfg(target_os = "macos")]
#[tauri::command]
fn tts_stop() {
    tts::playback::stop();
}

/// Toggle pause/resume on the active TTS playback. Returns the resulting paused
/// state (`true` = now paused). macOS only.
#[cfg(target_os = "macos")]
#[tauri::command]
fn tts_toggle_pause() -> bool {
    tts::playback::toggle_pause()
}

/// Whether TTS is currently speaking — lets the UI render the right play/stop
/// control on mount. macOS only.
#[cfg(target_os = "macos")]
#[tauri::command]
fn tts_is_active() -> bool {
    tts::playback::is_active()
}

/// Grow / shrink the screen dock window for the Ask answer panel (voice P4
/// phase C). Called from the `/dictation-pill` webview when it opens/collapses
/// the Ask thread. The resize runs Rust-side so the dock webview needs no
/// window-control permission. macOS only.
#[cfg(target_os = "macos")]
#[tauri::command]
fn dock_set_expanded(app: tauri::AppHandle, expanded: bool) {
    dock_window::set_expanded(&app, expanded);
}

/// Open the standalone Voice settings window (Symon parity). Double-tapping the
/// dock pill invokes this — it works even when the main o8 window is closed,
/// since the dock is always-on. Creates the window on first call, then just
/// shows/focuses it. Renders `/voice-settings` (the same VoiceTab as the main
/// settings overlay).
#[cfg(target_os = "macos")]
#[tauri::command]
fn open_voice_settings(app: tauri::AppHandle) {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
    if let Some(win) = app.get_webview_window("voice-settings") {
        let _ = win.center();
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    // Resolve the frontend origin the same way the dock does (dev-bridge aware).
    let base = match dev_frontend::from_env() {
        Ok(Some(dev)) => dev.origin().to_string(),
        _ => {
            let port = std::env::var("O8_API_PORT")
                .ok()
                .and_then(|s| s.parse::<u16>().ok())
                .unwrap_or(3001);
            format!("http://127.0.0.1:{}", port)
        }
    };
    let url = format!("{}/voice-settings", base);
    let parsed = match url.parse() {
        Ok(u) => u,
        Err(e) => {
            log::warn!("[voice-settings] bad url {url}: {e}");
            return;
        }
    };
    match WebviewWindowBuilder::new(&app, "voice-settings", WebviewUrl::External(parsed))
        .title("o8 Voice Settings")
        .inner_size(560.0, 760.0)
        .min_inner_size(460.0, 520.0)
        .resizable(true)
        .center()
        .focused(true)
        .build()
    {
        Ok(_) => log::info!("[voice-settings] window opened → {url}"),
        Err(e) => log::warn!("[voice-settings] failed to open window: {e}"),
    }
}

/// Read the voice preferences (`~/.o8/dictation.json`) for the settings panel,
/// with API keys stripped. The config is mtime-cached, so writes apply live.
#[tauri::command]
fn voice_prefs_get() -> serde_json::Value {
    crate::stt::keys::config_public()
}

/// Write one voice preference into `~/.o8/dictation.json` (read-modify-write).
/// Takes effect on the next read without a relaunch (mtime cache). Keys:
/// `ducking_enabled`, `sounds_enabled`, `dictionary` (array), `polish_instructions`,
/// `reading_speed`, `tts_provider`, `tts_voice_id`, etc.
#[tauri::command]
fn voice_prefs_set(key: String, value: serde_json::Value) -> Result<(), String> {
    crate::stt::keys::set_pref(&key, value)
}

/// Recent dictation history (newest first) for the settings History panel — the
/// safety net to retrieve what you said when a paste went to the wrong place.
#[tauri::command]
fn dictation_history_get() -> Vec<dictation_history::HistoryEntry> {
    dictation_history::list()
}

#[tauri::command]
fn dictation_history_clear() {
    dictation_history::clear();
}

#[tauri::command]
fn dictation_history_delete(id: String) {
    dictation_history::delete(&id);
}

/// Ask Gemini `question` on a dedicated OS thread, emit the answer to the webview
/// (`o8:ask-answer` / `o8:ask-error`), and SPEAK it through the TTS engine.
/// Shared by the `ask_question` command (text) and the Right-Option voice path
/// (`run_finalize`). macOS only. Gemini only — NEVER Anthropic.
#[cfg(target_os = "macos")]
fn spawn_ask_and_speak(app: tauri::AppHandle, question: String) {
    use tauri::Emitter;
    let question = question.trim().to_string();
    if question.is_empty() {
        return;
    }
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(e) => {
                log::error!("[ask] failed to build runtime: {e}");
                return;
            }
        };
        log::info!("[ask] question: {} chars", question.len());
        match rt.block_on(async { ai::gemini_ask::ask(&question, None).await }) {
            Ok(answer) => {
                log::info!("[ask] answer: {} chars", answer.len());
                let answer_payload =
                    serde_json::json!({ "question": question, "answer": answer });
                // Emit ONLY to the screen dock — the Ask answer panel lives in the
                // dock webview. (Emitting to `main` too made the dock receive it
                // twice → duplicated turns.)
                let _ = app.emit_to(dock_window::DOCK_LABEL, "o8:ask-answer", answer_payload);
                // Speak the answer through the TTS engine (spawns its own thread).
                tts::playback::play_thread(answer, tts::load_config());
            }
            Err(e) => {
                log::warn!("[ask] failed: {e}");
                let err_payload = serde_json::json!({ "message": e });
                let _ = app.emit_to(dock_window::DOCK_LABEL, "o8:ask-error", err_payload);
            }
        }
    });
}

/// Ask o8 a question by text (voice P4 phase C). Thin wrapper over
/// `spawn_ask_and_speak` — the Right-Option voice path calls the same helper.
#[cfg(target_os = "macos")]
#[tauri::command]
fn ask_question(app: tauri::AppHandle, text: String) {
    spawn_ask_and_speak(app, text);
}

/// TEMPORARY debug command (system-wide Symon fold P1): paste `text` into the
/// currently-focused 3rd-party app, so paste-into-frontmost is verifiable
/// without the global Fn hotkey. macOS only.
#[cfg(target_os = "macos")]
#[tauri::command]
fn o8_debug_paste(text: String) {
    paste::paste_text(&text);
}

/// Dock-route morph instrumentation. The `/dictation-pill` route runs in a
/// SECOND webview whose `console.log` does NOT reach `~/Library/Logs/
/// ai.o8.desktop/o8.log` — so when the dock fails to morph there is no server
/// trace to inspect. This thin command lets the dock route write a line to the
/// Rust tracing log (`[dock-route] …`) so we can SEE which `o8:stt-event`
/// payloads actually reach the dock webview (subscribe success + each
/// system-start/system-idle/system-pasted/final/error). High-frequency
/// partial/level events are intentionally NOT logged from the route. macOS only
/// (the dock window is macOS-only).
#[cfg(target_os = "macos")]
#[tauri::command]
fn o8_dock_log(msg: String) {
    // `log::` (captured by tauri_plugin_log → o8.log), NOT `tracing::` — the
    // tracing subscriber writes to stdout, which a bundled .app discards, so the
    // earlier `tracing::info!` here never surfaced in o8.log (false-negative that
    // masked the dock-morph capability bug). `log::info!` is what reaches the file.
    log::info!("[dock-route] {msg}");
}

/// TEMP/debug: morph the always-on screen dock pill into a sample "listening"
/// state so the dock can be screenshotted without a live Fn dictation (which
/// needs TCC perms + a physical Fn press). The dock window is created visible at
/// boot (idle capsule); this just re-asserts it + emits demo events to morph it
/// to recording. Not wired to any UI. macOS only.
#[cfg(target_os = "macos")]
#[tauri::command]
fn o8_debug_show_dock(app: tauri::AppHandle) {
    use tauri::{Emitter, Manager};
    // NSWindow ops are main-thread-only — schedule show() on the main thread
    // (the real Fn path does the same).
    if let Some(win) = app.get_webview_window("main") {
        let a = app.clone();
        let _ = win.run_on_main_thread(move || {
            dock_window::show(&a);
        });
    } else {
        dock_window::show(&app);
    }
    // Re-emit the demo state a few times: the dock webview may be waking from
    // hidden when the first events fire, so repeat until its route subscribes.
    // Emit DIRECTLY to the dock window (emit_to DOCK_LABEL) — the same reliable
    // path the real Fn flow uses — plus the broadcast for parity.
    let a = app.clone();
    std::thread::spawn(move || {
        for delay_ms in [250u64, 800, 1600] {
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
            log::info!("[dock-demo] morph dock → recording (system-start → dock)");
            let events = [
                serde_json::json!({ "type": "system-start", "origin": "system" }),
                serde_json::json!({ "type": "partial", "text": "the o8 dock pill \u{2014} system-wide voice, anywhere", "origin": "system" }),
                serde_json::json!({ "type": "level", "level": 0.62, "origin": "system" }),
            ];
            for payload in &events {
                let _ = a.emit_to(dock_window::DOCK_LABEL, "o8:stt-event", payload.clone());
                let _ = a.emit("o8:stt-event", payload.clone());
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let preship_gate = env_flag_enabled("O8_PRESHIP_GATE");

    if !preship_gate {
        sanitize_window_state();
    }

    // ── Shutdown safety net (issue #719) ──
    // Install panic + Unix-signal handlers BEFORE building Tauri so any
    // crash, SIGTERM, or SIGINT during startup still tears down children.
    // The normal Cmd-Q / app.exit() / CloseRequested paths are handled in
    // the RunEvent callback below; this is the belt-and-suspenders layer
    // for ungraceful exits.
    sidecar_lifecycle::install_shutdown_handlers();

    // ── Boot-time orphan reaper (issues #728 / #776) ──
    // Reap stale `next-server` / `ws-server` processes from prior crashes
    // (reparented to launchd) and remove a stale `/tmp/tauri-mcp-o8-<user>.sock`
    // BEFORE the Tauri builder is constructed — the `tauri-plugin-mcp` plugin
    // binds the socket during builder setup and throws if the file lingers.
    // Wider net than default-port cleanup from #719: hits orphans on any port,
    // not just 3001/3002.
    sidecar_lifecycle::reap_o8_orphans();

    let dev_frontend = match dev_frontend::from_env() {
        Ok(dev_frontend) => dev_frontend,
        Err(err) => {
            eprintln!("[dev-frontend] ignoring {}: {}", dev_frontend::ENV_VAR, err);
            None
        }
    };

    let mut context = tauri::generate_context!();
    if let Some(dev_frontend) = dev_frontend.as_ref() {
        if !dev_frontend::apply_to_main_window_config(context.config_mut(), dev_frontend) {
            eprintln!("[dev-frontend] main window config not found for {}", dev_frontend::ENV_VAR);
        }
    }

    #[allow(unused_mut)] // `mut` is needed only when `dev-mcp-plugin` feature is enabled
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Phase 4 (background presence): launch-at-login. LaunchAgent matches
        // the resident-hotkey-app pattern. Default ON is bootstrapped once from
        // setup() via background::initialize_autostart (marker-guarded).
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ));

    // Voice P3 hotkeys: OS-global keyboard shortcuts. Installing the plugin is
    // harmless on its own — the actual chord registrations live in the
    // `!preship_gate` macOS setup() block so the disposable pre-ship child app
    // never grabs system-wide shortcuts.
    builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());

    // Auto-saves window size + position to the OS data dir on close and
    // restores them on next launch. The pre-ship gate launches a disposable
    // child app and must not mutate the operator's saved window geometry.
    if !preship_gate {
        builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());
    }

    // MCP plugin: exposes app to AI agents (screenshots, DOM, input simulation).
    // Optional dev-only feature. Requires a sibling checkout of tauri-plugin-mcp.
    // Enable with: `cargo tauri dev --features dev-mcp-plugin`.
    #[cfg(feature = "dev-mcp-plugin")]
    {
        // Namespace the socket per-user so two devs on a shared machine don't clash.
        let socket_path = std::env::var("O8_TAURI_MCP_SOCKET").unwrap_or_else(|_| {
            let user = std::env::var("USER").unwrap_or_else(|_| "default".into());
            format!("/tmp/tauri-mcp-o8-{}.sock", user)
        });
        builder = builder.plugin(tauri_plugin_mcp::init_with_config(
            tauri_plugin_mcp::PluginConfig::new("o8".to_string())
                .start_socket_server(true)
                .socket_path(socket_path.into())
                // #932: pin the default webview label so emit_to('main') resolves
                // deterministically against the webview registry, not the
                // ambiguous window-vs-webview label scope. Without this, JS-side
                // listeners registered via WebviewWindow.listen() never receive
                // requests Rust emits with app.emit_to('main', ...).
                .default_webview_label("main".to_string()),
        ));
    }

    builder
        // Inject the console-error capture hook on every main-window page
        // load (issue #793). Non-main windows skip injection — we only care
        // about errors in the main app shell.
        // PageLoadEvent fires twice per navigation (Started + Finished); we
        // inject on Started so the hook is in place before any user JS runs.
        .on_page_load(move |webview, payload| {
            if webview.label() != "main" {
                return;
            }
            if payload.event() != tauri::webview::PageLoadEvent::Started {
                return;
            }
            if !preship_gate {
                launch_updater::start_launch_update_check(webview.app_handle().clone());
            }
            if let Err(err) = WebviewLatch::ConsoleErrorHook.fire(webview) {
                log::warn!("[console-error-hook] inject failed: {}", err);
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_desktop_info,
            check_port,
            start_ws_server,
            cortex_available,
            get_app_data_dir,
            read_repos,
            read_local_commits,
            read_worktrees,
            read_current_branch,
            read_git_status,
            read_approvals,
            read_workspaces,
            set_tray_badge,
            notify_review_ready,
            record_console_error,
            read_dropped_file,
            mcp_result,
            o8_view_console_errors,
            o8_view_active_route,
            #[cfg(target_os = "macos")]
            master_key_get,
            #[cfg(target_os = "macos")]
            master_key_ensure,
            #[cfg(target_os = "macos")]
            o8_stt_start,
            #[cfg(target_os = "macos")]
            o8_stt_stop,
            #[cfg(target_os = "macos")]
            o8_stt_locale,
            #[cfg(target_os = "macos")]
            tts_speak,
            tts_stop,
            tts_toggle_pause,
            tts_is_active,
            dock_set_expanded,
            open_voice_settings,
            voice_prefs_get,
            voice_prefs_set,
            dictation_history_get,
            dictation_history_clear,
            dictation_history_delete,
            #[cfg(target_os = "macos")]
            ask_question,
            #[cfg(target_os = "macos")]
            o8_debug_paste,
            #[cfg(target_os = "macos")]
            o8_dock_log,
            #[cfg(target_os = "macos")]
            o8_debug_show_dock,
            mac_perms::accessibility_permission_granted_cmd,
            mac_perms::input_monitoring_granted_cmd,
            mac_perms::fn_key_usage_type_cmd,
            background::autostart_is_enabled,
            background::autostart_set,
            background::background_mode_is_enabled,
            background::background_mode_set,
            background::open_system_settings,
        ])
        .setup(move |app| {
            // ── System Tray (issue #731) ──
            // Menu items: Show / Quit.
            let show = MenuItem::with_id(app, "show", "Show o8", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quit o8", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &separator, &quit])?;

            let tray = TrayIconBuilder::new()
                .menu(&menu)
                // Show menu on left-click (default is right-click only on
                // macOS) so the count-aware list is one click away.
                .show_menu_on_left_click(false)
                .tooltip("o8")
                .on_menu_event(|app, event| {
                    let id = event.id.as_ref();
                    match id {
                        "show" => {
                            // P4: the tray is the re-entry point. If background
                            // mode hid the Dock icon (Accessory), restore Regular
                            // so the user gets a window AND a Dock icon back —
                            // never stranded windowless. Centralized in background.
                            background::set_background_mode(app, false, true);
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        lane if lane.starts_with("lane:") => {
                            // #731 — dynamic lane row click. Surface the
                            // window so the operator sees the review queue,
                            // then emit a Tauri event the frontend can pick
                            // up to scroll the AgentPanel to the lane.
                            background::set_background_mode(app, false, true);
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                            let lane_id = &lane["lane:".len()..];
                            let _ = app.emit("tray:focus-lane", lane_id.to_string());
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        // P4: tray left-click is also a deliberate "bring me
                        // back" — restore Regular so the Dock icon returns.
                        background::set_background_mode(app, false, true);
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;
            // Store the handle so background tasks (badge poller) and
            // frontend commands can mutate the tray's title / tooltip.
            store_tray(tray);

            // ── Badge poller (issue #731) ──
            // 5s tick keeps the tray title in sync with awaiting_review
            // count without waiting on a frontend WS subscription. Cheap
            // — one HTTP GET per tick, hits the same server as the panel.
            spawn_tray_badge_poller(app.handle().clone());

            // ── Background presence (system-wide Symon fold P4) ──
            // 1. Launch-at-login defaults ON so the pill + Fn hotkey work without
            //    opening o8; marker-guarded so it auto-enables exactly once.
            // 2. Re-apply the persisted background-mode (Accessory/Regular) pref —
            //    default OFF (Dock icon visible), so a fresh boot is never an
            //    invisible app. This is the single boot-time activation-policy
            //    apply; the Settings toggle is the only other caller.
            // The pre-ship gate launches a disposable child app — never mutate the
            // operator's autostart registration or activation policy from it.
            if !preship_gate {
                background::initialize_autostart(app.handle());
                background::apply_persisted_background_mode(app.handle());

                // ── Boot-time update check (P4 review MEDIUM) ──
                // A background/autostart session that never opens the main window
                // would otherwise never self-update (the on_page_load check only
                // fires when main loads). Fire it here too — start_launch_update_check
                // is AtomicBool-guarded, so this never double-fires with on_page_load.
                launch_updater::start_launch_update_check(app.handle().clone());
            }

            // ── Voice STT engine (lifted from aqua/Symon, de-Symonized) ──
            // Install a tracing subscriber so the lifted STT modules' `tracing::`
            // logs surface (idempotent — `try_init` no-ops if one already set),
            // then spawn the Apple-Speech sidecar daemon ONCE. Both are
            // best-effort: a missing Swift helper or a poisoned mutex is logged
            // and skipped, leaving the existing dictation path intact. macOS only.
            #[cfg(target_os = "macos")]
            if !preship_gate {
                let _ = tracing_subscriber::fmt()
                    .with_env_filter(
                        tracing_subscriber::EnvFilter::try_from_default_env()
                            .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
                    )
                    .try_init();
                stt_engine::spawn(app.handle().clone());
                // Boot the procedural sound-cue worker (#1208) — owns its own
                // audio stream so cues never collide with TTS playback.
                sound::spawn_worker();
                // Let the off-thread TTS playback morph the screen dock while it speaks.
                tts::set_app_handle(app.handle().clone());

                // ── Global Fn hotkey → system-wide paste (system-wide Symon fold P2) ──
                // Reuses the stt_engine daemon spawned just above — never spawns a
                // second recognizer. On Fn-down it saves the focused app + starts
                // dictation; on Fn-up the finalize chain pastes the polished text at
                // the system caret (see the origin branch in run_finalize). Runs its
                // own CGEventTap on a dedicated CFRunLoop thread, so it keeps working
                // even when the main window is hidden.
                fn_hotkey::start(app.handle().clone());

                // ── Voice P3 global shortcuts ──
                // OS-global chords (fire even when o8 is unfocused). The Fn /
                // double-tap-Fn gestures stay on the CGEventTap above (modifier-
                // only gestures the plugin can't bind); these three map to
                // existing o8 capabilities. Registered INSIDE !preship_gate so the
                // disposable pre-ship child app never grabs system-wide chords.
                // Registration failures are logged, not fatal — a chord already
                // owned by another app must not block boot.
                {
                    use tauri::{Emitter, Manager};
                    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

                    // ⌘⇧Space → summon the o8 window to the front. o8's window is
                    // the full IDE (not a tiny pill), so summon-to-front only —
                    // never hide the whole IDE on a global chord.
                    if let Ok(sc) = "CommandOrControl+Shift+Space".parse::<Shortcut>() {
                        let h = app.handle().clone();
                        if let Err(e) = app.global_shortcut().on_shortcut(sc, move |_app, _sc, event| {
                            if event.state != ShortcutState::Pressed {
                                return;
                            }
                            if let Some(win) = h.get_webview_window("main") {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }) {
                            log::warn!("[hotkey] failed to register CmdShiftSpace (summon): {e}");
                        }
                    }

                    // ⌘⌥V → paste the last voice dictation at the system caret.
                    if let Ok(sc) = "CommandOrControl+Alt+V".parse::<Shortcut>() {
                        if let Err(e) = app.global_shortcut().on_shortcut(sc, move |_app, _sc, event| {
                            if event.state != ShortcutState::Pressed {
                                return;
                            }
                            if let Some(text) = fn_hotkey::last_voice_transcript() {
                                // paste_text does clipboard + a synthetic ⌘V + a
                                // focus settle — run it off the event-loop thread.
                                std::thread::spawn(move || crate::paste::paste_text(&text));
                            }
                        }) {
                            log::warn!("[hotkey] failed to register CmdAltV (paste-last): {e}");
                        }
                    }

                    // ⌘⇧, → open the in-app settings overlay. o8 settings is an
                    // overlay in the main webview (not a window), so emit to the
                    // dashboard rather than showing a "settings" window.
                    if let Ok(sc) = "CommandOrControl+Shift+,".parse::<Shortcut>() {
                        let h = app.handle().clone();
                        if let Err(e) = app.global_shortcut().on_shortcut(sc, move |_app, _sc, event| {
                            if event.state != ShortcutState::Pressed {
                                return;
                            }
                            let _ = h.emit_to("main", "o8:open-settings", ());
                        }) {
                            log::warn!("[hotkey] failed to register CmdShiftComma (settings): {e}");
                        }
                    }

                    // ⌘⇧S → speak the current text selection aloud (voice P4
                    // "say" / speak-selection). grab_selection does clipboard
                    // polling with sleeps, so run the whole thing off the
                    // event-loop thread; play_thread then spawns its own audio
                    // thread. Falls back to `say` inside play_thread.
                    if let Ok(sc) = "CommandOrControl+Shift+S".parse::<Shortcut>() {
                        let h_speak = app.handle().clone();
                        if let Err(e) = app.global_shortcut().on_shortcut(sc, move |_app, _sc, event| {
                            if event.state != ShortcutState::Pressed {
                                return;
                            }
                            // ⌘⇧S is a toggle: if TTS is already speaking, this
                            // press STOPS it instead of starting a second read.
                            // This is the primary keyboard stop AND prevents the
                            // re-trigger-stacking that forced a hard kill before.
                            if crate::tts::playback::is_active() {
                                std::thread::spawn(crate::tts::playback::stop);
                                return;
                            }
                            // o8's own webview doesn't expose its text selection via
                            // AXSelectedText (and synthetic Cmd+C can't copy it), so
                            // when o8 is frontmost ask the WEBVIEW for its selection
                            // (window.getSelection) via the frontend. For any other
                            // app, grab the selection natively (AX → Cmd+C).
                            if crate::paste::frontmost_is_o8() {
                                let _ = h_speak.emit_to("main", "o8:speak-selection", ());
                                return;
                            }
                            std::thread::spawn(|| match crate::paste::grab_selection() {
                                Some(text) => {
                                    crate::tts::playback::play_thread(text, crate::tts::load_config());
                                }
                                None => log::info!("[tts] CmdShiftS: no selection to speak"),
                            });
                        }) {
                            log::warn!("[hotkey] failed to register CmdShiftS (speak-selection): {e}");
                        }
                    }
                }
            }

            // ── Window Close → Hide to Tray ──
            let app_handle = app.handle().clone();
            if let Some(window) = app.get_webview_window("main") {
                #[cfg(target_os = "macos")]
                if let Err(err) =
                    apply_vibrancy(&window, NSVisualEffectMaterial::HudWindow, None, None)
                {
                    log::warn!("Failed to apply macOS vibrancy: {}", err);
                }

                #[cfg(target_os = "windows")]
                if let Err(err) = apply_blur(&window, Some((24, 26, 30, 168))) {
                    log::warn!("Failed to apply Windows blur: {}", err);
                }

                window.on_window_event(move |event| {
                    match event {
                        tauri::WindowEvent::CloseRequested { api, .. } => {
                            // Hide instead of close — agents keep working
                            api.prevent_close();
                            if let Some(w) = app_handle.get_webview_window("main") {
                                let _ = w.hide();
                            }
                            let _ = app_handle.emit("window-hidden", ());
                        }
                        // #1136 — bridge OS-level drag-drop into the webview as
                        // window CustomEvents. With dragDropEnabled: true in
                        // tauri.conf.json, HTML5 drop events no longer fire for
                        // EXTERNAL drags (Finder → app), so this is the only
                        // path that lets composers receive Finder file paths.
                        // Internal webview drags (tile reorder, etc.) still
                        // work through normal HTML5.
                        tauri::WindowEvent::DragDrop(drag) => match drag {
                            tauri::DragDropEvent::Enter { paths, position } => {
                                let payload = serde_json::json!({
                                    "paths": paths.iter()
                                        .map(|p| p.to_string_lossy().into_owned())
                                        .collect::<Vec<_>>(),
                                    "position": { "x": position.x, "y": position.y },
                                });
                                let _ = app_handle.emit("o8:tauri-file-drop-enter", payload);
                            }
                            tauri::DragDropEvent::Over { position } => {
                                let payload = serde_json::json!({
                                    "position": { "x": position.x, "y": position.y },
                                });
                                let _ = app_handle.emit("o8:tauri-file-drop-over", payload);
                            }
                            tauri::DragDropEvent::Drop { paths, position } => {
                                let payload = serde_json::json!({
                                    "paths": paths.iter()
                                        .map(|p| p.to_string_lossy().into_owned())
                                        .collect::<Vec<_>>(),
                                    "position": { "x": position.x, "y": position.y },
                                });
                                let _ = app_handle.emit("o8:tauri-file-drop", payload);
                            }
                            tauri::DragDropEvent::Leave => {
                                let _ = app_handle.emit("o8:tauri-file-drop-leave", ());
                            }
                            _ => {}
                        },
                        _ => {}
                    }
                });
            }

            // ── Start bundled Next.js server ──
            let resource_dir = app.path().resource_dir().expect("failed to resolve resource dir");
            let server_dir = resource_dir.join("server");
            let server_js = server_dir.join("server.js");

            // First-launch CLI symlink. The o8 CLI ships inside the .app at
            // Contents/Resources/server/bin/o8; symlink it onto PATH so the
            // operator + dispatched workers can just type `o8 <command>`.
            // Skip on failure — no permission, no /usr/local/bin, no problem.
            if !preship_gate {
                ensure_cli_on_path(&server_dir.join("bin").join("o8"));
            }

            // If a dev server is already running on the default port (e.g. the
            // user is running `npm run desktop:dev` in a terminal), defer to it
            // and don't spawn the bundled copy — the dev server is the source
            // of truth during iteration.
            //
            // BUT: a crashed prior install may have orphaned its bundled Next
            // server (reparented to launchd, still holding :3001). Issue #509
            // — we now classify the listener before deferring. An orphan gets
            // killed and we fall through to the bundled-spawn path so the new
            // shell owns both Next and ws-server.
            let dev_server_running = if env_flag_enabled("O8_FORCE_BUNDLED_SERVERS") {
                false
            } else if dev_frontend.is_some() {
                // The explicit frontend override owns API selection; probing
                // :3001 here could kill an unrelated listener during hot reload.
                false
            } else {
                match classify_port_listener(3001) {
                    PortListener::Free => false,
                    PortListener::Legit {
                        pid,
                        command,
                        o8_owned,
                    } => {
                        if !o8_owned {
                            log::info!(
                                "[orphan-check] :3001 is owned by non-o8 listener (pid={}, cmd={:?}) — bundled server will allocate another port",
                                pid, command
                            );
                            false
                        } else {
                            log::info!(
                                "[orphan-check] :3001 looks like an active o8 listener (pid={}, cmd={:?}) — deferring",
                                pid, command
                            );
                            true
                        }
                    }
                    PortListener::Orphan { pid, command } => {
                        log::info!(
                            "[orphan-check] :3001 owned by ORPHAN pid={} cmd={:?} — killing",
                            pid, command
                        );
                        sidecar_lifecycle::kill_orphan_and_wait(pid, 3001);
                        // Re-probe in case another legit process grabbed the port
                        // between kill and this check. Unlikely but cheap.
                        std::net::TcpStream::connect("127.0.0.1:3001").is_ok()
                    }
                }
            };

            // Default ports that survived from the legacy 3001/3002 era. If
            // nothing is on them and the bundled server is about to start,
            // these become the actual bindings. If they're taken, we probe
            // upward from the Rust side.
            let mut api_port: u16 = 3001;
            let mut ws_port: u16 = 3002;

            if let Some(dev_frontend) = dev_frontend.as_ref() {
                api_port = dev_frontend.port();
                if api_port != 3002 {
                    // Keep the WS orphan cleanup, but never kill the explicit
                    // dev frontend if an operator intentionally points at 3002.
                    sidecar_lifecycle::kill_o8_orphans_on_port(3002);
                }
                ws_port = find_free_port(WS_PORT_RANGE, Some(api_port)).unwrap_or(3002);
                log::info!(
                    "[dev-frontend] {}={} — skipping bundled Next; ports api={} ws={}",
                    dev_frontend::ENV_VAR,
                    dev_frontend.url().as_str(),
                    api_port,
                    ws_port
                );
                let _ = write_port_file("api-port", api_port);
                let _ = write_port_file("ws-port", ws_port);
                std::env::set_var("O8_API_PORT", api_port.to_string());
                std::env::set_var("O8_WS_PORT", ws_port.to_string());

                let node_bin = match run_node_preflight() {
                    Ok(path) => path,
                    Err(err) => show_node_error_and_exit(err),
                };
                std::env::set_var("O8_NODE_BIN", &node_bin);

                let ws_log = open_child_log("ws-server.log");
                let ai_keys = load_ai_keys_from_login_shell();
                if !ai_keys.is_empty() {
                    log::info!(
                        "Forwarded {} AI provider key(s) from login shell to ws-server",
                        ai_keys.len()
                    );
                }
                spawn_bundled_ws_server(
                    &node_bin,
                    &server_dir,
                    ws_port,
                    dev_frontend.origin(),
                    ws_log.as_ref(),
                    &ai_keys,
                );
                // Dev-bridge: the bundled Next isn't spawned here, but the dev
                // server IS up on `api_port` — create the dock pill against it.
                // prewarm polls `:{api_port}/dashboard` (the dev server) then
                // `dock_window::create` loads the dock from the dev origin. Without
                // this the dock never appears in dev-bridge (prewarm was only wired
                // into the bundled-spawn branch), so dock UI couldn't be iterated.
                prewarm_bundled_next_server(app.handle().clone(), api_port);
            } else if dev_server_running {
                log::info!("Dev server already running on :3001 — skipping bundled servers");
                // Write the dev ports so MCP servers launched from this
                // session agree with the dev backend.
                let _ = write_port_file("api-port", api_port);
                let _ = write_port_file("ws-port", ws_port);
                std::env::set_var("O8_API_PORT", api_port.to_string());
                std::env::set_var("O8_WS_PORT", ws_port.to_string());
            } else if server_js.exists() {
                // ── Node.js pre-flight ──
                // Resolve node via a login shell (handles nvm/fnm/volta),
                // verify version, and show a native dialog + exit on failure.
                // Without this the app silently loader-spins forever.
                let node_bin = match run_node_preflight() {
                    Ok(path) => path,
                    Err(err) => show_node_error_and_exit(err),
                };
                // Persist for child processes (MCP server, ws-server, etc.)
                std::env::set_var("O8_NODE_BIN", &node_bin);

                // Widen PATH from the login shell so the Next server's setup
                // detect (`which codex`), Codex dispatch spawn, and worktree
                // `pnpm install` can find the user's CLIs — Finder's minimal
                // PATH hides ~/.npm-global/bin, Homebrew, ~/.local/bin, etc.
                augment_process_path_from_login_shell();

                if preship_gate {
                    // ── Pre-ship boot gate isolation ──
                    // This is a disposable 2nd instance launched alongside the
                    // operator's live app. It must NEVER reap or bind the
                    // operator's ports. find_free_port() can wrongly return the
                    // operator's :3001 via an IPv4/IPv6 dual-stack bind quirk
                    // (the probe's 127.0.0.1 bind doesn't conflict with an
                    // operator listener on ::1/0.0.0.0), so do NOT probe — bind
                    // exactly the free ports the gate driver provisioned.
                    api_port = std::env::var("O8_API_PORT")
                        .ok()
                        .and_then(|p| p.parse().ok())
                        .unwrap_or(3060);
                    ws_port = std::env::var("O8_WS_PORT")
                        .ok()
                        .and_then(|p| p.parse().ok())
                        .unwrap_or(3061);
                    log::info!("[preship-gate] forced isolated ports: api={} ws={}", api_port, ws_port);
                } else {
                    // ── Reap o8 orphans on default ports (issue #719) ──
                    // If a previous install crashed or was killed in a way that
                    // left its Node children reparented to launchd, they're
                    // still serving on 3001/3002 right now. The naive
                    // find_free_port() below would step around them and pick
                    // 3003+ — but the webview keeps loading from 3001 and gets
                    // the stale orphan. Force-clear only o8-owned launchd orphans
                    // first so the new sidecar binds cleanly without killing
                    // unrelated local services.
                    sidecar_lifecycle::kill_o8_orphans_on_port(3001);
                    sidecar_lifecycle::kill_o8_orphans_on_port(3002);

                    // ── Port allocation ──
                    // Probe for free ports starting at the legacy defaults. If the
                    // user has something else on 3001/3002 (another o8 instance, a
                    // Next dev server, a random service), fall through to 3003+.
                    api_port = find_free_port(API_PORT_RANGE, None).unwrap_or(3001);
                    ws_port = find_free_port(WS_PORT_RANGE, Some(api_port)).unwrap_or(3002);
                    log::info!("Allocated ports: api={} ws={}", api_port, ws_port);
                }
                let _ = write_port_file("api-port", api_port);
                let _ = write_port_file("ws-port", ws_port);
                std::env::set_var("O8_API_PORT", api_port.to_string());
                std::env::set_var("O8_WS_PORT", ws_port.to_string());

                // Tell the Next server where the bundled MCP scripts live so
                // `/api/setup/mcp-config` and `orchestrator-session.ts` can
                // emit `node <bundled>.mjs` commands instead of dev `tsx` paths.
                let bundled_operator_mcp = server_dir.join("operator-mcp-server.mjs");
                let has_bundled_mcp = bundled_operator_mcp.exists();
                if has_bundled_mcp {
                    log::info!("Bundled MCP scripts at {:?}", server_dir);
                }

                // Issue #755: kick off the codebase-memory-mcp download in
                // the background. On a cache hit (existing install) the
                // env var lands synchronously before Next.js spawns. On a
                // cold first launch the download runs concurrently with
                // Next.js boot and the binary lands at the deterministic
                // path `~/.o8/bin/codebase-memory-mcp` — #740's MCP
                // registration resolves the path from the env var or
                // re-checks the filesystem on session spawn.
                ensure_codebase_memory_binary(app.handle().clone());

                // Open per-server log files before spawning so stdout/stderr
                // can be wired directly. Rotated to .prev on each boot.
                let next_log = open_child_log("next-server.log");
                let ws_log = open_child_log("ws-server.log");

                log::info!("Starting server: {} {:?} on :{}", node_bin, server_js, api_port);
                let mut server_cmd = Command::new(&node_bin);
                server_cmd
                    .arg(&server_js)
                    .current_dir(&server_dir)
                    .env("PORT", api_port.to_string())
                    .env("HOSTNAME", "0.0.0.0")
                    .env("NODE_ENV", "production")
                    .env("O8_NODE_BIN", &node_bin)
                    .env("O8_API_PORT", api_port.to_string())
                    .env("O8_WS_PORT", ws_port.to_string())
                    .env("WS_PORT", ws_port.to_string())
                    // Issue #776: marker so future sidecar boots can identify
                    // this child as an o8 sibling. macOS doesn't let us read
                    // env vars of other processes without root, so this is
                    // best-effort forward-compat for Linux/Windows /proc and
                    // human-readable in `ps -E` from the same user.
                    .env("O8_SIDECAR_PID", std::process::id().to_string());
                if has_bundled_mcp {
                    server_cmd.env("O8_BUNDLED_MCP_DIR", &server_dir);
                    server_cmd.env("O8_BUNDLED_MCP_PATH", &bundled_operator_mcp);
                }
                // Issue #755: forward the codebase-memory-mcp path. On a
                // cache hit `ensure_codebase_memory_binary()` set this
                // env var synchronously above; on a cold first launch
                // it's empty here and the download populates it later
                // (Next-spawned children re-resolve from the env or the
                // deterministic path).
                if let Ok(cmm_bin) = std::env::var("O8_CODEBASE_MEMORY_BIN") {
                    if !cmm_bin.is_empty() {
                        server_cmd.env("O8_CODEBASE_MEMORY_BIN", cmm_bin);
                    }
                }
                // Issue #935: forward AI provider keys from the user's login
                // shell so Finder-launched builds aren't dead for Gemini /
                // Anthropic / etc. features the user has keys for.
                let ai_keys = load_ai_keys_from_login_shell();
                for (k, v) in &ai_keys {
                    server_cmd.env(k, v);
                }
                if !ai_keys.is_empty() {
                    log::info!(
                        "Forwarded {} AI provider key(s) from login shell to next-server",
                        ai_keys.len()
                    );
                }
                match server_cmd
                    .stdout(child_stdio(next_log.as_ref()))
                    .stderr(child_stdio(next_log.as_ref()))
                    .spawn()
                {
                    Ok(child) => {
                        let pid = child.id();
                        log::info!("Next.js server started (pid: {})", pid);
                        sidecar_lifecycle::register_child(pid);
                        prewarm_bundled_next_server(app.handle().clone(), api_port);
                    }
                    Err(e) => {
                        log::error!("Failed to start server: {}", e);
                        show_node_error_and_exit(NodePreflightError::Missing);
                    }
                }

                // ── Start WebSocket server (terminals, chat, git watcher) ──
                //
                // If ws-server.mjs is missing the app boots into a degraded
                // state — /ws requests rewrite to a dead upstream and Next.js
                // can spiral into a CPU-pegged error loop. We no longer
                // silently swallow that: it's a fatal startup error so the
                // user sees the failure instead of a hung dashboard.
                let next_origin = format!("http://127.0.0.1:{}", api_port);
                spawn_bundled_ws_server(
                    &node_bin,
                    &server_dir,
                    ws_port,
                    &next_origin,
                    ws_log.as_ref(),
                    &ai_keys,
                );
            } else {
                log::warn!("No bundled server found at {:?} — running in dev mode", server_js);
                let _ = write_port_file("api-port", api_port);
                let _ = write_port_file("ws-port", ws_port);
                std::env::set_var("O8_API_PORT", api_port.to_string());
                std::env::set_var("O8_WS_PORT", ws_port.to_string());
            }

            // Expose the resolved ports to the frontend loader HTML so it
            // knows where to navigate.
            std::env::set_var("CORTEX_IDE_API_PORT", api_port.to_string());
            std::env::set_var("CORTEX_IDE_WS_PORT", ws_port.to_string());

            log::info!("Cortex IDE desktop shell initialized");

            Ok(())
        })
        .build(context)
        .expect("error while building Cortex IDE")
        .run(|_app_handle, event| match event {
            // ExitRequested fires on Cmd-Q, app.exit(), tray Quit menu, etc.
            // We tear down children here so they don't outlive the parent.
            // Children also see a TERM via the OS process group on graceful
            // exits, but the explicit kill is what catches detached/launchd
            // reparenting.
            RunEvent::ExitRequested { .. } => {
                sidecar_lifecycle::kill_tracked_children();
            }
            // Final event before the loop terminates. Idempotent with the
            // ExitRequested handler — kill_tracked_children() drains the
            // registry on first call.
            RunEvent::Exit => {
                sidecar_lifecycle::kill_tracked_children();
            }
            _ => {}
        });
}
