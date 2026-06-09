# Symon → o8 — MASTER Parity Dossier

**Audience:** the o8 agent porting **Symon** (`~/aqua-color`, Tauri v2 + Svelte + Rust) into **o8** (cortex-ide, Tauri v2 + Next.js/React) for **complete feature parity** — every surface, every hotkey, every preference, including **Founder's Edition / ElevenLabs**.

**Source of truth:** `~/aqua-color`. o8 is also Tauri v2, so the Rust/NSWindow/CGEvent layer ports nearly 1:1; only the Svelte UI becomes React. Every value below is from the live code with `path:line` citations — **read the source, don't trust prose.** This dossier was assembled by reading the actual implementation on 2026‑06‑08.

> o8 house rules to honor: **inline styles only, no CSS classes**; the CSS/values here are the *contract*, apply as inline style objects. Claude orchestrates, Codex executes. `npx tsc --noEmit` before commits.

---

## 0. Parity scoreboard — what o8 has vs needs

| Surface | Symon status | o8 status | Priority |
|---|---|---|---|
| Notch-dock **window contract** (transparent/level-25/flush-top/click-through) | ✅ | ✅ **done** (`dock_window.rs`, even exceeds — all-Spaces + nonactivating) | — |
| Dictation **dock morph** (idle/listening/thinking/done) | ✅ | ⚠️ done but **listening grows per-token** (diverges); see Part 1 fix | P1 |
| **Whisper finalize** stage (supersedes Apple at finalize, default-ON) | ✅ | ❌ **missing** — o8 pastes Apple's live text, not Whisper's | **P0 correctness** |
| **Voice commands** (scratch that / new line / remove that…) | ✅ | ❌ missing | P1 |
| **Polish context** (audio + AX window context + dictionary/instructions/tone) | ✅ | ⚠️ verify — likely thin | P1 |
| **Double-tap-Fn long-form** | ✅ | ❌ missing | P2 |
| **Sounds** (tink/pop/morse/chime/done/read) | ✅ | ⚠️ partial | P2 |
| **Ask** (Right-Option) + **answer/speaking/longform panel** (440×360) | ✅ | ❌ **not ported** (Right-Option intentionally dropped) | **P0 feature** |
| **Speak / read-aloud** (Fn+R, Cmd+Shift+R, Cmd+Shift+S, speaking state) | ✅ | ❌ not ported | P1 |
| **TTS stack + Founder's Edition / ElevenLabs** | ✅ | ❌ not ported | **P0 (founder uses it)** |
| **Pointing overlay** ([POINT] arrows, [CLICK] gated) | ✅ (fixed on a branch) | ❌ not ported | P2 |
| **Settings / Preferences / Account / Surfaces / Triggers** | ✅ | ⚠️ partial — needs the pref model + license/proxy + surfaces | P1 |

Parts 1–6 are the specs; Part 7 is the consolidated preferences table; Part 8 lists **stale-doc traps** (don't port phantom features); Part 9 is the master checklist; Part 10 is the file index.

---

# Part 1 — Notch-Dock HUD (window contract + morph)

The full window-contract write-up (Tauri config, NSWindow recipe, level 25, positioning math, click-through) is in the companion file **`o8-notch-dock-parity-dossier.md`** and is already implemented in o8's `src-tauri/src/dock_window.rs`. Summary of the contract + the one open bug:

**Window contract (done in o8):** transparent + borderless + non-resizable + no-shadow + skip-taskbar, native `clearColor`/`setOpaque(false)`, **NSWindow level 25** (above the menu bar at 24), **top-center, flush to the top edge** (`y = monitor.origin_y`), click-through wrapper (`pointer-events:none`) with only the dock interactive. o8 also added `CanJoinAllSpaces | Stationary | FullScreenAuxiliary | IgnoresCycle` + `orderFrontRegardless` (nonactivating) — that's *above* Symon parity. Good.

**The single morphing element** — `NotchSurface.svelte`. One `.ndock` whose geometry animates between states on the spring `cubic-bezier(0.22,1,0.36,1)` (`width/height 0.5s`, `border-radius 0.46s`). The native window is sized **once** to **440×360** and never resized per state (per-state native resize was the snap bug).

**Per-state geometry (exact — `NotchSurface.svelte`):**

| State | W×H | radius | background | shadow extras | line |
|---|---|---|---|---|---|
| idle | 128×16 | `0 0 14px 14px` | brand gradient | `inset 0 -2px 6px …`; `backdrop-filter blur(10px) saturate(160%)` | `:192` |
| listening / thinking | 248×40 | `0 0 20px 20px` | dark scrim **over** brand gradient | `0 8px 22px rgba(40,40,80,.3)` | `:205` |
| done | 420×44 | `0 0 20px 20px` | dark scrim over brand | `inset 0 -2px 0 #43d6a0` (green underline) | `:223` |
| answer / speaking / longform (panel) | 440×360 | `0 0 26px 26px` | `var(--symon-surface-bg)` | `backdrop-filter blur(34px) saturate(140%)` | `:251` |

- **Brand gradient:** `linear-gradient(100deg, #aecdff 0%, #d7c2f1 46%, #f7d9bf 100%)`
- **Dark scrim:** `linear-gradient(rgba(13,11,26,.5), rgba(13,11,26,.5))` layered over brand.
- **Wave primitives:** EQ media-wave `SymonPillWaveform` (~30 gaussian bars, gradient `#88D1F1→#B1B4E5→#F5B8C4→#F4C977`) for audio (listening/speaking); `SquiggleLoader` for processing (thinking/polishing).

**🔧 Open bug — listening morph (P1).** o8's `DockNotchSurface.tsx:290-293` recomputes the listening capsule **width from the partial-transcript length on every token** and re-springs it (0.5s) each update → the capsule visibly chases your words. Symon's shipped `NotchSurface` listening state is a **fixed 248×40, wave-only — no inline transcript** (`NotchSurface.svelte:74-75`). **Fix:** drop the inline partial + growing width in the dock's listening state; render the wave only at a fixed 248. (Inline words while dictating is the *prototype's* separate `dict-listening` 460 state, not a per-token grow.) Also set `backdrop-filter` on all states (currently idle-only) so it eases instead of popping.

---

# Part 2 — Dictation System

## 2.1 Input & state machine
One HID-level `CGEventTap` (`ListenOnly`, `FlagsChanged`+`KeyDown`) + a 40 ms hardware-poll fallback, both in `start_fn_key_monitor` — `lib.rs:2144`. HID (not session) tap because Sequoia 15.7.x silently stops delivering to session-level taps (`lib.rs:2474-2478`). Whole callback in `catch_unwind` (panic across the C boundary aborts the process — `lib.rs:2508`); tap auto-re-enables on `TapDisabledByTimeout/ByUserInput` via a stashed mach port (`lib.rs:2486-2501`).

Modifier/keycodes: `FN_FLAG=0x800000`, `OPTION_FLAG=0x80000`, `RIGHT_OPTION_KEYCODE=61` (`lib.rs:2462-2466`).

**Timing constants (exact, all tuned):**
| Constant | Value | Meaning | Ref |
|---|---|---|---|
| `FN_TAP_PRIMER_MAX_MS` | **220 ms** | hold < 220 ms = silent brush (no paste), records `last_fn_brush` (arms double-tap) | `lib.rs:152, 3159` |
| `LONG_FORM_FN_DOUBLE_TAP_MS` | **480 ms** | 2nd Fn-down within 480 ms of a brush → long-form | `lib.rs:151, 2881` |
| `LONG_DICTATION_DEBOUNCE_THRESHOLD_MS` | **50 000 ms** | only holds ≥50 s get release debouncing | `lib.rs:150, 3173` |
| `DEFAULT_POST_RELEASE_TAIL_MS` | **750 ms** | mic stays open after release (captures trailing words); pref `dictation_release_tail_ms`/env, cap 1500 | `lib.rs:1653, 1712-1717` |
| `STT_FINALIZE_TIMEOUT_MS` | **2 600 ms** | max wait for Swift `complete` after stop | `lib.rs:1652, 1749` |
| Right-Option Ask brush | **120 ms** | Ask hold < 120 ms = cancel | `lib.rs:2751` |
| hardware poll cadence | **40 ms** | poll `CGEventSourceFlagsState` for the missed Fn-up | `lib.rs:2291` |

> **No 250 ms start delay** (CLAUDE.md is stale). The recognizer starts at t=0 on Fn-down so its ~300–800 ms cold start overlaps the hold (`lib.rs:3041-3072`). The silent-brush gate is purely on **release** (`hold < 220 ms`).

**`AppMode` (Rust, `state.rs:8`):** `Idle, Listening, Panel, Polishing, Reading, Minimized, Tasks(560×560), Confirming(560×340)`.
**Frontend `SymonMode` (`app.ts:13`):** `idle | listening | long_form | polishing | reading | panel | minimized | thinking | tasks | confirming`. `long_form`/`thinking` are frontend-only strings Rust emits via `mode-change` (the authoritative channel, `app.ts:187`).

**Fn down → up (push-to-talk):** down-edge CAS-latched (dedupes macOS's duplicate flag events, `lib.rs:2666`); worker thread: `create_dictation_session` → `paste::save_frontmost_app()` **before any UI** (`lib.rs:3036`) → `audio_ducker::duck()` → `ensure_stt_ready_and_start` → on Ok `play_sound("Tink")` + mode `listening`. Up-edge: `audio_ducker::restore()`; brush gate (<220 ms → silent); ≥50 s → debounced path; else mode `polishing` + `finish_voice_dictation_session`. The CGEvent up-path and the poll path each claim the release via `dictation_active.swap(false)` so "Pop"/finish never doubles.

**Registered global shortcuts (`lib.rs:3647-3799`):** `Cmd+Shift+Space` toggle pill · `Cmd+Shift+R` reading (selection-first) · `Cmd+Shift+S` speak selection · `Cmd+Shift+,` settings · `Cmd+Alt+V` paste last transcript. Fn / Fn+R / Right-Option are **CGEvent-tap only**, not plugin shortcuts.

## 2.2 STT pipeline (verified)
**Apple SFSpeechRecognizer is ALWAYS the live listener** (Swift `speech_recognizer` daemon spawned once, `stt/mod.rs:124`); records a 16 kHz mono PCM WAV in parallel via `AVAudioConverter`, auto-chains at Apple's ~60 s limit. → **On finalize, Whisper Turbo re-transcribes the WAV and supersedes Apple** when enabled (`choose_final_stt_transcript`, `lib.rs:752`; Whisper text becomes `raw_text`, Apple kept as fallback `lib.rs:765-785`). → **Gemini/OpenRouter polish** runs on the winner.
- Whisper: model `openai/whisper-large-v3-turbo` (`whisper.rs:14`); `enabled()` **default ON** (false only in local mode / pref `whisper_stt_enabled` ∈ {false,0} / env override) `whisper.rs:72`; needs cloud + (license token OR `OPENROUTER_API_KEY`); routes proxy `/v1/proxy/stt/transcribe` or direct OpenRouter `audio/transcriptions`; 30 s timeout; 401 clears token.

**Finalize orchestration `finish_voice_dictation_session` (`lib.rs:1733`):** stop-after-750 ms-tail → `play_sound("Pop")` + pre-activate target app → wait ≤2600 ms for `complete` → `choose_final_stt_transcript` → `stt::commands::process` → polish (+optional translate) → app filters → voice-action check → `paste::paste_text` (pastes even if the session was superseded mid-finalize) → save to SQLite → `play_sound("Done")` + `paste-complete`; on silent polish fallback emit `polish-fallback` (amber flash).

## 2.3 Voice commands (`stt/commands.rs:33`, detected at END of transcript, case-insensitive)
| Phrase | Behavior | line |
|---|---|---|
| `scratch that` | Cancel (paste nothing), unconditional | `:42-48` |
| `cancel` / `never mind` / `nevermind` | Cancel | `:42-56` |
| `remove that`/`delete that`/`undo that`/`undo` | strip phrase + trailing punct, delete last remaining word (one left → Cancel) | `:62-89` |
| `new paragraph` | → `\n\n` anywhere (checked before "new line") | `:93` |
| `new line` | → `\n` anywhere | `:94` |

Empty result → Cancel. Plain `ends_with`/replace, no regex. **Target-app `@file` filters** (`apply_app_text_filters :123`): in Cursor/Claude/Windsurf, spoken "tag/at main dot ts" → `@main.ts` (camelCase for multiword).

## 2.4 Polish (`stt/polish.rs`)
Default provider **OpenRouter**, model **`google/gemini-3.1-flash-lite-preview`** (`:17`); Gemini-direct `gemini-3-flash-preview` (`:16`, only provider supporting audio context, `:306`); optional `claude_code_cli` (dev). Timeout **30 s**, 2 attempts. **Skip polish if < 3 words** (`:579`) — replacements still applied. `should_skip_polish` fast-path for clean 3–8-word text (`:356`). Routing: token → proxy `/v1/proxy/gemini/generate` or `/v1/proxy/polish/generate`; else direct (dev). Gemini params: `temperature 0.1`, `maxOutputTokens 16384`, **`thinkingConfig.thinkingBudget 0`** (load-bearing — thinking caused truncation).

**`PolishContext` (everything sent, `:519`):** transcript; **audio WAV** (Gemini-only; FLAC-transcoded >384 KB, skipped >10 MB); `frontmost_app` (drives app-category tone + hallucination guard); `window_title`/`selected_text`/`ax_excerpt` (from AX tree via `gather_window_context`, ≤3 KB); `dictionary`; `instructions`; `replacements`. Prompt (`build_prompt :1242`): correction rules, adaptive punctuation, hallucination guard ("spoken words ALWAYS beat visible app text"), output-coverage demand (output ≥ input — guards truncation). **Tone** (`output_tone`, default `auto` → by app category). **Translate** ("translate to <lang> …", `lib.rs:588`).

## 2.5 Replacements / Snippets (`commands.rs:104`)
Pref key **`replacements`** (legacy; Snippets UI writes it), JSON `[{trigger,replacement}]`. Deterministic, case-insensitive, **post-polish**, applied on *every* path (skip/fallback/success). **Sorted by trigger length descending** (longer wins). Order overall: STT → voice commands → polish → replacements → `@file` filters.

## 2.6 Sounds (synthesized PCM 44.1 kHz mono, half-sine envelope; cached worker `spawn_audio_worker lib.rs:327`)
| Cue | When | Synthesis | line |
|---|---|---|---|
| Tink | Fn-down / start | chirp 600→900 Hz, 80 ms, vol .15 | `lib.rs:347` |
| Pop | Fn-up / stop / no-selection | 700→400 Hz, 80 ms, vol .12 | `:348` |
| Morse | long-form activation | double-blip 750→850 Hz, 50/60/50 ms, vol .15 | `:349` |
| Chime | Right-Option Ask | 440→660 Hz, 600 ms*, vol .08 | `:350` |
| Done | paste complete | 523→659 Hz, 120 ms, vol .10 | `:351` |
| ReadStart | reading start | 392→523 Hz, 420 ms, vol .085 | `:354` |
| ReadDone | reading finish | 523→392 Hz, 300 ms, vol .075 | `:355` |

(*Ask chime duration is reported as 80 ms in the Ask trace and 600 ms here — confirm `lib.rs:350`; both refer to the same `Chime` cue.)

## 2.7 Paste (`paste.rs:654`)
Save clipboard (+ `changeCount`) → write text → **`smart_activate`** (paste where the user actually clicked if focus shifted, else reactivate saved app) → focus-settle `FOCUS_SETTLE_MS=35 ms` only if focus moved → synthesize **Cmd+V** (keycode `0x09`, Command flag, `COMMAND_KEY_GAP_MS=12 ms` between down/up, posted to HID) → **restore clipboard after 5000 ms** guarded by `changeCount` (don't clobber a user Cmd+C). All AX/activate calls hop to the main thread via `dispatch_sync_f` (`run_on_main_thread :118`) — 15.7+ SIGILLs off-main. Bundle id `com.misterlabs.symon`.

## 2.8 Long-form (double-tap Fn — NOT Cmd+Shift+L)
`panel` AppMode is **driver-disabled**. Shipped long-form = double-tap Fn (a sub-220 ms brush arms a 480 ms window): `LONG_FORM_SESSION_ID`, `Morse` sound, window **280×118**, mode `long_form`, hands-free single-turn (pastes once on finish). Finish = single Fn tap / Esc / `long-form-finish`; cancel = Esc / `long-form-cancel` / `stop-all` → resize back 280×58. Excluded from the brush gate + poll fallback so it survives Fn glitches. Pill footprints: idle/listening/polishing/long_form all **280×58**; reading **400×56**; thinking 500×180; minimized 60×44.

---

# Part 3 — Ask (Right-Option) + Operator

> Naming: the Claude-era files are gone — live surface is **`SymonApp.svelte`** + `symon-main.ts`, window label **`symon_assistant`**, component **`NotchSurface.svelte`**.

## 3.1 Entry & flow (Right-Option hold, keycode 61 — inside the CGEvent tap, `lib.rs:2677-2830`)
Down: record press, `opened_from_idle = !ask_mode_active()`, `play_sound("Chime")`, force-stop any Fn dictation (Ask takes the mic), new session, `ensure_symon_assistant_visible`, stop any TTS; if from idle emit **`symon-open`** + `qa::start_voice_question`; `begin_ask_mode_dictation` (emits `symon-voice-state=true`) + `ensure_stt_ready_and_start`; partials stream as `symon-voice-transcript`.
Up: emit `symon-voice-state=false`; **brush guard <120 ms** → discard (+`symon-collapse` if from idle); else stop-after-tail, finalize (≤2600 ms), `choose_final_stt_transcript`, voice-commands, polish; non-empty → `finish_ask_mode_dictation` + emit **`symon-send-now`** → frontend `submitQuestion`. A 2nd Right-Option while the panel is up records a follow-up via `symon-voice-state` **without** re-opening.

## 3.2 Ask engine — `qa.rs` (orchestrator) + `gemini_ask.rs` (transport)
Command `ask_question` (`commands.rs:548`) → `qa::stream_ask_question` (`qa.rs:173`): Local-Mode block; **Operator fork** if `agent_beta_enabled` && agent-intent (§3.5); classify intent; build context bundle + prompt; `run_streaming_gemini_with_bundle` → `gemini_ask::ask_stream`. Deltas run through the **annotation parser** (strips `[POINT]`/`[CLICK]`) then emit `ask-stream-delta {text}`; finish → `ask-stream-done {final, tokens}`; function calls → `ask-card`.
**Models (load-bearing):** proxy tag `MODEL="gemini-3-pro-preview"` (server resolves it); direct dev `DIRECT_MODEL="gemini-3.1-pro-preview"` (`gemini_ask.rs:29,33`). `MAX_OUTPUT_TOKENS=2048`, temp `0.3`, `MAX_HISTORY_TURNS=8`. Endpoint: token → `/v1/proxy/gemini/{generate,stream}` Bearer (snake_case `generation_config`, model in body; 401 clears token); dev → direct Google (camelCase, model in URL).
**Context bundle (`qa.rs:585`):** selection-first (`reading::grab_selection`), screenshot (`capture::capture_with_prompt`, JPEG → `inline_data`), frontmost app, ≤4 recent transcript summaries. **System prompt** (`gemini_ask.rs:160`) states it *cannot* execute/open/browse; concise 1–4 paragraphs; always appends `OVERLAY_SYSTEM_HINT` (teaches `[POINT]`/`[CLICK]`), `CARDS_SYSTEM_HINT` only if `symon_cards_enabled`.
> **Streaming gotcha:** real SSE is **off by default** (`symon_streaming_enabled=false`) — `ask_stream` bridges one unary call and fires `on_delta` once with the full answer (UI snaps, doesn't type). The SSE parser exists, ready for when the proxy streaming endpoint is confirmed.

## 3.3 Panel UI states (`NotchSurface.svelte`)
Window sized once to **360×440** (h×w, `SymonApp.svelte:309`); states `idle|listening|thinking|answer|speaking|longform|done`, `isPanel = answer|speaking|longform`. Panel internals: header bar (label + close → `cancel`; when speaking, "Speaking" + headwave 120×22); thread (auto-scroll, scrollbar width 0); per-turn "who" label **9.5px / weight 260 / -0.4px** (hurttlocker spec), user prompt 12.5px/300, assistant `MarkdownAnswer` 13.5px/300 + hover Copy button (→ "Copied" `#7fe0b0` 1400 ms); streaming cursor = pulsing 6px dot on the last assistant turn; empty assistant turn = inline squiggle. **Speaking transport** (`:135-159`): 3-bar meter `voiceBars=[8+lvl*12, 12+lvl*16, 7+lvl*11]`, pause/resume (`voiceToggle`), stop (`voiceStop`), buttons 30×30. **Longform** (Fn dictation in this window): "Dictating" + headwave + streaming transcript 15px/300 + blinking caret + "Tap Fn to send · Esc cancels".

## 3.4 Multi-turn (pending-turn / no-teardown — state in `SymonApp.svelte`)
`ChatTurn={role,text,turnId?,cards?}`; `threadTurns` is what NotchSurface renders. `IDLE_COLLAPSE_MS=45_000` (hide, **preserve** thread; never mid-flight), `RESUME_WINDOW_MS=60_000` (reopen <60 s → resume; else flush stale thread to History as `ask:thread` + start fresh), `MAX_HISTORY_TURNS=8`. `submitQuestion`: append user + empty assistant placeholder (with `turnId=randomUUID`), history = prior minus trailing two, trimmed to 8; deltas append in place; done snaps to authoritative `final`; cards route by `turn_id`. **Pending-wave:** `notchPending = hasPriorAnswer && !isStreaming && voiceListening ? "eq" : null` → renders a live listening wave as a `You` bubble at the bottom of the thread (no collapse). `notchMode` priority: `fnActive → speaking → inPanel(answer) → voiceListening(listening) → isSubmitting(thinking) → expanded(listening) → idle` (Fn always wins the dock).

## 3.5 Operator (Ask → real Mac actions) — `agent/` module, beta-gated, off by default
**Three gates:** `agent_beta_enabled` (default off) + intent looks like an action (`looks_like_agent_intent`/`classify_intent`) + quota (`check_and_decrement_quota`: free 5/mo, Pro 150). Dispatch: emit "Working on it…" → `agent::queue::enqueue_and_wait` (SQLite-backed, 300 s cap) → emit `ask-stream-done`; renders in the same answer panel (`mode:"agent"`).
**Model (runtime ≠ code default — check the config):** `router.rs:32` default is `gemini-3.1-pro-preview`, BUT `load_config()` (`router.rs:52-61`) reads `~/Library/Application Support/symon/agent_models.json` and the file wins — and the **live file sets `"mac_native_action": "openai/gpt-4o-mini"`**. Provider by model-id: **slash → OpenRouter (direct), bare → Gemini (proxy)** (`queue.rs:436-440`) → `openai/gpt-4o-mini` runs the Mac-action tool-calling loop on **GPT-4o-mini via OpenRouter**. (The `symon_operator_direction` memory was right; an earlier draft of this dossier wrongly "corrected" it by reading only the router default, not the runtime config.) Other lanes from the live config: `intent_classification` + `result_summarization` = `gemini-3-flash-preview`; `browser_action` = `gemini-2.5-computer-use-preview-10-2025` (fallbacks `claude-sonnet-4-6-cua`, `openai-cua`). Function-calling loop `MAX_TURNS=10`.
**Tools (`agent/tools/mod.rs`):** 22 native (open_app; Calendar; Reminders; Notes; Contacts; Mail draft/send; Shortcuts; fs read/write/spotlight; csv; browser `web_research/web_form_fill/web_extract_data`). **Safety (`agent/safety.rs`):** ReadOnly (auto) / Reversible (one confirm unless `agent_consent_reversible_silent`) / Destructive (always confirm). Hardcoded never-do (bash/shell/sudo/keychain; `/etc`,`/System`,`.env`,`credentials`…). **`enabled_tools()` withholds ALL Destructive tools at the schema level today** even though the `confirm_required` notch card (`AgentConfirmCard`, 300×400, 120 s→decline, `agent_confirm_action(id,approve)`) is fully wired. So a first port can ship read-only + reversible with the confirm card.
**Vision-clicking is killed as a customer feature.** `[CLICK:x,y]` still parses → `overlay::warp_cursor`, but gated behind **`agent_can_warp_cursor` (default false)** — off = teaching arrow only, no cursor move. `[POINT]` arrows always render.

## 3.6 Speaking (how an Ask answer is spoken) — `symon_voice.rs`
After `submitQuestion`, if `symon_voice_enabled` (migrated from `claude_voice_enabled`) → `symon_speak_answer` → `symon_voice::speak_answer` on a **dedicated OS thread** (rodio `!Send`) with its own current-thread tokio. Events: `symon-speaking` (bool), `symon-audio-level` (RMS f32/frame), `symon-speaking-paused` → stores → NotchSurface `voiceSpeaking/voiceLevel/voicePaused`. Transport: `symon_toggle_speaking_pause`, `symon_stop_speaking`. The Ask-answer voice path is **separate** from the reading path (see Part 5).

---

# Part 4 — Screen Reading + Speak Selection + Pointing Overlay

> **Coord-fix caveat:** the overlay 0–1000→screen normalization (`resolve_normalized`) is on branch **`fix/overlay-coord-normalization`** (commit `724c36a`), **not in `main`**. o8 must implement the FIXED math (§4.4), not mainline `overlay.rs`'s literal-pixel handling.

## 4.1 Screen reading flow (`reading::ReadingSession`)
Entries: **Fn+R** (keycode 15 + Fn, always captures, `lib.rs:2527`); **Cmd+Shift+R** (selection-first: `grab_selection` → `start_selection` else capture, `lib.rs:3664`). `start_reading`/`stop_reading` commands are **dead stubs** — the driver is the hotkeys holding a shared `Arc<Mutex<ReadingSession>>`.
Pipeline (`run_session reading.rs:723`): `reading-state=preparing` → `capture_with_prompt` → `gemini_vision_extract` (model `gemini-3-flash-preview`, **20 s** timeout, `temp 0.1`, `maxOutputTokens 4096`; prompt skips ads/nav/chrome; `NO_READABLE_CONTENT` guard) → chunk → rodio playback w/ prefetch → save transcript → `reading-state=done` → `collapse_to_idle` (1200 ms). Vision routing: token → `/v1/proxy/gemini/generate` Bearer; else direct (401 clears token).
Chunking: `MAX_CHUNK_CHARS=800`; **short first chunk** `carve_lead_chunk(text,200)` at a clause boundary for fast first-audio; remainder split on `\n\n`, long paras via `split_long_paragraph` (UTF-8-safe). Per-chunk TTS timeout **10 s** → `say` fallback for that chunk. **Lookahead:** ~1 chunk pre-rendered into an index-tagged `PrefetchSlot` (skip invalidates stale prefetch).

## 4.2 Reading controls (CGEvent tap, no modifier, while `reading_active`)
Space=pause/resume(49) · →=next para(124) · ←=restart/prev(123) · ↑=speed+0.25(126) · ↓=speed−0.25(125) · Esc=stop(53). Speed clamp **0.5–2.0**, applies to next synth. All via `Arc`-wrapped atomics/mutex on `ReadingSession`. Clickable transport mirrors ←/Space/→ (`reading_skip_back/_toggle_pause/_skip_forward`, `Pill.svelte:717`).

## 4.3 Speak Selection (Cmd+Shift+S, `lib.rs:3711`)
`grab_selection` (`reading.rs:1146`): **AX first** (`AXSelectedText`, no clipboard touch); fallback **Cmd+C** (snapshot clipboard, simulate, poll ≤180 ms for `changeCount` change, read, restore). `start_selection` skips capture+Vision → straight to TTS/rodio, 1-chunk lookahead, `SELECTION_TTS_TIMEOUT_SECS=45`, 1 retry. **Voice-consistency:** after audio starts, a chunk failure stops rather than switching to `say` mid-read; `say` only if the first chunk fails.

## 4.4 The `!Send` thread pattern (mandatory)
rodio `OutputStream`/`Sink` are `!Send` and held across `.await` → run the session on a **dedicated OS thread** with a `new_current_thread` tokio runtime built inside it (`reading.rs:157`, also `qa.rs`, `symon_voice.rs`). Controls reach in via `Arc<Atomic*/Mutex>`. Will not compile on Tauri's default multithread runtime.

## 4.5 Capture (`capture/macos.rs`)
Core Graphics `CGDisplay::screenshot(CGRectNull, OnScreenOnly, …)` → composites **the whole virtual desktop (union of displays)** into one image (this is what makes 0–1000 mapping correct). `spawn_blocking`. TCC Screen Recording (`CGPreflight/RequestScreenCaptureAccess`). Output **JPEG**, `MAX_WIDTH=960`, `JPEG_QUALITY=80` (~100–200 KB). (CLAUDE.md "6K PNG" is stale.)

## 4.6 Pointing overlay
Window `overlay` (1×1 placeholder; real frame computed at runtime): `decorations:false, transparent:true, alwaysOnTop:true, focus:false, shadow:false, skipTaskbar:true`. `configure_overlay_window` (`overlay.rs:319`): `set_ignore_cursor_events(true)` (click-through) + `clearColor`/`setOpaque(false)` (white-flash fix tauri#13070) + **`setLevel(4)`** + spans the union of all `NSScreen.frame`.
Tags (`ai/annotation_parser.rs`): `[POINT:x,y:label:screenN]` (arrow+label) and `[CLICK:x,y:screenN]` (warp target); streaming-safe (buffers half-tags across chunks; passes markdown `[link]` through). Dispatch (`qa.rs:1152`): Point→`show_annotation`; Click→`show_click_target` + `warp_cursor`.
**THE COORD FIX o8 must implement** (Gemini grounds 0–1000, top-left, over the union screenshot):
```rust
fn resolve_normalized(nx, ny, d: DesktopRect) -> (css, cg) {
    let fx = (nx/1000.0).clamp(0.0,1.0); let fy = (ny/1000.0).clamp(0.0,1.0);
    let css = (fx*d.width, fy*d.height);            // overlay-window CSS px (union-relative) → arrow
    let cg  = (d.min_x+css.0, d.min_y+css.1);        // CG global pts → cursor warp
}
```
`DesktopRect` = union of `CGDisplay::active_displays().bounds()` (fallback main). CSS for the arrow, CG-global for the warp. Update the Gemini system hint to declare the 0–1000 convention or coords and math disagree. Arrows: `AnnotationArrow` SVG, `ARROW_LEN=80`, Point pink `#ff7eb6` / Click yellow `#ffe066`+pulse, 6 s TTL, CSS-only fade. **Cursor warp gated by `agent_can_warp_cursor` (default false).**

## 4.7 Reading bar UI
`expand_reading_bar` → 400×56. Markup `Pill.svelte:689`: text (`preparing`→"Reading…", error→"Not much to read here", else current chunk) + transport + progress. **Progress bar is 2px, fill blue `linear-gradient(90deg,#4058FF,#6B7FFF)`** (CLAUDE.md "green dot" is wrong — no dot element). `readingPercent = round(current/total*100)`, `transition width 300ms`.

---

# Part 5 — TTS / Voice Stack + **Founder's Edition / ElevenLabs**

> The single most-emphasized area. There are **two independent voice paths** — do not conflate: (A) **Reading path** (screen-read + speak-selection) → `tts::load_config()` → `tts::speak()`; (B) **Ask-answer path** ("Symon's own voice") → `symon_voice::speak_answer()`. Both honor ElevenLabs founder mode but via different code.

## 5.1 Providers & fallback
Enum (`tts/mod.rs:8`): `Edge`, `Google`, `ElevenLabs`, `Native`.
**Reading-path selection `load_config()` (`tts/mod.rs:39`):** (1) if `elevenlabs::personal_mode_enabled()` → **ElevenLabs** (unconditional founder override); (2) pref `tts_provider`: `google`→Google, `native`→Native(stub), **`edge`→Google (remapped)**, else Google; default Google / `en-US-Neural2-J` / speed 1.0.
**Reading-path runtime fallback:** TTS fail → macOS **`say -r <175*speed> <text>`** (`reading.rs:567`). Voice-consistency rule: only fall back to `say` if the *first* chunk fails.
**Ask-answer-path selection (`symon_voice.rs:175`):** (1) personal mode → ElevenLabs `configured_voice_id()`; (2) else Google `selected_voice_id()`; on Google fail → retry `FALLBACK_VOICE=en-US-Wavenet-H`; both fail → error (no `say` here).

## 5.2 Decision tree
```
personal_mode_enabled() == (personal_tts_provider=="elevenlabs") AND ELEVENLABS_API_KEY present
   (elevenlabs.rs:61-70)
```
| Surface | Founder ON | Founder OFF |
|---|---|---|
| Screen reading / Speak selection | ElevenLabs `personal_elevenlabs_voice_id` | Google `tts_voice_id` (Neural2-J), `say` fallback |
| Ask-answer voice | ElevenLabs `configured_voice_id()` | Google `symon_voice_id` (Wavenet-I default / H fallback) |
| Reading-voice **preview** (Settings) | **forced Google** regardless (`commands.rs:506`) | Google `tts_voice_id` |
| Dictation | none (STT→polish→paste, no TTS) | none |

`symon_voice_enabled` (whether Ask speaks) is checked **only in the frontend** (`SymonApp.svelte:673`) — no Rust gate. Local product mode hard-disables Google TTS (`google.rs:74`) but not ElevenLabs.

## 5.3 ElevenLabs integration (exact, `tts/elevenlabs.rs`)
- POST `https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format={fmt}`, **non-streaming**, headers `xi-api-key`, `Accept: audio/mpeg`.
- Body: `{ text, model_id, voice_settings:{ stability, similarity_boost, style, use_speaker_boost } }`.
- Defaults: model `eleven_multilingual_v2`, output `mp3_44100_128`, stability `0.45`, similarity_boost `0.8`, style `0.0`, speaker_boost `true` (floats clamped 0–1). **No `speed` sent** (v2 has none) → reading speed only affects Google + `say`.
- Voice id at call time: `config.voice_id` else `configured_voice_id()`. Key: pref/env `ELEVENLABS_API_KEY` (**not** dev-gated — read in every build). **Direct to ElevenLabs, NOT the proxy** (deliberate: this is the owner-local paid-moat boundary). MP3 → `Vec<u8>` → rodio.
- Getters: `personal_elevenlabs_voice_id`/`ELEVENLABS_VOICE_ID`/`JBFqnCBsd6RMkjVDRZzb`; `personal_elevenlabs_model_id`/…/`eleven_multilingual_v2`; `personal_elevenlabs_output_format`/…/`mp3_44100_128`.

## 5.4 Founder's Edition
**`founder_edition_enabled`** (JSON bool) unlocks: metering bypass (`quota.rs:40`); the **Founder** + **Agent Beta** settings tabs (`SettingsApp.svelte:126`); the polish provider/model picker (non-founders forced `openrouter`, `SettingsPage.svelte:226`); Ask-answer voice → personal ElevenLabs; Advanced Context (`workspace_context_enabled`); Account Runtime/Diagnostics panels; History affordances.

**Voice library** (`founder_elevenlabs_voice_library`, managed in `FounderPage.svelte`) — a **JSON-stringified array** in one pref, per-voice `{id,label,modelId?,stability?,similarityBoost?,style?,speakerBoost?,addedAt?}`. UI form defaults: `DEFAULT_VOICE_ID='I33geqnOHQGKDPUMUspQ'`, model `eleven_multilingual_v2`, output `mp3_44100_128`, 0.45/0.8/0/true, label `'Main voice'`. (⚠️ UI default voice id differs from the Rust fallback `JBFqnCBsd6RMkjVDRZzb` — pick one canonical default in o8.) The "Rocky v.1 / Brit Rick / Sydney / Main voice" set is **user data** at runtime, not seeded in code.

**Save/Use/Preview** (`persistActiveVoice` `:136`) writes the full set: `founder_edition_enabled='true'`, `personal_tts_provider='elevenlabs'`, `personal_elevenlabs_voice_id/model_id/output_format`, `personal_elevenlabs_stability/similarity_boost/style`, `personal_elevenlabs_use_speaker_boost`, `symon_voice_enabled='true'`. Preview speaks a sample via `symonSpeakAnswer` (routes through ElevenLabs because personal mode is now on).

## 5.5 Google Cloud TTS (`tts/google.rs`)
POST `https://texttospeech.googleapis.com/v1/text:synthesize`, `{input{text},voice{languageCode,name},audioConfig{audioEncoding:MP3,speakingRate,pitch}}`. Reading voice `en-US-Neural2-J`; Ask voices restricted to `en-US-Wavenet-I`/`-H` (allow-list). `Chirp3` in id → pitch forced 0. Speed range 0.5–2.0 step 0.25. **Routing:** token → proxy `/v1/proxy/tts/synthesize` Bearer (no `?key=`); else direct `?key=GOOGLE_TTS_API_KEY` (dev only). 401→clear token+`invalid_token`, 403→`subscription_inactive`. Response `{audioContent: base64}`. In prod, Google TTS **always** goes through the proxy.

## 5.6 macOS native
`TtsProvider::Native` is a **stub** (always errors). The real macOS fallback is the **`say` binary** (reading path only).

## 5.7 Port notes
Keep the two-path model; ElevenLabs override short-circuits both before any other logic; replicate the exact ElevenLabs request (direct, no proxy) and Google-via-proxy; founder unlocks all keyed off `founder_edition_enabled`; voice library is client JSON in one pref; `say` fallback with the no-mid-read-switch rule; voice-on gate lives in the caller. **Gotchas:** rodio `!Send` thread pattern; pref JSON coercion (`'true'`→bool); the default-voice-id mismatch; ElevenLabs key not dev-gated; speed dropped on ElevenLabs; Edge/Native are effectively dead; Local mode kills Google but not ElevenLabs.

---

# Part 6 — Settings + Preferences + Account + Surfaces + Triggers

## 6.1 Settings window
Separate Tauri window (label `settings`, decorations off, transparent). Root `SettingsApp.svelte:166`, 188px sidebar + lazy code-split tabs. Base tabs: **Settings, Dictionary, Snippets, Instructions, History, Stats, Account, Report Issue**; when `founder_edition_enabled==='true'` splice in **Founder** + **Agent Beta**. Every page reads/writes via `load_preference`/`save_preference`.

| Page | File | Prefs / commands |
|---|---|---|
| Settings | `SettingsPage.svelte` | the big control→pref map (below) |
| Dictionary | `DictionaryPage.svelte` | `dictionary` (JSON string[]) |
| Instructions | `InstructionsPage.svelte` | `instructions` (raw string) |
| Snippets | `ReplacementsPage.svelte` | `replacements` (JSON `{trigger,replacement}[]`) |
| History | `HistoryPage.svelte` | `get_transcripts`/`get_transcript`/`replay_transcript_audio`/`rerun_transcript`/`paste_last_transcript` |
| Stats | `StatsPage.svelte` | `get_stats`→`StatsSnapshot` (total words/sessions/today/streak/top app/avg WPM/time saved/level) |
| Agent Beta (founder) | `AgentPage.svelte` | `agent_beta_enabled`/`agent_consent_reversible_silent`/`agent_dry_run_default`; `agent_get_quota` |
| Account | `AccountPage.svelte` + `AccountSignInCard.svelte` | license + updater + founder diagnostics (§6.3) |
| Report Issue | `ReportIssuePage.svelte` | `get_feedback_context`/`submit_feedback` (→ Discord backend) |
| Founder (founder) | `FounderPage.svelte` | `personal_elevenlabs_*` (§5.4) |

`SettingsPage` mount loads ~20 prefs, **force-writes** `pill_style='wave_bar'` + `local_agent_enabled='false'`, and migrates stale values (`tts_provider edge→google`, `symon_product_mode→pro`, non-founder `polish_provider→openrouter`). Control map: Input (mic→`dictation_microphone_uid`, `whisper_stt_enabled`, `dictation_locale`, `output_tone`); Appearance (`pill_surface`, `pill_movement_enabled`, `surface_anchor` notch/pill, `notch_idle_pill`, `autostart_enabled`, `listening_show_waveform`); Permissions (`get_permission_statuses`); Voice Output (`symon_voice_enabled`, `symon_voice_id`, `tts_voice_id`, `reading_speed`); Advanced Context founder-only (`workspace_context_enabled`, `agent_can_warp_cursor`).

## 6.2 Preferences storage
`~/Library/Application Support/symon/preferences.json` — flat JSON, **no central schema**. Helpers `load_raw_value`/`save_raw_value`/`load_json<T>`/`bool_pref` (`preferences.rs:95-157`); **mtime-keyed cache** so multiple webviews stay in sync. `load_preference` returns `""` when absent. Booleans are literal strings `'true'`/`'false'` (`bool_pref` accepts `true|1|yes|on`). Full table in **Part 7**.

## 6.3 Account / License / Proxy
Single bearer token **`symon_license_token`** in prefs IS the whole auth state (`keys.rs:79`; returns None when `bypass_proxy_in_dev`). Token present → route AI/TTS via proxy; "Pro" = product-mode/backend status, not a local boolean. Proxy base = `symon_api_url` else `https://api.symonsays.run`.
**Stripe checkout:** `sign_in_checkout(email)` → `/v1/auth/checkout` → opens URL + stores `symon_pending_session_id`; success deep-link `symon://auth?session_id=` → Tauri event `license-session-received` → `verify_license(session_id)` → `/v1/auth/verify` → stores token+email. **Magic link:** `login_request_code`→`/v1/auth/login`, `login_verify_code`→`/v1/auth/login/verify`. **Status:** `get_license_status`→`/v1/me` Bearer; **401 clears token, 403 KEEPS it** (beta/past-due recover). **Portal:** `open_customer_portal`→`/v1/auth/portal`; after return poll status 8×/2.5 s (webhook lag). Endpoints: `/v1/auth/{checkout,verify,login,login/verify,portal,beta-token}`, `/v1/me`.

## 6.4 Surfaces / Themes / Tokens
**Surfaces (`pillSurfaces.ts`)**, default **`apple-glass`**:
| id | solid (bg) | border | shadow |
|---|---|---|---|
| midnight | `rgba(8,14,24,0.88)` | `rgba(255,255,255,0.08)` | `0 16px 34px rgba(3,8,17,0.22)` |
| frost | `rgba(248,250,253,0.9)` | `rgba(255,255,255,0.62)` | `0 16px 36px rgba(148,163,184,0.18)` |
| **apple-glass** | `rgba(246,248,251,0.6)` | `rgba(255,255,255,0.5)` | `0 18px 40px rgba(15,23,42,0.18)` |
| mist | `rgba(255,255,255,0.28)` | `rgba(255,255,255,0.24)` | `0 16px 34px rgba(15,23,42,0.14)` |

`pillSurfaceVars` emits **both** prefixes: `--pill-surface-*` (← `background` gradient) and `--symon-surface-*` (← `solid`, used by the notch panel). `frost` is the only light surface (settings window branches its var set on it). `nativeGlass:true` (apple-glass) drives `set_pill_native_glass`. ⚠️ `getPillSurface` fallback is `[0]`=midnight while the constant default is apple-glass — normalize in o8.
**Orb themes (`orbThemes.ts`):** default `official-blue` (`#4058FF`), locked as identity; alpha themes exist but no live pref (design data).
**Tokens (`tokens.css`):** glass `--glass-blur:24px` + bg/border/shadow; accent `--accent:#4058FF`/`--accent-light:#6B7FFF`/`--accent-glow`; system font stack (no webfont); type sizes xs10–xl20, weights 400/500/600; pill geometry `--pill-radius:22px`, panel `--panel-width:500px`; timing `--transition-spring:400ms cubic-bezier(0.34,1.56,0.64,1)`; z pill 9999/panel 9998/overlay 9997. Dark/light/`[data-glass-profile='legacy']` overrides.

## 6.5 Triggers (`triggers.rs`) — ships dark
`const AUTOMATIONS_ENABLED=false` (`:15`) → `dispatch_to_subscriptions` early-returns; **no settings UI**. Machinery: events `on_dictation_saved/_memory_created/_action_item_created/_reading_finished/_agent_task_finished`; `TriggerSubscription{id,created_at,event_name,kind,target,enabled}`; action kinds `webhook` (POST 5 s), `append_to_file`, `append_to_daily_notes` (default `~/Documents/Symon Daily/`), `create_reminder` (osascript, macOS). Every delivery writes a `trigger_events` audit row. Lowest porting priority.

## 6.6 Storage
Base `~/Library/Application Support/symon/`: `preferences.json`, `transcripts.db` (SQLite), `logs/symon.log`, `history-audio/`. **SQLite (6 tables, additive migrations, UUID text PKs, RFC3339 timestamps, Vec→`*_json`):** `transcripts` (source∈screen|voice|text, raw_text, ai_response, mode, audio_path, token/cost cols), `memories`, `action_items`, `session_recaps`, `trigger_subscriptions`, `trigger_events`.

---

# Part 7 — Consolidated preferences reference

Defaults: implicit "absent = X" is noted. Booleans stored as `'true'`/`'false'` strings.

| Key | Type | Default | Meaning |
|---|---|---|---|
| **Dictation / polish** | | | |
| `instructions` | string | `""` | freeform polish rules |
| `dictionary` | JSON string[] | `[]` | custom words → polish |
| `replacements` | JSON `{trigger,replacement}[]` | `[]` | post-polish snippets (longest-first) |
| `output_tone` | enum | `auto` | auto/raw/clean/formal/casual |
| `polish_provider` | enum | `openrouter` (non-founder forced) | gemini/openrouter/claude_code_cli |
| `polish_model` | string | provider default | polish model id |
| `whisper_stt_enabled` | bool | **`true`** (absent=on) | Whisper finalize |
| `dictation_locale` | string | `en-US` | STT locale + Whisper hint |
| `dictation_microphone_uid` | string | `default` | input device |
| `dictation_release_tail_ms` | int-str | `750` (cap 1500) | mic tail after release |
| `symon_product_mode` | enum | `pro` | local/fast/pro; local disables cloud STT/TTS |
| **Voice / TTS** | | | |
| `tts_provider` | string | `google` (`edge`→google) | read-aloud backend |
| `tts_voice_id` | string | `en-US-Neural2-J` | read-aloud voice |
| `reading_speed` | f32 | `1.0` (0.5–2.0) | TTS speed |
| `symon_voice_enabled` | bool | `false` | speak Ask answers (frontend gate) |
| `claude_voice_enabled` | bool | — | **legacy alias**, auto-migrated |
| `symon_voice_id` | string | `en-US-Wavenet-I` | Ask voice (allow-list I/H) |
| `personal_tts_provider` | string | unset | `elevenlabs` arms personal mode |
| `personal_elevenlabs_voice_id` | string | `JBFqnCBsd6RMkjVDRZzb` (rust)/`I33geqnOHQGKDPUMUspQ` (UI) | founder voice |
| `personal_elevenlabs_model_id` | string | `eleven_multilingual_v2` | |
| `personal_elevenlabs_output_format` | string | `mp3_44100_128` | |
| `personal_elevenlabs_stability` | f32 0–1 | `0.45` | |
| `personal_elevenlabs_similarity_boost` | f32 0–1 | `0.8` | |
| `personal_elevenlabs_style` | f32 0–1 | `0.0` | |
| `personal_elevenlabs_use_speaker_boost` | bool | `true` | |
| `founder_elevenlabs_voice_library` | JSON array | `[]` | saved voice presets |
| **Surface / appearance** | | | |
| `pill_surface` | string | `apple-glass` | glass theme |
| `pill_style` | string | force-set `wave_bar` | |
| `surface_anchor` | string | `notch` (only `pill` opts out) | dock location |
| `notch_idle_pill` | bool | `true` (only `'false'` opts out) | idle capsule at notch |
| `pill_movement_enabled` | bool | `false` | draggable pill |
| `pill_position_x`/`_y` | num-str | `""` | saved coords |
| `listening_show_waveform` | bool | `false` | wave vs words during Fn hold |
| `long_form_{font_size,width,bottom,left,font_weight,shadow,tail_chars,font}` | str | UI (≈430w, 13px, 92, 50, 560, 44, 220, system) | long-form caption HUD tuner (founder) |
| **Agent / Operator (founder)** | | | |
| `agent_beta_enabled` | bool | `false` | route Ask actions to Mac agent |
| `agent_consent_reversible_silent` | bool | `false` | reversible without confirm |
| `agent_dry_run_default` | bool | `false` | preview, don't execute |
| `agent_can_warp_cursor` | bool | `false` | `[CLICK]` cursor warp |
| `workspace_context_enabled` | bool | `false` | feed git repos to Ask |
| `local_agent_enabled` | bool | force-set `false` | Claude Code CLI route (disabled) |
| **Ask** | | | |
| `symon_streaming_enabled` | bool | `false` | real SSE vs unary bridge |
| `symon_cards_enabled` | bool | `false` | file/code/image cards |
| **License / proxy / identity** | | | |
| `symon_license_token` | string | `""` | bearer; presence → proxy; cleared on 401 |
| `symon_user_email` | string | `""` | cached account email |
| `symon_pending_session_id` | string | `""` | Stripe checkout awaiting verify |
| `symon_api_url` | string | `https://api.symonsays.run` | proxy base |
| `symon_device_id` | uuid | generated once | per-install id |
| `symon_bypass_proxy_in_dev` | bool | `false` | debug-only: local keys |
| `symon_enable_beta_token` | bool | `false` | mint anonymous beta token |
| `license_plan` | string | — | cached plan for quota |
| **Lifecycle / misc** | | | |
| `founder_edition_enabled` | bool | `false` | unlocks Founder/Agent tabs + pickers + diagnostics |
| `first_launch_complete` | bool | `false` | onboarding done |
| `autostart_enabled` | bool | `true` (first run) | launch at login |
| `notification_cadence` | enum | balanced | action-item reminders |

**Env vars:** `OPENROUTER_API_KEY`, `GOOGLE_TTS_API_KEY`, `ELEVENLABS_API_KEY` (+ `ELEVENLABS_*` overrides), `SYMON_LICENSE_TOKEN`, `SYMON_WHISPER_STT_ENABLED`, `SYMON_DICTATION_RELEASE_TAIL_MS`, `SYMON_BYPASS_PROXY_IN_DEV`, `SYMON_PERSONAL_TTS_PROVIDER`. (Never commit values.)

**Proxy endpoints:** polish `/v1/proxy/gemini/generate` + `/v1/proxy/polish/generate`; STT `/v1/proxy/stt/transcribe`; TTS `/v1/proxy/tts/synthesize`; Ask `/v1/proxy/gemini/{generate,stream}`; agent `/v1/proxy/agent/generate`; auth `/v1/auth/*` + `/v1/me`.

---

# Part 8 — Stale-doc traps (do NOT port these)

The repo's CLAUDE.md predates several changes. Verified against code:
1. **No `Cmd+Shift+L` panel** — never registered. Long-form = **double-tap Fn**. `panel` AppMode is driver-disabled.
2. **No 250 ms Fn start delay** — recognizer starts at t=0; brush gate is on release (<220 ms).
3. **Whisper is in the listen/finalize path** (default-ON, supersedes Apple) — "Gemini-only" applies to the *polish* stage only.
4. **Operator runs on GPT at runtime, not Gemini.** `router.rs:32` *code default* is `gemini-3.1-pro-preview`, but the live `agent_models.json` overrides `mac_native_action` → **`openai/gpt-4o-mini`** (slash ⇒ OpenRouter direct). Always read the runtime config, not just the router default — an earlier dossier draft got this backwards.
5. **Vision-clicking is killed** as a customer feature — `[CLICK]` warp gated behind `agent_can_warp_cursor` (default false); `[POINT]` arrows fine.
6. **Overlay coord fix is on branch `724c36a`, not `main`** — build the fixed 0–1000→union math (Part 4.6).
7. **Reading progress bar is blue**, not a green dot.
8. **Capture is JPEG 960px**, not 6K PNG.
9. **Real SSE streaming is off by default** (unary bridge) — don't build a typewriter UI assuming deltas.
10. **`start_reading`/`stop_reading` Tauri commands are dead stubs** — entry is the hotkey handlers.
11. **`ClaudeApp`/`claude-main` are gone** — it's `SymonApp.svelte`/`symon-main.ts`, window `symon_assistant`.

---

# Part 9 — Master parity checklist

**Dictation**
- [ ] Whisper finalize stage (default-ON, supersedes Apple) + WAV from the STT helper — **biggest correctness gap**
- [ ] Voice commands (scratch/cancel/remove that/new line/new paragraph), on finalized raw text, before polish
- [ ] Full `PolishContext` (audio Gemini-only, AX window context, dictionary, instructions, tone, output-coverage prompt, `thinkingBudget:0`, `maxOutputTokens:16384`)
- [ ] Replacements (`replacements`, longest-first, on every path incl. skip/fallback)
- [ ] Double-tap-Fn long-form (220 ms brush arms 480 ms window; 280×118; finish on single Fn)
- [ ] Sounds (exact freqs/durations + half-sine envelope + cached worker)
- [ ] Paste: smart_activate, 35 ms focus-settle, 12 ms Cmd+V gap, 5000 ms changeCount-guarded restore, main-thread AX trampoline
- [ ] Fix the **listening morph** (fixed 248 wave, no per-token grow)

**Ask + Operator**
- [ ] Right-Option (keycode 61) CGEvent handler sharing the mic/STT state machine; 120 ms brush; finalize→polish→`symon-send-now`
- [ ] 440×360 answer/speaking/longform panel states (grow the dock window or add an assistant window)
- [ ] Multi-turn pending-wave model + 45 s collapse / 60 s resume / flush-to-history
- [ ] Event contract verbatim (`symon-open/collapse/voice-state/voice-transcript/send-now/preview`; `ask-stream-delta/done/error`; `ask-card`; `symon-speaking/audio-level/speaking-paused`; `agent-task-event`/`agent-quota-exceeded`)
- [ ] Proxy-vs-direct Gemini split (models, snake vs camel, 401-clears-token, history 8, `inline_data`)
- [ ] Unary-bridge streaming fallback (`symon_streaming_enabled=false`)
- [ ] Operator (optional first pass: read-only + reversible + confirm card; withhold Destructive at schema; no vision-click)

**Reading / Speak / Overlay**
- [ ] Fn+R / Cmd+Shift+R (selection-first) / Cmd+Shift+S; reading controls; reading bar 400×56 (blue progress)
- [ ] `!Send` dedicated-thread + current-thread tokio pattern
- [ ] Vision extract (gemini-3-flash-preview, 20 s, skip-chrome prompt); 800-char chunking + short lead chunk; 1-chunk prefetch; `say` fallback
- [ ] Pointing overlay: level-4 click-through union window; tag parser; **fixed 0–1000→union coord transform**; `agent_can_warp_cursor` gate

**TTS + Founder**
- [ ] Two-path voice model (reading vs Ask-answer) with separate defaults
- [ ] ElevenLabs override short-circuits both paths; exact request (direct, no proxy); founder voice library (client JSON in one pref); Save/Use/Preview writes the full pref set
- [ ] Google via proxy (token bearer, `{audioContent}`, 401/403 handling, Chirp3 pitch=0)
- [ ] `say` fallback with no-mid-read-switch; voice-on gate in caller

**Settings / Prefs / Account / Surfaces**
- [ ] Flat-JSON pref store + mtime cache + `'true'/'false'` strings + implicit defaults (Part 7)
- [ ] License/proxy: token-in-prefs, 7 `/v1/auth/*` + `/v1/me`, 403-keeps-token, deep-link verify, post-portal polling
- [ ] Surfaces (4, default apple-glass) + dual-prefix vars + tokens.css + frost light branch
- [ ] Settings pages incl. founder-gated Founder/Agent tabs + mount migrations (`edge→google`, `→pro`, force `wave_bar`/`local_agent_enabled=false`)
- [ ] SQLite 6-table schema; Triggers optional (ships dark)

---

# Part 10 — Source-of-truth file index (`~/aqua-color`)

| Area | Files |
|---|---|
| Window/level/positioning | `src-tauri/src/commands.rs:1531-1741`, `lib.rs:3435-3566`, `overlay.rs:319-391` |
| Notch dock UI | `src/lib/components/NotchSurface.svelte`, `notch-dock-prototype.html`, `src/lib/pillSurfaces.ts` |
| Dictation driver / state machine | `src-tauri/src/lib.rs` (`start_fn_key_monitor` :2144, finalize :1733, sounds :327) |
| STT | `src-tauri/src/stt/{mod,commands,polish,whisper}.rs`, `helpers/speech_recognizer.swift` |
| Paste | `src-tauri/src/paste.rs`, `keys.rs` |
| Ask | `src-tauri/src/qa.rs`, `ai/gemini_ask.rs`, `ai/annotation_parser.rs`, `src/SymonApp.svelte`, `src/symon-main.ts` |
| Operator | `src-tauri/src/agent/{mod,queue,router,safety,quota,tools/mod,providers/*}.rs`, `src/lib/settings/AgentPage.svelte` |
| Reading / capture / overlay | `src-tauri/src/reading.rs`, `capture/{mod,macos}.rs`, `overlay.rs`, `src/.../OverlayApp.svelte` + `AnnotationArrow.svelte`, `Pill.svelte` |
| TTS / Founder | `src-tauri/src/tts/{mod,elevenlabs,google,native,edge}.rs`, `symon_voice.rs`, `product_mode.rs`, `src/lib/settings/{FounderPage,SettingsPage}.svelte` |
| Settings / prefs / account | `src-tauri/src/preferences.rs`, `commands.rs` (prefs/license 1784-2181), `keys.rs`, `src/SettingsApp.svelte`, `src/lib/settings/*`, `src/lib/styles/tokens.css`, `orbThemes.ts` |
| Triggers / storage | `src-tauri/src/triggers.rs`, `transcript/{mod,db}.rs` |

Companion: `o8-notch-dock-parity-dossier.md` (full window-contract write-up + the broken-state reference frames in `o8-parity-frames/`).
