//! Immutable stream frames for inspection while drawing remains interactive.
use crate::visual_capture_packet::{self as packet, Mark, Moment};
use base64::Engine;
use screencapturekit::cm::{CMSampleBuffer, CMSampleBufferExt, CMSampleBufferSCExt};
use screencapturekit::prelude::SCStreamOutputType;
use screencapturekit::screenshot_manager::CGImageExt;
use screencapturekit::SCFrameStatus;
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Emitter;

const MAX_RETAINED_BYTES: usize = 128 * 1024 * 1024;
const MAX_AGE_MS: u64 = 250;

struct StreamFrame {
    sample: CMSampleBuffer,
    at_ms: u64,
    pts_ms: f64,
    valid_through: AtomicU64,
    bytes: usize,
    retained: Arc<AtomicUsize>,
}
impl Drop for StreamFrame {
    fn drop(&mut self) {
        self.retained.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}

#[derive(Clone)]
pub struct FrozenFrame {
    frame: Arc<StreamFrame>,
    valid_through: u64,
}
struct Work {
    mark: Mark,
    frame: Option<FrozenFrame>,
    revision: u64,
    webview_rect: Option<[f64; 4]>,
}

pub struct SnapshotPipeline {
    frames: Mutex<VecDeque<Arc<StreamFrame>>>,
    retained: Arc<AtomicUsize>,
    revision: AtomicU64,
    stopped: AtomicBool,
    sender: mpsc::SyncSender<Work>,
    started: Instant,
}

impl SnapshotPipeline {
    pub fn start(
        app: tauri::AppHandle,
        capture_id: String,
        generation: u64,
        directory: PathBuf,
        screen: [f64; 4],
        cancelled: Arc<AtomicBool>,
        started: Instant,
    ) -> Arc<Self> {
        let (sender, receiver) = mpsc::sync_channel::<Work>(1);
        let pipeline = Arc::new(Self {
            frames: Mutex::new(VecDeque::new()),
            retained: Arc::new(AtomicUsize::new(0)),
            revision: AtomicU64::new(0),
            stopped: AtomicBool::new(false),
            sender,
            started,
        });
        let weak = Arc::downgrade(&pipeline);
        let mut stored_paths: VecDeque<[PathBuf; 2]> = VecDeque::new();
        std::thread::spawn(move || loop {
            let Some(owner) = weak.upgrade() else {
                break;
            };
            if owner.stopped.load(Ordering::Acquire)
                || cancelled.load(Ordering::Acquire)
                || crate::spatial_ink_window::generation() != generation
            {
                break;
            }
            match receiver.recv_timeout(Duration::from_millis(20)) {
                Ok(work) => {
                    let revision = work.revision;
                    let result = snapshot(work, &directory, screen, &capture_id, generation);
                    if let Ok(value) = &result {
                        if let Some(id) = value["id"].as_str() {
                            stored_paths.push_back([
                                directory.join(format!("{id}-source.png")),
                                directory.join(format!("{id}.png")),
                            ]);
                            while stored_paths.len() > 12 {
                                if let Some(paths) = stored_paths.pop_front() {
                                    for path in paths {
                                        let _ = std::fs::remove_file(path);
                                    }
                                }
                            }
                        }
                    }
                    if owner.stopped.load(Ordering::Acquire)
                        || cancelled.load(Ordering::Acquire)
                        || crate::spatial_ink_window::generation() != generation
                        || revision != owner.revision.load(Ordering::Acquire)
                    {
                        continue;
                    }
                    match result {
                        Ok(mut value) => {
                            value["preparedAtMs"] =
                                serde_json::json!(
                                    owner.started.elapsed().as_millis().min(90_000) as u64
                                );
                            let _ = app.emit_to("main", "o8:visual-capture-observation", value);
                        }
                        Err(error) => {
                            let _ = app.emit_to("main", "o8:visual-capture-observation-error",
                            serde_json::json!({"captureId": capture_id, "generation": generation, "revision": revision, "error": error}));
                        }
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        });
        pipeline
    }

    pub fn observe(&self, sample: CMSampleBuffer, kind: SCStreamOutputType) {
        if kind != SCStreamOutputType::Screen || self.stopped.load(Ordering::Acquire) {
            return;
        }
        let Ok(mut frames) = self.frames.try_lock() else {
            return;
        };
        let at_ms = self.started.elapsed().as_millis() as u64;
        if sample.frame_status() == Some(SCFrameStatus::Idle) {
            if let Some(frame) = frames.back() {
                frame.valid_through.store(at_ms, Ordering::Release);
            }
            return;
        }
        if sample.frame_status() != Some(SCFrameStatus::Complete) {
            return;
        }
        let Some(pixel) = sample.pixel_buffer() else {
            return;
        };
        let bytes = pixel
            .width()
            .saturating_mul(pixel.height())
            .saturating_mul(4);
        if bytes == 0 || bytes > MAX_RETAINED_BYTES / 2 {
            return;
        }
        if frames.len() >= 2 {
            frames.pop_front();
        }
        if self.retained.load(Ordering::Acquire).saturating_add(bytes) > MAX_RETAINED_BYTES {
            return;
        }
        let pts = sample
            .output_presentation_timestamp()
            .as_seconds()
            .unwrap_or(f64::NAN)
            * 1000.0;
        if !pts.is_finite() || pts < 0.0 {
            return;
        }
        self.retained.fetch_add(bytes, Ordering::AcqRel);
        frames.push_back(Arc::new(StreamFrame {
            sample,
            at_ms,
            pts_ms: pts,
            valid_through: AtomicU64::new(at_ms),
            bytes,
            retained: self.retained.clone(),
        }));
    }

    pub fn freeze(&self, mark_at_ms: u64) -> Option<FrozenFrame> {
        let frames = self.frames.try_lock().ok()?;
        frames.iter().rev().find_map(|frame| {
            let valid_through = frame.valid_through.load(Ordering::Acquire).min(mark_at_ms);
            (frame.at_ms <= mark_at_ms && mark_at_ms.saturating_sub(valid_through) <= MAX_AGE_MS)
                .then(|| FrozenFrame {
                    frame: frame.clone(),
                    valid_through,
                })
        })
    }

    pub fn next_revision(&self) -> u64 {
        self.revision.fetch_add(1, Ordering::AcqRel) + 1
    }

    pub fn enqueue(
        &self,
        mark: Mark,
        frame: Option<FrozenFrame>,
        revision: u64,
        webview_rect: Option<[f64; 4]>,
    ) -> bool {
        self.sender
            .try_send(Work {
                mark,
                frame,
                revision,
                webview_rect,
            })
            .is_ok()
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        self.frames
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .clear();
    }
}
impl Drop for SnapshotPipeline {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
    }
}

fn fitted(image: image::RgbaImage) -> (image::RgbaImage, [f64; 4]) {
    let ratio = (1024.0 / image.width().max(image.height()) as f64).min(1.0);
    let width = (image.width() as f64 * ratio).round().max(1.0) as u32;
    let height = (image.height() as f64 * ratio).round().max(1.0) as u32;
    let resized =
        image::imageops::resize(&image, width, height, image::imageops::FilterType::Triangle);
    let mut output = image::RgbaImage::from_pixel(
        width.max(280),
        height.max(280),
        image::Rgba([24, 24, 24, 255]),
    );
    let x = (output.width() - width) / 2;
    let y = (output.height() - height) / 2;
    image::imageops::replace(&mut output, &resized, x as i64, y as i64);
    let rect = [
        x as f64 / output.width() as f64,
        y as f64 / output.height() as f64,
        width as f64 / output.width() as f64,
        height as f64 / output.height() as f64,
    ];
    (output, rect)
}

fn snapshot(
    work: Work,
    directory: &std::path::Path,
    screen: [f64; 4],
    capture_id: &str,
    generation: u64,
) -> Result<serde_json::Value, String> {
    let frozen = work
        .frame
        .ok_or("No sufficiently fresh screen frame belongs to this mark.")?;
    let marked_at = work.mark.points.last().ok_or("The mark is empty.")?.t;
    if marked_at.saturating_sub(frozen.valid_through) > MAX_AGE_MS {
        return Err("This screen frame is stale.".into());
    }
    let cg = frozen
        .frame
        .sample
        .cg_image()
        .map_err(|_| "Could not read the marked stream frame.")?;
    let rgba = cg
        .rgba_data()
        .map_err(|_| "Could not read the marked screen pixels.")?;
    let image = image::RgbaImage::from_raw(cg.width() as u32, cg.height() as u32, rgba)
        .ok_or("Invalid marked pixels.")?;
    let source_hash = hex::encode(Sha256::digest(image.as_raw()));
    let source_width = image.width();
    let source_height = image.height();
    let frame_at = frozen.frame.at_ms;
    let pts = frozen.frame.pts_ms;
    let valid_through = frozen.valid_through;
    drop(cg);
    drop(frozen);
    let id = format!("mark-{}", uuid::Uuid::new_v4());
    let moment = Moment {
        at_ms: marked_at,
        kind: "mark".into(),
        x: 0.0,
        y: 0.0,
    };
    let (marked, crop) =
        packet::marked_crop(image.clone(), &moment, std::slice::from_ref(&work.mark));
    let x = (crop[0] * source_width as f64).floor() as u32;
    let y = (crop[1] * source_height as f64).floor() as u32;
    let clean = image::imageops::crop_imm(&image, x, y, marked.width(), marked.height()).to_image();
    let actual_crop = [
        x as f64 / source_width as f64,
        y as f64 / source_height as f64,
        marked.width() as f64 / source_width as f64,
        marked.height() as f64 / source_height as f64,
    ];
    let (marked, content_rect) = fitted(marked);
    let (clean, _) = fitted(clean);
    let marked_bytes = packet::png(&marked)?;
    let clean_bytes = packet::png(&clean)?;
    if marked_bytes.len() + clean_bytes.len() > 1_500_000 {
        return Err("The marked image exceeds the inspection limit.".into());
    }
    std::fs::write(
        directory.join(format!("{id}-source.png")),
        packet::png(&image)?,
    )
    .map_err(|_| "Could not retain the original marked frame.")?;
    std::fs::write(directory.join(format!("{id}.png")), &marked_bytes)
        .map_err(|_| "Could not retain the marked image.")?;
    let points: Vec<_> = work
        .mark
        .points
        .iter()
        .map(|p| serde_json::json!({"x":p.x,"y":p.y,"tMs":p.t}))
        .collect();
    let mut result = serde_json::json!({"id":id,"captureId":capture_id,"generation":generation,"revision":work.revision,
        "frameAtMs":frame_at,"validThroughMs":valid_through,"markedAtMs":marked_at,"sourcePtsMs":pts,"timing":"stream-receipt",
        "sourceHash":source_hash,"imageHash":hex::encode(Sha256::digest(&marked_bytes)),"cleanHash":hex::encode(Sha256::digest(&clean_bytes)),
        "sourceWidth":source_width,"sourceHeight":source_height,"width":marked.width(),"height":marked.height(),"crop":actual_crop,"screen":screen,"contentRect":content_rect,
        "image":{"name":format!("{id}.png"),"dataUri":format!("data:image/png;base64,{}",base64::engine::general_purpose::STANDARD.encode(marked_bytes))},
        "cleanImage":{"name":format!("{id}-clean.png"),"dataUri":format!("data:image/png;base64,{}",base64::engine::general_purpose::STANDARD.encode(clean_bytes))},
        "strokes":[{"points":points}],"webviewRect":work.webview_rect});
    if work.webview_rect.is_none() {
        result.as_object_mut().unwrap().remove("webviewRect");
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn small_crops_are_padded_without_stretching_the_target() {
        let original = image::RgbaImage::from_pixel(80, 40, image::Rgba([1, 2, 3, 255]));
        let (padded, rect) = fitted(original);
        assert_eq!(padded.dimensions(), (280, 280));
        assert_eq!(*padded.get_pixel(100, 125), image::Rgba([1, 2, 3, 255]));
        assert_eq!(
            rect,
            [100.0 / 280.0, 120.0 / 280.0, 80.0 / 280.0, 40.0 / 280.0]
        );
    }
    #[test]
    fn large_crops_stay_inside_the_provider_limits() {
        let (image, rect) = fitted(image::RgbaImage::new(2560, 1440));
        assert_eq!(image.dimensions(), (1024, 576));
        assert_eq!(rect, [0.0, 0.0, 1.0, 1.0]);
    }
}
