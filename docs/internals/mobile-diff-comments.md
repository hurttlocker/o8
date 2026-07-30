# Mobile inline diff comments

*The operator taps a diff line on the phone and leaves a note anchored to a file + line of an agent session's diff. The desktop stores it, shows it on the review surface, and injects open comments into the agent's iterate prompt so it acts on "fix this HERE." This is the **byte-level contract** both sides build to — same discipline as `docs/internals/mobile-e2ee.md`; don't improvise field names.*

## Anchor model

A comment is anchored to one line of one file of one agent session's unified diff:

```
{ sessionKey, path, lineNumber, side, text }
```

- `sessionKey` (string) — the agent session whose diff this is (same key the phone uses for `GET /api/worktrees/diff?sessionKey=…`).
- `path` (string) — the file path as it appears in the diff.
- `lineNumber` (integer ≥ 0) — the line number the mobile derives from the unified-diff hunk header (`@@ -a,b +c,d @@`).
- `side` (`"old"` | `"new"`) — which side of the diff the line number refers to. A deletion → `"old"`; an addition or context line the operator is commenting on → `"new"` (default). The phone owns this choice; the desktop stores it verbatim.
- `text` (string) — the operator's note (server clips to 2000 chars).

## Endpoints (all under `/api/mobile/*` — gated; a paired phone's per-device token or the loopback desktop)

```
POST /api/mobile/diff-comment
  body { sessionKey, path, lineNumber, side, text }
  → 200 { comment: { id, sessionKey, path, lineNumber, side, text, createdAt, resolvedAt } }
  → 400 { error } when any of sessionKey/path/text is missing or lineNumber is not a valid integer

GET /api/mobile/diff-comments?sessionKey=<key>[&openOnly=1]
  → 200 { comments: DiffComment[] }   // newest first; openOnly=1 drops resolved ones
  → 400 { error } when sessionKey is missing

POST /api/mobile/diff-comment/resolve
  body { commentId }
  → 200 { resolved: boolean }   // true if an open comment transitioned to resolved
```

`DiffComment` = `{ id, sessionKey, path, lineNumber, side, text, createdAt, resolvedAt }` (timestamps are sqlite `datetime('now')` UTC strings; `resolvedAt` is null until resolved).

## Mobile side (no native dep — sim-buildable now)

1. Fix `src/o8/diff.ts` to PRESERVE line numbers — they're in the `@@ -a,b +c,d @@` hunk headers; track running old/new line numbers per `DiffLine` as you parse (today they're dropped).
2. Long-press a diff line → input sheet → `POST /api/mobile/diff-comment` with `{sessionKey, path, lineNumber, side, text}`.
3. Render a marker on commented lines; `GET …/diff-comments?sessionKey=…` to load existing ones; tap a marker to view / resolve.

## Desktop side (built — server endpoints + store live)

- Store: `src/lib/mobile/diff-comments.ts` + the `mobile_diff_comments` table.
- The endpoints above.
- `formatOpenDiffCommentsForPrompt(sessionKey)` renders open comments as a compact block ready to inject into a rerun/steer prompt, and `countOpenDiffComments(sessionKey)` powers a review-surface badge. Wiring these into the orchestrator iterate flow + the desktop ReviewPanel is the follow-on once the mobile UI lands.

## Open question to confirm before the mobile wires it

The anchor is `{path, lineNumber, side}`. If the mobile's hunk-parse needs an extra disambiguator (e.g. a hunk index, or a content hash for robustness across a re-diff), say so and we add it — it's additive. The core five fields are stable.
