# Agent Tool-Calling — Seed Landed + Integration Note

**What this is:** Claude (orchestrator) ported the rest of Symon's **Tier-1 native macOS tool belt** into o8's existing `agent/` module, additively. It **compiles clean** (`cargo check` green, no warnings in the new modules) and is model-agnostic. This note covers what's done and the few things you finish to make it live.

Date: 2026-06-09. Branch: whatever `cortex-ide` is on (I only added/edited files under `src-tauri/src/agent/`).

---

## What landed (done, compiles)

Your agent module already had the V1 starter set (open_app, reminders, calendar list/create, notes search/create). I matched your exact conventions (`Result<Value, String>`, `spawn_blocking` + `run_applescript`/`run_osascript_jxa`, safety-by-name, sandbox keyed off `~/.o8`) and filled in the rest of Symon's Tier-1 catalog.

**New files** (`src-tauri/src/agent/tools/`): `mac_contacts.rs`, `mac_mail.rs`, `mac_shortcuts.rs`, `filesystem.rs`, `csv.rs`.
**Extended:** `mac_notes.rs` (+`append`), `mac_calendar.rs` (+`delete_event`).
**Wired:** `tools/mod.rs` (module decls + 14 new schemas in `all_tools()` + 14 dispatch arms), `safety.rs` (14 new `tool_safety_class` arms).

**Catalog is now 22 Tier-1 tools** (was 8). `enabled_tools()` already withholds Destructive from the model, so the model only *sees* the safe set until you trust the confirm gate.

| Tool | Safety | Notes |
|---|---|---|
| open_app, mac_reminders_list, mac_calendar_list_events, mac_notes_search, mac_contacts_search, mac_mail_search, mac_mail_read, mac_shortcuts_list, fs_read_text, fs_spotlight, csv_read | **ReadOnly** | autonomous |
| mac_reminders_create/complete, mac_calendar_create_event, mac_notes_create/append, mac_mail_draft, fs_write_text, csv_write | **Reversible** | confirm card unless blanket consent; writes sandboxed to `~/.o8/agent-output/` |
| mac_calendar_delete_event, mac_mail_send_draft, mac_shortcuts_run | **Destructive** | always confirm; **withheld from the model schema** by `enabled_tools()` |

Hardening carried over / improved: `fs_read_text` 8 KB cap floored to a char boundary (no multibyte panic); `fs_write_text`/`csv_write` refuse anything outside `~/.o8/agent-output/`; `is_never_do_path` guard on all path args; `mac_mail_read` uses an explicit length clamp (not AppleScript `min()`); shell-free arg passing for `open`/`shortcuts`/`mdfind`.

---

## What you finish (the "just finish up")

1. **Confirm the loop offers the full set.** `all_tools()`/`enabled_tools()`/`dispatch_tool_call()` are the *same* functions your `agent/gemini.rs` (and `openrouter.rs`) loop already call — so the 14 new tools flow through automatically. Just verify `gemini.rs` wraps `enabled_tools()` into Gemini `functionDeclarations` and routes results back through `dispatch_tool_call`. (Model-agnostic: the schemas are OpenAI-`function` shape; Gemini Flash function-calling consumes the same `{name, description, parameters}` — no per-model change needed.)
2. **Route Reversible tools through the confirm card.** The new Reversible tools (`mac_notes_append`, `mac_mail_draft`, `fs_write_text`, `csv_write`) must hit your `confirm_if_needed` gate before dispatch, same as `mac_reminders_create`. Destructive ones are auto-withheld; re-include them in `enabled_tools()` only after the confirm card is trusted live.
3. **TCC / entitlements.** Each app's *first* osascript call triggers an Automation prompt; the tools error until granted. Make sure the app has (Info.plist usage strings + the prompts fire): **Automation** for Reminders / Calendar / Notes / Contacts / Mail, plus Contacts/Calendar/Reminders privacy, and file access for `fs_*`/`csv_*`. The `shortcuts` CLI must exist (ships with macOS 12+). Without these, calls return an osascript permission error (not a crash).
4. **Tier-2 is intentionally NOT here.** The browser/`web_*` tools and the operator-mcp fleet bridge are your Tier-2 moat work — out of scope for this Tier-1 seed. Add them as a separate dispatch family.
5. **Spot-check the AppleScript live** (dialects vary by macOS): `mac_mail_search/read/draft`, `mac_contacts_search`, `mac_shortcuts_list/run`, `mac_calendar_delete_event` (scans all calendars by exact summary), and `mac_notes_append` (appends via `<br>` since Notes bodies are HTML). The osascript bodies are faithful ports but I couldn't run them headless here.

---

## Quick test recipe
With `agent_beta_enabled` on, ask the voice agent things that exercise the new tools:
- "search my contacts for Sydney" → `mac_contacts_search` (ReadOnly, runs).
- "draft an email to X about Y" → `mac_mail_draft` (Reversible → confirm card → saves to Drafts).
- "what unread mail do I have" → `mac_mail_read`.
- "list my shortcuts" → `mac_shortcuts_list`.
- "append 'call back' to my Groceries note" → `mac_notes_append` (confirm).
Destructive (`send draft`, `delete event`, `run shortcut`) won't be offered until you re-enable them.

## Files touched
`src-tauri/src/agent/tools/{mac_contacts,mac_mail,mac_shortcuts,filesystem,csv}.rs` (new), `…/tools/{mac_notes,mac_calendar,mod}.rs` (edited), `…/agent/safety.rs` (edited). Nothing outside `agent/` — fully additive.
