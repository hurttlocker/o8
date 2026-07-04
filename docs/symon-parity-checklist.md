# Symon → o8 100% parity checklist

**Status:** 2026-06-08 · from the exhaustive parity audit (aqua-color v0.1.15 vs o8 0.1.268). Goal: o8 does **everything** Symon does. Full per-item detail: workflow `wiqbbb6u2` output. Part of #1205.

**Current parity: ~40%.** Done: on-device Apple STT, Gemini audio-grounded polish, Whisper re-transcribe, deterministic voice-commands, paste-into-app, Fn-hold push-to-talk, in-window pill, autostart, Voice settings, perm checks. The other ~60% below.

## Build order → 100%
- **P0 — Always-on dock (the operator's #1 visible want):** dock window created *visible* + shown at boot (top-center, level 25, nonactivating, **persistent**); **fix the paint** — `DictationPillView` IDLE branch renders nothing today → the transparent window is invisible; add a persistent idle capsule/dot (Symon's notch idle). Fn morphs idle→recording→polishing→idle (never hides). Wire `frontmost_app` + dictionary/instructions/replacements into `run_finalize`'s polish ctx (currently dead). Port `commands.rs` voice-commands on the native Fn path. Stand up `preferences.rs`.
- **P1 — capture polish:** `audio_ducker.rs` (duck audio while dictating); dictionary UI + pref; phrase replacements + app file-tag filters + UI; custom-instructions textarea + pref.
- **P2 — Voice settings UIs:** dictionary/replacements/instructions/Whisper-toggle/local-vs-cloud.
- **P3 — hotkeys:** add `tauri-plugin-global-shortcut`; **double-tap-Fn** (long-form), **Cmd+Shift+Space** (toggle dock), **Cmd+Shift+,** (settings), **Cmd+Alt+V** (paste last) — all inside the ONE HID tap + poll. (Fn+R, Right-Option, Cmd+Shift+R / Ctrl+Shift+S need their pipelines below.)
- **P4 — TTS:** Edge (free, native Rust) + Google + ElevenLabs(founder) + speech-text normalization; **Ctrl+Shift+S speak-selection** + `grab_selection`; read-aloud "say".
- **P5 — screen reading:** capture→Gemini-Vision→TTS; **Fn+R** + reading sub-controls (Space/arrows/Esc); **Cmd+Shift+R**; needs Screen-Recording TCC.
- **P6 — history:** transcript store + history/replay/rerun + stats.
- **P7 — Ask Q&A:** the assistant surface (`qa.rs`) + spoken voice + RMS envelope + dock answer panel + **Right-Option hold**.
- **P8 — overlay annotations** (arrows/cursor warp).
- **P9 — Mac-action AGENT** (~150KB): safety/queue/quota/tools (Mail/Calendar/Reminders/Notes/Contacts/Shortcuts/FS/CSV/apps) + providers (Gemini/OpenRouter) + router + confirm card + voice-actions (open/launch); browser CUA last.
- **P10 — triggers (skip/reconcile w/ Cortex) / memories / founder voice.** De-Symonize every ported file throughout.

## Open forks (operator)
- **Mac-action AGENT:** ship the ~150KB layer (SafetyClass → o8 approval) or out-of-scope? (full parity ⇒ ship it.)
- **Ask Q&A / dock answer panel:** screen-aware dock Ask vs dictation-only dock? (gates TTS/overlay/agent depth.)
- **TTS default:** Edge (free) vs Google (key); ship the ElevenLabs founder voice?
- **Modes:** fold pro/founder into o8 entitlement + a separate local-vs-cloud toggle; agent quota 5/150 vs the $19/$29 tiers.
- **Transcript store:** standalone rusqlite (recommended) vs fold into Drizzle.
- **Triggers:** ship disabled / skip (overlaps Cortex v2 + o8 automations).
- **New TCC o8 will need:** Screen Recording (reading) + Automation/AppleEvents (some agent tools) — confirm acceptable.
