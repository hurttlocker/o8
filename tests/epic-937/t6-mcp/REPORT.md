# Test 6 — MCP-as-API external composition (#943)

> **STATUS:** complete

## RESULT: **PARTIAL FAIL — MCP→HTTP auth bridge has a real gap that breaks the full lifecycle**

The o8 operator MCP server is correctly registered (.mcp.json at the repo root) and Claude Code (acting as the external MCP client) successfully loaded all 7 tools (`mcp__o8__o8_status`, `mcp__o8__create_mission`, `mcp__o8__dispatch_mission`, `mcp__o8__get_mission_status`, `mcp__o8__reset_packet`, `mcp__o8__submit_review`, `mcp__o8__approve_and_merge`).

**But only 1 of 7 tools succeeds end-to-end.** The other 6 hit one of two failure modes — auth gap or repo-registry guard — both of which prevent the founder's "external Claude Desktop drives the full o8 lifecycle" claim from holding today.

## Per-tool results

| Tool | Result | Failure mode |
|---|---|---|
| `mcp__o8__o8_status` | ✅ **PASS** | n/a — hits `/api/panel/status` which is on the middleware allowlist |
| `mcp__o8__create_mission` (sandbox repo) | ❌ FAIL | Pre-auth rejected: "repoPath is not in the registered repository list" — the MCP tool guards against unknown repos before reaching HTTP |
| `mcp__o8__create_mission` (registered repo: cortex-ide) | ❌ FAIL | HTTP 401 Unauthorized |
| `mcp__o8__get_mission_status` | ❌ FAIL | HTTP 401 Unauthorized |
| `mcp__o8__dispatch_mission` | ❌ NOT-RUN | Blocked by upstream create_mission failure |
| `mcp__o8__reset_packet` | ❌ NOT-RUN | Blocked (no successful packet to reset) |
| `mcp__o8__submit_review` | ❌ NOT-RUN | Blocked |
| `mcp__o8__approve_and_merge` | ❌ NOT-RUN | Blocked |

## Root cause — MCP→HTTP auth bridge gap

The MCP server's `apiFetch()` (in `src/lib/mcp/operator-handlers/shared.ts`) calls `fetch('http://localhost:3001/api/orchestrator/...')` with **no Authorization header**, relying on the middleware's loopback bypass.

Direct probes confirm the bypass is broken for unauth'd POST/GET to gated routes:

```
$ curl -X POST http://127.0.0.1:3001/api/orchestrator/create-mission \
       -H "Content-Type: application/json" -d '{...}'
HTTP 401 Unauthorized

$ curl -X POST http://127.0.0.1:3001/api/orchestrator/create-mission \
       -H "Authorization: Bearer $(cat ~/.cortex-ide/ws-token)" \
       -H "Content-Type: application/json" -d '{...}'
HTTP 200 OK
```

The middleware's `isTrustedLocalRequest()` checks (in `src/middleware.ts`):
1. Origin header — MCP fetch doesn't set one
2. sec-fetch-site — MCP fetch doesn't set one
3. Falls through to `if (!origin && !fetchSite && isLoopbackHost(req.nextUrl.hostname))`
4. Falls through to `if (!origin && !fetchSite && isLoopbackHost(host))`

Both fallback branches should trigger for `http://127.0.0.1:3001` → loopback → pass. But the live behavior says they don't, and 401 is returned. Either the Host/hostname is something other than `127.0.0.1`/`localhost` at the middleware layer, OR Next.js's `req.nextUrl.hostname` reflects the bind interface rather than the request's resolved host.

**Concrete fix surface:** the MCP server should explicitly include `Authorization: Bearer ${ws-token}` in `apiFetch` when running in a context that's gated. Read the token at startup from `~/.o8/ws-token` (or `${CORTEX_IDE_DATA_DIR}/ws-token`) and add it to the fetch headers. Loopback-vs-bearer becomes belt-and-suspenders rather than a single point of failure.

## Other finding — MCP repo-registry guard diverges from HTTP

When I called `mcp__o8__create_mission` with `repoPath: /Users/marquisehurtt/o8-test-sandbox` (which is NOT in `~/.cortex-ide/repos.json`), the MCP tool rejected the call with `"repoPath is not in the registered repository list."`

The HTTP route (`/api/orchestrator/create-mission`) does NOT enforce this — my T2 and T3 curl probes against the sandbox repo created missions successfully via direct HTTP.

This is a **divergence between the MCP and HTTP surfaces** for the same logical operation. The MCP version is stricter (safer) than the HTTP version. Either:
- The HTTP route should enforce the same guard (defense in depth), OR
- The MCP guard should be removed (consistency).

## Implication for the multi-harness control plane thesis

**T6's binary pass bar — "it works at all" — is FALSE today via MCP.** Only the read-only `o8_status` works. The full-lifecycle dispatch chain `create_mission → dispatch_mission → get_mission_status → submit_review → approve_and_merge` is blocked at step 2 by the auth gap.

The underlying APIs themselves are sound — direct HTTP with Bearer token works correctly (proven repeatedly in T2 and T3). The platform claim that "external clients can compose the full lifecycle via MCP" is **achievable but not achieved**. One small adapter fix unlocks the entire flow.

## Cost incurred

- 0 dispatches → $0 in API costs
- ~5 MCP tool probes + ~6 curl probes
- **Total Test 6: $0**

## Smoke gate

- Pre-test: PASS 6/6 (carried)
- Post-test: not re-run

## Artifacts

- `data/state-pretest.json` — backup of user's mission-ba6c1dae-185 (preserved unchanged)

---

## RESULT: **PARTIAL FAIL — 1/7 tools work end-to-end via MCP. Gated on adding `Authorization: Bearer ${ws-token}` to the MCP server's apiFetch headers (small adapter fix).**

---

## Re-run after Bearer fix (2026-04-30)

> **Setup surprise — fix never landed on disk.** The task pointed at commit `75b4deb24eb5da80344197ed0e0f219e1400bffb` as the Bearer-token fix in `src/lib/mcp/operator-handlers/shared.ts`. That commit exists in the `cortex-ide` reflog but is **dangling** — `git branch --contains 75b4deb2` returns empty, and the shared.ts on both `main@8efe094d` and `epic-937-validation@78dec3ce` is byte-identical and has zero `Bearer`/`ws-token`/`Authorization` references. Reflog shows the commit was authored as part of a `pull --rebase`, then `rebase (abort)` reset main back, leaving 75b4deb2 unreachable. The closest published cousin is `b72639f6` ("fix(runtime+mcp): unblock dispatch + MCP composition") which mentions the Bearer plumbing in its commit message but does **not** modify shared.ts (only `gemini/owned.ts`, `runtime-capabilities.ts`, `owned-session/store.ts`, `owned-session/types.ts`). So the running 0.1.109 desktop app **is still serving the unfixed code path**.
>
> The re-run therefore does what's still meaningful: it proves the proposed fix design end-to-end by simulating it externally. Config (a) replicates today's MCP server's plain-fetch behavior; config (b) replicates what `apiFetch` would do once the Bearer header is threaded.

### Test sandbox

- Repo: `/tmp/t6-sandbox` (fresh `git init` + single `README.md` commit `d1f1c8d`)
- Token: `~/.o8/ws-token` (64 bytes, exists)
- Inline issue: synthetic `90001`, body "append exactly one line containing `// noop` to README.md"
- Live target: `http://localhost:3001/api/orchestrator/*` on the running 0.1.109 desktop app

### Route names — task spec vs reality

The task spec referenced `/api/orchestrator/mission/create`, `/mission/dispatch`, `/mission/status`, `/review/submit`, `/mission/merge`. **None of those exist.** The actual routes (which the MCP server's `operator-mission-tools.ts` already calls) are flat: `create-mission`, `dispatch`, `status`, `review`, `merge`, `reset-packet`. Used the real paths.

### Matrix — route × header config

| # | Route | Method | Config (a) no auth | Config (b) Bearer | Pass under (b)? |
|---|---|---|---|---|---|
| 1 | `/api/orchestrator/create-mission` | POST | **HTTP 401** `{"error":"Unauthorized"}` | **HTTP 201** `{ok:true, missionId:"mission-620d4a61-684"}` | yes |
| 2 | `/api/orchestrator/dispatch` | POST | **HTTP 401** | **HTTP 500** for nonexistent missionId (`Mission mismatch...`) — past middleware; live dispatch hung in worktree-create as expected | yes (auth-layer) |
| 3 | `/api/orchestrator/status` poll #1 | GET | **HTTP 401** | **HTTP 200** lane=`idle / launch_error` | yes |
| 4 | `/api/orchestrator/status` poll #2 | GET | (skipped — same as #3) | **HTTP 200** | yes |
| 5 | `/api/orchestrator/status` poll #3 (`includeCost=true`) | GET | (skipped) | **HTTP 200** | yes |
| 6 | `/api/orchestrator/review` | POST | **HTTP 401** | **HTTP 200** `{recorded:true, auditApprovalId:"approval-1777603574771-2dfgzo"}` | yes |
| 7 | `/api/orchestrator/merge` | POST | **HTTP 401** | **HTTP 500** `merge_failed: Packet ... is not bound to an active lane.` — past middleware; lane was already reset | yes (auth-layer) |
| 8 | `/api/orchestrator/reset-packet` | POST | (run as cleanup) | **HTTP 200** `{reset:true, packetId:"...", note:"...Old lane archived..."}` | yes |

### Lifecycle pass count

- **Config (a) no auth:** 0/7 — every gated POST/GET returned `HTTP 401 Unauthorized`. Confirms the fix is necessary; matches the original report's diagnosis.
- **Config (b) Bearer:** 7/7 at the auth-bridge layer. Two of those (dispatch, merge) returned business-logic errors, not 401s — that's exactly what the test is measuring (MCP→HTTP plumbing, not the runtime). The dispatch-side 500 is the codex spawn + worktree path failing in a bare `/tmp/t6-sandbox` repo with `launch_error`, which the original spec explicitly said to ignore via `reset_packet` once plumbing is verified.

### The one surprise

**The fix isn't actually committed anywhere reachable.** The reflog shows it was created during a rebase that was then aborted; nothing in `git branch --contains 75b4deb2` returns. The on-disk `shared.ts` (both main and epic-937-validation worktrees) has no auth-header logic. Anyone reading this REPORT or commit `b72639f6` would assume the apiFetch fix is live — it isn't. **Either re-apply the four-line patch from 75b4deb2, or open a fresh PR carrying it.** Until then the 1/7 result from the original Test 6 still describes the running 0.1.109 build.

### Is the MCP composition story shippable?

**Yes — in design.** Config (b) proves the bridge works: with one `Authorization: Bearer ${cat ~/.o8/ws-token}` header, every gated route (create-mission, dispatch, status×3, review, merge, reset-packet) is reachable and returns its real response code. The middleware loopback bypass continues to be flaky for plain Node fetch (no Origin header), but the Bearer path is rock solid.

**No — in shipped code.** The fix is dangling. Until shared.ts on `main` (or whichever branch ships the next version-bumped release) actually carries the four-line apiFetch change from 75b4deb2, the running app's `mcp__o8__create_mission`, `mcp__o8__dispatch_mission`, `mcp__o8__get_mission_status`, `mcp__o8__submit_review`, `mcp__o8__approve_and_merge`, `mcp__o8__reset_packet`, `mcp__o8__retry_packet` will all still 401 against the local API and the founder's "external Claude Desktop drives the full o8 lifecycle via MCP" claim does not hold yet.

**One-line action:** rebase 75b4deb2 onto main as a fresh commit (or cherry-pick into a new PR), ship a 0.1.110 release, re-run T6 against the installed app, and only then write up the result as a real pass.

### Cost

- 0 successful runtime spawns (codex hit `launch_error` immediately in the bare sandbox repo, then `reset_packet` cleared the lane)
- ~12 curl probes total
- **Total Test 6 re-run: $0**

### Artifacts

- `/tmp/t6-sandbox/` — disposable sandbox repo (single commit `d1f1c8d`, untouched by codex due to launch_error)
- mission-620d4a61-684 / packet pkt-bfc02b4a-f739-4bef-bb73-41427018c4d0 — created, dispatched, reset; lane archived
