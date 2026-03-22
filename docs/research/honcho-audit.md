# Honcho Audit for Cortex Memory

Date: 2026-03-22  
Audited Honcho repo: `plastic-labs/honcho` @ `254510d` (`3.0.3`)  
Clone path: `/Users/marquisehurtt/clawd/repos/honcho`

## TL;DR

Honcho is not a generic fact store. It is a peer-centric memory server built around directional representations: `(observer, observed, workspace, optional session)`. The strongest pattern to steal is not "documents in Postgres"; it is the idea that Agent A and Agent B should not share a single flat memory view.

The second strong pattern is batch fan-out. Honcho does one derivation pass for a sender and then writes the resulting observations into every observer's scoped collection. That is the cleanest answer I found for "how does Agent A's context reach Agent B without recomputing everything N times?"

The weak side is operational shape. Honcho is FastAPI + Postgres/pgvector + queue worker + optional Redis + mandatory LLM provider configuration for useful behavior. Cortex is much stronger on local-first packaging, deterministic storage, and explainable retrieval.

## Step 1: Self-Hosting Notes

### What I tried

1. Cloned Honcho to `/Users/marquisehurtt/clawd/repos/honcho`.
2. Tried the documented Docker Compose path.
3. Fell back to local Postgres because `docker` is not installed in this environment.
4. Brought up a local Honcho API against Postgres.app and verified the Python SDK against it.

### What actually worked

I could not run Docker Compose here because the machine does not have `docker`.

Manual fallback worked:

- Local Postgres: Postgres.app 17.2
- Database: `honcho`
- Extensions: `vector`, `pg_trgm`
- Migrations: `scripts/provision_db.py`
- API boot: `.venv/bin/fastapi run --host 127.0.0.1 --port 8000 src/main.py`
- SDK verification:
  - created workspace `audit-workspace`
  - created session `audit-session`
  - added 3 messages
  - `session.context(summary=True, tokens=80)` returned messages
  - `alice.search('espresso math')` returned the matching Alice message

### Setup friction

1. Docker Compose was not runnable here because `docker` is missing.
2. `uv sync --python 3.13` failed on macOS x86_64 because Honcho currently resolves `lancedb==0.29.2`, which has no macOS x86_64 wheel.
3. The self-hosting docs use `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`, but the code expects `LLM_OPENAI_API_KEY` / `LLM_ANTHROPIC_API_KEY` / `LLM_GEMINI_API_KEY` / `LLM_GROQ_API_KEY`.
4. The docs say `curl http://localhost:8000/health`; there is no `/health` route. `GET /openapi.json` and `/docs` work.
5. Honcho validates selected LLM clients at import time. Even with `DERIVER_ENABLED=false` and `SUMMARY_ENABLED=false`, the API would not boot until I overrode providers to one with an initialized client.
6. README and docs are inconsistent about the "easy" Docker path:
   - one path says `docker compose up -d database`
   - the compose file actually includes `api`, `deriver`, `database`, `redis`, `prometheus`, and `grafana`

### Local boot recipe that worked here

This is the exact shape that worked in this environment:

```bash
cd /Users/marquisehurtt/clawd/repos/honcho

# local postgres
psql -d postgres -c "CREATE DATABASE honcho;"
psql -d honcho -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;"

# venv workaround: install editable project + exported deps, skipping LanceDB-only packages
uv pip install --python .venv/bin/python -e . --no-deps
uv pip install --python .venv/bin/python -e sdks/python
uv pip install --python .venv/bin/python -r <(uv export --no-dev --no-hashes | rg -v '^(lancedb|lance-namespace|lance-namespace-urllib3-client)==')

# migrations
DB_CONNECTION_URI='postgresql+psycopg://postgres@localhost:5432/honcho' \
AUTH_USE_AUTH=false \
.venv/bin/python scripts/provision_db.py

# API boot with dummy provider overrides so import-time client validation passes
DB_CONNECTION_URI='postgresql+psycopg://postgres@localhost:5432/honcho' \
AUTH_USE_AUTH=false \
EMBED_MESSAGES=false \
DERIVER_ENABLED=false \
SUMMARY_ENABLED=false \
PEER_CARD_ENABLED=false \
LLM_OPENAI_API_KEY=dummy \
SUMMARY_PROVIDER=openai \
SUMMARY_MODEL=gpt-4o-mini \
DERIVER_PROVIDER=openai \
DERIVER_MODEL=gpt-4o-mini \
DIALECTIC_LEVELS__minimal__PROVIDER=openai \
DIALECTIC_LEVELS__minimal__MODEL=gpt-4o-mini \
DIALECTIC_LEVELS__minimal__THINKING_BUDGET_TOKENS=0 \
DIALECTIC_LEVELS__minimal__MAX_TOOL_ITERATIONS=1 \
DIALECTIC_LEVELS__minimal__MAX_OUTPUT_TOKENS=250 \
DIALECTIC_LEVELS__low__PROVIDER=openai \
DIALECTIC_LEVELS__low__MODEL=gpt-4o-mini \
DIALECTIC_LEVELS__low__THINKING_BUDGET_TOKENS=0 \
DIALECTIC_LEVELS__low__MAX_TOOL_ITERATIONS=5 \
DIALECTIC_LEVELS__medium__PROVIDER=openai \
DIALECTIC_LEVELS__medium__MODEL=gpt-4o-mini \
DIALECTIC_LEVELS__medium__THINKING_BUDGET_TOKENS=0 \
DIALECTIC_LEVELS__medium__MAX_TOOL_ITERATIONS=2 \
DIALECTIC_LEVELS__high__PROVIDER=openai \
DIALECTIC_LEVELS__high__MODEL=gpt-4o-mini \
DIALECTIC_LEVELS__high__THINKING_BUDGET_TOKENS=0 \
DIALECTIC_LEVELS__high__MAX_TOOL_ITERATIONS=4 \
DIALECTIC_LEVELS__max__PROVIDER=openai \
DIALECTIC_LEVELS__max__MODEL=gpt-4o-mini \
DIALECTIC_LEVELS__max__THINKING_BUDGET_TOKENS=0 \
DIALECTIC_LEVELS__max__MAX_TOOL_ITERATIONS=10 \
.venv/bin/fastapi run --host 127.0.0.1 --port 8000 src/main.py
```

## Step 2: Architecture Deep Dive

### Storage model

Honcho's real storage model is:

- `workspaces`: top-level tenant
- `peers`: all entities, human or agent
- `sessions`: conversation containers
- `session_peers`: many-to-many membership plus `joined_at`, `left_at`, `observe_me`, `observe_others`
- `messages`: raw event log with `seq_in_session`, `token_count`, `peer_name`, `session_name`
- `message_embeddings`: per-message or per-chunk embeddings
- `collections`: unique `(workspace, observer, observed)` pair
- `documents`: derived observations/facts for one `(observer, observed)` pair
- `queue`: async work for summaries, representations, dreams, reconciliation
- `active_queue_sessions`: worker ownership / in-flight locking

Important nuance: there is no `peer_cards` table. Peer cards are stored inside `peers.internal_metadata`, keyed as either `peer_card` or `{observed}_peer_card`.

Important nuance #2: the actual memory is in `documents`, not `messages`. `messages` are source material. `documents` are extracted observations with:

- `level`: `explicit`, `deductive`, `inductive`, `contradiction`
- `observer`, `observed`
- `session_name` nullable
- `times_derived`
- `source_ids`
- `deleted_at`
- `sync_state`

That means Honcho is effectively two systems:

1. a conversation log
2. an async observation graph layered on top

### How peers, sessions, and messages are structured

Peers and sessions are scoped by `workspace_name` and use stable human-readable `name` plus generated `id`.

Sessions are not just chat threads. `session_peers` adds:

- membership windows via `joined_at` / `left_at`
- per-session visibility config
- the basis for theory-of-mind isolation

Messages are append-only turns with:

- global PK `id`
- public nanoid `public_id`
- `session_name`
- `peer_name`
- `workspace_name`
- `seq_in_session`
- `token_count`

That `seq_in_session` field is key because summaries and context packing are sequence-aware, not just timestamp-aware.

### How `peer.chat()` works

`peer.chat()` in the Python SDK hits `POST /v3/workspaces/{workspace}/peers/{peer}/chat`.

Call flow:

1. Router ensures observer and observed peers exist.
2. It resolves workspace/session configuration.
3. If peer cards are enabled, it loads:
   - observer self-card
   - observer's card for observed
4. It constructs a `DialecticAgent`.
5. `DialecticAgent`:
   - injects a system prompt describing observer/observed semantics
   - optionally injects recent session history into the system prompt
   - prefetches semantically relevant observations with one query embedding
   - does two memory searches:
     - explicit observations
     - derived observations (`deductive`, `inductive`, `contradiction`)
6. It calls `honcho_llm_call(...)` with reasoning-level-specific model settings and tool definitions.
7. The model can then use tools like:
   - `search_memory`
   - `get_recent_history`
   - `search_messages`
   - `get_recent_observations`
   - `get_most_derived_observations`
   - `get_session_summary`
   - `get_reasoning_chain`

Two important conclusions:

1. `peer.chat()` is not "query a vector DB and answer once". It is an agent loop.
2. Cost and latency scale with tool iterations, not just with prompt size.

### How `alice.search()` scopes to a specific entity

`alice.search(query)` in the SDK does **not** search Alice's derived facts.

It hits `POST /v3/workspaces/{workspace}/peers/alice/search`, and the router forcibly adds:

- `workspace_id=<workspace>`
- `peer_id=alice`

That means it scopes to **messages authored by Alice**.

Under the hood, `utils.search.search(...)` does:

- full-text search always
- semantic search if `EMBED_MESSAGES=true`
- reciprocal rank fusion when both are available

So `alice.search()` is message-scoped entity search, not observation-scoped entity search.

If you want "facts about Alice", the stronger Honcho APIs are:

- `alice.representation(...)`
- `session.representation(alice, ...)`
- `alice.context(...)`
- `session.context(peer_target='alice', ...)`

### What `session.representation(peer)` returns

`session.representation(peer)` is just a session-scoped wrapper over the peer representation endpoint.

It returns a markdown string built from a `Representation` object, with sections like:

- `## Explicit Observations`
- `## Deductive Observations`
- `## Inductive Observations`
- `## Contradictions`

So it is not a prose profile. It is a curated observation listing.

Scope rules:

- `observer = peer`
- `observed = target or peer`
- `session_name = this session`
- optional semantic query narrowing
- optional inclusion of "most frequent" observations via `times_derived`

Important nuance: the normal message-deriver only creates `explicit` observations. Higher-order `deductive`, `inductive`, and `contradiction` entries mostly arrive later via dreamer/dialectic flows.

### How `session.context(summary=True, tokens=10000)` compresses to fit

The budgeter is simple and good:

1. Start with total `token_limit`.
2. If no peer-targeted representation is requested:
   - reserve up to 40% for a summary
   - spend the rest on recent raw messages
3. If peer-targeted context is requested:
   - first subtract estimated tokens of `peer_representation` and `peer_card`
   - then apply the same 40/60 summary/messages split to the remainder
4. Prefer long summary if it fits summary budget and is larger than short summary.
5. Otherwise prefer short summary if it fits.
6. Otherwise return no summary and spend all tokens on recent messages.

This is better than naive truncation because it treats summaries as optional compressed history, not mandatory filler.

The SDK then exposes `SessionContext.to_openai()` and `to_anthropic()`:

- `peer_representation` becomes a system message
- `peer_card` becomes a system message
- `summary` becomes a system message
- recent messages are mapped into role-based chat history

That is a pattern worth stealing almost verbatim.

### How Honcho models entities changing over time

Honcho does have a story for change over time, but it is not a hard fact-lifecycle model like Cortex.

What exists:

- multiple observations can coexist
- newer observations carry later timestamps
- duplicate detection can soft-delete weaker near-duplicates
- `times_derived` can reinforce recurring observations
- `source_ids` build evidence trees
- dreamer/dialectic can create higher-order update observations and contradictions
- prompts explicitly tell the agent to search for "updated", "changed", "now", etc., and prefer newer evidence

What does **not** exist as a first-class storage primitive:

- explicit "this fact supersedes that fact" state on every update
- built-in confidence decay
- a deterministic lifecycle engine for recency changes

So Honcho's update handling is mostly:

1. store multiple observations
2. derive higher-order conclusions
3. rely on prompts and timestamps to answer with the latest state

That works, but it is softer than Cortex's explicit lifecycle controls.

### How cross-agent sharing works

This is Honcho's best idea.

On message ingest:

1. determine the sender as `observed`
2. decide who should observe them:
   - self if `observe_me`
   - any active session peer with `observe_others=true`
3. create **one** representation queue item keyed as:
   - `representation:{workspace}:{session}:{observed}`
4. batch the sender's relevant messages once
5. run one derivation pass
6. write the resulting observations into **each observer's** `(observer, observed)` collection

The work-unit key intentionally omits observer. That means fan-out happens after derivation, not before it.

This is the concrete mechanism by which Agent A's context reaches Agent B:

- not global shared memory
- not broadcast copies of raw messages
- not a separate event bus
- a scoped observer fan-out at ingest time

The membership window in `session_peers.joined_at/left_at` is what keeps this honest. A peer only accumulates/searches what they were present to observe.

### Cost: what calls happen behind the scenes

I could not fully exercise the LLM paths locally because I did not have real provider keys in this environment, but the call graph is very clear from the code.

#### 1. Message ingest

Behind the scenes:

- 0 LLM calls if `EMBED_MESSAGES=false`
- otherwise 1 embedding batch call for message text/chunks
- 0 derivation LLM calls synchronously
- queue items created for async summary / representation / dream work

Rough cost:

- OpenAI `text-embedding-3-small` is currently listed at `$0.02 / 1M tokens`
- a 1k-token message is roughly `$0.00002`
- a 10k-token message batch is roughly `$0.0002`

#### 2. Representation batch (default background derivation)

Behind the scenes:

- 1 LLM call to `DERIVER` model
- 1 embedding batch for newly extracted observations
- optional dream scheduling

Default caps:

- input cap: `23,000` tokens
- output cap: `4,096` tokens
- thinking budget: `1,024`
- model: `gemini-2.5-flash-lite`

Rough cost:

- worst-case LLM cost is under `$0.004` per batch at current Flash-Lite pricing
- observation embeddings are usually negligible relative to the LLM call

#### 3. Summaries

Behind the scenes:

- short summary every `20` messages by default
- long summary every `60` messages by default
- each is its own LLM call

Default models:

- summary provider: `gemini-2.5-flash`
- short max output: `1,000`
- long max output: `4,000`

Rough cost:

- short summary: low single-digit mills, roughly `$0.003` to `$0.005`
- long summary: roughly around `$0.01` to `$0.02` depending on carried history

#### 4. `peer.chat()`

Behind the scenes:

- 1 query embedding for prefetch
- 2 semantic document searches (explicit + derived)
- 1 dialectic LLM call
- plus additional query embeddings if the tool loop repeatedly calls `search_memory`

The repo includes a cost calculator for the default dialectic config. Its realistic estimates are:

- `minimal`: `$0.0009`
- `low`: `$0.0077`
- `medium`: `$0.0370`
- `high`: `$0.0712`
- `max`: `$0.2440`

Worst-case `max` in the same script is `$0.7135`.

#### 5. Dreamer

Dreamer is the expensive path. It runs agentic specialists with tool loops, peer-card updates, and higher-order observation creation. This is the part I would least want to copy into Cortex unchanged.

### Pricing references used for the rough estimates

- Anthropic model pricing: <https://platform.claude.com/docs/en/about-claude/models/overview>
- Google Gemini pricing: <https://ai.google.dev/pricing>
- OpenAI embeddings pricing: <https://platform.openai.com/pricing>
- OpenAI `text-embedding-3-small` model page: <https://platform.openai.com/docs/models/text-embedding-3-small>

## Step 3: Compare to Cortex Memory

### Current Cortex snapshot on this machine

`cortex stats` currently reports:

- `23,569` memories
- `49,796` facts
- `4,889` sources
- `175,284,224` bytes on disk
- average confidence `0.9483`
- date range `2026-02-24 → 2026-03-22`

`cortex search "test" --explain` confirms Cortex already has:

- hybrid / BM25 ranking
- provenance per result
- confidence-aware scoring
- recency and source weighting
- explicit ranking explanations

That explainability is materially better than Honcho's retrieval surfaces today.

### What Honcho does that Cortex cannot currently do

1. Directional memory by observer and observed peer.
2. Session-local theory of mind with membership windows.
3. Fan-out one derived observation batch into multiple observer views.
4. Query "what does Alice know about Bob?" as a first-class operation.
5. Return context bundles that mix peer card, representation, summary, and recent chat for one specific conversational perspective.

### What Cortex does that Honcho cannot currently do

1. Run as a single local binary with SQLite and no required server stack.
2. Keep memory useful without a worker/queue service.
3. Expose explicit lifecycle controls like reinforce, supersede, keep, drop, stale, conflicts, and health from the CLI.
4. Explain retrieval ranking in detail with `--explain`.
5. Operate as a general import-first memory system across file trees and connectors, not just as a chat memory service.

### Bottom line

Honcho is better at social memory.

Cortex is better at local operational reality, lifecycle controls, and explainable retrieval.

The right move is to steal Honcho's scoping model and budgeting model, not its infra footprint.

## Step 4: Steal List

Effort scale:

- `S`: 1-2 days
- `M`: 3-7 days
- `L`: 1-2 weeks

| Pattern | What Honcho does | Can it work with SQLite/local-first? | Suggested Cortex shape | Effort |
| --- | --- | --- | --- | --- |
| Entity-scoped facts | Stores observations by `(observer, observed, workspace, optional session)` instead of one flat memory space | Yes. This is the best fit to steal. | Add optional scope columns to facts: `observer_agent`, `observed_entity`, `session_id`, `project_id`. Keep them indexed and optional so old facts still work. | `M` |
| Budget-aware recall | Packs summary + recent messages + optional representation/card into one token budget | Yes. Very strong fit. | Extend `cortex search` / IDE recall to accept a token budget, estimate token cost per fact, then greedily pack by score. Add optional compression pass only if needed. | `M` |
| "Chat with memories" | `peer.chat()` runs a tool-using memory agent | Partly already yes because Cortex has `answer` and `reason` | Do not copy the full Honcho dialectic stack. Expose a thinner `cortex ask` / IDE action that uses existing retrieval + citations + optional LLM synthesis. | `S-M` |
| Cross-agent propagation | One derivation batch fans out to many observers based on session config | Yes, if kept simple | Emit app-level events when a high-confidence fact lands. Subscribers are scoped agents/workflows. Re-materialize scoped views rather than copying raw facts blindly. | `M-L` |
| Dynamic representations | Builds session/global markdown profiles from scoped observations | Yes, but should be cached output, not source of truth | Add cached scoped profiles per `(observer, observed, session?)` built from facts under a token budget. Store as derived artifacts with invalidation on new facts or supersedes. | `L` |

### Recommended order

1. Entity-scoped facts
2. Budget-aware recall
3. Dynamic representations
4. Cross-agent propagation
5. Thin `ask` surface on top of retrieval

### What not to copy

1. Mandatory FastAPI + worker + Redis shape.
2. Import-time LLM client validation.
3. Making derived representations the primary truth instead of the underlying facts.
4. A design where memory quality depends on async LLM jobs succeeding before reads are useful.

## Cortex-Specific Recommendations

### 1. Add scope without breaking the current fact store

Do not create a separate "Honcho mode."

Add optional scope fields to the existing fact schema and keep the default global behavior when they are null.

### 2. Keep Cortex facts authoritative; make representations cached

Honcho's representations are useful, but they are secondary materializations.

Cortex should keep facts as source of truth and treat:

- agent cards
- session profiles
- role-specific memory bundles

as cached derived views.

### 3. Prefer deterministic packing before LLM compression

Honcho's 40/60 budgeting rule is simple and works. Cortex should copy that simplicity first:

- pack the highest-value facts under budget
- prefer deterministic packing
- only compress when the packer still cannot fit the needed context

### 4. Use propagation as invalidation/materialization, not blind duplication

The Honcho fan-out idea is good. The implementation to steal is:

- one upstream fact lands
- compute which agents/scopes care
- update or invalidate their scoped profile

The implementation to avoid is:

- duplicating every fact N times unless you truly need the physical copies

## Verdict

Honcho has one genuinely valuable architectural insight for Cortex Memory: memory should be perspective-aware, not just query-aware.

If Cortex adds scoped facts, token-budgeted recall, and cached scoped profiles, it gets most of Honcho's upside without inheriting its server-heavy footprint.
