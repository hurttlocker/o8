//! Descriptor-anchored writes and undo for Symon's agent-output sandbox.

use sha2::{Digest, Sha256};
use std::ffi::{CString, OsStr};
use std::io::{Error, ErrorKind, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TEMP_WRITE_COUNTER: AtomicU64 = AtomicU64::new(0);

fn c_string(value: &OsStr) -> Result<CString, Error> {
    CString::new(value.as_bytes()).map_err(|_| {
        Error::new(
            ErrorKind::InvalidInput,
            "output path contains an embedded NUL byte",
        )
    })
}

fn last_error_with(context: &str) -> Error {
    let error = Error::last_os_error();
    Error::new(error.kind(), format!("{context}: {error}"))
}

fn open_directory_anchored(path: &Path, create_missing: bool) -> Result<OwnedFd, Error> {
    if !path.is_absolute() {
        return Err(Error::new(
            ErrorKind::InvalidInput,
            "agent output directory must be absolute",
        ));
    }
    let root = unsafe {
        libc::open(
            c"/".as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if root < 0 {
        return Err(last_error_with("open filesystem root"));
    }
    let mut directory = unsafe { OwnedFd::from_raw_fd(root) };
    for component in path.components() {
        let part = match component {
            std::path::Component::RootDir => continue,
            std::path::Component::Normal(part) => part,
            _ => {
                return Err(Error::new(
                    ErrorKind::InvalidInput,
                    "agent output directory contains an unsafe path component",
                ))
            }
        };
        let part = c_string(part)?;
        let mut child = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                part.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if child < 0 && create_missing && Error::last_os_error().kind() == ErrorKind::NotFound {
            let created = unsafe { libc::mkdirat(directory.as_raw_fd(), part.as_ptr(), 0o700) };
            if created < 0 && Error::last_os_error().kind() != ErrorKind::AlreadyExists {
                return Err(last_error_with("create safe output directory"));
            }
            child = unsafe {
                libc::openat(
                    directory.as_raw_fd(),
                    part.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
        }
        if child < 0 {
            return Err(last_error_with("open safe output directory"));
        }
        directory = unsafe { OwnedFd::from_raw_fd(child) };
    }
    Ok(directory)
}

fn open_parent(path: &Path, create_missing: bool) -> Result<(OwnedFd, CString), Error> {
    let parent = path
        .parent()
        .ok_or_else(|| Error::new(ErrorKind::InvalidInput, "output path has no parent"))?;
    let name = path
        .file_name()
        .ok_or_else(|| Error::new(ErrorKind::InvalidInput, "output path has no file name"))?;
    Ok((
        open_directory_anchored(parent, create_missing)?,
        c_string(name)?,
    ))
}

fn stat_at(parent: &OwnedFd, name: &CString) -> Result<Option<libc::stat>, Error> {
    let mut stat = unsafe { std::mem::zeroed::<libc::stat>() };
    let result = unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            name.as_ptr(),
            &mut stat,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result == 0 {
        Ok(Some(stat))
    } else {
        let error = Error::last_os_error();
        if error.kind() == ErrorKind::NotFound {
            Ok(None)
        } else {
            Err(Error::new(
                error.kind(),
                format!("inspect output target: {error}"),
            ))
        }
    }
}

fn validated_regular_mode(stat: &libc::stat) -> Result<u32, Error> {
    if stat.st_mode & libc::S_IFMT != libc::S_IFREG {
        return Err(Error::new(
            ErrorKind::PermissionDenied,
            "refusing a non-regular or symbolic link output target",
        ));
    }
    if stat.st_nlink > 1 {
        return Err(Error::new(
            ErrorKind::PermissionDenied,
            "refusing a file with multiple hard links",
        ));
    }
    Ok((stat.st_mode & 0o777) as u32)
}

fn create_temp_at(
    parent: &OwnedFd,
    name: &CString,
    bytes: &[u8],
    mode: u32,
) -> Result<CString, Error> {
    let display_name = String::from_utf8_lossy(name.as_bytes());
    let mut opened = None;
    for _ in 0..32 {
        let nonce = TEMP_WRITE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let temp_name = CString::new(format!(
            ".{display_name}.o8-write-{}-{nonce}",
            std::process::id()
        ))
        .expect("generated temp name cannot contain NUL");
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                temp_name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                mode,
            )
        };
        if fd >= 0 {
            opened = Some((temp_name, unsafe { std::fs::File::from_raw_fd(fd) }));
            break;
        }
        let error = Error::last_os_error();
        if error.kind() != ErrorKind::AlreadyExists {
            return Err(Error::new(
                error.kind(),
                format!("create output temp: {error}"),
            ));
        }
    }
    let (temp_name, mut file) = opened.ok_or_else(|| {
        Error::new(
            ErrorKind::AlreadyExists,
            "could not reserve an output temp file",
        )
    })?;
    let result = (|| {
        let chmod_result = unsafe { libc::fchmod(file.as_raw_fd(), mode as libc::mode_t) };
        if chmod_result < 0 {
            return Err(last_error_with("set output temp permissions"));
        }
        file.write_all(bytes)?;
        file.flush()?;
        file.sync_data()?;
        Ok(())
    })();
    drop(file);
    if let Err(error) = result {
        unsafe {
            libc::unlinkat(parent.as_raw_fd(), temp_name.as_ptr(), 0);
        }
        return Err(error);
    }
    Ok(temp_name)
}

fn unlink_at(parent: &OwnedFd, name: &CString, context: &str) -> Result<(), Error> {
    let removed = unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), 0) };
    if removed < 0 {
        Err(last_error_with(context))
    } else {
        Ok(())
    }
}

fn atomic_replace_at(
    parent: &OwnedFd,
    name: &CString,
    bytes: &[u8],
    mode: u32,
) -> Result<(), Error> {
    let temp_name = create_temp_at(parent, name, bytes, mode)?;
    let result = (|| {
        let renamed = unsafe {
            libc::renameat(
                parent.as_raw_fd(),
                temp_name.as_ptr(),
                parent.as_raw_fd(),
                name.as_ptr(),
            )
        };
        if renamed < 0 {
            return Err(last_error_with("replace output target"));
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = unlink_at(parent, &temp_name, "clean failed output temp");
    }
    result
}

fn write_file_anchored(path: &Path, bytes: &[u8]) -> Result<(), Error> {
    let (parent, name) = open_parent(path, true)?;
    let mode = match stat_at(&parent, &name)? {
        Some(stat) => validated_regular_mode(&stat)?,
        None => 0o600,
    };
    atomic_replace_at(&parent, &name, bytes, mode)
}

fn validate_displaced_target(
    parent: &OwnedFd,
    displaced_name: &CString,
    initial_metadata: &std::fs::Metadata,
    expected_sha256: &str,
) -> Result<(), Error> {
    use std::os::unix::fs::MetadataExt;

    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            displaced_name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(last_error_with("open displaced undo target"));
    }
    let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.nlink() > 1
        || metadata.dev() != initial_metadata.dev()
        || metadata.ino() != initial_metadata.ino()
    {
        return Err(Error::new(
            ErrorKind::Other,
            "file changed after Symon wrote it",
        ));
    }
    let mut current = Vec::new();
    file.read_to_end(&mut current)?;
    if hex::encode(Sha256::digest(&current)) != expected_sha256 {
        return Err(Error::new(
            ErrorKind::Other,
            "file changed after Symon wrote it",
        ));
    }
    Ok(())
}

fn restore_file_anchored_with_hook(
    path: &Path,
    existed: bool,
    previous: &[u8],
    expected_sha256: &str,
    before_swap: impl FnOnce(),
) -> Result<(), Error> {
    let (parent, name) = open_parent(path, false)?;
    let initial = stat_at(&parent, &name)?
        .ok_or_else(|| Error::new(ErrorKind::NotFound, "undo target no longer exists"))?;
    validated_regular_mode(&initial)?;
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(last_error_with("open undo target"));
    }
    let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(Error::new(
            ErrorKind::PermissionDenied,
            "undo target is not a regular file",
        ));
    }
    use std::os::unix::fs::MetadataExt;
    if metadata.nlink() > 1 {
        return Err(Error::new(
            ErrorKind::PermissionDenied,
            "undo target has multiple hard links",
        ));
    }
    let mut current = Vec::new();
    file.read_to_end(&mut current)?;
    if hex::encode(Sha256::digest(&current)) != expected_sha256 {
        return Err(Error::new(
            ErrorKind::Other,
            "file changed after Symon wrote it",
        ));
    }
    let replacement = if existed { previous } else { &[] };
    let mode = if existed {
        metadata.mode() & 0o777
    } else {
        0o600
    };
    let temp_name = create_temp_at(&parent, &name, replacement, mode)?;
    before_swap();
    let swapped = unsafe {
        libc::renameatx_np(
            parent.as_raw_fd(),
            temp_name.as_ptr(),
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::RENAME_SWAP,
        )
    };
    if swapped < 0 {
        let error = last_error_with("atomically swap undo target");
        let _ = unlink_at(&parent, &temp_name, "clean failed undo temp");
        return Err(error);
    }

    let validation = validate_displaced_target(&parent, &temp_name, &metadata, expected_sha256);
    if let Err(validation_error) = validation {
        let rolled_back = unsafe {
            libc::renameatx_np(
                parent.as_raw_fd(),
                temp_name.as_ptr(),
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::RENAME_SWAP,
            )
        };
        if rolled_back < 0 {
            return Err(Error::new(
                ErrorKind::Other,
                format!(
                    "undo target changed and atomic rollback failed; displaced data remains in a protected temp file: {}",
                    last_error_with("rollback undo target")
                ),
            ));
        }
        let _ = unlink_at(&parent, &temp_name, "clean rolled-back undo temp");
        return Err(validation_error);
    }

    if !existed {
        if let Err(error) = unlink_at(&parent, &name, "remove undo placeholder") {
            let rolled_back = unsafe {
                libc::renameatx_np(
                    parent.as_raw_fd(),
                    temp_name.as_ptr(),
                    parent.as_raw_fd(),
                    name.as_ptr(),
                    libc::RENAME_SWAP,
                )
            };
            if rolled_back == 0 {
                let _ = unlink_at(&parent, &temp_name, "clean rolled-back undo temp");
            }
            return Err(error);
        }
    }
    unlink_at(&parent, &temp_name, "remove displaced undo target")?;
    Ok(())
}

fn restore_file_anchored(
    path: &Path,
    existed: bool,
    previous: &[u8],
    expected_sha256: &str,
) -> Result<(), Error> {
    restore_file_anchored_with_hook(path, existed, previous, expected_sha256, || {})
}

fn remove_dir_anchored(path: &Path) -> Result<(), Error> {
    let (parent, name) = open_parent(path, false)?;
    let stat = stat_at(&parent, &name)?
        .ok_or_else(|| Error::new(ErrorKind::NotFound, "output directory no longer exists"))?;
    if stat.st_mode & libc::S_IFMT != libc::S_IFDIR {
        return Err(Error::new(
            ErrorKind::PermissionDenied,
            "refusing to remove a non-directory output path",
        ));
    }
    let removed = unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), libc::AT_REMOVEDIR) };
    if removed < 0 {
        return Err(last_error_with("remove created output directory"));
    }
    Ok(())
}

async fn run_blocking<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, Error> + Send + 'static,
) -> Result<T, Error> {
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| Error::other(format!("safe file task failed: {error}")))?
}

pub(crate) async fn ensure_directory_tree_no_symlinks(path: &Path) -> Result<(), Error> {
    let path = path.to_path_buf();
    run_blocking(move || open_directory_anchored(&path, true).map(drop)).await
}

pub(crate) async fn write_file_no_follow(path: &Path, bytes: &[u8]) -> Result<(), Error> {
    let path = path.to_path_buf();
    let bytes = bytes.to_vec();
    run_blocking(move || write_file_anchored(&path, &bytes)).await
}

pub(crate) async fn restore_file_if_sha256(
    path: &Path,
    existed: bool,
    previous: &[u8],
    expected_sha256: &str,
) -> Result<(), Error> {
    let path = path.to_path_buf();
    let previous = previous.to_vec();
    let expected_sha256 = expected_sha256.to_string();
    run_blocking(move || restore_file_anchored(&path, existed, &previous, &expected_sha256)).await
}

pub(crate) async fn remove_dir_no_follow(path: PathBuf) -> Result<(), Error> {
    run_blocking(move || remove_dir_anchored(&path)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn restore_atomically_rolls_back_a_change_after_the_initial_hash() {
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("safe-file-cas-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("note.txt");
        std::fs::write(&path, b"symon result").unwrap();
        let expected = hex::encode(Sha256::digest(b"symon result"));

        let error =
            restore_file_anchored_with_hook(&path, true, b"before symon", &expected, || {
                std::fs::write(&path, b"newer user edit").unwrap()
            })
            .unwrap_err();

        assert!(error.to_string().contains("changed after Symon wrote it"));
        assert_eq!(std::fs::read(&path).unwrap(), b"newer user edit");
        assert!(std::fs::read_dir(&directory).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("o8-write")));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn restore_preserves_exact_target_permissions() {
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("safe-file-mode-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("note.txt");
        std::fs::write(&path, b"symon result").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o660)).unwrap();
        let expected = hex::encode(Sha256::digest(b"symon result"));

        restore_file_anchored(&path, true, b"before symon", &expected).unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), b"before symon");
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o660
        );
        std::fs::remove_dir_all(directory).unwrap();
    }
}
