//! Main-process microphone capture (#1540).
//!
//! macOS Sequoia 15.7.8 (2026-06-27) broke audio delivery to app-SPAWNED
//! helper processes on Intel: the helper's own AVAudioEngine receives silence
//! or garbage regardless of TCC state, while capture in the MAIN app process
//! keeps working (the composer/webview path never broke on the same machine —
//! the existence proof). This module owns the microphone in the app process —
//! the attribution macOS actually honors — and streams 16kHz mono f32 PCM to
//! the speech helper over a FIFO. The helper, in `--audio-fifo` mode, feeds
//! that stream to SFSpeechRecognizer + the Whisper WAV exactly as its own tap
//! used to.
//!
//! The pump runs only while a dictation session is live (plus the brief
//! open/close edges), so the mic-in-use indicator behaves like push-to-talk —
//! no always-hot engine, no 15s linger, and the entire engine
//! stall/rebuild/zero-fill class is unreachable in this mode.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

const TARGET_RATE: f64 = 16_000.0;
/// Frames per FIFO chunk — matches the helper's reader (1024 × f32 = 4096 B).
const CHUNK_FRAMES: usize = 1024;
/// Discard the first slice of captured audio after the device opens (#1544):
/// the first buffers off a freshly-opened input carry device-warmup garbage and
/// the tail of whatever was playing before the duck landed, which would
/// otherwise bleed into the start of the message. Measured at the SOURCE rate.
const WARMUP_DISCARD_MS: f64 = 200.0;

pub struct AudioPump {
    fifo_path: PathBuf,
    running: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl AudioPump {
    /// Create the FIFO node (idempotent) and return a stopped pump bound to it.
    pub fn new(fifo_path: PathBuf) -> Result<Self, String> {
        create_fifo(&fifo_path)?;
        Ok(Self {
            fifo_path,
            running: Arc::new(AtomicBool::new(false)),
            worker: None,
        })
    }

    pub fn fifo_path(&self) -> &Path {
        &self.fifo_path
    }

    /// Open the default input device and start streaming to the FIFO.
    /// No-op if already running. Errors are returned, not logged-and-lost —
    /// the caller surfaces them so a dead mic is never silent (#1534 lesson).
    pub fn start(&mut self) -> Result<(), String> {
        if self.running.load(Ordering::SeqCst) {
            return Ok(());
        }
        self.reap_worker();

        let running = Arc::clone(&self.running);
        running.store(true, Ordering::SeqCst);
        let fifo_path = self.fifo_path.clone();

        // The cpal stream must live on a thread we control: streams are !Send
        // on macOS, so build + hold it inside the worker.
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
        let worker = std::thread::Builder::new()
            .name("stt-capture-pump".into())
            .spawn(move || pump_thread(fifo_path, running, ready_tx))
            .map_err(|e| format!("capture pump thread spawn failed: {e}"))?;
        self.worker = Some(worker);

        match ready_rx.recv_timeout(std::time::Duration::from_secs(5)) {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => {
                self.running.store(false, Ordering::SeqCst);
                Err(e)
            }
            Err(_) => {
                self.running.store(false, Ordering::SeqCst);
                Err("capture pump did not become ready within 5s".to_string())
            }
        }
    }

    /// Stop streaming and release the input device (mic indicator goes dark).
    pub fn stop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        self.reap_worker();
    }

    fn reap_worker(&mut self) {
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl Drop for AudioPump {
    fn drop(&mut self) {
        self.stop();
    }
}

fn create_fifo(path: &Path) -> Result<(), String> {
    use std::os::unix::ffi::OsStrExt;
    if path.exists() {
        return Ok(());
    }
    let c_path = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| "fifo path contains NUL".to_string())?;
    let rc = unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) };
    if rc != 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST) {
        return Err(format!(
            "mkfifo({}) failed: {}",
            path.display(),
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

/// Worker: open device → open FIFO (blocks until the helper's reader is
/// attached) → forward resampled mono PCM until stopped.
fn pump_thread(
    fifo_path: PathBuf,
    running: Arc<AtomicBool>,
    ready_tx: std::sync::mpsc::Sender<Result<(), String>>,
) {
    let host = cpal::default_host();
    let Some(device) = host.default_input_device() else {
        let _ = ready_tx.send(Err("no default input device".to_string()));
        return;
    };
    let device_name = device.name().unwrap_or_else(|_| "unknown".to_string());

    let config = match device.default_input_config() {
        Ok(c) => c,
        Err(e) => {
            let _ = ready_tx.send(Err(format!("input config for '{device_name}' failed: {e}")));
            return;
        }
    };
    let src_rate = config.sample_rate() as f64;
    let channels = config.channels() as usize;

    // Samples cross from the audio callback to this thread through a channel;
    // the callback must never block on FIFO I/O.
    let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<f32>>(64);

    let err_flag = Arc::new(AtomicBool::new(false));
    let err_flag_cb = Arc::clone(&err_flag);
    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config.clone().into(),
            move |data: &[f32], _| {
                let mono: Vec<f32> = data
                    .chunks(channels)
                    .map(|frame| frame.iter().sum::<f32>() / channels as f32)
                    .collect();
                let _ = tx.try_send(mono);
            },
            move |e| {
                log::warn!("[stt-capture] input stream error: {e}");
                err_flag_cb.store(true, Ordering::SeqCst);
            },
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config.clone().into(),
            move |data: &[i16], _| {
                let mono: Vec<f32> = data
                    .chunks(channels)
                    .map(|frame| {
                        frame.iter().map(|s| *s as f32 / 32768.0).sum::<f32>() / channels as f32
                    })
                    .collect();
                let _ = tx.try_send(mono);
            },
            move |e| {
                log::warn!("[stt-capture] input stream error: {e}");
                err_flag_cb.store(true, Ordering::SeqCst);
            },
            None,
        ),
        other => {
            let _ = ready_tx.send(Err(format!("unsupported input sample format {other:?}")));
            return;
        }
    };
    let stream = match stream {
        Ok(s) => s,
        Err(e) => {
            let _ = ready_tx.send(Err(format!("input stream open failed: {e}")));
            return;
        }
    };
    if let Err(e) = stream.play() {
        let _ = ready_tx.send(Err(format!("input stream start failed: {e}")));
        return;
    }

    // Blocks until the helper opens its read end — it does so at boot in
    // --audio-fifo mode, so in practice this returns immediately.
    let mut fifo = match OpenOptions::new().write(true).open(&fifo_path) {
        Ok(f) => f,
        Err(e) => {
            let _ = ready_tx.send(Err(format!("fifo open failed: {e}")));
            return;
        }
    };

    log::info!(
        "[stt-capture] pump live: '{device_name}' {src_rate}Hz {channels}ch → 16kHz mono → {}",
        fifo_path.display()
    );
    let _ = ready_tx.send(Ok(()));

    // Linear resampler state (speech-tolerant; both recognizers accept it).
    let ratio = src_rate / TARGET_RATE;
    let mut src_buf: Vec<f32> = Vec::with_capacity(8192);
    let mut src_pos = 0f64;
    let mut out_chunk: Vec<f32> = Vec::with_capacity(CHUNK_FRAMES);

    // Source-rate frames of device warmup to drop before any audio reaches the
    // FIFO (#1544). Counted down as callback buffers arrive, ahead of resampling.
    let mut warmup_discard_left = (src_rate * WARMUP_DISCARD_MS / 1000.0) as usize;

    while running.load(Ordering::SeqCst) && !err_flag.load(Ordering::SeqCst) {
        let mut mono = match rx.recv_timeout(std::time::Duration::from_millis(200)) {
            Ok(m) => m,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        };
        if warmup_discard_left > 0 {
            let drop_n = warmup_discard_left.min(mono.len());
            mono.drain(..drop_n);
            warmup_discard_left -= drop_n;
            if mono.is_empty() {
                continue;
            }
        }
        src_buf.extend_from_slice(&mono);

        while (src_pos as usize) + 1 < src_buf.len() {
            let base = src_pos as usize;
            let frac = (src_pos - base as f64) as f32;
            let sample = src_buf[base] * (1.0 - frac) + src_buf[base + 1] * frac;
            out_chunk.push(sample);
            src_pos += ratio;

            if out_chunk.len() == CHUNK_FRAMES {
                let bytes: &[u8] = unsafe {
                    std::slice::from_raw_parts(
                        out_chunk.as_ptr() as *const u8,
                        out_chunk.len() * std::mem::size_of::<f32>(),
                    )
                };
                if let Err(e) = fifo.write_all(bytes) {
                    log::warn!("[stt-capture] fifo write failed (helper gone?): {e}");
                    running.store(false, Ordering::SeqCst);
                    break;
                }
                out_chunk.clear();
            }
        }
        // Drop consumed source samples, keep the fractional remainder aligned.
        let consumed = src_pos as usize;
        if consumed > 0 {
            src_buf.drain(..consumed.min(src_buf.len()));
            src_pos -= consumed as f64;
        }
    }

    drop(stream); // release the device — mic indicator off
    let _ = fifo.flush();
    log::info!("[stt-capture] pump stopped");
}
