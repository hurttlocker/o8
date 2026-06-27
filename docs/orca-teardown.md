# Orca — Competitive Teardown & Adoption Backlog

Orca (stablyai, MIT, Electron — `onorca.dev`) is o8's closest competitor: a desktop orchestrator that runs many CLI coding agents in parallel git worktrees, with a mobile companion. This is the teardown plus the ordered list of what we adopt — **refit through o8's lens, never copied.**

## The fork
Same starting point, opposite bets:
- **Orca = breadth.** Every agent is a CLI command in a PTY; agent state is read by *scraping the terminal title* (OSC escape sequences). ~33 agents with near-zero per-agent code — but no structured event stream, no typed transcript, and detection breaks the moment an agent changes its TUI. *"If it runs in a terminal, it runs in Orca."*
- **o8 = depth.** Typed runtime adapters, JSON event streams, a governable diff, an approval ledger, organizational memory.

Orca is **shallow exactly where we're deep** (governance, memory, approvals) and we're **narrow exactly where they're broad** (runtime count, cross-platform, SSH). **Rule for everything below: borrow the polish, never concede the moat.**

## Our moat (do not trade away)
- **Governance** — approval surface + audit ledger + the 5-layer merge-escalation chain. Orca's "orchestration" is agents typing messages to each other with decision gates; **no review-inversion, no approval ledger, no audit of every action.**
- **Organizational memory** — Cortex v2 (directives + session-outcome ledger) + the Engineering Brain (cited, spend-capped, workers `o8 ask`). They have skills + docs; no learning loop.
- **Orchestrator-as-brain** that reviews the diff before merge; **spend discipline** as product; **theme/accessibility rigor** (palette × surface).

---

## Adoption backlog (ordered — we start at 1)

### 1. Agent + human browser with a shared cursor + Design-Mode grab — ✅ SHIPPED

> Shipped via the 6-stage embedded-browser consolidation (commits e7b30af0 → 49d643c5):
> shared `selector.ts`; canonical `GrabbedElement` + `grab` verb across page-agent / engine /
> route / MCP / CLI; one unified click-to-grab Design Mode (Cmd+Shift+D) over chrome AND the
> embedded browser reading the live same-origin page; `?pick=1` strip + the element picker +
> the annotation arrow flow deleted; a continuous agent ghost cursor + unified driving-glow.
> Live behavior (panel SPA fidelity through the proxy, iframe grab, cursor coexistence) needs a
> ship + dogfood to verify. Next up: item 2.
**Our vision (one level past Orca):** o8's embedded browser is **both agent- and human-usable on the same surface.** The agent drives with a Claude-style **ghost cursor** — exactly how Claude drives the Google-native Chrome MCP (a visible cursor moving on the live page) — while the human uses their **own** cursor. One browser, two drivers.

**Borrow from Orca — Design Mode "grab":** click any live element → capture its HTML / CSS / computed-styles / accessibility tree / screenshot → auto-insert into the agent prompt. Orca refs: `src/renderer/src/components/browser-pane/BrowserPane.tsx`, `useGrabMode.ts`, `GrabConfirmationSheet.tsx` (works over SSH screencast). It is the single most "magic" interaction in their app, and it fits our agent+human browser perfectly: the human-side affordance that hands the agent exactly what's broken.

**Do it correctly — full parity, no dead code.** o8 already has: an embedded browser (canvas browser cards + the Browser tab), the in-page agent (`src/lib/browser-agent/page-agent.ts`, `window.__o8BrowserAgent`), the `o8_browser_*` MCP verbs (#1232 phase 1), and a ghost cursor + amber card glow on agent actions. The task is to **audit what exists and refit it** into the agent+human shared-cursor + Design-Mode model — adjusting or removing whatever the refactor obsoletes so nothing is left hanging or dead afterward.

**Decisions (greenlit 2026-06-25):** unify ALL grab paths into one Design Mode (dashboard + embedded browser); KILL the `?pick=1` script-strip proxy (read the live same-origin page so both drivers stay interactive); FULL under-the-hood consolidation.

**Target model:** one shared browser surface; a continuous agent **ghost cursor** (extended from `page-agent.ts` `paintCursor`) coexisting with the human's native cursor; **one** Design Mode (Cmd+Shift+D) that grabs from both the dashboard chrome AND the embedded browser (rich HTML/CSS/computed-styles/a11y/screenshot → agent prompt), reading the live same-origin page; every grab/action audited via `browser_acted` lane events.

**Stages (each tsc-clean + committable):**
1. **Shared selector util** — `src/lib/browser/selector.ts`; migrate the 4 divergent impls (`page-agent.ts:63`, `browser-card.tsx:121`, `browser-engine/engine.ts:37`, `element-picker-bridge.ts:58`).
2. **Grab payload + verb** — canonical `GrabbedElement` (extend `element-picker-bridge.buildPayload` with full computed-styles + a11y); add `grab(selector)` to `page-agent.ts` + the `/api/browser/agent` route + `o8_browser_grab`.
3. **Unify Design Mode** — `useDesignMode`/`DesignModeOverlay` target the embedded browser (route to `grab` when over a `data-o8-browser` frame); fold in the panel annotation flow + the canvas inline picker.
4. **Delete dead paths** — remove the `?pick=1` script-strip, the canvas inline picker, the annotation duplicate; grep-verify no orphans.
5. **Shared cursor + unified glow** — continuous agent cursor; standardize the agent-driving indicator (cursor + glow) across canvas AND panel.
6. **Audit + sweep** — `recordLaneEvent` for human-initiated grabs; final orphan grep; tsc + tests.

### 2. CLI-as-control-plane symmetry (moat-compounding) — ✅ SHIPPED (0.1.511)
One binary serves the human (headless) **and** the agents (self-orchestration) over one socket; skills are docs teaching agents which verbs exist. o8 has the `o8` CLI + MCP — unify so an agent orchestrates by shelling one binary on `$PATH`. Deepens our agent-control story. Orca refs: `skills/orca-cli/SKILL.md`, `skills/orchestration/SKILL.md`.

> **Full plan: [`docs/cli-control-plane-symmetry.md`](./cli-control-plane-symmetry.md).** Key finding: the shared control-plane core already exists (`src/lib/orchestrator/operator-mission-service/`, reached via gated `/api/orchestrator/*`); both MCP and the CLI are already thin HTTP clients of it. So it's a symmetry + governance pass (add CLI commands on existing routes), not a rebuild — one route extraction (`steer-packet`) + a merge-seam move + a worker-context approval guard so a worker can't self-merge to `main`. 7 staged steps, each tsc-clean + committable.

### 3. Side-by-side N-worktree diff/merge "pick the winner" surface (moat-compounding — neither has shipped it)
Both market "compare & merge the winner"; **neither built the N-up diff matrix.** Build it first → own the narrative, and wire it straight into our review-gate (`o8_merge_preview` → `submit_review` → `approve_and_merge`), which Orca lacks.

### 4. Detached daemon crash-survival
Orca's PTYs live in a **detached process, checkpointed to disk every 5s**; agents survive an app crash and cold-restore (Orca: `src/main/daemon/`). o8 sessions die with the Next/ws-server lifecycle (we document this pain). A resilience layer so a hot-reload or crash doesn't kill live agent state.

### 5. Mobile E2EE + per-device tokens
Per-connection ephemeral Curve25519 ECDH → XSalsa20-Poly1305 + per-device revocable tokens + forward secrecy (Orca: `src/main/runtime/rpc/e2ee-channel.ts`, `device-registry.ts`) vs. our single shared bearer token. A security upgrade for the mobile surface. **Keep our web-push edge** — Orca has no cloud push, so a backgrounded phone misses events.

### 6. Persistent terminal scrollback
WebGL xterm serialized to disk and replayed on restart with a "session restored" banner. Durable terminals.

### 7. Written, enforced styleguide
Feedback-timing tiers (0–100ms none / 100ms–1s disabled / 1–3s spinner / 3s+ stage labels), sibling-cohesion + button-hierarchy as **review-gating** rules (Orca: `docs/STYLEGUIDE.md`). Same instinct as hurttlocker — codify the interaction-timing half we haven't written down yet.

### 8. Cross-platform + SSH / remote worktrees (bigger bet)
macOS / Windows / Linux + run agents on a remote box (auto-reconnect, port-forward, remote browser screencast). Our largest gap and largest effort.

### 9. Richer mobile
Inline diff comments + approve / request-changes + compose PRs from the phone. Orca's mobile is closer to a full second client; ours is intentionally a remote control — worth selectively deepening.

---

*Teardown sourced from a full clone of `stablyai/orca` (Electron app, 6.3k files). Anchor files for each item are inline above.*
