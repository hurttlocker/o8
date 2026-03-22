# Cortex Honcho Steal Specs

Date: 2026-03-22  
Target: Cortex binary (`~/bin/cortex`)  
Purpose: turn the Honcho steal list into concrete binary-facing implementation specs

## Scope

This spec covers:

1. Entity-scoped facts
2. Budget-aware recall
3. `cortex ask`
4. Cross-agent propagation
5. Incremental rollout

Design constraints:

- do not break current Cortex users
- keep SQLite/local-first
- keep existing `facts` / `memories` usable during rollout
- prefer additive migrations
- keep old CLI surfaces working while new ones ship

Current live `facts` schema:

```sql
CREATE TABLE facts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id       INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  subject         TEXT,
  predicate       TEXT,
  object          TEXT,
  fact_type       TEXT NOT NULL CHECK(fact_type IN ('kv','relationship','preference','temporal','identity','location','decision','state','config')),
  confidence      REAL DEFAULT 1.0,
  decay_rate      REAL DEFAULT 0.01,
  last_reinforced DATETIME DEFAULT CURRENT_TIMESTAMP,
  source_quote    TEXT,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  superseded_by   INTEGER REFERENCES facts(id),
  agent_id        TEXT NOT NULL DEFAULT '',
  state           TEXT NOT NULL DEFAULT 'active'
);
```

## 1. Entity-Scoped Facts

Priority: 1  
Effort: `M` (`3-5` days binary-only, `5-7` days including IDE integration)

### Goal

Add Honcho-style directional scope to facts without breaking global search.

The scope tuple is:

- `observer_agent`
- `observed_entity`
- `session_id`
- `project_id`

`agent_id` remains for backward compatibility and is treated as a legacy alias for `observer_agent`.

### SQLite migration

Run exactly:

```sql
ALTER TABLE facts ADD COLUMN observer_agent TEXT NOT NULL DEFAULT '';
ALTER TABLE facts ADD COLUMN observed_entity TEXT NOT NULL DEFAULT '';
ALTER TABLE facts ADD COLUMN session_id TEXT NOT NULL DEFAULT '';
ALTER TABLE facts ADD COLUMN project_id TEXT NOT NULL DEFAULT '';
```

Backfill:

```sql
UPDATE facts
SET observer_agent = agent_id
WHERE observer_agent = ''
  AND agent_id <> '';

UPDATE facts
SET project_id = COALESCE((
  SELECT m.project
  FROM memories m
  WHERE m.id = facts.memory_id
), '')
WHERE project_id = '';

UPDATE facts
SET observed_entity = '',
    session_id = ''
WHERE observed_entity = ''
   OR session_id = '';
```

Indexes:

```sql
CREATE INDEX idx_facts_observer_agent
  ON facts(observer_agent);

CREATE INDEX idx_facts_observed_entity
  ON facts(observed_entity);

CREATE INDEX idx_facts_session_id
  ON facts(session_id);

CREATE INDEX idx_facts_project_id
  ON facts(project_id);

CREATE INDEX idx_facts_scope_lookup
  ON facts(project_id, observer_agent, observed_entity, session_id, state, superseded_by);

CREATE INDEX idx_facts_scope_subject_predicate
  ON facts(project_id, observer_agent, observed_entity, subject, predicate, state, superseded_by);
```

### Backfill strategy for existing 47K+ facts

Do not attempt heuristic observer/entity inference on the 47K+ existing facts.

Backfill rules:

1. `observer_agent`:
   - copy from legacy `agent_id`
   - if `agent_id=''`, leave blank
2. `project_id`:
   - copy from `memories.project`
3. `observed_entity`:
   - blank
4. `session_id`:
   - blank

Semantics:

- blank scope columns mean "global / legacy / unknown scope"
- old facts remain searchable globally
- no existing result disappears

Optional later enrichment command:

```bash
cortex scope backfill --from-memory-metadata
```

That command is out of scope for v1. The initial rollout should be deterministic and lossless only.

### Effective observer rule during migration

For one release cycle:

- writes populate both `observer_agent` and `agent_id`
- reads use `observer_agent` if set, otherwise `agent_id`

Canonical SQL expression:

```sql
COALESCE(NULLIF(f.observer_agent, ''), f.agent_id)
```

### CLI changes: import/extract

Add repeated `--scope` flags to the following commands:

- `cortex import`
- `cortex refresh-source`
- `cortex extract`
- `cortex update`

Supported dimensions:

- `agent:<id>`
- `entity:<id>`
- `session:<id>`
- `project:<id>`

Import-time rule:

- for write commands, allow at most one value per dimension
- duplicate dimensions are an error

Examples:

```bash
cortex import ~/notes --extract \
  --scope project:cortex-ide \
  --scope agent:niot \
  --scope entity:Q \
  --scope session:desktop-tab-42
```

```bash
cortex extract ./tmp/exchange.md \
  --scope project:cortex-ide \
  --scope agent:assistant \
  --scope entity:user
```

Resolved write scope:

```go
type FactScope struct {
  ObserverAgent string
  ObservedEntity string
  SessionID string
  ProjectID string
}
```

Write-path behavior:

1. parse CLI scopes
2. merge with existing memory row scope if command is `refresh-source` or `update`
3. write `memories.project = scope.ProjectID` if non-empty
4. also store full scope JSON in `memories.metadata`
5. when extracted facts are inserted, populate all four scope columns
6. mirror `observer_agent` into legacy `agent_id`

Proposed `memories.metadata` write shape:

```json
{
  "scope": {
    "observer_agent": "niot",
    "observed_entity": "Q",
    "session_id": "desktop-tab-42",
    "project_id": "cortex-ide"
  }
}
```

Fact insert shape:

```sql
INSERT INTO facts (
  memory_id,
  subject,
  predicate,
  object,
  fact_type,
  confidence,
  decay_rate,
  source_quote,
  agent_id,
  observer_agent,
  observed_entity,
  session_id,
  project_id,
  state
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active');
```

### CLI changes: search

Add repeated `--scope` flags to:

- `cortex search`
- `cortex query`
- `cortex answer`
- `cortex reason`
- new `cortex ask`

Examples:

```bash
cortex search "trading preferences" --scope agent:niot
```

```bash
cortex search "risk tolerance" \
  --scope agent:niot \
  --scope entity:Q \
  --scope project:cortex-ide
```

```bash
cortex search "auth decision" \
  --scope agent:niot \
  --scope agent:hawk \
  --scope project:cortex-ide
```

Scope semantics:

- same dimension repeated => `OR`
- different dimensions combined => `AND`

So this:

```bash
--scope agent:niot --scope agent:hawk --scope entity:Q
```

means:

```text
(observer_agent IN ('niot','hawk')) AND (observed_entity = 'Q')
```

### Backward compatibility when scope is omitted

If no `--scope` flags are provided:

- behavior stays global
- the search path does not filter on the four new columns
- existing commands keep returning old and new facts together

Legacy compatibility:

- existing `--agent <id>` remains
- internally it is translated to `--scope agent:<id>`

### Search parser pseudo-code

```go
type SearchScope struct {
  Agents   []string
  Entities []string
  Sessions []string
  Projects []string
}

func ParseScopes(flags []string, legacyAgent string) SearchScope {
  s := SearchScope{}
  if legacyAgent != "" {
    s.Agents = append(s.Agents, legacyAgent)
  }
  for _, raw := range flags {
    parts := strings.SplitN(raw, ":", 2)
    if len(parts) != 2 || parts[1] == "" {
      fatal("--scope must be dimension:value")
    }
    switch parts[0] {
    case "agent":
      s.Agents = append(s.Agents, parts[1])
    case "entity":
      s.Entities = append(s.Entities, parts[1])
    case "session":
      s.Sessions = append(s.Sessions, parts[1])
    case "project":
      s.Projects = append(s.Projects, parts[1])
    default:
      fatal("unsupported scope dimension")
    }
  }
  s.Agents = uniq(s.Agents)
  s.Entities = uniq(s.Entities)
  s.Sessions = uniq(s.Sessions)
  s.Projects = uniq(s.Projects)
  return s
}
```

### Actual SQL: current unscoped fact fetch

Current effective unscoped fetch after ranked memory selection:

```sql
WITH ranked_memories AS (
  SELECT
    m.id AS memory_id,
    bm25(memories_fts) AS bm25_score
  FROM memories_fts
  JOIN memories m ON m.id = memories_fts.rowid
  WHERE memories_fts MATCH :query
    AND m.deleted_at IS NULL
)
SELECT
  f.id,
  f.memory_id,
  f.subject,
  f.predicate,
  f.object,
  f.fact_type,
  f.confidence,
  f.source_quote,
  f.created_at,
  m.source_file,
  m.source_line,
  m.source_section,
  m.project
FROM ranked_memories rm
JOIN facts f ON f.memory_id = rm.memory_id
JOIN memories m ON m.id = f.memory_id
WHERE f.state = 'active'
  AND f.superseded_by IS NULL
ORDER BY rm.bm25_score, f.confidence DESC
LIMIT :limit;
```

### Actual SQL: new scoped fact fetch

Scoped version:

```sql
WITH ranked_memories AS (
  SELECT
    m.id AS memory_id,
    bm25(memories_fts) AS bm25_score
  FROM memories_fts
  JOIN memories m ON m.id = memories_fts.rowid
  WHERE memories_fts MATCH :query
    AND m.deleted_at IS NULL
),
candidate_facts AS (
  SELECT
    f.*,
    m.source_file,
    m.source_line,
    m.source_section,
    m.project AS memory_project,
    COALESCE(NULLIF(f.observer_agent, ''), f.agent_id) AS effective_observer
  FROM ranked_memories rm
  JOIN facts f ON f.memory_id = rm.memory_id
  JOIN memories m ON m.id = f.memory_id
  WHERE f.state = 'active'
    AND f.superseded_by IS NULL
)
SELECT *
FROM candidate_facts cf
WHERE (
    :agent_count = 0
    OR cf.effective_observer IN (SELECT value FROM json_each(:agents_json))
  )
  AND (
    :entity_count = 0
    OR cf.observed_entity IN (SELECT value FROM json_each(:entities_json))
  )
  AND (
    :session_count = 0
    OR cf.session_id IN (SELECT value FROM json_each(:sessions_json))
  )
  AND (
    :project_count = 0
    OR COALESCE(NULLIF(cf.project_id, ''), cf.memory_project)
       IN (SELECT value FROM json_each(:projects_json))
  )
ORDER BY cf.confidence DESC, cf.created_at DESC
LIMIT :limit;
```

Implementation note:

- pass scope arrays as JSON arrays to SQLite
- do not build dynamic SQL per flag combination

## 2. Budget-Aware Recall

Priority: 2  
Effort: `M` (`2-4` days binary, `1-2` days IDE wire-up)

### Goal

Replace "fixed top N results" with "pack as much high-value memory as fits in a token budget."

New CLI flag:

```bash
cortex search "deadline change" --budget 3000
```

### SQLite migration

Add cached token estimate:

```sql
ALTER TABLE facts ADD COLUMN token_estimate INTEGER NOT NULL DEFAULT 0;
```

Backfill:

```sql
UPDATE facts
SET token_estimate = MAX(
  1,
  CAST((
    LENGTH(
      TRIM(
        COALESCE(subject, '') || ' ' ||
        COALESCE(predicate, '') || ' ' ||
        COALESCE(object, '')
      )
    ) + 3
  ) / 4 AS INTEGER)
)
WHERE token_estimate = 0;
```

Index:

```sql
CREATE INDEX idx_facts_token_estimate
  ON facts(token_estimate);
```

### Token estimation rule

Use a model-agnostic cached estimate, not `tiktoken`.

Rule:

```text
token_estimate = max(1, ceil(len(rendered_fact_text) / 4))
```

Why:

- deterministic
- no remote tokenizer dependency
- cheap to backfill
- good enough for packing

Write-time behavior:

1. render the fact as the same text the CLI would show
2. compute `ceil(chars/4)`
3. store in `facts.token_estimate`

Read-time fallback:

- if `token_estimate = 0`, recompute in Go on the fly and update lazily

### Search behavior with `--budget`

`--budget` does not change ranking. It changes final packing.

Search pipeline:

1. run search as today
2. fetch a larger candidate pool
3. greedily pack results in score order until budget is exhausted

Candidate pool rules:

```text
if budget unset:
  use current limit behavior

if budget set and limit unset:
  internal candidate limit = 50

if budget set and limit set:
  internal candidate limit = max(limit, 50)
```

### Greedy packing algorithm

Pseudo-code:

```go
func PackByBudget(results []SearchResult, budget int) PackedResults {
  packed := []SearchResult{}
  used := 0

  for _, r := range results {
    cost := r.TokenEstimate
    if cost <= 0 {
      cost = EstimateTokens(r.RenderedText)
    }

    if cost <= (budget - used) {
      packed = append(packed, r)
      used += cost
      continue
    }

    // If nothing fits yet, include one clipped result so search does not return empty.
    if len(packed) == 0 && budget >= 32 {
      clipped := ClipResultToBudget(r, budget)
      clipped.Truncated = true
      clipped.TokenEstimate = budget
      packed = append(packed, clipped)
      used = budget
    }
  }

  return PackedResults{
    Budget: budget,
    PackedTokens: used,
    Results: packed,
  }
}
```

### JSON output shape

When `--budget` and `--json` are set, return an envelope instead of a bare array:

```json
{
  "query": "deadline change",
  "mode": "hybrid",
  "budget": 3000,
  "packed_tokens": 2874,
  "candidate_count": 50,
  "returned_count": 18,
  "results": [
    {
      "memory_id": 123,
      "fact_ids": [456],
      "content": "...",
      "snippet": "...",
      "score": 0.93,
      "match_type": "hybrid",
      "token_estimate": 64,
      "truncated": false
    }
  ]
}
```

When `--budget` is omitted, keep the existing array output for full backward compatibility.

### Text output

Text mode stays current-style plus footer:

```text
18 results
Packed 2874 / 3000 estimated tokens
```

### SQL for budgeted fetch

Budgeting happens in Go after ranking. SQL stays rank-oriented.

Optional future optimization:

```sql
ORDER BY final_score DESC, token_estimate ASC
```

Do not do that in v1. Keep ranking pure and pack in application code.

### IDE Phase A change

Current IDE recall path in `src/lib/llm/memory.ts` uses:

- `MAX_RECALL_TOKENS = 800`
- `MAX_RECALL_RESULTS = 10`
- `MAX_FACTS = 10`

Replace with:

```ts
const DEFAULT_RECALL_BUDGET = 1200;
const MAX_RECALL_CANDIDATES = 50;
```

New call shape:

```bash
cortex search "<query>" --mode hybrid --budget 1200 --limit 50 --json
```

Preferred budget heuristic:

```text
budget = clamp(floor(model_context_window * 0.015), 800, 2000)
```

If model window is unknown in the IDE, default to `1200`.

Phase A implementation changes:

1. stop hard-capping at 10 facts before asking Cortex
2. ask Cortex for a budget-packed result set
3. use `packed_tokens` from search output
4. inject until Cortex budget is exhausted, not until local `MAX_FACTS`

Pseudo-code:

```ts
const budget = deriveRecallBudget(modelContextWindow);
const packed = await cortex.search(userMessage, {
  mode: 'hybrid',
  budget,
  limit: 50,
  json: true,
  scope: derivedScopes,
});

if (packed.results.length > 0) {
  systemPrompt += renderRecallBlock(packed.results);
}
```

### IDE Phase A scope derivation

When possible, the IDE should also pass:

- `project:<repoName>`
- `session:<tabId>`
- `agent:<activeAssistantName>` for agent-local recall

This is how scoped facts become valuable immediately.

## 3. `cortex ask`

Priority: 3  
Effort: `M` (`3-4` days after scoped search + budgets land)

### Goal

Add a thin synthesis layer on top of search:

```bash
cortex ask "What are Q's trading preferences?"
```

### Command shape

```bash
cortex ask "<query>" \
  [--scope agent:niot] \
  [--scope entity:Q] \
  [--scope project:cortex-ide] \
  [--mode bm25|semantic|hybrid|rrf] \
  [--embed <provider/model>] \
  [--budget 1500] \
  [--limit 24] \
  [--model <provider/model>] \
  [--max-sentences 6] \
  [--json]
```

### Retrieval behavior

`ask` is search-first and fact-first:

1. run `search` internally
2. respect `--scope`
3. respect `--budget`
4. respect explicit `--mode`
5. do not silently degrade explicit `--mode hybrid`

Rules:

- if user explicitly passes `--mode hybrid` and no embedder exists: hard error
- if user does not pass `--mode`, choose:
  - `hybrid` if embedder configured
  - otherwise `bm25`

### How it differs from `cortex answer`

`cortex answer` today:

- has its own search path
- can degrade out of hybrid mode
- returns degraded fallback JSON when LLM or embedder config is missing

Live example on this machine:

```text
Note: hybrid mode requires an embedder; falling back to BM25 keyword search.
Use --embed <provider/model> for hybrid results.
```

`cortex ask` should be the stricter replacement:

- one internal retrieval path: the same search path users can call directly
- no hidden retrieval fallback when mode is explicit
- budget and scope are first-class
- LLM synthesis only after retrieval is resolved

Migration rule:

- ship `ask`
- keep `answer` unchanged for one release
- later re-implement `answer` as a compatibility wrapper around `ask`

### Default LLM selection

Use the cheapest configured synthesis model in this order:

1. `gemini-2.5-flash-lite`
2. `gemini-2.5-flash`
3. `claude-haiku-4-5`
4. `gpt-4o-mini`

Add config:

```text
CORTEX_ASK_MODEL=<provider/model>
```

If set, it overrides the default selector.

### Internal pipeline

Pseudo-code:

```go
func Ask(query string, opts AskOptions) AskResponse {
  searchResp := Search(query, SearchOptions{
    Scope:  opts.Scope,
    Mode:   opts.Mode,
    Embed:  opts.Embed,
    Budget: opts.BudgetOrDefault(1500),
    Limit:  opts.LimitOrDefault(24),
    JSON:   true,
  })

  if len(searchResp.Results) == 0 {
    return AskResponse{
      Answer: "I don't have enough memory to answer that.",
      Citations: nil,
      Results: searchResp.Results,
      Degraded: false,
    }
  }

  model := ResolveAskModel(opts.Model)
  if model == nil {
    return AskResponse{
      Answer: "",
      Citations: BuildCitations(searchResp.Results),
      Results: searchResp.Results,
      Degraded: true,
      Reason: "no_llm_configured",
    }
  }

  prompt := BuildAskPrompt(query, searchResp.Results, opts.MaxSentences)
  raw := model.Generate(prompt)
  validated := ValidateCitationIndices(raw, len(searchResp.Results))
  return BuildAskResponse(validated, searchResp)
}
```

### Prompt template

System prompt:

```text
You are Cortex Ask, a memory-grounded synthesis layer.

Answer ONLY from the supplied facts and snippets.

Rules:
- Do not use outside knowledge.
- If the supplied memory is insufficient, say you do not know.
- If the supplied memory conflicts, state the conflict explicitly.
- Prefer active, unsuperseded, higher-confidence facts.
- Keep the answer under {max_sentences} sentences.
- Every factual claim must cite one or more source indices like [1] or [2][4].
- Do not cite indices that were not supplied.
```

User prompt:

```text
Question:
{query}

Available memory:
{for each result i}
[{i}] {rendered_text}
Source: {source_file}:{source_line}
Confidence: {confidence}
Score: {score}
{/for}

Write:
1. A direct answer.
2. A short "Conflicts" note only if needed.
3. A short "Insufficient memory" note only if needed.
```

### JSON output shape

```json
{
  "query": "What are Q's trading preferences?",
  "answer": "Q prefers ... [1][3]",
  "citations": [
    {
      "index": 1,
      "source": "/path/file.md:42",
      "memory_id": 123,
      "fact_ids": [456],
      "score": 0.91
    }
  ],
  "results": [...],
  "degraded": false,
  "reason": ""
}
```

## 4. Cross-Agent Propagation

Priority: 4  
Effort: `M-L` (`5-8` days MVP, `8-12` days full)

### Goal

Make high-value facts visible across scoped agents without duplicating raw facts blindly.

### Event mechanism

Use the existing `memory_events` SQLite table as the event log.

Do not use:

- filesystem watchers
- SQLite triggers in v1
- long-lived IPC daemons as the only path

Write events from application code immediately after successful fact mutation.

Event emit points:

- fact insert
- fact update
- fact reinforce
- fact supersede
- fact drop / retire

Canonical insert:

```sql
INSERT INTO memory_events (
  event_type,
  fact_id,
  old_value,
  new_value,
  source
) VALUES (?, ?, ?, ?, ?);
```

Event payload format in `new_value` / `old_value`:

```json
{
  "id": 123,
  "memory_id": 456,
  "subject": "Q",
  "predicate": "prefers",
  "object": "tight spreads for live trading",
  "fact_type": "preference",
  "confidence": 0.93,
  "state": "active",
  "observer_agent": "mister",
  "observed_entity": "Q",
  "session_id": "desktop-tab-42",
  "project_id": "cortex-ide"
}
```

### Subscription mechanism

Add a dedicated table:

```sql
CREATE TABLE propagation_subscriptions_v1 (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_agent  TEXT NOT NULL,
  source_agent      TEXT NOT NULL DEFAULT '',
  observed_entity   TEXT NOT NULL DEFAULT '',
  project_id        TEXT NOT NULL DEFAULT '',
  fact_type         TEXT NOT NULL DEFAULT '',
  predicate         TEXT NOT NULL DEFAULT '',
  min_confidence    REAL NOT NULL DEFAULT 0.85,
  mode              TEXT NOT NULL DEFAULT 'share' CHECK(mode IN ('share','profile')),
  active            INTEGER NOT NULL DEFAULT 1,
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_prop_subs_active
  ON propagation_subscriptions_v1(active, subscriber_agent, project_id);
```

CLI registration:

```bash
cortex propagate subscribe \
  --to agent:niot \
  --from agent:mister \
  --from entity:Q \
  --project cortex-ide \
  --fact-type preference \
  --min-confidence 0.85
```

Stored semantics:

- `subscriber_agent` = who should gain visibility
- `source_agent` = optional originating observer constraint
- `observed_entity` = optional entity constraint
- `project_id` = optional project constraint
- `fact_type` / `predicate` = optional narrow filters

### What is a high-confidence fact worth propagating

MVP propagation predicate:

```text
state = 'active'
AND superseded_by IS NULL
AND confidence >= 0.85
AND fact_type IN ('preference','decision','config','state','identity','relationship')
AND observer_agent <> ''
AND observed_entity <> ''
```

Do not propagate by default:

- `temporal` unless confidence >= `0.95`
- `location` unless explicitly subscribed
- facts with blank observer or blank observed entity

### Minimal viable implementation

Do not copy facts.

Use a share table:

```sql
CREATE TABLE fact_shares_v1 (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  fact_id           INTEGER NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  subscriber_agent  TEXT NOT NULL,
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(fact_id, subscriber_agent)
);

CREATE INDEX idx_fact_shares_subscriber
  ON fact_shares_v1(subscriber_agent, fact_id);
```

Consumer cursor stored in `meta`:

```sql
INSERT OR REPLACE INTO meta(key, value)
VALUES ('propagation_cursor_v1', '0');
```

Worker command:

```bash
cortex propagate run --once
cortex propagate run --watch
```

MVP worker pseudo-code:

```go
cursor := meta["propagation_cursor_v1"]
events := LoadMemoryEventsAfter(cursor)

for _, ev := range events {
  fact := DecodeFactSnapshot(ev.NewValue)
  if !EligibleForPropagation(fact) {
    continue
  }

  subs := FindMatchingSubscriptions(fact)
  for _, sub := range subs {
    if sub.Mode == "share" {
      InsertFactShare(fact.ID, sub.SubscriberAgent)
    } else if sub.Mode == "profile" {
      MarkProfileDirty(sub.SubscriberAgent, fact.ObservedEntity, fact.ProjectID)
    }
  }

  cursor = ev.ID
}

SaveMeta("propagation_cursor_v1", cursor)
```

Scoped search change for shares:

If `--scope agent:niot` is active, treat facts as visible when either:

- `effective_observer = 'niot'`
- or `fact_shares_v1.subscriber_agent = 'niot'`

Visibility SQL fragment:

```sql
LEFT JOIN fact_shares_v1 fs
  ON fs.fact_id = cf.id

WHERE (
  :agent_count = 0
  OR cf.effective_observer IN (SELECT value FROM json_each(:agents_json))
  OR fs.subscriber_agent IN (SELECT value FROM json_each(:agents_json))
)
```

### Full implementation

After MVP works:

1. add cached scoped profiles:
   - key: `(subscriber_agent, observed_entity, project_id)`
2. use propagation events to invalidate/rebuild profiles
3. expose:

```bash
cortex profile build --scope agent:niot --scope entity:Q --scope project:cortex-ide
cortex profile show  --scope agent:niot --scope entity:Q --scope project:cortex-ide
```

Do not add fact-copying unless profiles plus shares prove insufficient.

## 5. Migration Path

Priority: rollout  
Effort: ongoing

### Order of implementation

Ship in this order:

1. scoped fact columns + search filters
2. budget-aware search
3. IDE Phase A and Phase B wiring to scopes + budgets
4. `cortex ask`
5. propagation shares + subscriptions
6. cached scoped profiles

### Why this order

1. scoped columns make the model possible
2. budget-aware search improves recall quality immediately, even globally
3. IDE gets user-visible gains early
4. `ask` becomes reliable only after search/scope/budget are stable
5. propagation depends on scoped facts existing
6. profiles should be last because they are cached materializations, not source of truth

### Binary rollout plan

#### Release 1

- add scope columns
- backfill from `agent_id` + `memories.project`
- support `--scope` on search/query/import/extract
- keep `--agent` as alias

No user-visible behavior change if scopes are omitted.

#### Release 2

- add `token_estimate`
- add `search --budget`
- return budget envelope only when `--budget` is present

Old JSON output remains unchanged when `--budget` is absent.

#### Release 3

- add `ask`
- keep `answer`
- document that `ask` is the preferred synthesis path

#### Release 4

- add `propagation_subscriptions_v1`
- add `fact_shares_v1`
- add `propagate run`

#### Release 5

- add cached profiles / scoped cards

### IDE changes needed

#### Phase A

Current:

- fixed local caps
- query is global unless `--agent` exists elsewhere

Change to:

1. compute `project_id` from repo/workspace
2. compute `session_id` from tab/session UUID
3. compute `observer_agent` from active agent lane if available
4. call:

```bash
cortex search "<query>" \
  --mode hybrid \
  --budget <derived_budget> \
  --scope project:<repo> \
  --scope session:<tab> \
  [--scope agent:<agent>]
```

5. inject packed results directly

#### Phase B

Current extraction writes unscoped durable facts.

Change to:

1. pass the same scope tuple used in Phase A
2. when the IDE extracts from a user/assistant exchange:

```text
observer_agent = active agent or assistant lane id
observed_entity = stable user handle or tab owner label
session_id = tab id / chat id
project_id = repo slug or cwd-derived project key
```

3. call write path with those scopes
4. let the binary emit `memory_events`

### Exact Phase B mapping recommendation

For current IDE code:

- `project_id`: repo name or normalized cwd slug
- `session_id`: existing `tabId`
- `observer_agent`: active assistant or runtime lane name
- `observed_entity`: stable user label; use `'user'` if no better ID exists

### Risk controls

1. blank scope columns always mean global legacy behavior
2. all new CLI behavior is opt-in
3. keep `agent_id` until one full release after `observer_agent` ships
4. never mutate old facts heuristically during initial backfill
5. do not couple propagation to copied facts in MVP

## Build Checklist

### Scoped facts

- [ ] add four columns
- [ ] backfill SQL
- [ ] add indexes
- [ ] parse repeated `--scope`
- [ ] support `--agent` alias
- [ ] write scopes during import/extract/update
- [ ] read scopes during search/query/answer/reason

### Budget recall

- [ ] add `token_estimate`
- [ ] backfill `token_estimate`
- [ ] implement candidate pool expansion
- [ ] implement greedy packing
- [ ] emit budget envelope JSON
- [ ] wire IDE Phase A to `--budget`

### Ask

- [ ] add command parser
- [ ] unify internal search path with `search`
- [ ] add model resolver
- [ ] implement strict hybrid handling
- [ ] implement citation prompt
- [ ] return degraded JSON when no LLM

### Propagation

- [ ] emit structured `memory_events`
- [ ] add subscriptions table
- [ ] add shares table
- [ ] add propagation cursor in `meta`
- [ ] implement `propagate run --once`
- [ ] implement `propagate run --watch`
- [ ] extend scoped search visibility with shares

## Recommended owner split

If Niot is implementing against the Cortex binary, split work this way:

1. Migration + scope parser + search/query filtering
2. Budget packing + JSON envelope + IDE Phase A consumer
3. `ask`
4. propagation

That sequence keeps the first two deliverables independently shippable.
