use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::collections::VecDeque;
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;
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
//   2. Legit dev → defer (parent is NOT launchd, or binary is not the
//      bundled server).
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
    /// Legitimate listener — defer to it (dev server, etc.).
    Legit { pid: u32, command: String },
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

    log::info!(
        "[orphan-check] :{} bound by pid={} ppid={} cmd={:?}",
        port, pid, ppid, command
    );

    // Orphan signature: parent is launchd (pid 1) AND the binary path
    // points into the packaged app's server bundle. We accept either
    // `/Applications/o8.app/Contents/Resources/server/server.js` (signed
    // install) or the more general `.app/Contents/Resources/server`
    // substring in case someone installed under a different prefix.
    let looks_bundled =
        command.contains(".app/Contents/Resources/server")
        || command.contains("/Resources/server/server.js")
        || command.ends_with("server.js");

    if ppid == 1 && looks_bundled {
        PortListener::Orphan { pid, command }
    } else {
        PortListener::Legit { pid, command }
    }
}

#[cfg(not(target_os = "macos"))]
#[allow(dead_code)]
fn classify_port_listener(port: u16) -> PortListener {
    // TODO(#548): implement Windows/Linux orphan detection. Until then we
    // fall back to the original naive behavior: anything listening is
    // treated as a legitimate dev server.
    if std::net::TcpStream::connect(format!("127.0.0.1:{}", port)).is_ok() {
        PortListener::Legit {
            pid: 0,
            command: "<unsupported-platform>".to_string(),
        }
    } else {
        PortListener::Free
    }
}

/// SIGKILL the orphan and poll until the port is released. Returns true if
/// the port became free within the timeout, false if the socket is still
/// held (caller should log + continue — launching anyway is worse than
/// trying to bind a free port higher up the range).
#[cfg(target_os = "macos")]
fn kill_orphan_and_wait(pid: u32, port: u16) -> bool {
    log::info!("[orphan-check] Killing orphan pid={} on :{}", pid, port);
    let out = Command::new("kill").args(["-9", &pid.to_string()]).output();
    match out {
        Ok(o) if o.status.success() => {
            log::info!("[orphan-check] kill -9 {} succeeded", pid);
        }
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr);
            log::warn!("[orphan-check] kill -9 {} non-zero: {}", pid, stderr.trim());
        }
        Err(e) => {
            log::warn!("[orphan-check] kill -9 {} failed to spawn: {}", pid, e);
            return false;
        }
    }

    // Poll the port for up to 3s. TcpListener::bind is the authoritative
    // signal because SO_REUSEADDR semantics on macOS mean a TIME_WAIT
    // socket still refuses new binds even after the process is gone.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while std::time::Instant::now() < deadline {
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
            log::info!("[orphan-check] Port :{} released after kill", port);
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    log::warn!(
        "[orphan-check] Port :{} still held 3s after killing pid={}; continuing",
        port, pid
    );
    false
}

// ── Child PID registry + probe-kill (issue #719) ──
//
// The Tauri parent spawns Node children (Next.js + ws-server) but doesn't
// own their lifecycle on quit. When the user Cmd-Q's, force-quits via
// osascript, or the parent panics, the children get reparented to launchd
// and survive — holding ports 3001/3002 indefinitely. The next launch then
// spawns a new Next on a different port (3003+), but the webview keeps
// hitting whatever served on 3001 — the old orphan with stale code.
//
// Fix is two layers:
//   1. On launch, force-kill anything bound to 3001 / 3002 BEFORE spawning.
//   2. On quit (RunEvent::Exit, panic, SIGTERM/SIGINT), TERM then KILL every
//      tracked child PID.
//
// `CHILD_PIDS` is a global registry written when each child is spawned and
// drained on every exit path. We use `OnceLock<Mutex<Vec<u32>>>` rather than
// a static `Mutex::new(...)` because const-init for `Mutex` is gated and
// `OnceLock` is the std-stable path.

fn child_pids() -> &'static Mutex<Vec<u32>> {
    static CHILD_PIDS: OnceLock<Mutex<Vec<u32>>> = OnceLock::new();
    CHILD_PIDS.get_or_init(|| Mutex::new(Vec::new()))
}

/// Track a freshly-spawned child so we can kill it on quit.
fn register_child(pid: u32) {
    if let Ok(mut guard) = child_pids().lock() {
        guard.push(pid);
    }
}

/// Probe-kill any process holding `port`. Used at launch — if a previous
/// install crashed and left an orphan Next/ws-server bound to 3001 or 3002,
/// or if the user is launching a second copy of o8 over a still-live first
/// copy, we kill the holder so the new sidecar can bind cleanly. Sends TERM
/// first, polls 200ms, escalates to KILL if the port is still held.
///
/// Safe because:
///   - A legit user-visible o8 instance that's still running means the user
///     is launching a SECOND copy → killing the first child cleanly is what
///     Finder does anyway.
///   - An orphan from a prior crash → exactly what we want to kill.
///   - A user-running `npm run desktop:dev` → the bundled-spawn path is
///     never reached (we defer to the dev server upstream of this).
fn probe_kill_port(port: u16) {
    // Cheap probe: if nothing answers, return early.
    if std::net::TcpStream::connect(format!("127.0.0.1:{}", port)).is_err() {
        return;
    }

    // lsof -ti :PORT returns one PID per line listening on the port. -sTCP:LISTEN
    // narrows to listeners (skips clients connected to the port).
    let pids = match Command::new("lsof")
        .args(["-ti", &format!(":{}", port), "-sTCP:LISTEN"])
        .output()
    {
        Ok(out) if out.status.success() => {
            let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
            raw.lines()
                .filter_map(|s| s.trim().parse::<u32>().ok())
                .collect::<Vec<_>>()
        }
        _ => Vec::new(),
    };

    if pids.is_empty() {
        log::warn!(
            "[probe-kill] :{} appears bound but lsof returned no PIDs — skipping",
            port
        );
        return;
    }

    log::info!("[probe-kill] :{} held by PIDs {:?} — killing", port, pids);
    for pid in &pids {
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status();
    }

    // Poll up to ~3s for the port to release (TIME_WAIT can hold even after
    // the process is gone). If a TERM didn't take, escalate to KILL.
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(3000);
    let mut escalated = false;
    while std::time::Instant::now() < deadline {
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
            log::info!("[probe-kill] :{} released", port);
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
        if !escalated && std::time::Instant::now() + std::time::Duration::from_millis(1000) < deadline {
            // After ~1s of TERM not working, send KILL alongside.
            for pid in &pids {
                let _ = Command::new("kill")
                    .args(["-KILL", &pid.to_string()])
                    .status();
            }
            escalated = true;
        }
    }
    log::warn!(
        "[probe-kill] :{} still held after 3s — sidecar will probe higher port",
        port
    );
}

/// TERM + (after 1s) KILL every tracked child PID. Idempotent — once a PID
/// is reaped, kill() with a stale PID is a harmless ESRCH. Drained on call
/// so a re-entry (panic during exit, repeat exit event) is a no-op.
fn kill_tracked_children() {
    let pids = match child_pids().lock() {
        Ok(mut guard) => std::mem::take(&mut *guard),
        Err(_) => return, // poisoned mutex — best-effort cleanup, skip
    };
    if pids.is_empty() {
        return;
    }
    log::info!("[shutdown] terminating {} tracked child PIDs: {:?}", pids.len(), pids);

    for pid in &pids {
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status();
    }

    // Give children a beat to flush + exit gracefully.
    std::thread::sleep(std::time::Duration::from_millis(1000));

    // Anything still alive gets KILL. `kill -0 <pid>` is the standard
    // "is this process alive" probe — exits 0 if alive, non-zero otherwise.
    for pid in &pids {
        let alive = Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if alive {
            log::info!("[shutdown] PID {} survived TERM — sending KILL", pid);
            let _ = Command::new("kill")
                .args(["-KILL", &pid.to_string()])
                .status();
        }
    }
}

// ── Boot-time orphan reaper (issue #776) ──
//
// `probe_kill_port(3001/3002)` from #719/#728 only clears specific ports.
// But orphans from prior crashes can squat on ANY port in our 3001-3050
// range — and once they're listening on, say, 3003, our new sidecar quietly
// picks 3004 and the user spends an hour debugging "why didn't my fix take
// effect" before realizing the webview is hitting the wrong server.
//
// This reaper runs ONCE at boot, BEFORE the Tauri builder is constructed,
// and:
//   1. Enumerates every `next-server` and `ws-server` process via `pgrep`.
//   2. Verifies o8 ownership via cwd substring + ppid==launchd (orphan
//      signature). Active processes parented to a live `npm run dev` or
//      another running sidecar are LEFT ALONE.
//   3. SIGTERM with 2s grace, then SIGKILL anything still alive.
//   4. Removes a stale `/tmp/tauri-mcp-o8-<user>.sock` if no live process
//      holds it — fixes the "Socket ... is in use" crash on relaunch when
//      the prior sidecar died without unbinding.
//
// We can't read other processes' env vars on macOS without root, so the
// `O8_SIDECAR_PID` marker we set on our own children (see setup()) is best-
// effort forward-compat — useful in `ps` output and on Linux/Windows where
// /proc/<pid>/environ is readable.

/// Fast PID enumeration via `pgrep -f <pattern>`. Returns Vec<u32> on success,
/// empty Vec if pgrep is missing or finds nothing (both are non-fatal).
#[cfg(unix)]
fn pgrep_pids(pattern: &str) -> Vec<u32> {
    let out = match Command::new("pgrep").args(["-f", pattern]).output() {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    // pgrep exits 1 when no match (stdout + stderr both empty) — not an error.
    // A real failure produces something on stderr (e.g. permission denied).
    if !out.status.success() && !out.stderr.is_empty() {
        log::warn!(
            "[orphan-reap] pgrep -f {:?} failed: {}",
            pattern,
            String::from_utf8_lossy(&out.stderr).trim()
        );
        return Vec::new();
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|s| s.trim().parse::<u32>().ok())
        .filter(|pid| *pid != std::process::id())
        .collect()
}

/// Best-effort cwd lookup via `lsof -p PID -a -d cwd -F n`. Returns the path
/// or empty string. macOS lsof is part of the base system; Linux ships it on
/// most distros. If lsof is missing we treat cwd as unknown and the candidate
/// is rejected by the ownership filter (safer than a false-positive kill).
#[cfg(unix)]
fn process_cwd(pid: u32) -> String {
    let out = match Command::new("lsof")
        .args(["-p", &pid.to_string(), "-a", "-d", "cwd", "-F", "n"])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return String::new(),
    };
    // lsof -F n format: each record line starts with a single-char field
    // marker; the cwd path is on a line starting with 'n'.
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find_map(|l| l.strip_prefix('n').map(|s| s.to_string()))
        .unwrap_or_default()
}

/// Parent PID via `ps -o ppid=`. Returns 0 on failure (treat as "unknown
/// parent" — unsafe to assume orphan, so caller skips).
#[cfg(unix)]
fn process_ppid(pid: u32) -> u32 {
    Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "ppid="])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .trim()
                .parse::<u32>()
                .ok()
        })
        .unwrap_or(0)
}

/// True if the cwd looks like an o8 install or checkout. We accept:
///   - Any path containing `cortex-ide` (dev checkouts, worktrees)
///   - Any path containing `.app/Contents/Resources/server` (installed app)
///   - Any path ending in `/.o8` or containing `/o8/` (rebrand-friendly)
///
/// We deliberately do NOT match the bare token "o8" anywhere — too broad
/// (matches user dirs like ~/projects/o8-experiment).
#[cfg(unix)]
fn cwd_looks_o8_owned(cwd: &str) -> bool {
    if cwd.is_empty() {
        return false;
    }
    cwd.contains("cortex-ide")
        || cwd.contains(".app/Contents/Resources/server")
        || cwd.contains("/.o8")
        || cwd.contains("/o8.app/")
}

/// Send SIGTERM, wait up to 2s for the process to exit, then SIGKILL if
/// still alive. `kill -0` is the standard "is this process alive" probe.
#[cfg(unix)]
fn term_then_kill(pid: u32) {
    let _ = Command::new("kill").args(["-TERM", &pid.to_string()]).status();
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(2000);
    while std::time::Instant::now() < deadline {
        let alive = Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !alive {
            log::info!("[orphan-reap] pid={} exited after TERM", pid);
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    log::warn!("[orphan-reap] pid={} did not exit after 2s — sending KILL", pid);
    let _ = Command::new("kill").args(["-KILL", &pid.to_string()]).status();
}

/// Clean a stale `/tmp/tauri-mcp-o8-<user>.sock` file. When the prior sidecar
/// crashed without unbinding, the socket file lingers and the next launch's
/// `tauri-plugin-mcp` plugin throws "Socket ... is in use by another instance".
///
/// We test "in-use" by attempting a Unix-domain stream connect to the socket.
/// If a process is actually listening, connect() succeeds → we leave it alone
/// (another live o8 instance owns it). If connect() fails with refused/no-such
/// the file is dead → safe to unlink.
#[cfg(unix)]
fn clean_stale_tauri_mcp_socket() {
    let user = std::env::var("USER").unwrap_or_else(|_| "default".into());
    let sock_path = format!("/tmp/tauri-mcp-o8-{}.sock", user);
    let path = std::path::Path::new(&sock_path);
    if !path.exists() {
        return;
    }
    // Best-effort liveness probe via UnixStream connect. A successful connect
    // means somebody is listening — leave the socket alone.
    use std::os::unix::net::UnixStream;
    match UnixStream::connect(&sock_path) {
        Ok(_) => {
            log::info!(
                "[orphan-reap] tauri-mcp socket at {} is live — leaving in place",
                sock_path
            );
        }
        Err(_) => {
            // Connect refused / no listener — socket file is dead.
            match std::fs::remove_file(&sock_path) {
                Ok(()) => log::info!("[orphan-reap] removed stale tauri-mcp socket {}", sock_path),
                Err(e) => log::warn!(
                    "[orphan-reap] could not remove stale tauri-mcp socket {}: {}",
                    sock_path, e
                ),
            }
        }
    }
}

/// Top-level orphan reaper. Called once from `pub fn run()` before the Tauri
/// builder is constructed. No-ops on non-unix platforms.
fn reap_o8_orphans() {
    #[cfg(unix)]
    {
        // Patterns chosen to catch every shape o8 spawns its node children as.
        // `next-server` is what Next.js renames the process title to after
        // boot. `ws-server.mjs` and `ws-server.ts` cover the bundled and dev
        // forms of our WebSocket multiplexer.
        let patterns: &[&str] = &["next-server", "ws-server.mjs", "ws-server.ts"];
        let mut candidates: Vec<u32> = Vec::new();
        for p in patterns {
            for pid in pgrep_pids(p) {
                if !candidates.contains(&pid) {
                    candidates.push(pid);
                }
            }
        }

        if candidates.is_empty() {
            log::info!("[orphan-reap] no candidate next/ws-server processes found");
        } else {
            log::info!("[orphan-reap] candidates: {:?}", candidates);
        }

        for pid in candidates {
            let ppid = process_ppid(pid);
            let cwd = process_cwd(pid);

            // Ownership filter — must look like an o8 install/checkout. This
            // is the catastrophic-false-positive guard.
            if !cwd_looks_o8_owned(&cwd) {
                log::info!(
                    "[orphan-reap] pid={} cwd={:?} not o8-owned — skipping",
                    pid, cwd
                );
                continue;
            }

            // Orphan signal: parent reparented to launchd (pid 1). If the
            // parent is still alive (a running terminal `npm run dev` or
            // another live o8 sidecar), we leave it alone — the user is
            // actively using it.
            if ppid != 1 {
                log::info!(
                    "[orphan-reap] pid={} ppid={} is actively parented (cwd={:?}) — skipping",
                    pid, ppid, cwd
                );
                continue;
            }

            log::info!(
                "[orphan-reap] reaping orphan pid={} ppid=1 cwd={:?}",
                pid, cwd
            );
            term_then_kill(pid);
        }

        clean_stale_tauri_mcp_socket();
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
    let node_bin = resolve_node_via_login_shell().ok_or(NodePreflightError::Missing)?;
    let (major, raw) = check_node_version(&node_bin).ok_or(NodePreflightError::Missing)?;
    if major < MIN_NODE_MAJOR {
        return Err(NodePreflightError::TooOld { raw });
    }
    log::info!("Node.js pre-flight OK: {} ({})", raw, node_bin);
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

/// JS injected into every page load on the main window. Wires three error
/// sources back into the Rust ring buffer via `__TAURI_INTERNALS__.invoke`:
///   1. `window.onerror` (synchronous runtime errors, parser errors)
///   2. `unhandledrejection` (async rejections without a `.catch`)
///   3. `console.error` (monkey-patched — original is preserved + still
///      forwarded to devtools so log output is unchanged)
///
/// Each handler stringifies its inputs into a single `message`, derives a
/// `source` (script URL where applicable, otherwise the source label), and
/// fires a fire-and-forget invoke. Failures swallow silently — we never
/// want the error hook itself to log noise that triggers more invokes.
const CONSOLE_ERROR_HOOK_JS: &str = r#"
(function () {
  if (typeof window === 'undefined' || window.__o8ConsoleErrorHookInstalled) return;
  window.__o8ConsoleErrorHookInstalled = true;

  function safeInvoke(message, source, lineno) {
    try {
      if (
        typeof window === 'undefined'
        || !window.__TAURI_INTERNALS__
        || typeof window.__TAURI_INTERNALS__.invoke !== 'function'
      ) {
        return;
      }
      var payload = {
        message: String(message == null ? '' : message).slice(0, 4000),
        source: String(source == null ? '' : source).slice(0, 1000),
        lineno: typeof lineno === 'number' && isFinite(lineno) ? Math.floor(lineno) : 0,
      };
      var p = window.__TAURI_INTERNALS__.invoke('record_console_error', payload);
      if (p && typeof p.then === 'function') p.catch(function () {});
    } catch (e) { /* swallow */ }
  }

  function stringifyArg(value) {
    if (value == null) return String(value);
    if (typeof value === 'string') return value;
    if (value instanceof Error) {
      return value.stack ? value.stack : (value.message || String(value));
    }
    try { return JSON.stringify(value); }
    catch (e) { try { return String(value); } catch (_) { return '[unserializable]'; } }
  }

  var originalConsoleError = console.error;
  console.error = function () {
    try {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) parts.push(stringifyArg(arguments[i]));
      safeInvoke(parts.join(' '), 'console.error', 0);
    } catch (e) { /* swallow */ }
    try {
      return originalConsoleError.apply(console, arguments);
    } catch (e) {
      // If the original throws (extremely unusual), fall back to noop so we
      // don't spiral. We've already captured the error above.
    }
  };

  window.addEventListener('error', function (event) {
    try {
      var msg = event && (event.message || (event.error && (event.error.stack || event.error.message)));
      var src = event && (event.filename || (event.target && (event.target.src || event.target.href)));
      var line = event && typeof event.lineno === 'number' ? event.lineno : 0;
      safeInvoke(msg, src, line);
    } catch (e) { /* swallow */ }
  }, true);

  window.addEventListener('unhandledrejection', function (event) {
    try {
      var reason = event && event.reason;
      var msg;
      if (reason instanceof Error) {
        msg = reason.stack || reason.message || String(reason);
      } else {
        try { msg = JSON.stringify(reason); }
        catch (_) { msg = String(reason); }
      }
      safeInvoke(msg, 'unhandledrejection', 0);
    } catch (e) { /* swallow */ }
  });
})();
"#;

/// Tauri command invoked by the injected JS hook. Pushes one error onto the
/// ring buffer, evicting the oldest entry when capacity is reached, and
/// bumps the per-fetch counter that `o8_view_console_errors` resets on read.
#[tauri::command]
fn record_console_error(message: String, source: String, lineno: u32) {
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

// ── Tray badge + native weapons (issues #730, #731) ──
//
// Three native macOS features that differentiate o8 from web/Electron rivals:
//
//   1. Cmd+Shift+O global shortcut → spawns a 600x80 always-on-top dispatch
//      popover. Wired via tauri-plugin-global-shortcut.
//
//   2. Native notifications when a packet flips to `awaiting_review`. Fired
//      from the frontend (which already holds the WS lane stream) via the
//      `notify_review_ready` Tauri command. The macOS notification plugin
//      doesn't expose action buttons natively (notify-rust limitation), so
//      clicking the notification raises the app focused on the review card —
//      "Approve / Reject" stay as in-app affordances for v1.
//
//   3. Menu bar tray with live "[N]" badge for pending reviews. The tray
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

/// Count lanes whose status is `reviewing` (the user-facing "awaiting review"
/// state). Falls back to 0 on any parse / network error — the badge just
/// shows nothing rather than a stale value.
fn count_awaiting_review() -> u32 {
    let Some(body) = http_get_local("/api/lanes?active=true") else { return 0 };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) else { return 0 };
    let Some(lanes) = json.get("lanes").and_then(|v| v.as_array()) else { return 0 };
    lanes
        .iter()
        .filter(|lane| {
            lane.get("status")
                .and_then(|s| s.as_str())
                .map(|s| s == "reviewing")
                .unwrap_or(false)
        })
        .count() as u32
}

/// Spawn a long-lived background thread that polls the lanes API every 5s
/// and pushes the awaiting-review count to the tray badge. Light enough to
/// run continuously — one tiny HTTP request, no JSON deserialization beyond
/// pulling out a status string per lane.
fn spawn_tray_badge_poller(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_count: u32 = u32::MAX; // force first emit
        loop {
            let count = count_awaiting_review();
            if count != last_count {
                apply_tray_badge(count);
                // Mirror to the frontend so any UI badge can stay synced
                // without doing its own poll.
                let _ = app.emit("tray-badge-changed", count);
                last_count = count;
            }
            std::thread::sleep(std::time::Duration::from_secs(5));
        }
    });
}

// ── Cmd+Shift+O dispatch popover ──
//
// The popover is a secondary window labelled "dispatch-popover" loaded from
// /dispatch-popover (a Next.js route that renders DispatchPopover.tsx). We
// destroy it on Esc / submit so each invocation is a fresh window — simpler
// than juggling visibility state across the global-shortcut callback and the
// frontend.

const POPOVER_LABEL: &str = "dispatch-popover";
const POPOVER_WIDTH: f64 = 600.0;
const POPOVER_HEIGHT: f64 = 280.0;
const POPOVER_STATE_FILE: &str = "popover-state.json";

/// Read the saved popover position from `~/.o8/popover-state.json`.
/// Returns None when the file is missing, malformed, or contains values that
/// don't fit on any plausible screen — in which case the open path falls back
/// to the Spotlight-style top-center anchor.
fn read_saved_popover_position() -> Option<(f64, f64)> {
    let path = std::path::PathBuf::from(o8_data_dir()).join(POPOVER_STATE_FILE);
    let raw = std::fs::read_to_string(&path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let x = json.get("x")?.as_f64()?;
    let y = json.get("y")?.as_f64()?;
    // Reject obviously broken values — multi-monitor reconfigs sometimes save
    // off-screen coordinates we can't recover from. Same defensive bounds as
    // sanitize_window_state(), just looser.
    if !x.is_finite() || !y.is_finite() { return None; }
    if x < -10000.0 || x > 20000.0 || y < -10000.0 || y > 10000.0 { return None; }
    Some((x, y))
}

/// Persist the popover position to `~/.o8/popover-state.json`. Called from
/// the frontend after a drag finishes (via `save_dispatch_popover_position`).
/// Best-effort: any IO error is logged and swallowed so the popover never
/// becomes unusable just because a write failed.
fn write_saved_popover_position(x: f64, y: f64) {
    let dir = o8_data_dir();
    if let Err(e) = std::fs::create_dir_all(&dir) {
        log::warn!("[popover] mkdir {} failed: {}", dir, e);
        return;
    }
    let path = std::path::PathBuf::from(&dir).join(POPOVER_STATE_FILE);
    let payload = serde_json::json!({ "x": x, "y": y });
    if let Err(e) = std::fs::write(&path, payload.to_string()) {
        log::warn!("[popover] write {:?} failed: {}", path, e);
    }
}

/// Open (or focus, if already open) the dispatch popover. Spotlight-style on
/// first launch: horizontally centered, anchored at 25% from the top of the
/// active monitor. Subsequent opens honor a position the user dragged the
/// popover to (persisted to `~/.o8/popover-state.json`). Always-on-top, no
/// decorations, frameless. Built on the dev URL when running `cargo tauri
/// dev`, otherwise the bundled `tauri://localhost` scheme. Returns Ok(()) on
/// success.
fn open_dispatch_popover_impl(app: &AppHandle) -> Result<(), String> {
    // Compute Spotlight-style position on the primary monitor: horizontally
    // centered, 25% from the top. Falls back to .center() if monitor info is
    // unavailable (rare — headless / detached display races).
    //
    // Tauri v2: monitor.size() is physical pixels, popover dims are logical.
    // .position(x, y) takes physical pixels, so we scale logical → physical.
    let spotlight_position: Option<(f64, f64)> = match app.primary_monitor() {
        Ok(Some(monitor)) => {
            let scale = monitor.scale_factor();
            let monitor_w = monitor.size().width as f64;
            let monitor_h = monitor.size().height as f64;
            let popover_w_phys = POPOVER_WIDTH * scale;
            let x = (monitor_w - popover_w_phys) / 2.0;
            let y = monitor_h * 0.25;
            Some((x.max(0.0), y.max(0.0)))
        }
        _ => None,
    };

    // Saved drag position wins over the Spotlight default — this is what
    // makes the popover "remember where I put it" across summons.
    let preferred_position = read_saved_popover_position().or(spotlight_position);

    if let Some(existing) = app.get_webview_window(POPOVER_LABEL) {
        let _ = existing.show();
        let _ = existing.set_focus();
        if let Some((x, y)) = preferred_position {
            let _ = existing.set_position(tauri::PhysicalPosition::new(x, y));
        } else {
            let _ = existing.center();
        }
        return Ok(());
    }

    // /dispatch-popover route. In dev (cargo tauri dev) we hit the Next dev
    // server directly; in prod we use tauri://localhost which serves the
    // static build out of out/frontend/.
    let url = if cfg!(debug_assertions) {
        let port = resolve_api_port();
        let raw = format!("http://localhost:{}/dispatch-popover", port);
        let parsed: tauri::Url = raw.parse().map_err(|e| format!("popover url parse: {}", e))?;
        WebviewUrl::External(parsed)
    } else {
        WebviewUrl::App("dispatch-popover".into())
    };

    let mut builder = WebviewWindowBuilder::new(app, POPOVER_LABEL, url)
        .title("Dispatch")
        .inner_size(POPOVER_WIDTH, POPOVER_HEIGHT)
        .resizable(false)
        .always_on_top(true)
        .decorations(false)
        .transparent(true)
        .focused(true)
        .visible(true)
        .skip_taskbar(true);

    builder = if let Some((x, y)) = preferred_position {
        builder.position(x, y)
    } else {
        builder.center()
    };

    // visible_on_all_workspaces is critical for a global shortcut —
    // otherwise the popover only shows on the workspace that owns the main
    // window, defeating the "from anywhere" promise.
    builder = builder.visible_on_all_workspaces(true);

    builder.build().map_err(|e| e.to_string())?;
    Ok(())
}

/// Tauri command: open the popover. Called from frontend (e.g. a NavRail
/// button) as well as from the global shortcut callback.
#[tauri::command]
fn open_dispatch_popover(app: AppHandle) -> Result<(), String> {
    open_dispatch_popover_impl(&app)
}

/// Tauri command: close the popover. Called from the popover frontend on
/// Esc / submit / blur.
#[tauri::command]
fn close_dispatch_popover(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(POPOVER_LABEL) {
        let _ = window.close();
    }
    Ok(())
}

/// Tauri command: persist the dispatch popover's last-known physical
/// position. The popover frontend calls this after a drag finishes (mouseup
/// on the header) so the next Cmd+Shift+O opens at the same spot. Coordinates
/// are physical pixels relative to the primary monitor.
#[tauri::command]
fn save_dispatch_popover_position(x: f64, y: f64) {
    write_saved_popover_position(x, y);
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    sanitize_window_state();

    // ── Shutdown safety net (issue #719) ──
    // Install panic + Unix-signal handlers BEFORE building Tauri so any
    // crash, SIGTERM, or SIGINT during startup still tears down children.
    // The normal Cmd-Q / app.exit() / CloseRequested paths are handled in
    // the RunEvent callback below; this is the belt-and-suspenders layer
    // for ungraceful exits.
    install_shutdown_handlers();

    // ── Boot-time orphan reaper (issue #776) ──
    // Reap stale `next-server` / `ws-server` processes from prior crashes
    // (reparented to launchd) and remove a stale `/tmp/tauri-mcp-o8-<user>.sock`
    // BEFORE the Tauri builder is constructed — the `tauri-plugin-mcp` plugin
    // binds the socket during builder setup and throws if the file lingers.
    // Wider net than `probe_kill_port` from #719: hits orphans on any port,
    // not just 3001/3002.
    reap_o8_orphans();

    // Cmd+Shift+O on macOS, Ctrl+Shift+O elsewhere. The global-shortcut
    // plugin uses the same `Modifiers::SUPER` token for both Cmd (mac) and
    // the Windows key — close enough for v1; we expose this constant so the
    // handler and the registration match.
    let dispatch_shortcut = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyO);

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
        // Auto-saves window size + position to the OS data dir on close and
        // restores them on next launch. The dispatch-popover is excluded —
        // it's transient (Cmd+Shift+O summons + closes per use) and we don't
        // want its 600x80 dimensions or position bleeding into anything.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_filter(|label| label != POPOVER_LABEL)
                .skip_initial_state(POPOVER_LABEL)
                .build(),
        )
        // Cmd+Shift+O global shortcut (issue #730). Registered on `setup()`
        // below so the AppHandle is available; the handler routes back into
        // `open_dispatch_popover_impl()`.
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    if shortcut == &dispatch_shortcut {
                        if let Err(err) = open_dispatch_popover_impl(app) {
                            log::warn!("[global-shortcut] open dispatch popover failed: {}", err);
                        }
                    }
                })
                .build(),
        );

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
                .socket_path(socket_path.into()),
        ));
    }

    builder
        // Inject the console-error capture hook on every main-window page
        // load (issue #793). Other windows (dispatch popover, etc.) skip
        // injection — we only care about errors in the main app shell.
        // PageLoadEvent fires twice per navigation (Started + Finished); we
        // inject on Started so the hook is in place before any user JS runs.
        .on_page_load(|webview, payload| {
            if webview.label() != "main" {
                return;
            }
            if payload.event() != tauri::webview::PageLoadEvent::Started {
                return;
            }
            if let Err(err) = webview.eval(CONSOLE_ERROR_HOOK_JS) {
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
            open_dispatch_popover,
            close_dispatch_popover,
            save_dispatch_popover_position,
            set_tray_badge,
            notify_review_ready,
            record_console_error,
            o8_view_console_errors,
            o8_view_active_route,
            #[cfg(target_os = "macos")]
            master_key_get,
            #[cfg(target_os = "macos")]
            master_key_ensure,
        ])
        .setup(move |app| {
            // ── System Tray (issue #731) ──
            // Menu items: Show / Open Dispatch (Cmd+Shift+O) / Quit. The
            // separator + "Open Dispatch" entry surfaces the global-shortcut
            // feature so users discover it without reading docs.
            let show = MenuItem::with_id(app, "show", "Show o8", true, None::<&str>)?;
            let dispatch = MenuItem::with_id(app, "dispatch", "Quick Dispatch", true, Some("CmdOrCtrl+Shift+O"))?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quit o8", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &dispatch, &separator, &quit])?;

            let tray = TrayIconBuilder::new()
                .menu(&menu)
                // Show menu on left-click (default is right-click only on
                // macOS) so the count-aware list is one click away.
                .show_menu_on_left_click(false)
                .tooltip("o8")
                .on_menu_event(|app, event| {
                    match event.id.as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "dispatch" => {
                            if let Err(err) = open_dispatch_popover_impl(app) {
                                log::warn!("[tray] dispatch menu failed: {}", err);
                            }
                        }
                        "quit" => {
                            app.exit(0);
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

            // ── Cmd+Shift+O global shortcut registration (issue #730) ──
            // The handler is wired in the plugin Builder above; we just need
            // to register the binding. macOS shows the accessibility prompt
            // automatically on first registration; if the user denies, we
            // log + carry on rather than blocking startup.
            if let Err(err) = app.global_shortcut().register(dispatch_shortcut) {
                log::warn!(
                    "[global-shortcut] could not register Cmd+Shift+O: {} \
                     (user may need to grant Accessibility permission)",
                    err
                );
            } else {
                log::info!("[global-shortcut] Cmd+Shift+O registered");
            }

            // ── Badge poller (issue #731) ──
            // 5s tick keeps the tray title in sync with awaiting_review
            // count without waiting on a frontend WS subscription. Cheap
            // — one HTTP GET per tick, hits the same server as the panel.
            spawn_tray_badge_poller(app.handle().clone());

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
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        // Hide instead of close — agents keep working
                        api.prevent_close();
                        if let Some(w) = app_handle.get_webview_window("main") {
                            let _ = w.hide();
                        }
                        let _ = app_handle.emit("window-hidden", ());
                    }
                });
            }

            // ── Start bundled Next.js server ──
            let resource_dir = app.path().resource_dir().expect("failed to resolve resource dir");
            let server_dir = resource_dir.join("server");
            let server_js = server_dir.join("server.js");

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
            let dev_server_running = match classify_port_listener(3001) {
                PortListener::Free => false,
                PortListener::Legit { pid, command } => {
                    log::info!(
                        "[orphan-check] :3001 looks legitimate (pid={}, cmd={:?}) — deferring",
                        pid, command
                    );
                    true
                }
                PortListener::Orphan { pid, command } => {
                    log::info!(
                        "[orphan-check] :3001 owned by ORPHAN pid={} cmd={:?} — killing",
                        pid, command
                    );
                    kill_orphan_and_wait(pid, 3001);
                    // Re-probe in case another legit process grabbed the port
                    // between kill and this check. Unlikely but cheap.
                    std::net::TcpStream::connect("127.0.0.1:3001").is_ok()
                }
            };

            // Default ports that survived from the legacy 3001/3002 era. If
            // nothing is on them and the bundled server is about to start,
            // these become the actual bindings. If they're taken, we probe
            // upward from the Rust side.
            let mut api_port: u16 = 3001;
            let mut ws_port: u16 = 3002;

            if dev_server_running {
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

                // ── Probe-kill orphans on default ports (issue #719) ──
                // If a previous install crashed or was killed in a way that
                // left its Node children reparented to launchd, they're
                // still serving on 3001/3002 right now. The naive
                // find_free_port() below would step around them and pick
                // 3003+ — but the webview keeps loading from 3001 and gets
                // the stale orphan. Force-clear the default ports first so
                // the new sidecar binds them cleanly.
                probe_kill_port(3001);
                probe_kill_port(3002);

                // ── Port allocation ──
                // Probe for free ports starting at the legacy defaults. If the
                // user has something else on 3001/3002 (another o8 instance, a
                // Next dev server, a random service), fall through to 3003+.
                api_port = find_free_port(API_PORT_RANGE, None).unwrap_or(3001);
                ws_port = find_free_port(WS_PORT_RANGE, Some(api_port)).unwrap_or(3002);
                log::info!("Allocated ports: api={} ws={}", api_port, ws_port);
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
                match server_cmd
                    .stdout(child_stdio(next_log.as_ref()))
                    .stderr(child_stdio(next_log.as_ref()))
                    .spawn()
                {
                    Ok(child) => {
                        let pid = child.id();
                        log::info!("Next.js server started (pid: {})", pid);
                        register_child(pid);
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
                let ws_server_js = server_dir.join("ws-server.mjs");
                if ws_server_js.exists() {
                    log::info!("Starting WS server: {} {:?} on :{}", node_bin, ws_server_js, ws_port);
                    match Command::new(&node_bin)
                        .arg(&ws_server_js)
                        .current_dir(&server_dir)
                        .env("O8_NODE_BIN", &node_bin)
                        .env("WS_PORT", ws_port.to_string())
                        .env("NEXT_ORIGIN", format!("http://127.0.0.1:{}", api_port))
                        // Issue #776: same sidecar marker as the next-server child.
                        .env("O8_SIDECAR_PID", std::process::id().to_string())
                        .stdout(child_stdio(ws_log.as_ref()))
                        .stderr(child_stdio(ws_log.as_ref()))
                        .spawn()
                    {
                        Ok(child) => {
                            let pid = child.id();
                            log::info!("WS server started (pid: {})", pid);
                            register_child(pid);
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
        .build(tauri::generate_context!())
        .expect("error while building Cortex IDE")
        .run(|_app_handle, event| match event {
            // ExitRequested fires on Cmd-Q, app.exit(), tray Quit menu, etc.
            // We tear down children here so they don't outlive the parent.
            // Children also see a TERM via the OS process group on graceful
            // exits, but the explicit kill is what catches detached/launchd
            // reparenting.
            RunEvent::ExitRequested { .. } => {
                kill_tracked_children();
            }
            // Final event before the loop terminates. Idempotent with the
            // ExitRequested handler — kill_tracked_children() drains the
            // registry on first call.
            RunEvent::Exit => {
                kill_tracked_children();
            }
            _ => {}
        });
}

// ── Shutdown handler installation ──
//
// Called once from `run()` before the Tauri builder is constructed. Installs
// three layers that all converge on `kill_tracked_children()`:
//   1. Panic hook  — preserves any prior hook (e.g. tauri-plugin-log) and
//      runs cleanup AFTER the original. Catches startup panics.
//   2. SIGTERM/SIGINT (Unix) — `signal-hook` registers a clean handler that
//      runs in a dedicated thread; we kill children then re-raise the
//      default disposition so the process actually exits.
//   3. Tauri RunEvent::Exit — wired in `run()` itself, the normal path.
fn install_shutdown_handlers() {
    // Panic hook: chain after the existing hook so default backtraces still
    // print, then drain children so they don't outlive a panicking parent.
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        prev(info);
        kill_tracked_children();
    }));

    // Unix-only signal handler. signal-hook is already in our transitive
    // dep graph; promoting it to a direct dep adds zero binary cost.
    #[cfg(unix)]
    {
        use signal_hook::consts::{SIGINT, SIGTERM};
        use signal_hook::iterator::Signals;
        match Signals::new([SIGTERM, SIGINT]) {
            Ok(mut signals) => {
                std::thread::spawn(move || {
                    if let Some(sig) = signals.forever().next() {
                        log::info!("[shutdown] received signal {} — killing children", sig);
                        kill_tracked_children();
                        // Re-raise the default disposition so the process
                        // actually exits with the signal's exit code. Using
                        // exit() here would lose the signal-vs-clean-exit
                        // distinction; raise() puts us back on the standard
                        // "killed by signal N" path.
                        unsafe {
                            libc::signal(sig, libc::SIG_DFL);
                            libc::raise(sig);
                        }
                    }
                });
            }
            Err(e) => {
                log::warn!("[shutdown] could not install signal handler: {}", e);
            }
        }
    }
}
