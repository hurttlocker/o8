# o8 P3 Hotkeys — Build-Ready Port Spec

Port source: `/Users/marquisehurtt/aqua-color` (Symon). Target: `/Users/marquisehurtt/cortex-ide` (o8). Tauri stays **2.10.3**.

> Produced by parity-research workflow `wmtpyh473` (6 parallel readers over aqua-color + o8 current state → synthesis). Part of #1205. Read alongside `docs/symon-parity-checklist.md` and `docs/symon-port/notch-dock-parity-dossier.md`.

## Overview

P3 adds the gesture/combo bindings Symon ships, on top of o8's single existing Fn push-to-talk tap. Two mechanisms:

1. **Extend the ONE existing HID CGEventTap** in `src-tauri/src/fn_hotkey.rs` to also detect **double-tap-Fn** (long-form toggle), and — where Symon uses the tap — **Fn+R** (screen-reading) and **Right-Option-hold** (Ask). No second recognizer, no second tap. catch_unwind panic-safety stays mandatory.
2. **Add `tauri-plugin-global-shortcut`** (currently absent in o8) for the Cmd/Option combos: `⌘⇧Space`, `⌘⇧R`, `⌘⇧S`, `⌘⇧,`, `⌘⌥V`.

**Pipeline gating (CRITICAL).** The *binding* is P3 for every gesture, but several land on pipelines o8 does not have yet:
- **Fn+R / ⌘⇧R → screen reading** → BLOCKED on P5 (no `reading.rs`, no Vision→TTS path).
- **Right-Option hold → Ask** → BLOCKED on P7 (no `qa.rs`, no answer pipeline).
- **Ctrl+Shift+S → speak-selection / TTS** → BLOCKED on P4 (no TTS subsystem).

**First shippable slice** = substrate (plugin + tap extension scaffolding) + **double-tap-Fn long-form** (rides o8's EXISTING `stt_engine` + `paste` + dock — fully wireable today) + the Cmd-combos that map to an **existing o8 capability**: **⌘⇧Space → summon/dismiss o8 window** and **⌘⌥V → paste-last-dictation** (needs a thin transcript-store read, see gap) and **⌘⇧, → open settings overlay**. The reading/Ask/speak keys get registered as **no-op-with-log stubs** (or are left unregistered) and marked BLOCKED until their pipelines land.

De-Symonize everything: no `Symon`/`symon`, no `symonsays.run`, no `com.misterlabs.symon`. All emitted events use the `o8:` prefix; all identifiers drop the `symon`/`aqua` stems.

## Architecture decision

**Extend, never duplicate.** o8 already owns the exact tap foundation Symon has: HID location, `HeadInsertEventTap`, `ListenOnly`, subscribed to `[FlagsChanged, KeyDown]` (`fn_hotkey.rs:286-290`), `catch_unwind` wrapper (`fn_hotkey.rs:315`), CAS edge-latch (`fn_hotkey.rs:327-334`), the 40ms `CGEventSourceFlagsState` poll fallback (`fn_hotkey.rs:256-280`), and tap re-enable on `TapDisabledBy*` (`fn_hotkey.rs:296-308`). The panic-safety + dedupe substrate that double-tap requires is **already in place** — confirmed against `aqua-color/src-tauri/src/lib.rs:2503-2508,2660-2673` (catch_unwind) and `:3280-3291` (CAS).

Net-new work inside the tap:
- module-level / closure state: `LONG_FORM_FN_DOUBLE_TAP_MS = 480`, a `long_form_active: AtomicBool`, a `last_fn_brush: Arc<Mutex<Option<Instant>>>`, and (for the BLOCKED keys) `option_held: AtomicBool`, `reading_active: AtomicBool`.
- three **ordered** branches in the existing `if down_edge {` arm: (1) finish-long-form check, (2) double-tap-detect, (3) normal-hold-start. This ordering is load-bearing (Symon: finish-check `lib.rs:2832-2872`, detect `:2874-2894`, start `:2896-2973`).
- two edits to the `up_edge` arm: early-return when `long_form_active`, and stamp `last_fn_brush` in the sub-220ms brush branch.
- one edit to the poll fallback: skip teardown when `long_form_active` is set.
- stop blanket-discarding KeyDown (`fn_hotkey.rs:317-319`): read keycode via `event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE)` so Escape-cancels-long-form works now and Fn+R / reading-transport can be added when P5 lands.

**For the Cmd-combos: add `tauri-plugin-global-shortcut`.** Symon registers the plugin (`aqua lib.rs:3332`) and binds 5 combos in `setup()` (`aqua lib.rs:3646-3804`). o8 has zero global-shortcut usage. Match Symon's split: Fn / double-tap / Right-Option via the CGEventTap (modifier-only gestures the plugin cannot bind), Cmd-combos via the plugin.

### Origin model — one structural change

Today o8's system path is a single `SYSTEM_DICTATION_ORIGIN: AtomicBool` (`fn_hotkey.rs:49`) that `run_finalize` (`lib.rs:2482-2499`) reads to decide paste-vs-emit. **Long-form rides this same machinery unchanged** — it is still a dictation that pastes on finish, so the bool is sufficient for the first slice. Fn+R (screen-read) and Right-Option (Ask) are semantically *different* post-actions (not paste). When P5/P7 land, generalize `set_system_origin(bool)` → `set_system_mode(Mode::{Paste, Ask, ScreenRead})` threaded through `begin_*` → `run_finalize`. **Do NOT do this in the first slice.**

## Exact ports

### A. Substrate: tauri-plugin-global-shortcut (NEW)

| aqua file:line | behavior | o8 target | note |
|---|---|---|---|
| `aqua Cargo.toml:30` `tauri-plugin-global-shortcut = "2"` | plugin dep | `src-tauri/Cargo.toml` `[dependencies]` after line 42 (`tauri-plugin-autostart`) | — |
| `aqua lib.rs:3332` `.plugin(tauri_plugin_global_shortcut::Builder::new().build())` | plugin install | `src-tauri/src/lib.rs` Builder chain after autostart `.plugin(...)` (~2709) | — |
| `aqua default.json:15-17` global-shortcut perms | capability | `capabilities/default.json` add `"global-shortcut:default"` after line 29 | `allow-register`/`-unregister` only if a rebind UI is ever built |
| `aqua lib.rs:3646-3804` `app.global_shortcut().on_shortcut(...)` ×5 | registration | `lib.rs::setup()` near `fn_hotkey::start()` (~2902-2926) | **register inside `!preship_gate`** — see Risks. Guard `if shortcut.state != ShortcutState::Pressed { return; }` |

### B. Double-tap-Fn long-form (SHIPPABLE — rides existing stt_engine)

| aqua file:line | behavior | o8 target |
|---|---|---|
| `aqua lib.rs:151` `LONG_FORM_FN_DOUBLE_TAP_MS = 480` | 480ms double-tap window | `fn_hotkey.rs` const near `FN_TAP_PRIMER_MAX_MS` (line 79). **Use 480 verbatim** |
| `aqua lib.rs:2221-2225` `long_form_active`, `last_fn_brush` | gesture state | `fn_hotkey.rs::start()` next to `fn_held`/`fn_press_time` (247-249); clone into tap closure + poll thread |
| `aqua lib.rs:171` `LONG_FORM_SESSION_ID: AtomicU64` | session tag | `fn_hotkey.rs` module-level `static`; store `stt_engine::start()`'s `sid` |
| `aqua lib.rs:2874-2894` `is_double_tap_fn` (consume-on-read) | core detector | inside `if down_edge {` (336-342) BEFORE normal start; lock+consume `last_fn_brush`, true iff `elapsed <= 480ms` |
| `aqua lib.rs:2896-2973` double-tap → START long-form | toggle ON | add `begin_long_form_dictation()` paralleling `begin_system_dictation()` (97-148). Replace Symon Morse cue + pill-resize with `o8:stt-event {type:"system-long-form-start"}` `emit_to(DOCK_LABEL)` |
| `aqua lib.rs:2832-2872` single Fn-tap → FINISH | toggle OFF | FIRST check in `if down_edge {`: if `long_form_active && LONG_FORM_SESSION_ID!=0` → `finish_long_form_dictation()` (drives existing finalize→paste) |
| `aqua lib.rs:3147-3171` Fn-up no-op + brush stamp | toggle wire | `else if up_edge {` (343-355): early-return if `long_form_active`; in sub-220ms brush branch (351) stamp `last_fn_brush = Some(Instant::now())` |
| `aqua lib.rs:2257-2339` poll skips long-form | poll guard | `fn_hotkey.rs:256-280`: before `swap(false)` at 270, `continue` if `long_form_active_poll` set |
| `aqua lib.rs:2617-2649` Escape (kc 53) cancels | escape hatch | remove blanket KeyDown return (317-319); read keycode; `53 && long_form_active` → `cancel_long_form_dictation()` (`set_system_origin(false)` FIRST so finalize skips paste). Needs `use core_graphics::event::EventField;` |

### C. Cmd-combos mapping to an EXISTING o8 capability (SHIPPABLE)

| aqua file:line | behavior | o8 target |
|---|---|---|
| `aqua lib.rs:3646-3662` `⌘⇧Space` toggle pill | summon | register `"CommandOrControl+Shift+Space"`. o8's window is the full IDE → **summon-to-front** (`get_webview_window("main")` → `show()` + `set_focus()`), NOT hide |
| `aqua lib.rs:3752-3769` `⌘⇧,` open settings | open settings overlay | register `"CommandOrControl+Shift+,"` → `emit_to("main","o8:open-settings",())` (o8 settings is an overlay, not a window). **Chord fork** — see Forks |
| `aqua lib.rs:3771-3804` `⌘⌥V` paste last transcript | paste last dictation | register `"CommandOrControl+Alt+V"` → read new `LAST_VOICE_TRANSCRIPT` static → `paste::paste_text`. No o8 keymap collision |

### D. BLOCKED on missing pipelines (DEFER — register nothing in first slice)

| aqua file:line | behavior | blocked on |
|---|---|---|
| `aqua lib.rs:2527-2559` Fn+R (kc 15) → screen reading | P5 (no `reading.rs`) |
| `aqua lib.rs:2565-2615` reading transport (Space/arrows/Esc) | P5 |
| `aqua lib.rs:2677-2739` Right-Option (kc 61, `OPTION_FLAG 0x80000`) PRESS → Ask | P7 (no `qa.rs`) |
| `aqua lib.rs:2740-2829` Right-Option RELEASE → finalize+send | P7 |
| `aqua lib.rs:3664-3709` `⌘⇧R` reading | P5 |
| `aqua lib.rs:3711-3747` `⌘⇧S` speak selection | P4 (TTS) — o8 uses Ctrl+Shift+S to avoid Save As and Option chords |

## o8 gap

- **No `tauri-plugin-global-shortcut`** anywhere (Cargo.toml/lock/src clean). NEW dep + install + capability + registration — all four needed.
- **No transcript store on the Rust side.** `⌘⌥V` needs the last polished system transcript. Stash it in a `static LAST_VOICE_TRANSCRIPT: Mutex<Option<String>>` written at the end of `run_finalize` (~2482). Small, contained.
- **No `reading.rs`/Vision→TTS (P5), no `qa.rs` (P7), no TTS (P4).** These block Fn+R, ⌘⇧R, Ctrl+Shift+S, Right-Option Ask.
- **Origin model is a bool** — sufficient for long-form (Paste-mode); becomes a `Mode` enum only when P5/P7 land.
- **Settings UI already at/ahead of parity:** `KeyboardShortcutsOverlay.tsx` has a `ShortcutSection[]` schema with a "Voice" section; `VoiceTab.tsx` already has `01 PERMISSIONS` (Accessibility/Input Monitoring/Fn-binding). Just add discoverability rows.

## Capability / permission changes

1. `capabilities/default.json` — add `"global-shortcut:default"` (only capability change for the slice).
2. No new TCC for the Cmd-combos (plugin path). The tap path is already gated by Accessibility + Input Monitoring (`fn_hotkey::start()` `mac_perms`).
3. `AppleFnUsageType=0` (Fn → Do Nothing) still required; o8 already warns (`fn_hotkey.rs:227-243`).

## Risks / conflicts

- **preship_gate (lib.rs ~2909).** Register the global shortcuts inside the same `!preship_gate` macOS `setup()` block, NOT in the Builder, so the disposable pre-ship app doesn't grab system chords. (The `.plugin()` install can stay in the Builder.)
- **⌘⇧Space** — o8's window is the whole IDE; summon-to-front only, never hide.
- **⌘⇧, vs ⌘,** — o8 already binds plain `⌘,` in-app (`dashboard/page.tsx:3690`). See Forks.
- **⌘⇧S shadows macOS "Save As…"** system-wide — do NOT register globally; use Ctrl+Shift+S for speak-selection instead.
- **catch_unwind is non-negotiable** — keep all new tap-closure code INSIDE the existing `catch_unwind(AssertUnwindSafe(...))` (315-358). A panic across the extern "C" boundary aborts o8 + kills the Node sidecars.
- **Double-tap window = 480ms** (real Symon constant `aqua lib.rs:151`) — do not guess.
- **No rebind UI** — Symon's `settings.ts` `hotkey` field is dead/vestigial; keep o8 hotkeys display-only.

## Operator forks

1. **first-slice-combos** — Which Cmd-combos ship now? **Rec: ship the 3 existing-capability combos (⌘⇧Space, ⌘⌥V, ⌘⇧,) + double-tap-Fn; register nothing for the 2 pipeline-blocked ones** (no inert globals grabbing system chords). ⌘⌥V's transcript-store stash is small — keep it in.
2. **settings-chord-conflict** — o8 has in-app `⌘,`; Symon's global is `⌘⇧,`. **Rec: add `⌘⇧,` as the global (fires when o8 unfocused — the actual value of a global), keep `⌘,` in-app.** If avoiding redundancy, drop `⌘⇧,` from the slice entirely.
3. **cmd-s-save-as** — `⌘⇧S` global shadows "Save As…". **Resolved: never register a global `⌘⇧S`; use Ctrl+Shift+S for speak-selection.**
4. **preship-gate-placement** — **Rec: register the on_shortcut handlers inside the `!preship_gate` setup() block** (the `.plugin()` install can stay in the Builder).
5. **escape-cancel-scope** — **Rec: include Escape-cancel in the first slice** — KeyDown plumbing is cheap and pre-wires the keycode read Fn+R/reading-transport reuse in P5.

## Build plan (ordered — first shippable slice)

1. `Cargo.toml [dependencies]`: add `tauri-plugin-global-shortcut = "2"` after line 42.
2. `lib.rs` Builder chain (~2709): `.plugin(tauri_plugin_global_shortcut::Builder::new().build())` after autostart.
3. `capabilities/default.json`: add `"global-shortcut:default"`.
4. `fn_hotkey.rs`: `const LONG_FORM_FN_DOUBLE_TAP_MS: u64 = 480;` (~line 79); `static LONG_FORM_SESSION_ID: AtomicU64`; `use std::sync::atomic::AtomicU64;` + `use core_graphics::event::EventField;`.
5. `fn_hotkey.rs start()`: `long_form_active: Arc<AtomicBool>` + `last_fn_brush: Arc<Mutex<Option<Instant>>>` (next to 247-249); clone `_cb` into tap closure, `_poll` into poll thread.
6. `fn_hotkey.rs`: `begin_long_form_dictation()` / `finish_long_form_dictation()` / `cancel_long_form_dictation()` (parallel `begin_system_dictation` 97-148). Reuse `stt_engine` + `paste::save_frontmost_app` + dock emits; record/zero `LONG_FORM_SESSION_ID`; cancel sets `set_system_origin(false)` BEFORE stop. Never spawn a second recognizer.
7. `fn_hotkey.rs` down_edge (336): order branches — (a) finish-long-form FIRST, (b) double-tap-detect (lock+consume, `elapsed<=480ms`), (c) else normal `begin_system_dictation`.
8. `fn_hotkey.rs` up_edge (343-355): early-return if `long_form_active`; stamp `last_fn_brush = Some(now)` in the sub-220ms brush branch (351).
9. `fn_hotkey.rs` poll (256-280): before `swap(false)` at 270, `continue` if `long_form_active_poll` set.
10. `fn_hotkey.rs` KeyDown: remove blanket return (317-319); read keycode; `53 && long_form_active` → `cancel_long_form_dictation()`. Keep inside `catch_unwind`.
11. `lib.rs run_finalize` (~2482): for system-origin, write `polished` to `static LAST_VOICE_TRANSCRIPT: Mutex<Option<String>>`.
12. `lib.rs setup()` (`!preship_gate` macOS block ~2902-2926): register 3 globals, each `if shortcut.state != ShortcutState::Pressed { return; }` — `⌘⇧Space` (summon: show+set_focus), `⌘⇧,` (`emit_to("main","o8:open-settings",())`), `⌘⌥V` (`LAST_VOICE_TRANSCRIPT` → `paste::paste_text`).
13. dashboard webview: listen `o8:open-settings` → `toggleSettingsOverlay()`.
14. `KeyboardShortcutsOverlay.tsx` Voice section: add discoverability rows (long-form / summon / paste-last / open-settings).
15. Verify: `cargo tauri build` compiles; double-tap starts / single-tap finishes-with-paste / Escape cancels-no-paste / Fn-release-during-long-form no-op / poll doesn't kill toggle / ⌘⇧Space summons / ⌘⌥V pastes last / ⌘⇧, opens settings / no panic aborts the process.
