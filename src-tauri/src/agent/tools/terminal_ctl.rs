//! Terminal voice control — the dev frontier (Terminal.app AND iTerm2 via JXA).
//!
//! "What terminals are up?", "what's the o8 terminal doing?", "tell the claude
//! in the rainwater terminal to run the backtest": survey and drive the user's
//! terminal windows by voice, no click-first. Window/session NAMES carry the
//! live story (cwd + Claude task title), so `term_list` alone answers "what are
//! they talking about".
//!
//! ## Backend-tagged ids (#1213)
//! Each terminal gets an opaque string `id` whose PREFIX names its app, so every
//! later tool self-routes with no separate detection call:
//!   - `t:<windowId>:<tab>` — Terminal.app (stable integer window id + tab #).
//!   - `i:<sessionGuid>`     — iTerm2 (stable per-session GUID; locates across
//!                              windows/tabs/splits on its own).
//! `term_list` enumerates BOTH apps when both run; the prefix keeps them
//! distinct. The model just passes back whatever id `term_list` gave it.
//!
//! `term_send` executes a line in a live shell (Terminal `do script` /
//! iTerm `write` both type AND submit) — Reversible in `safety`, so it ALWAYS
//! rides the spoken proposal + dock confirm card. Reads are ReadOnly.
//!
//! iTerm gotcha: `Application("iTerm").running()` THROWS (-2700) when iTerm
//! isn't installed, so every iTerm reference is try-wrapped in the JXA. The
//! session getters (`uniqueId`/`text`/`isProcessing`) vary across iTerm
//! versions, so helpers probe a few names each.

use super::run_osascript_jxa;
use serde_json::{json, Value};

/// Embed a Rust string as a safe JS string literal.
fn js_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
}

/// JS prelude shared by every script: app-running probe (iTerm-safe) + the
/// iTerm session helpers that tolerate version differences in getter names.
const JS_PRELUDE: &str = r#"
function appRunning(name){ try { return Application(name).running(); } catch(e){ return false; } }
function tryStr(obj, keys){ for (const k of keys){ try { if (typeof obj[k] === "function"){ const v = String(obj[k]() ?? ""); if (v) return v; } } catch(e){} } return ""; }
function tryBool(obj, keys){ for (const k of keys){ try { if (typeof obj[k] === "function"){ return !!obj[k](); } } catch(e){} } return false; }
function sid(s){ return tryStr(s, ["uniqueId","uniqueID","id"]); }
function sname(s){ return tryStr(s, ["name","profileName"]); }
function sbusy(s){ return tryBool(s, ["isProcessing"]); }
function stext(s){ return tryStr(s, ["contents","text"]); }
// Find an iTerm session by GUID across all windows/tabs/splits. Returns the
// session object or null. Caller guards with appRunning("iTerm").
function itermFind(guid){
  const it = Application("iTerm");
  const wins = it.windows();
  for (let wi=0; wi<wins.length; wi++){
    const tabs = wins[wi].tabs();
    for (let ti=0; ti<tabs.length; ti++){
      const sess = tabs[ti].sessions();
      for (let si=0; si<sess.length; si++){
        try { if (sid(sess[si]) === guid) return { s: sess[si], w: wins[wi] }; } catch(e){}
      }
    }
  }
  return null;
}
"#;

/// `term_list` — every terminal across Terminal.app + iTerm2: backend-tagged
/// id, title, busy state.
pub async fn list(_args: Value) -> Result<Value, String> {
    let script = format!(
        r#"{prelude}
        const out = [];
        if (appRunning("Terminal")) {{
            const term = Application("Terminal");
            const wins = term.windows();
            for (let wi=0; wi<wins.length; wi++){{
                const w = wins[wi];
                const tabs = w.tabs();
                for (let ti=0; ti<tabs.length; ti++){{
                    const t = tabs[ti];
                    out.push({{
                        id: "t:" + w.id() + ":" + (ti+1),
                        app: "Terminal",
                        title: String(w.name() || "").slice(0,180),
                        busy: t.busy(),
                        selected: t.selected(),
                    }});
                }}
            }}
        }}
        if (appRunning("iTerm")) {{
            const it = Application("iTerm");
            const wins = it.windows();
            for (let wi=0; wi<wins.length; wi++){{
                const w = wins[wi];
                let wname = ""; try {{ wname = String(w.name() || ""); }} catch(e){{}}
                let curId = ""; try {{ curId = sid(w.currentSession()); }} catch(e){{}}
                const tabs = w.tabs();
                for (let ti=0; ti<tabs.length; ti++){{
                    const sess = tabs[ti].sessions();
                    for (let si=0; si<sess.length; si++){{
                        const s = sess[si];
                        const id = sid(s);
                        if (!id) continue;
                        const nm = sname(s) || wname;
                        out.push({{
                            id: "i:" + id,
                            app: "iTerm",
                            title: String(nm || "").slice(0,180),
                            busy: sbusy(s),
                            selected: id === curId,
                        }});
                    }}
                }}
            }}
        }}
        JSON.stringify(out);
    "#,
        prelude = JS_PRELUDE
    );
    let out = run_osascript_jxa(&script).map_err(spoken_err)?;
    let terminals: Vec<Value> = serde_json::from_str(&out).unwrap_or_default();
    Ok(json!({ "count": terminals.len(), "terminals": terminals }))
}

/// A parsed terminal token (`t:<winid>:<tab>` or `i:<guid>`).
enum Target {
    Terminal { win_id: i64, tab: i64 },
    ITerm { guid: String },
}

fn parse_token(id: &str) -> Result<Target, String> {
    let id = id.trim();
    if let Some(rest) = id.strip_prefix("t:") {
        let mut parts = rest.splitn(2, ':');
        let win_id = parts
            .next()
            .and_then(|s| s.parse::<i64>().ok())
            .ok_or("malformed Terminal id — call term_list again")?;
        let tab = parts.next().and_then(|s| s.parse::<i64>().ok()).unwrap_or(1).max(1);
        Ok(Target::Terminal { win_id, tab })
    } else if let Some(rest) = id.strip_prefix("i:") {
        if rest.is_empty() {
            return Err("malformed iTerm id — call term_list again".into());
        }
        Ok(Target::ITerm { guid: rest.to_string() })
    } else {
        Err("unknown terminal id — call term_list to get a current one".into())
    }
}

fn token_arg(args: &Value) -> Result<Target, String> {
    let id = args
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or("this needs the terminal 'id' string from term_list".to_string())?;
    parse_token(id)
}

/// `term_read` — the last N visible lines of one terminal (by id from
/// `term_list`). Default 25 lines, cap 80; output capped at 6KB.
pub async fn read(args: Value) -> Result<Value, String> {
    let target = token_arg(&args)?;
    let lines = args.get("lines").and_then(|v| v.as_i64()).unwrap_or(25).clamp(1, 80);

    let body = match target {
        Target::Terminal { win_id, tab } => format!(
            r#"
            const term = Application("Terminal");
            const w = term.windows().find(w => w.id() === {win_id});
            if (!w) throw new Error("no Terminal window with that id — call term_list again");
            const tabs = w.tabs();
            const t = tabs[{tab_ix}] || tabs[0];
            const all = String(t.contents() || "").split("\n");
            while (all.length && !all[all.length - 1].trim()) all.pop();
            JSON.stringify({{ title: String(w.name() || "").slice(0,180), lines: all.slice(-{lines}) }});
        "#,
            win_id = win_id,
            tab_ix = tab - 1,
            lines = lines
        ),
        Target::ITerm { guid } => format!(
            r#"
            if (!appRunning("iTerm")) throw new Error("iTerm isn't running");
            const hit = itermFind({guid});
            if (!hit) throw new Error("no iTerm session with that id — call term_list again");
            const all = stext(hit.s).split("\n");
            while (all.length && !all[all.length - 1].trim()) all.pop();
            let title = sname(hit.s); try {{ if (!title) title = String(hit.w.name() || ""); }} catch(e){{}}
            JSON.stringify({{ title: String(title || "").slice(0,180), lines: all.slice(-{lines}) }});
        "#,
            guid = js_str(&guid),
            lines = lines
        ),
    };

    let script = format!("{}{}", JS_PRELUDE, body);
    let out = run_osascript_jxa(&script).map_err(spoken_err)?;
    let parsed: Value = serde_json::from_str(&out)
        .map_err(|e| format!("couldn't parse the terminal contents: {e}"))?;
    let text = parsed
        .get("lines")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|l| l.as_str()).collect::<Vec<_>>().join("\n"))
        .unwrap_or_default();
    Ok(json!({
        "title": parsed.get("title").and_then(|v| v.as_str()).unwrap_or(""),
        "text": crate::utf8_head(&text, 6 * 1024),
    }))
}

/// `term_send` — type + submit one line in a terminal (Terminal `do script` /
/// iTerm `write`; both type AND submit). The confirm card has already named the
/// command + target by the time this runs.
pub async fn send(args: Value) -> Result<Value, String> {
    let target = token_arg(&args)?;
    let command = args.get("command").and_then(|v| v.as_str()).unwrap_or("").trim();
    if command.is_empty() {
        return Err("term_send needs a non-empty 'command'".into());
    }
    run_in_target(target, &js_str(command), true, "sent").await.map(|title| {
        json!({ "sent": true, "command": command, "terminal": title })
    })
}

/// `term_interrupt` — deliver a real Ctrl+C to a terminal's tty (the brake).
/// On Terminal, `do script (char 3)` rides the tty line discipline (SIGINT, no
/// focus steal). On iTerm, `write newline:false` sends the raw byte.
pub async fn interrupt(args: Value) -> Result<Value, String> {
    let target = token_arg(&args)?;
    run_in_target(target, "String.fromCharCode(3)", false, "interrupted")
        .await
        .map(|title| json!({ "done": "interrupted", "terminal": title }))
}

/// `term_key` — press one named key in a terminal (raw tty bytes / escape
/// sequences, no focus steal). Enough to drive a TUI: answer a Claude Code
/// permission menu (y / n / digits / enter), back out (escape), or move a
/// selection (up / down).
pub async fn key(args: Value) -> Result<Value, String> {
    let target = token_arg(&args)?;
    let key = args.get("key").and_then(|v| v.as_str()).unwrap_or("").trim().to_lowercase();
    // `enter` is the submit newline; everything else is raw bytes WITHOUT an
    // added newline (Terminal's `do script` always appends one — harmless for
    // y/n/digit menus; iTerm honors newline:false exactly).
    let (payload, newline) = match key.as_str() {
        "enter" | "return" => ("\"\"".to_string(), true),
        "escape" | "esc" => ("String.fromCharCode(27)".to_string(), false),
        "ctrl_c" | "ctrl-c" => ("String.fromCharCode(3)".to_string(), false),
        "up" => ("String.fromCharCode(27) + \"[A\"".to_string(), false),
        "down" => ("String.fromCharCode(27) + \"[B\"".to_string(), false),
        k if k.len() == 1 && k.chars().all(|c| c.is_ascii_alphanumeric()) => {
            (format!("\"{k}\""), false)
        }
        other => {
            return Err(format!(
                "I can press enter, escape, ctrl_c, up, down, or a single letter/digit — not '{other}'."
            ))
        }
    };
    run_in_target(target, &payload, newline, &format!("pressed {key}"))
        .await
        .map(|title| json!({ "done": format!("pressed {key}"), "terminal": title }))
}

/// Shared executor: type `payload_js` (a JS string expression) into the target,
/// optionally submitting (newline). Returns the terminal's title for the reply.
async fn run_in_target(
    target: Target,
    payload_js: &str,
    newline: bool,
    _did: &str,
) -> Result<String, String> {
    let body = match target {
        Target::Terminal { win_id, tab } => format!(
            r#"
            const term = Application("Terminal");
            const w = term.windows().find(w => w.id() === {win_id});
            if (!w) throw new Error("no Terminal window with that id — call term_list again");
            const tabs = w.tabs();
            const t = tabs[{tab_ix}] || tabs[0];
            term.doScript({payload}, {{ in: t }});
            JSON.stringify({{ title: String(w.name() || "").slice(0,120) }});
        "#,
            win_id = win_id,
            tab_ix = tab - 1,
            payload = payload_js
        ),
        Target::ITerm { guid } => format!(
            r#"
            if (!appRunning("iTerm")) throw new Error("iTerm isn't running");
            const hit = itermFind({guid});
            if (!hit) throw new Error("no iTerm session with that id — call term_list again");
            hit.s.write({{ text: {payload}, newline: {newline} }});
            let title = sname(hit.s); try {{ if (!title) title = String(hit.w.name() || ""); }} catch(e){{}}
            JSON.stringify({{ title: String(title || "").slice(0,120) }});
        "#,
            guid = js_str(&guid),
            payload = payload_js,
            newline = newline
        ),
    };
    let script = format!("{}{}", JS_PRELUDE, body);
    let out = run_osascript_jxa(&script).map_err(spoken_err)?;
    let parsed: Value = serde_json::from_str(&out).unwrap_or(json!({}));
    Ok(parsed.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string())
}

/// `term_new` — open a fresh terminal window, optionally cd somewhere and start
/// a command. Prefers iTerm when it's running, else Terminal (always installed).
pub async fn new(args: Value) -> Result<Value, String> {
    let directory = args.get("directory").and_then(|v| v.as_str()).unwrap_or("").trim();
    let command = args.get("command").and_then(|v| v.as_str()).unwrap_or("").trim();

    let mut line = String::new();
    if !directory.is_empty() {
        line.push_str(&format!("cd {} && ", shell_quote(directory)));
    }
    if command.is_empty() {
        if line.ends_with(" && ") {
            line.truncate(line.len() - 4);
        }
    } else {
        line.push_str(command);
    }

    let script = format!(
        r#"{prelude}
        if (appRunning("iTerm")) {{
            const it = Application("iTerm");
            const w = it.createWindowWithDefaultProfile();
            const line = {cmd};
            if (line) {{ try {{ w.currentSession().write({{ text: line }}); }} catch(e){{}} }}
            it.activate();
            JSON.stringify({{ ok: true, app: "iTerm" }});
        }} else {{
            const term = Application("Terminal");
            term.doScript({cmd});
            term.activate();
            JSON.stringify({{ ok: true, app: "Terminal" }});
        }}
    "#,
        prelude = JS_PRELUDE,
        cmd = js_str(&line)
    );
    let out = run_osascript_jxa(&script).map_err(spoken_err)?;
    let parsed: Value = serde_json::from_str(&out).unwrap_or(json!({ "ok": true }));
    Ok(json!({
        "opened": true,
        "app": parsed.get("app").and_then(|v| v.as_str()).unwrap_or("Terminal"),
        "running": if line.is_empty() { "a shell" } else { line.as_str() },
    }))
}

/// Quote a path for a shell line (single quotes, escaping embedded ones).
fn shell_quote(s: &str) -> String {
    if s.starts_with('~') && !s[1..].contains('\'') {
        return s.replace(' ', "\\ ");
    }
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// `term_watch` — "tell me when that terminal finishes or needs me." Registers
/// a one-shot watch (poller + heuristics in `agent::term_watch`); Symon speaks
/// ONCE when the terminal goes idle, asks for input, or closes — then the watch
/// dies. ReadOnly: it only observes a terminal the user explicitly named.
pub fn watch(app: &tauri::AppHandle, args: Value) -> Result<Value, String> {
    let id = args
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or("term_watch needs the terminal 'id' string from term_list".to_string())?;
    // Validate the token now so a bad id fails fast (not 5s later in the poller).
    parse_token(id)?;
    let title = args
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .split(" — ")
        .take(2)
        .collect::<Vec<_>>()
        .join(" — ");
    let title = if title.is_empty() { "that".to_string() } else { title };
    let count = crate::agent::term_watch::add(app, id.to_string(), title.clone());
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
        "Neither Terminal nor iTerm is running right now.".to_string()
    } else {
        e
    }
}
