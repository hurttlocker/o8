use crate::desktop::{WindowHandle, create_error_response, create_success_response};
use crate::models::ScreenshotResponse;
use crate::shared::ScreenshotParams;
use crate::tools::take_screenshot::{process_image, process_image_to_file, process_thumbnail};
use crate::{Error, Result};
use image::DynamicImage;
use log::info;
use tauri::Runtime;

// Common function for handling the screenshot task and response
pub async fn handle_screenshot_task<F>(screenshot_fn: F) -> Result<ScreenshotResponse>
where
    F: FnOnce() -> Result<ScreenshotResponse> + Send + 'static,
{
    // Execute the platform-specific screenshot function in a blocking task
    let result = tokio::task::spawn_blocking(screenshot_fn)
        .await
        .map_err(|e| Error::WindowOperationFailed(format!("Task join error: {}", e)))?;

    // Handle the result consistently across platforms
    match result {
        Ok(response) => Ok(response),
        Err(e) => Ok(create_error_response(format!("{}", e))),
    }
}

/// Finalize a screenshot capture: branches on save_to_disk/thumbnail params to produce the right response.
pub fn finalize_screenshot(
    dynamic_image: DynamicImage,
    params: &ScreenshotParams,
) -> Result<ScreenshotResponse> {
    let save_to_disk = params.save_to_disk.unwrap_or(false);
    let thumbnail = params.thumbnail.unwrap_or(false);

    // Determine output directory
    let output_dir = params.output_dir.clone().unwrap_or_else(|| {
        let dir = std::env::temp_dir().join("tauri-mcp-screenshots");
        dir.to_string_lossy().to_string()
    });

    match (save_to_disk, thumbnail) {
        // Combo mode: save full image to disk + return thumbnail inline
        (true, true) => {
            let file_path = process_image_to_file(dynamic_image.clone(), params, &output_dir)?;
            let thumb_data_url = process_thumbnail(dynamic_image)?;
            info!(
                "[SCREENSHOT] Combo mode: thumbnail inline + file at {}",
                file_path
            );
            Ok(ScreenshotResponse {
                data: Some(thumb_data_url),
                success: true,
                error: None,
                file_path: Some(file_path),
                ..Default::default()
            })
        }
        // Save to disk only: no inline data
        (true, false) => {
            let file_path = process_image_to_file(dynamic_image, params, &output_dir)?;
            info!("[SCREENSHOT] Save-to-disk mode: file at {}", file_path);
            Ok(ScreenshotResponse {
                data: None,
                success: true,
                error: None,
                file_path: Some(file_path),
                ..Default::default()
            })
        }
        // Thumbnail only: return small thumbnail inline, no file
        (false, true) => {
            let thumb_data_url = process_thumbnail(dynamic_image)?;
            info!("[SCREENSHOT] Thumbnail-only mode");
            Ok(ScreenshotResponse {
                data: Some(thumb_data_url),
                success: true,
                error: None,
                file_path: None,
                ..Default::default()
            })
        }
        // Default: return full inline base64
        (false, false) => {
            let data_url = process_image(dynamic_image, params)?;
            Ok(create_success_response(data_url))
        }
    }
}

// Helper function to get window title from WindowHandle - supports both architectures
pub fn get_window_title_from_handle<R: Runtime>(handle: &WindowHandle<R>) -> Result<String> {
    match handle {
        WindowHandle::WebviewWindow(w) => match w.title() {
            Ok(title) => Ok(title),
            Err(e) => Err(Error::WindowOperationFailed(format!(
                "Failed to get window title: {}",
                e
            ))),
        },
        WindowHandle::Window(w) => match w.title() {
            Ok(title) => Ok(title),
            Err(e) => Err(Error::WindowOperationFailed(format!(
                "Failed to get window title: {}",
                e
            ))),
        },
    }
}
