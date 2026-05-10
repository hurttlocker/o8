use std::process::Command;
use std::sync::{Mutex, OnceLock};

// The Tauri parent spawns Node children (Next.js + ws-server) but must own
// their lifecycle explicitly. Dropping std::process::Child does not kill the
// process, so every spawn registers its PID here and every exit path drains it.
fn child_pids() -> &'static Mutex<Vec<u32>> {
    static CHILD_PIDS: OnceLock<Mutex<Vec<u32>>> = OnceLock::new();
    CHILD_PIDS.get_or_init(|| Mutex::new(Vec::new()))
}

/// Track a freshly spawned child so we can kill it on quit.
pub(crate) fn register_child(pid: u32) {
    if let Ok(mut guard) = child_pids().lock() {
        guard.push(pid);
    }
}

/// TERM + (after 1s) KILL every tracked child PID.
///
/// Idempotent: the registry is drained on first call, so repeated exit events
/// or a panic during shutdown cannot send another cleanup pass.
pub(crate) fn kill_tracked_children() {
    let pids = match child_pids().lock() {
        Ok(mut guard) => std::mem::take(&mut *guard),
        Err(_) => return,
    };
    if pids.is_empty() {
        return;
    }

    log::info!(
        "[shutdown] terminating {} tracked child PIDs: {:?}",
        pids.len(),
        pids
    );
    for pid in &pids {
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status();
    }

    std::thread::sleep(std::time::Duration::from_millis(1000));

    for pid in &pids {
        let alive = Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if alive {
            log::info!("[shutdown] PID {} survived TERM — sending KILL", pid);
            let _ = Command::new("kill")
                .args(["-KILL", &pid.to_string()])
                .status();
        }
    }
}

/// Install panic + Unix signal handlers before Tauri starts spawning children.
pub(crate) fn install_shutdown_handlers() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        prev(info);
        kill_tracked_children();
    }));

    #[cfg(unix)]
    {
        use signal_hook::consts::{SIGINT, SIGTERM};
        use signal_hook::iterator::Signals;
        match Signals::new([SIGTERM, SIGINT]) {
            Ok(mut signals) => {
                std::thread::spawn(move || {
                    if let Some(sig) = signals.forever().next() {
                        log::info!("[shutdown] received signal {} — killing children", sig);
                        kill_tracked_children();
                        unsafe {
                            libc::signal(sig, libc::SIG_DFL);
                            libc::raise(sig);
                        }
                    }
                });
            }
            Err(e) => {
                log::warn!("[shutdown] could not install signal handler: {}", e);
            }
        }
    }
}

/// Reap a launchd-parented o8 child that is still listening on `port`.
///
/// This is intentionally narrower than "kill whatever owns the port": the
/// stale-UI failure comes from o8's own bundled Next/ws-server children being
/// orphaned after the Tauri parent exits. Unrelated local services must survive.
pub(crate) fn kill_o8_orphans_on_port(port: u16) {
    #[cfg(unix)]
    {
        kill_o8_orphans_on_port_unix(port);
    }

    #[cfg(not(unix))]
    {
        let _ = port;
    }
}

#[cfg(unix)]
fn kill_o8_orphans_on_port_unix(port: u16) {
    if std::net::TcpStream::connect(format!("127.0.0.1:{}", port)).is_err() {
        return;
    }

    let pids = listening_pids(port);
    if pids.is_empty() {
        log::warn!(
            "[port-orphan-reap] :{} appears bound but lsof returned no PIDs — skipping",
            port
        );
        return;
    }

    let mut killed = Vec::new();
    for pid in pids {
        if pid == std::process::id() {
            continue;
        }

        let ppid = crate::process_ppid(pid);
        let cwd = crate::process_cwd(pid);
        if ppid != 1 {
            log::info!(
                "[port-orphan-reap] :{} pid={} ppid={} is actively parented (cwd={:?}) — skipping",
                port,
                pid,
                ppid,
                cwd
            );
            continue;
        }

        if !crate::cwd_looks_o8_owned(&cwd) {
            log::info!(
                "[port-orphan-reap] :{} pid={} cwd={:?} not o8-owned — skipping",
                port,
                pid,
                cwd
            );
            continue;
        }

        log::info!(
            "[port-orphan-reap] reaping o8 orphan on :{} pid={} cwd={:?}",
            port,
            pid,
            cwd
        );
        crate::term_then_kill(pid);
        killed.push(pid);
    }

    if killed.is_empty() {
        return;
    }

    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(3000);
    while std::time::Instant::now() < deadline {
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
            log::info!(
                "[port-orphan-reap] :{} released after killing {:?}",
                port,
                killed
            );
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    log::warn!(
        "[port-orphan-reap] :{} still held after reaping {:?} — sidecar will probe higher port",
        port,
        killed
    );
}

#[cfg(unix)]
fn listening_pids(port: u16) -> Vec<u32> {
    match Command::new("lsof")
        .args(["-ti", &format!(":{}", port), "-sTCP:LISTEN"])
        .output()
    {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|s| s.trim().parse::<u32>().ok())
            .collect(),
        Ok(out) if !out.stderr.is_empty() => {
            log::warn!(
                "[port-orphan-reap] lsof for :{} failed: {}",
                port,
                String::from_utf8_lossy(&out.stderr).trim()
            );
            Vec::new()
        }
        _ => Vec::new(),
    }
}
