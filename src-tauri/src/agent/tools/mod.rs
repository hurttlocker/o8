//! Symon voice-agent Tier-1 tools — native macOS actions via osascript (JXA +
//! AppleScript) and `open`. Lifted from aqua, de-Symonized, trimmed to the V1
//! starter set (open_app, Reminders, Calendar list/create, Notes search/create).
//!
//! SafetyClass is NOT declared on the tool — it's looked up by name from
//! `super::safety`. `enabled_tools()` withholds Destructive tools from the
//! schema the model sees; the loop still gates Reversible tools on a confirm
//! card via `super::confirm_if_needed`.

pub mod apps;
pub mod csv;
pub mod filesystem;
pub mod git_github;
pub mod mac_calendar;
pub mod mac_contacts;
pub mod mac_mail;
pub mod mac_notes;
pub mod mac_reminders;
pub mod mac_music;
pub mod mac_shortcuts;
pub mod o8_bridge;
pub mod o8_ui;
pub mod terminal_ctl;

use super::{safety, TaskCtx};
use chrono::{Datelike, Timelike};
use serde_json::{json, Value};

/// All tool schemas, in the `{name, description, parameters}` shape (which wraps
/// directly into OpenAI's `function` object).
pub fn all_tools() -> Vec<Value> {
    vec![
        json!({
            "name": "open_app",
            "description": "Open (launch and bring to the front) any installed macOS application by name — first-party (Reminders, Calendar, Safari) or third-party (Google Chrome, Slack, Figma). Fuzzy-matches the installed apps, so a casual name like 'chrome' works. If the name is ambiguous it returns the candidates. Use when the user asks to open, show, or pull up an app, including right after creating something in that app.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Application name as the user said it, e.g. 'Reminders', 'chrome', 'Figma'." }
                },
                "required": ["name"]
            }
        }),
        json!({
            "name": "list_apps",
            "description": "List the applications installed on this Mac (names only). Use when the user asks what apps they have, or when open_app could not find a match.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Optional substring filter, e.g. 'adobe'. Omit for all apps." }
                },
                "required": []
            }
        }),
        json!({
            "name": "mac_reminders_list",
            "description": "List the user's reminders. Optionally filter by list name and whether to include completed reminders.",
            "parameters": {
                "type": "object",
                "properties": {
                    "list_name": { "type": "string", "description": "Reminders list to read from. Omit for all lists." },
                    "include_completed": { "type": "boolean", "description": "Include completed reminders. Default false." }
                },
                "required": []
            }
        }),
        json!({
            "name": "mac_reminders_create",
            "description": "Create a reminder. Use an ISO 8601 due_date (e.g. 2026-06-09T15:00:00) when the user gives a time.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "The reminder text." },
                    "due_date": { "type": "string", "description": "ISO 8601 due date/time. Omit if none given." },
                    "notes": { "type": "string", "description": "Optional notes/body." },
                    "list_name": { "type": "string", "description": "Reminders list. Default 'Reminders'." }
                },
                "required": ["title"]
            }
        }),
        json!({
            "name": "mac_reminders_complete",
            "description": "Mark a reminder complete by its title.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "The reminder title to complete." },
                    "list_name": { "type": "string", "description": "Reminders list to search. Omit for all." }
                },
                "required": ["title"]
            }
        }),
        json!({
            "name": "mac_calendar_list_events",
            "description": "List upcoming calendar events within the next N days.",
            "parameters": {
                "type": "object",
                "properties": {
                    "days_ahead": { "type": "integer", "description": "How many days ahead to look. Default 7." },
                    "calendar_name": { "type": "string", "description": "Limit to one calendar. Omit for all." }
                },
                "required": []
            }
        }),
        json!({
            "name": "mac_calendar_create_event",
            "description": "Create a calendar event. start_date and end_date are ISO 8601 (e.g. 2026-06-09T15:00:00).",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "Event title." },
                    "start_date": { "type": "string", "description": "ISO 8601 start." },
                    "end_date": { "type": "string", "description": "ISO 8601 end." },
                    "notes": { "type": "string", "description": "Optional notes." },
                    "calendar_name": { "type": "string", "description": "Target calendar. Omit for the first writable one." }
                },
                "required": ["title", "start_date", "end_date"]
            }
        }),
        json!({
            "name": "mac_notes_search",
            "description": "Search Apple Notes by title or body text.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Text to search for." },
                    "limit": { "type": "integer", "description": "Max notes to return. Default 5." }
                },
                "required": ["query"]
            }
        }),
        json!({
            "name": "mac_notes_create",
            "description": "Create a new Apple Note.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "Note title." },
                    "body": { "type": "string", "description": "Note body text." },
                    "folder": { "type": "string", "description": "Target folder. Omit for the default." }
                },
                "required": ["title"]
            }
        }),
        json!({
            "name": "mac_notes_append",
            "description": "Append text to an existing Apple Note, found by its exact title.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "Title of the note to append to." },
                    "text": { "type": "string", "description": "Text to append (added on a new line)." }
                },
                "required": ["title", "text"]
            }
        }),
        json!({
            "name": "mac_calendar_delete_event",
            "description": "Delete calendar events matching an exact title. Destructive — always confirmed.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "Exact event title to delete." },
                    "calendar_name": { "type": "string", "description": "Limit to one calendar. Omit to search all." }
                },
                "required": ["title"]
            }
        }),
        json!({
            "name": "mac_contacts_search",
            "description": "Search Contacts by name; returns name, first email, and first phone.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Name or partial name to match." },
                    "limit": { "type": "integer", "description": "Max contacts to return. Default 5." }
                },
                "required": ["query"]
            }
        }),
        json!({
            "name": "mac_mail_search",
            "description": "Search Mail messages by subject or body text.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Text to search for." },
                    "mailbox": { "type": "string", "description": "Mailbox to search. Default 'INBOX'." },
                    "limit": { "type": "integer", "description": "Max messages. Default 10." }
                },
                "required": ["query"]
            }
        }),
        json!({
            "name": "mac_mail_read",
            "description": "Read recent Mail messages (subject, sender, body preview).",
            "parameters": {
                "type": "object",
                "properties": {
                    "mailbox": { "type": "string", "description": "Mailbox to read. Default 'INBOX'." },
                    "unread_only": { "type": "boolean", "description": "Only unread messages. Default true." },
                    "limit": { "type": "integer", "description": "Max messages. Default 5." }
                },
                "required": []
            }
        }),
        json!({
            "name": "mac_mail_draft",
            "description": "Create a Mail draft (saved, not sent). Reversible — confirmed before saving.",
            "parameters": {
                "type": "object",
                "properties": {
                    "to": { "type": "string", "description": "Recipient email address." },
                    "subject": { "type": "string", "description": "Subject line." },
                    "body": { "type": "string", "description": "Message body." }
                },
                "required": ["to", "subject"]
            }
        }),
        json!({
            "name": "mac_mail_send_draft",
            "description": "Send an existing Mail draft matched by subject. Destructive — always confirmed.",
            "parameters": {
                "type": "object",
                "properties": {
                    "subject": { "type": "string", "description": "Subject of the draft to send." }
                },
                "required": ["subject"]
            }
        }),
        json!({
            "name": "mac_shortcuts_list",
            "description": "List the user's installed Shortcuts by name.",
            "parameters": { "type": "object", "properties": {}, "required": [] }
        }),
        json!({
            "name": "mac_shortcuts_run",
            "description": "Run a Shortcut by name, with optional text input. Destructive — always confirmed.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Exact Shortcut name." },
                    "input": { "type": "string", "description": "Optional text input to pass." }
                },
                "required": ["name"]
            }
        }),
        json!({
            "name": "fs_read_text",
            "description": "Read a UTF-8 text file (capped at 8 KB). Protected system/credential paths are refused.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute file path to read." }
                },
                "required": ["path"]
            }
        }),
        json!({
            "name": "fs_write_text",
            "description": "Write a text file inside the agent sandbox (~/.o8/agent-output/ only). Reversible.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path under ~/.o8/agent-output/." },
                    "content": { "type": "string", "description": "Text content to write." }
                },
                "required": ["path", "content"]
            }
        }),
        json!({
            "name": "fs_spotlight",
            "description": "Spotlight (mdfind) search for files; returns matching paths.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Spotlight query string." },
                    "limit": { "type": "integer", "description": "Max paths. Default 10." }
                },
                "required": ["query"]
            }
        }),
        json!({
            "name": "csv_read",
            "description": "Read a CSV file into headers + rows.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path to the CSV file." }
                },
                "required": ["path"]
            }
        }),
        json!({
            "name": "csv_write",
            "description": "Write a CSV into the agent sandbox (~/.o8/agent-output/) by bare filename. Reversible.",
            "parameters": {
                "type": "object",
                "properties": {
                    "filename": { "type": "string", "description": "Bare filename, e.g. 'results.csv'." },
                    "headers": { "type": "array", "items": { "type": "string" }, "description": "Header row." },
                    "rows": { "type": "array", "items": { "type": "array", "items": { "type": "string" } }, "description": "Rows of string cells." }
                },
                "required": ["filename"]
            }
        }),
        // ── In-place text edit (magic roadmap #1) ──────────────────────────────
        json!({
            "name": "apply_text_edit",
            "description": "Replace the text the user is editing (their selection, or the text field they're in) with new_text — IN PLACE on their screen. Only works when the request included a '--- text being edited ---' block. Make ONE call with the complete replacement; a Revert chip appears for the user, so apply directly without asking permission.",
            "parameters": {
                "type": "object",
                "properties": {
                    "new_text": { "type": "string", "description": "The complete replacement text (full selection or full field content)." }
                },
                "required": ["new_text"]
            }
        }),
        // ── o8 bridge (Tier-2) — read what the coding agents are doing ─────────
        json!({
            "name": "o8_status",
            "description": "Report what's currently shipping or in progress across o8's autonomous agent fleet — the active packets/lanes and their status (running, reviewing, etc.). Use for 'what's shipping?', 'what's in progress?', 'what are my agents doing?'. Optionally filter to one repo.",
            "parameters": {
                "type": "object",
                "properties": {
                    "repo": { "type": "string", "description": "Filter to one repo by folder name, e.g. 'o8'. Omit for the whole fleet." }
                },
                "required": []
            }
        }),
        json!({
            "name": "o8_ask",
            "description": "Ask o8's Engineering Brain a question about the codebase, recent work, or the fleet — e.g. 'what did Codex do today?', 'what changed in the orchestrator?', 'how does dispatch work?'. Returns a synthesized answer grounded in o8's organizational memory.",
            "parameters": {
                "type": "object",
                "properties": {
                    "question": { "type": "string", "description": "The natural-language question to ask the Brain." },
                    "repo_path": { "type": "string", "description": "Optional absolute repo path to scope the answer. Omit for fleet-wide." }
                },
                "required": ["question"]
            }
        }),
        json!({
            "name": "o8_needs_me",
            "description": "List everything waiting on the USER across o8 — pending approval cards (merges, plans, gated commands) and agent lanes stuck needing attention. Use for 'what needs me?', 'anything waiting on me?', 'do I have approvals?'. ALWAYS call this before o8_approve_item or o8_reject_item to learn the exact pending titles.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }),
        json!({
            "name": "o8_approve_item",
            "description": "Approve ONE pending o8 approval card by its title. Call o8_needs_me first and pass the exact title you read there — never guess. The user confirms on a card before this executes.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "The exact title of the pending approval, as returned by o8_needs_me." }
                },
                "required": ["title"]
            }
        }),
        json!({
            "name": "o8_reject_item",
            "description": "Reject ONE pending o8 approval card by its title. Call o8_needs_me first and pass the exact title you read there — never guess. The user confirms on a card before this executes.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "The exact title of the pending approval, as returned by o8_needs_me." },
                    "reason": { "type": "string", "description": "Optional short reason the user gave for rejecting." }
                },
                "required": ["title"]
            }
        }),
        json!({
            "name": "o8_dispatch",
            "description": "Hand a CODING task to o8's orchestrator — it dispatches an autonomous worker in an isolated worktree, reviews the diff, and surfaces a packet for the user's approval. Use when the user wants code written, changed, fixed, or investigated in a repo ('have the orchestrator fix the auth bug', 'kick off the tooltip work in o8'). You do NOT write code yourself — this delegates it. Always include the repo so the user can confirm by ear.",
            "parameters": {
                "type": "object",
                "properties": {
                    "repo": { "type": "string", "description": "Repo folder name to work in, e.g. 'o8'." },
                    "task": { "type": "string", "description": "A clear one-or-two-sentence description of what the orchestrator should do." },
                    "base_branch": { "type": "string", "description": "Optional branch to fork from. Default 'main'." }
                },
                "required": ["repo", "task"]
            }
        }),
        // ── Apple Music (app-control frontier) ────────────────────────────────
        json!({
            "name": "mac_music_playlists",
            "description": "List the names of the user's Apple Music playlists. Use for 'what playlists do I have?' or before playing from a playlist whose exact name you don't know.",
            "parameters": { "type": "object", "properties": {}, "required": [] }
        }),
        json!({
            "name": "mac_music_play",
            "description": "Play music in Apple Music: a named playlist, a searched song/artist, or just resume playback. Use for 'play my chill playlist', 'play some Sade', 'play music'. If a playlist name might be off, call mac_music_playlists first.",
            "parameters": {
                "type": "object",
                "properties": {
                    "playlist": { "type": "string", "description": "Exact playlist name to play. Omit when playing a song or resuming." },
                    "song": { "type": "string", "description": "Song, artist, or album to search the library for and play the top match. Omit when playing a playlist or resuming." }
                },
                "required": []
            }
        }),
        json!({
            "name": "mac_music_pause",
            "description": "Pause Apple Music playback. Use for 'pause the music', 'stop the song'.",
            "parameters": { "type": "object", "properties": {}, "required": [] }
        }),
        json!({
            "name": "mac_music_next",
            "description": "Skip to the next track in Apple Music. Use for 'next song', 'skip this'.",
            "parameters": { "type": "object", "properties": {}, "required": [] }
        }),
        json!({
            "name": "mac_music_now_playing",
            "description": "What's currently playing in Apple Music (track, artist, player state). Use for 'what song is this?'.",
            "parameters": { "type": "object", "properties": {}, "required": [] }
        }),
        // ── o8 UI control (the o8-control frontier v1) ────────────────────────
        json!({
            "name": "o8_ui_open",
            "description": "Open a surface of the o8 window itself by voice — 'open my settings', 'show the mobile QR code', 'open my automations', 'show the inbox / PRs / activity / review panel', 'open the o8.md page', 'open the browser to anthropic.com'. Brings the o8 window forward and opens the named surface.",
            "parameters": {
                "type": "object",
                "properties": {
                    "surface": { "type": "string", "enum": ["settings", "voice_settings", "mobile_qr", "automations", "browser", "inbox", "prs", "activity", "review", "o8md", "workspace", "files", "terminal"], "description": "Which o8 surface to open. mobile_qr = the phone pairing QR code; o8md = the repo's o8.md spec page; voice_settings = the Symon voice settings window." },
                    "url": { "type": "string", "description": "For surface 'browser' only: the URL to open, e.g. 'anthropic.com' or 'http://localhost:3000'." }
                },
                "required": ["surface"]
            }
        }),
        json!({
            "name": "o8_recap",
            "description": "What happened across o8's agent fleet recently — packets completed / failed / sent to review, what's still running, approvals resolved. Use for 'what happened while I was gone?', 'what did I miss?', 'how did the day go?'. Default window 8 hours.",
            "parameters": {
                "type": "object",
                "properties": {
                    "hours": { "type": "integer", "description": "Look-back window in hours (1-72, default 8)." }
                },
                "required": []
            }
        }),
        json!({
            "name": "o8_usage",
            "description": "How much Claude / Codex CLI quota is left — the rate-limit windows (used percent, tokens, when they reset). Use for 'how much Codex do I have left?', 'where are my rate limits?'.",
            "parameters": { "type": "object", "properties": {}, "required": [] }
        }),
        json!({
            "name": "o8_panel_read",
            "description": "List what's configured inside o8: 'automations' (scheduled/triggered jobs and their last run), 'projects' (project groupings), or 'repos' (connected repositories). Use for 'what automations do I have?', 'what projects are in o8?', 'which repos are connected?'. For PRs, issues, or commits use the git/gh tools instead.",
            "parameters": {
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "enum": ["automations", "projects", "repos"], "description": "Which list to read." }
                },
                "required": ["kind"]
            }
        }),
        // ── Terminal control (the dev frontier) ───────────────────────────────
        json!({
            "name": "term_list",
            "description": "List the user's open Terminal windows — each with a stable id, its title (titles carry the working directory and the live session/task name, e.g. a Claude Code session's current task), and whether it's busy. Use for 'what terminals are up?', 'what are my terminals doing?'. ALWAYS call this before term_read or term_send to get the id.",
            "parameters": { "type": "object", "properties": {}, "required": [] }
        }),
        json!({
            "name": "term_read",
            "description": "Read the last lines visible in one Terminal window — 'what is the o8 terminal saying?', 'did the tests finish in that terminal?'. Pass the id from term_list.",
            "parameters": {
                "type": "object",
                "properties": {
                    "id": { "type": "integer", "description": "Terminal window id from term_list." },
                    "lines": { "type": "integer", "description": "How many trailing lines (default 25, max 80)." },
                    "tab": { "type": "integer", "description": "Tab number within the window (default 1)." }
                },
                "required": ["id"]
            }
        }),
        json!({
            "name": "term_send",
            "description": "Type and submit ONE line in a Terminal window — a shell command, or a message to an agent REPL (like Claude Code) running there. Pass the id from term_list, and include 'title' (the terminal's title from term_list) so the user hears which terminal on the confirm card. The user confirms before it runs.",
            "parameters": {
                "type": "object",
                "properties": {
                    "id": { "type": "integer", "description": "Terminal window id from term_list." },
                    "command": { "type": "string", "description": "The single line to type and submit." },
                    "title": { "type": "string", "description": "The target terminal's title from term_list — spoken on the confirm card." },
                    "tab": { "type": "integer", "description": "Tab number within the window (default 1)." }
                },
                "required": ["id", "command", "title"]
            }
        }),
        json!({
            "name": "term_interrupt",
            "description": "Send Ctrl+C to a Terminal window — stop whatever is running there ('stop that terminal', 'interrupt the audit'). Pass id and title from term_list. The user confirms first.",
            "parameters": {
                "type": "object",
                "properties": {
                    "id": { "type": "integer", "description": "Terminal window id from term_list." },
                    "title": { "type": "string", "description": "The target terminal's title from term_list — spoken on the confirm card." },
                    "tab": { "type": "integer", "description": "Tab number (default 1)." }
                },
                "required": ["id", "title"]
            }
        }),
        json!({
            "name": "term_key",
            "description": "Press ONE key in a Terminal window — answer an agent's permission prompt or menu there: 'enter', 'escape', 'up', 'down', 'y', 'n', or a digit ('approve what that terminal is asking' → read it with term_read first, then press the right key). Pass id and title from term_list. The user confirms first.",
            "parameters": {
                "type": "object",
                "properties": {
                    "id": { "type": "integer", "description": "Terminal window id from term_list." },
                    "key": { "type": "string", "description": "enter, escape, ctrl_c, up, down, or a single letter/digit." },
                    "title": { "type": "string", "description": "The target terminal's title from term_list — spoken on the confirm card." },
                    "tab": { "type": "integer", "description": "Tab number (default 1)." }
                },
                "required": ["id", "key", "title"]
            }
        }),
        json!({
            "name": "term_new",
            "description": "Open a NEW Terminal window, optionally in a directory and running a command — 'open a terminal in the o8 repo', 'start a claude session in the rainwater repo' (command: 'claude'). Resolve a spoken repo name to its path with o8_panel_read repos + the known registry first when unsure. The user confirms first.",
            "parameters": {
                "type": "object",
                "properties": {
                    "directory": { "type": "string", "description": "Absolute path (or ~ path) to cd into. Omit for home." },
                    "command": { "type": "string", "description": "Command to run there, e.g. 'claude'. Omit for a plain shell." }
                },
                "required": []
            }
        }),
        // ── GitHub + local git (Tier-3, read-only) ────────────────────────────
        json!({
            "name": "git_status",
            "description": "Show the local git status (branch + changed files) of a repo. Use for 'what's the git status of o8?', 'is my working tree clean?'.",
            "parameters": {
                "type": "object",
                "properties": {
                    "repo": { "type": "string", "description": "Repo folder name, e.g. 'o8'." }
                },
                "required": ["repo"]
            }
        }),
        json!({
            "name": "git_log",
            "description": "Show recent commits (one line each) for a repo. Use for 'what are the recent commits on o8?'.",
            "parameters": {
                "type": "object",
                "properties": {
                    "repo": { "type": "string", "description": "Repo folder name." },
                    "count": { "type": "integer", "description": "How many commits. Default 10, max 30." }
                },
                "required": ["repo"]
            }
        }),
        json!({
            "name": "gh_pr_list",
            "description": "List open pull requests for a repo (number, title, state, author) via the GitHub CLI. Use for 'any open PRs on o8?'.",
            "parameters": {
                "type": "object",
                "properties": {
                    "repo": { "type": "string", "description": "Repo folder name." }
                },
                "required": ["repo"]
            }
        }),
        json!({
            "name": "gh_issue_list",
            "description": "List open issues for a repo (number, title, state) via the GitHub CLI. Use for 'what issues are open on o8?'.",
            "parameters": {
                "type": "object",
                "properties": {
                    "repo": { "type": "string", "description": "Repo folder name." }
                },
                "required": ["repo"]
            }
        }),
    ]
}

/// Tools the model is allowed to see — Destructive ones are withheld entirely.
pub fn enabled_tools() -> Vec<Value> {
    all_tools()
        .into_iter()
        .filter(|tool| {
            let Some(name) = tool.get("name").and_then(|n| n.as_str()) else {
                return false;
            };
            safety::tool_safety_class(name) != safety::SafetyClass::Destructive
        })
        .collect()
}

/// Dispatch a parsed tool call to its handler. `args` is already JSON-decoded.
pub async fn dispatch_tool_call(name: &str, args: Value, ctx: &TaskCtx) -> Result<Value, String> {
    // Hard refuse list (defense in depth — the V1 schema exposes none of these).
    if safety::is_never_do_tool(name) {
        return Err(format!("Tool '{name}' is on the never-do list"));
    }
    if let Some(path) = args.get("path").and_then(|p| p.as_str()) {
        if safety::is_never_do_path(path) {
            return Err(format!("Path '{path}' is a protected system path"));
        }
    }

    match name {
        "open_app" => apps::open_app(args).await,
        "list_apps" => apps::list_apps(args).await,
        "mac_reminders_list" => mac_reminders::list(args).await,
        "mac_reminders_create" => mac_reminders::create(args).await,
        "mac_reminders_complete" => mac_reminders::complete(args).await,
        "mac_calendar_list_events" => mac_calendar::list_events(args).await,
        "mac_calendar_create_event" => mac_calendar::create_event(args).await,
        "mac_notes_search" => mac_notes::search(args).await,
        "mac_notes_create" => mac_notes::create(args).await,
        "mac_notes_append" => mac_notes::append(args).await,
        "mac_calendar_delete_event" => mac_calendar::delete_event(args).await,
        "mac_contacts_search" => mac_contacts::search(args).await,
        "mac_mail_search" => mac_mail::search(args).await,
        "mac_mail_read" => mac_mail::read(args).await,
        "mac_mail_draft" => mac_mail::draft(args).await,
        "mac_mail_send_draft" => mac_mail::send_draft(args).await,
        "mac_shortcuts_list" => mac_shortcuts::list(args).await,
        "mac_shortcuts_run" => mac_shortcuts::run(args).await,
        "fs_read_text" => filesystem::read_text(args).await,
        "fs_write_text" => filesystem::write_text(args).await,
        "fs_spotlight" => filesystem::spotlight(args).await,
        "csv_read" => csv::read(args).await,
        "csv_write" => csv::write(args).await,
        "apply_text_edit" => {
            let Some(edit) = ctx.edit.as_deref() else {
                return Err(
                    "No editable text was captured for this request — ask the user to select \
                     the text or click into the field, then try again."
                        .into(),
                );
            };
            let new_text = args.get("new_text").and_then(|v| v.as_str()).unwrap_or("");
            crate::agent::edit_ctx::apply(&ctx.app, edit, new_text)
        }
        "o8_status" => o8_bridge::status(args).await,
        "o8_needs_me" => o8_bridge::needs_me(args).await,
        "o8_approve_item" => o8_bridge::approve_item(args).await,
        "o8_reject_item" => o8_bridge::reject_item(args).await,
        "o8_ask" => o8_bridge::ask(args).await,
        "o8_dispatch" => o8_bridge::dispatch(args).await,
        "o8_ui_open" => o8_ui::open(&ctx.app, args),
        "o8_panel_read" => o8_bridge::panel_read(args).await,
        "o8_recap" => o8_bridge::recap(args).await,
        "o8_usage" => o8_bridge::usage(args).await,
        "term_list" => terminal_ctl::list(args).await,
        "term_read" => terminal_ctl::read(args).await,
        "term_send" => terminal_ctl::send(args).await,
        "term_interrupt" => terminal_ctl::interrupt(args).await,
        "term_key" => terminal_ctl::key(args).await,
        "term_new" => terminal_ctl::new(args).await,
        "mac_music_playlists" => mac_music::playlists(args).await,
        "mac_music_play" => mac_music::play(args).await,
        "mac_music_pause" => mac_music::pause(args).await,
        "mac_music_next" => mac_music::next(args).await,
        "mac_music_now_playing" => mac_music::now_playing(args).await,
        "git_status" => git_github::git_status(args).await,
        "git_log" => git_github::git_log(args).await,
        "gh_pr_list" => git_github::pr_list(args).await,
        "gh_issue_list" => git_github::issue_list(args).await,
        other => Err(format!("Unknown tool: {other}")),
    }
}

// ── osascript executors ──────────────────────────────────────────────────────
// Both run with a hard 30s cap. The killer case: the FIRST Apple Event to a
// new target app (e.g. Music) parks osascript on the macOS Automation consent
// dialog — without a timeout that wedged the whole agent task on "Working"
// forever (live-hit 2026-06-10). 30s gives a present user time to click
// Allow; an absent/dismissed dialog degrades to a spoken, actionable error.

const OSASCRIPT_TIMEOUT_SECS: u64 = 30;

/// Spawn `osascript` with the given args, enforcing the timeout. Output pipes
/// are tiny for every script we run, so poll-then-read is deadlock-safe.
fn run_osascript_capped(args: &[&str], label: &str) -> Result<String, String> {
    let mut child = std::process::Command::new("osascript")
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("{label} exec failed: {e}"))?;

    let deadline =
        std::time::Instant::now() + std::time::Duration::from_secs(OSASCRIPT_TIMEOUT_SECS);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "{label} timed out after {OSASCRIPT_TIMEOUT_SECS}s — macOS is likely \
                         waiting on an Automation permission: System Settings → Privacy & \
                         Security → Automation → o8 must be allowed to control the target app."
                    ));
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(e) => return Err(format!("{label} wait failed: {e}")),
        }
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("{label} output read failed: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(format!(
            "{label} error: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

/// Run a JXA (JavaScript-for-Automation) script, returning stdout.
pub(crate) fn run_osascript_jxa(script: &str) -> Result<String, String> {
    run_osascript_capped(&["-l", "JavaScript", "-e", script], "osascript")
}

/// Run an AppleScript, returning stdout.
pub(crate) fn run_applescript(script: &str) -> Result<String, String> {
    run_osascript_capped(&["-e", script], "AppleScript")
}

// ── shared helpers ───────────────────────────────────────────────────────────

/// Escape a string for embedding inside an AppleScript double-quoted literal.
pub(crate) fn as_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n")
}

/// Parse a model-emitted ISO 8601 date/time into (year, month, day, hour, min).
/// Date-only strings default to 9:00 AM. Returns None if unparseable.
pub(crate) fn parse_due_components(s: &str) -> Option<(i32, u32, u32, u32, u32)> {
    use chrono::{DateTime, NaiveDate, NaiveDateTime};
    let s = s.trim();
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        let n = dt.naive_local();
        return Some((n.year(), n.month(), n.day(), n.hour(), n.minute()));
    }
    for fmt in [
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
    ] {
        if let Ok(n) = NaiveDateTime::parse_from_str(s, fmt) {
            return Some((n.year(), n.month(), n.day(), n.hour(), n.minute()));
        }
    }
    if let Ok(d) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return Some((d.year(), d.month(), d.day(), 9, 0));
    }
    None
}

/// Build an AppleScript block that sets `var` to a date with the given
/// components. Day is set to 1 first to avoid month-overflow when reassigning.
pub(crate) fn date_setter_block(var: &str, (y, mo, d, h, mi): (i32, u32, u32, u32, u32)) -> String {
    format!(
        "set {var} to (current date)\n\
         set day of {var} to 1\n\
         set year of {var} to {y}\n\
         set month of {var} to {mo}\n\
         set day of {var} to {d}\n\
         set hours of {var} to {h}\n\
         set minutes of {var} to {mi}\n\
         set seconds of {var} to 0\n"
    )
}
