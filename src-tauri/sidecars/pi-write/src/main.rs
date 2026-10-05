//! Approved-write helper for the o8 Pi SDK worker (#3289).
//!
//! The host passes the verified parent directory as fd 3 and, when replacing,
//! the opened target as fd 4. Every mutation is relative to fd 3, so it follows
//! the directory itself even if another process moves it, and a recovery run
//! given the same descriptor still reaches it.
//!
//! - A new file is published with a no-replace rename: nothing at the name is
//!   ever overwritten.
//! - A replacement is one atomic exchange of the stage and the target, so the
//!   name is never absent. The swapped-out entry must be the approved target,
//!   or the publication is rolled back.
//! - The published inode, its link count, its bytes and the parent's location
//!   are verified before the commit point. The target's mode is applied before
//!   it too, so recovery past that point never touches the published file.
//! - Names are removed only after being captured under a fresh random name and
//!   checked; anything that is not ours goes back without overwriting.
//! - Any uncommitted failure wipes the stage inode through a descriptor before
//!   its last hidden name is dropped, so a hard-link alias keeps no approved
//!   bytes.
//! - The helper reports its stage identity, every captured name and the commit
//!   point on stdout, so the host can recover after a signal ends it.
//!
//! Request on stdin (JSON); exit 0 only when the approved bytes are published.

use std::ffi::{CStr, CString, OsStr};
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};

const MAX_BYTES: usize = 50_000;
const DIR: libc::c_int = 3;
const TARGET: libc::c_int = 4;

#[cfg(target_os = "macos")]
const NOREPLACE: libc::c_uint = libc::RENAME_EXCL;
#[cfg(target_os = "macos")]
const EXCHANGE: libc::c_uint = libc::RENAME_SWAP;
#[cfg(target_os = "linux")]
const NOREPLACE: libc::c_uint = libc::RENAME_NOREPLACE;
#[cfg(target_os = "linux")]
const EXCHANGE: libc::c_uint = libc::RENAME_EXCHANGE;

/// The host sends SIGTERM to abort or on timeout. Before publication the helper
/// stops at its next safe point and cleans up; publication itself runs to
/// completion or rollback.
static ABORTED: AtomicBool = AtomicBool::new(false);
extern "C" fn on_sigterm(_: libc::c_int) {
    ABORTED.store(true, Ordering::SeqCst);
}

#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
struct Id {
    dev: u64,
    ino: u64,
}

#[derive(Deserialize)]
struct Parent {
    path: String,
    dev: u64,
    ino: u64,
    root: Id,
}

#[derive(Deserialize, Clone)]
struct Capture {
    name: String,
    from: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    mode: String,
    root: String,
    parent: Parent,
    name: String,
    target: Option<Id>,
    before: Option<String>,
    content: String,
    stage: String,
    stage_id: Option<Id>,
    published_id: Option<Id>,
    committed: Option<bool>,
    captures: Option<Vec<Capture>>,
}

#[derive(Clone, Copy, Debug)]
struct Stat {
    id: Id,
    mode: u32,
    nlink: u64,
    size: i64,
}

impl Stat {
    fn is(&self, kind: libc::mode_t) -> bool {
        self.mode & libc::S_IFMT as u32 == kind as u32
    }
}

#[allow(clippy::unnecessary_cast)]
fn stat_from(raw: &libc::stat) -> Stat {
    Stat {
        id: Id { dev: raw.st_dev as u64, ino: raw.st_ino as u64 },
        mode: raw.st_mode as u32,
        nlink: raw.st_nlink as u64,
        size: raw.st_size as i64,
    }
}

fn refuse(reason: &str) -> io::Error {
    io::Error::other(reason.to_string())
}

fn check(ret: libc::c_int) -> io::Result<libc::c_int> {
    if ret < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(ret)
    }
}

fn is_errno(error: &io::Error, code: i32) -> bool {
    error.raw_os_error() == Some(code)
}

fn cstring(name: &str) -> io::Result<CString> {
    CString::new(name).map_err(|_| refuse("Invalid name"))
}

/// lstat of a name relative to the pinned directory; None when it is absent.
fn stat_at(name: &str) -> io::Result<Option<Stat>> {
    let name = cstring(name)?;
    let mut raw: libc::stat = unsafe { std::mem::zeroed() };
    let ret = unsafe { libc::fstatat(DIR, name.as_ptr(), &mut raw, libc::AT_SYMLINK_NOFOLLOW) };
    if ret < 0 {
        let error = io::Error::last_os_error();
        return if is_errno(&error, libc::ENOENT) { Ok(None) } else { Err(error) };
    }
    Ok(Some(stat_from(&raw)))
}

fn id_at(name: &str) -> Option<Id> {
    stat_at(name).ok().flatten().map(|stat| stat.id)
}

fn fstat(fd: libc::c_int) -> io::Result<Stat> {
    let mut raw: libc::stat = unsafe { std::mem::zeroed() };
    check(unsafe { libc::fstat(fd, &mut raw) })?;
    Ok(stat_from(&raw))
}

fn lstat_path(path: &Path) -> io::Result<Stat> {
    let path = CString::new(path.as_os_str().as_bytes()).map_err(|_| refuse("Invalid path"))?;
    let mut raw: libc::stat = unsafe { std::mem::zeroed() };
    check(unsafe { libc::lstat(path.as_ptr(), &mut raw) })?;
    Ok(stat_from(&raw))
}

fn open_at(name: &str, flags: libc::c_int, mode: libc::c_uint) -> io::Result<libc::c_int> {
    let name = cstring(name)?;
    check(unsafe { libc::openat(DIR, name.as_ptr(), flags | libc::O_CLOEXEC | libc::O_NOFOLLOW, mode) })
}

fn close(fd: libc::c_int) {
    unsafe { libc::close(fd) };
}

fn rename_with(from: &str, to: &str, flags: libc::c_uint) -> io::Result<()> {
    let (from, to) = (cstring(from)?, cstring(to)?);
    #[cfg(target_os = "macos")]
    let ret = unsafe { libc::renameatx_np(DIR, from.as_ptr(), DIR, to.as_ptr(), flags) };
    #[cfg(target_os = "linux")]
    let ret = unsafe { libc::renameat2(DIR, from.as_ptr(), DIR, to.as_ptr(), flags) };
    check(ret).map(|_| ())
}

/// Rename that fails with EEXIST instead of replacing anything at `to`.
fn rename_noreplace(from: &str, to: &str) -> io::Result<()> {
    rename_with(from, to, NOREPLACE)
}

/// Atomically swap two names.
fn exchange(a: &str, b: &str) -> io::Result<()> {
    rename_with(a, b, EXCHANGE)
}

fn read_all(fd: libc::c_int) -> io::Result<Vec<u8>> {
    let mut buffer = vec![0u8; MAX_BYTES + 1];
    let mut offset = 0usize;
    while offset < buffer.len() {
        let count = unsafe {
            libc::pread(fd, buffer[offset..].as_mut_ptr().cast(), buffer.len() - offset, offset as libc::off_t)
        };
        if count < 0 {
            let error = io::Error::last_os_error();
            if is_errno(&error, libc::EINTR) {
                continue;
            }
            return Err(error);
        }
        if count == 0 {
            break;
        }
        offset += count as usize;
    }
    buffer.truncate(offset);
    Ok(buffer)
}

fn write_all(fd: libc::c_int, bytes: &[u8]) -> io::Result<()> {
    let mut offset = 0usize;
    while offset < bytes.len() {
        let count = unsafe {
            libc::pwrite(fd, bytes[offset..].as_ptr().cast(), bytes.len() - offset, offset as libc::off_t)
        };
        if count < 0 {
            let error = io::Error::last_os_error();
            if is_errno(&error, libc::EINTR) {
                continue;
            }
            return Err(error);
        }
        offset += count as usize;
    }
    Ok(())
}

fn fchmod(fd: libc::c_int, mode: u32) -> io::Result<()> {
    check(unsafe { libc::fchmod(fd, mode as libc::mode_t) }).map(|_| ())
}

#[cfg(target_os = "macos")]
fn dir_path() -> io::Result<PathBuf> {
    let mut buffer = vec![0u8; libc::PATH_MAX as usize];
    check(unsafe { libc::fcntl(DIR, libc::F_GETPATH, buffer.as_mut_ptr()) })?;
    let path = unsafe { CStr::from_ptr(buffer.as_ptr().cast()) };
    Ok(PathBuf::from(OsStr::from_bytes(path.to_bytes())))
}

#[cfg(target_os = "linux")]
fn dir_path() -> io::Result<PathBuf> {
    std::fs::read_link("/proc/self/fd/3")
}

fn random_name(prefix: &str) -> io::Result<String> {
    let mut bytes = [0u8; 16];
    File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!("{prefix}{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32]))
}

fn report(message: Value) {
    let mut out = io::stdout().lock();
    let _ = writeln!(out, "{message}");
    let _ = out.flush();
}

/// Test builds run `<helper dir>/hook <point> <pid>` at named points and wait
/// for it, so a test can mutate the workspace at an exact step.
#[cfg(feature = "test-hooks")]
fn hook(point: &str) {
    use std::process::{Command, Stdio};
    let Some(script) = std::env::current_exe().ok().and_then(|exe| exe.parent().map(|dir| dir.join("hook"))) else {
        return;
    };
    if script.exists() {
        let _ = Command::new(script)
            .arg(point)
            .arg(std::process::id().to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .status();
    }
}

#[cfg(not(feature = "test-hooks"))]
#[inline(always)]
fn hook(_: &str) {}

fn aborted() -> io::Result<()> {
    if ABORTED.load(Ordering::SeqCst) {
        Err(refuse("Aborted"))
    } else {
        Ok(())
    }
}

fn safe_point(point: &str) -> io::Result<()> {
    hook(point);
    aborted()
}

fn protected(path: &Path) -> bool {
    path.components().any(|part| match part {
        Component::Normal(name) => {
            let name = name.to_string_lossy().to_lowercase();
            name == ".git" || name.starts_with(".env")
        }
        _ => true,
    })
}

fn txn_name(name: &str, prefix: &str) -> bool {
    name.strip_prefix(prefix).is_some_and(|rest| {
        rest.len() == 36 && rest.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte) || byte == b'-')
    })
}

fn validate(request: &Request) -> io::Result<()> {
    let name = Path::new(&request.name);
    let single = name.components().count() == 1 && matches!(name.components().next(), Some(Component::Normal(_)));
    let recover = request.mode == "recover";
    let valid = (request.mode == "commit" || recover)
        && single
        && !request.name.contains('/')
        && !protected(name)
        && request.content.len() <= MAX_BYTES
        && txn_name(&request.stage, ".o8-pi-write-")
        && request.target.is_some() == request.before.is_some()
        && (!recover || request.stage_id.is_some())
        && request.captures.as_ref().is_none_or(|captures| {
            captures
                .iter()
                .all(|captured| txn_name(&captured.name, ".o8-pi-q-") && (captured.from == request.name || captured.from == request.stage))
        });
    if valid {
        Ok(())
    } else {
        Err(refuse("Invalid commit"))
    }
}

/// Unlink a captured name only while it still holds the entry that was judged.
fn discard(name: &str, id: Id) -> io::Result<()> {
    if id_at(name) == Some(id) {
        let name = cstring(name)?;
        check(unsafe { libc::unlinkat(DIR, name.as_ptr(), 0) })?;
    }
    Ok(())
}

struct Txn<'a> {
    request: &'a Request,
    bytes: Vec<u8>,
    before: Option<Vec<u8>>,
    stage_fd: Option<libc::c_int>,
    writable: bool,
    stage_id: Option<Id>,
    /// What the publication step moved to the name: our stage inode, unless
    /// another process swapped something in at the stage name.
    published: Option<Id>,
    /// Replacement only: what the exchange left at the stage name.
    swapped_out: Option<Id>,
    /// Every captured name, from earlier runs and this one.
    captures: Vec<Capture>,
    /// Entries of others that could not be put back where they were.
    stranded: Vec<Id>,
    committed: bool,
}

impl<'a> Txn<'a> {
    fn new(request: &'a Request) -> io::Result<Self> {
        let before = match &request.before {
            Some(encoded) => {
                let decoded = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|_| refuse("Invalid commit"))?;
                if decoded.len() > MAX_BYTES {
                    return Err(refuse("Invalid commit"));
                }
                Some(decoded)
            }
            None => None,
        };
        Ok(Txn {
            request,
            bytes: request.content.as_bytes().to_vec(),
            before,
            stage_fd: None,
            writable: false,
            stage_id: request.stage_id,
            published: None,
            swapped_out: None,
            captures: request.captures.clone().unwrap_or_default(),
            stranded: Vec::new(),
            committed: false,
        })
    }

    fn parent_id(&self) -> Id {
        Id { dev: self.request.parent.dev, ino: self.request.parent.ino }
    }

    fn check_parent(&self) -> io::Result<()> {
        let request = self.request;
        let root = Path::new(&request.root);
        let parent = Path::new(&request.parent.path);
        let rel = parent.strip_prefix(root).map_err(|_| refuse("Parent changed"))?;
        if protected(rel) || std::fs::canonicalize(root)? != root || dir_path()? != parent {
            return Err(refuse("Parent changed"));
        }
        let root_stat = lstat_path(root)?;
        if !root_stat.is(libc::S_IFDIR) || root_stat.id != request.parent.root {
            return Err(refuse("Root changed"));
        }
        let mut current = root.to_path_buf();
        for part in rel.components() {
            current.push(part);
            if !lstat_path(&current)?.is(libc::S_IFDIR) {
                return Err(refuse("Parent alias changed"));
            }
        }
        if fstat(DIR)?.id != self.parent_id() || lstat_path(parent)?.id != self.parent_id() {
            return Err(refuse("Parent identity changed"));
        }
        Ok(())
    }

    /// The entry is the approved target, still with its approved bytes and no other names.
    fn approved_target(&self, entry: Option<Stat>) -> io::Result<bool> {
        let (Some(target), Some(entry), Some(before)) = (self.request.target, entry, self.before.as_ref()) else {
            return Ok(false);
        };
        let held = fstat(TARGET)?;
        Ok(entry.is(libc::S_IFREG)
            && entry.id == target
            && held.id == target
            && held.nlink == 1
            && held.size as usize <= MAX_BYTES
            && read_all(TARGET)? == *before)
    }

    fn check_target(&self) -> io::Result<()> {
        let at_name = stat_at(&self.request.name)?;
        let ok = match self.request.target {
            None => at_name.is_none(),
            Some(_) => self.approved_target(at_name)?,
        };
        if ok {
            Ok(())
        } else {
            Err(refuse("Target changed"))
        }
    }

    fn check_stage(&self) -> io::Result<()> {
        let (Some(fd), Some(id)) = (self.stage_fd, self.stage_id) else {
            return Err(refuse("No stage"));
        };
        let held = fstat(fd)?;
        if !held.is(libc::S_IFREG) || held.nlink != 1 || held.id != id || id_at(&self.request.stage) != Some(id) || read_all(fd)? != self.bytes {
            return Err(refuse("Staging file changed"));
        }
        Ok(())
    }

    /// Our inode is at the name with the approved bytes and no other names, and
    /// the parent is still where it was approved.
    fn publication_verified(&self) -> io::Result<bool> {
        let (Some(fd), Some(id)) = (self.stage_fd, self.stage_id) else {
            return Ok(false);
        };
        if id_at(&self.request.name) != Some(id) {
            return Ok(false);
        }
        let held = fstat(fd)?;
        Ok(held.nlink == 1 && read_all(fd)? == self.bytes && self.check_parent().is_ok())
    }

    /// The target's mode is applied before the commit is reported, so recovery
    /// past this point never changes the published file.
    fn commit_point(&mut self) -> io::Result<()> {
        if self.request.target.is_some() {
            let fd = self.stage_fd.ok_or_else(|| refuse("No stage"))?;
            fchmod(fd, fstat(TARGET)?.mode & 0o7777)?;
        }
        self.committed = true;
        report(json!({ "committed": true }));
        hook("committed");
        Ok(())
    }

    fn commit(&mut self) -> io::Result<()> {
        let request = self.request;
        self.check_parent()?;
        self.check_target()?;
        aborted()?;
        let fd = open_at(&request.stage, libc::O_RDWR | libc::O_CREAT | libc::O_EXCL, 0o600)?;
        self.stage_fd = Some(fd);
        self.writable = true;
        let id = fstat(fd)?.id;
        self.stage_id = Some(id);
        report(json!({ "stage": { "dev": id.dev, "ino": id.ino } }));
        hook("staged");
        write_all(fd, &self.bytes)?;
        check(unsafe { libc::fsync(fd) })?;
        safe_point("synced")?;
        self.check_target()?;
        self.check_parent()?;
        self.check_stage()?;
        hook("before-publish");
        // Publication. No safe point until it is committed or rolled back.
        if request.target.is_some() {
            exchange(&request.stage, &request.name)?;
            self.published = Some(id_at(&request.name).unwrap_or(id));
            self.swapped_out = id_at(&request.stage);
        } else {
            rename_noreplace(&request.stage, &request.name)?;
            self.published = Some(id_at(&request.name).unwrap_or(id));
        }
        if let Some(published) = self.published {
            report(json!({ "published": { "dev": published.dev, "ino": published.ino } }));
        }
        hook("after-publish");
        if request.target.is_some() && !self.approved_target(stat_at(&request.stage)?)? {
            return Err(refuse("Target changed"));
        }
        if !self.publication_verified()? {
            return Err(refuse("Publication changed"));
        }
        self.commit_point()?;
        self.finish()
    }

    /// After the commit point: remove the replaced target, which the exchange
    /// left at the stage name.
    fn finish(&mut self) -> io::Result<()> {
        if let Some(target) = self.request.target {
            self.remove_if(&self.request.stage, target)?;
        }
        Ok(())
    }

    /// Move whatever holds `name` to a fresh random name so it can be judged
    /// without a check-then-unlink race. The destination is reported first.
    fn capture(&mut self, name: &str) -> io::Result<Option<(String, Stat)>> {
        let held = random_name(".o8-pi-q-")?;
        report(json!({ "capture": held, "from": name }));
        self.captures.push(Capture { name: held.clone(), from: name.to_string() });
        match rename_noreplace(name, &held) {
            Ok(()) => {}
            Err(error) if is_errno(&error, libc::ENOENT) => return Ok(None),
            Err(error) => return Err(error),
        }
        hook("captured");
        let stat = stat_at(&held)?.ok_or_else(|| refuse("Capture vanished"))?;
        Ok(Some((held, stat)))
    }

    /// Put an entry of someone else's back without overwriting anything.
    fn put_back(&mut self, held: &str, id: Id, name: &str) -> io::Result<()> {
        match rename_noreplace(held, name) {
            Ok(()) => Ok(()),
            Err(error) => {
                self.stranded.push(id);
                if is_errno(&error, libc::EEXIST) {
                    Ok(())
                } else {
                    Err(error)
                }
            }
        }
    }

    /// Remove a name only if it holds `id`; put anything else back.
    fn remove_if(&mut self, name: &str, id: Id) -> io::Result<()> {
        let Some((held, stat)) = self.capture(name)? else {
            return Ok(());
        };
        if stat.id == id {
            discard(&held, id)
        } else {
            self.put_back(&held, stat.id, name)
        }
    }

    /// Take what the publication moved off the name and, for a replacement, put
    /// the swapped-out entry back without overwriting a save made since. Our
    /// inode stays under a captured name until cleanup has wiped it; anything
    /// else the publication moved goes back to the stage name it came from.
    fn rollback(&mut self) -> io::Result<()> {
        let request = self.request;
        let Some(published) = self.published else {
            return Ok(());
        };
        hook("before-rollback");
        if id_at(&request.name) != Some(published) {
            return Ok(());
        }
        let Some((held, stat)) = self.capture(&request.name)? else {
            return Ok(());
        };
        if stat.id != published {
            return self.put_back(&held, stat.id, &request.name);
        }
        if let Some(swapped) = self.swapped_out {
            if id_at(&request.stage) == Some(swapped) {
                hook("before-restore");
                match rename_noreplace(&request.stage, &request.name) {
                    Err(error) if !is_errno(&error, libc::EEXIST) => return Err(error),
                    _ => {}
                }
            }
        }
        if Some(published) != self.stage_id {
            self.put_back(&held, published, &request.stage)?;
        }
        Ok(())
    }

    /// Open our inode through a name that still holds it, verifying identity:
    /// for writing when the mode allows, else read-only. If a mode change left it
    /// unreadable and the name is one of ours, restore owner access there first.
    fn open_ours(&self, name: &str, id: Id, hidden: bool) -> Option<(libc::c_int, bool)> {
        let stat = stat_at(name).ok().flatten()?;
        if stat.id != id || !stat.is(libc::S_IFREG) {
            return None;
        }
        let verified = |fd: libc::c_int, writable: bool| {
            if fstat(fd).ok().map(|held| held.id) == Some(id) {
                Some((fd, writable))
            } else {
                close(fd);
                None
            }
        };
        for (flags, writable) in [(libc::O_RDWR, true), (libc::O_RDONLY, false)] {
            match open_at(name, flags | libc::O_NONBLOCK, 0) {
                Ok(fd) => return verified(fd, writable),
                Err(error) if is_errno(&error, libc::EACCES) => continue,
                Err(_) => return None,
            }
        }
        if !hidden {
            return None;
        }
        let path = cstring(name).ok()?;
        #[cfg(target_os = "macos")]
        let flags = libc::AT_SYMLINK_NOFOLLOW;
        #[cfg(target_os = "linux")]
        let flags = 0;
        unsafe { libc::fchmodat(DIR, path.as_ptr(), 0o600, flags) };
        let fd = open_at(name, libc::O_RDWR | libc::O_NONBLOCK, 0).ok()?;
        verified(fd, true)
    }

    fn hidden_names(&self) -> Vec<String> {
        let mut names = vec![self.request.stage.clone()];
        names.extend(self.captures.iter().map(|captured| captured.name.clone()));
        names
    }

    /// Get a writable descriptor for our inode: restore owner write access
    /// through the descriptor held, then reopen through one of our hidden names.
    fn reopen_writable(&mut self, id: Id) {
        if let Some(fd) = self.stage_fd {
            if let Ok(held) = fstat(fd) {
                let _ = fchmod(fd, (held.mode & 0o777) | 0o600);
            }
        }
        for name in self.hidden_names() {
            if let Some((fd, true)) = self.open_ours(&name, id, true) {
                if let Some(old) = self.stage_fd.replace(fd) {
                    close(old);
                }
                self.writable = true;
                return;
            }
        }
    }

    /// Put entries of others that an earlier run captured back where they were.
    /// With `committed`, also drop captured names of the replaced target.
    fn settle_captures(&mut self, committed: bool) -> io::Result<()> {
        for captured in self.captures.clone() {
            let Some(stat) = stat_at(&captured.name)? else {
                continue;
            };
            let ours = Some(stat.id) == self.stage_id;
            if committed && (ours || Some(stat.id) == self.request.target) {
                discard(&captured.name, stat.id)?;
            } else if !ours {
                self.put_back(&captured.name, stat.id, &captured.from)?;
            }
        }
        Ok(())
    }

    /// After a signal ended a run. Ownership comes only from the identity the
    /// commit reported. Past the commit point, recovery only finishes cleanup.
    /// Before it, recovery finishes a verified publication or rolls back.
    fn recover(&mut self) -> io::Result<()> {
        let request = self.request;
        if fstat(DIR)?.id != self.parent_id() {
            return Err(refuse("Parent changed"));
        }
        let id = request.stage_id.ok_or_else(|| refuse("No stage"))?;
        let mut names = vec![(request.name.clone(), false)];
        names.extend(self.hidden_names().into_iter().map(|name| (name, true)));
        for (name, hidden) in names {
            if let Some((fd, writable)) = self.open_ours(&name, id, hidden) {
                self.stage_fd = Some(fd);
                self.writable = writable;
                break;
            }
        }
        if request.committed == Some(true) {
            self.committed = true;
            self.settle_captures(true)?;
            return self.finish();
        }
        self.settle_captures(false)?;
        let at_name = id_at(&request.name);
        if at_name.is_some() && (at_name == Some(id) || at_name == request.published_id) {
            self.published = at_name;
            let swapped = stat_at(&request.stage)?;
            if request.target.is_some() {
                self.swapped_out = swapped.map(|stat| stat.id);
            }
            let verified = self.publication_verified()? && (request.target.is_none() || self.approved_target(swapped)?);
            if verified {
                self.commit_point()?;
                self.settle_captures(true)?;
                return self.finish();
            }
        }
        Err(refuse("Commit rolled back"))
    }

    /// Wipe an uncommitted stage inode through a writable descriptor, then drop
    /// our hidden names. Without a wipe the names stay, so nothing approved is
    /// left unreachable.
    fn cleanup(&mut self) {
        if let (false, Some(id)) = (self.committed, self.stage_id) {
            if !self.writable {
                self.reopen_writable(id);
            }
            let wiped = self.writable && self.stage_fd.is_some_and(|fd| unsafe { libc::ftruncate(fd, 0) } == 0);
            if wiped {
                for captured in self.captures.clone() {
                    let _ = discard(&captured.name, id);
                }
                let _ = self.remove_if(&self.request.stage, id);
            }
        }
        if let Some(fd) = self.stage_fd.take() {
            close(fd);
        }
    }

    /// Report where the entry that held the name before publication now is,
    /// when a failed write could not put it back: the approved target first.
    fn report_kept(&self) {
        let mut wanted: Vec<Id> = self.request.target.into_iter().chain(self.swapped_out).collect();
        wanted.extend(self.stranded.iter().copied());
        for id in wanted.into_iter().filter(|id| Some(*id) != self.stage_id) {
            if let Some(name) = self.hidden_names().into_iter().find(|name| id_at(name) == Some(id)) {
                report(json!({ "kept": name }));
                return;
            }
        }
    }
}

fn run() -> io::Result<bool> {
    let mut input = Vec::new();
    io::stdin().take((MAX_BYTES * 10 + 1) as u64).read_to_end(&mut input)?;
    if input.len() > MAX_BYTES * 10 {
        return Err(refuse("Request too large"));
    }
    let request: Request = serde_json::from_slice(&input).map_err(|_| refuse("Invalid commit"))?;
    validate(&request)?;
    let mut txn = Txn::new(&request)?;
    hook("start");
    let outcome = if request.mode == "recover" { txn.recover() } else { txn.commit() };
    if !txn.committed {
        let _ = txn.rollback();
    }
    txn.cleanup();
    if !txn.committed {
        txn.report_kept();
    }
    // A failure after the commit point leaves the write published.
    let _ = outcome;
    Ok(txn.committed)
}

fn main() {
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = on_sigterm as extern "C" fn(libc::c_int) as libc::sighandler_t;
        action.sa_flags = libc::SA_RESTART;
        libc::sigemptyset(&mut action.sa_mask);
        libc::sigaction(libc::SIGTERM, &action, std::ptr::null_mut());
    }
    std::process::exit(if matches!(run(), Ok(true)) { 0 } else { 1 });
}
