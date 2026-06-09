# Symon Agent Parity Plan (voice tool-calling agent)

Canonical reference for porting the acquired Symon's **agent side** into o8. Action prompt for a fresh session: `~/o8-symon-agent-resume.md`. Generated from a 3-agent extract+audit+brainstorm (Jun 9 2026).

## Locked decision (revised Jun 9 — confirmed vs Symon's live `agent_models.json`)
- **Loop brain:** `openai/gpt-4o-mini` via **OpenRouter** (DEFAULT) — what Symon actually ships; proven tool-calling; ~Flash price tier (cost is a wash, reliability decides). Symon moved off Gemini for the loop because its allowlisted Gemini *proxy* timed out/quota'd. Build **config-driven** (port Symon's `agent_models.json` + `/`-id→OpenRouter routing) so the model is a one-flip change. Needs the OpenRouter key plumbed (o8 already has an OpenRouter fallback path).
- **Gemini Flash = config-flip A/B** after the loop works on 4o-mini (nuance: o8 calls Gemini **direct**, not Symon's flaky license proxy — so Flash may be fine here).
- **Ask + vision model:** Gemini 3.1 Pro (`gemini-3.1-pro-preview`) — o8's `gemini_ask.rs` already runs this (parity for free). classify+summarize = `gemini-3-flash`; browser = `gemini-2.5-computer-use`.
- **Not Claude in the loop** (Anthropic only via the Claude REPL = orchestrator's lane). **Not the Codex CLI as the loop brain** — Codex is the *delegation worker* (below).
- **Architecture (hybrid):** a dedicated Rust voice-agent loop beside `gemini_ask.rs` — fast brain (4o-mini) function-calling turn (drop `classify_intent` pre-call), ~10-turn feedback, native TTS. **"Go work" muscle = a warm, pre-loaded Codex subscription session** the brain delegates to (free inference, Codex IS the worker; `ensureCodexOrchestratorSession()` + `codex exec resume` kills cold-start; warm-Codex = ~100-500ms/turn + no streaming → delegation, not the snappy loop). **Two-tier tools:** Tier-1 native macOS (parity, any Mac); Tier-2 o8 bridge — read-state day one + delegate-work = moat, fleet-gated. Every mutating call → o8 approval card. Distinct from the orchestrator.
- **Moat vs Siri:** Tier-2 fleet voice bridge + governed/audited actions + Cortex memory grounding; runs on older Macs Apple's Siri update skips.

## Old Symon agent (aqua-color) — what it SHIPS
Tool-calling loop = **`openai/gpt-4o-mini` via OpenRouter** (runtime `agent_models.json` override; the `gemini-3.1-pro` in `router.rs` is just the code default). Ask/vision = Gemini 3.1 Pro. classify/summarize = Gemini Flash. Browser = Gemini 2.5 Computer Use. SQLite task queue (max-2), SafetyClass gate (ReadOnly/Reversible/Destructive + confirm card), ≤10 reasoning turns, ≤30 browser iters w/ screenshot dedup.

### Tool inventory (Tier-1 to port — Rust via osascript-JXA)
| Tool | Purpose |
|---|---|
| open_app | launch/foreground a macOS app |
| mac_calendar_list/create/delete_event | EventKit calendar |
| mac_reminders_list/create/complete | reminders |
| mac_notes_search/create/append | Apple Notes |
| mac_contacts_search | contacts |
| mac_mail_search/read/draft/send_draft | Mail (send needs confirm) |
| mac_shortcuts_list/run | Shortcuts (run needs confirm) |
| fs_read_text/write_text/spotlight | files + mdfind |
| csv_read/write | CSV |
| web_research/web_form_fill/web_extract_data | Playwright + Computer Use (Tier-5/vision) |

aqua refs: `src-tauri/src/agent/{mod,queue,router,safety}.rs`, `agent/providers/{gemini,computer_use,openrouter}.rs`, `agent/tools/*.rs`, `agent/browser_daemon.rs`, `agent-browser/daemon.mjs`.

## o8 reuse map
- `src-tauri/src/ai/gemini_ask.rs` — direct Gemini transport (swap model for loop, keep Pro for Ask).
- `src-tauri/src/{stt.rs,tts/mod.rs,audio_ducker.rs,sound.rs}` — native STT/TTS/ducking/cues (already ported).
- dock surface: `src/app/dictation-pill/page.tsx`, `DockNotchSurface`, `DockAskPanel`, `spawn_ask_and_speak`, `emit_to(DOCK_LABEL,…)`.
- Tier-2 target: `src/lib/mcp/operator-mcp-server.ts` (`dispatch_mission`, `get_mission_status`, `approve_and_merge`, `cortex_ask`, `o8_view_*`).
- dispatch routing: `src/lib/orchestrator/operator-mission-service.ts` + `src/lib/agents/routing.ts` (`resolveWorkerRouting`).
- Q&A grounding: `src/lib/cortex/qa/ask.ts` (`runAskPipeline`).
- approvals store + confirm-card pattern (backs SafetyClass + Tier-2 mutations).

## Phases
0. Always-on dock paint (P0). 1. Model lock + Rust loop + safety + confirm card. 2. Tier-1 native tools = **shippable Siri parity**. 3. persistence + notification + streaming + OpenRouter fallback + history. 4. **Tier-2 fleet bridge (the moat)**. 5. vision/browser CUA + screen-reading.

## Risks
Don't be a Siri clone (moat = Tier-2 + governance). Sub-second first-token on the *actual* older-Mac target. Billing at scale (BYOK/metered/voice budget). Never leak Claude into the voice/Ask loop. Privacy/TCC consent (Automation + Screen Recording). Gate Tier-2 to fleet-connected. Browser CUA flakiness → last.
