// ScreenCaptureKit sampling adapted from Scrawl src/capture.rs.
// Copyright (c) 2026 Kit Langton. MIT; see ../third-party/visual-capture-MIT.txt.
use crate::visual_capture_packet::{self as packet, Mark, Moment, Sample};
use screencapturekit::prelude::*;
use screencapturekit::recording_output::{
    SCRecordingOutput, SCRecordingOutputCodec, SCRecordingOutputConfiguration,
    SCRecordingOutputFileType,
};
use screencapturekit::screenshot_manager::{CGImageExt, SCScreenshotManager};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::Emitter;

#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WidgetRect {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Widget {
    pub regions: Vec<WidgetRect>,
    pub typing: bool,
}

pub struct Shared {
    pub stopping: AtomicBool,
    pub cancelled: Arc<AtomicBool>,
    pub marks: Mutex<Vec<Mark>>,
    pub events: Mutex<Vec<Moment>>,
    pub widget: Mutex<Option<Widget>>,
    pub bounds: [f64; 4],
    pub started: Instant,
    pub snapshots: Arc<crate::visual_capture_snapshot::SnapshotPipeline>,
}

pub struct Session {
    pub shared: Arc<Shared>,
    pub directory: PathBuf,
    _artifacts: Arc<crate::visual_capture::Artifacts>,
    worker: Option<JoinHandle<Result<(Vec<Sample>, u64), String>>>,
    input_worker: Option<JoinHandle<()>>,
}

/// Check the API itself before permissions, overlays, storage, or worker startup.
pub(crate) fn require_recording_output() -> Result<(), String> {
    recording_output_available(SCRecordingOutput::is_available())
}
pub(crate) fn recording_output_available(available: bool) -> Result<(), String> {
    if available {
        return Ok(());
    }
    Err("Capture screen requires macOS 15 or later. On macOS 14, attach an image to your chat and type your instruction instead.".into())
}

impl Session {
    pub fn start(
        app: tauri::AppHandle,
        id: String,
        generation: u64,
        directory: PathBuf,
        target: tauri::Monitor,
        cancelled: Arc<AtomicBool>,
        artifacts: Arc<crate::visual_capture::Artifacts>,
    ) -> Result<Self, String> {
        require_recording_output()?;
        if cancelled.load(Ordering::Acquire) {
            return Err("Visual capture was cancelled.".into());
        }
        let content = SCShareableContent::get()
            .map_err(|_| "Screen capture is unavailable. Check Screen Recording access.")?;
        let scale = target.scale_factor();
        let bounds = [
            target.position().x as f64 / scale,
            target.position().y as f64 / scale,
            target.size().width as f64 / scale,
            target.size().height as f64 / scale,
        ];
        let display = content
            .displays()
            .into_iter()
            .find(|display| {
                let frame = display.frame();
                [
                    frame.origin.x,
                    frame.origin.y,
                    frame.size.width,
                    frame.size.height,
                ]
                .iter()
                .zip(bounds)
                .all(|(actual, expected)| (actual - expected).abs() <= 2.0)
            })
            .ok_or("The selected display changed before capture. Try again on that display.")?;
        let rect = display.frame();
        let pid = std::process::id() as i32;
        // Keep the normal o8 window visible; omit only this process's floating overlays.
        let excluded: Vec<SCWindow> = content
            .windows()
            .into_iter()
            .filter(|window| {
                window.window_layer() != 0
                    && window
                        .owning_application()
                        .is_some_and(|owner| owner.process_id() == pid)
            })
            .collect();
        let references: Vec<&SCWindow> = excluded.iter().collect();
        let filter = SCContentFilter::create()
            .with_display(&display)
            .with_excluding_windows(&references)
            .build()
            .map_err(|_| "Could not prepare a screen capture.")?;
        if cancelled.load(Ordering::Acquire) {
            return Err("Visual capture was cancelled.".into());
        }
        let started = Instant::now();
        let snapshots = crate::visual_capture_snapshot::SnapshotPipeline::start(
            app.clone(),
            id.clone(),
            generation,
            directory.clone(),
            [
                rect.origin.x,
                rect.origin.y,
                rect.size.width,
                rect.size.height,
            ],
            cancelled.clone(),
            started,
            artifacts.clone(),
        );
        let shared = Arc::new(Shared {
            stopping: AtomicBool::new(false),
            cancelled,
            marks: Mutex::new(Vec::new()),
            events: Mutex::new(Vec::new()),
            widget: Mutex::new(None),
            bounds: [
                rect.origin.x,
                rect.origin.y,
                rect.size.width,
                rect.size.height,
            ],
            started,
            snapshots,
        });
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
        let thread_shared = shared.clone();
        let thread_directory = directory.clone();
        let failure_app = app.clone();
        let failure_id = id.clone();
        let worker = std::thread::Builder::new().name("visual-capture-screen".into()).spawn(move || {
            let result = (|| -> Result<(Vec<Sample>, u64), String> {
            if thread_shared.cancelled.load(Ordering::Acquire) { return Err("Visual capture was cancelled.".into()); }
            let scale = (2560.0 / rect.size.width.max(rect.size.height)).min(2.0);
            let width = ((rect.size.width * scale) as u32).max(48) & !1;
            let height = ((rect.size.height * scale) as u32).max(48) & !1;
            let config = SCStreamConfiguration::new().with_width(width).with_height(height).with_shows_cursor(true);
            let recording = SCRecordingOutputConfiguration::new().map_err(|_| "Could not prepare the recording.")?
                .with_output_url(&thread_directory.join("recording.mp4")).map_err(|_| "Could not prepare recording output.")?
                .with_video_codec(SCRecordingOutputCodec::H264).with_output_file_type(SCRecordingOutputFileType::MP4);
            let output = SCRecordingOutput::new(&recording).ok_or("Could not prepare recording output.")?;
            let mut stream = SCStream::new(&filter, &config).map_err(|_| "Could not prepare the recording stream.")?;
            let snapshot_stream = thread_shared.snapshots.clone();
            stream.add_output_handler(move |sample, kind| snapshot_stream.observe(sample, kind), SCStreamOutputType::Screen).map_err(|_| "Could not observe screen frames.")?;
            stream.add_recording_output(&output).map_err(|_| "Could not attach recording output.")?;
            let before = thread_shared.started.elapsed();
            stream.start_capture().map_err(|_| "Screen recording could not start.")?;
            let video_offset = ((before + thread_shared.started.elapsed()) / 2).as_millis() as u64;
            let sample_width = 480_u32;
            let sample_height = ((480.0 * rect.size.height / rect.size.width).round() as u32).max(48);
            let sampling = SCStreamConfiguration::new().with_width(sample_width).with_height(sample_height).with_shows_cursor(false);
            let mut samples = Vec::new();
            let mut interval = Duration::from_millis(220);
            let mut last = Instant::now() - interval;
            let mut failed = 0;
            while !thread_shared.stopping.load(Ordering::Acquire) && !thread_shared.cancelled.load(Ordering::Acquire) && crate::spatial_ink_window::generation() == generation {
                if last.elapsed() >= interval {
                    last = Instant::now();
                    match SCScreenshotManager::capture_image(&filter, &sampling).and_then(|image| image.rgba_data().map(|rgba| (image, rgba))) {
                        Ok((image, rgba)) => {
                            let image = image::RgbaImage::from_raw(image.width() as u32, image.height() as u32, rgba).ok_or("Invalid screen pixels.")?;
                            samples.push(Sample { at_ms: thread_shared.started.elapsed().as_millis() as u64, image });
                            if samples.len() == 1 { let _ = ready_tx.send(()); }
                            if samples.len() >= 96 { samples = samples.into_iter().enumerate().filter_map(|(n, value)| (n % 2 == 0).then_some(value)).collect(); interval *= 2; }
                            failed = 0;
                        }
                        Err(_) => { failed += 1; if failed >= 3 { let _ = stream.stop_capture(); let _ = stream.remove_recording_output(&output); return Err("Screen capture stopped producing real frames. This capture was not added.".into()); } }
                    }
                }
                if thread_shared.started.elapsed() > Duration::from_secs(90) { break; }
                std::thread::sleep(Duration::from_millis(20));
            }
            stream.stop_capture().map_err(|_| "The recording did not stop cleanly.")?;
            stream.remove_recording_output(&output).map_err(|_| "The recording did not finish cleanly.")?;
            if samples.is_empty() { return Err("No real screen frames were captured.".into()); }
            Ok((samples, video_offset))
            })();
            thread_shared.stopping.store(true, Ordering::Release);
            if let Err(error) = &result { let _ = failure_app.emit_to("main", "o8:visual-capture-error", serde_json::json!({"id": failure_id, "generation": generation, "error": error})); }
            result
        }).map_err(|_| "Could not start screen capture.")?;
        if ready_rx.recv_timeout(Duration::from_secs(5)).is_err() {
            shared.stopping.store(true, Ordering::Release);
            let _ = worker.join();
            return Err(
                "The screen recorder did not produce a frame. Check Screen Recording access."
                    .into(),
            );
        }
        let input_shared = shared.clone();
        let input_worker = match std::thread::Builder::new()
            .name("visual-capture-pointer".into())
            .spawn(move || crate::visual_capture_input::run(app, id, generation, input_shared))
        {
            Ok(input) => input,
            Err(_) => {
                shared.stopping.store(true, Ordering::Release);
                let _ = worker.join();
                return Err("Could not start visual input.".into());
            }
        };
        Ok(Self {
            shared,
            directory,
            _artifacts: artifacts,
            worker: Some(worker),
            input_worker: Some(input_worker),
        })
    }

    pub fn finish(mut self, instruction: String) -> Result<serde_json::Value, String> {
        self.shared.snapshots.stop();
        let duration = self.shared.started.elapsed().as_millis().min(90_000) as u64;
        self.shared.stopping.store(true, Ordering::Release);
        if let Some(input) = self.input_worker.take() {
            let _ = input.join();
        }
        let (samples, video_offset) = self
            .worker
            .take()
            .ok_or("The screen recorder is unavailable.")?
            .join()
            .map_err(|_| "Screen capture stopped unexpectedly.")??;
        let marks = self
            .shared
            .marks
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .clone();
        let events: Vec<Moment> = self
            .shared
            .events
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .iter()
            .filter(|event| event.at_ms <= duration)
            .cloned()
            .collect();
        let moments = packet::select(&samples, &marks, &events, duration);
        let times: Vec<u64> = moments
            .iter()
            .map(|moment| moment.at_ms.saturating_sub(video_offset))
            .collect();
        let argument =
            serde_json::to_string(&times).map_err(|_| "Could not prepare capture times.")?;
        crate::visual_capture_media::run(
            &self.directory,
            "frames",
            &self.directory.join("recording.mp4"),
            &argument,
            &self.shared.cancelled,
        )?;
        let mut frames = Vec::new();
        for (index, moment) in moments.iter().enumerate() {
            let source = self.directory.join(format!("source-{}.png", index + 1));
            let image = image::open(&source)
                .map_err(|_| "Could not read a full-resolution captured frame.")?
                .to_rgba8();
            frames.push(packet::frame(
                image,
                moment,
                &marks,
                &self.directory,
                index + 1,
            )?);
        }
        let timeline = serde_json::json!({"durationMs": duration, "marks": marks, "events": events, "moments": moments});
        std::fs::write(
            self.directory.join("timeline.json"),
            serde_json::to_vec_pretty(&timeline)
                .map_err(|_| "Could not serialize capture timeline.")?,
        )
        .map_err(|_| "Could not save capture timeline.")?;
        Ok(
            serde_json::json!({"frames": frames, "durationMs": duration, "instruction": instruction, "directory": self.directory.to_string_lossy()}),
        )
    }

    pub fn announce(
        &self,
        app: &tauri::AppHandle,
        id: &str,
        generation: u64,
    ) -> Result<(), String> {
        app.emit_to("spatial-ink", "o8:visual-capture-begin", serde_json::json!({"id": id, "generation": generation, "elapsedMs": self.shared.started.elapsed().as_millis()})).map_err(|_| "Could not show capture controls.".into())
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.shared.stopping.store(true, Ordering::Release);
        if let Some(handle) = self.input_worker.take() {
            let _ = handle.join();
        }
        if let Some(handle) = self.worker.take() {
            let _ = handle.join();
        }
    }
}
