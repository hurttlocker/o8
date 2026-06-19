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
pub mod mac_system;
pub mod mac_weather;
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
            "description": "Create a calendar event, optionally REPEATING. start_date and end_date are ISO 8601 (e.g. 2026-06-09T15:00:00). For 'every Monday at 9' use repeat:'weekly' with start_date on the next Monday 9am. Recurring REMINDERS aren't possible on macOS — route 'remind me every X' here as a repeating event and tell the user it went on the calendar.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "Event title." },
                    "start_date": { "type": "string", "description": "ISO 8601 start." },
                    "end_date": { "type": "string", "description": "ISO 8601 end." },
                    "notes": { "type": "string", "description": "Optional notes." },
                    "calendar_name": { "type": "string", "description": "Target calendar. Omit for the first writable one." },
                    "repeat": { "type": "string", "enum": ["daily", "weekdays", "weekly", "biweekly", "monthly", "yearly"], "description": "Optional recurrence. The event repeats from start_date." }
                },
                "required": ["title", "start_date", "end_date"]
            }
        }),
        json!({
            "name": "mac_reminders_update",
            "description": "Change an EXISTING reminder — rename it, move its due date, or rewrite its notes ('move my dentist reminder to Friday', 'rename that to X'). List the reminders first and pass the EXACT current title. The user confirms first.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "EXACT current reminder title (from mac_reminders_list)." },
                    "new_title": { "type": "string", "description": "Optional new title." },
                    "new_due_date": { "type": "string", "description": "Optional new due date, ISO 8601." },
                    "new_notes": { "type": "string", "description": "Optional replacement notes." },
                    "list_name": { "type": "string", "description": "Optional list to search in." }
                },
                "required": ["title"]
            }
        }),
        json!({
            "name": "mac_calendar_update_event",
            "description": "Move or rename an UPCOMING calendar event — 'push my 2pm to 3', 'move standup to Friday at 10', 'rename tomorrow's sync'. List events first and pass the EXACT title. Giving only new_start keeps the event the same length. The user confirms first.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "EXACT current event title (from mac_calendar_list_events)." },
                    "new_start": { "type": "string", "description": "Optional new start, ISO 8601. Alone, it preserves the event's duration." },
                    "new_end": { "type": "string", "description": "Optional new end, ISO 8601." },
                    "new_title": { "type": "string", "description": "Optional new title." },
                    "calendar_name": { "type": "string", "description": "Optional calendar to search in." }
                },
                "required": ["title"]
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
        // ── Escalation handoff (two-tier brain) ───────────────────────────────
        json!({
            "name": "escalate",
            "description": "Hand a HEAVIER, multi-step task off to a more capable BACKGROUND brain so you can answer the user INSTANTLY instead of making them wait. Two targets: 'claude_brain' for deep personal/Mac tasks that need several steps or careful reasoning (e.g. 'go through my calendar this week and draft a summary email to the team', 'organize my reminders by project') — it runs in the background and reports back when done; 'orchestrator' for work that CHANGES a code repository (pass `repo`). Do NOT escalate quick single-tool asks you can just do yourself. After calling escalate, give a short spoken acknowledgement like 'On it — I'll get that going and let you know.' and do not call more tools.",
            "parameters": {
                "type": "object",
                "properties": {
                    "task": { "type": "string", "description": "The full task to hand off, written as a clear standalone instruction with any context the background brain needs." },
                    "target": { "type": "string", "enum": ["claude_brain", "orchestrator"], "description": "'claude_brain' for heavy personal/Mac tasks; 'orchestrator' for code-repo changes." },
                    "repo": { "type": "string", "description": "Repo folder name — REQUIRED when target is 'orchestrator' (e.g. 'o8'). Omit for claude_brain." }
                },
                "required": ["task", "target"]
            }
        }),
        // ── o8 Canvas control (drive the operator's screen) ───────────────────
        json!({
            "name": "o8_canvas",
            "description": "Drive o8's Canvas (the spatial workspace) by voice — this is the ONLY tool that opens the Canvas (do NOT use o8_ui_open for the canvas). Use when the user wants to SEE or arrange something in o8 itself: 'open / enter / show / go to / pull up the canvas' (enter — just bring the Canvas up, no other action), 'tell the orchestrator to fix the failing test' (send-prompt), 'ask the brain why the merge gate exists' (ask-brain), 'open the browser on localhost 3000' (open-browser), 'pull up the spec' (open-spec), 'open a terminal' (spawn-terminal), 'search the canvas for the tooltip card' (search), 'zoom out' (zoom), 'open/close the dock' (dock), 'spawn two agents on the auth refactor' (spawn-agents — blooms N worker cards that work the task in isolated worktrees). Every verb opens the Canvas automatically if it isn't already up. This only changes what's on screen — it never edits code itself (use o8_dispatch/escalate for that).",
            "parameters": {
                "type": "object",
                "properties": {
                    "verb": { "type": "string", "enum": ["enter", "send-prompt", "ask-brain", "open-browser", "open-spec", "spawn-terminal", "search", "zoom", "dock", "spawn-agents"], "description": "Which canvas action to run. 'enter' just brings the Canvas up (open/show/go to the canvas) with no further action." },
                    "text": { "type": "string", "description": "send-prompt: the message for the orchestrator." },
                    "question": { "type": "string", "description": "ask-brain: the question for the Engineering Brain." },
                    "url": { "type": "string", "description": "open-browser: the URL to open (omit for the app dashboard)." },
                    "query": { "type": "string", "description": "search: text to pre-fill the canvas search." },
                    "level": { "type": "number", "description": "zoom: an explicit level (1, 0.85, or 0.7)." },
                    "direction": { "type": "string", "enum": ["in", "out"], "description": "zoom: step in or out." },
                    "open": { "type": "boolean", "description": "dock: true opens, false closes (omit to toggle)." },
                    "task": { "type": "string", "description": "spawn-agents: what the agents should work on, e.g. 'the auth refactor'." },
                    "count": { "type": "number", "description": "spawn-agents: how many agents to spawn (1-5, default 1)." },
                    "repo": { "type": "string", "description": "spawn-agents: optional repo name or path to scope the agents to; omit to use the active repo." }
                },
                "required": ["verb"]
            }
        }),
        // ── o8 Browser driving (drive a web page by voice) ────────────────────
        json!({
            "name": "o8_browser_read",
            "description": "Read what o8's browser is showing, or wait for an element to appear — 'read the page', 'what's on this page', 'wait for the login form'. ReadOnly: never changes the page. Open a page first with o8_canvas verb 'open-browser' or o8_browser_act 'open'. Returns the page text plus a list of interactive elements (each with a CSS selector) you can then act on via o8_browser_act.",
            "parameters": {
                "type": "object",
                "properties": {
                    "verb": { "type": "string", "enum": ["read", "wait"], "description": "'read' the visible page text, or 'wait' for a selector to appear (polls ~8s)." },
                    "selector": { "type": "string", "description": "read: optional CSS selector to read just one element. wait: the CSS selector to wait for (required)." },
                    "text": { "type": "string", "description": "wait: optional text the element must contain." },
                    "max_chars": { "type": "number", "description": "read: cap the returned text length (default 6000)." }
                },
                "required": ["verb"]
            }
        }),
        json!({
            "name": "o8_browser_act",
            "description": "Act on the page o8's browser is showing — 'click the sign-in button', 'type my email into the search box', 'open localhost 3000'. Each action shows a confirm card first (the page can be a real logged-in site). Find selectors with o8_browser_read. Drives only o8's own browser surfaces (localhost / proxied pages).",
            "parameters": {
                "type": "object",
                "properties": {
                    "verb": { "type": "string", "enum": ["click", "type", "open"], "description": "'click' an element, 'type' into a field, or 'open' a URL." },
                    "selector": { "type": "string", "description": "click/type: the CSS selector of the target element (get it from o8_browser_read)." },
                    "text": { "type": "string", "description": "type: the text to enter." },
                    "submit": { "type": "boolean", "description": "type: press Enter after typing to submit the form." },
                    "url": { "type": "string", "description": "open: the URL to open, e.g. 'localhost:3000'." }
                },
                "required": ["verb"]
            }
        }),
        // ── o8 Review (inspect a packet's diff before approving) ───────────────
        json!({
            "name": "o8_review_diff",
            "description": "Inspect what a coding agent (packet) changed before approving — 'what did the auth packet change?', 'show me the diff before I approve'. Returns the diffstat (files + lines changed) and the review state (working / ready-to-merge / needs-revision / merged). ReadOnly — to actually release the merge use o8_approve_item. Name the packet, or omit for the only active one.",
            "parameters": {
                "type": "object",
                "properties": {
                    "packet": { "type": "string", "description": "Which packet/lane to inspect (fuzzy match on its label). Omit for the only active lane." }
                },
                "required": []
            }
        }),
        // ── Screen reading (give the brain sight) ─────────────────────────────
        json!({
            "name": "read_screen",
            "description": "Look at the user's Mac screen and read it back. Use for 'read me what's on screen', 'what does this say', 'what's the error', or when you need to SEE the screen to act on it. Optional `focus` narrows what to extract ('the error message', 'the third paragraph'). Returns the screen's text/description.",
            "parameters": {
                "type": "object",
                "properties": {
                    "focus": { "type": "string", "description": "Optional — what to look for or extract (e.g. 'the error dialog', 'the meeting time'). Omit to describe the whole screen." }
                },
                "required": []
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
            "name": "mac_music_previous",
            "description": "Go back a track in Apple Music ('previous song', 'go back', 'play that again').",
            "parameters": { "type": "object", "properties": {}, "required": [] }
        }),
        json!({
            "name": "mac_music_now_playing",
            "description": "What's currently playing in Apple Music (track, artist, player state). Use for 'what song is this?'.",
            "parameters": { "type": "object", "properties": {}, "required": [] }
        }),
        // ── Day-one assistant basics ──────────────────────────────────────────
        json!({
            "name": "mac_weather",
            "description": "Current weather + today's outlook, spoken-ready. Use for 'what's the weather?', 'is it going to rain?', 'how hot is it in Tokyo?'. No 'place' = the user's current location. SPEAK the answer — only open the Weather app if the user asks for the app itself.",
            "parameters": {
                "type": "object",
                "properties": {
                    "place": { "type": "string", "description": "Optional city or place name ('Tokyo', 'Paris'). Omit for the user's current location." }
                },
                "required": []
            }
        }),
        json!({
            "name": "mac_volume",
            "description": "Control the Mac's output volume — 'turn it down a little', 'set the volume to 50', 'mute', 'unmute'. 'up'/'down' nudge by 15 unless an amount is given.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["get", "set", "up", "down", "mute", "unmute"], "description": "What to do." },
                    "level": { "type": "integer", "description": "For 'set': target volume 0-100." },
                    "amount": { "type": "integer", "description": "For 'up'/'down': nudge size (default 15)." }
                },
                "required": ["action"]
            }
        }),
        json!({
            "name": "o8_add_repo",
            "description": "Register an existing local git repo in o8 so agents can work in it — 'add my hurttlocker folder as a repo', 'connect ~/Projects/site to o8'. Needs the ABSOLUTE folder path: if the user spoke a folder name, find it with fs_spotlight (kind:folder) first. Optionally assigns it to a named o8 project. The user confirms first.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path (or ~/ path) to the local git repo folder." },
                    "project": { "type": "string", "description": "Optional o8 project name to assign the repo to." }
                },
                "required": ["path"]
            }
        }),
        // ── o8 UI control (the o8-control frontier v1) ────────────────────────
        json!({
            "name": "o8_ui_open",
            "description": "Open a surface of the o8 window itself by voice — 'open my settings', 'show the mobile QR code', 'open my automations', 'show the inbox / PRs / activity / review panel', 'open the o8.md page / the spec' (o8md), 'show me the changes / the diff' (review or workspace), 'open the files panel', 'open a terminal', 'open the browser to anthropic.com'. Brings the o8 window forward and opens the named surface. NOTE: this does NOT open the Canvas — for 'open / enter / show / go to the canvas' use the o8_canvas tool with verb 'enter', never this tool.",
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
            "name": "o8_ui_set",
            "description": "Change an o8 UI preference by voice — flips the SAME control the operator would toggle in Settings. 'switch to dark mode' / 'go light' (key 'theme'), 'make it glass' / 'make it solid / opaque' (key 'surface'), 'turn on / off canvas mode' (key 'canvas_mode'). Changes a display preference only — never code or repo state. To OPEN a surface use o8_ui_open; to open the canvas use o8_canvas with verb 'enter'.",
            "parameters": {
                "type": "object",
                "properties": {
                    "key": { "type": "string", "enum": ["theme", "surface", "canvas_mode"], "description": "Which preference to change." },
                    "value": { "type": "string", "description": "theme: 'dark' or 'light'; surface: 'glass' or 'solid'; canvas_mode: 'on' or 'off'." }
                },
                "required": ["key", "value"]
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
        // ── Terminal control (the dev frontier) — Terminal.app AND iTerm2 ─────
        json!({
            "name": "term_list",
            "description": "List the user's open terminals across Terminal.app AND iTerm2 — each with a stable string id, its title (titles carry the working directory and the live session/task name, e.g. a Claude Code session's current task), and whether it's busy. Use for 'what terminals are up?', 'what are my terminals doing?'. ALWAYS call this before term_read / term_send / etc. to get the id. Pass the id back EXACTLY as given.",
            "parameters": { "type": "object", "properties": {}, "required": [] }
        }),
        json!({
            "name": "term_read",
            "description": "Read the last lines visible in one terminal — 'what is the o8 terminal saying?', 'did the tests finish in that terminal?'. Pass the exact id string from term_list.",
            "parameters": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "The exact terminal id string from term_list (e.g. 't:12345:1' or 'i:GUID')." },
                    "lines": { "type": "integer", "description": "How many trailing lines (default 25, max 80)." }
                },
                "required": ["id"]
            }
        }),
        json!({
            "name": "term_send",
            "description": "Type and submit ONE line in a terminal — a shell command, or a message to an agent REPL (like Claude Code) running there. Pass the exact id from term_list, and include 'title' (the terminal's title from term_list) so the user hears which terminal on the confirm card. The user confirms before it runs.",
            "parameters": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "The exact terminal id string from term_list." },
                    "command": { "type": "string", "description": "The single line to type and submit." },
                    "title": { "type": "string", "description": "The target terminal's title from term_list — spoken on the confirm card." }
                },
                "required": ["id", "command", "title"]
            }
        }),
        json!({
            "name": "term_interrupt",
            "description": "Send Ctrl+C to a terminal — stop whatever is running there ('stop that terminal', 'interrupt the audit'). Pass the exact id and title from term_list. The user confirms first.",
            "parameters": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "The exact terminal id string from term_list." },
                    "title": { "type": "string", "description": "The target terminal's title from term_list — spoken on the confirm card." }
                },
                "required": ["id", "title"]
            }
        }),
        json!({
            "name": "term_key",
            "description": "Press ONE key in a terminal — answer an agent's permission prompt or menu there: 'enter', 'escape', 'up', 'down', 'y', 'n', or a digit ('approve what that terminal is asking' → read it with term_read first, then press the right key). Pass the exact id and title from term_list. The user confirms first.",
            "parameters": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "The exact terminal id string from term_list." },
                    "key": { "type": "string", "description": "enter, escape, ctrl_c, up, down, or a single letter/digit." },
                    "title": { "type": "string", "description": "The target terminal's title from term_list — spoken on the confirm card." }
                },
                "required": ["id", "key", "title"]
            }
        }),
        json!({
            "name": "term_new",
            "description": "Open a NEW terminal window, optionally in a directory and running a command — 'open a terminal in the o8 repo', 'start a claude session in the rainwater repo' (command: 'claude'). Opens in iTerm2 if it's running, otherwise Terminal.app. Resolve a spoken repo name to its path with o8_panel_read repos + the known registry first when unsure. The user confirms first.",
            "parameters": {
                "type": "object",
                "properties": {
                    "directory": { "type": "string", "description": "Absolute path (or ~ path) to cd into. Omit for home." },
                    "command": { "type": "string", "description": "Command to run there, e.g. 'claude'. Omit for a plain shell." }
                },
                "required": []
            }
        }),
        json!({
            "name": "term_watch",
            "description": "Watch a terminal and SAY one line when it finishes, asks for input, or closes — 'tell me when that terminal is done', 'let me know when the audit needs me'. One-shot: speaks once then stops watching (45-minute cap). Pass the exact id and title from term_list.",
            "parameters": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "The exact terminal id string from term_list." },
                    "title": { "type": "string", "description": "The terminal's title from term_list." }
                },
                "required": ["id", "title"]
            }
        }),
        json!({
            "name": "o8_packet_steer",
            "description": "Get a spoken message to a running packet's worker — 'tell the tooltip packet to also fix the colors'. Steers the warm session when one exists, else restarts the worker with the message as feedback. Identify the packet by part of its name (from o8_status / o8_needs_me). The user confirms first.",
            "parameters": {
                "type": "object",
                "properties": {
                    "packet": { "type": "string", "description": "Part of the packet's name, enough to identify it." },
                    "message": { "type": "string", "description": "What to tell the worker." }
                },
                "required": ["packet", "message"]
            }
        }),
        json!({
            "name": "o8_packet_rerun",
            "description": "Restart a packet fresh — 'retry the failed packet', 'run the tooltip work again'. Optionally include spoken feedback about what went wrong last time. Identify the packet by part of its name. The user confirms first.",
            "parameters": {
                "type": "object",
                "properties": {
                    "packet": { "type": "string", "description": "Part of the packet's name, enough to identify it." },
                    "feedback": { "type": "string", "description": "Optional: what went wrong / what to do differently." }
                },
                "required": ["packet"]
            }
        }),
        json!({
            "name": "o8_orchestrator_draft",
            "description": "Put a spoken message into o8's orchestrator chat composer as a DRAFT — 'tell the orchestrator to look at the failing CI'. Never sends: the user reviews the draft and presses send themselves. Use for messages/questions TO the orchestrator; use o8_dispatch when the user wants actual coding work kicked off.",
            "parameters": {
                "type": "object",
                "properties": {
                    "message": { "type": "string", "description": "The message to draft into the orchestrator composer." }
                },
                "required": ["message"]
            }
        }),
        json!({
            "name": "gh_issue_create",
            "description": "File a GitHub issue on a repo — voice capture to the tracker: 'file an issue on o8: the dock flickers on wake'. Give it a clear Title Case title and put the user's full description in the body. The user confirms first.",
            "parameters": {
                "type": "object",
                "properties": {
                    "repo": { "type": "string", "description": "Repo folder name, e.g. 'o8'." },
                    "title": { "type": "string", "description": "Short, clear issue title." },
                    "body": { "type": "string", "description": "The full description, in the user's words plus any useful detail." }
                },
                "required": ["repo", "title"]
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

/// Front-brain tool list honoring the escalation policy (`voice_escalation`).
/// "off" withholds the `escalate` handoff so the front brain handles everything
/// inline (the background Claude brain is disabled); "auto"/"deep" keep it.
/// The background Claude brain strips `escalate` itself (see `claude.rs`), so
/// this is only consulted by the front brains.
pub fn enabled_tools_for(escalation: &str) -> Vec<Value> {
    enabled_tools()
        .into_iter()
        .filter(|tool| {
            escalation != "off"
                || tool.get("name").and_then(|n| n.as_str()) != Some("escalate")
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
        "mac_reminders_update" => mac_reminders::update(args).await,
        "mac_calendar_list_events" => mac_calendar::list_events(args).await,
        "mac_calendar_create_event" => mac_calendar::create_event(args).await,
        "mac_calendar_update_event" => mac_calendar::update_event(args).await,
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
        "escalate" => {
            let task = args
                .get("task")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if task.is_empty() {
                return Err("escalate requires a non-empty `task`".to_string());
            }
            let is_orchestrator =
                args.get("target").and_then(|v| v.as_str()) == Some("orchestrator");
            if is_orchestrator {
                // Code-repo work → reuse the existing dispatch tool, but re-impose
                // its confirm card here: `escalate` is ReadOnly, so the loop did
                // NOT card it, and a worker spawn must never go silent.
                if !super::confirm_if_needed(ctx, "o8_dispatch", &args).await {
                    return Ok(json!({ "error": "User declined this action", "declined_by_user": true }));
                }
                o8_bridge::dispatch(args).await
            } else {
                // Heavy personal/Mac task → hand to the background Claude brain and
                // let the front brain ack instantly. Fire-and-forget; results reach
                // the user via the dock + TTS when the background run finishes.
                super::spawn_claude_task(ctx.app.clone(), task);
                Ok(json!({
                    "status": "handed_off",
                    "target": "claude_brain",
                    "message": "A more capable background brain is now working on this. Give the user a short spoken acknowledgement (e.g. \"On it — I'll get that going and let you know.\") and do not call more tools."
                }))
            }
        }
        "o8_canvas" => {
            let verb = args
                .get("verb")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if verb.is_empty() {
                return Err("o8_canvas requires a `verb`".to_string());
            }
            o8_bridge::canvas_intent(&verb, args).await
        }
        "o8_browser_read" => o8_bridge::browser_read(args).await,
        "o8_browser_act" => o8_bridge::browser_act(args).await,
        "o8_review_diff" => o8_bridge::review_diff(args).await,
        "read_screen" => crate::agent::screen::read_screen(ctx, args).await,
        "o8_ui_open" => o8_ui::open(&ctx.app, args),
        "o8_ui_set" => o8_ui::set_setting(&ctx.app, args),
        "o8_panel_read" => o8_bridge::panel_read(args).await,
        "o8_recap" => o8_bridge::recap(args).await,
        "o8_usage" => o8_bridge::usage(args).await,
        "term_list" => terminal_ctl::list(args).await,
        "term_read" => terminal_ctl::read(args).await,
        "term_send" => terminal_ctl::send(args).await,
        "term_interrupt" => terminal_ctl::interrupt(args).await,
        "term_key" => terminal_ctl::key(args).await,
        "term_new" => terminal_ctl::new(args).await,
        "term_watch" => terminal_ctl::watch(&ctx.app, args),
        "o8_packet_steer" => o8_bridge::packet_steer(args).await,
        "o8_packet_rerun" => o8_bridge::packet_rerun(args).await,
        "o8_orchestrator_draft" => o8_ui::orchestrator_draft(&ctx.app, args),
        "gh_issue_create" => git_github::issue_create(args).await,
        "mac_weather" => mac_weather::current(args).await,
        "mac_volume" => mac_system::volume(args).await,
        "o8_add_repo" => o8_bridge::add_repo(args).await,
        "mac_music_playlists" => mac_music::playlists(args).await,
        "mac_music_play" => mac_music::play(args).await,
        "mac_music_pause" => mac_music::pause(args).await,
        "mac_music_next" => mac_music::next(args).await,
        "mac_music_previous" => mac_music::previous(args).await,
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

#[cfg(test)]
mod escalation_tests {
    use super::*;

    fn has_escalate(tools: &[Value]) -> bool {
        tools
            .iter()
            .any(|t| t.get("name").and_then(|n| n.as_str()) == Some("escalate"))
    }

    #[test]
    fn off_withholds_escalate_other_policies_keep_it() {
        assert!(!has_escalate(&enabled_tools_for("off")), "off must hide escalate");
        assert!(has_escalate(&enabled_tools_for("auto")), "auto must offer escalate");
        assert!(has_escalate(&enabled_tools_for("deep")), "deep must offer escalate");
    }

    #[test]
    fn escalate_is_in_the_base_enabled_set() {
        // escalate is ReadOnly, so enabled_tools() (which only drops Destructive)
        // must include it — the off-filter is the ONLY thing that removes it.
        assert!(has_escalate(&enabled_tools()));
    }
}
