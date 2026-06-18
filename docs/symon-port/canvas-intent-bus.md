# Canvas Intent Bus — Symon → o8 contract (#1232 phase 2)

**What this is:** the loopback HTTP contract that lets Symon (or any local agent
surface) drive o8's Canvas mode by voice — enter the canvas, open the browser,
ask the Brain a question, message the orchestrator, zoom, dock. One POST per
intent; the verb
executes through the **same handlers the canvas rail buttons call**, so behavior
never forks from what the operator gets by clicking.

Sibling tier (phase 1): `/api/browser/agent` drives the *embedded browser*
(read/click/type/probe with ghost cursor) — same transport, documented at the
bottom.

---

## Transport

```
POST http://127.0.0.1:<api-port>/api/canvas/intent
Content-Type: application/json

{ "verb": "<verb>", "args": { … }, "ensure": true }
```

- **Port:** read `~/.o8/api-port` (the Tauri sidecar writes it at launch).
  Never hardcode 3001.
- **Auth:** loopback callers pass the middleware gate automatically. A
  non-loopback caller must send `Authorization: Bearer <~/.o8/ws-token>`.
- **`ensure`** (default `true`): when the webview isn't on the canvas route,
  the bridge SPA-navigates it to `/preview/canvas-glass` and waits (≤10s) for
  the intent listener to mount before dispatching. Pass `false` to only
  dispatch if the canvas is already up.

## Response

```json
{ "ok": true,  "verb": "ask-brain", "navigated": true }
{ "ok": false, "verb": "send-prompt", "note": "orchestrator not ready — no repo scoped, busy, or not connected" }
{ "ok": false, "error": "canvas not open (current route: /dashboard)", "route": "/dashboard", "navigated": false }
```

`ok` is the page-side ack — the listener ran the handler synchronously and
reported back. `note` carries the page's reason on a soft failure. `error`
means the intent never reached a mounted listener (app closed, canvas flag
off, navigation timed out).

## Verbs

| Verb | Args | What it does |
|---|---|---|
| `enter` | — | Just bring the Canvas up — "open / enter / show / go to the canvas". No further action; the `ensure:true` navigation IS the action (a no-op when already on the canvas). The bare open verb so "open canvas" never falls through to a panel. |
| `send-prompt` | `{ text }` | Message the orchestrator, scoped to the canvas's active repo — same path as the bottom composer. The dock opens when the reply streams. **The marquee voice verb.** |
| `ask-brain` | `{ question? }` | Spawn (or focus) the Engineering Brain card; with `question`, the card asks it immediately and streams the cited answer. |
| `open-browser` | `{ url? }` | Reveal the embedded browser — new tab per URL, reuses an exact match. No URL → app dashboard. |
| `open-spec` | — | Spawn (or focus) the o8.md spec card for the active repo. |
| `spawn-terminal` | — | Spawn a terminal card cwd'd to the active repo. |
| `search` | `{ query? }` | Open canvas search, optionally pre-filled — results include cards, threads, and default-surface hits. |
| `zoom` | `{ level }` or `{ direction }` | `level` ∈ 1 \| 0.85 \| 0.7, or `direction` `in`/`out` steps through them. |
| `dock` | `{ open? }` | Open/close the conversation dock; no arg toggles. |

## Suggested Symon tool registration (Tier-2 dispatch family)

One tool, verb-enum'd — keeps Gemini Flash's schema small:

```json
{
  "name": "o8_canvas",
  "description": "Drive o8's Canvas: open the canvas itself (enter), message the orchestrator (send-prompt), ask the Engineering Brain (ask-brain), open the browser/spec/terminal, search, zoom, toggle the dock.",
  "parameters": {
    "type": "object",
    "properties": {
      "verb": { "type": "string", "enum": ["enter", "send-prompt", "ask-brain", "open-browser", "open-spec", "spawn-terminal", "search", "zoom", "dock"] },
      "text": { "type": "string", "description": "send-prompt: the message for the orchestrator" },
      "question": { "type": "string", "description": "ask-brain: the question" },
      "url": { "type": "string", "description": "open-browser: target URL" },
      "query": { "type": "string", "description": "search: pre-filled query" }
    },
    "required": ["verb"]
  }
}
```

Symon-side handler: map flat params into `{ verb, args }` and POST. Safety
class **Reversible** (it changes what's on the operator's screen, never
repo state) — `send-prompt` reaches the orchestrator, which is itself gated
by o8's review/approval pipeline, so no extra confirm card is needed beyond
Symon's normal trust settings.

Voice grammar examples:
- "open the canvas" / "go to the canvas" / "show me the canvas" → `enter`
- "ask the brain why the merge gate exists" → `ask-brain {question}`
- "tell the orchestrator to fix the failing test" → `send-prompt {text}`
- "open the browser on localhost three thousand" → `open-browser {url}`
- "zoom out" → `zoom {direction: "out"}`

## Phase 1 sibling — `/api/browser/agent`

Same transport, drives the *embedded browser* (canvas browser cards + the
Browser tab): `{ verb: read|click|type|probe|open, args, packetId? }`.
`read` returns page text + interactive elements with stable selectors;
`click`/`type` paint a ghost cursor + amber card glow the operator can watch;
packet-attributed calls record `browser_acted` lane events. Workers reach it
as the `o8 browser` CLI (see AGENTS.md); Symon can call the route directly
for voice-driven browsing of localhost pages.
