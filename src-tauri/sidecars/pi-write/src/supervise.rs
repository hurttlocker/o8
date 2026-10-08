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
#[cfg(target_os = "linux")]
use std::ffi::CString;
#[cfg(target_os = "linux")]
use std::os::unix::ffi::OsStrExt;
#[cfg(target_os = "linux")]
use std::time::{Duration, Instant};

#[cfg(target_os = "linux")]
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

#[cfg(target_os = "linux")]
fn write_receipt(status: Option<libc::c_int>, confirmed: bool) {
    let (code, signal) = match status {
        Some(raw) if libc::WIFEXITED(raw) => (Some(libc::WEXITSTATUS(raw)), None),
        Some(raw) if libc::WIFSIGNALED(raw) => (None, Some(libc::WTERMSIG(raw))),
        _ => (None, None),
    };
    let line = serde_json::json!({ "code": code, "signal": signal, "confirmed": confirmed }).to_string() + "\n";
    unsafe { libc::write(RECEIPT, line.as_ptr().cast(), line.len()) };
}

#[cfg(not(target_os = "linux"))]
pub fn run(_argv: &[OsString]) -> i32 {
    // No subreaper on this platform; the host uses its own best-effort tracker.
    eprintln!("The command supervisor is available on Linux only.");
    125
}

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
