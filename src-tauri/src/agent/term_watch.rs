//! Terminal watcher — "tell me when that terminal finishes or needs me."
//!
//! The first Symon feature that speaks UNPROMPTED, so the contract is tight:
//! a watch exists only because the user asked for one by voice, it fires at
//! most ONCE, and it expires silently after 45 minutes. No ambient
//! surveillance — the poller only looks at explicitly watched windows and
//! stops entirely when no watches remain.
//!
//! Two completion signals, because "busy" lies for agent REPLs:
//!   - shell commands: the tab's `busy` flag goes true → false.
//!   - Claude Code (and similar TUIs): the foreground process never exits, so
//!     watch the tail instead — "esc to interrupt" marks WORKING; a composer
//!     prompt line ("❯") with no working marker means the turn finished.
//!     A permission menu ("Do you want", numbered ❯ options) fires "needs you".

use serde_json::json;
use std::sync::Mutex;

struct Watch {
    window_id: i64,
    /// Shortened title, spoken in the announcement.
    title: String,
    registered_at: std::time::Instant,
    /// Did we ever see this terminal working? (Prevents an instant fire when
    /// the watch starts on an already-idle terminal — we announce a
    /// TRANSITION, not a state.)
    saw_working: bool,
}

static WATCHES: Mutex<Vec<Watch>> = Mutex::new(Vec::new());
static POLLER_UP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

const EXPIRY: std::time::Duration = std::time::Duration::from_secs(45 * 60);

/// Register a watch (replaces an existing watch on the same window). Returns
/// the count of active watches.
pub fn add(app: &tauri::AppHandle, window_id: i64, title: String) -> usize {
    let count = {
        let mut watches = WATCHES.lock().unwrap_or_else(|p| p.into_inner());
        watches.retain(|w| w.window_id != window_id);
        watches.push(Watch {
            window_id,
            title,
            registered_at: std::time::Instant::now(),
            saw_working: false,
        });
        watches.len()
    };
    ensure_poller(app);
    count
}

fn ensure_poller(app: &tauri::AppHandle) {
    if POLLER_UP.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(5));
        let ids: Vec<i64> = {
            let mut watches = WATCHES.lock().unwrap_or_else(|p| p.into_inner());
            watches.retain(|w| w.registered_at.elapsed() < EXPIRY);
            watches.iter().map(|w| w.window_id).collect()
        };
        if ids.is_empty() {
            continue;
        }
        let Some(states) = probe(&ids) else { continue };
        for state in states {
            let fired = {
                let mut watches = WATCHES.lock().unwrap_or_else(|p| p.into_inner());
                let Some(pos) = watches.iter().position(|w| w.window_id == state.id) else {
                    continue;
                };
                if state.gone {
                    // Window closed — treat as finished.
                    Some((watches.remove(pos).title, "closed"))
                } else if state.working {
                    watches[pos].saw_working = true;
                    None
                } else if state.needs_input && watches[pos].saw_working {
                    Some((watches.remove(pos).title, "asking"))
                } else if state.idle && watches[pos].saw_working {
                    Some((watches.remove(pos).title, "finished"))
                } else {
                    None
                }
            };
            if let Some((title, what)) = fired {
                announce(&app, &title, what);
            }
        }
    });
}

struct ProbeState {
    id: i64,
    gone: bool,
    working: bool,
    idle: bool,
    needs_input: bool,
}

/// One JXA round-trip for all watched windows: busy flag + tail heuristics.
fn probe(ids: &[i64]) -> Option<Vec<ProbeState>> {
    let id_list = ids
        .iter()
        .map(|i| i.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let script = format!(
        r#"
        const term = Application("Terminal");
        const want = [{id_list}];
        const out = [];
        const wins = term.running() ? term.windows() : [];
        for (const id of want) {{
            const w = wins.find(w => {{ try {{ return w.id() === id; }} catch (e) {{ return false; }} }});
            if (!w) {{ out.push({{ id, gone: true }}); continue; }}
            const t = w.tabs()[0];
            const busy = t.busy();
            const tail = String(t.contents() || "").split("\n").filter(l => l.trim()).slice(-14);
            const tailStr = tail.join("\n");
            const working = tailStr.includes("esc to interrupt") || tailStr.includes("ctrl+c to interrupt");
            const prompt = tail.length ? tail[tail.length - 1].trim() : "";
            const composerIdle = !working && (tailStr.includes("❯") || /[%$]\s*$/.test(prompt));
            const needsInput = !working && (tailStr.includes("Do you want") || /❯\s*1\./.test(tailStr) || /\(y\/n\)/i.test(tailStr));
            out.push({{ id, gone: false, busy, working, idle: composerIdle && !busy ? true : (!busy || composerIdle), needsInput }});
        }}
        JSON.stringify(out);
    "#
    );
    let out = crate::agent::tools::run_osascript_jxa(&script).ok()?;
    let parsed: Vec<serde_json::Value> = serde_json::from_str(&out).ok()?;
    Some(
        parsed
            .iter()
            .map(|v| ProbeState {
                id: v.get("id").and_then(|x| x.as_i64()).unwrap_or(0),
                gone: v.get("gone").and_then(|x| x.as_bool()).unwrap_or(false),
                working: v.get("working").and_then(|x| x.as_bool()).unwrap_or(false),
                idle: v.get("idle").and_then(|x| x.as_bool()).unwrap_or(false),
                needs_input: v.get("needsInput").and_then(|x| x.as_bool()).unwrap_or(false),
            })
            .collect(),
    )
}

/// Speak the announcement + drop a dock glint. The watch already died — at
/// most one unprompted sentence per watch, ever.
fn announce(app: &tauri::AppHandle, title: &str, what: &str) {
    let line = match what {
        "asking" => format!("The {title} terminal is asking for something."),
        "closed" => format!("The {title} terminal closed."),
        _ => format!("The {title} terminal looks finished."),
    };
    log::info!("[term-watch] firing: {line}");
    crate::tts::playback::play_thread(line.clone(), crate::tts::load_config());
    let payload = json!({ "kind": "glint", "text": line });
    use tauri::Emitter;
    let _ = app.emit_to(crate::dock_window::DOCK_LABEL, "o8:agent-task-event", payload.clone());
    let _ = app.emit("o8:agent-task-event", payload);
}
