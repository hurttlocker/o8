//! Speech-to-text engine for o8 (lifted from aqua/Symon, de-Symonized).
//!
//! Uses a Swift helper binary (`speech_recognizer`) that wraps Apple's
//! SFSpeechRecognizer. The Rust side spawns the helper ONCE at app
//! startup and keeps it alive idle between dictations. On dictation start,
//! Rust writes `start\n` to the helper's stdin; on stop, it writes
//! `stop\n`. On app shutdown, it writes `quit\n`.
//!
//! Partial transcripts, levels, and audio_file events stream
//! continuously on the helper's stdout and are forwarded via a single
//! long-lived `mpsc::Receiver<TranscriptEvent>` owned by the caller.
//!
//! Each finalized dictation also produces a 16 kHz mono WAV on disk. The
//! path is emitted as an `AudioFile` event and can feed optional Whisper
//! STT plus audio-grounded polish.

// Several items are lifted verbatim as part of the engine's public surface
// (input-device / on-device toggles, `app_category_for_bundle`, `is_available`,
// etc.) but aren't all wired into a caller yet. Keep them so the lifted modules
// stay faithful to the source; allow dead_code rather than deleting API.
#![allow(dead_code)]

pub mod keys;
pub mod polish;
pub mod whisper;

use serde::Deserialize;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;

/// Phrase-replacement vocabulary + post-pass applier.
///
/// `PolishContext` carries a `Vec<ReplacementRule>` so the polished output can
/// run deterministic phrase expansions. o8's engine doesn't ship a settings
/// surface for these yet — callers pass an empty Vec — but the type + applier
/// are kept so the lifted polish prompt logic compiles verbatim.
pub mod commands {
    use serde::{Deserialize, Serialize};

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct ReplacementRule {
        pub trigger: String,
        pub replacement: String,
    }

    pub fn apply_replacements(text: &str, replacements: &[ReplacementRule]) -> String {
        if replacements.is_empty() {
            return text.to_string();
        }

        let mut ordered = replacements
            .iter()
            .filter(|rule| !rule.trigger.trim().is_empty())
            .cloned()
            .collect::<Vec<_>>();
        ordered.sort_by(|a, b| b.trigger.len().cmp(&a.trigger.len()));

        let mut result = text.to_string();
        for rule in ordered {
            result = replace_case_insensitive(&result, &rule.trigger, &rule.replacement);
        }
        result
    }

    fn replace_case_insensitive(text: &str, pattern: &str, replacement: &str) -> String {
        let lower = text.to_lowercase();
        let pattern_lower = pattern.to_lowercase();
        let mut result = String::with_capacity(text.len());
        let mut last_end = 0;

        for (start, _) in lower.match_indices(&pattern_lower) {
            result.push_str(&text[last_end..start]);
            result.push_str(replacement);
            last_end = start + pattern.len();
        }
        result.push_str(&text[last_end..]);
        result
    }

    /// Result of processing voice commands in a transcript.
    pub enum CommandResult {
        /// Modified text ready to paste.
        Text(String),
        /// User cancelled dictation — don't paste anything.
        Cancel,
        /// Read-aloud directive ("say <text>") — speak the text, don't paste it.
        Speak(String),
    }

    /// Process voice commands at the END of a transcript (ported from aqua/Symon
    /// `stt/commands.rs::process`, de-Symonized). Case-insensitive, plain
    /// `ends_with`/replace, zero latency. Runs on the RAW transcript BEFORE polish
    /// on the system-Fn paste path (the in-window composer has its own TS
    /// processor at `src/lib/dictation/voice-commands.ts`).
    ///
    /// - "scratch that" / "cancel" / "never mind" / "nevermind" → Cancel (no paste)
    /// - "remove that" / "delete that" / "undo that" / "undo" → strip phrase + last word
    /// - "new paragraph" → `\n\n` (anywhere) · "new line" → `\n` (anywhere)
    pub fn process(transcript: &str) -> CommandResult {
        let trimmed = transcript.trim();
        if trimmed.is_empty() {
            return CommandResult::Cancel;
        }

        let lower = trimmed.to_lowercase();

        // Read-aloud directive — a "say <text>" LEADS the utterance (unlike the
        // trailing cancel/remove commands), so check it FIRST so "say cancel"
        // speaks "cancel" rather than cancelling. Net-new grammar (not in Symon).
        if lower.starts_with("say ") {
            return CommandResult::Speak(trimmed[4..].trim().to_string());
        }

        // Full cancellation — any of these at the end cancels the paste.
        for cancel_cmd in &["scratch that", "cancel", "never mind", "nevermind"] {
            if lower.ends_with(cancel_cmd) {
                return CommandResult::Cancel;
            }
        }

        let mut text = trimmed.to_string();

        // Remove/delete/undo — strip the command phrase + the last remaining word.
        let remove_commands: &[&str] = &["remove that", "delete that", "undo that", "undo"];
        for cmd in remove_commands {
            if lower.ends_with(cmd) {
                let end = text.len() - cmd.len();
                text.truncate(end);
                text = text.trim_end().to_string();

                // Drop trailing punctuation Apple may have added before the command.
                while text.ends_with('.')
                    || text.ends_with(',')
                    || text.ends_with('!')
                    || text.ends_with('?')
                {
                    text.pop();
                    text = text.trim_end().to_string();
                }

                // Remove the last word (one word left → clear it → Cancel below).
                if let Some(last_space) = text.rfind(' ') {
                    text.truncate(last_space);
                } else {
                    text.clear();
                }
                break;
            }
        }

        // Inline replacements (anywhere). Longer pattern first to avoid partials.
        text = replace_case_insensitive(&text, "new paragraph", "\n\n");
        text = replace_case_insensitive(&text, "new line", "\n");

        let result = text.trim().to_string();
        if result.is_empty() {
            CommandResult::Cancel
        } else {
            CommandResult::Text(result)
        }
    }
}

/// JSON structure emitted by the Swift helper (one per line).
#[derive(Debug, Deserialize)]
struct SttEvent {
    #[serde(rename = "type")]
    kind: String,
    text: String,
    #[serde(default)]
    session_id: Option<u64>,
}

/// A transcript update sent from the recognizer to the caller.
#[derive(Debug, Clone)]
pub enum TranscriptEvent {
    /// Partial (in-progress) transcript — updated as the user speaks.
    Partial { session_id: u64, text: String },
    /// Final transcript — recognition complete.
    Final { session_id: u64, text: String },
    /// Status message (e.g. "listening").
    Status {
        session_id: Option<u64>,
        text: String,
    },
    /// Error from the Swift helper.
    Error {
        session_id: Option<u64>,
        text: String,
    },
    /// Audio level (0.0 = silence, 1.0 = loud).
    Level { session_id: u64, level: f32 },
    /// Path to the recorded WAV file used by optional Whisper STT and by
    /// audio-grounded transcript polishing.
    AudioFile { session_id: u64, path: String },
    /// Session has fully finalized and emitted all final artifacts.
    Complete { session_id: u64 },
    /// Daemon is idle and ready to accept a `start` command.
    /// Emitted once at startup and again after each `stop`.
    Ready,
}

/// Poll result for the daemon child — the tri-state the lifecycle code needs
/// (`try_wait` semantics) expressed over both spawn paths.
enum ChildPoll {
    Alive,
    Exited(String),
    Gone,
}

/// A helper spawned via raw `posix_spawn` with TCC responsibility DISCLAIMED
/// (see `spawn_disclaimed`). Only the pid is held — stdio pipes are taken at
/// spawn time. `reaped` guards double-waitpid.
#[cfg(target_os = "macos")]
struct DisclaimedChild {
    pid: libc::pid_t,
    reaped: bool,
}

#[cfg(target_os = "macos")]
impl DisclaimedChild {
    fn poll(&mut self) -> ChildPoll {
        if self.reaped {
            return ChildPoll::Gone;
        }
        let mut status: libc::c_int = 0;
        match unsafe { libc::waitpid(self.pid, &mut status, libc::WNOHANG) } {
            0 => ChildPoll::Alive,
            pid if pid == self.pid => {
                self.reaped = true;
                ChildPoll::Exited(format!("status {status}"))
            }
            _ => {
                self.reaped = true;
                ChildPoll::Gone
            }
        }
    }

    fn kill_and_reap(&mut self) {
        if self.reaped {
            return;
        }
        unsafe {
            libc::kill(self.pid, libc::SIGKILL);
            let mut status: libc::c_int = 0;
            libc::waitpid(self.pid, &mut status, 0);
        }
        self.reaped = true;
    }
}

/// The spawned helper process, over either spawn path: `Std` = classic
/// `std::process::Command` (non-macOS, and the macOS fallback), `Disclaimed` =
/// raw posix_spawn with TCC responsibility disclaimed (the macOS primary path
/// — the fix for #1534's zero-filled capture).
enum DaemonChild {
    Std(Child),
    #[cfg(target_os = "macos")]
    Disclaimed(DisclaimedChild),
}

impl DaemonChild {
    fn id(&self) -> u32 {
        match self {
            Self::Std(c) => c.id(),
            #[cfg(target_os = "macos")]
            Self::Disclaimed(d) => d.pid as u32,
        }
    }

    fn poll(&mut self) -> ChildPoll {
        match self {
            Self::Std(c) => match c.try_wait() {
                Ok(None) => ChildPoll::Alive,
                Ok(Some(status)) => ChildPoll::Exited(status.to_string()),
                Err(_) => ChildPoll::Gone,
            },
            #[cfg(target_os = "macos")]
            Self::Disclaimed(d) => d.poll(),
        }
    }

    fn kill_and_reap(&mut self) {
        match self {
            Self::Std(c) => {
                let _ = c.kill();
                let _ = c.wait();
            }
            #[cfg(target_os = "macos")]
            Self::Disclaimed(d) => d.kill_and_reap(),
        }
    }
}

/// Manages the lifecycle of the speech recognition subprocess.
///
/// The child is spawned once via `spawn_daemon()` and then reused for
/// every dictation session. `start()` / `stop()` are cheap stdin writes.
#[derive(Default)]
pub struct LiveRecognizer {
    child: Option<DaemonChild>,
    stdin: Option<Box<dyn Write + Send>>,
    locale: Option<String>,
    on_device: Option<bool>,
    input_device_uid: Option<String>,
}

impl LiveRecognizer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Resolve the path to the compiled `speech_recognizer` helper binary.
    ///
    /// During development, it lives at `src-tauri/helpers/speech_recognizer`.
    /// In a release bundle, it's next to the app binary.
    pub fn helper_path() -> PathBuf {
        // 1. Check next to our own binary (Tauri externalBin bundles here)
        if let Ok(exe) = std::env::current_exe() {
            let dir = exe.parent().unwrap();

            // Tauri bundles sidecars with target-triple suffix
            let target = if cfg!(target_arch = "x86_64") {
                "x86_64-apple-darwin"
            } else {
                "aarch64-apple-darwin"
            };
            let sidecar = dir.join(format!("speech_recognizer-{target}"));
            if sidecar.exists() {
                return sidecar;
            }

            // Also check without suffix
            let beside_exe = dir.join("speech_recognizer");
            if beside_exe.exists() {
                return beside_exe;
            }
        }

        // 2. Fallback: relative to the Cargo manifest dir (dev builds)
        let manifest_dir = env!("CARGO_MANIFEST_DIR");
        PathBuf::from(manifest_dir)
            .join("helpers")
            .join("speech_recognizer")
    }

    /// Spawn the Swift helper daemon ONCE at app startup.
    ///
    /// Returns a long-lived `mpsc::Receiver<TranscriptEvent>` that
    /// streams events from ALL dictation sessions for the lifetime of
    /// the daemon. The caller should install a single reader thread
    /// that routes events to shared state.
    pub fn spawn_daemon(&mut self) -> Result<mpsc::Receiver<TranscriptEvent>, String> {
        if self.child.is_some() {
            return Err("STT daemon already running".to_string());
        }

        let helper = Self::helper_path();
        if !helper.exists() {
            return Err(format!(
                "Speech recognizer helper not found at: {}",
                helper.display()
            ));
        }

        let (child, stdin, stdout, stderr) = Self::spawn_helper(&helper)?;

        // Read stderr in background for diagnostics
        {
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().map_while(Result::ok) {
                    tracing::warn!("STT stderr: {line}");
                }
            });
        }

        let (tx, rx) = mpsc::channel();

        // Long-lived background thread: read JSON lines from stdout and
        // forward them as TranscriptEvents. Continues across sessions —
        // ends only when the helper exits (drop / quit).
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if line.is_empty() {
                    continue;
                }
                match serde_json::from_str::<SttEvent>(&line) {
                    Ok(evt) => {
                        let sid = evt.session_id.unwrap_or(0);
                        let event = match evt.kind.as_str() {
                            "partial" => TranscriptEvent::Partial {
                                session_id: sid,
                                text: evt.text,
                            },
                            "final" => TranscriptEvent::Final {
                                session_id: sid,
                                text: evt.text,
                            },
                            "status" => {
                                // Engine-health statuses must reach the PROD log
                                // file (`log::` → tauri_plugin_log → o8.log);
                                // `tracing::` goes to stdout, which a bundled
                                // .app discards — #1534 was undiagnosable in the
                                // field because every capture/paste breadcrumb
                                // was tracing-only.
                                if evt.text.starts_with("audio_engine") {
                                    log::warn!("[stt] helper audio-engine health: {}", evt.text);
                                }
                                TranscriptEvent::Status {
                                    session_id: evt.session_id,
                                    text: evt.text,
                                }
                            }
                            "error" => {
                                log::warn!("[stt] helper error: {}", evt.text);
                                TranscriptEvent::Error {
                                    session_id: evt.session_id,
                                    text: evt.text,
                                }
                            }
                            "level" => {
                                let level = evt.text.parse::<f32>().unwrap_or(0.0);
                                TranscriptEvent::Level {
                                    session_id: sid,
                                    level,
                                }
                            }
                            "audio_file" => TranscriptEvent::AudioFile {
                                session_id: sid,
                                path: evt.text,
                            },
                            "complete" => TranscriptEvent::Complete { session_id: sid },
                            "ready" => {
                                tracing::debug!("STT: daemon ready");
                                TranscriptEvent::Ready
                            }
                            _ => TranscriptEvent::Status {
                                session_id: evt.session_id,
                                text: evt.text,
                            },
                        };
                        if tx.send(event).is_err() {
                            break; // Receiver dropped
                        }
                    }
                    Err(e) => {
                        tracing::warn!("STT: failed to parse helper output: {e} — line: {line}");
                    }
                }
            }
            tracing::info!("STT: stdout reader thread exiting (daemon stopped)");
        });

        self.stdin = Some(stdin);
        self.child = Some(child);
        tracing::info!(
            "STT: spawned speech recognizer daemon (pid={})",
            self.child.as_ref().map(|c| c.id()).unwrap_or(0)
        );

        Ok(rx)
    }

    /// Spawn the helper, preferring the DISCLAIMED path on macOS.
    ///
    /// Why (#1534, the clean-install Intel killer): a helper spawned normally
    /// inherits the app as its TCC "responsible process". On the affected
    /// machines tccd REPORTS the mic as authorized for that chain, yet
    /// CoreAudio delivers all-zero sample buffers to the helper — dictation
    /// records pure silence (-91 dB WAVs) and every transcript finalizes
    /// empty. The SAME binary run so that responsibility does NOT resolve to
    /// the app captures perfectly (verified live on the Intel MacBook,
    /// including a posix_spawn+disclaim run of the exact shipped binary).
    ///
    /// `responsibility_spawnattrs_setdisclaim` makes the helper its OWN
    /// responsible process: macOS prompts once for "o8 Speech Helper"
    /// (usage strings ship in its embedded Info.plist) and creates a TCC
    /// entry keyed to the helper itself — the attribution shape that
    /// demonstrably captures real audio. Any failure on this path falls back
    /// to the classic Command spawn (today's behavior), so dictation can
    /// never regress below the status quo.
    #[allow(clippy::type_complexity)]
    fn spawn_helper(
        helper: &std::path::Path,
    ) -> Result<
        (
            DaemonChild,
            Box<dyn Write + Send>,
            Box<dyn Read + Send>,
            Box<dyn Read + Send>,
        ),
        String,
    > {
        #[cfg(target_os = "macos")]
        match Self::spawn_disclaimed(helper) {
            Ok((child, stdin, stdout, stderr)) => {
                log::info!(
                    "[stt] helper spawned with disclaimed TCC responsibility (pid={})",
                    child.pid
                );
                return Ok((
                    DaemonChild::Disclaimed(child),
                    Box::new(stdin),
                    Box::new(stdout),
                    Box::new(stderr),
                ));
            }
            Err(e) => {
                log::warn!(
                    "[stt] disclaimed spawn failed ({e}) — falling back to inherited-responsibility spawn"
                );
            }
        }

        let mut child = Command::new(helper)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to spawn speech_recognizer: {e}"))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to capture speech_recognizer stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to capture speech_recognizer stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Failed to capture speech_recognizer stderr".to_string())?;

        Ok((
            DaemonChild::Std(child),
            Box::new(stdin),
            Box::new(stdout),
            Box::new(stderr),
        ))
    }

    /// Raw `posix_spawn` of the helper with TCC responsibility disclaimed and
    /// stdio wired to fresh pipes. See `spawn_helper` for the why.
    #[cfg(target_os = "macos")]
    fn spawn_disclaimed(
        helper: &std::path::Path,
    ) -> Result<(DisclaimedChild, std::fs::File, std::fs::File, std::fs::File), String> {
        use std::os::fd::FromRawFd;
        use std::os::unix::ffi::OsStrExt;

        // Private-but-stable libSystem API (the mechanism Chromium and other
        // multi-process apps use for exactly this): child becomes its own
        // TCC responsible process instead of inheriting ours.
        extern "C" {
            fn responsibility_spawnattrs_setdisclaim(
                attr: *mut libc::posix_spawnattr_t,
                disclaim: libc::c_int,
            ) -> libc::c_int;
            fn _NSGetEnviron() -> *mut *mut *mut libc::c_char;
        }

        let path = std::ffi::CString::new(helper.as_os_str().as_bytes())
            .map_err(|_| "helper path contains NUL".to_string())?;

        // Three pipes: [read, write] each. Parent keeps stdin-write,
        // stdout-read, stderr-read; the child ends are dup2'd onto 0/1/2 and
        // every raw pipe fd is closed in the child.
        let mut fds_in = [0 as libc::c_int; 2];
        let mut fds_out = [0 as libc::c_int; 2];
        let mut fds_err = [0 as libc::c_int; 2];
        unsafe {
            if libc::pipe(fds_in.as_mut_ptr()) != 0
                || libc::pipe(fds_out.as_mut_ptr()) != 0
                || libc::pipe(fds_err.as_mut_ptr()) != 0
            {
                return Err("pipe() failed".to_string());
            }
        }
        let close_all = |fds: &[libc::c_int]| {
            for fd in fds {
                unsafe { libc::close(*fd) };
            }
        };

        unsafe {
            let mut attr: libc::posix_spawnattr_t = std::mem::zeroed();
            if libc::posix_spawnattr_init(&mut attr) != 0 {
                close_all(&[fds_in[0], fds_in[1], fds_out[0], fds_out[1], fds_err[0], fds_err[1]]);
                return Err("posix_spawnattr_init failed".to_string());
            }
            if responsibility_spawnattrs_setdisclaim(&mut attr, 1) != 0 {
                libc::posix_spawnattr_destroy(&mut attr);
                close_all(&[fds_in[0], fds_in[1], fds_out[0], fds_out[1], fds_err[0], fds_err[1]]);
                return Err("responsibility_spawnattrs_setdisclaim failed".to_string());
            }

            let mut fa: libc::posix_spawn_file_actions_t = std::mem::zeroed();
            if libc::posix_spawn_file_actions_init(&mut fa) != 0 {
                libc::posix_spawnattr_destroy(&mut attr);
                close_all(&[fds_in[0], fds_in[1], fds_out[0], fds_out[1], fds_err[0], fds_err[1]]);
                return Err("posix_spawn_file_actions_init failed".to_string());
            }
            libc::posix_spawn_file_actions_adddup2(&mut fa, fds_in[0], 0);
            libc::posix_spawn_file_actions_adddup2(&mut fa, fds_out[1], 1);
            libc::posix_spawn_file_actions_adddup2(&mut fa, fds_err[1], 2);
            for fd in [fds_in[0], fds_in[1], fds_out[0], fds_out[1], fds_err[0], fds_err[1]] {
                libc::posix_spawn_file_actions_addclose(&mut fa, fd);
            }

            let argv: [*mut libc::c_char; 2] = [path.as_ptr() as *mut _, std::ptr::null_mut()];
            let envp = *_NSGetEnviron();

            let mut pid: libc::pid_t = 0;
            let rc = libc::posix_spawn(&mut pid, path.as_ptr(), &fa, &attr, argv.as_ptr(), envp);

            libc::posix_spawn_file_actions_destroy(&mut fa);
            libc::posix_spawnattr_destroy(&mut attr);

            // Parent closes the child-side ends regardless of outcome.
            libc::close(fds_in[0]);
            libc::close(fds_out[1]);
            libc::close(fds_err[1]);

            if rc != 0 {
                close_all(&[fds_in[1], fds_out[0], fds_err[0]]);
                return Err(format!("posix_spawn failed (errno {rc})"));
            }

            Ok((
                DisclaimedChild { pid, reaped: false },
                std::fs::File::from_raw_fd(fds_in[1]),
                std::fs::File::from_raw_fd(fds_out[0]),
                std::fs::File::from_raw_fd(fds_err[0]),
            ))
        }
    }

    /// Begin a new dictation session by writing `start\n` to the daemon.
    /// Cheap — no spawn, no allocation beyond the line.
    pub fn start(&mut self, session_id: u64) -> Result<(), String> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| "STT daemon not initialized".to_string())?;
        let cmd = format!("start:{session_id}\n");
        stdin
            .write_all(cmd.as_bytes())
            .map_err(|e| format!("STT: failed to write start command: {e}"))?;
        stdin
            .flush()
            .map_err(|e| format!("STT: failed to flush start command: {e}"))?;
        tracing::debug!("STT: sent start");
        Ok(())
    }

    pub fn set_locale(&mut self, locale_identifier: &str) -> Result<(), String> {
        let normalized = locale_identifier.trim();
        if normalized.is_empty() {
            return Err("STT locale cannot be empty".to_string());
        }

        if self.locale.as_deref() == Some(normalized) {
            return Ok(());
        }

        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| "STT daemon not initialized".to_string())?;
        let cmd = format!("locale:{normalized}\n");
        stdin
            .write_all(cmd.as_bytes())
            .map_err(|e| format!("STT: failed to write locale command: {e}"))?;
        stdin
            .flush()
            .map_err(|e| format!("STT: failed to flush locale command: {e}"))?;
        self.locale = Some(normalized.to_string());
        tracing::debug!("STT: set locale to {normalized}");
        Ok(())
    }

    pub fn set_input_device(&mut self, uid: Option<&str>) -> Result<(), String> {
        let normalized = uid
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);

        if normalized
            .as_deref()
            .is_some_and(|value| value.contains('\n') || value.contains('\r'))
        {
            return Err("STT microphone UID cannot contain newlines".to_string());
        }

        if self.input_device_uid == normalized {
            return Ok(());
        }

        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| "STT daemon not initialized".to_string())?;
        let target = normalized.clone().unwrap_or_else(|| "default".to_string());
        let cmd = format!("input_device:{target}\n");
        stdin
            .write_all(cmd.as_bytes())
            .map_err(|e| format!("STT: failed to write input device command: {e}"))?;
        stdin
            .flush()
            .map_err(|e| format!("STT: failed to flush input device command: {e}"))?;
        self.input_device_uid = normalized;
        tracing::debug!("STT: set input device to {target}");
        Ok(())
    }

    /// End the current dictation session by writing `stop\n` to the daemon.
    ///
    /// Does NOT kill the child or wait for exit. The daemon will emit
    /// `final` + `audio_file` + `ready` on stdout and return to idle.
    ///
    /// Best-effort: if the daemon has died or stdin is gone, logs and moves on.
    /// Signature matches the pre-refactor version (`pub fn stop(&mut self)`).
    pub fn stop(&mut self, session_id: u64) {
        if let Some(stdin) = self.stdin.as_mut() {
            let cmd = format!("stop:{session_id}\n");
            if let Err(e) = stdin.write_all(cmd.as_bytes()) {
                tracing::warn!("STT: failed to write stop command: {e}");
                return;
            }
            if let Err(e) = stdin.flush() {
                tracing::warn!("STT: failed to flush stop command: {e}");
                return;
            }
            tracing::debug!("STT: sent stop");
        } else {
            tracing::warn!("STT: stop called but daemon not initialized");
        }
    }

    /// Whether the daemon subprocess is currently alive.
    pub fn is_running(&mut self) -> bool {
        if let Some(ref mut child) = self.child {
            matches!(child.poll(), ChildPoll::Alive)
        } else {
            false
        }
    }

    /// Kill the current daemon (if any) and spawn a fresh one.
    ///
    /// Called when `is_running()` returns false — the daemon crashed
    /// between dictation sessions and needs to be replaced. Returns a
    /// new Receiver for the caller to install a replacement router thread.
    pub fn respawn(&mut self) -> Result<mpsc::Receiver<TranscriptEvent>, String> {
        // Gracefully shut down old daemon
        if let Some(mut stdin) = self.stdin.take() {
            let _ = stdin.write_all(b"quit\n");
            let _ = stdin.flush();
        }
        if let Some(mut child) = self.child.take() {
            std::thread::sleep(std::time::Duration::from_millis(100));
            if matches!(child.poll(), ChildPoll::Alive) {
                child.kill_and_reap();
            }
        }
        self.locale = None;
        self.on_device = None;
        self.input_device_uid = None;
        // child and stdin are now None — spawn_daemon() will accept this
        self.spawn_daemon()
    }

    pub fn set_on_device(&mut self, enabled: bool) -> Result<(), String> {
        if self.on_device == Some(enabled) {
            return Ok(());
        }

        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| "STT daemon not initialized".to_string())?;
        let cmd = format!("on_device:{enabled}\n");
        stdin
            .write_all(cmd.as_bytes())
            .map_err(|e| format!("STT: failed to write on-device command: {e}"))?;
        stdin
            .flush()
            .map_err(|e| format!("STT: failed to flush on-device command: {e}"))?;
        self.on_device = Some(enabled);
        tracing::debug!("STT: set on-device recognition to {enabled}");
        Ok(())
    }

    pub fn shutdown(&mut self) {
        if let Some(mut stdin) = self.stdin.take() {
            let _ = stdin.write_all(b"quit\n");
            let _ = stdin.flush();
        }

        if let Some(mut child) = self.child.take() {
            std::thread::sleep(std::time::Duration::from_millis(100));
            if matches!(child.poll(), ChildPoll::Alive) {
                child.kill_and_reap();
            }
        }

        self.locale = None;
        self.on_device = None;
        self.input_device_uid = None;
    }
}

impl Drop for LiveRecognizer {
    fn drop(&mut self) {
        // Best-effort graceful quit: write quit\n, then SIGTERM after a
        // short grace, then SIGKILL after 3s.
        if let Some(mut stdin) = self.stdin.take() {
            let _ = stdin.write_all(b"quit\n");
            let _ = stdin.flush();
            // Dropping stdin here also closes the pipe, which the Swift
            // stdin reader treats as a "parent died, quit" signal.
        }

        if let Some(mut child) = self.child.take() {
            let pid = child.id();
            tracing::info!("STT: tearing down speech recognizer daemon (pid={pid})");

            // Give the helper a brief chance to exit on its own after the
            // quit command / stdin close.
            std::thread::sleep(std::time::Duration::from_millis(200));

            // If still alive, send SIGTERM.
            if matches!(child.poll(), ChildPoll::Alive) {
                #[cfg(unix)]
                unsafe {
                    libc::kill(pid as i32, libc::SIGTERM);
                }
            }

            // Wait for graceful exit (up to 3s), then force kill.
            let start = std::time::Instant::now();
            loop {
                match child.poll() {
                    ChildPoll::Exited(status) => {
                        tracing::info!("STT: helper exited with {status}");
                        break;
                    }
                    ChildPoll::Alive => {
                        if start.elapsed() > std::time::Duration::from_secs(3) {
                            tracing::warn!("STT: helper did not exit in time, killing");
                            child.kill_and_reap();
                            break;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(50));
                    }
                    ChildPoll::Gone => break,
                }
            }
        }
    }
}
