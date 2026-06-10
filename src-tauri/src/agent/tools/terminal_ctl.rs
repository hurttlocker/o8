//! Terminal voice control — the dev frontier v1 (Terminal.app via JXA).
//!
//! "What terminals are up?", "what's the o8 terminal doing?", "tell the claude
//! in the rainwater terminal to run the backtest": survey and drive the user's
//! Terminal windows by voice, no click-first. Window NAMES carry the live
//! session story (cwd + Claude task title), so `term_list` alone answers
//! "what are they talking about". Targeting uses the window's stable `id` —
//! z-order indices shift every refocus, ids don't.
//!
//! `term_send` executes a line in a live shell (Terminal's `do script` types
//! AND submits) — Reversible in `safety`, so it ALWAYS rides the spoken
//! proposal + dock confirm card. Reads are ReadOnly.

use super::run_osascript_jxa;
use serde_json::{json, Value};

/// Embed a Rust string as a safe JS string literal.
fn js_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
}

/// `term_list` — every Terminal window/tab: stable id, title, busy state.
pub async fn list(_args: Value) -> Result<Value, String> {
    let script = r#"
        const term = Application("Terminal");
        if (!term.running()) throw new Error("Terminal is not running");
        const out = [];
        const wins = term.windows();
        for (let wi = 0; wi < wins.length; wi++) {
            const w = wins[wi];
            const tabs = w.tabs();
            for (let ti = 0; ti < tabs.length; ti++) {
                const t = tabs[ti];
                out.push({
                    id: w.id(),
                    tab: ti + 1,
                    title: String(w.name() || "").slice(0, 180),
                    busy: t.busy(),
                    selected: t.selected(),
                });
            }
        }
        JSON.stringify(out);
    "#;
    let out = run_osascript_jxa(script).map_err(spoken_err)?;
    let terminals: Vec<Value> = serde_json::from_str(&out).unwrap_or_default();
    Ok(json!({ "count": terminals.len(), "terminals": terminals }))
}

/// `term_read` — the last N visible lines of one terminal (by id from
/// `term_list`). Default 25 lines, cap 80; output capped at 6KB.
pub async fn read(args: Value) -> Result<Value, String> {
    let id = args.get("id").and_then(|v| v.as_i64()).ok_or(
        "term_read needs the terminal 'id' from term_list".to_string(),
    )?;
    let tab = args.get("tab").and_then(|v| v.as_i64()).unwrap_or(1).max(1);
    let lines = args.get("lines").and_then(|v| v.as_i64()).unwrap_or(25).clamp(1, 80);

    let script = format!(
        r#"
        const term = Application("Terminal");
        const w = term.windows().find(w => w.id() === {id});
        if (!w) throw new Error("no terminal window with that id — call term_list again");
        const tabs = w.tabs();
        const t = tabs[{tab_ix}] || tabs[0];
        const all = String(t.contents() || "").split("\n");
        while (all.length && !all[all.length - 1].trim()) all.pop();
        JSON.stringify({{ title: String(w.name() || "").slice(0, 180), lines: all.slice(-{lines}) }});
    "#,
        id = id,
        tab_ix = tab - 1,
        lines = lines
    );
    let out = run_osascript_jxa(&script).map_err(spoken_err)?;
    let parsed: Value = serde_json::from_str(&out)
        .map_err(|e| format!("couldn't parse the terminal contents: {e}"))?;
    let text = parsed
        .get("lines")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|l| l.as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    Ok(json!({
        "title": parsed.get("title").and_then(|v| v.as_str()).unwrap_or(""),
        "text": crate::utf8_head(&text, 6 * 1024),
    }))
}

/// `term_send` — type + submit one line in a terminal (Terminal's `do script`
/// in an existing tab). The confirm card has already named the command and the
/// target by the time this runs.
pub async fn send(args: Value) -> Result<Value, String> {
    let id = args.get("id").and_then(|v| v.as_i64()).ok_or(
        "term_send needs the terminal 'id' from term_list".to_string(),
    )?;
    let tab = args.get("tab").and_then(|v| v.as_i64()).unwrap_or(1).max(1);
    let command = args
        .get("command")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if command.is_empty() {
        return Err("term_send needs a non-empty 'command'".into());
    }

    let script = format!(
        r#"
        const term = Application("Terminal");
        const w = term.windows().find(w => w.id() === {id});
        if (!w) throw new Error("no terminal window with that id — call term_list again");
        const tabs = w.tabs();
        const t = tabs[{tab_ix}] || tabs[0];
        term.doScript({cmd}, {{ in: t }});
        JSON.stringify({{ ok: true, title: String(w.name() || "").slice(0, 120) }});
    "#,
        id = id,
        tab_ix = tab - 1,
        cmd = js_str(command)
    );
    let out = run_osascript_jxa(&script).map_err(spoken_err)?;
    let parsed: Value = serde_json::from_str(&out).unwrap_or(json!({ "ok": true }));
    Ok(json!({
        "sent": true,
        "command": command,
        "terminal": parsed.get("title").and_then(|v| v.as_str()).unwrap_or(""),
    }))
}

/// `term_interrupt` — deliver a real Ctrl+C to a terminal's tty (the brake).
/// `do script (character id 3)` rides the tty line discipline, so the SIGINT
/// lands WITHOUT activating the window — verified live: a running `sleep`
/// died showing `^C` while the window stayed in the background.
pub async fn interrupt(args: Value) -> Result<Value, String> {
    send_raw(args, "String.fromCharCode(3)", "interrupted").await
}

/// `term_key` — press one named key in a terminal (raw tty bytes / escape
/// sequences, no focus steal). Enough to drive a TUI: answer a Claude Code
/// permission menu (y / n / digits / enter), back out of one (escape), or
/// move a selection (up / down). NOTE: Terminal's `do script` appends a
/// newline after the payload — harmless for y/n/digit menus (the Enter
/// confirms) and for escape on an empty composer, but it is NOT a
/// general-purpose keyboard.
pub async fn key(args: Value) -> Result<Value, String> {
    let key = args
        .get("key")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let js_payload = match key.as_str() {
        "enter" | "return" => "\"\"".to_string(), // do script's own newline IS the Enter
        "escape" | "esc" => "String.fromCharCode(27)".to_string(),
        "ctrl_c" | "ctrl-c" => "String.fromCharCode(3)".to_string(),
        "up" => "String.fromCharCode(27) + \"[A\"".to_string(),
        "down" => "String.fromCharCode(27) + \"[B\"".to_string(),
        k if k.len() == 1 && k.chars().all(|c| c.is_ascii_alphanumeric()) => {
            format!("\"{k}\"")
        }
        other => {
            return Err(format!(
                "I can press enter, escape, ctrl_c, up, down, or a single letter/digit — not '{other}'."
            ))
        }
    };
    send_raw(args, &js_payload, &format!("pressed {key}")).await
}

/// Shared raw-byte sender for interrupt/key.
async fn send_raw(args: Value, js_payload: &str, did: &str) -> Result<Value, String> {
    let id = args.get("id").and_then(|v| v.as_i64()).ok_or(
        "this tool needs the terminal 'id' from term_list".to_string(),
    )?;
    let tab = args.get("tab").and_then(|v| v.as_i64()).unwrap_or(1).max(1);
    let script = format!(
        r#"
        const term = Application("Terminal");
        const w = term.windows().find(w => w.id() === {id});
        if (!w) throw new Error("no terminal window with that id — call term_list again");
        const tabs = w.tabs();
        const t = tabs[{tab_ix}] || tabs[0];
        term.doScript({payload}, {{ in: t }});
        JSON.stringify({{ ok: true, title: String(w.name() || "").slice(0, 120) }});
    "#,
        id = id,
        tab_ix = tab - 1,
        payload = js_payload
    );
    let out = run_osascript_jxa(&script).map_err(spoken_err)?;
    let parsed: Value = serde_json::from_str(&out).unwrap_or(json!({}));
    Ok(json!({
        "done": did,
        "terminal": parsed.get("title").and_then(|v| v.as_str()).unwrap_or(""),
    }))
}

/// `term_new` — open a fresh Terminal window, optionally cd somewhere and
/// start a command ("open a new terminal in the o8 repo and start claude").
pub async fn new(args: Value) -> Result<Value, String> {
    let directory = args.get("directory").and_then(|v| v.as_str()).unwrap_or("").trim();
    let command = args.get("command").and_then(|v| v.as_str()).unwrap_or("").trim();

    let mut line = String::new();
    if !directory.is_empty() {
        // Spoken repo names resolve through o8's registry upstream; accept
        // absolute paths and ~ here.
        line.push_str(&format!("cd {} && ", shell_quote(directory)));
    }
    if command.is_empty() {
        // Trim the trailing " && " when there's no command.
        if line.ends_with(" && ") {
            line.truncate(line.len() - 4);
        }
    } else {
        line.push_str(command);
    }

    let script = format!(
        r#"
        const term = Application("Terminal");
        const t = term.doScript({cmd});
        term.activate();
        JSON.stringify({{ ok: true }});
    "#,
        cmd = js_str(&line)
    );
    run_osascript_jxa(&script).map_err(spoken_err)?;
    Ok(json!({ "opened": true, "running": if line.is_empty() { "a shell" } else { line.as_str() } }))
}

/// Quote a path for a shell line (single quotes, escaping embedded ones).
fn shell_quote(s: &str) -> String {
    if s.starts_with('~') && !s[1..].contains('\'') {
        // Leave ~ unquoted so the shell expands it.
        return s.replace(' ', "\\ ");
    }
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// `term_watch` — "tell me when that terminal finishes or needs me." Registers
/// a one-shot watch (poller + heuristics in `agent::term_watch`); Symon speaks
/// ONCE when the terminal goes idle, asks for input, or closes — then the
/// watch dies. ReadOnly: it only observes a window the user explicitly named.
pub fn watch(app: &tauri::AppHandle, args: Value) -> Result<Value, String> {
    let id = args.get("id").and_then(|v| v.as_i64()).ok_or(
        "term_watch needs the terminal 'id' from term_list".to_string(),
    )?;
    let title = args
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .split(" — ")
        .take(2)
        .collect::<Vec<_>>()
        .join(" — ");
    let title = if title.is_empty() { "that".to_string() } else { title };
    let count = crate::agent::term_watch::add(app, id, title.clone());
    Ok(json!({
        "watching": title,
        "active_watches": count,
        "note": "Symon will say one line when it finishes or asks for input; the watch expires quietly after 45 minutes.",
    }))
}

/// Terminal-not-running and consent timeouts both arrive as raw osascript
/// errors — keep them short and speakable.
fn spoken_err(e: String) -> String {
    if e.contains("not running") {
        "Terminal isn't running right now.".to_string()
    } else {
        e
    }
}
