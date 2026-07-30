# Roughdraft Ingestion Blueprint — porting the markdown-review LOGIC into o8.md

Status: Plan / read-only audit. No o8 source was modified producing this doc.
Audited source: `roughdraft@0.1.8`, cloned from `https://github.com/Lex-Inc/roughdraft`
(npm repo field confirms this URL; product is "Roughdraft", a local markdown review
app by Nathan Baschez / Lex-Inc). Commit `78af393` at clone time.

Goal: adopt Roughdraft's **review FORMAT** (Roughdraft Flavored Markdown = Markdown +
CriticMarkup + a compact attribute grammar) and **review LOOP** (read index → leave
comments/suggestions → agent replies/resolves in-file) into the existing o8.md feature,
so the orchestrator, dispatched agents, AND external Claude sessions (Claude Code /
Desktop / cowork) can read and annotate `<repoPath>/o8.md`. We do NOT adopt their
per-file localhost:7373 server model — o8.md is per-repo and lives inside the Tauri
panel.

---

## 0. o8 product direction (operator decisions — READ FIRST)

Two operator decisions (2026-05-21) reframe how everything below is applied:

**Decision — license: VENDOR the parser (option A).** Copy `@roughdraft/rfm` into
`src/lib/o8md/` with an SPDX header + reconstructed MIT text crediting Nathan Baschez.
The missing upstream LICENSE file reads as an oversight (package.json + README both
declare MIT); preserving the notice satisfies attribution. See §7.

**Decision — the roles are INVERTED vs Roughdraft.** This is the core product idea and
it flips the default direction of the loop:

- Roughdraft default: **agent writes** the doc, **human annotates**.
- o8 default: **the operator writes** o8.md (it's their living scratchpad for ideas +
  tasks — they're in it every session) and **the agent annotates** what the operator
  wrote. Backwards from Roughdraft, identical format.

Hard rules that fall out of the inversion:
- **The operator's prose is sacred — never overwritten.** Agents may only ADD
  annotations (comments / suggestions / replies). Suggestions (`{~~old~>new~~}`) are
  non-destructive *proposals* the operator accepts or rejects — they never auto-apply.
  The base text is human-authored and human-edited, full stop.
- Agent annotations carry `by="AI"` (the format's magic author value already supports
  this — see §1.2), so human vs agent marks are distinguishable for free and the UI can
  style agent marks differently.
- The agent's job in o8.md is to leave **thoughts / pointers**, not edits: "nice — this
  is done," "good idea, worth a packet?," a suggestion where wording could tighten, a
  flag that something's gone stale. A thoughtful collaborator reading over the shoulder.

**Feel (UI-pass — DEFER to the desktop):** agent annotations render two ways — inline
(CriticMarkup decorations over the text) AND as **margin / side notes** in a
**handwritten font**, so the AI's pointers feel alive and personal rather than
mechanical. Roughdraft's own UI (inline highlights + strike/insert + a right-side comment
rail) is a fine baseline; the differentiator is "basically a font change" — the
handwritten marginalia. The data is identical CriticMarkup; only placement + typeface
change. Do NOT build this look now — it's the gorgeous-UI pass the operator owns at the
desktop.

---

## 1. Exact spec reference (so we never need to re-clone)

### 1.0 License / provenance (VERIFY note)

- `package.json` → `"license": "MIT"`, `"author": "Nathan Baschez"`.
- `README.md` footer: "## License — MIT. Built by Nathan Baschez."
- **There is NO `LICENSE`/`LICENSE.md` file in the repo root** (confirmed via `ls` +
  `cat LICENSE*` → "NO LICENSE FILE"). The MIT declaration is package.json + README
  only. This is the one thing to flag: to satisfy MIT attribution cleanly we should
  reproduce the standard MIT text ourselves with the copyright line
  `Copyright (c) Nathan Baschez` (see §7). Worth a one-line confirmation with the
  author or checking the npm tarball/website for a canonical LICENSE before shipping
  a vendored copy.
- Package layout: pnpm workspace (`pnpm-workspace.yaml` → `packages/*`), Biome for
  lint/format, Vitest + Playwright for tests. Four packages:
  - `@roughdraft/rfm` — **the canonical parser** (zero runtime deps; THE port target)
  - `@roughdraft/app` — Vite + React + **Tiptap/ProseMirror** WYSIWYG editor
  - `@roughdraft/server` — Express server + CLI + stdio MCP server
  - `@roughdraft/skill` — empty stub ("Claude Code skill for Roughdraft", v0.1.0, no src)
- Editor library actually used: **Tiptap** (`@tiptap/core`, `@tiptap/starter-kit`,
  `@tiptap/pm/*`) for the app editor; **marked** + **turndown** for markdown↔HTML; the
  canonical `rfm` parser is **hand-rolled, regex-free, dependency-free** (an offset
  scanner). So there are effectively TWO parsers in the repo (see §1.4).

### 1.1 CriticMarkup syntax supported

From `docs/spec/roughdraft-flavored-markdown.md` ("Canonical Markers") + README:

| Kind | Delimiters | Example |
|---|---|---|
| Comment | `{>>` … `<<}` | `{>>Needs a source.<<}` |
| Insertion (addition) | `{++` … `++}` | `{++one concrete example++}` |
| Deletion | `{--` … `--}` | `{--vague phrasing--}` |
| Substitution | `{~~` old `~>` new `~~}` | `{~~rough~>specific~~}` |
| Highlight (anchor) | `{==` … `==}` | `{==this sentence==}` |

Rules (MUST per the spec, RFC-2119 language):
- Markers are review delimiters **only outside inline code spans and fenced code
  blocks**. Inside `` `...` `` and ```` ```...``` ```` they are literal example text and
  MUST NOT produce review items.
- Comment text MUST NOT contain a raw close delimiter (`<<}` etc.) unless an escaping
  extension is defined; Roughdraft has none, so writers MUST reject such text (the
  parser enforces this on write — see `assertSafeCommentBodyText`).

### 1.2 Metadata-attribute grammar (the high-value bit — CONFIRMED)

Canonical metadata is an attribute block written **immediately after** a comment or
suggestion marker. EBNF from the spec:

```ebnf
metadata  = "{" 1*attribute "}"
attribute = name "=" quoted-value
name      = ALPHA *( ALPHA / DIGIT / "_" / "-" )
```

- Values are **double-quoted**. Inside a value, `\"` = literal quote, `\\` = literal
  backslash. (Parser: `parseCanonicalMetadata` + `escapeMetadataAttributeValue`.)
- Attribute names match `/^[A-Za-z][A-Za-z0-9_-]*$/`.
- At least one attribute is required for the block to be recognized (a bare `{}` is not
  metadata).

Canonical attributes (spec table):

| Attr | Applies to | Required on write | Meaning |
|---|---|---|---|
| `id` | comments + suggestions | **yes** | stable document-local id |
| `by` | comments + suggestions | **yes** | author/agent label; `AI` = agent author |
| `at` | comments + suggestions | **yes** | ISO-8601 timestamp |
| `re` | comments | no | parent comment/suggestion id (threaded reply) |
| `status` | both | no | review state; Roughdraft writes `resolved` when addressed |
| `resolved` | both | no | short resolution summary when `status="resolved"` |

Real example (from the spec; this is the exact wire format):

```markdown
Please revisit {==this sentence==}{>>Needs a source.<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}.
```

Threaded reply (note `re` points at the parent id):

```markdown
{==this sentence==}{>>Needs a source.<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}{>>I can add one.<<}{id="c2" by="AI" at="2026-04-28T12:05:00.000Z" re="c1"}
```

> The operator's guess (`{>>comment<<}{id="..." by="..." at="..." re="..."}`) is **correct**.
> Confirmed additions: `status` + `resolved` attributes; values are double-quoted;
> `at` MUST be ISO-8601; ids are document-local (`c1`,`c2`… for comments, `s1`,`s2`…
> for suggestions). `AI` is the magic author value identifying an agent.

ID conventions (MUST/SHOULD): comments `c1, c2, …`, suggestions `s1, s2, …` (parser:
`nextCommentId` scans existing `^c(\d+)$` ids and returns max+1). Unknown valid
attributes MUST be preserved on round-trip and MUST NOT be required for rendering.

Legacy metadata (read-only compat): `{@id:c1; by:AI; at:...@}` — semicolon-separated
`key:value`. Readers MAY accept; writers SHOULD emit canonical. The parser accepts it
with a `legacy-metadata` warning and counts it in `summary.legacyMetadata`.

### 1.3 Roughdraft Flavored Markdown spec + review-index JSON schema

- Spec file: `docs/spec/roughdraft-flavored-markdown.md` (RFM 0.1, "Draft"). Full grammar
  reproduced in §1.1–§1.2 above.
- Schema: `docs/spec/roughdraft-flavored-markdown.schema.json` (JSON-Schema 2020-12).
  Root requires `format` (`const "roughdraft-flavored-markdown"`), `version` (`^0\.1$`),
  `source.markdown`, `comments[]`, `suggestions[]`.
  - **comment** object requires `id, body, by, at`; optional `re`, `anchor{text,markdown?}`,
    `targetSuggestionId`, `status` (`enum ["resolved"]`), `resolved`, `metadata` (preserved
    unknowns).
  - **suggestion** object requires `id, kind` (`enum addition|deletion|substitution`),
    `by, at`; substitution requires `oldText`+`newText`, others require `text`; optional
    `commentIds[]`, `status`, `resolved`, `metadata`.
  - NOTE: the schema uses `if/then/else` + `allOf` for the substitution constraint. That's
    fine for a doc/JSON schema, but is **forbidden at the top level of an MCP tool
    inputSchema** under OpenAI strict mode (see §4) — keep the constraint in handler
    validation, not in tool schemas.
- Conformance fixtures: `docs/spec/fixtures/anchored-comment.json`,
  `docs/spec/fixtures/suggestion-with-reply.json` (both reproduced verbatim below — these
  are the contract test vectors). Note the JSON `source.markdown` strings end with a
  literal `\n` (escaped) and the suggestion fixture adds a derived `targetSuggestionId`
  on the reply + `commentIds` on the suggestion (not stored in markdown — derived at
  index time):

```json
// anchored-comment.json
{ "format":"roughdraft-flavored-markdown","version":"0.1",
  "source":{"markdown":"Please revisit {==this sentence==}{>>Needs a source.<<}{id=\"c1\" by=\"user\" at=\"2026-04-28T12:00:00.000Z\"}.\\n"},
  "comments":[{"id":"c1","body":"Needs a source.","by":"user","at":"2026-04-28T12:00:00.000Z","anchor":{"text":"this sentence"}}],
  "suggestions":[] }
```
```json
// suggestion-with-reply.json
{ "format":"roughdraft-flavored-markdown","version":"0.1",
  "source":{"markdown":"Add {++one concrete example++}{id=\"s1\" by=\"AI\" at=\"2026-04-28T12:05:00.000Z\"}{>>Use the launch story.<<}{id=\"c2\" by=\"user\" at=\"2026-04-28T12:08:00.000Z\" re=\"s1\"}.\\n"},
  "comments":[{"id":"c2","body":"Use the launch story.","by":"user","at":"...","re":"s1","targetSuggestionId":"s1"}],
  "suggestions":[{"id":"s1","kind":"addition","text":"one concrete example","by":"AI","at":"...","commentIds":["c2"]}] }
```

### 1.4 Parser implementation (the port target)

**Canonical parser:** `packages/rfm/src/index.ts` — 955 lines, **zero runtime deps**
(devDeps only typescript+vitest), pure ESM. NOT regex-driven for structure: it's a
single-pass **offset scanner** (`while (offset < markdown.length)`) that tracks fenced-code
state (`matchFence`) and inline-code spans (`matchInlineCodeSpan`) to skip them, then
matches the literal marker prefixes (`{==`, `{>>`, `{++`, `{--`, `{~~`) with
`startsWith`/`indexOf`. Metadata is parsed by a char-walker (`parseCanonicalMetadata`)
that handles quote-escaping. Regex is used only for small leaf checks (attribute-name
shape, ISO date, fence line). Exported surface:

- `validateRoughdraftMarkdown(md): RfmValidationResult` — diagnostics (errors/warnings),
  summary `{comments, suggestions, legacyMetadata}`. Diagnostic codes:
  `missing-metadata-{id,by,at}`, `invalid-metadata-at`, `duplicate-id`, `self-reply`,
  `missing-reply-target`, `unclosed-{comment,highlight,addition,deletion,substitution}`,
  `invalid-metadata-syntax`, `legacy-metadata`. Each carries `offset/line/column`
  (1-based, CRLF-aware via `createLineStarts`/`locationForOffset` binary search).
- `extractRoughdraftReviewIndex(md): RfmReviewIndex` — `{format, version, items[],
  diagnostics, summary}`. `items[]` are flat `RfmReviewItem`s with
  `kind: 'comment'|'suggestion'|'reply'`, `suggestionKind`, `parentId`, `author`,
  `createdAt`, `status`, `text`, `originalText`, `replacementText`, `anchorText`,
  `offset/endOffset/line/column`. (Note: this flat shape differs from the JSON-Schema's
  nested comments/suggestions shape — the schema is the interchange contract, the
  index is the in-memory shape. A small adapter maps one to the other if we want schema
  output.) Summary adds `replies` + `unresolved` counts.
- `appendRoughdraftReply(md, {parentId, message, author?, at?, id?}): string` — finds the
  parent item's `endOffset`, splices a new `{>>message<<}{id by at re=parentId}` block
  right after it. Throws if parent missing or message contains a raw close delimiter
  (`assertSafeCommentBodyText`). **Round-trip-safe**: only inserts, never rewrites
  surrounding text (test asserts byte-exact output).
- `markRoughdraftResolved(md, {targetId, summary?}): string` — locates the target's
  canonical metadata block (`findCanonicalMetadataStart` scans backward from endOffset),
  sets `status="resolved"` + optional `resolved="<summary>"`, re-serializes only that
  block. Byte-exact elsewhere (test-asserted).

**Round-trip contract** (ADR-0003 + `index.test.ts`): preserve YAML frontmatter, local
links/image paths, tables, task lists, inline+fenced code (including literal markers
inside them), and metadata escaping. The mutation helpers are *splice-only* — they never
re-emit unrelated markdown. This is the property that makes them safe to run against a
file the operator is also hand-editing.

**App parser (NOT the port target):** `packages/app/src/critic-markup/index.ts` — a
*second*, marked-based tokenizer (regex patterns `criticCommentBlockPattern` etc.) that
produces HTML with `data-comment-ids` / `data-critic-change-*` spans for Tiptap, plus a
Turndown serializer back to CriticMarkup. This exists only to drive the WYSIWYG editor
(ProseMirror marks `commentRef` + `criticChange`, decoration plugins, accept/reject
commands in `editor-extensions.ts`). It is heavyweight and Tiptap-coupled — we do NOT
port it; o8 will render decorations its own way (§3).

### 1.5 File-watching + JSON event output for agents

- Mechanism: `packages/server/src/review-events.ts` — an in-memory `ReviewEventQueue`
  (NOT a filesystem watcher). The browser app POSTs to `/api/review-events/...` when the
  user clicks **Done Reviewing**; the queue emits a `review.completed` event:
  ```ts
  { type:"review.completed", sequence, createdAt,
    documentPath, projectPath, relativePath, version,
    summary:{comments, replies, suggestions, unresolved} }
  ```
- Agents block on it via `roughdraft watch <path> --json` / the MCP
  `roughdraft_watch_review_events` tool, which long-polls `/api/review-events/watch`
  with `{projectPath, path, batchWindowSeconds(0.25), fromNow:true, timeoutSeconds?}`.
  Default = wait indefinitely; `--timeout` opts into a deadline. There's a 250ms batch
  window to coalesce bursts and a 100-event retained ring buffer.
- This is a **human→agent handoff signal**, not a generic file watcher. It is the piece
  that maps least directly to o8 (o8 already has WS + its own event bus — §3/§5).

### 1.6 CLI commands (exact behavior + flags)

Source `packages/server/src/cli.ts` (handrolled dispatcher). `KNOWN_COMMANDS`:
`open, start, status, stop, watch, mcp, doctor, help, agent-setup, criticmarkup`.

- `open <path>` — start/reuse background server, open the doc in browser/app, register a
  fresh watcher, block until the next `review.completed`, then print event JSON. Flags:
  `--no-open`, `--print-url`, `--json`, `--no-watch`, `--timeout <seconds>`. Bare
  `roughdraft <path>` is shorthand for `open` when the arg looks like a path.
- `start` — start or reuse the background server; write `~/.roughdraft/server.json`
  (`{port, pid, startedAt, url}`); print URL; exit (server keeps running). Flag `--port`.
- `status [--json]` — print server status. `--json` always exits 0 even when
  `"running": false`.
- `stop [--all]` — stop the managed background server.
- `watch <path> [--json] [--timeout]` — block for one `review.completed` event.
- `mcp` — start the experimental stdio MCP server.
- `doctor [path] [--json]` — diagnose setup, or if given a `.md` path, run
  `validateRoughdraftMarkdown` and print errors/warnings/summary. **This is the CLI
  surface of the parser** and the cleanest analog for an `o8 spec check`.
- `help [agent|criticmarkup|<command>]`, `agent-setup` (prints the install prompt),
  `criticmarkup` (prints marker examples).
- Global flags: `-h/--help`, `--version`, `--json`, `--no-color`. Exit codes: usage
  error = 2, runtime failure = 1.
- Env: `ROUGHDRAFT_PORT`/`PORT`, `ROUGHDRAFT_NO_OPEN`, `ROUGHDRAFT_STATE_FILE`,
  `ROUGHDRAFT_STATE_DIR`.

### 1.7 Experimental stdio MCP server (exact tools + I/O)

Source `packages/server/src/mcp.ts`. Hand-rolled JSON-RPC over stdio
(`Content-Length`-framed; protocol `2025-06-18`; `serverInfo {name:"roughdraft",
version:"0.1.0"}`). Six tools — **every inputSchema is already a flat
`{type:"object", additionalProperties:false, required, properties}`** (strict-mode
compatible out of the box):

| Tool | Required args | Optional args | Behavior |
|---|---|---|---|
| `roughdraft_get_open_documents` | — | — | stateless; returns `{documents:[]}` |
| `roughdraft_get_review_index` | `documentPath` | — | `fs.readFileSync` → `extractRoughdraftReviewIndex`; returns `{documentPath, ...index}` |
| `roughdraft_get_pending_feedback` | `documentPath` | — | index filtered to `status !== "resolved"`, in document order |
| `roughdraft_watch_review_events` | `documentPath` | `projectPath, timeoutSeconds, batchWindowSeconds` | POSTs to running server's `/api/review-events/watch` |
| `roughdraft_reply_to_comment` | `documentPath, parentId, message` | `author` (default `"AI"`) | read → `appendRoughdraftReply` → write file |
| `roughdraft_mark_resolved` | `documentPath, targetId` | `summary` | read → `markRoughdraftResolved` → write file |

Guards: `requireDocumentPath` resolves to absolute, rejects non-`.md`, rejects
missing/non-file. Tool results are returned as a single `content:[{type:"text",
text:JSON.stringify(result)}]`. **This 6-tool shape is a near-1:1 template for o8's
spec MCP tools** (§4) — only the path argument changes (o8 keys off `repoPath`, not a
free `documentPath`).

### 1.8 How annotations are RENDERED (and how the file stays plaintext)

The file on disk is always plaintext Markdown+CriticMarkup — that's the durable source of
truth (ADR-0002). The app builds a *view* on top:

1. `criticMarkdownToEditorState(md)` → marked tokenizes CriticMarkup into HTML spans with
   `data-comment-ids` / `data-critic-change-kind|id|by|at` attributes → Tiptap
   `generateJSON` → ProseMirror doc. Custom marks `commentRef` + `criticChange`
   (`editor-extensions.ts`) carry the metadata; decoration plugins
   (`CommentHighlight`, `CriticChangeHighlight`) add hover/selected styling; the right
   rail (`DocumentCommentRail`/`DocumentReviewRail`) shows threads anchored to spans via
   `useCommentAnchorLayout`.
2. On edit/save, `editorStateToCriticMarkdown(doc, comments)` → Tiptap `generateHTML` →
   Turndown with custom rules → re-emits `{==…==}{>>…<<}{id=…}` etc. Accept/reject of a
   suggestion is a ProseMirror command (`acceptCriticChange`/`rejectCriticChange`) that
   mutates the doc then re-serializes.

Net: pretty inline annotations are a *projection*; the bytes never leave Markdown. The
key insight for o8: we need the same projection but **without** the ProseMirror/Tiptap
stack — a lighter decoration layer (§3).

---

## 2. Ground truth: o8's current o8.md feature

- Storage: plain file at `<repoPath>/o8.md`, 256KB cap, `DEFAULT_TEMPLATE`.
  Route `src/app/api/repo-spec/route.ts` — `GET ?repoPath=` returns
  `{ok, content, exists, path}`; `PUT ?repoPath=` writes `{content}`. `runtime=nodejs`,
  `force-dynamic`. **`/api/repo-spec` is covered by the default-deny
  middleware** → operator clients need the ws-token even on loopback, while
  paired devices and workers receive only the explicitly listed methods.
- Editor UI: `src/components/desktop/o8-panel/O8SpecPane.tsx` — a single `<textarea>`
  with 800ms debounced autosave, a +/- line-diff chip, and a `surface` (solid/paper) vs
  glass theme split (re-binds `--t-*` tokens). Tab is `O8Tab 'spec'`, label "o8.md"
  (`O8HeaderTabs.tsx` / `O8Panel.tsx`). Constraints honored here: inline styles only,
  `var(--t-*)` tokens, raw SVG/HTML entities (no React icon components).
- Orchestrator already reads `<repoPath>/o8.md` from disk during context assembly
  (alongside CLAUDE.md/AGENTS.md) — so anything we write into o8.md is already in the
  agent's context on dispatch (confirmed by the route's own header comment + memory
  notes).
- o8 CLI: `cli/` package (`o8` bin → `cli/dist/o8.mjs`). Handrolled dispatcher
  (`cli/src/index.ts`); each command is "fetch + JSON shape, no business logic" hitting
  the local HTTP API; auto-discovers port/token from env → `~/.o8/` → legacy → 3001.
  Existing groups: `status`, `version`, `doctor`, `cortex observe`, `lane touches`,
  `packet *`, `task *`. Output schema-versioned (`schema: o8/cli/<cmd>/v1`); exit codes
  0/1/2/3/4/5. Documented in `AGENTS.md`.
- MCP servers (`src/lib/mcp/`):
  - `operator-mcp-server.ts` (641 lines) — user/orchestrator-facing. Assembles its tool
    list by **spreading `*_TOOLS` arrays** from `operator-handlers/{approve,cortex,
    mission,repo-management,shared,status}.ts` + `O8_WEBVIEW_TOOLS`. New tool groups
    plug in by adding an `operator-handlers/spec.ts` exporting `SPEC_TOOLS` + handlers.
  - `cortex-mcp-server.ts` (1396 lines) — internal tools for orchestrator-spawned Codex
    sessions (`cortex_*`, `lane_touches`, `register_mcp`, project tools).
  - Strict-mode caveat (CLAUDE.md): every tool `inputSchema` top level MUST be plain
    `{type:'object', properties, required}` — no `oneOf/anyOf/allOf/not`.
- Hard constraints to respect (CLAUDE.md): inline styles only; raw SVG icons (extract
  path data from `@phosphor-icons/react/dist/defs/`) or HTML entities — never React icon
  components in the Tauri webview; `var(--t-*)` theme tokens, never hardcoded surface
  rgba; 800-line file ceiling; never bypass the middleware gate; never throw in API
  routes (return structured errors).

---

## 3. Proposed o8-side architecture

### 3.1 Parser module — VENDOR + lightly adapt `@roughdraft/rfm`

Create `src/lib/o8md/rfm.ts` (and optional `rfm-index-json.ts` for schema-shaped output).

- **Vendor the file**: copy `packages/rfm/src/index.ts` (955 lines, zero deps) into
  `src/lib/o8md/rfm.ts`. It's pure TS, no imports, drops straight into o8's strict
  build. Add the MIT attribution header (§7). Because it's already > the 800-line
  ceiling at 955 lines, split on import: keep the public functions
  (`validate*`, `extract*`, `appendReply`, `markResolved`) in `rfm.ts` and move the
  private scanner helpers (`createLineStarts`, `matchFence`, `matchInlineCodeSpan`,
  `parseComment`, `parseSuggestion`, `parse*Metadata`, etc.) into
  `src/lib/o8md/rfm-internal.ts`. Net behavior identical; satisfies the ceiling.
- **Bring the test vectors**: port `packages/rfm/src/index.test.ts` assertions + the two
  fixtures as a fact-backed contract doc / smoke script (o8 has no test runner — mirror
  the existing `src/lib/cortex/fact-backed.test.ts` pattern or a `tsx` smoke script per
  CLAUDE.md "Dispatch smoke-test pattern").
- **Adaptation**: the only API-shape change is that o8 addresses documents by `repoPath`
  (→ `join(repoPath,'o8.md')`) rather than an arbitrary `documentPath`. The parser itself
  takes a string and is path-agnostic, so this lives in the callers (API/CLI/MCP), not in
  `rfm.ts`.

### 3.2 API route — extend `/api/repo-spec` (stays inside the existing gate)

Add review-aware sub-actions. Two clean options; recommend the query-param verb form to
keep one route file:

- `GET /api/repo-spec?repoPath=…&view=index` → `extractRoughdraftReviewIndex(content)`
  (returns items + summary). `view` absent = today's raw `{content}` behavior (back-compat).
- `GET /api/repo-spec?repoPath=…&view=validate` → `validateRoughdraftMarkdown(content)`.
- `POST /api/repo-spec/reply?repoPath=…` body `{parentId, message, author?}` →
  `appendRoughdraftReply` → write. Returns `{ok, id}`.
- `POST /api/repo-spec/resolve?repoPath=…` body `{targetId, summary?}` →
  `markRoughdraftResolved` → write. Returns `{ok}`.

All inherit the loopback+token gate (prefix `/api/repo-spec` already gated). Keep the
256KB cap. Never throw — return `{ok:false, error}` (matches existing route + CLAUDE.md
rule). This single route then backs the UI, the CLI, and the API-mode MCP path uniformly.

### 3.3 O8SpecPane rendering (DEFER the visual design — operator perfects UI at desktop)

The textarea must become a **decorated read/annotate surface** while keeping the file
plaintext. Do NOT pull in Tiptap/ProseMirror (heavyweight, CSS-class-based, fights o8's
inline-style + raw-SVG constraints). Options, ranked, but the visual polish is explicitly
out of scope for the logic phases:

1. **Overlay-highlight textarea (lightest, recommended phase-1 visual seed):** keep the
   `<textarea>` for editing raw markdown; render a positioned, transparent-text overlay
   `<div>` behind/over it that paints colored spans for each review item using
   `offset`/`endOffset` from `extractRoughdraftReviewIndex` (insert=green, delete=red
   strike, substitution=amber, comment-anchor=highlight, comment=margin dot). This is the
   classic "highlighted textarea" technique; pure inline styles, no editor lib. Pairs with
   a right-rail thread list (reuse the Agents/Issues row idiom referenced in CLAUDE.md).
2. **Read-rendered + raw-edit toggle:** a "Reading" mode renders markdown→HTML with review
   spans (decorations only, accept/reject buttons), and an "Editing" mode is the raw
   textarea. Mirrors Roughdraft's two-surface feel without ProseMirror.
3. **CodeMirror 6 decorations** (only if we later want true inline WYSIWYG-in-place) — CM6
   is far lighter than ProseMirror and decoration-based, but it's still a new dep; defer
   unless the overlay proves insufficient.

Whichever lands, the data contract is fixed now: the pane consumes the review index
(`items[]` with offsets + thread structure via `parentId`) and issues reply/resolve via
the API route. The pretty layer is swappable on top of that contract.

### 3.4 How orchestrator + agents read/write annotations

- **Read on dispatch:** orchestrator already ingests `o8.md` text. Optionally enrich the
  context-assembly step to also surface the *pending-feedback* index (unresolved items)
  so the agent gets a structured "open review threads" list, not just raw markup.
- **Write back:** agents in packet worktrees use the new `o8 spec reply/resolve` CLI
  commands (§4a); the orchestrator (Claude or Codex) uses the new MCP spec tools (§4b).
  Both ultimately call the §3.2 route → the vendored parser → splice-write the file. The
  splice-only mutation guarantee means concurrent operator hand-edits + agent replies
  don't clobber each other at the markup level (last-writer-wins on the file, but each
  write is minimal).

### 3.5 What we DROP from Roughdraft

- The Express server, `~/.roughdraft/server.json` state model, port probing, `open/start/
  stop/status` lifecycle (ADR-0001/0004) — o8.md is per-repo inside the Tauri app; there
  is no separate localhost:7373 process. o8's API+gate+WS already cover transport.
- Remote-document mode / `ROUGHDRAFT_TOKEN` / SSE (the hosted-peer feature) — out of scope.
- Tiptap/marked/turndown editor stack (`@roughdraft/app`) — replaced by §3.3.
- `roughdraft_watch_review_events` as a *new server long-poll* — o8 has its own event bus;
  if we want a "review done" signal, ride o8's existing WS/event plumbing rather than
  porting the `ReviewEventQueue` (see §5).

---

## 4. CLI + MCP exposure (explicit operator requirement: external Claude reads + writes o8.md)

The most advanced users will drive o8 from external Claude (Claude Code / Desktop /
cowork), so o8.md read+annotate must be reachable both via the `o8` CLI binary and via the
MCP servers — not just by o8-dispatched agents.

### 4a. `o8` CLI — new `spec` command group

Add `cli/src/commands/spec.ts` + register in `cli/src/index.ts`. Each command is a thin
fetch to §3.2 (consistent with the CLI's "no business logic" rule, schema-versioned
output, exit codes 0/1/2/3/4/5). Default `--repo <path>` (or auto-resolve to the packet's
repo when run inside a worktree, like `packet info` does):

| Command | Maps to | Output |
|---|---|---|
| `o8 spec read [--repo <path>]` | `GET ?view` absent | raw o8.md content (`schema: o8/cli/spec-read/v1`) |
| `o8 spec index [--repo <path>]` | `GET ?view=index` | review index `{items, summary}` |
| `o8 spec pending [--repo <path>]` | index filtered `status!=resolved` | open threads |
| `o8 spec check [--repo <path>]` | `GET ?view=validate` | diagnostics (analog of `roughdraft doctor`) |
| `o8 spec comment --repo <path> --anchor "<text>"? --body "<msg>" [--by user]` | new top-level/anchored comment | `{ok, id}` |
| `o8 spec reply --repo <path> --to <id> --body "<msg>" [--by AI]` | `POST /reply` | `{ok, id}` |
| `o8 spec resolve --repo <path> --id <id> [--summary "<txt>"]` | `POST /resolve` | `{ok}` |
| `o8 spec suggest --repo <path> --kind add\|del\|sub --text "…" [--new "…"] --anchor "…"` | splice a suggestion marker | `{ok, id}` |

(`comment`/`suggest` need a small "insert marker at anchor/append" helper alongside the
vendored parser — Roughdraft's app does this in the editor; for headless we add a
`appendComment`/`insertSuggestion` companion to `appendReply`, same splice-only style.)
Document the group in `AGENTS.md` next to the existing `o8` commands.

### 4b. MCP tools — new `operator-handlers/spec.ts` → `SPEC_TOOLS` (operator server)

Put the spec tools on the **operator MCP server** (the one external Claude Code / Desktop
sessions load via `.mcp.json`), not the internal cortex server — that's the surface the
operator says advanced users drive. Mirror Roughdraft's 6-tool shape, re-keyed to
`repoPath`, all inputSchemas flat `{type:'object', properties, required}` (strict-mode
safe — and Roughdraft's already are):

| o8 MCP tool | Required | Optional | Maps to |
|---|---|---|---|
| `o8_spec_read` | `repoPath` | — | GET raw content |
| `o8_spec_review_index` | `repoPath` | — | `extractRoughdraftReviewIndex` |
| `o8_spec_pending_feedback` | `repoPath` | — | index filtered unresolved |
| `o8_spec_validate` | `repoPath` | — | `validateRoughdraftMarkdown` |
| `o8_spec_comment` | `repoPath, body` | `anchor, by` | append comment (anchored if `anchor`) |
| `o8_spec_reply` | `repoPath, parentId, message` | `author` | `appendRoughdraftReply` |
| `o8_spec_resolve` | `repoPath, targetId` | `summary` | `markRoughdraftResolved` |
| `o8_spec_write` | `repoPath, content` | — | full PUT (256KB cap) — optional, for "rewrite the whole spec" flows |

Example schema (the pattern for all of them):
```jsonc
{ "name":"o8_spec_reply",
  "inputSchema":{ "type":"object","additionalProperties":false,
    "required":["repoPath","parentId","message"],
    "properties":{ "repoPath":{"type":"string"},
      "parentId":{"type":"string"}, "message":{"type":"string"},
      "author":{"type":"string"} } } }
```
Handlers resolve `repoPath`→`o8.md`, read, mutate via the vendored parser, write — OR call
the §3.2 HTTP route via the operator server's existing local-fetch helper (preferred:
keeps one code path + the gate). Reject raw close delimiters in `message`/`body` (parser
already throws — surface it as a tool error, not a 500). Validate the substitution
old/new constraint in the handler (NOT the schema). Register in the operator server's
spread list (`...SPEC_TOOLS`).

Optionally also expose read-only `o8_spec_review_index` / `o8_spec_pending_feedback` on the
**cortex** server so orchestrator-spawned Codex sessions can see open threads inline.

### 4c. External-session reachability

- Claude Code / Desktop sessions that have o8's operator MCP configured (repo-root
  `.mcp.json`, or via Settings → MCP) get `o8_spec_*` automatically — read+annotate o8.md
  for any repo by `repoPath`.
- Sessions on a box with the `o8` CLI on `$PATH` use `o8 spec …`.
- Both go through the loopback+ws-token gate; no new auth surface, no new open port.

---

## 5. The review LOOP (what we adopt vs. how it differs)

Roughdraft loop: AI writes md → user opens in Roughdraft → user comments/suggests → AI
`watch`es → on **Done Reviewing** AI reads pending feedback → replies/resolves in-file.

o8 adaptation (note the **role inversion** from §0 — in o8 the operator authors the prose
and the agent annotates it, the reverse of the Roughdraft line above):
- The "open in app" + "Done Reviewing" handoff collapses into the o8.md panel: the operator
  edits/annotates o8.md in `O8SpecPane`; the orchestrator/agent reads the pending-feedback
  index on its next turn/dispatch.
- We do **not** need to port `ReviewEventQueue` to get a usable loop (poll-on-dispatch is
  enough for v1). IF a push "operator finished reviewing" signal is wanted, ride o8's
  existing WS event bus / the durable-channel pattern in `ws-server.ts` (see memory note
  "MCP long-poll/SSE notify follow-up") rather than standing up a second long-poll server.

---

## 6. What ports directly vs. must be adapted

**Ports directly (logic, copy-with-attribution):**
1. The `@roughdraft/rfm` parser (`validate`, `extract`, `appendReply`, `markResolved`) +
   its diagnostic codes, ID conventions, and round-trip/splice guarantees — zero-dep,
   drops into `src/lib/o8md/`.
2. The Roughdraft Flavored Markdown **format**: CriticMarkup markers + the canonical
   attribute grammar (`{id="" by="" at="" re="" status="" resolved=""}`) + legacy-read
   compat. Adopt verbatim — interop with anything else that speaks RFM/CriticMarkup.
3. The MCP **tool shapes** (read-index / pending-feedback / reply / resolve / validate) —
   already strict-mode-clean; re-key from `documentPath` to `repoPath`.

**Must be adapted (or dropped):**
1. **Transport/lifecycle**: their per-file `localhost:7373` Express server + `~/.roughdraft`
   state model does NOT fit. o8.md is per-repo inside the Tauri panel; reuse o8's gated
   `/api/repo-spec` route + ws-token + WS bus. (ADR-0001/0004 are explicitly the part we
   replace.)
2. **Editor rendering**: their Tiptap/marked/turndown WYSIWYG can't come over (CSS classes,
   ProseMirror, React-icon-incompatible). Build a light inline-style decoration layer over
   the existing textarea (§3.3); DEFER the visual polish to the operator at the desktop.

---

## 7. Licensing / attribution plan

- Roughdraft is MIT (package.json + README), author Nathan Baschez / Lex-Inc. We are
  copying source (the rfm parser) → MIT requires the copyright + permission notice travel
  with it.
- Action items:
  1. Add an SPDX/attribution header to every vendored file
     (`src/lib/o8md/rfm.ts`, `rfm-internal.ts`):
     `/* Adapted from roughdraft (@roughdraft/rfm), MIT © Nathan Baschez. https://github.com/Lex-Inc/roughdraft */`
  2. Add a `licenses/roughdraft-MIT.txt` (or a `THIRD-PARTY-NOTICES` entry) containing the
     full MIT license text with `Copyright (c) Nathan Baschez`. **Flag:** the upstream repo
     has no LICENSE file — reconstruct the standard MIT text ourselves and, ideally,
     confirm the exact copyright holder/year with the author or the npm tarball before
     ship.
  3. The **format/spec** (CriticMarkup grammar, attribute names) is not copyrightable as
     such — implementing the same wire format is fine; the attribution above covers the
     copied implementation.
  4. Public release-note safety (CLAUDE.md): "roughdraft", "CriticMarkup", and "RFM"
     are external OSS names and are safe to use in public attribution.

---

## 8. Phasing, effort, risks

Phases are ordered so all LOGIC lands before the gorgeous-UI pass.

- **Phase 0 — Vendor + verify parser (S, ~0.5 day).** Copy rfm into `src/lib/o8md/`, split
  for the 800-line ceiling, add attribution, port the test vectors as a `tsx` smoke
  script + fixtures. Exit: `validate/extract/appendReply/markResolved` pass the upstream
  assertions on a fresh checkout. *No UI, no API yet.*
- **Phase 1 — API + headless read/write (S–M, ~1 day).** Extend `/api/repo-spec` with
  `view=index|validate` GET + `/reply` + `/resolve` POST (+ `appendComment`/`insertSuggestion`
  helpers). Exit: curl/`fetch` round-trips through the gate; byte-exact splice writes
  verified against o8.md.
- **Phase 2 — CLI + MCP exposure (M, ~1–1.5 days).** `o8 spec {read,index,pending,check,
  comment,reply,resolve,suggest}` in `cli/`; `operator-handlers/spec.ts` → `SPEC_TOOLS` on
  the operator server (+ optional read-only on cortex server); document in AGENTS.md +
  CLAUDE.md. Exit: an external Claude Code session reads + replies to an o8.md comment via
  both CLI and MCP. **This is the operator's headline requirement — it is fully delivered
  by end of Phase 2, before any pretty UI.**
- **Phase 3 — Orchestrator loop integration (S, ~0.5 day).** Surface pending-feedback in
  context assembly; agents reply/resolve as part of dispatch. Exit: a dispatched agent
  answers an operator's o8.md comment in-file on its next turn.
- **Phase 4 — Decorated UI (M–L, DEFERRED / operator-led).** Replace the bare textarea with
  the overlay-highlight + thread-rail surface (§3.3). Operator perfects visuals at the
  desktop via the ship→auto-update loop. Out of scope for the logic delivery.

Risks / watch-items:
- **800-line ceiling**: rfm is 955 lines → must split on vendor (planned in Phase 0).
- **Concurrent writes**: operator hand-edits o8.md in the panel while an agent splices a
  reply. Splice-only mutations minimize damage, but it's still file-level last-writer-wins.
  Mitigate: the panel already debounces saves; consider a read-modify-write with a quick
  content-hash check (optimistic concurrency) on the reply/resolve POST. Low risk for v1.
- **Two parsers diverging**: we only vendor the canonical `rfm` parser; we are NOT bringing
  the app's marked-based tokenizer. Keep o8 on one parser to avoid the drift Roughdraft
  carries.
- **Index shape vs. JSON-Schema shape**: `extractRoughdraftReviewIndex` returns a flat
  `items[]`; the published schema is nested comments/suggestions. If we ever advertise
  "RFM-schema-compliant JSON," add the small adapter (`rfm-index-json.ts`); not needed for
  internal use.
- **Strict-mode MCP schemas**: keep all spec-tool inputSchemas flat; put the substitution
  old/new requirement and the close-delimiter rejection in handlers, not schemas.
- **LICENSE absence upstream** (see §7) — the only true unknown; everything else is
  verified from source.

---

## 9. Verification notes

Verified from the cloned source (`/tmp/roughdraft-audit`): MIT in package.json+README;
exact CriticMarkup markers + attribute grammar (spec + parser code + passing tests);
parser implementation (offset scanner, zero deps, splice-only mutations, byte-exact
round-trip tests); the 6 MCP tool names + schemas (already strict-mode-clean); CLI command
set + flags + exit codes; the `review.completed` event shape + in-memory queue (not an fs
watcher); the Tiptap/marked/turndown editor rendering path; the 4 ADRs establishing the
single-file + CriticMarkup + round-trip + server-state decisions.

Could NOT verify: a standalone upstream LICENSE file (none present — MIT asserted only in
package.json/README; §7 mitigation). The `@roughdraft/skill` package is an empty stub
(name/version only, no source) — there is no shipped Claude Code skill to study; the
"agent setup" surface is just the CLI `agent-setup`/`help agent` prompt text pointing at
`https://roughdraft.md/setup.md` (a remote URL not fetched in this audit).
