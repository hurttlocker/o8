//! Semantic undo adapters for Symon's action ledger.
//!
//! This is intentionally separate from `SafetyClass`: a tool can require a
//! confirmation card without having a safe machine inverse. Only tools that
//! produce a guarded inverse token are advertised as undoable by the ledger.

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

const MAX_SNAPSHOT_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UndoCapability {
    Automatic,
    None,
}

pub fn capability(tool: &str) -> UndoCapability {
    match tool {
        "apply_text_edit"
        | "csv_write"
        | "fs_write_text"
        | "mac_calendar_create_event"
        | "mac_notes_create"
        | "mac_reminders_create" => UndoCapability::Automatic,
        _ => UndoCapability::None,
    }
}

#[derive(Debug)]
pub enum PreparedUndo {
    File {
        path: std::path::PathBuf,
        existed: bool,
        previous_base64: String,
        created_dirs: Vec<std::path::PathBuf>,
    },
    Edit,
    CreatedResource,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Inverse {
    RestoreFile {
        path: String,
        existed: bool,
        previous_base64: String,
        expected_sha256: String,
        #[serde(default)]
        created_dirs: Vec<String>,
    },
    RevertEdit {
        edit_id: String,
    },
    DeleteReminder {
        reminder_id: String,
        expected_sha256: String,
        created_list: Option<String>,
    },
    DeleteCalendarEvent {
        event_uid: String,
        expected_sha256: String,
    },
    DeleteNote {
        note_id: String,
        expected_sha256: String,
    },
}

impl Inverse {
    pub fn scope(&self) -> &'static str {
        match self {
            Self::RevertEdit { .. } => "edit_buffer",
            Self::RestoreFile { .. } => "file",
            Self::DeleteReminder { .. }
            | Self::DeleteCalendarEvent { .. }
            | Self::DeleteNote { .. } => "created_resource",
        }
    }
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn csv_output_path(args: &Value) -> Option<std::path::PathBuf> {
    let filename = args.get("filename")?.as_str()?.trim();
    if filename.is_empty() {
        return None;
    }
    let safe = std::path::Path::new(filename).file_name()?.to_str()?;
    Some(agent_output_dir().join(safe))
}

fn agent_output_dir() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    std::path::PathBuf::from(home)
        .join(".o8")
        .join("agent-output")
}

fn validate_file_inverse_path(
    path: &std::path::Path,
    sandbox: &std::path::Path,
) -> Result<(), String> {
    let has_traversal = path.components().any(|component| {
        !matches!(
            component,
            std::path::Component::Normal(_) | std::path::Component::RootDir
        )
    });
    if has_traversal || !path.starts_with(sandbox) {
        return Err("Stored undo target is outside Symon's agent-output sandbox".into());
    }
    Ok(())
}

async fn restore_file(
    path: &str,
    existed: bool,
    previous_base64: &str,
    expected_sha256: &str,
    created_dirs: &[String],
    sandbox: &std::path::Path,
) -> Result<Value, String> {
    validate_file_inverse_path(std::path::Path::new(path), sandbox)?;
    let previous = base64::engine::general_purpose::STANDARD
        .decode(previous_base64)
        .map_err(|error| format!("Stored undo snapshot is invalid: {error}"))?;
    super::tools::restore_file_if_sha256(
        std::path::Path::new(path),
        existed,
        &previous,
        expected_sha256,
    )
    .await
    .map_err(|error| format!("Cannot undo the file safely: {error}"))?;
    let mut removed_dirs = 0;
    for directory in created_dirs {
        let directory = std::path::Path::new(directory);
        let has_traversal = directory.components().any(|component| {
            !matches!(
                component,
                std::path::Component::Normal(_) | std::path::Component::RootDir
            )
        });
        if has_traversal || directory == sandbox || !directory.starts_with(sandbox) {
            continue;
        }
        match super::tools::remove_dir_no_follow(directory.to_path_buf()).await {
            Ok(()) => removed_dirs += 1,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
                ) => {}
            Err(error) => {
                log::warn!(
                    "[symon-ledger] could not remove created directory {}: {error}",
                    directory.display()
                );
            }
        }
    }
    Ok(serde_json::json!({
        "undone": true,
        "path": path,
        "created_dirs_removed": removed_dirs,
    }))
}

/// Snapshot pre-state before a supported action runs. Failure to snapshot is
/// deliberately non-fatal to the requested action; it simply receives no undo
/// token, which is more honest than claiming reversibility without the bytes.
pub fn prepare(tool: &str, args: &Value) -> Option<PreparedUndo> {
    let path = match tool {
        "fs_write_text" => args
            .get("path")
            .and_then(Value::as_str)
            .map(std::path::PathBuf::from),
        "csv_write" => csv_output_path(args),
        "apply_text_edit" => return Some(PreparedUndo::Edit),
        "mac_calendar_create_event" | "mac_notes_create" | "mac_reminders_create" => {
            return Some(PreparedUndo::CreatedResource)
        }
        _ => return None,
    }?;

    let (existed, previous) = match std::fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_symlink() => return None,
        Ok(_) => match std::fs::read(&path) {
            Ok(bytes) if bytes.len() <= MAX_SNAPSHOT_BYTES => (true, bytes),
            _ => return None,
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (false, Vec::new()),
        Err(_) => return None,
    };
    let mut created_dirs = Vec::new();
    if let Some(mut parent) = path.parent() {
        let sandbox = agent_output_dir();
        while parent != sandbox && parent.starts_with(&sandbox) && !parent.exists() {
            created_dirs.push(parent.to_path_buf());
            let Some(next) = parent.parent() else {
                break;
            };
            parent = next;
        }
    }
    Some(PreparedUndo::File {
        existed,
        path,
        previous_base64: base64::engine::general_purpose::STANDARD.encode(previous),
        created_dirs,
    })
}

/// Bind a prepared snapshot to the exact successful post-state. The post hash
/// makes undo fail closed if the user or another process changed the file since
/// Symon wrote it.
pub fn finalize(prepared: PreparedUndo, result: &Value) -> Option<Inverse> {
    match prepared {
        PreparedUndo::File {
            path,
            existed,
            previous_base64,
            created_dirs,
        } => {
            let current = std::fs::read(&path).ok()?;
            Some(Inverse::RestoreFile {
                path: path.to_string_lossy().to_string(),
                existed,
                previous_base64,
                expected_sha256: sha256(&current),
                created_dirs: created_dirs
                    .into_iter()
                    .map(|path| path.to_string_lossy().to_string())
                    .collect(),
            })
        }
        PreparedUndo::Edit => Some(Inverse::RevertEdit {
            edit_id: result.get("undo_handle")?.as_str()?.to_string(),
        }),
        PreparedUndo::CreatedResource => {
            let expected_sha256 = sha256(result.get("_ledger_fingerprint")?.as_str()?.as_bytes());
            let stable_id = |key: &str| {
                result
                    .get(key)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
            };
            if let Some(reminder_id) = stable_id("reminder_id") {
                Some(Inverse::DeleteReminder {
                    reminder_id: reminder_id.to_string(),
                    expected_sha256,
                    created_list: stable_id("_ledger_created_list").map(str::to_string),
                })
            } else if let Some(event_uid) = stable_id("event_uid") {
                Some(Inverse::DeleteCalendarEvent {
                    event_uid: event_uid.to_string(),
                    expected_sha256,
                })
            } else {
                stable_id("note_id").map(|note_id| Inverse::DeleteNote {
                    note_id: note_id.to_string(),
                    expected_sha256,
                })
            }
        }
    }
}

pub async fn execute(inverse: &Inverse, app: &tauri::AppHandle) -> Result<Value, String> {
    match inverse {
        Inverse::RestoreFile {
            path,
            existed,
            previous_base64,
            expected_sha256,
            created_dirs,
        } => restore_file(
            path,
            *existed,
            previous_base64,
            expected_sha256,
            created_dirs,
            &agent_output_dir(),
        )
        .await,
        Inverse::RevertEdit { edit_id } => {
            match super::edit_ctx::revert_for(app, edit_id)? {
                super::edit_ctx::RevertOutcome::Restored => {
                    Ok(serde_json::json!({ "undone": true, "edit_id": edit_id }))
                }
                super::edit_ctx::RevertOutcome::CopiedToClipboard => Err(
                    "The original was copied to the clipboard, but the edit could not be restored in place"
                        .to_string(),
                ),
            }
        }
        Inverse::DeleteReminder {
            reminder_id,
            expected_sha256,
            created_list,
        } => {
            super::tools::mac_reminders::delete_created(
                reminder_id,
                expected_sha256,
                created_list.as_deref(),
            )
            .await
        }
        Inverse::DeleteCalendarEvent {
            event_uid,
            expected_sha256,
        } => {
            super::tools::mac_calendar::delete_created(event_uid, expected_sha256).await
        }
        Inverse::DeleteNote {
            note_id,
            expected_sha256,
        } => {
            super::tools::mac_notes::delete_created(note_id, expected_sha256).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn carded_does_not_mean_undoable() {
        assert_eq!(capability("fs_write_text"), UndoCapability::Automatic);
        assert_eq!(capability("csv_write"), UndoCapability::Automatic);
        assert_eq!(capability("apply_text_edit"), UndoCapability::Automatic);
        assert_eq!(
            capability("mac_reminders_create"),
            UndoCapability::Automatic
        );
        assert_eq!(capability("o8_dispatch"), UndoCapability::None);
        assert_eq!(capability("o8_browser_act"), UndoCapability::None);
        assert_eq!(capability("o8_approve_item"), UndoCapability::None);
    }

    #[test]
    fn created_resources_bind_to_stable_ids() {
        assert!(finalize(
            PreparedUndo::CreatedResource,
            &serde_json::json!({ "reminder_id": "id-without-post-state" }),
        )
        .is_none());
        assert!(matches!(
            finalize(
                PreparedUndo::CreatedResource,
                &serde_json::json!({
                    "reminder_id": "x-apple-reminder://one",
                    "_ledger_fingerprint": "reminder-state",
                }),
            ),
            Some(Inverse::DeleteReminder { reminder_id, expected_sha256, .. })
                if reminder_id == "x-apple-reminder://one"
                    && expected_sha256 == sha256(b"reminder-state")
        ));
        assert!(matches!(
            finalize(
                PreparedUndo::CreatedResource,
                &serde_json::json!({
                    "event_uid": "calendar-uid",
                    "_ledger_fingerprint": "event-state",
                }),
            ),
            Some(Inverse::DeleteCalendarEvent { event_uid, expected_sha256 })
                if event_uid == "calendar-uid" && expected_sha256 == sha256(b"event-state")
        ));
        assert!(matches!(
            finalize(
                PreparedUndo::CreatedResource,
                &serde_json::json!({
                    "note_id": "note-id",
                    "_ledger_fingerprint": "note-state",
                }),
            ),
            Some(Inverse::DeleteNote { note_id, expected_sha256 })
                if note_id == "note-id" && expected_sha256 == sha256(b"note-state")
        ));
        let inverse = finalize(
            PreparedUndo::CreatedResource,
            &serde_json::json!({
                "note_id": "note-private",
                "_ledger_fingerprint": "private multiline\nbody",
            }),
        )
        .unwrap();
        assert!(!serde_json::to_string(&inverse)
            .unwrap()
            .contains("private multiline"));
    }

    #[test]
    fn file_inverse_round_trips_and_refuses_divergence() {
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("ledger-undo-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("note.txt");
        std::fs::write(&path, b"before").unwrap();

        let prepared = prepare(
            "fs_write_text",
            &serde_json::json!({ "path": path, "content": "after" }),
        )
        .unwrap();
        std::fs::write(&path, b"after").unwrap();
        let inverse = finalize(prepared, &serde_json::json!({ "success": true })).unwrap();

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let Inverse::RestoreFile {
            existed,
            previous_base64,
            expected_sha256,
            created_dirs,
            ..
        } = &inverse
        else {
            panic!("expected file inverse")
        };
        rt.block_on(restore_file(
            path.to_str().unwrap(),
            *existed,
            previous_base64,
            expected_sha256,
            created_dirs,
            &dir,
        ))
        .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"before");

        let prepared = prepare(
            "fs_write_text",
            &serde_json::json!({ "path": path, "content": "after again" }),
        )
        .unwrap();
        std::fs::write(&path, b"after again").unwrap();
        let inverse = finalize(prepared, &serde_json::json!({ "success": true })).unwrap();
        std::fs::write(&path, b"someone else changed it").unwrap();
        let Inverse::RestoreFile {
            existed,
            previous_base64,
            expected_sha256,
            created_dirs,
            ..
        } = &inverse
        else {
            panic!("expected file inverse")
        };
        let error = rt
            .block_on(restore_file(
                path.to_str().unwrap(),
                *existed,
                previous_base64,
                expected_sha256,
                created_dirs,
                &dir,
            ))
            .unwrap_err();
        assert!(error.contains("changed after Symon wrote it"));
        assert_eq!(std::fs::read(&path).unwrap(), b"someone else changed it");

        std::fs::write(&path, b"before symlink").unwrap();
        let prepared = prepare(
            "fs_write_text",
            &serde_json::json!({ "path": path, "content": "after symlink" }),
        )
        .unwrap();
        std::fs::write(&path, b"after symlink").unwrap();
        let inverse = finalize(prepared, &serde_json::json!({ "success": true })).unwrap();
        let outside = dir
            .parent()
            .unwrap()
            .join(format!("ledger-undo-outside-{}", std::process::id()));
        std::fs::write(&outside, b"after symlink").unwrap();
        std::fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(&outside, &path).unwrap();
        let Inverse::RestoreFile {
            existed,
            previous_base64,
            expected_sha256,
            created_dirs,
            ..
        } = &inverse
        else {
            panic!("expected file inverse")
        };
        let error = rt
            .block_on(restore_file(
                path.to_str().unwrap(),
                *existed,
                previous_base64,
                expected_sha256,
                created_dirs,
                &dir,
            ))
            .unwrap_err();
        assert!(error.contains("symbolic link"));
        assert_eq!(std::fs::read(&outside).unwrap(), b"after symlink");
        std::fs::remove_file(&outside).unwrap();

        std::fs::remove_file(&path).unwrap();
        let outside_hard = dir
            .parent()
            .unwrap()
            .join(format!("ledger-undo-hardlink-{}", std::process::id()));
        std::fs::write(&outside_hard, b"after hardlink").unwrap();
        std::fs::hard_link(&outside_hard, &path).unwrap();
        let error = rt
            .block_on(restore_file(
                path.to_str().unwrap(),
                true,
                &base64::engine::general_purpose::STANDARD.encode(b"before hardlink"),
                &sha256(b"after hardlink"),
                &[],
                &dir,
            ))
            .unwrap_err();
        assert!(error.contains("multiple hard links"));
        assert_eq!(std::fs::read(&outside_hard).unwrap(), b"after hardlink");
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_file(&outside_hard).unwrap();

        let first_created_dir = dir.join("new");
        let deepest_created_dir = first_created_dir.join("nested");
        let created_path = deepest_created_dir.join("created.txt");
        let prepared = PreparedUndo::File {
            path: created_path.clone(),
            existed: false,
            previous_base64: String::new(),
            created_dirs: vec![deepest_created_dir.clone(), first_created_dir.clone()],
        };
        std::fs::create_dir_all(&deepest_created_dir).unwrap();
        std::fs::write(&created_path, b"created").unwrap();
        let inverse = finalize(prepared, &serde_json::json!({ "success": true })).unwrap();
        let Inverse::RestoreFile {
            existed,
            previous_base64,
            expected_sha256,
            created_dirs,
            ..
        } = &inverse
        else {
            panic!("expected file inverse")
        };
        let result = rt
            .block_on(restore_file(
                created_path.to_str().unwrap(),
                *existed,
                previous_base64,
                expected_sha256,
                created_dirs,
                &dir,
            ))
            .unwrap();
        assert_eq!(result["created_dirs_removed"], 2);
        assert!(!first_created_dir.exists());

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
