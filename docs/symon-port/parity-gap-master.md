# Symon → o8 Voice Parity — Master Gap Report

> **Status snapshot (verified 2026-06-08 against `/Users/marquisehurtt/aqua-color` and `/Users/marquisehurtt/cortex-ide`).** The 99 candidate gaps from 4 mappers collapse to **~40 distinct items** after dedup. The core hotkey/STT pipeline is **at parity** (push-to-talk, double-tap long-form, Right-Option Ask, voice commands, paste-last, Sequoia tap fix, permissions, locale, daemon respawn). The remaining gaps cluster in: **audio cues, ducking wiring, screen-reading, dock answer-panel UI, and the entire Settings surface.**
>
> **Key correction to the candidate set:** `audio_ducker.rs` **already exists in o8** (97 lines, ported under #1207) — but it is **unwired**: `lib.rs:1` has `mod audio_ducker;` and there are **zero `duck()`/`restore()` call sites**. Aqua wires it at 10 sites in `lib.rs`. So #1207 is "ported, not connected," not "missing."

---

## 1. Voice / Audio (TTS, reading, Ask voice)

| Feature | o8 status | aqua source | parity notes | priority | effort |
|---|---|---|---|---|---|
| **Screen reading** (Cmd+Shift+R: capture → Gemini Vision → chunked TTS, pause/resume/skip/speed) | **MISSING** | `reading.rs:1-1193` (`ReadingSession`, `run_session`, `gemini_vision_extract`); aqua `lib.rs` Fn+R handler | No `reading.rs`, no `capture/` dir in o8. The single largest feature gap. Needs capture infra + Vision + session lifecycle + playback control. | medium | large |
| **Screen capture infra** (permission checks, async full-screen capture) | **MISSING** | `capture/macos.rs` (`has/request_screen_capture_permission`, `capture_full_screen`) | `src-tauri/src/capture/` does not exist in o8. Prereq for screen reading **and** Ask-with-screen-context. | medium | medium |
| **Speak Selection chunking + events + speed** | **partial** | `reading.rs:196-414` (`start_selection`, one-chunk lookahead, retry, `reading-text`/`reading-progress` events) | o8 has `grab_selection` (`paste.rs`) + `tts_speak` (`tts/playback.rs`) wired to Cmd+Shift+S, but no chunking, lookahead, progress events, or mid-playback speed change. | medium | medium |
| **Playback speed control mid-playback** | **partial** | `reading.rs:479-494` (`set_speed`/`get_speed`, atomic Mutex) | o8 `tts/mod.rs:1-98` loads `reading_speed` from prefs but `tts/playback.rs` (580 lines) has no live speed API — speed only flows through at config time. | low | small |
| **Speech text normalization for TTS** (strip ANSI/markdown/box-drawing, expand units/currency/URLs, linearize tables) | **MISSING** | `speech_text.rs:1-1027` (`prepare_text_for_speech`, `expand_unit_token`, `shorten_url_core`) | o8 ships raw text to TTS → mispronounces code, URLs, prices, terminal output. ~40KB of preprocessing absent. | low | large |
| **Symon assistant voice** (Wavenet-I/H pair + ElevenLabs personal override + RMS envelope frames for waveform) | **partial** | `symon_voice.rs:1-346` (`speak_answer`, `compute_envelope`, `audio-level` emits) | o8 TTS routes ElevenLabs/Google/`say` (`tts/elevenlabs.rs`, `tts/google.rs`, `tts/native_say.rs`) but uses one hardcoded voice/provider; no Wavenet-I/H fallback pair, no audio-level envelope emission. | low | medium |
| **Reading transcript + `on_reading_finished` triggers** | **MISSING** | `reading.rs:981-1015`; `triggers.rs:507-515` | No reading automation/transcript in o8 (no `triggers.rs`). Tail of the screen-reading feature. | low | small |
| **QA retrieval pipeline** (selection-first → screenshot fallback → local read-only agent) | **partial** | `qa.rs:100-600+` (`QuestionIntent`, `select_evidence_slice`, `synthesize_context_snapshot`) | o8 `ai/gemini_ask.rs` (123 lines) does direct-Gemini single-shot only; no selection/screenshot routing or local-agent fallback. | low | large |
| **Ask answer with structured metadata** (evidence pairs, confidence, next_action) | **partial** | `qa.rs:69-85` (`QuestionResponse`) | o8 Ask returns answer text only via `o8:ask-answer` (`lib.rs:2807`); no evidence/confidence/next_action schema or panel. | medium | medium |

---

## 2. Sounds (procedural audio cues + ducking) — **#1207, #1208**

| Feature | o8 status | aqua source | parity notes | priority | effort |
|---|---|---|---|---|---|
| **Audio ducking** (Fn-hold dims system volume to 20%, restores on release) — **#1207** | **PORTED-BUT-UNWIRED** | aqua `audio_ducker.rs:1-86` + 10 call sites in `lib.rs` (`duck`/`restore` at lines 2375, 2411, 2445, 2628, 2847, 2926, 2956, 3051, 3153) | o8 `audio_ducker.rs:1-97` is a complete port (`DUCK_SCALAR=0.20`, `read/set_output_volume`) but the **only** reference is `mod audio_ducker;` at `lib.rs:1`. **Zero `duck()`/`restore()` calls.** Wire into: Fn down-edge, Right-Option Ask begin, long-form start (`fn_hotkey.rs`), and all finalize/cancel/Escape paths. | medium | small |
| **Procedural sound cues** (Tink/Pop/Morse/Chime/Done/ReadStart/ReadDone chirps via synthesized frequency sweeps, cached on a rodio thread, played non-blocking on Fn events) — **#1208** | **MISSING** | aqua `lib.rs:327-435` (`spawn_audio_worker`, `chirp_samples`, `double_blip_samples`, `play_sound`) | `grep play_sound\|chirp_samples\|spawn_audio_worker` → **0 hits in o8**. Synthesis is cheap (precomputed); the work is the worker thread + mpsc cache + wiring `play_sound()` into Fn-down/Fn-up/paste/Ask/reading-start/reading-done. | medium | small–medium |

---

## 3. Dictation / Hotkeys — **AT PARITY** (verified)

> This whole slice is **done**. Listed for the operator's confidence; **no build work needed**.

| Feature | o8 status | o8 location | parity notes |
|---|---|---|---|
| Fn double-tap → long-form toggle (480ms window) | **present** | `fn_hotkey.rs:113` (`LONG_FORM_FN_DOUBLE_TAP_MS=480`), `:221` (`consume_double_tap_brush`), `:435` | Exact port incl. brush-consume on both branches + session fence. |
| Right-Option Ask (press-record, release-speak, 120ms brush guard) | **present** | `fn_hotkey.rs:139` (`ASK_MODE`), `:449-535` (begin/end/discard, session fencing) | Routes polished question → Gemini → TTS via `take_ask_mode`. |
| Voice commands (scratch that / undo / new line / new paragraph / say) | **present** | `stt/mod.rs:98-160` | System-origin-gated; verbatim behavior. |
| CGEventTap HID-level + Sequoia Fn-UP 40ms poll fallback | **present** | `fn_hotkey.rs:642` (`CGEventTapLocation::HID`), poll loop | Exact Sequoia regression fix. |
| Fn-key binding check (`AppleFnUsageType`) | **present** | `fn_hotkey.rs:572` → `mac_perms::fn_key_usage_type()` | Detection + warn. |
| Accessibility / Input-Monitoring permission checks on startup | **present** | `fn_hotkey.rs` → `mac_perms::accessibility_permission_granted` | Input-monitoring exposed in `mac_perms` (minor onboarding-sequence divergence, not a feature gap). |
| Escape → cancel long-form + stop TTS (dual handler) | **present** | `fn_hotkey.rs:676-699` | Long-form cancel + `tts::playback::stop`. |
| STT daemon respawn on crash | **present** | `stt/mod.rs:493` (`respawn`) | Respawns dead daemon between dictations. |
| Locale config to STT daemon | **present** | `stt/mod.rs` + `lib.rs` (`o8_stt_locale`) | Wired. |
| Paste-last (⌘⌥V) | **present** | `fn_hotkey.rs:76` (`LAST_VOICE_TRANSCRIPT`) + ⌘⌥V shortcut | Single-slot vs aqua's DB, but functionally equivalent for P3. |
| Dock always-on, morphs idle↔recording↔success | **present** | `dock_window.rs:55-137`; `fn_hotkey.rs:271-335` | Created visible; morphs via `system-start`/`system-idle`/`system-pasted` events. |
| Dock top-center positioning (multi-monitor, scale factor) | **present** | `dock_window.rs:256-273` | No user-drag reposition yet (future), base positioning correct. |

**Caveat carried forward to Sounds slice:** the long-form start/cancel/Escape paths in `fn_hotkey.rs` are correct but **do not call `audio_ducker::duck/restore`** — see #1207 above.

---

## 4. Dock / Visual (notch answer panel, pill modes, components)

| Feature | o8 status | aqua source | parity notes | priority | effort |
|---|---|---|---|---|---|
| **Notch answer panel** (multi-turn conversation: You/Symon turns, scrollable thread, copy buttons, markdown answers) | **partial** | `NotchSurface.svelte:89-159` (`ndock__thread`, `nturn*`) | o8 `DockNotchSurface.tsx:306-533` morphs idle/listening/thinking/done + has TTS pause/stop, but **no answer/conversation panel** — collapses to idle without showing the reply. The biggest visual gap. | high | large |
| **MarkdownAnswer rendering** (h2-h5, lists, quotes, code blocks w/ lang labels, streaming cursor) | **MISSING** | `MarkdownAnswer.svelte` | No answer rendering in o8 dock. Pairs with the answer panel above. | high | large |
| **Long-form dictation panel** (live streaming transcript + Send/Cancel + blinking caret + "Tap Fn to send · Esc cancels" hint) | **MISSING** | `NotchSurface.svelte:80-88` (`ndock--longform`); `Pill.svelte:776-820` | o8 maps transcribing/polishing → "thinking" (squiggle only); never shows live/polished transcript in the dock. | medium | large |
| **TTS transport meter** (3-bar animated meter reacting to audio level, beside pause/stop) | **partial** | `NotchSurface.svelte:135-159` (`ndock__meter`) | o8 `DockNotchSurface.tsx:388-424` has pause/play/stop buttons but **no animated level meter**, and no live waveform during speaking. | medium | small |
| **Reading mode UI** (current word, skip-back/play/skip-forward transport, progress bar) | **MISSING** | `Pill.svelte:690-767` (`layer--reading`) | No reading-mode UI in dock or in-window pill (blocked on the reading feature itself). | medium | medium |
| **Pill panel mode** (growing transcript scroll + live waveform + Send/Cancel) | **partial** | `Pill.svelte:776-820` | In-window `DictationPill.tsx` has no panel mode; dock has no panel mode. | medium | large |
| **Long-form hint overlay** ("Tap Fn to send · Esc cancels", 3s) | **MISSING** | `Pill.svelte:585-587, 866-900` | No hint in o8. | low | small |
| **DictationToolbar** (close, target-app label, mic-source label, pulsing REC dot) | **MISSING** | `DictationToolbar.svelte` | None in o8 pill/dock. | low | medium |
| **Pill tasks / confirming layers** (agent task list + destructive-confirm card) | **MISSING** | `Pill.svelte:830-846` | No agent task UI in pill (out of voice-P3 scope). | low | large |
| **MorphOrb** (Threlte/Three.js 3D audio-reactive sphere) | **MISSING** | `MorphOrb.svelte:16-59` | No 3D component in o8; aqua landing/Ask flourish. | low | large |
| **ThinkingText** (animated dots + shimmer tail) | **MISSING** | `ThinkingText.svelte` | o8 uses squiggle loader instead; cosmetic. | low | small |
| **WaveformVisualizer / PlayButton / Close button** (reusable reading-UI primitives) | **MISSING** | `WaveformVisualizer.svelte`, `PlayButton.svelte`, `NotchSurface.svelte:97-101` | o8 uses inline buttons; reading primitives unneeded until reading lands. | low | small |
| Ink-color CSS-variable theming | **partial** | `NotchSurface.svelte` (`--symon-*` vars) | o8 `DockNotchSurface.tsx` uses literal RGBA (documented exception). Structural, not visual. | low | small |
| Idle wave bar (legacy bottom-pill resting visual) | **MISSING** | `Pill.svelte:608-617, 1005-1027` | o8 in-window pill hidden when idle; dock has idle sliver. Not needed (dock-only UX). | low | small |
| Canvas EQ waveform / SquiggleLoader / idle capsule / listening+done capsules / play-pause morph / RTL partial / listening waveform / thinking squiggle | **present** | `SymonPillWaveform.svelte`, `SquiggleLoader.svelte`, `NotchSurface.svelte:192-236` | **Ported 1:1** in `DictationPill.tsx:118-293` and `DockNotchSurface.tsx:188-471`. **No work needed.** | — | — |

---

## 5. Ask

| Feature | o8 status | aqua source | parity notes | priority | effort |
|---|---|---|---|---|---|
| **Ask answer panel in dock** (show question + answer + context, grow/shrink) | **partial** | aqua hidden assistant NSWindow (`ensure_symon_assistant_visible`, `park_hidden_assistant_window`) | o8 has `dock_set_expanded` (`lib.rs:2773`) + `o8:ask-answer` emit (`lib.rs:2807`) + `/dictation-pill` route. Aqua uses a separate floating window; o8's docked panel is **intentional** for the IDE. Gap = the rendered panel content (turns/markdown) — see §4. | medium | medium |
| **Multi-turn Ask threads + persistence + cards** (`history[]`, `save_ask_thread`, `ask-card` artifact events, stream-delta/done) | **partial** | `qa.rs` (`stream_ask_question`, phase-3 cards); aqua `commands.rs:548-657` | o8 `ask_question` spawns + speaks one answer; no thread history, no card/artifact streaming, no `cancel_voice_question`. | medium | large |
| **Voice-question entry** (press voice button, dictate question, submit) | **MISSING** | aqua `commands.rs:660-694` (`start/submit/cancel_voice_question`) | o8 Ask is hotkey/text; no voice-button entry to the Ask composer. (Right-Option voice→Ask **is** present; this is the UI-button path.) | low | large |
| **Screen capture for Ask** (base64 PNG screenshot as Vision context) | **MISSING** | aqua `commands.rs:444-456` (`capture_screen`); `qa.rs` `screenshot_jpeg` | Blocked on the capture module (§1). Enables "ask about what's on screen." | medium | medium |

---

## 6. Settings — **#1209** (entire surface missing for the voice stack)

| Feature | o8 status | aqua source | parity notes | priority | effort |
|---|---|---|---|---|---|
| **Voice-stack Settings panel** (12 sub-pages) — **#1209** | **MISSING** | aqua `SettingsPage.svelte` (660+ lines) + Account/Agent/Dictionary/Founder/History/Instructions/LongForm/Replacements/ReportIssue/Stats pages | o8's `SettingsQuickDrawer.tsx`/`SettingsPage.tsx` are **IDE** settings — none of the voice controls exist. Umbrella for most rows below. | high | large |
| **Generic preference store** (`save/load_preference`, `preferences.json`, mtime-aware cross-process cache) | **partial** | aqua `preferences.rs`; `commands.rs:1784-1795` | o8 uses `~/.o8/dictation.json` (`stt/keys.rs`) + env; no generic 30-key store. No `preferences.rs` in o8. | high | large |
| **Permission/onboarding flow** (welcome → accessibility → input-monitoring → mic → screen-recording → restart → done, polling + auto-advance) | **MISSING** | aqua `commands.rs:978-1151`; `OnboardingApp.svelte` | o8 relies on inline system prompts; no coordinated onboarding journey or `complete_onboarding` marker. | high | large |
| Polish provider/model selection (gemini / openrouter / claude-code-cli) + benchmarking | **MISSING** | `commands.rs:856-945`; `SettingsPage.svelte:37-102`; `stt/polish.rs` | o8 polish (`stt/polish.rs`) is hardcoded/unexposed. | low | medium |
| TTS provider + voice selection + preview | **partial** | `commands.rs:516-545` (`preview_reading_voice`); `SettingsPage.svelte:40-118` | o8 has providers but no picker UI, no `tts_voice_id` persistence, no preview-audition button. | medium | medium |
| Dictation mic selection | **MISSING** | `commands.rs:1001-1035` (`list/set_dictation_microphone`) | o8 uses system default; no enumerate/select. | medium | medium |
| Dictation locale **UI** | **partial** | `SettingsPage.svelte:120-130` (9 locales) | Backend `o8_stt_locale` present; no dropdown/persistence/onboarding question. | medium | small |
| Output-tone selector (Auto/Raw/Clean/Formal/Casual) | **MISSING** | `SettingsPage.svelte:39, 132-138` | No tone setting threaded into polish prompt. | low | small |
| Dictionary + replacements editor | **MISSING** | `DictionaryPage.svelte`, `ReplacementsPage.svelte`; `stt/commands.rs` filters | No custom-word/regex editor in o8. | low | medium |
| Transcript history + replay/rerun | **MISSING** | `commands.rs:697-769`; `HistoryPage.svelte`; aqua `transcript.rs` | o8 dictations are ephemeral — **no transcript store** (finalize never persists). Prereq for Stats + History + benchmarking. | medium | large |
| Stats dashboard (WPM/streak/levels) | **MISSING** | `commands.rs:1154-1243`; `StatsPage.svelte` | Needs transcript store first. | low | large |
| Gemini usage/cost tracking | **MISSING** | `commands.rs:1272-1296` | No usage analytics in o8. | low | small |
| Report Issue / feedback form (context snapshot) | **MISSING** | `commands.rs:2309-2489`; `ReportIssuePage.svelte` | No in-app reporter. | low | medium |
| Pill geometry commands (resize/reposition, notch-vs-bottom anchor, reading-bar resize, window level) | **partial** | `commands.rs:1530-1753` | o8 has `dock_set_expanded` only; no notch/bottom anchor toggle, multi-monitor inset, or reading-bar resize. | medium | medium |
| Pill native glass (AppKit vibrancy backing) | **MISSING** | `commands.rs:1640-1660`; aqua `native_glass.rs` | o8 dock is CSS-only (note: o8 *has* `native_glass.rs`? — **no**, absent; aqua-only). | low | small |
| Pill movement/anchor persistence | **MISSING** | `commands.rs:1569-1599`; `SettingsPage.svelte:81` | No drag/anchor persistence in o8. | low | small |
| Notch-surface toggle + notch-idle-pill toggle | **MISSING** | `commands.rs:1545-1717`; `SettingsPage.svelte:85,87` | o8 is dock-top only; no notch/bottom switch UI. | low | medium |
| Listening waveform vs clean-meter toggle | **MISSING** | `SettingsPage.svelte:83` | No toggle in o8. | low | small |
| Account/license (Stripe checkout, magic-link, portal) | **MISSING** | `commands.rs:1824-2181`; `AccountPage.svelte` | N/A unless o8 voice goes paid (o8 has its own M1–M5 license server — different system). | low | large |
| Autostart / launch-at-login toggle | **MISSING** | `commands.rs:1082-1105` | No UI (backend may support). | low | small |
| Reveal-in-Finder buttons (logs/db/prefs) | **partial** | `commands.rs:1390-1439` | No `reveal_*` commands/buttons in o8. | low | small |
| Diagnostics snapshot (version/paths/permissions/API status) | **partial** | `commands.rs:1304-1315` | o8 has `get_desktop_info` only; no combined diagnostics display. | low | small |
| Fn-hotkey enable/disable toggle (`toggle_filter`) | **MISSING** | `commands.rs:1518-1521` | No global voice-disable switch in o8. | low | small |
| Founder-edition toggle / workspace-context toggle / agent cursor-warp opt-in / release-channel / visual-profile detection / long-form transcript tuner | **MISSING/partial** | `commands.rs:163-167, 199, 948-975, 1756-1776`; `SettingsPage.svelte:71,74,78` | All env-gated or absent in o8; low-priority settings rows. | low | small–medium |

---

## Build order — path to full parity

Ordered by **value × cheapness**. Bracketed tags are the tracked issues.

**Tier 0 — finish what's already half-built (high value, small effort):**
1. **Wire audio ducking [#1207].** The port exists (`src-tauri/src/audio_ducker.rs:1-97`) — just unwired. Add `duck()` on Fn down-edge / Right-Option Ask begin / long-form start, and `restore()` on every finalize/cancel/Escape path in `fn_hotkey.rs` (mirror aqua's 10 call sites in `lib.rs`). **~1 file, closes #1207.**
2. **Procedural sound cues [#1208].** Port `spawn_audio_worker` + `chirp_samples` + `double_blip_samples` + `play_sound` from aqua `lib.rs:327-435` into a new o8 module; cache 7 chirps on a rodio thread; call `play_sound()` from the same Fn/paste/Ask hooks. Synthesis is precomputed; the work is integration. **Closes #1208.**
3. **TTS transport meter + speaking waveform** in `DockNotchSurface.tsx` (port `ndock__meter`, `NotchSurface.svelte:135-159`). Reuse the existing canvas EQ. Makes "Speaking" state feel alive.

**Tier 1 — the visible Ask experience (high value, larger effort):**
4. **Notch answer panel + MarkdownAnswer** in `DockNotchSurface.tsx` (port `NotchSurface.svelte:89-159` + `MarkdownAnswer.svelte`). o8 already emits `o8:ask-answer` (`lib.rs:2807`) — wire it to a rendered turn/markdown view. This is the single highest-impact visual gap.
5. **Long-form dictation panel** (live transcript + Send/Cancel + hint) — surfaces the polished text the dock currently hides.

**Tier 2 — Settings foundation [#1209] (unblocks ~20 rows):**
6. **Generic preference store** (`preferences.rs` equivalent + `save/load_preference` commands, mtime-aware) — every settings row depends on this.
7. **Voice Settings panel shell + the high-leverage controls first:** TTS voice selection + preview, dictation mic picker, locale dropdown, reading-speed slider. **Begins closing #1209.**
8. **Onboarding/permission journey** (welcome → accessibility → input-monitoring → mic → screen-recording → done) + `complete_onboarding` marker — first-run UX.

**Tier 3 — the screen-reading feature (largest, self-contained):**
9. **Screen capture module** (`capture/macos.rs` port: permission + `capture_full_screen`) — prereq for both reading and Ask-with-screen-context.
10. **`reading.rs` session engine** (Vision extract + chunked TTS + skip/pause/speed) + **reading-mode dock UI** + `on_reading_finished` triggers.
11. **Speech text normalization** (`speech_text.rs`) — pairs with reading so TTS stops mispronouncing code/URLs/prices.

**Tier 4 — corpus & analytics (defer; needs persistence):**
12. **Transcript store** → then **History/replay**, **Stats dashboard**, **polish benchmarking**, **usage/cost tracking**, **Report-Issue form**. Each is low-priority and all depend on persisting dictations (which o8 currently does not do, by design — confirm with operator before building, as the o8 CLAUDE.md notes this was intentionally dropped for privacy).

**Explicitly NOT parity gaps (skip):** MorphOrb 3D, Stripe license flow (o8 has its own license server), agent task/confirm pill layers, derived-context memory mining (gated off even in aqua). The entire **Dictation/Hotkeys slice (§3) is already at parity** — no work.

**Relevant files:** o8 Rust at `/Users/marquisehurtt/cortex-ide/src-tauri/src/` (`fn_hotkey.rs`, `dock_window.rs`, `audio_ducker.rs`, `ai/gemini_ask.rs`, `stt/`, `tts/`); o8 React at `/Users/marquisehurtt/cortex-ide/src/components/desktop/dictation/` (`DockNotchSurface.tsx`, `DictationPill.tsx`); aqua reference at `/Users/marquisehurtt/aqua-color/src-tauri/src/` (`reading.rs`, `speech_text.rs`, `qa.rs`, `symon_voice.rs`, `commands.rs`) and `/Users/marquisehurtt/aqua-color/src/lib/settings/SettingsPage.svelte`.