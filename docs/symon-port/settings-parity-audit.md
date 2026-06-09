# o8 Voice-Settings — Parity Audit vs Symon

Audited `src/app/voice-settings/*` (shell `page.tsx`, `primitives.tsx`, `tokens.ts`, `helpers.ts`, 8 tab files) against Symon `~/aqua-color/src/SettingsApp.svelte` + `src/lib/settings/*`, and cross-checked which pref keys o8's Rust actually reads (`src-tauri/src`). Date: 2026-06-09.

## Verdict
**~85% there and genuinely faithful.** The shell, the design-system primitives, and 10-of-10 tabs exist. The gaps are concentrated and structural, not cosmetic. In priority order below.

---

## ✅ What he nailed — do NOT touch
- **Shell** (`page.tsx`): borderless transparent 22px glass window, 188px sidebar, in-app traffic lights (`#FF5F57/#FFBD2E/#28CA41`, close→hide), BrandGlyph + 96×16 brand wave + version, tabbed nav with hover/active + `translateY(-1)`, content grid-dot bg + 46px drag bar. Faithful to `SettingsApp.svelte`.
- **All 10 tabs exist as separate sidebar entries** (Settings, Dictionary, Snippets, Instructions, History, Stats, Account, Founder, Agent, Report) — the single-page problem is fully fixed.
- **Primitives** (`primitives.tsx`): SectionCard, SectionTitle, SectionHint, ToggleRow, ControlRow, Toggle (44×24, knob translateX 20 — exact), Select, Segmented, Slider, StatusBadge, ProPill, Ghost/AccentButton. Dimensions match.
- **Dictionary** (chip list), **Snippets** (trigger→replacement rows), **Instructions** (textarea) — faithful.
- **Tokens**: dark map ported verbatim from `settingsSurfaceStyle()` dark branch; accent `#4058FF`; wave stops; traffic-light colors.

### Deliberate, CORRECT deviations — don't "fix" these
- **Weight discipline** (`tokens.ts`: W_BODY 300 / W_HEADING 400 / W_STRONG 500): intentional per hurttlocker ("never 600+ on chrome", weight-300 as true thin). Symon uses 600 on section-titles / 560 page-title; o8 deliberately doesn't. Leave it.
- **Account tab** is o8-native (reads `/api/panel/entitlement` + o8.run/pricing), NOT Symon's Stripe-checkout/magic-link/customer-portal. By design — o8's billing lives in the main app.
- **o8's own pref-key names** (`polish_instructions`, `elevenlabs_*`, `ducking_enabled`, `sounds_enabled`): verified the Rust side reads exactly these — frontend↔backend are consistent. They differ from Symon's `instructions`/`personal_elevenlabs_*` but that's o8's scheme, not a bug.
- **Audio Feedback** section (Dim audio / Sound cues): o8 *additions* beyond Symon (Symon ducks automatically, sounds always-on). Nice to have, both wired. Keep.

---

## ❌ Where he's going wrong — prioritized

### P0 — The **Appearance** section is entirely missing
`SettingsTab.tsx` has Input / Voice Output / Audio Feedback / Permissions — but **no Appearance card**. Symon's Appearance section (`SettingsPage.svelte:774`) is a whole control group that's absent:
- **Pill surface / theme picker** (`pill_surface`: Midnight / Frost / Apple Glass / Mist) — the surface grid w/ live pill previews. *Also* the thing that drives light/dark (see P1).
- **Dock to top notch** (`surface_anchor` notch↔pill) — the notch-vs-bottom-pill toggle. Core to a dictation HUD; missing.
- **Show idle capsule at notch** (`notch_idle_pill`).
- **Allow moving the pill** (`pill_movement_enabled`).
- **Launch at login** (`autostart_enabled`) — o8 already has the capability (`background.rs` `autostart_is_enabled`/`tauri_plugin_autostart`), it's just not surfaced.
- **Show waveform while holding Fn** (`listening_show_waveform`).

Verified: none of `surface_anchor / pill_surface / notch_idle_pill / pill_movement_enabled / listening_show_waveform` are read by o8's backend either — so this is net-new (UI + a little wiring), not just a missing card. **Biggest single gap.**

### P1 — Settings window has no light mode / doesn't follow the surface
`tokens.ts` hardcodes only the **dark "midnight"** half of Symon's `settingsSurfaceStyle()`. Missing:
- The **light (Frost) theme** — Symon flips the *entire* settings window to light when `pill_surface === 'frost'` (`SettingsApp.svelte:75-114` builds a full light var set).
- Reading `pill_surface` on mount + the **`pill-surface-changed` listener** (Symon re-themes live). `page.tsx` never reads `pill_surface`.

Fix is paired with P0: add the surface picker, then make `tokens.ts` a function of the selected surface (light when frost) and re-render on change. Port the light column of the `settingsSurfaceStyle` table from the master dossier Part 2.

### P1 — Founder + Agent tabs are shown to **everyone** (no founder gate)
`page.tsx:43-44` always includes `founder` + `agent` in `TABS`. Symon only renders **Founder + Agent Beta when `founder_edition_enabled === 'true'`**, inserted right before Report Issue (`SettingsApp.svelte:153-160`). Verified `founder_edition_enabled` isn't read anywhere in o8 yet. Fix: load it in `page.tsx`, conditionally append those two tabs. (Otherwise every user sees the ElevenLabs founder config + agent beta.)

### P1 — Voice Output collapsed Symon's **two-path voice model**
`SettingsTab.tsx` Voice Output has one "Read-aloud voice" (`tts_voice_id`) + preview + speed. Symon splits this (the two voice paths from the master dossier Part 5):
- **"Speak Ask answers" toggle** (`symon_voice_enabled`) — whether Ask answers are spoken at all. Missing (not read by o8 backend).
- **"Ask answer voice"** (`symon_voice_id`, restricted to Wavenet-I/H) — separate from the read-aloud voice. Missing.
- *(minor)* provider/API status badges next to the voice rows.

Reasonable to defer until o8's Ask-answer *speaking* surface lands — but the toggle + second selector are the parity gap. Flag, don't necessarily build today.

### P2 — Founder tab has no **voice library** (single voice only)
`FounderTab.tsx` edits one active ElevenLabs voice (id + model + 3 sliders + speaker boost) and writes `elevenlabs_*` keys — which **do match o8's `tts/elevenlabs.rs`** (verified), so it works. But Symon's Founder page is a **voice library** (`founder_elevenlabs_voice_library`): save multiple named voices (Rocky / Brit Rick / Sydney / Main voice), each with its own params, and switch/preview/remove. o8 has only the single-voice editor. Also Symon's save flips `founder_edition_enabled` + `personal_tts_provider='elevenlabs'` + `symon_voice_enabled` on as a bundle. (The founder voice library is the piece Marquise specifically cares about.)
- Minor: o8 default model `eleven_turbo_v2_5` vs Symon `eleven_multilingual_v2`.

### P2 — Permissions is thinner than Symon
`SettingsTab` Permissions checks **Accessibility, Input Monitoring, Fn-key binding** (correct for the Fn tap). Symon also surfaces **Microphone, Speech Recognition, Screen Recording** (needed for dictation / reading / Ask vision). Add those three rows. (Symon's section is also collapsible w/ chevron; o8's is always-open — trivial.)

### P3 — History + Stats are slightly reduced (honest, but missing pieces)
- **History**: o8 has copy + delete + clear. Symon also has **replay saved audio** and **re-run polish** per entry. (o8 may not persist the WAV; replay needs that.) 
- **Stats**: o8 has Time-Saved hero (modeled, honestly labeled) + total words / dictations / today / week / active days / top app / Fn-vs-Ask. Missing Symon's **day-streak** and the **level / level-name / progress** gamification.

### Nits (optional)
- `PAGE_TITLE_STYLE` 19px/400/-0.02em vs Symon 22px/560/-0.03em (tied to the weight philosophy — fine, reads a touch smaller).
- SectionTitle letter-spacing 0.12em vs 0.14em, icon 14 vs 13, SectionHint maxWidth 460 vs 720 — trivial.

---

## Suggested order
1. **Appearance section** (surface picker + dock-to-notch + idle capsule + launch-at-login + pill-move + listening waveform) — P0, biggest visible gap.
2. **Light/Frost theming** (driven by the new surface picker) — pairs with #1.
3. **Founder-gate** Founder + Agent tabs.
4. **Founder voice library** (the multi-voice list) — Marquise priority.
5. **Voice Output**: add Speak-Ask-answers toggle + Ask-answer voice (when the speaking surface is ready).
6. Permissions (mic/speech/screen-recording), then History replay/rerun + Stats streak/level.

**Source refs:** Symon Appearance `SettingsPage.svelte:774`; light/dark vars `SettingsApp.svelte:75-114`; founder gate `:153-160`; Voice Output two-path = master dossier Part 5; voice library `FounderPage.svelte`. o8: tabs `page.tsx:35-46`, SettingsTab sections `SettingsTab.tsx:91-166`, Founder keys `FounderTab.tsx:42-48`.
