# o8 — TTS + say/Speak-Selection + Ask (Right-Option) — Phased Port Spec

> Parity-research workflow `wxe56nlsl` (4 readers over aqua tts/qa.rs/reading.rs/symon_voice.rs + o8 gap). Part of #1205. Companion: symon-parity-dossier-MASTER.md.

# o8 Port Spec — Native TTS + `say`/Speak-Selection + Ask (Right-Option)

**Source of truth:** aqua/Symon live tree at `/Users/marquisehurtt/aqua-color/src-tauri/` + `/aqua-color/src/`. Target: `/Users/marquisehurtt/cortex-ide/`. o8 stays Tauri **2.10.3**. Every key path is **direct API key** via the existing `~/.o8/dictation.json` + env resolver pattern — **NO Symon proxy, NO license token, NO product-mode gate**. Ask uses **Gemini direct only**; **NEVER Anthropic** (billing rule).

Three phases in dependency order:

- **Phase A — TTS Engine** (foundation: providers, two-path `load_config`, ElevenLabs exact request, Google direct, `say` fallback, the `!Send` rodio playback thread, key resolution). Nothing else can speak until A lands.
- **Phase B — `say` / Speak-Selection** (uses A): `grab_selection` compose, a `Ctrl+Shift+S` global shortcut, plus the net-new spoken `"say <text>"` grammar in `stt/mod.rs`.
- **Phase C — Ask / Right-Option** (uses A only for the *spoken* answer; the **text** answer is independent of A): extend `fn_hotkey.rs` CGEventTap for Right-Option, the Ask engine (Gemini direct), the dock answer panel, and the spoken answer gated behind A.

De-Symonize throughout: drop `personal_mode`/founder ceremony, drop `symon_license_token()`/`symon_api_url()`, drop the proxy branches, rename every `symon-*`/`ask-*` event to `o8:ask-*`, rename "Symon" → "o8" in prompts, omit the dead Edge/Native TTS providers. Any React UI is **inline styles only**, `var(--t-*)` tokens, no CSS classes.

---

## The MANDATORY rodio `!Send` thread pattern (applies to ALL audio playback in Phases A/B/C)

`rodio::OutputStream`, `Sink`, and `Decoder` are **`!Send`** and are held across `.await`. They CANNOT be spawned through `tauri::async_runtime::spawn` (multithread runtime) — it will not compile. Every playback site MUST use this exact shape:

```rust
std::thread::spawn(move || {
    // current-thread tokio built INSIDE the OS thread
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tts: build current-thread runtime");

    // 1) synthesize (async reqwest) on this thread's runtime
    let mp3: Vec<u8> = match rt.block_on(async { tts::speak(&text, &config).await }) {
        Ok(bytes) => bytes,
        Err(_) => { /* fall back to `say` (Vec<u8> path not used) */ return; }
    };

    // 2) decode + play on the SAME OS thread (never cross a thread boundary)
    let (_stream, handle) = match rodio::OutputStream::try_default() {
        Ok(s) => s, Err(_) => return,
    };
    let sink = match rodio::Sink::try_new(&handle) { Ok(s) => s, Err(_) => return };
    let cursor = std::io::Cursor::new(mp3);
    match rodio::Decoder::new(cursor) {
        Ok(decoder) => { sink.append(decoder); }
        Err(_) => return,
    }
    sink.sleep_until_end(); // drain
});
```

**Source:** `aqua reading.rs:157-189` (thread shape) + `reading.rs:267-330` (minimal decode/play) → o8 `src-tauri/src/tts/playback.rs::play_thread()`. The `symon_voice.rs:175-252` i16-PCM/RMS variant is **only** needed if a waveform UI wants the envelope — out of scope for v1, use the minimal decode. Transport (pause/stop) reaches the thread via `Arc<AtomicBool>` + `Arc<Mutex<Option<Sink>>>` (additive, not required for the single-shot v1 path).

---

# PHASE A — TTS Engine (foundation)

Goal: a native Rust TTS module so o8 can speak **with no focused webview** — ElevenLabs (direct, entitlement-gated), Google (direct), macOS `say` runtime fallback. This is the foundation Phases B and C build on. o8 has **zero** native TTS today (verified: no `rodio`/`OutputStream`/`elevenlabs`/`msedge_tts` anywhere in `src-tauri`).

## A.1 — Cargo deps

`src-tauri/Cargo.toml`:

| Action | Crate | Note |
|---|---|---|
| **ADD** | `rodio = "0.19"` | Match aqua's pin exactly. rodio 0.20+ changed `OutputStream`/`Sink` APIs; 0.19 keeps `OutputStream::try_default()` / `Sink::try_new()` / `Decoder::new(Cursor)` as the ported code expects. |
| present | `reqwest = "0.13"` (line 61, `default-features=false`, `["blocking","rustls","json","http2"]`) | Sufficient — ElevenLabs/Google paths use async `reqwest::Client::new()` POST with `json`+`rustls`. Aqua used 0.12 rustls-tls; 0.13 is a clean superset for these calls. |
| present | `base64 = "0.22"` (line 84) | Google path decodes `audioContent` (STANDARD). |
| present | `serde`/`serde_json` (lines 28-29), `tracing` (line 80) | Used by all ports. |
| **DO NOT ADD** | `msedge-tts` | Edge provider is dead code in aqua (remapped to Google). Drags in `isahc`/`curl-sys`/`openssl-sys` universal-build pain. |
| **DO NOT ADD** | `objc2-av-foundation` | Native (AVSpeechSynthesizer) provider is a perpetual stub. The real macOS fallback is the `say` subprocess. |

## A.2 — Key resolution (de-Symonized, mirror `stt/keys.rs`)

`stt/keys.rs:60-79` is the exact verified template: env-first → `config_string()` from `~/.o8/dictation.json` (OnceLock-cached `config()`), UN-GATED. The sidecar already forwards env keys from the login shell (`load_ai_keys_from_login_shell` in `lib.rs`), so `ELEVENLABS_API_KEY`/`GOOGLE_TTS_API_KEY` in `~/.zshenv` reach a Finder-launched build.

| Port | aqua → o8 |
|---|---|
| ElevenLabs key | `aqua keys.rs:elevenlabs()` (the ONE un-gated accessor) → **add to `src-tauri/src/stt/keys.rs`**: `pub fn get_elevenlabs_key()` = env `ELEVENLABS_API_KEY` → `config_string("elevenlabs_api_key")` (identical to `get_gemini_key()` at `stt/keys.rs:63`). |
| Google TTS key | `aqua keys.rs:google_tts()` (drop the `bypass_proxy_in_dev()` gate) → **add to `stt/keys.rs`**: `pub fn get_google_tts_key()` = env `GOOGLE_TTS_API_KEY` → `config_string("google_tts_api_key")`. |
| **DELETE** | `symon_license_token()` / `symon_api_url()` / `bypass_proxy_in_dev()` / `is_local()` / `product_mode` — these do not exist in o8 and must not be ported. |

**Recommendation:** extend the existing `stt/keys.rs` rather than create `tts/keys.rs` — the `o8_data_dir()`/`config()`/`config_string()` helpers are already there; TTS resolvers are two more 8-line functions reusing the same OnceLock cache.

## A.3 — `tts/mod.rs` — the two-path model, collapsed

`aqua tts/mod.rs:8-88` → **new `src-tauri/src/tts/mod.rs`**. Declare `mod tts;` next to `mod stt;` at `lib.rs:10`.

**The load-bearing two-path model**, collapsed for o8 (FORK 1 drops the personal_mode override; FORK 3/4 drop Edge/Native variants):

```rust
pub enum TtsProvider { ElevenLabs, Google }  // Edge/Native OMITTED

pub struct TtsConfig { pub provider: TtsProvider, pub voice_id: String, pub speed: f32, pub pitch: f32 }
// Default: Google / "en-US-Neural2-J" / 1.0 / 0.0   (aqua tts/mod.rs Default)

pub fn load_config() -> TtsConfig {
    // De-Symonized selection — collapses to a plain pref read:
    let provider = match crate::stt::keys::config_string("tts_provider").as_deref() {
        Some("elevenlabs") if crate::stt::keys::get_elevenlabs_key().is_some() => TtsProvider::ElevenLabs,
        _ => TtsProvider::Google,            // google | edge | native | default → Google
    };
    let default_voice = match provider {
        TtsProvider::ElevenLabs => elevenlabs::configured_voice_id(),
        TtsProvider::Google => "en-US-Neural2-J".to_string(),
    };
    let voice_id = match provider {
        TtsProvider::ElevenLabs => default_voice,   // ElevenLabs ALWAYS uses its own voice id
        TtsProvider::Google => crate::stt::keys::config_string("tts_voice_id").unwrap_or(default_voice),
    };
    let speed = crate::stt::keys::config_string("reading_speed")
        .and_then(|s| s.parse::<f32>().ok()).unwrap_or(1.0);
    TtsConfig { provider, voice_id, speed, pitch: 0.0 }
}

pub async fn speak(text: &str, config: &TtsConfig) -> Result<Vec<u8>, String> {
    match config.provider {
        TtsProvider::ElevenLabs => elevenlabs::synthesize(text, config).await,
        TtsProvider::Google     => google::synthesize(text, config).await,
    }
}
```

De-Symonize notes: `AquaError` → `String` (mirror what the stt module does — `Result<Vec<u8>, String>`). Drop the `elevenlabs::personal_provider_requested()`/`personal_mode_enabled()` branch entirely (FORK 1) — ElevenLabs is selectable whenever the `tts_provider` pref is `"elevenlabs"` AND `ELEVENLABS_API_KEY` resolves. The Edge `"edge"=>Google` remap (dead in aqua) is folded into the catch-all `_ => Google`.

## A.4 — `tts/elevenlabs.rs` — the EXACT direct request (highest-fidelity port)

`aqua tts/elevenlabs.rs:6-173` → **new `src-tauri/src/tts/elevenlabs.rs`**. Port **nearly verbatim** — this is the load-bearing request.

Constants:
```rust
const ENDPOINT_BASE: &str = "https://api.elevenlabs.io/v1/text-to-speech";
const DEFAULT_VOICE: &str = "JBFqnCBsd6RMkjVDRZzb";      // FORK 2: canonical default
const DEFAULT_MODEL: &str = "eleven_multilingual_v2";
const DEFAULT_OUTPUT_FORMAT: &str = "mp3_44100_128";
```

URL: `format!("{ENDPOINT_BASE}/{voice_id}?output_format={output_format}")` — **voice_id in PATH, output_format in QUERY**.

Request struct — **snake_case AS-IS, do NOT add `#[serde(rename_all)]`** (the API literally wants `model_id`/`voice_settings`/`similarity_boost`/`use_speaker_boost`):
```rust
#[derive(Serialize)]
struct SynthesizeRequest { text: String, model_id: String, voice_settings: VoiceSettings }
#[derive(Serialize)]
struct VoiceSettings { stability: f32, similarity_boost: f32, style: f32, use_speaker_boost: bool }
```

Headers + send:
```rust
reqwest::Client::new().post(&url)
    .header("xi-api-key", api_key)        // key = crate::stt::keys::get_elevenlabs_key()
    .header("Accept", "audio/mpeg")
    .json(&request_body)
    .send().await ...
```

Defaults (each pref-or-env, f32 clamped `0.0..=1.0`) — **drop the `personal_` prefix ceremony**, use plain pref keys:
- `stability` 0.45 (`config_string("elevenlabs_stability")` / env `ELEVENLABS_STABILITY`)
- `similarity_boost` 0.8 (`elevenlabs_similarity_boost` / `ELEVENLABS_SIMILARITY_BOOST`)
- `style` 0.0 (`elevenlabs_style` / `ELEVENLABS_STYLE`)
- `use_speaker_boost` true (bool parse `true|1|yes` / `false|0|no`; `elevenlabs_use_speaker_boost` / `ELEVENLABS_USE_SPEAKER_BOOST`)
- `model_id` `eleven_multilingual_v2` (`elevenlabs_model_id` / `ELEVENLABS_MODEL_ID`)
- `output_format` `mp3_44100_128` (`elevenlabs_output_format` / `ELEVENLABS_OUTPUT_FORMAT`)
- `configured_voice_id()` = `elevenlabs_voice_id` / `ELEVENLABS_VOICE_ID` / `JBFqnCBsd6RMkjVDRZzb`

`config.voice_id` non-empty wins over `configured_voice_id()`.

**Speed is IGNORED on the ElevenLabs path** (FORK 7) — `voice_settings` has no rate field. Do not invent one.

Response: read `.bytes()`; on `!status.is_success()` parse `{detail:{message}}|{detail}|{message}` → `String` error; empty → `"received empty audio"`; else `Ok(bytes.to_vec())`. **DIRECT to `api.elevenlabs.io`** (o8 has no proxy). `AquaError::Tts` → `String`.

**Entitlement gate (FORK 8):** because ElevenLabs is a paid premium voice, gate it behind the existing M1-M6 entitlement layer. Recommended: at the **selection** level — `load_config()` only returns `TtsProvider::ElevenLabs` when both `tts_provider == "elevenlabs"` AND the entitlement check passes (founder/Pro). For a founder-only build, the env-key presence is the de-facto gate; the entitlement check is the productized form. See FORK F.

## A.5 — `tts/google.rs` — direct branch ONLY (proxy half deleted)

`aqua tts/google.rs:6-171` → **new `src-tauri/src/tts/google.rs`**, but **DELETE the proxy half** (FORK 5).

```rust
const ENDPOINT: &str = "https://texttospeech.googleapis.com/v1/text:synthesize";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]   // REQUIRED here (unlike ElevenLabs)
struct SynthesizeRequest { input: SynthesisInput, voice: VoiceSelection, audio_config: AudioConfig }
// input:{text}, voice:{languageCode,name}, audioConfig:{audioEncoding,speakingRate,pitch}
```

- `language_code` = `voice_id.split('-').take(2).join("-")` (`en-US-Neural2-J` → `en-US`)
- `audio_encoding = "MP3"`, `speaking_rate = speed`, `pitch = effective_pitch` where `effective_pitch = 0.0 if voice_id.contains("Chirp3") else pitch`
- key = `crate::stt::keys::get_google_tts_key()`; URL = `format!("{ENDPOINT}?key={api_key}")`; direct POST
- on `!success` parse `{error:{message}}` → `"Google TTS API error ({status}): {message}"` (`String`)
- success: `SynthesizeResponse{audio_content}` → base64 **STANDARD** decode → `Vec<u8>`

**DELETE:** the `is_local()`/product-mode guard, the `symon_license_token()` branch + proxy URL, the `401-clears-token` / `403-subscription_inactive` `License` errors. None of that exists in o8.

## A.6 — `tts/native_say.rs` — macOS `say` runtime fallback

`aqua reading.rs:543-584` → **new `src-tauri/src/tts/native_say.rs`** (or inline in `mod.rs`). Verbatim, no de-Symonization needed:

```rust
pub fn speak_with_say(text: &str, speed: f32) -> bool {
    let rate = (175.0 * speed.max(0.1)) as u32;
    matches!(std::process::Command::new("say")
        .args(["-r", &rate.to_string()]).arg(text).status(),
        Ok(s) if s.success())
}
```

**No-mid-read-switch rule** (preserve if chunked reading is ported): `say` is a fallback ONLY before any cloud audio has played. First-chunk failure → `say` the whole text. Once playback started, a later failure **STOPS** (`stopped_for_voice_consistency`) rather than switching voices mid-paragraph. For o8 v1 single-shot (one `speak` per utterance, no chunking) the rule simplifies to: **provider fails → `say` the whole text once.**

## A.7 — `tts/playback.rs` — the `!Send` thread + the Tauri command

The mandatory pattern (see top of doc) → **new `src-tauri/src/tts/playback.rs::play_thread(text, config)`**. Register a `#[tauri::command] tts_speak(text: String)` (+ optional `tts_stop`) in the `generate_handler![]` list at `lib.rs:~2863`, alongside the existing `stt_engine` commands. The command body MUST `std::thread::spawn` → build `Builder::new_current_thread().enable_all()` runtime → `block_on(tts::speak)` → `OutputStream::try_default()` + `Sink::try_new` + `Decoder::new(Cursor::new(mp3))` + `sink.append` + `sink.sleep_until_end()` **all on that same OS thread**. On `tts::speak` error → `native_say::speak_with_say(&text, config.speed)`.

## A.8 — Phase A wiring summary (file:line)

| aqua source | o8 target |
|---|---|
| `tts/mod.rs:8-88` | `src-tauri/src/tts/mod.rs` (enum collapsed to ElevenLabs/Google; `load_config()`; `speak()`) |
| `tts/elevenlabs.rs:6-173` | `src-tauri/src/tts/elevenlabs.rs::synthesize()` + `configured_voice_id()` |
| `tts/google.rs:6-171` (direct half) | `src-tauri/src/tts/google.rs::synthesize()` |
| `reading.rs:543-584` | `src-tauri/src/tts/native_say.rs::speak_with_say()` |
| `symon_voice.rs:175-252` / `reading.rs:157-189,267-330` | `src-tauri/src/tts/playback.rs::play_thread()` (`!Send` thread) |
| `keys.rs:elevenlabs()` + `google_tts()` (un-gated) | `src-tauri/src/stt/keys.rs::get_elevenlabs_key()` + `get_google_tts_key()` |
| `lib.rs` module decl + handler | `src-tauri/src/lib.rs:10` (`mod tts;`) + `:~2863` (`tts_speak`/`tts_stop` in `generate_handler![]`) |

**Phase A build steps:** add `rodio = "0.19"` → write the 6 new files + 2 key fns → declare `mod tts;` + register `tts_speak`/`tts_stop` → `cargo build` → smoke-test `tts_speak` from the webview (`invoke('tts_speak', { text: 'hello from o8' })`) with `ELEVENLABS_API_KEY` set (premium voice) and unset (Google → `say` fallback). **Nothing blocks Phase A.**

---

# PHASE B — `say` / Speak-Selection (uses Phase A)

Goal: highlight text anywhere → `Ctrl+Shift+S` speaks it; plus the operator's net-new spoken `"say <text>"` grammar. **BLOCKED ON:** Phase A (`tts::speak`/`playback::play_thread`). If Phase A slips, B can ship a degraded path that routes straight to `native_say::speak_with_say` (no rodio, no cloud) — see FORK G.

## B.1 — `grab_selection()` — thin verbatim compose (all backing helpers exist)

`aqua reading.rs:1146-1193` → **new `grab_selection()` in `src-tauri/src/paste.rs`** (or `tts/select.rs`). **All six helpers ALREADY EXIST in o8 `paste.rs`** (verified `#[allow(dead_code)]`): `read_selected_text_via_accessibility:310`, `capture_clipboard_snapshot:730`, `simulate_cmd_c:852`, `clipboard_change_count:745`, `read_clipboard_text:753`, `restore_clipboard_if_match:774`. This is a thin compose — no name changes (already de-Symonized).

Port the exact algorithm: Strategy 1 = `read_selected_text_via_accessibility()` → `Some` done (no clipboard touch). Strategy 2 fallback = snapshot → `simulate_cmd_c()` → poll loop **deadline `now+180ms`, sleep `10ms`/iter** comparing `clipboard_change_count() != saved.change_count` → on change read new clipboard + `restore_clipboard_if_match`. Accept rule verbatim: `(Some new, Some old)` use if `new != old && !new.trim().is_empty()`; `(Some new, None)` use if `!new.trim().is_empty()`; else warn `"clipboard unchanged — not using stale content"` → `None`. The **180ms/10ms/accept-rule must be copied exactly.** Flip off `#[allow(dead_code)]` on the helpers.

FORK on the fallback (FORK H): AX-only (clean, no clipboard clobber) vs AX-then-Cmd+C (covers canvas/Electron apps with opaque AX). Recommend **AX-then-Cmd+C** — the helpers are right there and the save/restore dance is already correct.

## B.2 — `Ctrl+Shift+S` global shortcut handler

`aqua lib.rs:3711-3747` (Cmd+Shift+S Speak-Selection) → **o8 `lib.rs` global-shortcut block (~3037-3089)**, alongside the existing `⌘⇧Space` / `⌘⌥V` / `⌘⇧,` handlers. o8 **already has `tauri-plugin-global-shortcut` 2** (Cargo line 46), so this is the natural slot (Ctrl+Shift+S is a plain chord, unlike Right-Option which is a modifier).

Pattern (mirror the existing `⌘⌥V` handler at `lib.rs:3060` which already does `std::thread::spawn(paste_text)`):
```
register "Control+Shift+S"
.on_shortcut → if state != Pressed { return }   // guard double-fire
  std::thread::spawn(move || {
     match grab_selection() {
       Some(text) => { /* play_sound optional */ tts::playback::play_thread(text, tts::load_config()); }
       None => { emit_to(DOCK_LABEL, "o8:ask-error" or a toast, "Select text first"); }
     }
  });
```
De-Symonize: drop `play_sound("ReadStart"/"Pop")` or map to o8 sounds; **do not** port the `Arc<Mutex<ReadingSession>>` machinery — for v1 the speak path is a **stateless fn** (`play_thread`), not a session. (aqua shares `start_selection` between Cmd+Shift+S and Cmd+Shift+R; o8 v1 only needs the selection-only path.)

**Optional `Cmd+Shift+R`** (`aqua lib.rs:3664-3709`): the selection-first-else-full-screen reader. The full-screen branch (`session.start()`) needs **Gemini Vision + capture + chunking** — **DEFER**. If o8 registers Cmd+Shift+R at all, route **both** branches to the selection-only speak path until the screen-read pipeline is ported.

## B.3 — Net-new `"say <text>"` spoken grammar (NOT in Symon)

**Confirmed:** Symon has NO spoken `say <text>` command — its only processor is `stt commands.process` (cancel/scratch/remove/new-line/new-paragraph), which o8 already ported. This is the operator's **net-new, de-Symonized-by-construction** grammar.

`o8 stt/mod.rs:82-154` (verified: `CommandResult` has only `Text(String)`/`Cancel`) → three surgical edits:

1. **Add variant** at `stt/mod.rs:~84`:
   ```rust
   pub enum CommandResult { Text(String), Cancel, Speak(String) }
   ```
2. **Add branch** in `process()` at `stt/mod.rs:~99`, placed **BEFORE** the cancel/remove logic, using **`starts_with`** (a read-aloud directive *leads* the utterance, unlike the trailing `ends_with` cancel commands):
   ```rust
   if lower.starts_with("say ") {
       return CommandResult::Speak(trimmed[4..].trim().to_string());
   }
   ```
   (Optionally also accept `"speak "` / `"read this "` leads.)
3. **Wire the call-site** in `lib.rs::stt_engine::run_finalize` (~2475-2581, the system-Fn paste path): the existing `match crate::stt::commands::process(&raw_text)` branches on `Text`→paste / `Cancel`→discard. **Add a third arm** `CommandResult::Speak(t) => tts::playback::play_thread(t, tts::load_config())` instead of pasting. Keep the TS mirror (`src/lib/dictation/voice-commands.ts`) in sync if the in-window composer should honor `"say "` too (optional).

## B.4 — Phase B wiring summary (file:line)

| aqua source | o8 target |
|---|---|
| `reading.rs:1146-1193` | `src-tauri/src/paste.rs::grab_selection()` (composes existing :310/:730/:852/:745/:753/:774) |
| `lib.rs:3711-3747` (Cmd+Shift+S) | `src-tauri/src/lib.rs` global-shortcut block (~3037-3089) |
| `lib.rs:3664-3709` (Cmd+Shift+R, deferred) | same block — route both branches to selection-only until Vision ports |
| `reading.rs:543-584` (`say` fallback) | already landed in Phase A (`tts/native_say.rs`) |
| net-new (not in Symon) | `src-tauri/src/stt/mod.rs:84` (`CommandResult::Speak`) + `:99` (`starts_with("say ")`) + `lib.rs run_finalize` third match arm |

**Phase B blocked on:** Phase A (`tts::load_config`/`playback::play_thread`). Build steps: land `grab_selection` (flip dead_code) → register `Ctrl+Shift+S` → add `CommandResult::Speak` + `process()` branch + `run_finalize` arm → `cargo build` → manual test: highlight text in any app, press `Ctrl+Shift+S`, hear it; Fn-dictate `"say hello world"`, hear "hello world" (not pasted).

---

# PHASE C — Ask / Right-Option (text answer independent of A; spoken answer uses A)

Goal: hold **Right-Option** → record via the shared STT machine → on release (≥120ms) finalize → polish → ask **Gemini direct** → stream answer into the dock answer panel. The **text answer is fully independent of Phase A**; only the **spoken answer** is gated behind A.

Note: o8 also already has a working Ask *backend* at `/api/cortex/ask` (SSE: open/token/citation/done/error → `runAskPipeline` at `src/lib/cortex/qa/ask.ts:214`). This is **FORK A**: port aqua's Rust `qa.rs`+`gemini_ask.rs` (faithful, keeps the event contract, Gemini-direct), **OR** reuse o8's existing `/api/cortex/ask` and have the Rust hotkey POST to it. Both are valid; the spec documents the faithful Rust port and flags the reuse alternative.

## C.1 — Right-Option hotkey (extend `fn_hotkey.rs` CGEventTap)

o8's `fn_hotkey.rs` header literally says *"the Right-Option Ask path is intentionally dropped"* — this **un-blocks it**. The existing tap is HID-location, ListenOnly, watching `[FlagsChanged, KeyDown]`, with the Fn brush/double-tap atomics + `catch_unwind` + the Sequoia 40ms poll fallback. Extend it; **never spawn a second recognizer** (header line 25 rule).

**Constants** (`aqua lib.rs:2462-2466` → `o8 fn_hotkey.rs:~102`, next to `FN_FLAG`):
```rust
const OPTION_FLAG: u64 = 0x80000;        // NSEventModifierFlagOption (1<<19)
const RIGHT_OPTION_KEYCODE: i64 = 61;    // kVK_RightOption (Left Option = 58)
```
Plus state: `option_held: AtomicBool`, `option_press_time: Mutex<Instant>`, `ask_session_id: AtomicU64`. **L vs R Option is NOT distinguishable by the OPTION mask bit** — must combine `(flags & OPTION_FLAG) != 0` with `keycode == 61` on the FlagsChanged event.

**DOWN edge** (`aqua lib.rs:2677-2739` → `fn_hotkey.rs` new FlagsChanged branch): record press `Instant`; `option_held=true`; debounce if `ask_session_id != 0`; `opened_from_idle = !ask_mode_active()`. **"Ask takes the mic":** if a Fn dictation is active, **force-stop it** (coordinate with the Fn atomics already in this file — flip `dictation_active=false`, swap the active session, `request_stt_stop(prev, "Right Option ask takeover")`). Allocate a new session id; show/grow the o8 `dock` window; (if `opened_from_idle`) emit `o8:ask-open` + `o8:ask-voice-state(true)`; `ensure_stt_ready_and_start` **reusing the existing recognizer** the Fn path drives. (aqua's `symon_voice::stop_speaking` is a no-op in C until A's transport exists.) On failure roll back all atomics + emit `o8:ask-error`.

**UP edge** (`aqua lib.rs:2740-2830` → `fn_hotkey.rs`): `option_held=false`; `hold = now - press_time`. **120ms BRUSH GUARD (load-bearing): `if hold < Duration::from_millis(120)`** → `ask_session_id=0`, `request_stt_stop("short ask brush")`, cancel, (if opened_from_idle) emit `o8:ask-collapse`, return. Else `std::thread::spawn` → `request_stt_stop_after_tail` → `wait_for_session_complete(STT_FINALIZE_TIMEOUT_MS≈2600)` → snapshot → `choose_final_stt_transcript` → run `stt::commands::process` → if `Text` non-empty & still-current & polish available → `polish_text` → if `final_text` non-empty emit `o8:ask-send-now(final_text)`; else emit `o8:ask-collapse`. (o8 already has `request_stt_stop`/snapshot equivalents in `src-tauri/src/stt/` — the Fn path uses them.)

A **2nd Right-Option while the panel is up** records a follow-up (`ask_session` reused, `opened_from_idle=false` so no open/collapse) — emits `o8:ask-voice-state` only.

## C.2 — Ask engine (Gemini DIRECT only — FORK A path 1)

o8 has no `qa.rs`. **Create `src-tauri/src/qa.rs`** + `src-tauri/src/ai/gemini_ask.rs`. This is **pure `reqwest`** (no rodio) — the `!Send` dedicated-thread pattern is **NOT needed** for Ask text.

**Models** (`aqua gemini_ask.rs:29-39`): use `DIRECT_MODEL = "gemini-3.1-pro-preview"` (drop the proxy `MODEL = "gemini-3-pro-preview"` tag — that's the license server). `MAX_OUTPUT_TOKENS 2048`, `temperature 0.3`, `MAX_HISTORY_TURNS 8`. **NEVER Anthropic** (billing rule). o8 already references `gemini-3.1-pro-preview` (`src/lib/format.ts`) and has `GEMINI_API_KEY` plumbing (`stt::keys::get_gemini_key`).

**Endpoint** (`aqua gemini_ask.rs:419-439`, direct branch only — drop the proxy branch): `https://generativelanguage.googleapis.com/v1beta/models/{DIRECT_MODEL}:generateContent?key={api_key}`. Body camelCase: `{ contents, generationConfig: { maxOutputTokens: 2048, temperature: 0.3 } }`. `build_contents` ordering is **load-bearing**: workspace-context (user role) → ≤8 prior turns (assistant→`model`, else→`user`) → current user turn. `current_parts = [{text:"[System context: …]"}, optional inline_data screenshot, {text: question}]`. Image = base64 `inline_data`, mime sniffed by magic bytes. Key = `crate::stt::keys::get_gemini_key()`.

**`stream_ask_question`** (`aqua qa.rs:173-313` → `qa.rs::stream_ask_question`): **DROP** the Local-Mode block, the Operator/agent beta fork (FORK C), and the local-agent (Claude-Code-CLI) route (`local_agent_enabled()` is already hardcoded false → `gemini_route` always true). **KEEP** `classify_question_intent`, `build_context_bundle`, `build_gemini_prompt`, `run_streaming_gemini_with_bundle`. Emit deltas through `AnnotationParser` (strips `[POINT]`/`[CLICK]` so raw tags never leak — overlay dispatch is a **no-op in v1**, FORK D). Events de-Symonized: `o8:ask-stream-delta {text}`, `o8:ask-stream-done {final, tokens}`, `o8:ask-stream-error {message}` (`message=="cancelled"` handled specially).

**Context bundle** (`aqua qa.rs:585-640`): `selection_text` = `grab_selection()` (the Phase B compose — reuse it), `screenshot_jpeg` (capture 960px/q80 → `inline_data`; **DEFER** capture for v1 minimum — selection + frontmost is enough), `frontmost_app` = `get_frontmost_bundle_id` (o8 `paste.rs` has the equivalent), `recent` transcripts (≤4×140 chars, nice-to-have).

**Prompts** (`aqua qa.rs:884-933` + `gemini_ask.rs:160-177`): port verbatim, **rename "Symon" → "o8"**, `RECENT SYMON TRANSCRIPTS` → `RECENT TRANSCRIPTS`. Keep `OVERLAY_SYSTEM_HINT` appended (harmless — parser strips the tags). Skip `CARDS_SYSTEM_HINT` (cards off, FORK D).

**Unary bridge = v1 default** (`aqua gemini_ask.rs:558-595`, FORK E): `STREAMING_PREF_KEY` defaults FALSE → `ask_stream` calls `ask_with_cards` once and fires `on_delta(&answer)` ONCE with the full answer → emit a single `o8:ask-stream-delta` then `o8:ask-stream-done` (UI **snaps**, doesn't type). Port the SSE parser (`ask_stream_real`) too but gate it behind an o8 pref (dead-ready). `cancel_rx` → a `cancel_ask_stream` command (single-slot oneshot).

**FORK A path 2 (alternative):** skip `qa.rs` and have the UP-edge thread POST the polished transcript to o8's existing `/api/cortex/ask` with the operator bearer (the route is default-deny, including on loopback), then emit its SSE tokens as `o8:ask-stream-delta`/`done`. Simpler, reuses done work, but diverges from aqua's prompt/intent/screenshot bundle. **Recommend path 1 (Rust port)** for fidelity if screenshot/selection context matters; path 2 if a fast text-only Ask is acceptable.

## C.3 — Dock answer panel (React, inline styles)

`aqua NotchSurface.svelte:40-160` (answer/longform states) + `SymonApp.svelte:593-696,770-918` → **o8 `src/components/desktop/dictation/DockNotchSurface.tsx`** (the existing morphing dock at `/dictation-pill`).

**Surface (FORK B):** grow the existing `dock` window in-place. aqua sizes its `symon_assistant` window **once** to 440×360 and morphs the `.ndock` element (per-state native resize was the snap bug — `SymonApp.svelte:309`). o8's `dock` window (`dock_window.rs`: `DOCK_LABEL="dock"`, 520×120, level 25, transparent, nonactivating) is **wider (520 fits 440)** but **shorter (120 < 360)**. So: either (a) grow `DOCK_HEIGHT` to ~360 and top-anchor the idle/listening states, or (b) **one-time** resize the dock window to 360 tall on `o8:ask-open` and back to 120 on `o8:ask-collapse` (a single open/close resize is fine; **never** resize per morph-state). The `.ndock` element animates width/height via the spring `cubic-bezier(0.22,1,0.36,1)` (width/height 0.5s, radius 0.46s).

**Listeners** (port `SymonApp.svelte:770-918` to a React `useEffect` in the dock host) — **all de-Symonized**:
`o8:ask-open`→open · `o8:ask-collapse`→close · `o8:ask-voice-transcript`(string)→live partial · `o8:ask-voice-state`(bool)→listening · `o8:ask-send-now`(string)→`submitQuestion(payload)` · `o8:ask-error`(string) · `o8:ask-stream-delta {text}`→append to trailing assistant turn · `o8:ask-stream-done {final,tokens}`→snap · `o8:ask-stream-error {message}`(ignore `"cancelled"`). Rust must emit these exact names. Emit to the dock via the **same `app.emit_to(DOCK_LABEL, …)`** pattern proven for `o8:stt-event`.

**Thread engine** (`SymonApp.svelte:593-696` → React `useState threadTurns: ChatTurn[]`): on `o8:ask-send-now`, `turnId = randomUUID`, append `{role:'user',text}` + placeholder `{role:'assistant',text:'',turnId,cards:[]}`; `history = threadTurns.slice(0,-2).filter(non-empty).slice(-8)`; invoke the Rust `ask_question` command. Deltas mutate the trailing assistant turn; done snaps to authoritative. Constants verbatim: `IDLE_COLLAPSE_MS=45000`, `RESUME_WINDOW_MS=60000`, `MAX_HISTORY_TURNS=8`. notchMode priority: `fnActive → speaking → answer → listening → thinking → idle` (Fn always wins the dock).

**Panel structure** (`NotchSurface.svelte:40-160`, **inline styles + `var(--t-*)` only**): header bar (label "o8" / close X → cancel), thread (auto-scroll, per-turn "who" label = hurttlocker **9.5px / weight 260 / -0.4px**, user prompt, assistant Markdown + hover Copy→"Copied" flash `#7fe0b0` 1400ms), streaming cursor = pulsing dot on last assistant turn. Use `var(--t-panel)`/`var(--t-bg-card)` not `--symon-surface-bg`. **Render only `answer` + `longform` states in v1.**

## C.4 — Spoken answer — BLOCKED ON PHASE A

The `Speaking` state, the 3-bar transport meter (`voiceBars`), pause/stop, and `o8:ask-speaking`/`o8:ask-audio-level`/`o8:ask-speaking-paused` events all depend on a TTS engine. **In v1:** wire the listeners (they never fire). Once Phase A is in: the `submitQuestion` done handler calls `tts::playback::play_thread(answer, tts::load_config())` (the minimal decode is enough; the RMS-envelope variant from `symon_voice.rs:223-250` is only needed if the 3-bar meter wants live levels). De-Symonize event names: `symon-speaking`→`o8:ask-speaking`, `symon-audio-level`→`o8:ask-audio-level`, `symon-speaking-paused`→`o8:ask-speaking-paused`. Gate the whole Speaking surface behind a feature flag until A lands.

## C.5 — Phase C wiring summary (file:line)

| aqua source | o8 target | blocked on |
|---|---|---|
| `lib.rs:2462-2466` (constants) | `src-tauri/src/fn_hotkey.rs:~102` (`OPTION_FLAG`/`RIGHT_OPTION_KEYCODE` + atomics) | — |
| `lib.rs:2677-2739` (down edge) | `fn_hotkey.rs` FlagsChanged branch (`o8:ask-open`, share recognizer, "Ask takes the mic") | — |
| `lib.rs:2740-2830` (up edge) | `fn_hotkey.rs` (120ms brush guard → finalize → `o8:ask-send-now`) | — |
| `qa.rs:173-313` | `src-tauri/src/qa.rs::stream_ask_question` (drop Local/agent/local-route) | — |
| `qa.rs:585-640` | `src-tauri/src/qa.rs::build_context_bundle` (selection via Phase-B `grab_selection`; screenshot deferred) | — |
| `qa.rs:884-933` + `gemini_ask.rs:160-177` | `qa.rs::build_gemini_prompt` + `gemini_ask.rs DEFAULT_SYSTEM_PROMPT` ("Symon"→"o8") | — |
| `gemini_ask.rs:29-39,419-439,558-595` | `src-tauri/src/ai/gemini_ask.rs` (direct model, unary bridge, SSE gated) | — |
| `SymonApp.svelte:770-918,593-696` | `src/components/desktop/dictation/DockNotchSurface.tsx` (listeners + thread engine, de-Symonized) | — |
| `NotchSurface.svelte:40-160` | `DockNotchSurface.tsx` panel (answer/longform, inline styles, `var(--t-*)`) | — |
| `dock_window.rs` (520×120) | `src-tauri/src/dock_window.rs` (grow to ~360 tall or one-time resize on open) | — |
| `symon_voice::speak_answer` + Speaking state | spoken-answer call into `tts::playback::play_thread` | **PHASE A** |

**Phase C build steps:** extend `fn_hotkey.rs` (constants + down/up branches + brush guard) → create `qa.rs` + `ai/gemini_ask.rs` (Gemini direct, unary bridge) → register `ask_question`/`cancel_ask_stream` commands → grow dock window + port `DockNotchSurface` listeners/thread/panel → `cargo build` + `npx tsc --noEmit` → manual test: hold Right-Option, speak a question, release ≥120ms, see the answer snap into the dock panel. Spoken answer lights up automatically once Phase A is present.

---

## Cross-phase de-Symonize checklist

- Events: every `symon-*`/`ask-*` → `o8:ask-*` (Rust emit names + React listeners must match).
- Prompts: "Symon" → "o8"; "RECENT SYMON TRANSCRIPTS" → "RECENT TRANSCRIPTS".
- Keys: env-first → `~/.o8/dictation.json` via `config_string`, **un-gated**. No `symon_license_token`/`symon_api_url`/`bypass_proxy_in_dev`/`is_local`/`product_mode`.
- Providers: omit Edge (`msedge-tts`) and Native (`objc2-av-foundation`) — `say` is the only macOS-native path.
- Ask: Gemini direct only, never Anthropic. Drop the proxy `gemini-3-pro-preview` tag, use `gemini-3.1-pro-preview`.
- UI: inline styles only, `var(--t-*)` tokens, no CSS classes; per-turn "who" label = hurttlocker 9.5px/260/-0.4px.
- Errors: `AquaError::*` → `String`.

---

## Operator forks

### F-A-TTS-DEFAULT: TTS default provider when ELEVENLABS_API_KEY is absent (the non-founder / no-premium-key path).
- Google direct (needs GOOGLE_TTS_API_KEY) then macOS say fallback
- macOS say as the unconditional default (no cloud key needed)
- Keep the existing python3 edge_tts /api/tts path as the webview default and only use native TTS for system-wide say

**Rec:** load_config() defaults to Google; native_say::speak_with_say is the runtime fallback when no Google key resolves. So out of the box (no keys) every speak path lands on macOS `say` — zero-config working voice. Google lights up if GOOGLE_TTS_API_KEY is set; ElevenLabs only when its key is set AND the provider pref is 'elevenlabs'. The reports flag aqua's 'edge→Google remap' so Edge is never a real default; do not resurrect it.

### F-ELEVENLABS-GATE: How to founder/entitlement-gate ElevenLabs (it's a paid premium voice).
- Env-key presence is the de-facto gate (founder-only build: only the founder has ELEVENLABS_API_KEY in ~/.zshenv)
- Wire load_config()'s ElevenLabs selection through the M1-M6 entitlement layer (Pro/founder check) — productized gate
- No gate — anyone who sets the key gets the voice

**Rec:** For the founder's own daily-driver, ship the env-key-presence gate now (simplest, matches the un-gated stt/keys.rs pattern). When ElevenLabs becomes a Pro feature, add the entitlement check at the selection point in load_config() (return ElevenLabs only if entitlement passes) — keep Google/say UNCONDITIONAL and free, exactly like the M6 'keep free single-pass unconditional' rule. Do NOT replicate aqua's personal_mode/FounderPage ceremony.

### F-ELEVENLABS-VOICE-DEFAULT: Canonical default ElevenLabs voice id (aqua's Rust fallback JBFqnCBsd6RMkjVDRZzb disagrees with its UI default I33geqnOHQGKDPUMUspQ).
- JBFqnCBsd6RMkjVDRZzb (the Rust synthesize() fallback)
- I33geqnOHQGKDPUMUspQ (the aqua FounderPage UI default)

**Rec:** JBFqnCBsd6RMkjVDRZzb — it's what synthesize() actually falls back to, so the Rust path is self-consistent. Overridable via elevenlabs_voice_id pref / ELEVENLABS_VOICE_ID env.

### F-ASK-ENGINE-LOCATION: Ask orchestrator: port aqua's Rust qa.rs+gemini_ask.rs, or reuse o8's existing /api/cortex/ask SSE backend?
- Rust port (qa.rs + ai/gemini_ask.rs, Gemini direct, faithful prompt/intent/screenshot bundle, keeps the event contract in one place)
- Reuse /api/cortex/ask — the UP-edge thread POSTs the polished transcript (loopback passes the gate) and re-emits its SSE tokens as o8:ask-* events

**Rec:** Rust port (path 1) if the screenshot + selection + frontmost context bundle matters (that's aqua's whole Ask value). It's pure reqwest (no !Send thread needed) and the hotkey already lives in Rust. Reuse /api/cortex/ask (path 2) only if a text-only, context-light Ask is acceptable for v1 — it's less work but diverges from aqua's prompt/intent design and routes Class B through Claude Sonnet (check billing — the ask pipeline composer may use Anthropic, which violates the Ask-never-Anthropic rule; the Rust Gemini-direct port does not).

### F-ASK-PANEL-SURFACE: Where the Ask answer renders.
- Grow the existing dock window (DockNotchSurface) in-place to 440x360 (aqua's window-sized-once + element-morphs pattern)
- Stand up a new dedicated assistant window

**Rec:** Grow the dock in-place. o8's dock is already 520 wide (440 fits), transparent, always-on-top, nonactivating — aqua proved per-state native resize is the snap bug, so do a SINGLE open/close resize (120→~360 on o8:ask-open, back on collapse) and let the .ndock element morph. A new window duplicates the level-25/transparent/nonactivating recipe for no gain.

### F-SAY-GRAMMAR: Ship the spoken 'say <text>' voice grammar, and which match shape?
- Yes — starts_with('say ') strips the verb and speaks the remainder
- Yes — ends_with (like the existing remove/cancel commands)
- No — speak-selection (Ctrl+Shift+S) is enough; skip the spoken grammar

**Rec:** Yes, starts_with('say '). A read-aloud directive LEADS the utterance ('say hello world'), unlike the trailing cancel/remove commands. It's a net-new CommandResult::Speak(String) variant (Symon has no such grammar) wired into run_finalize's third match arm. Cheap, additive, and the operator explicitly asked for it. Place the branch BEFORE cancel/remove so 'say cancel' speaks rather than cancels.

### F-RODIO-VS-SAY: If Phase A slips, can Phase B ship without rodio?
- Yes — route Ctrl+Shift+S and 'say <text>' straight to native_say::speak_with_say (no rodio, no cloud, no new crate)
- No — block B until A's rodio playback lands

**Rec:** Yes — native_say::speak_with_say is fully self-contained (`say -r <175*speed> <text>`, no deps) and satisfies the operator's literal 'say' request. Ship B on the `say` path as a degraded-but-working slice if rodio/cloud TTS isn't ready; swap to play_thread (ElevenLabs/Google) once Phase A lands. This is the lowest-risk first user-visible win.

### F-GRAB-SELECTION-FALLBACK: grab_selection strategy.
- AX-only (read_selected_text_via_accessibility, no clipboard touch)
- AX-then-Cmd+C fallback (180ms/10ms poll + save/restore clipboard)

**Rec:** AX-then-Cmd+C. All six backing helpers already exist in o8 paste.rs (dead_code), the save/restore dance is already correct, and AX-only returns None for canvas/Electron apps with opaque AX trees — the Cmd+C fallback covers them. Copy aqua's 180ms deadline / 10ms poll / accept-rule verbatim.

## Phase A build plan

1. A.0 — Add `rodio = "0.19"` to src-tauri/Cargo.toml (match aqua's pin; 0.20+ broke OutputStream/Sink APIs). Do NOT add msedge-tts or objc2-av-foundation. `cargo build` to confirm rodio resolves against the existing reqwest/base64 graph.
1. A.1 — Extend src-tauri/src/stt/keys.rs: add get_elevenlabs_key() (env ELEVENLABS_API_KEY → config_string('elevenlabs_api_key')) and get_google_tts_key() (env GOOGLE_TTS_API_KEY → config_string('google_tts_api_key')), copying the get_gemini_key() shape verbatim. UN-GATED, no license/proxy/product-mode.
1. A.2 — Create src-tauri/src/tts/elevenlabs.rs (port aqua tts/elevenlabs.rs:6-173 near-verbatim): ENDPOINT_BASE, DEFAULT_VOICE=JBFqnCBsd6RMkjVDRZzb, DEFAULT_MODEL=eleven_multilingual_v2, DEFAULT_OUTPUT_FORMAT=mp3_44100_128, the snake_case (NO rename) SynthesizeRequest/VoiceSettings, xi-api-key+Accept:audio/mpeg headers, all defaults (stability 0.45/similarity 0.8/style 0.0/speaker_boost true), key via stt::keys::get_elevenlabs_key(), DIRECT to api.elevenlabs.io, AquaError→String. Speed is IGNORED here.
1. A.3 — Create src-tauri/src/tts/google.rs (port aqua tts/google.rs:6-171, DIRECT branch only): ENDPOINT, camelCase serde structs, language_code split-take-2, Chirp3 pitch=0 guard, audioEncoding MP3 + speakingRate + pitch, key via stt::keys::get_google_tts_key(), url ?key={key}, base64 STANDARD decode of audioContent. DELETE the is_local guard, the symon_license_token/proxy branch, and the 401/403 License errors.
1. A.4 — Create src-tauri/src/tts/native_say.rs (port aqua reading.rs:543-584 verbatim): speak_with_say(text, speed) = `say -r <(175*speed) as u32> <text>`, returns bool.
1. A.5 — Create src-tauri/src/tts/playback.rs::play_thread(text, config) using the MANDATORY !Send pattern: std::thread::spawn → tokio Builder::new_current_thread().enable_all() INSIDE the thread → block_on(tts::speak) → OutputStream::try_default + Sink::try_new + Decoder::new(Cursor) + sink.append + sink.sleep_until_end, ALL on that OS thread. On tts::speak Err → native_say::speak_with_say (provider-fails → say-the-whole-text-once rule).
1. A.6 — Create src-tauri/src/tts/mod.rs (port aqua tts/mod.rs:8-88, collapsed): enum TtsProvider{ElevenLabs,Google}, TtsConfig{provider,voice_id,speed,pitch} default Google/en-US-Neural2-J/1.0/0.0, load_config() (provider = config_string('tts_provider') → ElevenLabs only if 'elevenlabs' AND get_elevenlabs_key().is_some() else Google; voice_id/speed reads), speak() dispatch. Drop the personal_mode override and the Edge/Native variants.
1. A.7 — Wire into src-tauri/src/lib.rs: add `mod tts;` at line 10 (next to `mod stt;`); register #[tauri::command] tts_speak(text) (+ optional tts_stop) in generate_handler![] at ~line 2863 — the command body calls tts::playback::play_thread(text, tts::load_config()).
1. A.8 — `cargo build` (confirm the !Send thread compiles — it will NOT compile via async_runtime::spawn) + `npx tsc --noEmit`. Smoke-test from the webview: invoke('tts_speak', {text:'hello from o8'}) — (a) with ELEVENLABS_API_KEY set → ElevenLabs voice, (b) with only GOOGLE_TTS_API_KEY → Google, (c) with no keys → macOS `say` fallback. Confirm all three audibly play with no focused webview dependency. This is the first shippable slice; Phases B and C depend on it.
