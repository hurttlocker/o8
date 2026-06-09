# o8 — Symon Settings Ingest (Voice Settings) — Phased Port Spec

> Parity-research workflow `wi6q33t8u` (4 readers over aqua preferences.rs + settings pages + o8 gap). Part of #1205. Phase 1 = persistence bridge + connect-up (backend, highest value); Phase 2 = UI.

# o8 Voice Settings — Symon-settings ingest spec (build-ready)

Goal: land voice prefs into `~/.o8/dictation.json` (the ONLY file the Rust STT/TTS engine reads, via `src-tauri/src/stt/keys.rs::config_string`), fix the process-lifetime cache so a settings write takes effect without relaunch, then connect the already-ported polish path to those prefs, then build the UI. **Phase 1 (bridge + connect-up) is pure backend and is the highest-value work — it makes prefs that are ALREADY in the engine real.** Phase 2 is the UI.

De-Symonize throughout: drop `personal_`/`symon_`/`founder_` prefixes. o8 already chose the plain key names — `elevenlabs_voice_id`, `tts_provider`, `tts_voice_id`, `reading_speed`, `elevenlabs_*` tuning set — and the Rust read sites use those exact names. Keep the ENGINE key names verbatim; rebrand only user-facing copy ("Symon voice" → "o8 voice", "Symon Male/Female" → plain voice labels).

---

## PHASE 1 — THE PERSISTENCE BRIDGE (backend, do first)

### 1.1 New Rust module: `src-tauri/src/stt/config.rs` (read-modify-write `dictation.json`)

A small module that owns the write path AND the typed readers, importing `o8_data_dir()` / `config_path()` from `keys.rs` so the dictation.json path stays single-source. Mirrors aqua's `preferences.rs::update_map` read-modify-write-whole-object discipline (`/Users/marquisehurtt/aqua-color/src-tauri/src/preferences.rs:159-173`) so writing one key never drops the others.

```rust
// src-tauri/src/stt/config.rs  (NEW)
use serde_json::{Map, Value};

// Read the whole dictation.json as an object (empty on missing/invalid).
fn read_object() -> Map<String, Value> {
    std::fs::read_to_string(crate::stt::keys::config_path())  // make config_path() pub(crate)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

// Tauri command: read one key, "" on absent (mirrors aqua load_preference contract,
// /Users/marquisehurtt/aqua-color/src-tauri/src/commands.rs:1793-1794).
#[tauri::command]
pub fn get_voice_pref(key: String) -> String {
    crate::stt::keys::config_string(&key).unwrap_or_default()
}

// Read ALL prefs at once (one round-trip for the settings panel mount).
#[tauri::command]
pub fn get_all_voice_prefs() -> Value { Value::Object(read_object()) }

// Tauri command: parse value as JSON-primitive first else store as String
// (mirrors aqua save_raw_value, /Users/marquisehurtt/aqua-color/src-tauri/src/preferences.rs:95-101),
// read-modify-write the whole object, then invalidate the cache.
#[tauri::command]
pub fn set_voice_pref(key: String, value: String) -> Result<(), String> {
    let mut obj = read_object();
    let v = serde_json::from_str::<Value>(&value).unwrap_or(Value::String(value));
    obj.insert(key, v);
    write_object(obj)
}

// Batch write (settings panel saves several keys without N file rewrites).
#[tauri::command]
pub fn set_voice_prefs(patch: Map<String, Value>) -> Result<(), String> {
    let mut obj = read_object();
    for (k, v) in patch { obj.insert(k, v); }
    write_object(obj)
}

fn write_object(obj: Map<String, Value>) -> Result<(), String> {
    let path = crate::stt::keys::config_path();
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    let body = serde_json::to_string_pretty(&Value::Object(obj)).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| e.to_string())?;
    crate::stt::keys::invalidate_config();   // see 1.2
    Ok(())
}
```

Note on values: o8 voice prefs are mostly strings (API keys, voice ids, locale) plus a few that must stay JSON-structured — `dictionary` (string[]), `replacements` ({trigger,replacement}[]). The settings UI sends those two as `JSON.stringify(...)` and `set_voice_pref` will `from_str`-parse them back into real arrays. Booleans (`whisper_stt_enabled`) are sent as the literal `"true"`/`"false"` — `from_str` turns them into JSON bools, and the Rust read side already treats `whisper_stt_enabled` as enabled unless it equals the string `"false"`/`"0"` (`src-tauri/src/stt/whisper.rs` `enabled()`), so store them as the bool — but to be safe, store `whisper_stt_enabled` as the **string** `"false"`/`"true"` to match the exact `config_string` match arms the engine uses. (Engine reads it via `config_string`, i.e. as a string; a JSON bool would read as `None`.) **Decision: send/store `whisper_stt_enabled` as a quoted string, not a JSON bool.**

### 1.2 Fix the OnceLock cache in `keys.rs` (the relaunch problem)

`src-tauri/src/stt/keys.rs:40-48` — `config()` is a process-lifetime `OnceLock<serde_json::Value>`, read ONCE. A settings write to dictation.json is invisible until app relaunch. `OnceLock` cannot be reset in place. **Replace it with a mtime-keyed `Mutex` cache (the exact pattern aqua uses in `preferences.rs::load_map`, `/Users/marquisehurtt/aqua-color/src-tauri/src/preferences.rs:67-77`)** so `config_string` re-reads when the file changes. File is single-digit KB, so the mtime stat + occasional re-parse is negligible (aqua's own rationale, `preferences.rs:7-12`).

Replace lines 37-58 of `keys.rs` with:

```rust
use std::sync::Mutex;
use std::time::SystemTime;

// pub(crate) so config.rs can resolve the same path.
pub(crate) fn config_path() -> PathBuf { o8_data_dir().join("dictation.json") }

static CONFIG_CACHE: OnceLock<Mutex<(Option<SystemTime>, serde_json::Value)>> = OnceLock::new();

fn current_mtime() -> Option<SystemTime> {
    std::fs::metadata(config_path()).and_then(|m| m.modified()).ok()
}

fn read_value_from_disk() -> serde_json::Value {
    std::fs::read_to_string(config_path())
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .unwrap_or(serde_json::Value::Null)
}

/// `~/.o8/dictation.json` as a JSON value, re-read when the file's mtime changes.
/// Returns an owned clone (the file is tiny) so callers don't hold the lock.
pub fn config() -> serde_json::Value {
    let cell = CONFIG_CACHE.get_or_init(|| Mutex::new((None, serde_json::Value::Null)));
    let mut guard = cell.lock().unwrap();
    let mtime = current_mtime();
    if guard.0 != mtime {
        guard.1 = read_value_from_disk();
        guard.0 = mtime;
    }
    guard.1.clone()
}

/// Force the next config() to re-read (called by config.rs after a write so the
/// change is live even within the same mtime-second).
pub fn invalidate_config() {
    if let Some(cell) = CONFIG_CACHE.get() {
        if let Ok(mut g) = cell.lock() { g.0 = None; }
    }
}

pub fn config_string(key: &str) -> Option<String> {
    config().get(key).and_then(|v| v.as_str()).map(str::trim)
        .filter(|s| !s.is_empty()).map(ToOwned::to_owned)
}
```

`config()` now returns an owned `Value` (was `&'static`). Every existing caller uses `config_string(...)` (in `keys.rs:63-100`, `tts/mod.rs:36-52`, `tts/elevenlabs.rs:62-123`, `whisper.rs`) — none binds `config()` to a reference, so the signature change is self-contained. The connect-up code in 1.3 calls the new owned `config()` directly for the array prefs.

### 1.3 CONNECT-UP — make the empty polish prefs real (the highest-value edit)

The polish prompt-builder ALREADY consumes dictionary / instructions / replacements (`src-tauri/src/stt/polish.rs:1062-1083`) and the deterministic replacement applier ALREADY runs on every return (`polish.rs:438,456,481` → `stt/mod.rs:48`). They receive nothing because `run_finalize` hardcodes empty collections.

**`src-tauri/src/lib.rs:2507-2517`** — replace the three empty fields:

```rust
            let ctx = crate::stt::polish::PolishContext {
                transcript: &raw_text,
                audio_wav: audio_wav.as_deref(),
                frontmost_app: None,
                window_title: window_ctx.window_title,
                selected_text: window_ctx.selected_text,
                ax_excerpt: window_ctx.ax_excerpt,
                dictionary: crate::stt::keys::config_string_array("dictionary"),
                instructions: crate::stt::keys::config_string("instructions").unwrap_or_default(),
                replacements: crate::stt::keys::config_json::<Vec<crate::stt::commands::ReplacementRule>>("replacements")
                    .unwrap_or_default(),
            };
```

Add the two typed readers to `keys.rs` (off the owned `config()` from 1.2):

```rust
pub fn config_string_array(key: &str) -> Vec<String> {
    config().get(key).and_then(|v| v.as_array()).map(|arr| {
        arr.iter().filter_map(|x| x.as_str()).map(str::trim)
            .filter(|s| !s.is_empty()).map(ToOwned::to_owned).collect()
    }).unwrap_or_default()
}

pub fn config_json<T: serde::de::DeserializeOwned>(key: &str) -> Option<T> {
    config().get(key).cloned().and_then(|v| serde_json::from_value(v).ok())
}
```

This single edit lights up the entire custom-dictionary / instructions / phrase-replacement surface that was dead at the read layer. `polish.rs:1062-1083` needs NO change. `PolishContext` (`polish.rs:394-414`) already has the fields.

**`output_tone` is a DOUBLE gap** — no read site AND no prompt consumer. Connecting it is two edits:
1. Read it in `run_finalize` (or pass through PolishContext — add a `tone` field) via `config_string("output_tone")`.
2. Add a tone clause to `polish.rs::build_prompt` (around the dictionary/instructions block, `polish.rs:1062-1083`) mapping `raw`/`clean`/`formal`/`casual` to a prompt instruction. **Make `auto` (and absent) a no-op** so the default polish behavior does not change. This is optional for Phase 1 (lower value than dictionary/replacements which are zero-edit-to-prompt). Recommend shipping dictionary/instructions/replacements in Phase 1 and folding `output_tone` in alongside the Tone UI control in Phase 2.

### 1.4 Already-connected prefs (NO Rust change — just need the write surface)

These read sites already drive behavior; Phase 1's only job for them is that the UI writes the same keys:
- `tts_provider`, `tts_voice_id`, `reading_speed` → `tts/mod.rs:36-52`
- `elevenlabs_voice_id` + the full tuning set (`elevenlabs_model_id`, `elevenlabs_output_format`, `elevenlabs_stability`, `elevenlabs_similarity_boost`, `elevenlabs_style`, `elevenlabs_use_speaker_boost`) → `tts/elevenlabs.rs:62-123`
- `whisper_stt_enabled`, `dictation_locale` (Whisper language hint only) → `whisper.rs`
- `gemini_api_key`, `openrouter_api_key`, `elevenlabs_api_key`, `google_tts_api_key` → `keys.rs:63-100` (env-first, file fallback)

### 1.5 Half-wired / unwired prefs (flag, defer)

- `dictation_locale` → native Apple recognizer: `o8_stt_locale` command exists (`lib.rs:2678`) + `LiveRecognizer::set_locale`, but the only JS caller `useNativeDictation.setLocale` has zero callers — so the pref only hits Whisper's hint, never the live recognizer. **Defer**: optionally have the Locale UI control also `invoke('o8_stt_locale', { locale })` on change for full coverage.
- `dictation_microphone_uid` → no read site; `set_input_device` exists but nothing calls it. **Defer** (needs a read-at-start wire + a mic-list Tauri command pair).
- `dictation_release_tail_ms` → no plumbing at all in `fn_hotkey.rs`; Swift helper support unverified. **Skip** for v1.

### 1.6 Register the commands

`src-tauri/src/lib.rs:2874` `generate_handler![ ... ]` — add `stt::config::get_voice_pref`, `stt::config::get_all_voice_prefs`, `stt::config::set_voice_pref`, `stt::config::set_voice_prefs`. Add `pub mod config;` to `stt/mod.rs:23-25` (next to `pub mod keys;`).

### 1.7 Bridge wrappers

`src/lib/tauri/bridge.ts` (after line 246, the voice block) — add typed wrappers over the new commands. Do NOT route these through `storeGet`/`storeSet` (`bridge.ts:147-172`) — that writes `settings.json`, which the engine never reads.

```ts
export async function dictationPrefGet(key: string): Promise<string> {
  return (await invoke<string>('get_voice_pref', { key })) ?? '';
}
export async function dictationPrefsGetAll(): Promise<Record<string, unknown>> {
  return (await invoke<Record<string, unknown>>('get_all_voice_prefs')) ?? {};
}
export async function dictationPrefSet(key: string, value: string): Promise<void> {
  await invoke('set_voice_pref', { key, value });
}
export async function dictationPrefsSet(patch: Record<string, unknown>): Promise<void> {
  await invoke('set_voice_prefs', { patch });
}
```

---

## PHASE 2 — THE UI (extend the existing VoiceTab)

No new SettingsTab id, no new TabButton, no SettingsPage edit. `'voice'` already exists in `SettingsTab` (`shared.tsx:58`), is wired at `SettingsPage.tsx:49,354,428`, and renders `VoiceTab` (`VoiceTab.tsx:173-386`). Slot the new prefs in as numbered `<section>` blocks AFTER the existing `01 PERMISSIONS` / `02 BACKGROUND PRESENCE` sections, continuing the numbering.

Control idiom (all from `shared.tsx`, inline styles only, `var(--t-*)`, raw-SVG icons, no CSS classes, no native `<select>`):
- Booleans → `SettingsToggleButton` (`shared.tsx:458`) inside the in-file `ToggleRow` helper already in `VoiceTab.tsx`.
- Provider / voice / locale / tone pickers → radio-card stacks, copying `DictationInputModeToggle` exactly (`AppearanceTab.tsx:325-402`): button-card with a dot indicator + mono-uppercase label + caption, active via `RAMS_CONTROL_ACTIVE_BG/BORDER` + `RAMS_ACCENT`. NOT native `<select>`/segmented.
- API keys → `<input type="password">` with `borderBottom: 1px solid RAMS_HAIRLINE_SOFT`, accent on focus, copying `APIKeysTab.tsx:320-350`.
- Reading speed → either a thin range control or a 5-button radio-card row (0.5/0.75/1.0/1.5/2.0) to stay on the no-native-control rule; clamp 0.5–2.0.
- Actions (Preview voice, Save instructions) → `RamsButton` (`shared.tsx:519`).
- Section headers → `SectionLabel number="0N"` (`shared.tsx:437`), `HairlineRule` between rows.

State model: on mount, one `dictationPrefsGetAll()` round-trip → local component state. Each control writes through `dictationPrefSet(key, value)` (booleans → `String(bool)`, arrays/objects → `JSON.stringify(...)`). Instructions uses an explicit Save button (NOT debounced) matching aqua (`InstructionsPage.svelte`), shows "Saved" for 2s. Everything else autosaves on change. Because Phase 1 mtime-cache + `invalidate_config()` is in place, writes take effect on the next dictation with no relaunch.

### Section layout (continuing VoiceTab numbering)

**03 — INPUT** (aqua `SettingsPage.svelte:674-772`)
- High-accuracy dictation → toggle → `whisper_stt_enabled` (default on; store `"true"`/`"false"` string). De-Symonize copy.
- Dictation language → radio-card picker → `dictation_locale` (default `en-US`); options en-US/en-GB/en-AU/es-ES/fr-FR/de-DE/it-IT/pt-BR/ja-JP (aqua list).
- Tone → radio-card picker → `output_tone` (default `auto`; auto/raw/clean/formal/casual). Ships with the Phase-1.3 `output_tone` connect-up (read + `build_prompt` clause). If that's deferred, render the control read-disabled until the backend branch lands.
- (Microphone select → `dictation_microphone_uid` — DEFER, needs mic-list Tauri commands; omit from v1.)

**04 — DICTIONARY** (aqua `DictionaryPage.svelte:7-86`)
- List-editor: text input + add button (Enter adds), dedupe, chips with trash-remove. Empty state "Add words the AI should know". Persists full array → `dictionary` via `dictationPrefSet('dictionary', JSON.stringify(words))`. Chips = pill rows, inline styles.

**05 — SNIPPETS** (aqua `ReplacementsPage.svelte:8-118`; note: tab/pref is `replacements`, LABEL is "Snippets")
- Two-field list-editor (trigger → replacement), add disabled until both filled, rows with mono trigger + arrow + replacement + trash. Filter incomplete entries on load. Persists → `replacements` as `JSON.stringify([{trigger,replacement}])`. De-Symonize empty-state copy. **Keep pref key `replacements`** (Rust reads it); show "Snippets" in the UI.

**06 — INSTRUCTIONS** (aqua `InstructionsPage.svelte:6-68`)
- 8-row resizable textarea + explicit Save (RamsButton) → `instructions` (raw string, NOT JSON-wrapped). "Saved" check 2s. Static examples block — port verbatim (already engine-neutral copy).

**07 — VOICE OUTPUT** (aqua `SettingsPage.svelte:1202-1298`)
- o8 voice (Ask read-aloud) → toggle. (o8 has no `symon_voice_enabled` read site; this is presentation/gating only — wire to a plain key e.g. `voice_output_enabled` if a gate is wanted, else drive purely off provider+key presence.)
- TTS provider → radio-card → `tts_provider` (`google` | `elevenlabs`). ElevenLabs only effective when key present (engine gate, `tts/mod.rs:37`).
- Read-aloud voice → for Google: `tts_voice_id` (default `en-US-Neural2-J` per `tts/mod.rs:47`); for ElevenLabs: `elevenlabs_voice_id` (default `JBFqnCBsd6RMkjVDRZzb` per `elevenlabs.rs:13`).
- Reading speed → `reading_speed` (default 1.0, clamp 0.5–2.0).
- Preview → RamsButton → `tts_speak` command (`lib.rs:2687`) with a sample string. (Wire `tts_speak` into bridge.ts if not already.)
- De-Symonize all voice labels.

**08 — API KEYS (voice engine)** (de-Symonized — these are plaintext keys the engine reads from dictation.json, distinct from o8's encrypted `api_keys` DB / `APIKeysTab`)
- Four password inputs → `gemini_api_key` (polish), `openrouter_api_key` (Whisper), `elevenlabs_api_key` (premium TTS gate), `google_tts_api_key` (Google TTS). Show an "using environment key" read-only note when the corresponding env var is set, since env wins over the file (`keys.rs:63-100`). Decision: file fields write to dictation.json directly (matches the engine contract — plaintext) rather than reusing the encrypted store.

**09 — ELEVENLABS (advanced)** — gate behind a founder/advanced flag or collapse by default (aqua `FounderPage.svelte`, de-`personal_`-ized)
- Voice ID input → `elevenlabs_voice_id`; Model → `elevenlabs_model_id`; three sliders/cards Stability/Similarity/Style → `elevenlabs_stability` (0.45) / `elevenlabs_similarity_boost` (0.8) / `elevenlabs_style` (0.0); Speaker boost toggle → `elevenlabs_use_speaker_boost` (true); output format → `elevenlabs_output_format`. All already read by `elevenlabs.rs:62-123`. Drop aqua's `personal_*` prefix and the `founder_elevenlabs_voice_library` preset store for v1 (single active voice is enough). Strip all "Founder Edition" branding.

### Ports to SKIP / fold (de-Symonize)
- **Account / license** (aqua `AccountPage.svelte`, `symon_license_token`, Stripe checkout, api.symonsays.run) — DO NOT port. o8 has its own native entitlement system (license-server, `license.ts`, Clerk, M1–M5) → maps to the existing Plan & Billing tab.
- **Report Issue** (aqua `ReportIssuePage.svelte`) — o8 already has `ReportIssueSection.tsx`; fold in, no port.
- **Stats / History** (aqua `StatsPage.svelte` / `HistoryPage.svelte`) — read-only, no dictation.json keys, need an o8 backend (transcripts store). Optional; the gamified "Harbor" level system is Symon-flavored — drop or re-theme. Defer.
- **Agent Beta** (aqua `AgentPage.svelte`) — founder-only, explicitly not V1. Skip.
- **Pill / notch / long-form HUD prefs** (aqua `SettingsPage.svelte:774-932` Appearance + `LongFormTuner.svelte`) — only relevant if the notch dock surface is ported. Out of scope here.
- **aqua mount-time force-writes / migrations** (`SettingsPage.svelte:163-350`: pill_style, local_agent_enabled, symon_product_mode, edge→google, polish_provider) — Symon-legacy; do NOT replicate.

---

## Canonical pref table (key / type / default / wires-to)

| Canonical o8 key | aqua key (de-Symonized) | type | default | Rust read site (file:line) | Phase |
|---|---|---|---|---|---|
| `dictionary` | `dictionary` | JSON string[] | `[]` | `lib.rs:2514` (wire) → `polish.rs:1062` | 1 |
| `instructions` | `instructions` | raw string | `""` | `lib.rs:2515` (wire) → `polish.rs:1070` | 1 |
| `replacements` | `replacements` | JSON {trigger,replacement}[] | `[]` | `lib.rs:2516` (wire) → `polish.rs:1074`, applier `stt/mod.rs:48` | 1 |
| `output_tone` | `output_tone` | string | `auto` | NONE yet — needs `run_finalize` read + new `polish.rs:build_prompt` clause | 1/2 |
| `whisper_stt_enabled` | `whisper_stt_enabled` | string bool `"true"`/`"false"` | `"true"` | `whisper.rs` `enabled()` | 1 (read exists) |
| `dictation_locale` | `dictation_locale` | string | `en-US` | `whisper.rs` `language_hint()` (Whisper only) | 1 (read exists; Apple recognizer deferred) |
| `tts_provider` | `tts_provider` | string | `google` | `tts/mod.rs:36` | 1 (read exists) |
| `tts_voice_id` | `tts_voice_id` | string | `en-US-Neural2-J` | `tts/mod.rs:46` | 1 (read exists) |
| `reading_speed` | `reading_speed` | string num | `1.0` | `tts/mod.rs:50` | 1 (read exists) |
| `elevenlabs_voice_id` | `personal_elevenlabs_voice_id` | string | `JBFqnCBsd6RMkjVDRZzb` | `elevenlabs.rs:62` | 1 (read exists) |
| `elevenlabs_model_id` | `personal_elevenlabs_model_id` | string | `eleven_multilingual_v2` | `elevenlabs.rs:67` | 1 (read exists) |
| `elevenlabs_output_format` | `personal_elevenlabs_output_format` | string | `mp3_44100_128` | `elevenlabs.rs:71` | 1 (read exists) |
| `elevenlabs_stability` | `personal_elevenlabs_stability` | string f32 | `0.45` | `elevenlabs.rs:115` | 1 (read exists) |
| `elevenlabs_similarity_boost` | `personal_elevenlabs_similarity_boost` | string f32 | `0.8` | `elevenlabs.rs:116` | 1 (read exists) |
| `elevenlabs_style` | `personal_elevenlabs_style` | string f32 | `0.0` | `elevenlabs.rs:121` | 1 (read exists) |
| `elevenlabs_use_speaker_boost` | `personal_elevenlabs_use_speaker_boost` | string bool | `true` | `elevenlabs.rs:122` | 1 (read exists) |
| `gemini_api_key` | `gemini_api_key` | string | env-first | `keys.rs:63` | 1 (read exists) |
| `openrouter_api_key` | `openrouter_api_key` | string | env-first | `keys.rs:73` | 1 (read exists) |
| `elevenlabs_api_key` | `elevenlabs_api_key` | string | env-first | `keys.rs:84` | 1 (read exists) |
| `google_tts_api_key` | `google_tts_api_key` | string | env-first | `keys.rs:94` | 1 (read exists) |
| `dictation_microphone_uid` | `dictation_microphone_uid` | string | `default` | NONE — `set_input_device` uncalled | deferred |
| `dictation_release_tail_ms` | `dictation_release_tail_ms` | string u64 | `750` | NONE — no plumbing | skip v1 |

Most engine prefs ALREADY have live read sites — Phase 1's value is the bridge + cache fix making the UI writes actually reach them, plus the one `run_finalize` connect-up that revives dictionary/instructions/replacements.

---

## Operator forks

### source-of-truth: Single source of truth for voice prefs: dictation.json directly, or o8's existing store + sync?
- Write voice prefs straight into ~/.o8/dictation.json via new Tauri commands (matches what the Rust engine actually reads)
- Route through o8's Tauri plugin-store settings.json / encrypted api_keys DB and have Rust read those

**Rec:** dictation.json directly. The engine reads ONLY ~/.o8/dictation.json via stt/keys.rs::config_string — settings.json (bridge.ts storeGet/Set, lines 147-172) and the encrypted api_keys DB are invisible to it. Adding a sync layer is pure overhead. New get_voice_pref/set_voice_pref commands that read-modify-write the whole dictation.json object (aqua update_map pattern) are the minimal, correct path.

### cache-fix: OnceLock cache in keys.rs — live refresh or accept relaunch-to-apply?
- Replace the process-lifetime OnceLock with aqua's mtime-keyed Mutex cache + an invalidate_config() hook called after every write (live updates, ~15 ported lines)
- Keep OnceLock and tell the user to relaunch after changing voice settings

**Rec:** Replace with the mtime-keyed Mutex cache. The whole point of the port is a settings UI; 'type an API key, STT still says no key until restart' is a broken UX. The file is single-digit KB so the mtime stat + occasional re-parse is negligible — this is exactly aqua's own rationale (preferences.rs:7-12). config() changes from returning &'static to an owned clone, but every caller goes through config_string, so the signature change is self-contained.

### connect-up-scope: Which connect-up edits land in Phase 1?
- dictionary + instructions + replacements only (zero prompt-builder change — they light up the moment run_finalize passes real values)
- Also output_tone (needs BOTH a run_finalize read AND a new tone clause in polish.rs build_prompt)

**Rec:** Ship dictionary/instructions/replacements in Phase 1 (highest value, lowest risk — build_prompt at polish.rs:1062-1083 and the applier at stt/mod.rs:48 are already live, only run_finalize lib.rs:2507-2517 is empty). Fold output_tone in alongside the Tone UI control, and make 'auto'/absent a strict no-op so default polish output never changes.

### prefs-v1: Which prefs does the v1 UI expose?
- Lean: dictionary, snippets, instructions, language, tone, TTS provider/voice/speed, 4 API keys, whisper toggle
- Add the full ElevenLabs tuning studio (model, 3 sliders, speaker-boost, output format)
- Add mic select + release-tail + Apple-recognizer locale (currently unwired)

**Rec:** Lean set + ElevenLabs studio behind an advanced/collapsed section. Every key in the lean set + the elevenlabs_* tuning set ALREADY has a live Rust read site, so exposing them is pure UI with no extra backend. Exclude dictation_microphone_uid (no read site, needs a mic-list command pair) and dictation_release_tail_ms (no plumbing at all, Swift-helper support unverified) from v1 — they'd be cosmetic controls.

### founder-gating: Founder / ElevenLabs gating in the UI?
- Drop all founder/personal_ gating — expose the plain elevenlabs_* keys to everyone behind an 'Advanced' disclosure
- Reproduce aqua's founder_edition_enabled flag + Pro pills + voice-library preset store

**Rec:** Drop founder gating and the personal_ prefix entirely. o8 already chose the plain key names (elevenlabs_voice_id etc.) and its read side is UN-GATED — the ElevenLabs API key's presence IS the de-facto premium gate (keys.rs:84 comment). Expose a single active ElevenLabs voice under an Advanced disclosure; skip the founder_elevenlabs_voice_library preset store for v1. Strip all 'Symon Founder Edition' branding.

### history-stats-account: Port History / Stats / Account?
- Skip all three for v1
- Port Stats/History (needs a new o8 transcripts backend)
- Fold Account into existing Plan & Billing

**Rec:** Skip History/Stats for v1 (no dictation.json keys, need a transcripts store o8 doesn't have, and the gamified 'Harbor' level system is Symon-flavored). Do NOT port aqua's Account/license page at all — o8 has its own native entitlement system (license-server, license.ts, Clerk, M1-M5); it maps to the existing Plan & Billing tab. Report Issue folds into the existing ReportIssueSection.tsx.

## Phase 1 build plan

1. Step 1 — keys.rs cache fix: replace the OnceLock<Value> in src-tauri/src/stt/keys.rs:40-48 with a mtime-keyed Mutex cache (port aqua preferences.rs:67-77), make config() return an owned Value, make config_path() pub(crate), add invalidate_config(). Verify: cargo check — every existing caller goes through config_string so it compiles unchanged.
1. Step 2 — typed readers: add config_string_array(key)->Vec<String> and config_json::<T>(key)->Option<T> to keys.rs, both off the owned config(). Verify: cargo check.
1. Step 3 — connect-up (THE high-value edit): in src-tauri/src/lib.rs:2514-2516 replace dictionary: Vec::new()/instructions: String::new()/replacements: Vec::new() with config_string_array("dictionary") / config_string("instructions").unwrap_or_default() / config_json::<Vec<ReplacementRule>>("replacements").unwrap_or_default(). No change to polish.rs:1062-1083 (already consumes them) or stt/mod.rs:48 (applier already runs). Verify: drop a dictation.json with a dictionary + replacement, dictate, confirm the words spell correctly + the replacement fires.
1. Step 4 — new module src-tauri/src/stt/config.rs: get_voice_pref / get_all_voice_prefs / set_voice_pref / set_voice_prefs Tauri commands, read-modify-write the whole dictation.json object (aqua update_map pattern, preferences.rs:159-173), '' on absent, JSON-primitive-or-string parse on write, calls keys::invalidate_config() after write. Add pub mod config; to stt/mod.rs. Verify: cargo check.
1. Step 5 — register commands in src-tauri/src/lib.rs:2874 generate_handler![] (alongside o8_stt_start/tts_speak/background::*). Verify: cargo check + app boots.
1. Step 6 — bridge wrappers in src/lib/tauri/bridge.ts after line 246: dictationPrefGet / dictationPrefsGetAll / dictationPrefSet / dictationPrefsSet over the new commands (NOT storeGet/storeSet). Verify: npx tsc --noEmit.
1. Step 7 — end-to-end backend smoke: from a dev build, set_voice_pref('dictionary', '["o8","Tauri"]') then dictate without relaunch; confirm config() re-reads (mtime cache + invalidate) and the polish prompt picks up the words. This proves Phase 1 made existing prefs real with no app restart. (Phase 2 UI builds on top: extend VoiceTab.tsx with numbered sections 03-09 using the AppearanceTab radio-card + APIKeysTab password-input idioms, writing through the Step 6 bridge.)
