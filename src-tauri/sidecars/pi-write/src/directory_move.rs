//! Opt-in directory move. No file-write transaction or cleanup permission.
use super::{check, fstat, hook, lstat_path, refuse, rename_noreplace, report, stat_at, Id, DIR};
use serde::Deserialize;
use serde_json::json;
use std::io::{self, Read};
use std::path::{Component, Path};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Parent {
    path: String,
    dev: u64,
    ino: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    parent: Parent,
    source: String,
    destination: String,
    source_id: Id,
}

fn leaf(value: &str) -> bool {
    let mut parts = Path::new(value).components();
    matches!(parts.next(), Some(Component::Normal(_)))
        && parts.next().is_none()
        && !value.contains('/')
        && !value.contains('\\')
        && !value.contains('\0')
}
fn parent(request: &Request) -> io::Result<()> {
    let named = Path::new(&request.parent.path);
    if !named.is_absolute() || std::fs::canonicalize(named)? != named {
        return Err(refuse("Directory parent is redirected"));
    }
    let held = fstat(DIR)?;
    let observed = lstat_path(named)?;
    let expected = Id {
        dev: request.parent.dev,
        ino: request.parent.ino,
    };
    if !held.is(libc::S_IFDIR)
        || !observed.is(libc::S_IFDIR)
        || held.id != expected
        || observed.id != expected
    {
        return Err(refuse("Directory parent identity changed"));
    }
    Ok(())
}
fn execute() -> io::Result<()> {
    let mut input = Vec::new();
    io::stdin().take(16_385).read_to_end(&mut input)?;
    if input.len() > 16_384 {
        return Err(refuse("Directory request too large"));
    }
    let request: Request =
        serde_json::from_slice(&input).map_err(|_| refuse("Invalid directory request"))?;
    if !leaf(&request.source)
        || !leaf(&request.destination)
        || request.source == request.destination
    {
        return Err(refuse("Invalid directory names"));
    }
    parent(&request)?;
    hook("directory-before-rename");
    parent(&request)?;
    let source = stat_at(&request.source)?.ok_or_else(|| refuse("Directory source missing"))?;
    if !source.is(libc::S_IFDIR) || source.id != request.source_id {
        return Err(refuse("Directory source identity changed"));
    }
    // Atomic EEXIST refusal. Never substitute ordinary rename on unsupported filesystems.
    rename_noreplace(&request.source, &request.destination)?;
    check(unsafe { libc::fsync(DIR) })?;
    hook("directory-after-rename");
    parent(&request)?;
    let moved = stat_at(&request.destination)?.ok_or_else(|| refuse("Moved directory missing"))?;
    if !moved.is(libc::S_IFDIR)
        || moved.id != request.source_id
        || stat_at(&request.source)?.is_some()
    {
        return Err(refuse("Directory move result is ambiguous"));
    }
    report(json!({"schema":"o8/directory-no-replace/v1", "moved":true,
        "device":moved.id.dev,"inode":moved.id.ino}))?;
    Ok(())
}
pub fn run() -> i32 {
    match execute() {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("Directory move refused: {error}");
            1
        }
    }
}
