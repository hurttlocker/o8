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

/// Terminal-not-running and consent timeouts both arrive as raw osascript
/// errors — keep them short and speakable.
fn spoken_err(e: String) -> String {
    if e.contains("not running") {
        "Terminal isn't running right now.".to_string()
    } else {
        e
    }
}
