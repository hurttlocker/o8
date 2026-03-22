# Clawmark vs Cortex Memory Audit

Issue: #249  
Date: 2026-03-22

## Executive Summary

Clawmark is a clean, opinionated local memory binary with a strong core idea: store compact human-written "signals" in SQLite, embed them locally, and retrieve them semantically with almost no ceremony.

Cortex is materially deeper as a memory system. It already has structured fact extraction, hybrid search, belief state management, lifecycle/decay, conflict handling, provenance, and far stronger operational tooling.

The biggest practical finding was not search quality. It was portability:

- On this host (`x86_64` macOS), Clawmark did **not** run out of the box.
- `cargo run -- status` failed initially because `ort` does not ship prebuilt `x86_64-apple-darwin` binaries for the configured feature set.
- `install.sh` also failed on this machine because it requests `clawmark-darwin-amd64.tar.gz`, but the latest release only ships `darwin-arm64`, `linux-amd64`, and `linux-arm64`.
- I only got Clawmark running after installing Homebrew `onnxruntime` and building with:

```bash
ORT_LIB_LOCATION=/usr/local/opt/onnxruntime/lib ORT_PREFER_DYNAMIC_LINK=1 cargo run -- status
```

So the product claim is directionally strong, but the current distribution story is not yet robust on Intel Mac.

## Methodology

### Clawmark

- Repo cloned from `https://github.com/jackccrawford/clawmark` at `718e996`.
- Read and audited:
  - `README.md`
  - `schema/schema.sql`
  - `src/db.rs`
  - `src/embedding.rs`
  - `src/adapter.rs`
  - `src/main.rs`
  - `src/cli.rs`
- Built a test station at `/tmp/clawmark-cortex-audit.db`.
- Imported data using Clawmark's own schema and import logic:
  - `MEMORY.md`
  - `memory/YYYY-MM-DD.md` daily files from `/Users/marquisehurtt/clawd`
  - top-level `docs/*.md`, `README.md`, and `AGENTS.md` from this repo
- Final station size:
  - `2148` signals
  - `2148/2148` embeddings cached
  - semantic search ready

Why I imported this way:

- Clawmark's actual search path was exercised with the real binary (`backfill`, `tune`, `status`).
- I reproduced the import phase directly from Clawmark's own `schema.sql` and adapter/capture code so I could load the full corpus once and then let the real binary backfill/query it.
- This avoided a very slow repeated-embedding import path while staying faithful to Clawmark's storage and threading model.

### Cortex

I used the real local Cortex binary and live database:

```bash
~/bin/cortex stats
~/bin/cortex search "test query" --explain
```

Live stats on this machine:

- `23,569` memories
- `49,796` facts
- `4,889` sources
- average confidence `0.9483`
- freshness window: `2026-02-24 → 2026-03-22`

Important fairness note:

- The Clawmark station used a shared core corpus: OpenClaw memory plus repo docs.
- Cortex's live DB is broader and noisier because it includes much more historical vault content and imported artifacts.
- That broader corpus is a real strength for long-term memory, but it also polluted some repo-doc queries in default search.

## Clawmark: What It Actually Is

### Storage format

Clawmark stores one row per signal in SQLite:

- `signals(signal_uuid, payload, created_at, parent_uuid)`
- `payload` is JSON with `content` and `gist`
- `signal_embeddings(signal_uuid, embedding)` stores the embedding blob

It also creates a recursive `signal_chains` view for parent/child threading.

### Search method

Clawmark has two retrieval paths:

1. Semantic search:
   - local ONNX runtime
   - `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`
   - `384` dimensions
   - cosine similarity over cached embeddings

2. Keyword fallback:
   - splits query on whitespace
   - runs `payload LIKE %term% OR ...`
   - sorts by `created_at DESC`

The fallback path is extremely weak on natural-language queries with stopwords and punctuation. Without embeddings, it gets swamped by recency.

### Fact extraction

None.

Clawmark does not extract structured facts. It stores:

- manual `signal` content
- file capture content
- imported OpenClaw memory sections

There is no LLM extraction phase and no typed fact model.

### Lifecycle / decay

None.

There is no confidence decay, stale queue, reinforcement policy, contradiction handling, or retirement model.

### Dedup

None beyond UUID identity.

There is no content-hash dedup, semantic near-duplicate detection, or supersede model.

### Recall injection

Manual only.

The model is:

- write signal
- later run `clawmark tune`
- optionally inspect full content

There is no automatic prompt injection or structured pre-flight recall surface.

### Embedding strategy

- Local ONNX model
- cached once per signal
- `backfill` for historical population
- tries ONNX first, then falls back to Ollama embeddings if ONNX init fails

## Feature Matrix

| Area | Clawmark | Cortex |
|---|---|---|
| Core storage | SQLite `signals` + JSON payloads + embedding blob | SQLite memories + structured facts + belief/lifecycle state |
| Retrieval | semantic cosine over one embedding per signal; weak keyword fallback | BM25 + semantic hybrid with source/class/confidence/recency weighting |
| Query explainability | no explain output | `--explain` gives provenance and rank breakdown |
| Fact extraction | none; manual signals or capture only | LLM-driven extraction via `import --extract` and chat post-flight extraction |
| Typing | none | typed facts (`decision`, `preference`, `state`, `config`, etc.) |
| Decay / lifecycle | none | Ebbinghaus confidence decay, stale queue, reinforce, retire, supersede |
| Conflict handling | none | explicit conflict detection and resolution flows |
| Dedup | none | duplicate guards, supersede model, content-hash/dedup work in progress |
| Threading | yes, simple parent/child signal chains | provenance chains and graph tooling rather than explicit thread metaphor |
| Graph / relationship view | no | yes |
| Health / stats | basic station counts | rich stats, freshness, confidence distribution, source counts |
| Watches / alerts | no | yes |
| Shared memory ergonomics | very simple shared station via `CLAWMARK_STATION` | richer system, but team/shared-memory path is heavier and not as frictionless today |
| Platform/runability on this host | broken until manually repaired | already running live at scale |

## Search Comparison

### Results summary

| Query | Better | Why |
|---|---|---|
| What are Q's trading preferences? | Clawmark, slight | Neither answered the actual preference question cleanly, but Clawmark at least stayed inside trading history while Cortex ranked `SOUL.md` first. |
| How does the approval system work in Cortex IDE? | Clawmark | Clawmark surfaced repo architecture docs in the top set; Cortex mostly returned session logs. |
| What happened on March 20? | Neither | Both missed the exact `2026-03-20` session note on this natural-language date query. |
| What model does Niot use? | Cortex | Cortex hit `DELEGATION.md` and an auto-captured answer mentioning `openai-codex/gpt-5.4`; Clawmark missed the model detail. |
| What is the Triple Crown scanner? | Cortex | Cortex's top hit explicitly named `orb_options_scanner.py` and described its config. Clawmark returned status/context, but not the clearest definition. |
| What are the five memory surfaces in Cortex IDE? | Clawmark | Clawmark surfaced `cortex-memory-integration.md`; Cortex returned adjacent audit notes instead of the design doc. |
| How should runtime adapters handle pause support? | Clawmark | Clawmark hit `runtime-adapter-contract.md` and the exact "pause is not assumed" rule. Cortex was irrelevant. |
| What is the live OpenClaw bridge? | Clawmark | Clawmark hit `live-openclaw-bridge.md` directly. Cortex returned nearby daily notes. |
| How is worktree storage path decided? | Clawmark | Clawmark hit `worktree-storage-path-decision.md` directly, including the decision to keep `.cortex-worktrees` repo-local. Cortex was irrelevant. |
| What is the canonical workflow? | Clawmark | Clawmark hit `canonical-workflow.md` directly. Cortex did not surface the workflow doc in top results. |

Scorecard:

- Clawmark wins: `7` if you count the trading-preferences query as a slight edge
- Cortex wins: `2`
- Neither: `1`

### What this really means

Clawmark won the repo-doc questions because:

- I loaded the repo docs directly into the station
- its semantic retrieval was strong on doc-title / design-note style questions
- each captured document is a clean semantic unit with a short gist

Cortex won the operational/person-identity questions because:

- it already has broader historical memory
- it stores richer extracted facts and provenance
- its corpus contains distilled answers, not just raw document captures

The failure mode both systems shared:

- date-style natural language questions like "What happened on March 20?" were weak
- neither system normalized the date intent into a strong scoped query

## What Clawmark Does Well

### 1. Gist-first memory is a strong primitive

The `gist` field is good.

It gives each memory a short human-written retrieval target instead of making every search depend on long raw content or extracted facts.

Cortex should steal this idea, but attach it to memories/facts as an additional operator-written summary field, not as the only structure.

### 2. Threaded follow-up signals are simple and useful

Clawmark's parent/child chain model is easy to understand.

For issue work, incident follow-ups, and multi-session debugging, a lightweight "thread" surface is a better UX than only raw provenance or graph traversal.

### 3. Capture ergonomics are excellent

The command set is easy to hold in your head:

- `signal`
- `tune`
- `capture`
- `backfill`
- `status`

This is a better operator story than a memory system that feels like an internal platform before it feels like a tool.

### 4. Shared-station setup is frictionless

`CLAWMARK_STATION=/shared/team.db` is dead simple.

That is a real advantage for small teams and agent fleets that just want shared continuity without a whole service layer.

## What Cortex Already Does Better

### 1. Cortex is a memory system, not just a retrieval cache

Cortex has:

- extracted facts
- confidence
- lifecycle
- contradictions
- beliefs
- graph exploration
- richer operational statistics

Clawmark today is closer to "semantic notebook with threads" than "full memory operating system."

### 2. Cortex is much stronger at operational introspection

`cortex stats` immediately tells me:

- scale
- freshness
- growth
- confidence distribution
- source counts

Clawmark's `status` is intentionally minimal. Nice for simplicity, but much weaker for operating a large memory system.

### 3. Cortex can explain ranking

This matters more than it sounds.

When search is wrong, Cortex gives enough evidence to debug why. Clawmark does not.

### 4. Cortex is already solving the hard long-term problems

These are not cosmetic wins:

- duplicate suppression
- fact retirement
- stale/fading memory
- contradiction resolution
- structured recall injection

That is the real moat.

## What Cortex Should Steal

### Add an explicit operator-authored gist

Every imported memory or high-value conversation should be able to carry:

- raw content
- extracted facts
- optional short "gist" written for future retrieval

Use it as:

- a display title
- a ranking hint
- a compact review surface

### Add a thread/chain view

For issue work and debugging lanes, add a simple memory thread abstraction:

- original memory
- follow-up
- regression
- fix
- postmortem

This is more legible than a generic graph when the user really wants narrative continuity.

### Tighten repo-doc ingestion

Clawmark looked good on repo-doc questions because those docs were explicitly captured as clean semantic units.

Cortex should improve:

- project-doc capture presets
- source scoping for repo-doc search
- better weighting when the query looks like "design doc title / architecture question"

### Keep the operator surface small

Clawmark's CLI is compact and memorable.

Cortex should preserve its depth, but still expose a thin everyday lane for:

- quick capture
- recent memory
- semantic lookup
- one-shot memory health

## Recommended Improvements

### For Cortex

1. Add a `gist` field to memories or import jobs and use it as a first-class ranking/display signal.
2. Add a threaded memory view for issue/debugging continuity.
3. Improve natural-language date queries by normalizing dates before search.
4. Improve repo-doc retrieval with stronger source scoping and ranking when the query is clearly architectural.
5. Consider a very lightweight shared-memory mode that is as easy to point multiple agents at as `CLAWMARK_STATION=/path/to/db`.

### For Clawmark

1. Fix Intel macOS distribution immediately. Current install story is broken on this host.
2. Update `install.sh` or release assets so platform claims match reality.
3. Add at least minimal query explain output.
4. Add stopword/punctuation normalization to keyword fallback so semantic-off mode is not catastrophically weak.
5. Add optional dedup/supersede and a lightweight confidence/lifecycle model.
6. Add some notion of structured extraction or typed signals if the product wants to compete with systems like Cortex rather than complement them.

## Bottom Line

Clawmark is a good product idea with real strengths:

- elegant local architecture
- strong gist/thread model
- good semantic retrieval on captured docs once embeddings are ready

But Cortex is still the more serious memory system.

If I were choosing patterns to copy, I would copy Clawmark's:

- gist discipline
- thread simplicity
- low-friction shared-station ergonomics

I would not trade away Cortex's:

- structured facts
- lifecycle
- dedup
- provenance
- explainability
- health tooling

That is the part that compounds.
