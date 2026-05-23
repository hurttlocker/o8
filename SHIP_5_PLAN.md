# Ship #5 Plan — From foundation to brain

Closing six fixes that take o8 from "the dogfood loop works" to **reliable foundation + a brain that actually feels like one**. Single ship target: **`0.1.155`**.

Order is **leverage-first**: every fix should produce an operator-noticeable delta on the next dispatch (or the next backend interaction). Highest-leverage first so a partial ship still moves the needle.

---

## Pre-flight (already true after today)

- ✅ Main is internally consistent (commit `e1a3a4d0` swept the 22-file WIP).
- ✅ Pre-launch tsc gate runs regardless of `skipSetup` (commit `e1a3a4d0`).
- ✅ Lane lookup in 4 governance handlers tolerates terminal lanes (`57ca3d2d`).
- ✅ The auto-merge loop fired clean once (`7fcb5e41 [via-o8]`), so the pipeline is proven.

---

## Phase 1 — `#1109` Backend reliability (P0, Rust)

**Problem:** A failed `o8_view_screenshot` panics in `tauri_plugin_mcp` (`core-foundation NULL object`), and the panic triggers `sidecar_lifecycle` shutdown — killing the bundled Next + WS sidecars. Backend dies; Claude Desktop loses connection; the webview loses its API. This bit us today.

**Fix:**
- Wrap the macOS screenshot path in `std::panic::catch_unwind` so panics become returned errors.
- Audit `sidecar_lifecycle` for what currently classifies a tokio worker panic as a sidecar-fatal event. **MCP tool panics MUST NOT trigger sidecar shutdown.**
- Add a smoke: run a deliberately-bad screenshot (window minimized / off-screen) → assert backend stays up.

**Files (likely):** `src-tauri/tauri-plugin-mcp/src/tools.rs` (or similar), `src-tauri/src/sidecar_lifecycle.rs`.

**Tests:** trigger panic via known bad coords → assert `/api/orchestrator/state` still responds.

**Ship note:** Rust change — requires `cargo tauri build` (which the ship script already does).

- [ ] Investigate code locations
- [ ] Wrap screenshot in catch_unwind
- [ ] Audit + isolate sidecar_lifecycle from MCP panics
- [ ] tsc + cargo check
- [ ] Commit

---

## Phase 2 — Wire `session_outcomes` writes (P0, TS)

**Problem:** The 27-column `session_outcomes` table has no live writers; only seed scripts populate it. Three systems depend on it and silently no-op today:
1. `Recent Outcomes` section of the worker's `<context>` envelope.
2. Auto-directive proposer (#746).
3. Runtime routing recommender (#747 — always returns `null` for insufficient data).

**Fix:** On packet terminal-state in `src/lib/lane/lifecycle.ts` (or the existing `capturePacketCompletionContext` call site in `ws-server.ts:4451`), upsert one row to `session_outcomes` with:
- `repo_path`, `runtime`, `outcome`, `summary`, `changed_files_json`, `merged_clean`, `attempts`.
- Source the data from `packetCompletionContextStore` (already aggregated).

**Files:** `src/lib/lane/lifecycle.ts`, possibly `src/ws-server.ts` near line 4451, `src/lib/orchestrator/context-relay.ts`.

**Tests:** dispatch + complete a packet → query `session_outcomes` → row present with sensible columns. Confirm the next dispatch's brief includes Recent Outcomes.

- [ ] Find the terminal-state hook(s)
- [ ] Implement the upsert
- [ ] Smoke test: dispatch → row appears
- [ ] tsc clean
- [ ] Commit

---

## Phase 3 — In-app directive editor + Accept-writes-the-file

**Problem:** Operator can't author / edit directives in-app. "Accept" on a directive proposal just drops text into the chat composer — the operator still has to hand-edit `~/.o8/directives/*.md` in a terminal. The proposal loop never closes.

**Fix:** Two seams.
1. **`POST /api/cortex/directives`** accepting `{id, title, scope, repoName?, projects?, priority?, body}`. Writes `~/.o8/directives/<id>.md` with the front-matter the parser already understands. Loopback-gated via the existing middleware.
2. **`handleAcceptDirectiveProposal`** in `dashboard/page.tsx` → POST the directive instead of `setThoughtsDraftInjection`. Pop a small inline editor for title/scope/priority tweaks before save.

**Files:** `src/app/api/cortex/directives/route.ts` (extend with POST), `src/components/desktop/.../useDirectiveProposals.ts`, `src/app/dashboard/page.tsx`.

**Tests:** accept a proposal → file appears at `~/.o8/directives/<id>.md` → next packet brief includes the directive.

- [ ] Add POST route
- [ ] Inline editor (Rams density, raw SVG icons, no native inputs)
- [ ] Rewire handleAccept
- [ ] tsc clean
- [ ] Commit

---

## Phase 4 — Worker MCP escape hatch

**Problem:** Codex workers can't call `cortex_propose_observation` — `codexLaunchArgs` doesn't pass any `--config mcp_servers.*` flags. The "every dispatch learns" loop is amputated.

**Fix:**
1. Verify Codex exec supports `--config mcp_servers.<name>.command=<binary>` flags. If yes:
   - Wire a per-packet MCP config in `src/lib/codex/owned.ts:codexLaunchArgs` exposing just `cortex_propose_observation` (and maybe `cortex_ask`).
2. If Codex exec doesn't support it under `danger-full-access` sandbox: ship the CLI wrapper alternative — `o8 observe --kind ... --text ...` that POSTs to `/api/cortex/proposals`. The `o8` binary is already on the worker's PATH.

**Files:** `src/lib/codex/owned.ts`, possibly `src/lib/lane/orchestrator-mcp-config.ts` (reuse pattern), `cli/src/commands/observe.ts` (new, fallback).

**Tests:** dispatch a packet → observe Codex emitting an observation → it appears in the proposal queue → operator sees it in O8 Activity tab.

- [ ] Investigate Codex CLI MCP support under `exec`
- [ ] Wire whichever path works
- [ ] tsc + CLI build
- [ ] Commit

---

## Phase 5 — Profile `/api/panel/repos` (60 ms outlier)

**Problem:** Hot-path endpoint at 60 ms — 10x slower than the next slowest (`/api/cortex/directives` at 8.7 ms). Called on every dashboard render.

**Fix:** Read the route. Likely culprits: synchronous `git` calls per repo, no result cache, repeated file reads. Add a short-TTL in-memory cache OR parallelize the per-repo enrichment OR cut the per-repo git calls.

**Files:** `src/app/api/panel/repos/route.ts` and whatever it calls.

**Tests:** measure before/after with the same curl-with-token script.

- [ ] Read route + identify hot spot
- [ ] Apply the fix
- [ ] Re-measure
- [ ] Commit

---

## Phase 6 — Polish: `#1104` CLI version + `#1105` MCP webview DX

**Problem 6a (#1104):** Bundled `o8 version` reports `0.0.0-dev` instead of `0.1.X`. The `__O8_CLI_VERSION__` esbuild define isn't reaching the ship's CLI bundle path.

**Fix:** Investigate `scripts/tauri-export.mjs` + `cli/esbuild.config.mjs`. Ensure the version is read from `package.json` at ship time and injected. Bonus: have `o8 version` also include the git short SHA.

**Files:** `scripts/tauri-export.mjs`, `cli/esbuild.config.mjs`, possibly `cli/src/commands/version.ts`.

**Tests:** rebuild + run `/usr/local/bin/o8 version` from the shipped install → shows the right version.

**Problem 6b (#1105):** Eval-based MCP webview tools (`o8_view_eval`, `o8_view_type`, `o8_view_snapshot`) time out but the action fires anyway, misleading callers. CSS-vs-screenshot pixel mismatch confuses coord-based clicks.

**Fix (lighter touch):** Document the behavior in each tool's description; add a `cssWidth`/`cssHeight` field to `o8_view_screenshot` response so callers can scale. Optional: shorter timeout on `o8_view_type` (synchronous-action tools shouldn't await long).

**Files:** `src-tauri/tauri-plugin-mcp/src/tools.rs` (description strings + screenshot response shape), `src/lib/mcp/operator-handlers/webview.ts` (or equivalent JS-side wrappers).

- [ ] 6a: fix CLI version injection
- [ ] 6b: add screenshot CSS dims to response + improve descriptions
- [ ] tsc + smoke
- [ ] Commit

---

## Ship gate

After all six phases:
- Full `npx tsc --noEmit` clean.
- `npm run lint` clean.
- `npm run build` succeeds.
- `o8 version` reports `0.1.155` from a fresh shipped install.
- `/api/panel/repos` measured at < 20 ms.
- Deliberate screenshot panic → backend survives (the `#1109` smoke).
- Dispatch a small packet end-to-end → `session_outcomes` row written → next packet brief shows Recent Outcomes.

Then:
```bash
npm --no-git-tag-version version patch   # → 0.1.155
git commit -m "0.1.155" -- package.json package-lock.json src-tauri/tauri.conf.json src-tauri/Cargo.toml
git tag -a v0.1.155 -m "0.1.155"
git push origin main --follow-tags
npm run ship
```

Install + relaunch with `env -u O8_DEV_FRONTEND_URL` (the launchd inherits-dev-bridge dance) and verify each phase's operator-visible delta.

---

## Progress

Tasks #90-#95 created. Mark them as work lands. This file is the source of truth — update it as scope or order changes.
