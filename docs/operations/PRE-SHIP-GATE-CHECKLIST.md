# Pre-Ship Gate Checklist — "Could a stranger install o8 and ship one reviewed change?"

This is the **release readiness gate** for o8. It has two halves:

1. **Automated boot gate** (`scripts/preship-webview-gate.mjs`) — runs inside `npm run ship`. Proves the freshly-built signed app *boots* (real WKWebView, dashboard reaches `o8:dashboard:interactive`, no console errors). Catches hard/page-load/SSR crashes. **Known gap (#1163):** does not yet catch soft client-side React crashes — see that issue.
2. **Manual fresh-profile first-run runbook** (this document) — what the boot gate *cannot* prove: that a person who is not Marquise can install the DMG, complete setup, reach the orchestrator, and land one reviewed change. **No outreach to a design partner happens until this runbook PASSES 2–3× on a clean profile.**

The bar is not "it works on the build machine." It is **"a stranger could install o8 and ship one reviewed change without embarrassment."**

---

## 0. Prerequisites a stranger must have

o8 orchestrates external CLIs; it does not bundle them. Before install, the user needs:

| Requirement | Why | Check |
|---|---|---|
| **macOS** (Apple Silicon or Intel) | o8 ships as a signed `.dmg` | — |
| **Node.js ≥ 22** | bundled Next/ws sidecars + better-sqlite3 ABI | `node -v` |
| **A worker CLI: Codex** (`codex`) | the default worker runtime and the simplest first-run proof | `which codex` |
| **Claude Code** (`claude`) — optional but expected | orchestrator and worker harness | `which claude` |
| **CLIProxyAPI** (`cliproxyapi`) — optional | local Codex subscription carrier for Claude Code | `which cliproxyapi` |
| **`gh` CLI** — recommended | GitHub issue/PR ops, higher rate limits | `which gh` |
| **`git` ≥ 2.5** | worktree-based dispatch | `git --version` |

> If `codex` is missing, dispatch will fail. As of the GATE-2b fix, that failure must surface in the UI **at dispatch time** with an install command — not silently minutes later. Verify this is true before shipping (see §4).

---

## 1. Create a clean profile

Pick the strongest isolation you can:

- **Best (true stranger):** a fresh macOS user account, or a VM, with none of o8's data dirs and none of the CLIs pre-installed (then install only the prereqs above).
- **Good (fresh data only):** wipe o8's state so first-run logic triggers:
  ```bash
  # Quit o8 first. Back up if you care about local directives/history.
  rm -rf ~/.o8                 # data dir: db, ws-token, api-port, setup.json, directives
  # Optionally simulate "no prior agent history":
  #   mv ~/.codex ~/.codex.bak ; mv ~/.claude ~/.claude.bak
  ```
- **Override (no wipe):** point o8 at a throwaway data dir without touching yours:
  ```bash
  CORTEX_IDE_DATA_DIR=$(mktemp -d) open -n /Applications/o8.app
  ```

Confirm a clean start: `ls ~/.o8 2>/dev/null` (or the override dir) shows no `setup.json`.

---

## 2. Install the signed DMG

1. Download the latest `o8_*.dmg` from the newest release at `hurttlocker/o8` (or the mirror `hurttlocker/o8`).
2. Open the DMG, drag **o8** to `/Applications`.
3. First launch: Gatekeeper should accept the signed + notarized build (no "unidentified developer" wall). **If Gatekeeper blocks it, that's a ship blocker** — notarization/stapling failed.
4. The Node pre-flight runs: if Node < 22 or not found, o8 shows a native dialog and exits. Confirm a machine *with* Node 22 launches clean.

**PASS §2:** the window opens to the dashboard shell within a few seconds, no crash, no "Application error" page.

---

## 3. Complete the setup wizard

The 6-step Onboarding appears on a fresh profile (`useSetupWizard.ts` → `setupComplete` false). Walk every step:

| Step | What to verify | Known failure mode to watch |
|---|---|---|
| **1 · Welcome** | Feature carousel renders; "Sign in with GitHub" starts a device-code flow; code + verify URL shown | Device flow is hardened (10-min expiry, clean restart on `expired`). If it dead-ends, file it. |
| **2 · Repos** | After GitHub auth, your repos list loads; you can select one | Empty list with no error = a fetch failure being swallowed |
| **3 · Runtimes** | Detected CLIs (Codex/Claude/Gemini/opencode) show with versions | **GATE-2a:** if `/api/setup/detect` fails, the spinner just stops and the list is empty with no error/retry. The list should show *something* or an explicit "couldn't detect — retry" — never a silent blank. |
| **4 · Dispatch** | Pick default runtime (Codex); it persists | Save errors *are* surfaced here (hardened). |
| **5 · Import** | Optional ChatGPT history import; skippable | — |
| **6 · Ready** | "Enter o8" closes the wizard | **GATE-2a:** if the completion POST fails it's swallowed and the wizard silently re-appears next launch. Re-launch once and confirm the wizard does NOT come back — that proves `setupComplete` actually persisted. |

**PASS §3:** all steps complete, and after a full quit + relaunch the wizard does **not** reappear.

---

## 4. Reach the orchestrator and ship one reviewed change

This is the product. A stranger must be able to do this on day one.

1. The dashboard shows the **Orchestrator** tab (empty state with quick-action cards) + an Assistant tab.
2. **Dispatch a trivial change.** In the orchestrator, ask for a one-line, safe change to the selected repo (or use an inline packet, e.g. "add a comment to the README"). Confirm:
   - The packet card appears on the **same tab** (no orphaned/blank tab).
   - A Codex worker actually launches (status moves past "launching").
   - **GATE-2b:** if `codex` is NOT on PATH, the dispatch must fail with a clear, user-visible error **and an install command** — not a lane that silently dies and only reveals "Run ended without clean turn" minutes later. Test this explicitly by temporarily renaming `codex` off PATH.
3. When the packet hits **awaiting_review**, review the diff (`o8_merge_preview` / the review surface), then **explicitly approve + merge**.
   - **GATE-1a invariant:** the packet must NOT reach `released` on main unless a recorded approved review exists. Confirm an unreviewed packet cannot merge (the governance moat).
4. Confirm the change is on `main` and the worktree is cleaned up.

**PASS §4:** a packet went dispatch → review → approve → merge, the diff was correct, and at no point did a never-reviewed packet auto-land.

---

## 5. Claude Code with a Codex subscription (verify if claimed)

This path consumes real Codex subscription quota, so it stays outside ordinary CI. Run it once before a release that changes the carrier, warm-session lifecycle, cache telemetry, or Codex capacity reader.

1. In **Settings → Models → Claude Code harness**, select **Codex subscription**.
2. If needed, install `cliproxyapi`, click **Connect Codex**, and finish the browser authorization.
3. Start one orchestrator chat and complete two turns. Confirm that the second turn stays in the same chat and reports prompt-cache use.
4. Start a second orchestrator chat. Confirm that it has a separate Claude session and does not know the first chat's conversation.
5. Confirm that Codex capacity in the app agrees with the current local Codex account state.
6. Run the real entry proof:

   ```bash
   O8_LIVE_CLAUDE_CODE_CODEX_ORCHESTRATOR=1 \
     npx vitest run tests/claude-code-codex-orchestrator-live-smoke.test.ts
   ```

**PASS §5:** the real process completes both chats, the warm follow-up reports more than 90% prompt-cache reads, the second chat is isolated, and no API key is required.

See [Claude Code model carriers](../user/claude-code-model-carriers.md) for the operator-facing setup and billing boundaries.

---

## 6. Mobile pairing (optional for first-10, verify if claimed)

If mobile is part of the pitch: pair a phone to the running instance and confirm the inbox/approvals surface loads over the WS bridge.

---

## PASS CRITERIA (all required)

- [ ] Signed DMG installs + launches clean on a profile that is **not** the build machine (Gatekeeper accepts; Node pre-flight OK).
- [ ] Setup wizard completes end-to-end; `setupComplete` persists across a relaunch (no silent re-loop).
- [ ] Runtime detection shows results or an explicit retry — never a silent blank (GATE-2a).
- [ ] A missing `codex`/`gh` produces a **dispatch-time** UI error with a fix command (GATE-2b).
- [ ] One packet went dispatch → review → **explicit approve** → merge; the diff was correct.
- [ ] No never-reviewed packet can reach `main` (GATE-1a invariant holds).
- [ ] If this release changes the Codex subscription carrier, the opt-in live carrier test passed and two orchestrator chats stayed isolated.
- [ ] No crash, no "Application error," no orphaned processes after quit.

**Run this 2–3× on a clean profile. Only an all-green run unlocks the first warm invite.** Watch the first real installs like a live red-team and fix friction same-day.
