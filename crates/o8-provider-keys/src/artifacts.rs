//! Generated MCP snapshots share the credential lock; they are never source configuration.
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};
const ERROR: &str =
    "Owned MCP credential artifacts unavailable or unsafe; previous state preserved";
fn optional(path: &Path) -> Result<Option<fs::Metadata>, String> {
    match fs::symlink_metadata(path) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(ERROR.into()),
    }
}
fn owned(metadata: &fs::Metadata, base: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        metadata.uid() == base.uid()
    }
    #[cfg(not(unix))]
    {
        let _ = base;
        !metadata.file_type().is_symlink()
    }
}
fn directory(path: &Path, base: &fs::Metadata) -> Result<Option<fs::Metadata>, String> {
    let value = optional(path)?;
    if value
        .as_ref()
        .is_some_and(|m| !m.is_dir() || !owned(m, base))
    {
        return Err(ERROR.into());
    }
    Ok(value)
}
fn same(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if left.dev() != right.dev()
            || left.ino() != right.ino()
            || left.ctime() != right.ctime()
            || left.ctime_nsec() != right.ctime_nsec()
        {
            return false;
        }
    }
    left.modified().ok() == right.modified().ok()
}
fn artifact(name: &str) -> bool {
    name.strip_prefix("o8-worker-mcp-")
        .and_then(|s| s.strip_suffix(".json"))
        .is_some_and(|s| !s.is_empty() && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-'))
}
fn entries(
    path: &Path,
    base: &fs::Metadata,
    observed: &mut Vec<(PathBuf, fs::Metadata)>,
    visited: &mut usize,
) -> Result<Vec<fs::DirEntry>, String> {
    let Some(metadata) = directory(path, base)? else {
        return Ok(vec![]);
    };
    observed.push((path.into(), metadata));
    let values: Vec<_> = fs::read_dir(path)
        .map_err(|_| ERROR.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|_| ERROR.to_string())?;
    *visited += values.len();
    if *visited > 100_000 {
        return Err(ERROR.into());
    }
    Ok(values)
}
fn collect(
    path: &Path,
    base: &fs::Metadata,
    observed: &mut Vec<(PathBuf, fs::Metadata)>,
    visited: &mut usize,
    files: &mut Vec<fs::File>,
) -> Result<(), String> {
    for entry in entries(path, base, observed, visited)? {
        if !artifact(&entry.file_name().to_string_lossy()) {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path()).map_err(|_| ERROR.to_string())?;
        if !metadata.is_file() || !owned(&metadata, base) {
            return Err(ERROR.into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.nlink() != 1 {
                return Err(ERROR.into());
            }
        }
        if metadata.len() == 0 {
            continue;
        }
        let mut options = fs::OpenOptions::new();
        options.write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let file = options.open(entry.path()).map_err(|_| ERROR.to_string())?;
        if !same(&metadata, &file.metadata().map_err(|_| ERROR.to_string())?) {
            return Err(ERROR.into());
        }
        files.push(file);
    }
    Ok(())
}
/// Caller holds .provider-keys.lock. Fail before the authoritative store write.
pub(crate) fn purge(dir: &Path) -> Result<(), String> {
    let base = fs::symlink_metadata(dir).map_err(|_| ERROR.to_string())?;
    if !base.is_dir() {
        return Err(ERROR.into());
    }
    let mut observed = vec![];
    let mut visited = 0;
    let mut files = vec![];
    collect(
        &dir.join("worker-mcp-artifacts"),
        &base,
        &mut observed,
        &mut visited,
        &mut files,
    )?;
    let mut roots = BTreeSet::new();
    for entry in fs::read_dir(dir).map_err(|_| ERROR.to_string())? {
        let entry = entry.map_err(|_| ERROR.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.strip_prefix("owned-").is_some_and(|s| {
            !s.is_empty()
                && s.bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        }) {
            roots.insert(entry.path());
        }
    }
    for (name, value) in std::env::vars() {
        let token = name
            .strip_prefix("O8_OWNED_")
            .or_else(|| name.strip_prefix("CORTEX_IDE_OWNED_"))
            .and_then(|s| s.strip_suffix("_ROOT"));
        if !value.is_empty()
            && token.is_some_and(|s| {
                !s.is_empty()
                    && s.bytes()
                        .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_')
            })
        {
            let root: PathBuf = Path::new(&value).components().collect();
            if !root.is_absolute() {
                return Err(ERROR.into());
            }
            roots.insert(root.clone());
            roots.insert(PathBuf::from(format!("{}-archive", root.display())));
        }
    }
    let mut stable_roots = vec![];
    for root in roots {
        if let Some(metadata) = directory(&root, &base)? {
            stable_roots.push((root.clone(), metadata));
        }
        for entry in entries(&root, &base, &mut observed, &mut visited)? {
            let kind = entry.file_type().map_err(|_| ERROR.to_string())?;
            if kind.is_symlink() {
                return Err(ERROR.into());
            }
            if kind.is_dir() {
                collect(
                    &entry.path(),
                    &base,
                    &mut observed,
                    &mut visited,
                    &mut files,
                )?;
            }
        }
    }
    for (path, before) in observed {
        if !directory(&path, &base)?.is_some_and(|after| same(&before, &after)) {
            return Err(ERROR.into());
        }
    }
    for file in files {
        // Scrub the opened file, even if a checked parent directory was replaced.
        file.set_len(0).map_err(|_| ERROR.to_string())?;
    }
    for (path, before) in stable_roots {
        if !directory(&path, &base)?.is_some_and(|after| same(&before, &after)) {
            return Err(ERROR.into());
        }
    }
    Ok(())
}
