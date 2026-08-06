//! Windows CLI shim install + PATH registration (#1741, part of #1673).
//!
//! Mirrors the macOS `ensure_cli_on_path` symlink flow in `lib.rs`, but
//! Windows has neither a symlink model usable without elevation nor a PATH
//! separator/lookup model that matches POSIX, so the approach differs:
//!   - Copy the bundled `o8.cmd` / `o8.ps1` / `o8.mjs` into a stable,
//!     user-writable directory (`%USERPROFILE%\.o8\bin`, matching the same
//!     `.o8` data-dir convention the rest of the app already uses).
//!   - Append that directory to `HKCU\Environment\Path` (no admin required).
//!   - Broadcast `WM_SETTINGCHANGE` so already-running shells notice.
//!
//! The PATH string manipulation below is pure and platform-independent on
//! purpose — it is unit-tested on every host OS via `cargo test --lib`, even
//! though the registry-touching caller only compiles/runs on Windows.

/// Returns `Some(new_path_value)` if `dir` needs to be appended to
/// `existing_path`, or `None` if an equivalent entry is already present.
/// Windows PATH entries are compared case-insensitively and ignoring a
/// trailing separator, matching how `cmd.exe`/PowerShell resolve PATH.
///
/// Only called from the `cfg(target_os = "windows")` impl below, so a
/// non-Windows build (macOS/Linux) sees no caller outside `#[cfg(test)]` —
/// `#[allow(dead_code)]` keeps that combination warning-free.
#[allow(dead_code)]
pub(crate) fn append_path_entry(existing_path: &str, dir: &str) -> Option<String> {
    let dir = dir.trim().trim_end_matches('\\');
    let already_present = existing_path
        .split(';')
        .map(|entry| entry.trim().trim_end_matches('\\'))
        .any(|entry| !entry.is_empty() && entry.eq_ignore_ascii_case(dir));
    if already_present {
        return None;
    }
    Some(if existing_path.trim().is_empty() {
        dir.to_string()
    } else if existing_path.trim_end().ends_with(';') {
        format!("{existing_path}{dir}")
    } else {
        format!("{existing_path};{dir}")
    })
}

/// Removes every entry matching `dir` (same comparison rule as
/// `append_path_entry`) from `existing_path`. Intended for the uninstall
/// cleanup path (see `remove_cli_from_path` below) so a removed app never
/// leaves a dangling PATH entry behind.
#[allow(dead_code)]
pub(crate) fn remove_path_entry(existing_path: &str, dir: &str) -> String {
    let dir = dir.trim().trim_end_matches('\\');
    let kept: Vec<&str> = existing_path
        .split(';')
        .filter(|entry| {
            let trimmed = entry.trim().trim_end_matches('\\');
            !trimmed.is_empty() && !trimmed.eq_ignore_ascii_case(dir)
        })
        .collect();
    kept.join(";")
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::{append_path_entry, remove_path_entry};
    use std::path::{Path, PathBuf};

    fn user_home() -> Option<PathBuf> {
        std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(PathBuf::from)
    }

    fn cli_bin_dir() -> Option<PathBuf> {
        user_home().map(|home| home.join(".o8").join("bin"))
    }

    /// Broadcast WM_SETTINGCHANGE("Environment") so already-running processes
    /// (Explorer, open shells) re-read the environment block without a login
    /// or reboot. Best-effort — a failure here just means the user has to
    /// open a fresh session, which is the pre-existing Windows behavior for
    /// any registry-only PATH edit.
    fn broadcast_environment_change() {
        use windows_sys::Win32::Foundation::{HWND, LPARAM, WPARAM};
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
        };

        let param: Vec<u16> = "Environment\0".encode_utf16().collect();
        let mut result: usize = 0;
        unsafe {
            SendMessageTimeoutW(
                HWND_BROADCAST as HWND,
                WM_SETTINGCHANGE,
                0 as WPARAM,
                param.as_ptr() as LPARAM,
                SMTO_ABORTIFHUNG,
                5000,
                &mut result as *mut usize,
            );
        }
    }

    fn read_user_path() -> std::io::Result<String> {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let env = hkcu.open_subkey("Environment")?;
        Ok(env.get_value::<String, _>("Path").unwrap_or_default())
    }

    fn write_user_path(value: &str) -> std::io::Result<()> {
        use winreg::enums::{HKEY_CURRENT_USER, KEY_WRITE, REG_EXPAND_SZ};
        use winreg::{RegKey, RegValue};
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (env, _) = hkcu.create_subkey_with_flags("Environment", KEY_WRITE)?;

        // REG_EXPAND_SZ/REG_SZ are both null-terminated UTF-16LE on Windows —
        // build the bytes by hand instead of relying on winreg's default
        // String conversion (which writes REG_SZ, not REG_EXPAND_SZ, and the
        // real Windows Path value is REG_EXPAND_SZ so it keeps expanding
        // other vendors' %VAR%-style entries).
        let mut bytes: Vec<u8> = value.encode_utf16().flat_map(|unit| unit.to_le_bytes()).collect();
        bytes.extend_from_slice(&0u16.to_le_bytes());

        env.set_raw_value(
            "Path",
            &RegValue {
                bytes,
                vtype: REG_EXPAND_SZ,
            },
        )
    }

    fn copy_shim_files(source_bin_dir: &Path, dest_bin_dir: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(dest_bin_dir)?;
        for name in ["o8.cmd", "o8.ps1", "o8.mjs"] {
            let src = source_bin_dir.join(name);
            if src.exists() {
                std::fs::copy(&src, dest_bin_dir.join(name))?;
            }
        }
        Ok(())
    }

    /// Ensure the bundled CLI shim is copied into `%USERPROFILE%\.o8\bin` and
    /// that directory is on the user's PATH. Best-effort — logs and returns
    /// on any error so a permission failure never blocks app startup, same
    /// contract as the macOS symlink path.
    pub(crate) fn ensure_cli_on_path(cli_source: &Path) {
        let Some(source_bin_dir) = cli_source.parent() else {
            eprintln!("[cli-path] no parent dir for {}", cli_source.display());
            return;
        };
        let Some(dest_bin_dir) = cli_bin_dir() else {
            eprintln!("[cli-path] could not resolve user home — skipping");
            return;
        };

        if let Err(err) = copy_shim_files(source_bin_dir, &dest_bin_dir) {
            eprintln!("[cli-path] failed to copy shim into {}: {}", dest_bin_dir.display(), err);
            return;
        }

        let dest_str = dest_bin_dir.to_string_lossy().to_string();
        let current_path = match read_user_path() {
            Ok(path) => path,
            Err(err) => {
                eprintln!("[cli-path] failed to read HKCU Environment\\Path: {}", err);
                return;
            }
        };

        match append_path_entry(&current_path, &dest_str) {
            None => {
                std::env::set_var("O8_CLI_INSTALL_STATUS", "already-linked");
            }
            Some(new_path) => {
                if let Err(err) = write_user_path(&new_path) {
                    eprintln!("[cli-path] failed to write HKCU Environment\\Path: {}", err);
                    return;
                }
                broadcast_environment_change();
                std::env::set_var("O8_CLI_INSTALL_STATUS", "linked");
            }
        }
        std::env::set_var("O8_CLI_INSTALL_PATH", dest_str);
    }

    /// Removes `dir` from the user's PATH. Not currently wired to an
    /// uninstall hook (no verifiable NSIS/installer surface from this
    /// environment — see implementation-notes.md) but kept as a pure,
    /// tested primitive so wiring it up later is a small follow-up.
    #[allow(dead_code)]
    pub(crate) fn remove_cli_from_path() {
        let Some(dest_bin_dir) = cli_bin_dir() else {
            return;
        };
        let dest_str = dest_bin_dir.to_string_lossy().to_string();
        let Ok(current_path) = read_user_path() else {
            return;
        };
        let new_path = remove_path_entry(&current_path, &dest_str);
        if new_path != current_path {
            let _ = write_user_path(&new_path);
            broadcast_environment_change();
        }
    }
}

#[cfg(target_os = "windows")]
pub(crate) use windows_impl::ensure_cli_on_path;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_adds_when_missing() {
        let result = append_path_entry("C:\\Windows;C:\\Windows\\System32", "C:\\Users\\me\\.o8\\bin");
        assert_eq!(
            result,
            Some("C:\\Windows;C:\\Windows\\System32;C:\\Users\\me\\.o8\\bin".to_string())
        );
    }

    #[test]
    fn append_is_noop_when_already_present() {
        let existing = "C:\\Windows;C:\\Users\\me\\.o8\\bin;C:\\Windows\\System32";
        assert_eq!(append_path_entry(existing, "C:\\Users\\me\\.o8\\bin"), None);
    }

    #[test]
    fn append_is_case_and_trailing_slash_insensitive() {
        let existing = "C:\\Users\\me\\.o8\\BIN\\";
        assert_eq!(append_path_entry(existing, "c:\\users\\me\\.o8\\bin"), None);
    }

    #[test]
    fn append_handles_empty_existing_path() {
        assert_eq!(
            append_path_entry("", "C:\\Users\\me\\.o8\\bin"),
            Some("C:\\Users\\me\\.o8\\bin".to_string())
        );
    }

    #[test]
    fn append_handles_trailing_semicolon() {
        assert_eq!(
            append_path_entry("C:\\Windows;", "C:\\Users\\me\\.o8\\bin"),
            Some("C:\\Windows;C:\\Users\\me\\.o8\\bin".to_string())
        );
    }

    #[test]
    fn remove_strips_matching_entry() {
        let existing = "C:\\Windows;C:\\Users\\me\\.o8\\bin;C:\\Windows\\System32";
        assert_eq!(
            remove_path_entry(existing, "C:\\Users\\me\\.o8\\bin"),
            "C:\\Windows;C:\\Windows\\System32"
        );
    }

    #[test]
    fn remove_is_noop_when_absent() {
        let existing = "C:\\Windows;C:\\Windows\\System32";
        assert_eq!(remove_path_entry(existing, "C:\\Users\\me\\.o8\\bin"), existing);
    }

    #[test]
    fn remove_drops_empty_segments() {
        let existing = ";C:\\Users\\me\\.o8\\bin;;C:\\Windows;";
        assert_eq!(remove_path_entry(existing, "C:\\Users\\me\\.o8\\bin"), "C:\\Windows");
    }
}
