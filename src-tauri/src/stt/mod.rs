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
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
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

/// Manages the lifecycle of the speech recognition subprocess.
///
/// The child is spawned once via `spawn_daemon()` and then reused for
/// every dictation session. `start()` / `stop()` are cheap stdin writes.
#[derive(Default)]
pub struct LiveRecognizer {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
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

        let mut child = Command::new(&helper)
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

        // Read stderr in background for diagnostics
        if let Some(stderr) = child.stderr.take() {
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
                            "status" => TranscriptEvent::Status {
                                session_id: evt.session_id,
                                text: evt.text,
                            },
                            "error" => TranscriptEvent::Error {
                                session_id: evt.session_id,
                                text: evt.text,
                            },
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
            matches!(child.try_wait(), Ok(None))
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
            if let Ok(None) = child.try_wait() {
                let _ = child.kill();
            }
            let _ = child.wait();
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
            if let Ok(None) = child.try_wait() {
                let _ = child.kill();
            }
            let _ = child.wait();
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
            if let Ok(None) = child.try_wait() {
                #[cfg(unix)]
                unsafe {
                    libc::kill(pid as i32, libc::SIGTERM);
                }
            }

            // Wait for graceful exit (up to 3s), then force kill.
            let start = std::time::Instant::now();
            loop {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        tracing::info!("STT: helper exited with {status}");
                        break;
                    }
                    Ok(None) => {
                        if start.elapsed() > std::time::Duration::from_secs(3) {
                            tracing::warn!("STT: helper did not exit in time, killing");
                            let _ = child.kill();
                            let _ = child.wait();
                            break;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(50));
                    }
                    Err(_) => break,
                }
            }
        }
    }
}
