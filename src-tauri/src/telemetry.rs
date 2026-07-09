//! Sentry crash/error reporting for the native (Rust) shell — panics + native
//! crashes, tagged with the app version + plan + a founder boolean.
//!
//! DORMANT unless this is a RELEASE build that had a DSN baked in (build.rs sets
//! `O8_SENTRY_DSN` via `cargo:rustc-env`, RELEASE profile only) — dev / `tauri
//! dev` (debug) stay silent regardless. `environment` is always "production"
//! because we never reach here in debug.
//!
//! Privacy is brand (telemetry ruling): `before_send` collapses `/Users/<user>`
//! + `/home/<user>` home paths to an ellipsis and drops the machine name;
//! `send_default_pii` is false so no username/IP is attached. The live "Crash &
//! error reports" toggle is re-read every 30s (and checked in `before_send`), so
//! turning it OFF stops the wire within the budget without dropping the client.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crate::entitlement;

/// Live mirror of the operator toggle — refreshed by the 30s watcher and read in
/// `before_send`. Defaults ON (matches the operator-defaults fallback).
static CRASH_REPORTS_ENABLED: AtomicBool = AtomicBool::new(true);

/// Canonical o8 data dir (`~/.o8`, overridable). Kept local so this module stays
/// dependency-free, mirroring `entitlement::o8_data_dir`.
fn o8_data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("O8_DATA_DIR") {
        return PathBuf::from(dir);
    }
    if let Ok(dir) = std::env::var("CORTEX_IDE_DATA_DIR") {
        return PathBuf::from(dir);
    }
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".o8")
}

/// Read the "Crash & error reports" toggle from `~/.o8/operator-defaults.json`
/// (`crashReportsEnabled`). Default ON when the file/key is absent. Never panics.
fn read_toggle() -> bool {
    let path = o8_data_dir().join("operator-defaults.json");
    let Ok(raw) = std::fs::read_to_string(path) else {
        return true;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return true;
    };
    match value.get("crashReportsEnabled") {
        Some(serde_json::Value::Bool(b)) => *b,
        _ => true,
    }
}

/// The baked DSN (runtime env wins, else the compile-time bake), or None. Empty
/// is treated as absent. `None` in a debug build (build.rs bakes release-only).
fn resolve_dsn() -> Option<String> {
    if let Ok(dsn) = std::env::var("O8_SENTRY_DSN") {
        if !dsn.trim().is_empty() {
            return Some(dsn);
        }
    }
    match option_env!("O8_SENTRY_DSN") {
        Some(dsn) if !dsn.trim().is_empty() => Some(dsn.to_string()),
        _ => None,
    }
}

/// Collapse `/Users/<user>` and `/home/<user>` home prefixes to `/Users/…` /
/// `/home/…`, keeping the trailing path so a stack stays debuggable. The
/// username is the PII. Pure; operates on char boundaries.
pub fn scrub_paths(input: &str) -> String {
    scrub_prefix(&scrub_prefix(input, "/Users/"), "/home/")
}

fn scrub_prefix(input: &str, prefix: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(idx) = rest.find(prefix) {
        out.push_str(&rest[..idx]);
        out.push_str(prefix);
        out.push('…');
        let after = &rest[idx + prefix.len()..];
        // Drop the identity-bearing username segment up to the next path
        // separator / terminator; keep everything after it.
        let end = after
            .find(|c: char| {
                c == '/' || c.is_whitespace() || c == '"' || c == '\'' || c == ':' || c == ')'
            })
            .unwrap_or(after.len());
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

/// Make the baked DSN visible to child processes (the Next server + ws-server
/// inherit the parent env), so all layers share one source. RELEASE-only; a
/// real runtime `O8_SENTRY_DSN` (e.g. from the wrapper bake) already set wins.
pub fn export_dsn_to_env() {
    if cfg!(debug_assertions) {
        return;
    }
    if std::env::var("O8_SENTRY_DSN")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .is_some()
    {
        return;
    }
    if let Some(dsn) = option_env!("O8_SENTRY_DSN") {
        if !dsn.trim().is_empty() {
            std::env::set_var("O8_SENTRY_DSN", dsn);
        }
    }
}

/// Initialize Sentry for the native shell. Returns the guard (hold it for the
/// program's lifetime so panics flush on exit) or None when dormant. Never
/// panics.
pub fn init() -> Option<sentry::ClientInitGuard> {
    // Dev / `tauri dev` stay silent.
    if cfg!(debug_assertions) {
        return None;
    }
    let dsn = resolve_dsn()?;

    CRASH_REPORTS_ENABLED.store(read_toggle(), Ordering::Relaxed);

    let guard = sentry::init((
        dsn,
        sentry::ClientOptions {
            release: Some(env!("CARGO_PKG_VERSION").into()),
            environment: Some("production".into()),
            send_default_pii: false,
            // Errors only — no performance/tracing.
            traces_sample_rate: 0.0,
            // Never attach the machine name.
            server_name: None,
            before_send: Some(Arc::new(|mut event| {
                // Live kill-switch: OFF → drop every event (no wire).
                if !CRASH_REPORTS_ENABLED.load(Ordering::Relaxed) {
                    return None;
                }
                event.server_name = None;
                if let Some(msg) = event.message.take() {
                    event.message = Some(scrub_paths(&msg));
                }
                for exception in event.exception.values.iter_mut() {
                    if let Some(value) = exception.value.take() {
                        exception.value = Some(scrub_paths(&value));
                    }
                }
                Some(event)
            })),
            ..Default::default()
        },
    ));

    sentry::configure_scope(|scope| {
        scope.set_tag("app_version", env!("CARGO_PKG_VERSION"));
        scope.set_tag(
            "plan",
            entitlement::read_plan().unwrap_or_else(|| "free".to_string()),
        );
        // Boolean only — never the operator number.
        scope.set_tag("founder", entitlement::is_founder());
        scope.set_tag("surface", "rust");
    });

    // Live-toggle watcher: OFF is respected within ~30s across layers.
    let _ = std::thread::Builder::new()
        .name("o8-sentry-toggle".to_string())
        .spawn(|| loop {
            std::thread::sleep(Duration::from_secs(30));
            CRASH_REPORTS_ENABLED.store(read_toggle(), Ordering::Relaxed);
        });

    Some(guard)
}

#[cfg(test)]
mod tests {
    use super::scrub_paths;

    #[test]
    fn collapses_macos_home_username_keeps_path() {
        assert_eq!(
            scrub_paths("/Users/marquisehurtt/o8/src/x.rs"),
            "/Users/…/o8/src/x.rs"
        );
    }

    #[test]
    fn collapses_linux_home() {
        assert_eq!(
            scrub_paths("panicked at /home/deploy/app/main.rs:12"),
            "panicked at /home/…/app/main.rs:12"
        );
    }

    #[test]
    fn scrubs_multiple_occurrences() {
        assert_eq!(
            scrub_paths("/Users/quise/a.rs and /Users/quise/b.rs"),
            "/Users/…/a.rs and /Users/…/b.rs"
        );
    }

    #[test]
    fn username_at_end_of_string() {
        assert_eq!(scrub_paths("home is /Users/quise"), "home is /Users/…");
    }

    #[test]
    fn leaves_non_home_paths_untouched() {
        assert_eq!(scrub_paths("/var/log/o8.log"), "/var/log/o8.log");
    }
}
