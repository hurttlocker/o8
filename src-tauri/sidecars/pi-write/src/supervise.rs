//! Command supervisor for the o8 Pi SDK worker (#3350).
//!
//! `o8-pi-write supervise <host-pid> <program> [args...]` runs one approved
//! command and ends every process it starts. On Linux the supervisor marks
//! itself a child subreaper, so any descendant whose parent exits is reparented
//! to the supervisor instead of init, whatever process group or session it moved
//! to. Every descendant therefore stays reachable by walking parent links in
//! /proc from the supervisor, and it is done only when `waitpid` reports no
//! children.
//!
//! The command runs in its own process group. When it exits, or the host sends
//! SIGTERM, SIGINT or SIGHUP, the supervisor sends TERM to every descendant,
//! waits up to 1.5 seconds, then sends KILL until none is left. If the host
//! dies, the parent-death signal starts the same teardown; the supervisor
//! refuses to start the command unless its parent is still the expected host.
//! Signals go through pidfds checked against each process's start time, so a
//! reused pid never receives one. The supervisor refuses to start the command
//! when pidfds are unavailable (kernels before 5.3, or a seccomp policy that
//! denies them), since teardown could not signal anything.
//!
//! macOS tracks forks, execs and exits with kqueue and registers descendants
//! recursively through libproc. It watches the host's exit too. A parent that
//! forks and exits before its fork event is handled can still leave a child
//! untracked, since macOS has no subreaper. Setup failure refuses before launch.
//!
//! With `--write <path>` options before the host pid (#3385), the supervisor
//! applies Landlock before it starts the command, so the command and everything
//! it starts can create, change, remove or rename files only beneath those
//! paths, and can neither connect nor bind TCP sockets. Reads stay as they are.
//! It needs Landlock ABI 4 (Linux 6.7) for the TCP rights; without it the
//! supervisor refuses to start the command, and the host never runs it
//! unconfined. Landlock does not cover file metadata (mode, owner, timestamps),
//! UDP, or Unix sockets.
//!
//! The receipt goes to fd 3, never to the command: one JSON line with the
//! command's exit code or signal and whether teardown was confirmed.
//!
//! Outside the tree, and so outside this guarantee: work handed to another
//! service (systemd, an already running daemon) over IPC.

use std::ffi::OsString;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::ffi::CString;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::os::unix::ffi::OsStrExt;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::time::{Duration, Instant};

#[cfg(any(target_os = "linux", target_os = "macos"))]
const RECEIPT: libc::c_int = 3;
/// Reaps per pass, so a stream of exiting orphans cannot hold teardown past its deadlines.
#[cfg(target_os = "linux")]
const REAP_BUDGET: usize = 4_096;

#[cfg(target_os = "linux")]
#[derive(Clone, Copy)]
struct Proc {
    pid: libc::pid_t,
    started: u64,
}

/// Parent pid and start time (clock ticks since boot) from /proc/<pid>/stat.
#[cfg(target_os = "linux")]
fn proc_stat(pid: libc::pid_t) -> Option<(libc::pid_t, u64)> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // The command name may contain spaces and parentheses; fields resume after the last ')'.
    let rest = &stat[stat.rfind(')')? + 1..];
    let fields: Vec<&str> = rest.split_whitespace().collect();
    // Field 4 (ppid) and field 22 (starttime) of proc(5), counted from field 3 here.
    Some((fields.get(1)?.parse().ok()?, fields.get(19)?.parse().ok()?))
}

/// Every live descendant of the supervisor. Zombies stay in the walk: a thread
/// group leader that exited while other threads still run shows as a zombie,
/// and its children still name it as their parent.
#[cfg(target_os = "linux")]
fn descendants() -> Vec<Proc> {
    let mut children: std::collections::HashMap<libc::pid_t, Vec<Proc>> = std::collections::HashMap::new();
    if let Ok(entries) = std::fs::read_dir("/proc") {
        for entry in entries.flatten() {
            let Ok(pid) = entry.file_name().to_string_lossy().parse::<libc::pid_t>() else { continue };
            let Some((ppid, started)) = proc_stat(pid) else { continue };
            children.entry(ppid).or_default().push(Proc { pid, started });
        }
    }
    let mut found = Vec::new();
    let mut pending = vec![unsafe { libc::getpid() }];
    while let Some(parent) = pending.pop() {
        for child in children.get(&parent).into_iter().flatten() {
            found.push(*child);
            pending.push(child.pid);
        }
    }
    found
}

/// Signals one process only if it is still the process that was scanned: the
/// pidfd pins whatever holds the pid, and the start time proves it is the same one.
#[cfg(target_os = "linux")]
fn signal_one(target: Proc, signal: libc::c_int) {
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, target.pid, 0) } as libc::c_int;
    if fd < 0 {
        // Gone already, or no pidfd for it; teardown keeps going until `waitpid` agrees.
        return;
    }
    if proc_stat(target.pid).map(|(_, started)| started) == Some(target.started) {
        unsafe {
            libc::syscall(libc::SYS_pidfd_send_signal, fd, signal, std::ptr::null::<libc::siginfo_t>(), 0);
        }
    }
    unsafe { libc::close(fd) };
}

/// True when this process can open a pidfd and send a signal through it, which
/// is everything teardown needs. Signal 0 only checks that delivery is allowed.
#[cfg(target_os = "linux")]
fn pidfds_usable() -> bool {
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, libc::getpid(), 0) } as libc::c_int;
    if fd < 0 {
        return false;
    }
    let sent = unsafe { libc::syscall(libc::SYS_pidfd_send_signal, fd, 0, std::ptr::null::<libc::siginfo_t>(), 0) };
    unsafe { libc::close(fd) };
    sent == 0
}

/// Reaps exited children within the budget; records the command's status when
/// it is among them. Returns true only when `waitpid` reports no child at all.
#[cfg(target_os = "linux")]
fn reap(command: libc::pid_t, status: &mut Option<libc::c_int>) -> bool {
    for _ in 0..REAP_BUDGET {
        let mut raw = 0;
        let pid = unsafe { libc::waitpid(-1, &mut raw, libc::WNOHANG) };
        if pid == command {
            *status = Some(raw);
        }
        if pid > 0 {
            continue;
        }
        // ECHILD: no child is left, live or zombie.
        return pid < 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ECHILD);
    }
    false
}

#[cfg(target_os = "linux")]
fn wait_signal(set: &libc::sigset_t, timeout: Duration) -> libc::c_int {
    let spec = libc::timespec { tv_sec: timeout.as_secs() as libc::time_t, tv_nsec: timeout.subsec_nanos() as libc::c_long };
    unsafe { libc::sigtimedwait(set, std::ptr::null_mut(), &spec) }
}

#[cfg(target_os = "linux")]
fn signal_all(signal: libc::c_int) {
    for target in descendants() {
        signal_one(target, signal);
    }
}

/// TERM, a grace period, then KILL until `waitpid` reports no child. Returns
/// false only if processes outlive the final deadline (for example a process
/// stuck in uninterruptible sleep).
#[cfg(target_os = "linux")]
fn teardown(set: &libc::sigset_t, command: libc::pid_t, status: &mut Option<libc::c_int>) -> bool {
    signal_all(libc::SIGTERM);
    let grace = Instant::now() + Duration::from_millis(1_500);
    while Instant::now() < grace {
        if reap(command, status) {
            return true;
        }
        wait_signal(set, Duration::from_millis(50));
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        signal_all(libc::SIGKILL);
        if reap(command, status) {
            return true;
        }
        wait_signal(set, Duration::from_millis(20));
    }
    reap(command, status)
}

// Landlock filesystem rights (linux/landlock.h).
#[cfg(target_os = "linux")]
const FS_WRITE_FILE: u64 = 1 << 1;
#[cfg(target_os = "linux")]
const FS_TRUNCATE: u64 = 1 << 14;
/// Every right that creates, changes, removes, renames or links: bits 1 and 4 to 14, through ABI 3.
#[cfg(target_os = "linux")]
const FS_WRITES: u64 = FS_WRITE_FILE | 0x7ff0;
/// TCP bind and connect. No port is allowed.
#[cfg(target_os = "linux")]
const NET_TCP: u64 = 0b11;
#[cfg(target_os = "linux")]
const RULE_PATH_BENEATH: libc::c_int = 1;

#[cfg(target_os = "linux")]
#[repr(C)]
struct RulesetAttr {
    handled_access_fs: u64,
    handled_access_net: u64,
}

#[cfg(target_os = "linux")]
#[repr(C, packed)]
struct PathBeneathAttr {
    allowed_access: u64,
    parent_fd: i32,
}

/// Grants writes beneath a directory, or to a single file. A missing path grants nothing.
#[cfg(target_os = "linux")]
fn allow_writes(ruleset: libc::c_int, path: &OsString) -> bool {
    let Ok(path) = CString::new(path.as_bytes()) else { return false };
    let fd = unsafe { libc::open(path.as_ptr(), libc::O_PATH | libc::O_CLOEXEC) };
    if fd < 0 {
        return std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT);
    }
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    let added = unsafe { libc::fstat(fd, &mut stat) } == 0 && {
        let directory = stat.st_mode & libc::S_IFMT == libc::S_IFDIR;
        let rule = PathBeneathAttr {
            allowed_access: if directory { FS_WRITES } else { FS_WRITE_FILE | FS_TRUNCATE },
            parent_fd: fd,
        };
        let added = unsafe {
            libc::syscall(libc::SYS_landlock_add_rule, ruleset, RULE_PATH_BENEATH, &rule as *const PathBeneathAttr, 0u32)
        };
        added == 0
    };
    unsafe { libc::close(fd) };
    added
}

/// Limits writes by this process and everything it starts to `paths`, and
/// denies TCP. False when Landlock is below ABI 4 or any step fails; the
/// command must not start then.
#[cfg(target_os = "linux")]
fn confine_writes(paths: &[OsString]) -> bool {
    let abi = unsafe {
        libc::syscall(libc::SYS_landlock_create_ruleset, std::ptr::null::<RulesetAttr>(), 0usize, 1u32)
    };
    if abi < 4 {
        return false;
    }
    let attr = RulesetAttr { handled_access_fs: FS_WRITES, handled_access_net: NET_TCP };
    let ruleset = unsafe {
        libc::syscall(libc::SYS_landlock_create_ruleset, &attr as *const RulesetAttr, std::mem::size_of::<RulesetAttr>(), 0u32)
    } as libc::c_int;
    if ruleset < 0 {
        return false;
    }
    let confined = paths.iter().all(|path| allow_writes(ruleset, path))
        && unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } == 0
        && unsafe { libc::syscall(libc::SYS_landlock_restrict_self, ruleset, 0u32) } == 0;
    unsafe { libc::close(ruleset) };
    confined
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn write_receipt(status: Option<libc::c_int>, confirmed: bool) {
    let (code, signal) = match status {
        Some(raw) if libc::WIFEXITED(raw) => (Some(libc::WEXITSTATUS(raw)), None),
        Some(raw) if libc::WIFSIGNALED(raw) => (None, Some(libc::WTERMSIG(raw))),
        _ => (None, None),
    };
    let line = serde_json::json!({ "code": code, "signal": signal, "confirmed": confirmed }).to_string() + "\n";
    unsafe { libc::write(RECEIPT, line.as_ptr().cast(), line.len()) };
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn run(_argv: &[OsString]) -> i32 {
    eprintln!("The command supervisor is available on Linux and macOS only.");
    125
}

#[cfg(target_os = "macos")]
pub use macos::run;

#[cfg(target_os = "linux")]
pub fn run(argv: &[OsString]) -> i32 {
    // The receipt is required; without fd 3 the host could not confirm teardown.
    if unsafe { libc::fcntl(RECEIPT, libc::F_SETFD, libc::FD_CLOEXEC) } != 0 {
        return 125;
    }
    let mut writes = Vec::new();
    let mut argv = argv;
    while argv.len() > 1 && argv[0] == "--write" {
        writes.push(argv[1].clone());
        argv = &argv[2..];
    }
    let Some(host) = argv.first().and_then(|arg| arg.to_str()).and_then(|arg| arg.parse::<libc::pid_t>().ok()) else {
        write_receipt(None, false);
        return 125;
    };
    if argv.len() < 2 {
        write_receipt(None, false);
        return 125;
    }
    // Nothing has started, so nothing is left behind.
    if !pidfds_usable() {
        eprintln!("The command supervisor needs pidfds (Linux 5.3 or later, not blocked by seccomp).");
        write_receipt(None, true);
        return 125;
    }
    let Ok(program) = argv[1..].iter().map(|arg| CString::new(arg.as_bytes())).collect::<Result<Vec<_>, _>>() else {
        write_receipt(None, false);
        return 125;
    };
    let mut set: libc::sigset_t = unsafe { std::mem::zeroed() };
    let mut previous: libc::sigset_t = unsafe { std::mem::zeroed() };
    unsafe {
        // Block first, so a parent-death signal arriving from here on stays
        // pending for the wait loop instead of ending the supervisor.
        libc::sigemptyset(&mut set);
        for signal in [libc::SIGCHLD, libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
            libc::sigaddset(&mut set, signal);
        }
        libc::sigprocmask(libc::SIG_BLOCK, &set, &mut previous);
        if libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0
            || libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM, 0, 0, 0) != 0
        {
            write_receipt(None, false);
            return 125;
        }
        // Armed now: if the expected host already died, the parent is someone
        // else and nothing would end this command on the host's death.
        if libc::getppid() != host {
            write_receipt(None, true);
            return 125;
        }
    }
    // Applied to the supervisor itself, so the command inherits it from the start.
    if !writes.is_empty() && !confine_writes(&writes) {
        eprintln!("The command supervisor could not confine the command (Landlock ABI 4, Linux 6.7 or later).");
        write_receipt(None, true);
        return 125;
    }
    let mut pointers: Vec<*const libc::c_char> = program.iter().map(|arg| arg.as_ptr()).collect();
    pointers.push(std::ptr::null());
    let command = unsafe { libc::fork() };
    if command < 0 {
        write_receipt(None, false);
        return 125;
    }
    if command == 0 {
        unsafe {
            libc::setpgid(0, 0);
            libc::sigprocmask(libc::SIG_SETMASK, &previous, std::ptr::null_mut());
            libc::execv(pointers[0], pointers.as_ptr());
            libc::_exit(127);
        }
    }
    let mut status = None;
    loop {
        let signal = wait_signal(&set, Duration::from_millis(250));
        reap(command, &mut status);
        if status.is_some() || matches!(signal, libc::SIGTERM | libc::SIGINT | libc::SIGHUP) {
            break;
        }
    }
    let confirmed = teardown(&set, command, &mut status);
    write_receipt(status, confirmed);
    match status {
        Some(raw) if libc::WIFEXITED(raw) => libc::WEXITSTATUS(raw),
        Some(raw) if libc::WIFSIGNALED(raw) => 128 + libc::WTERMSIG(raw),
        _ => 125,
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::collections::HashMap;

    struct Process {
        started: Option<(u64, u64)>,
        registered: bool,
    }

    struct Tree {
        queue: libc::c_int,
        host: libc::pid_t,
        tracked: HashMap<libc::pid_t, Process>,
        complete: bool,
    }

    /// `SZOMB` in sys/proc.h.
    const ZOMBIE: u32 = 5;

    // A zombie has exited and cannot run. kqueue refuses to watch it and
    // `kill(pid, 0)` still succeeds, so it is recognised by its status. Its pid
    // cannot be reused until it is reaped.
    fn gone(pid: libc::pid_t) -> bool {
        ((unsafe { libc::kill(pid, 0) }) < 0
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH))
            || process_info(pid).is_some_and(|info| info.pbi_status == ZOMBIE)
    }

    fn process_info(pid: libc::pid_t) -> Option<libc::proc_bsdinfo> {
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of_val(&info) as libc::c_int;
        let read = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), size) };
        (read == size).then_some(info)
    }

    fn started(pid: libc::pid_t) -> Option<(u64, u64)> {
        process_info(pid).map(|info| (info.pbi_start_tvsec, info.pbi_start_tvusec))
    }

    fn watch(queue: libc::c_int, ident: usize, filter: i16, fflags: u32) -> bool {
        watch_errno(queue, ident, filter, fflags).is_none()
    }

    /// The registration error, if any. `ESRCH` on a process means it has exited
    /// or is exiting, and an exiting process can no longer fork.
    fn watch_errno(queue: libc::c_int, ident: usize, filter: i16, fflags: u32) -> Option<i32> {
        let event = libc::kevent { ident, filter, flags: libc::EV_ADD | libc::EV_CLEAR, fflags, data: 0, udata: std::ptr::null_mut() };
        if (unsafe { libc::kevent(queue, &event, 1, std::ptr::null_mut(), 0, std::ptr::null()) }) == 0 { return None; }
        Some(std::io::Error::last_os_error().raw_os_error().unwrap_or(0))
    }

    fn children(parent: libc::pid_t) -> Option<Vec<libc::pid_t>> {
        let mut pids = vec![0; 64];
        loop {
            let bytes = pids.len().checked_mul(std::mem::size_of::<libc::pid_t>())?;
            let bytes = libc::c_int::try_from(bytes).ok()?;
            unsafe { *libc::__error() = 0 };
            // libproc returns a count of pids, not bytes. A full buffer is retried.
            let count = unsafe { libc::proc_listchildpids(parent, pids.as_mut_ptr().cast(), bytes) };
            if count < 0 || (count == 0 && std::io::Error::last_os_error().raw_os_error() != Some(0)) {
                return None;
            }
            if (count as usize) < pids.len() {
                pids.truncate(count as usize);
                pids.retain(|pid| *pid > 0);
                return Some(pids);
            }
            pids.resize(pids.len().checked_mul(2)?, 0);
        }
    }

    impl Tree {
        fn track(&mut self, pid: libc::pid_t, expected: Option<(u64, u64)>) -> bool {
            if self.tracked.contains_key(&pid) { return true; }
            // A process in exit has no readable info while `kill(pid, 0)` still
            // succeeds, so only two readable, different start times mean reuse.
            let identity = started(pid);
            if expected.is_some() && identity.is_some() && identity != expected {
                if gone(pid) { return true; }
                self.complete = false;
                return false;
            }
            let identity = identity.or(expected);
            let error = watch_errno(self.queue, pid as usize, libc::EVFILT_PROC, libc::NOTE_FORK | libc::NOTE_EXEC | libc::NOTE_EXIT);
            // kqueue refuses a process in exit with ESRCH; it can no longer fork.
            if error == Some(libc::ESRCH) { return true; }
            let registered = error.is_none();
            if !registered && gone(pid) { return true; }
            // Unreadable after registration: it exited since, and NOTE_EXIT will report it.
            let same = identity.is_some() && started(pid).is_none_or(|now| Some(now) == identity);
            if !registered || !same { self.complete = false; }
            self.tracked.insert(pid, Process { started: identity, registered });
            registered && same
        }

        fn discover(&mut self, parent: libc::pid_t) {
            let mut pending = vec![parent];
            while let Some(parent) = pending.pop() {
                let identity = self.tracked.get(&parent).and_then(|process| process.started);
                // A queued event belongs to the original process, even if its
                // numeric pid has since been reused. Never adopt that new tree.
                if identity.is_none() || started(parent) != identity { continue; }
                let Some(pids) = children(parent) else {
                    // A parent can exit before its fork event is handled.
                    if !gone(parent) { self.complete = false; }
                    continue;
                };
                for pid in pids {
                    if self.tracked.contains_key(&pid) { continue; }
                    if started(parent) != identity { break; }
                    let Some(info) = process_info(pid).filter(|info| info.pbi_ppid == parent as u32) else { continue; };
                    self.track(pid, Some((info.pbi_start_tvsec, info.pbi_start_tvusec)));
                    if self.tracked.contains_key(&pid) { pending.push(pid); }
                }
            }
        }

        // Only NOTE_EXIT confirms a registered process ended. Failed registrations
        // can be confirmed by ESRCH, never by an unreadable process table.
        fn events(&mut self, timeout: Duration) -> bool {
            let mut events: [libc::kevent; 64] = unsafe { std::mem::zeroed() };
            let spec = libc::timespec { tv_sec: timeout.as_secs() as libc::time_t, tv_nsec: timeout.subsec_nanos() as libc::c_long };
            let count = unsafe { libc::kevent(self.queue, std::ptr::null(), 0, events.as_mut_ptr(), events.len() as libc::c_int, &spec) };
            if count < 0 {
                if std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) { self.complete = false; }
                return !self.complete;
            }
            let mut stop = false;
            for event in &events[..count as usize] {
                if event.flags & libc::EV_ERROR != 0 { self.complete = false; stop = true; continue; }
                if event.filter == libc::EVFILT_SIGNAL { stop = true; continue; }
                let pid = event.ident as libc::pid_t;
                if pid == self.host {
                    if event.fflags & libc::NOTE_EXIT != 0 { stop = true; }
                    continue;
                }
                if event.fflags & (libc::NOTE_FORK | libc::NOTE_EXEC) != 0 { self.discover(pid); }
                if event.fflags & libc::NOTE_EXIT != 0 { self.tracked.remove(&pid); }
            }
            self.tracked.retain(|pid, process| process.registered || !gone(*pid));
            stop || !self.complete
        }

        fn signal_all(&self, signal: libc::c_int) {
            for (pid, process) in &self.tracked {
                // Drain exit events before signalling and check the start time,
                // so an observed pid reuse never receives a signal.
                if process.started.is_some() && started(*pid) == process.started {
                    unsafe { libc::kill(*pid, signal) };
                }
            }
        }

        fn teardown(&mut self, command: libc::pid_t, status: &mut Option<libc::c_int>) -> bool {
            self.events(Duration::ZERO);
            self.signal_all(libc::SIGTERM);
            let grace = Instant::now() + Duration::from_millis(1_500);
            let deadline = grace + Duration::from_secs(5);
            loop {
                self.events(Duration::from_millis(20));
                reap(command, status);
                if self.tracked.is_empty() && status.is_some() { return self.complete; }
                if Instant::now() >= deadline { return false; }
                // Children discovered during teardown get TERM too, then KILL.
                self.signal_all(if Instant::now() < grace { libc::SIGTERM } else { libc::SIGKILL });
            }
        }
    }

    impl Drop for Tree {
        fn drop(&mut self) { unsafe { libc::close(self.queue) }; }
    }

    fn reap(command: libc::pid_t, status: &mut Option<libc::c_int>) {
        if status.is_some() { return; }
        let mut raw = 0;
        if unsafe { libc::waitpid(command, &mut raw, libc::WNOHANG) } == command { *status = Some(raw); }
    }

    pub fn run(argv: &[OsString]) -> i32 {
        if unsafe { libc::fcntl(RECEIPT, libc::F_SETFD, libc::FD_CLOEXEC) } != 0 { return 125; }
        let Some(host) = argv.first().and_then(|arg| arg.to_str()).and_then(|arg| arg.parse::<libc::pid_t>().ok()).filter(|pid| *pid > 0) else {
            write_receipt(None, false);
            return 125;
        };
        if argv.len() < 2 { write_receipt(None, false); return 125; }
        let Ok(program) = argv[1..].iter().map(|arg| CString::new(arg.as_bytes())).collect::<Result<Vec<_>, _>>() else {
            write_receipt(None, false);
            return 125;
        };
        let queue = unsafe { libc::kqueue() };
        if queue < 0 { write_receipt(None, true); return 125; }
        let mut tree = Tree { queue, host, tracked: HashMap::new(), complete: true };
        let mut set: libc::sigset_t = unsafe { std::mem::zeroed() };
        let mut previous: libc::sigset_t = unsafe { std::mem::zeroed() };
        unsafe {
            libc::sigemptyset(&mut set);
            // A closed launch or receipt pipe must not interrupt teardown.
            for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP, libc::SIGPIPE] { libc::sigaddset(&mut set, signal); }
        }
        // All watches must work before the command is allowed to execute.
        let ready = unsafe { libc::fcntl(queue, libc::F_SETFD, libc::FD_CLOEXEC) } == 0
            && unsafe { libc::sigprocmask(libc::SIG_BLOCK, &set, &mut previous) } == 0
            && unsafe { libc::getppid() } == host
            && watch(queue, host as usize, libc::EVFILT_PROC, libc::NOTE_EXIT)
            && [libc::SIGTERM, libc::SIGINT, libc::SIGHUP].iter().all(|signal| watch(queue, *signal as usize, libc::EVFILT_SIGNAL, 0))
            && unsafe { libc::getppid() } == host;
        let mut gate = [0; 2];
        if !ready || unsafe { libc::pipe(gate.as_mut_ptr()) } != 0 {
            write_receipt(None, true);
            return 125;
        }
        let mut pointers: Vec<*const libc::c_char> = program.iter().map(|arg| arg.as_ptr()).collect();
        pointers.push(std::ptr::null());
        let command = unsafe { libc::fork() };
        if command == 0 {
            unsafe {
                libc::close(gate[1]);
                let mut byte = 0u8;
                let released = libc::read(gate[0], (&mut byte as *mut u8).cast(), 1) == 1;
                libc::close(gate[0]);
                if !released { libc::_exit(125); }
                libc::setpgid(0, 0);
                libc::sigprocmask(libc::SIG_SETMASK, &previous, std::ptr::null_mut());
                libc::execv(pointers[0], pointers.as_ptr());
                libc::_exit(127);
            }
        }
        unsafe { libc::close(gate[0]) };
        if command < 0 {
            unsafe { libc::close(gate[1]) };
            write_receipt(None, true);
            return 125;
        }
        if !tree.track(command, started(command)) {
            // Closing the gate makes the child exit without executing anything.
            unsafe { libc::close(gate[1]); libc::waitpid(command, std::ptr::null_mut(), 0); }
            write_receipt(None, true);
            return 125;
        }
        let released = unsafe { libc::write(gate[1], b"1".as_ptr().cast(), 1) } == 1;
        unsafe { libc::close(gate[1]) };
        let mut status = None;
        if released {
            loop {
                let stop = tree.events(Duration::from_millis(250));
                reap(command, &mut status);
                if stop || status.is_some() { break; }
            }
        }
        let confirmed = tree.teardown(command, &mut status);
        write_receipt(status, confirmed);
        match status {
            Some(raw) if libc::WIFEXITED(raw) => libc::WEXITSTATUS(raw),
            Some(raw) if libc::WIFSIGNALED(raw) => 128 + libc::WTERMSIG(raw),
            _ => 125,
        }
    }
}
