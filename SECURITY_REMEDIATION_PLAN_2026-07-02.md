# o8 Security Remediation Plan — ROOT fixes (2026-07-02)

Companion to `SECURITY_AUDIT_2026-07-02.md` (findings) and GitHub issues #1312–#1324.
This plan fixes the **classes**, not the instances. Each root fix names the existing o8 primitives it reuses, the new code, the invariant it establishes, and the regression test that keeps the class dead. Sequenced P0→P2 with dependencies.

**Guiding principle:** every finding traces to one of five root causes. Patch the cause once and a whole column of the findings table closes. Two fixes are keystones — the **request principal model** (RF-1) and the **default-deny gate** (RF-2); the other three are contained, mechanical, and can land in parallel.

**Preserve these invariants while fixing** (do not regress): the middleware socket-truth stamping (`scripts/tauri-export.mjs`), the billing/print-flag lockouts (`assertNoPrintFlag`, warm REPL pool, Brain daily cap), inline-styles-only, no-emoji, no-hardcoded-ports, and the WORKER_PREFIXES self-auth bypass for genuinely off-host workers.

---

## 0. Threat-model honesty (read before RF-1)

The deepest finding (CRIT-1 and the worker-escalation chain) exists because **a dispatched local worker runs as the operator's uid** — so it can read any file the operator's process can, including any file-based credential. **On a single-uid box, no secret on disk cryptographically separates operator from worker.** Therefore the remediation is two-tier and the plan says so plainly:

- **Tier 1 — principal + scoping (this plan's P0/P1).** Stops the *realistic* threat: a **prompt-injected worker following malicious instructions** ("run `o8 inbox approve X`", "call approve_and_merge"). The worker's environment never contains the operator credential and its verbs are packet-scoped, so the injected instruction fails. This ships fast and closes the issues as filed.
- **Tier 2 — OS isolation (P2, larger lift).** Stops a *fully malicious* worker that would independently hunt for a file-read primitive. Run local workers under `sandbox-exec`/a separate uid/a container with FS confined to their worktree — the same isolation o8 already gets "for free" from off-host workers on a separate machine. Until then, Tier 1 is defense-in-depth, not cryptographic isolation, and the plan labels it as such.

This honesty *is* the spec: shipping Tier 1 and calling it "isolation" would be the same category of error the audit found.

---

## 1. KEYSTONE — the request principal model (RF-1 foundation)

**Problem class (Root Cause A):** governance authorizes on *transport reachability* ("loopback = trusted") and *self-asserted body flags* (`requestedByWorker`, hardcoded `actor:'desktop'/'user'`). Loopback ≙ any same-uid process ≙ the worker. Covers **CRIT-1, HIGH-4, HIGH-5, HIGH-6**.

**Fix:** every request resolves to exactly one **principal**, and every governance verb authorizes on it. Reuse the existing, already-correct `worker_tokens` machinery — off-host workers already authenticate this way; **local workers are the gap.**

### 1.1 Principals

| Principal | Evidence | Where it comes from |
|---|---|---|
| `operator` | holds the **operator-token** | new: `~/.o8/operator-token` (0600), injected into the webview HTML **only on loopback page loads** (reuse `headersIndicateLoopback` + the meta-tag pattern already used for the mobile ws-token), read by the webview, sent on privileged calls. Never placed in a worker's env. |
| `worker:<packetId>` | holds a **scoped worker-token** | reuse `createToken()` (`src/lib/worker/tokens.ts:100`) at dispatch, `scope` bound to the packet/lane; stamp into the worker env as `O8_WORKER_TOKEN` (+ `O8_WORKER_PACKET_ID`) at the spawn chokepoint. Revocable via existing `revokeToken`. |
| `mobile:<deviceId>` | active per-device token | existing (`device-registry`, `middleware.ts` per-device path). |
| `unknown` | none of the above | default → denied for governance verbs. |

### 1.2 New primitive: `resolvePrincipal(req)`

`src/lib/auth/principal.ts` — pure resolver used by governance routes and the gate:
```
resolvePrincipal(req): { kind:'operator' } | { kind:'worker', packetId, tokenId } | { kind:'mobile', deviceId } | { kind:'unknown' }
```
- operator-token present + matches (constant-time) → `operator`.
- else `verifyWorkerToken(authHeader)` (`worker/auth.ts:22`, already SHA256 + `timingSafeEqual` + revocation) → `worker` with the packet binding read from the token's `scope`.
- else active device token → `mobile`.
- else `unknown`.

Loopback origin alone is **necessary but not sufficient** for `operator` — it must also present the operator-token. This is the single line that breaks the "loopback = operator" equivalence.

### 1.3 Capability matrix (authorize verbs, not reachability)

| Verb / route | operator | worker (own packet) | worker (other packet) | mobile |
|---|---|---|---|---|
| `POST /api/panel/approvals` approve/reject | ✓ | ✗ → 403 | ✗ | ✓ |
| lane merge with `actor:'user'` | ✓ | ✗ (worker semantics → card) | ✗ | ✓ |
| `steer/reset/rerun/merge-packet` | ✓ any | ✓ own only | ✗ → 403 | ✓ any |
| `file-io` / `file-content` write/read | ✓ registered roots | ✓ own worktree only | ✗ | ✓ registered |
| `dev-server` / ws `terminal-spawn` shell | ✓ | ✗ → 403 | ✗ | ✗ |
| webview eval socket (`o8_view_eval`) | ✓ (socket token) | ✗ | ✗ | n/a |

### 1.4 Concrete changes (RF-1)

1. **Mint + stamp local worker tokens.** At the packet dispatch spawn (the env chokepoint at `src/lib/lane/codex-orchestrator-session.ts:438` and the sibling runtime launch env builders — the same spread that already sets `O8_MANAGED_SESSION`), call `createToken({ scope: 'packet:'+packetId, maxWorkers: 1 })`, add `O8_WORKER_TOKEN` + `O8_WORKER_PACKET_ID` to the worker env, and revoke on packet terminal state. **This is the one missing stamp** the CLI comment at `cli/src/commands/packet/recover.ts:187` already assumes exists.
2. **Operator-token issuance + injection.** Generate on first run (CSPRNG, 0600) via a `getOrCreateOperatorToken()` mirroring `getOrCreateWsToken`. Inject into the desktop shell HTML on loopback loads only (same guard as the mobile token meta-tag). Webview sends it on privileged calls.
3. **`POST /api/panel/approvals` (CRIT-1):** at handler entry, `resolvePrincipal(req)`; if not `operator` → 403. Derive `resolveApproval(..., actor)` and the lane `dispatch({..., actor})` from the principal — **delete the hardcoded `'desktop'` (`route.ts:175`) and `'user'` (`route.ts:264`).** `actor:'user'` is emitted only for an `operator` principal.
4. **`POST /api/orchestrator/merge` (HIGH-4):** delete the `requestedByWorker` body branch (`route.ts:40`); derive worker-vs-operator from the principal. A `worker` principal always gets `raiseWorkerMergeApproval` (the existing card path in `commands.ts:260-276`); it cannot self-select the operator path.
5. **`steer/reset/rerun/merge-packet` (HIGH-4):** if principal is `worker`, assert `req.packetId === principal.packetId` (server-side ownership), else 403.
6. **Webview eval socket (HIGH-5):** set `tauri_plugin_mcp` `auth_token` in `src-tauri/src/lib.rs:3743-3753` (a random per-launch token written 0600); hand it only to the bundled operator MCP server. Workers have no token → socket refuses `execute_js`.

**Invariant:** *No governance state transition is authorized by loopback reachability alone; every one authorizes on a resolved principal, and the `actor`/`requestedByWorker` values are server-derived, never client-supplied.*

**Regression test:** `tests/principal-authz.test.ts` — for each governance route, assert (operator-token → allowed), (worker-token → 403 or card), (worker-token + cross-packet id → 403), (no credential loopback → 403 for approve/merge/shell). Fails if a new governance route skips `resolvePrincipal`.

---

## 2. RF-2 — Default-deny gate (Root Cause B)

**Problem class:** the gate is an allowlist-by-`startsWith` with a **fail-open default** (unlisted `/api/*` route → passes) and a **trailing-slash gap** (`/api/board/` misses the bare `/api/board`), plus a **divergent weak helper** (`requirePanelAuth`). Covers **HIGH-1, MED-2**.

**Fix — invert the gate to default-deny:**
1. In `src/middleware.ts`, change the decision from *"gate only listed prefixes"* to *"deny every `/api/*` request unless it matches an explicit policy."* Replace `needsGate()` with a per-route **policy classifier** returning one of `{ public-read, public-any, worker, gated }`. The default for any unclassified `/api/*` path is `gated` (loopback + principal), **never pass-through.**
2. Classify by **exact path or explicit prefix with a trailing-boundary check** (`p === base || p.startsWith(base + '/')`) — kills the trailing-slash class structurally.
3. Add the currently-ungated state routes to the manifest with `gated`: `/api/board`, `/api/v2/repos`, `/api/v2/keys`, `/api/tasks`, `/api/browser/proxy` (see RF-4), `/api/browser/attach`, `/api/browser/inventory`, `/api/tts`.
4. **Retire `requirePanelAuth`/`isTrustedPanelRequest`'s divergent logic** (`src/lib/panel/auth.ts:11-31`): re-export a thin wrapper that delegates to `@/lib/auth/loopback-request` + `resolvePrincipal`. Drop `origin===nextUrl.origin` and the host-less `sec-fetch-site` trust. In-handler auth becomes defense-in-depth over the same logic, so the two can never diverge again.

**Invariant:** *Every `/api/*` route has an explicit policy; the default is deny. There is exactly one implementation of loopback/principal trust.*

**Regression test (the class-killer):** `tests/route-coverage.test.ts` — enumerate every `src/app/api/**/route.ts`, assert each resolves to a policy in the manifest, and **fail the build if any route is unclassified.** This converts "someone added a route and forgot the gate" from a silent vuln into a red test. Extend `tests/middleware-gate.test.ts` with the trailing-slash cases (`/api/board` vs `/api/board/x`).

---

## 3. RF-3 — Untrusted content never reaches a code sink (Root Cause C)

**Problem class:** agent-authored content flows to HTML render (`dangerouslySetInnerHTML`), shell strings (`execSync` with interpolation), and un-gated tool execution. Covers **CRIT-2, HIGH-2, HIGH-3, HIGH-7**.

### 3.1 HTML sanitization (CRIT-2)
- Introduce one sanitizer boundary: `src/lib/render/sanitize-html.ts` wrapping **DOMPurify** (SVG profile; forbid `<script>`, `<iframe>`, `on*`, SMIL `<animate>/<set>` event attrs, `javascript:` URLs). **Every** `dangerouslySetInnerHTML` that can carry agent content routes through it — `markdown-render.tsx:216-238` (`InlineSvg`/`PassthroughIframe`), `LLMMarkdown.tsx:510` (Mermaid), `CodeBlock.tsx:249,356`. Prefer the existing **SVG-as-data-URL-`<img>`** pattern (`CanvasResourceViewers`, `ReviewFileRow`) where feasible.
- **Delete `PassthroughIframe`'s live-iframe path** — markdown must not emit an agent-controlled `<iframe>`. If HTML preview is a real feature, render it in a `srcdoc` iframe with a fixed `sandbox="allow-scripts"` (no `allow-same-origin`), never a sandbox the source can override.
- **Defense-in-depth CSP** on the webview: a `Content-Security-Policy` that forbids inline script execution in the app document and restricts `connect-src`, so even a sanitizer miss cannot `fetch()` the loopback API. (Verify it doesn't break the legitimate app; scope to the main shell.)

### 3.2 No shell-string interpolation of content (HIGH-2)
- Replace `execSync` template literals in `src/lib/llm/tools.ts:737-742,766-772` with `execFile('grep', [...])` / `execFile('find', [...])` — array-args make `query`/`pattern`/`filePattern` inert tokens. Mirror the safe tokenize+allowlist in `google-native-execution.ts:559-580`.
- **Class-killer:** promote the repo's own `merge-gate.ts:53` detector (`execSync(...${...})`) into a **CI lint rule over the whole `src/` tree**, not just agent diffs. Any new template-literal `exec*` fails CI.

### 3.3 All tool execution through the policy gate (HIGH-7, HIGH-3)
- `o8-scratch-chat/route.ts:386` must route `executeTool` through `evaluatePolicy`/`createApproval`, identical to `v2/proxy/llm/route.ts:604-716`. No surface calls `executeTool` directly.
- `runTerminalCommand` (`tools.ts:588-592`) must honor `needs_approval` (stop trusting the porous `BLOCKED_PATTERNS` denylist as the sole control).
- The shell primitives `dev-server` (`route.ts:61`) and ws `terminal-spawn` (`ws-server.ts:1322`) become `operator`-principal-only (RF-1) and the ws-server internal POSTs additionally require a loopback socket (independent of the token).

**Invariant:** *Agent content is data at every sink: HTML is sanitized before render, command args are array-tokens never shell strings, and no tool executes without passing the policy/approval gate.*

**Regression tests:** DOMPurify unit tests with SVG/iframe/`on*`/SMIL payloads; `search_code({query:'$(touch /tmp/x)'})` asserts no file created; scratch-chat with a `run_terminal_command` call asserts an approval card, not execution.

---

## 4. RF-4 — One safe-path helper + SSRF lockdown (Root Cause D)

**Problem class:** each file route hand-rolls its own traversal check (some correct, some trivially bypassable), and an ungated server-side fetch can loop back into the gated API. Covers **CRIT-3, HIGH-6, PL-2**.

**Fix:**
1. **Single `safeRepoPath(rootKind, relPath, principal)` helper** (`src/lib/fs/safe-path.ts`) built on the *correct* pattern already in `panel/file-asset/route.ts:36-39` (`resolve` → `relative` → reject `..`/absolute). **All** file routes use only this helper — `file-content` (delete the `workspace`-as-root + `startsWith` guard at `file-content/route.ts:24-30`), `file-io`, `serve-image`, `file-asset`. The `root` must resolve to a **registered repo/worktree** (via the repo registry), never a caller-supplied absolute path; a `worker` principal is confined to its own worktree (RF-1).
2. **SSRF lockdown of `/api/browser/proxy`:** gate it (RF-2) so the legitimate in-webview iframe passes via loopback socket truth and a LAN caller cannot reach it; set `redirect:'manual'`; after fetch, re-validate the *resolved* URL against the localhost allowlist; **deny the app's own api/ws ports** so it can never launder into o8's gated API.

**Invariant:** *No route reads/writes a path outside the caller's registered-repo scope; no server-side fetch can target o8's own API ports; there is one path-safety implementation.*

**Regression test:** `file-content?workspace=/&path=etc/hosts` → 403; `browser/proxy?url=…localhost:<api-port>/api/panel/file-content…` → 400; a worker principal reading outside its worktree → 403.

---

## 5. RF-5 — Secrets & crypto key-source hardening (Root Cause E)

Covers **MED-1, PL-1, PL-4, PL-6.** Mechanical, no dependencies:
- **MED-1:** in `src/lib/db/master-key.ts`, on non-macOS generate + persist a random key file (0600) instead of `DEV_STATIC_KEY` (`:33`); never return the constant. Consider libsecret (Linux) / DPAPI (Windows). Keep the macOS Keychain path (it fails closed correctly).
- **PL-1:** `chmod 0600` the DB + `-wal`/`-shm` and `.env.local` on create; `0700` on `~/.o8`.
- **PL-6:** constant-time compares for the ws-token in `ws-server.ts:3861,4566` and `panel/auth.ts:41` (use `timingSafeEqual`, matching `verifyWorkerToken`).
- **PL-4:** set a passphrase on the signing key + tighten CI-secret handling (operational; the key file is already 0600).

**Invariant:** *Encryption-at-rest uses a per-install random key on every platform; secret files are 0600; all token compares are constant-time.*

---

## 6. Sequencing & dependencies

**P0 — remote RCE / supply-chain / the moat (this week):**
1. **RF-4** SSRF lockdown + `safeRepoPath` → closes CRIT-3 + Chain A/B (remote, zero-cred). *No dependencies — ship first.*
2. **RF-3.1** DOMPurify in `markdown-render.tsx` (+CSP) → closes CRIT-2 + Chain C. *No dependencies.*
3. **RF-1 steps 1-5** principal model + `POST /api/panel/approvals` operator-only → closes CRIT-1. *Foundation for HIGH-4/5/6.*

**P1 — LAN / local escalation:**
4. **RF-2** default-deny gate + route-coverage test → closes HIGH-1, MED-2 (depends on `resolvePrincipal` from RF-1).
5. **RF-3.2/3.3** `execFile` + tool-gate + shell-principal → closes HIGH-2, HIGH-7, HIGH-3.
6. **RF-1 step 6** webview socket `auth_token` → closes HIGH-5. **RF-4** worktree-scoping → closes HIGH-6.

**P2 — hardening + true isolation:**
7. **RF-5** (MED-1, PL-1/4/6).
8. **Tier-2 OS sandbox** for local workers (sandbox-exec / uid / container) — the true isolation behind Root Cause A; multi-week, tracked separately. Until it lands, RF-1 is labeled defense-in-depth.

**Dependency graph:** RF-1 (`resolvePrincipal`) is a prerequisite for RF-2's principal classification and for the worktree-scoping in RF-4/RF-1.6. RF-4 and RF-3.1 are independent and ship immediately.

---

## 7. Why these are ROOT fixes (not patches)

| Root cause | Instances it spawned | The one change that kills the class |
|---|---|---|
| A. Authz on reachability, not principal | CRIT-1, HIGH-4, HIGH-5, HIGH-6 | `resolvePrincipal` + capability matrix + Tier-2 sandbox |
| B. Fail-open `startsWith` gate | HIGH-1, MED-2, trailing-slash | default-deny classifier + route-coverage test |
| C. Untrusted content → code sink | CRIT-2, HIGH-2, HIGH-3, HIGH-7 | one sanitizer boundary + `execFile`-only + one tool-gate + CI lint |
| D. Per-route hand-rolled path/fetch checks | CRIT-3, HIGH-6, PL-2 | one `safeRepoPath` + own-port SSRF deny |
| E. Non-random key source / weak file perms | MED-1, PL-1/4/6 | per-install random key + 0600 + constant-time |

Each row's "one change" is enforced by a **regression test that fails when the class recurs** — the route-coverage test (B), the principal-authz test (A), the `execSync`-template CI lint (C), and the path-safety test (D) are what make these durable rather than whack-a-mole.

---

## 8. Issue → fix mapping

| Issue | Root fix | Phase |
|---|---|---|
| #1312 CRIT-1 | RF-1 (§1.4.3) | P0 |
| #1313 CRIT-2 | RF-3.1 | P0 |
| #1314 CRIT-3 | RF-4 | P0 |
| #1315 HIGH-1 | RF-2 | P1 |
| #1316 HIGH-2 | RF-3.2 | P1 |
| #1317 HIGH-3 | RF-3.3 + RF-1 | P1 |
| #1318 HIGH-4 | RF-1 (§1.4.4-5) | P0/P1 |
| #1319 HIGH-5 | RF-1 (§1.4.6) | P1 |
| #1320 HIGH-6 | RF-4 + RF-1 | P1 |
| #1321 HIGH-7 | RF-3.3 | P1 |
| #1322 MED-1 | RF-5 | P2 |
| #1323 MED-2 | RF-2 | P1 |
| #1324 MED-3 | RF-3.2 (branch validation) | P1 |

Remediation is the operator's to implement; this plan is the design. Recommend one PR per root fix (RF-1..RF-5), each landing with its regression test, in the P0→P2 order above.
</content>
