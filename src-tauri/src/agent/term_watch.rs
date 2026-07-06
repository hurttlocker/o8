//! Terminal watcher — "tell me when that terminal finishes or needs me."
//!
//! The first Symon feature that speaks UNPROMPTED, so the contract is tight:
//! a watch exists only because the user asked for one by voice, it fires at
//! most ONCE, and it expires silently after 45 minutes. No ambient
//! surveillance — the poller only looks at explicitly watched windows and
//! stops entirely when no watches remain.
//!
//! Two completion signals, because "busy" lies for agent REPLs:
//!   - shell commands: `busy` true with no visible prompt marks WORKING;
//!     busy dropping back to a prompt line means the command finished.
//!   - Claude Code (and similar TUIs): the foreground process never exits
//!     (busy stays true), so watch the tail instead — "esc to interrupt"
//!     marks WORKING; a composer prompt ("❯") with no working marker means
//!     the turn finished. A permission menu ("Do you want", numbered ❯
//!     options) fires "needs you".

use serde_json::json;
use std::sync::Mutex;

struct Watch {
    /// Backend-tagged token (`t:<winid>:<tab>` or `i:<guid>`) from term_list.
    token: String,
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

/// Register a watch (replaces an existing watch on the same terminal). Returns
/// the count of active watches.
pub fn add(app: &tauri::AppHandle, token: String, title: String) -> usize {
    let count = {
        let mut watches = WATCHES.lock().unwrap_or_else(|p| p.into_inner());
        watches.retain(|w| w.token != token);
        watches.push(Watch {
            token,
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
        let tokens: Vec<String> = {
            let mut watches = WATCHES.lock().unwrap_or_else(|p| p.into_inner());
            watches.retain(|w| w.registered_at.elapsed() < EXPIRY);
            watches.iter().map(|w| w.token.clone()).collect()
        };
        if tokens.is_empty() {
            continue;
        }
        let Some(states) = probe(&tokens) else {
            continue;
        };
        for state in states {
            let fired = {
                let mut watches = WATCHES.lock().unwrap_or_else(|p| p.into_inner());
                let Some(pos) = watches.iter().position(|w| w.token == state.id) else {
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
    id: String,
    gone: bool,
    working: bool,
    idle: bool,
    needs_input: bool,
}

/// One JXA round-trip for all watched terminals, across Terminal.app + iTerm2.
/// The completion HEURISTICS are identical (tail text); only how we fetch
/// `busy` + the tail differs per backend. Each watched token keeps its exact
/// string id so the poller matches it back.
fn probe(tokens: &[String]) -> Option<Vec<ProbeState>> {
    // JS array of the raw tokens; the script parses the prefix itself.
    let want = serde_json::to_string(tokens).ok()?;
    let script = format!(
        r#"
        function appRunning(name){{ try {{ return Application(name).running(); }} catch(e){{ return false; }} }}
        function tryStr(obj, keys){{ for (const k of keys){{ try {{ if (typeof obj[k] === "function"){{ const v = String(obj[k]() ?? ""); if (v) return v; }} }} catch(e){{}} }} return ""; }}
        function tryBool(obj, keys){{ for (const k of keys){{ try {{ if (typeof obj[k] === "function"){{ return !!obj[k](); }} }} catch(e){{}} }} return false; }}
        function sid(s){{ return tryStr(s, ["uniqueId","uniqueID","id"]); }}
        function sbusy(s){{ return tryBool(s, ["isProcessing"]); }}
        function stext(s){{ return tryStr(s, ["contents","text"]); }}
        // Classify a terminal from its busy flag + last lines.
        function classify(busy, contents){{
            const tail = String(contents || "").split("\n").filter(l => l.trim()).slice(-14);
            const tailStr = tail.join("\n");
            const tuiWorking = tailStr.includes("esc to interrupt") || tailStr.includes("ctrl+c to interrupt");
            const prompt = tail.length ? tail[tail.length - 1].trim() : "";
            const composerIdle = !tuiWorking && (tailStr.includes("❯") || /[%$]\s*$/.test(prompt));
            const working = tuiWorking || (busy && !composerIdle);
            const needsInput = !tuiWorking && (tailStr.includes("Do you want") || /❯\s*1\./.test(tailStr) || /\(y\/n\)/i.test(tailStr));
            return {{ working, idle: !busy || composerIdle, needsInput }};
        }}
        const want = {want};
        const out = [];
        const hasTerm = appRunning("Terminal");
        const hasITerm = appRunning("iTerm");
        const termWins = hasTerm ? Application("Terminal").windows() : [];
        for (const id of want) {{
            try {{
                if (id.indexOf("t:") === 0) {{
                    const parts = id.slice(2).split(":");
                    const winId = parseInt(parts[0], 10);
                    const tabIx = (parseInt(parts[1], 10) || 1) - 1;
                    const w = termWins.find(w => {{ try {{ return w.id() === winId; }} catch(e){{ return false; }} }});
                    if (!w) {{ out.push({{ id, gone: true }}); continue; }}
                    const t = w.tabs()[tabIx] || w.tabs()[0];
                    const c = classify(t.busy(), t.contents());
                    out.push({{ id, gone: false, working: c.working, idle: c.idle, needsInput: c.needsInput }});
                }} else if (id.indexOf("i:") === 0) {{
                    if (!hasITerm) {{ out.push({{ id, gone: true }}); continue; }}
                    const guid = id.slice(2);
                    let found = null;
                    const wins = Application("iTerm").windows();
                    for (let wi=0; wi<wins.length && !found; wi++){{
                        const tabs = wins[wi].tabs();
                        for (let ti=0; ti<tabs.length && !found; ti++){{
                            const sess = tabs[ti].sessions();
                            for (let si=0; si<sess.length; si++){{ if (sid(sess[si]) === guid){{ found = sess[si]; break; }} }}
                        }}
                    }}
                    if (!found) {{ out.push({{ id, gone: true }}); continue; }}
                    const c = classify(sbusy(found), stext(found));
                    out.push({{ id, gone: false, working: c.working, idle: c.idle, needsInput: c.needsInput }});
                }}
            }} catch(e){{ /* skip a flaky probe this tick */ }}
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
                id: v
                    .get("id")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                gone: v.get("gone").and_then(|x| x.as_bool()).unwrap_or(false),
                working: v.get("working").and_then(|x| x.as_bool()).unwrap_or(false),
                idle: v.get("idle").and_then(|x| x.as_bool()).unwrap_or(false),
                needs_input: v
                    .get("needsInput")
                    .and_then(|x| x.as_bool())
                    .unwrap_or(false),
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
    let _ = app.emit_to(
        crate::dock_window::DOCK_LABEL,
        "o8:agent-task-event",
        payload.clone(),
    );
    let _ = app.emit("o8:agent-task-event", payload);
}
