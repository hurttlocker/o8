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
