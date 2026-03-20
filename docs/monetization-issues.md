# Monetization Epic — Issues to File

## Epic: Monetization — Auth, Token Relay, Cloud Cortex, Cloud Agents (#TBD)

Master epic linking all monetization work. 10-week build plan.
Labels: epic, priority:p0

Revenue Model:
- Token relay = primary revenue (15-25% margin on LLM pass-through)
- Cloud Cortex = competitive moat (persistent memory no one else has)
- Cloud agents = premium tier (agents run while your laptop sleeps)
- IDE = distribution channel (free, never gated)

Build order: Auth → Token Proxy → Billing → CortexClient → Cloud Cortex → Sync → Team Memory → Cloud Agents

---

## LAYER 1: Auth + User Database (Weeks 1-2)

### Issue: GitHub OAuth Sign-In
Labels: enhancement, priority:p0

Add GitHub OAuth login as the primary auth method.

What to build:
- `/api/v2/auth/github` — initiates OAuth flow
- `/api/v2/auth/callback` — handles GitHub callback, creates/updates user, returns JWT
- `/api/v2/auth/session` — validates JWT, returns user profile
- `src/lib/auth/jwt.ts` — JWT sign/verify utilities
- `src/lib/auth/middleware.ts` — auth middleware for protected routes
- Sign-in button on landing/onboarding page
- User profile dropdown in TitleBar (avatar, name, plan, sign out)

Auth provider options: NextAuth.js (already Next.js native), Clerk, or raw OAuth.
Recommendation: NextAuth.js — zero external dependency, works in Tauri.

### Issue: User Database Schema
Labels: enhancement, priority:p0

Create the foundational user database for all monetization features.

Schema:
```sql
-- Users table
CREATE TABLE users (
  id TEXT PRIMARY KEY,           -- UUID
  github_id INTEGER UNIQUE,
  email TEXT,
  name TEXT,
  avatar_url TEXT,
  plan TEXT DEFAULT 'free',      -- free | pro | team
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- API keys (BYOK storage, encrypted)
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  provider TEXT,                  -- anthropic | openai | google
  encrypted_key TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Usage logs (token metering)
CREATE TABLE usage_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  model TEXT,                     -- claude-opus-4-6, gpt-5.4, etc.
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  session_key TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Subscriptions (Stripe link)
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  plan TEXT,
  status TEXT,                    -- active | canceled | past_due
  current_period_end TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);
```

SQLite for local/dev, PostgreSQL for production multi-tenant.
Use Drizzle ORM or Prisma for type-safe queries.

### Issue: Auth Middleware for Protected Routes
Labels: enhancement, priority:p0

Wrap monetization API routes with auth middleware.

What to build:
- `withAuth(handler)` wrapper that validates JWT from Authorization header
- Injects `user` object into request context
- Returns 401 for missing/invalid tokens
- Rate limiting per user (not just per IP)
- Free tier: 100 req/min. Pro: 1000 req/min. Team: 5000 req/min.

Existing routes (v1) remain unprotected for local/self-hosted use.
New v2 routes require auth.

---

## LAYER 2: Token Relay + Billing (Weeks 3-4)

### Issue: Unified Chat Send Route (Token Proxy)
Labels: enhancement, priority:p0

Single `/api/v2/chat/send` route that replaces the 3 separate send routes for managed-token users.

Current architecture (3 routes):
- `/api/claude-code/send` → spawns `claude -p` locally
- `/api/codex/send` → spawns `codex exec` locally
- `/api/mobile/action` → OpenClaw gateway

New unified route:
- POST `/api/v2/chat/send` with `{ runtime, message, sessionKey }`
- Auth middleware checks user plan
- BYOK users: routes to existing v1 endpoints (no change)
- Managed users: routes to `/api/v2/proxy/llm` with our API keys
- Streams response back via SSE (same format as current routes)

### Issue: LLM Provider Proxy
Labels: enhancement, priority:p0

The core token relay service. Routes LLM calls through our infrastructure.

`/api/v2/proxy/llm/route.ts`:
1. Receives chat request with user JWT
2. Validates user plan + remaining budget
3. Selects provider API key from our pool
4. Forwards request to Anthropic/OpenAI/Google API
5. Streams response back to client
6. Logs token usage to `usage_logs` table
7. Deducts from user's monthly budget

Provider key management:
- Store our API keys in environment variables (not in DB)
- Key rotation support (multiple keys per provider)
- Automatic failover if one provider is down
- Model mapping: user requests "fast" → routes to cheapest available

Budget enforcement:
- Pro plan: $40/mo included tokens
- Check remaining budget before each request
- Return 402 Payment Required if budget exhausted
- Overage option: charge per-token beyond budget

### Issue: Stripe Billing Integration
Labels: enhancement, priority:p0

Stripe subscription management for paid plans.

What to build:
- `/api/v2/billing/checkout` — creates Stripe Checkout session
- `/api/v2/billing/portal` — redirects to Stripe Customer Portal
- `/api/v2/billing/webhook` — handles subscription events (created, updated, canceled, payment_failed)
- `/api/v2/billing/usage` — returns current period usage + remaining budget
- Stripe Products: Free, Pro ($50/mo), Team ($20/seat/mo)
- Usage-based component for overage billing

Stripe webhook events to handle:
- `customer.subscription.created` → activate plan
- `customer.subscription.updated` → plan change
- `customer.subscription.deleted` → downgrade to free
- `invoice.payment_failed` → flag account, grace period
- `invoice.paid` → reset monthly budget

### Issue: Usage Dashboard Component
Labels: enhancement, priority:p1

Visual usage tracking in the IDE Settings page.

What to build:
- New "Usage" tab in SettingsPage.tsx
- Daily/weekly/monthly token consumption chart
- Cost breakdown by model (pie chart)
- Cost breakdown by agent/session
- Remaining budget indicator (progress bar)
- Overage warnings
- "Upgrade Plan" CTA for free users

Reuse existing analytics infrastructure from `/api/panel/analytics` and `/api/panel/session-costs`.

---

## LAYER 3: Cloud Cortex (Weeks 5-8)

### Issue: CortexClient Abstraction Layer
Labels: enhancement, priority:p0, area:memory

Abstract Cortex access so it can be local, cloud, or hybrid.

`src/lib/cortex/client.ts`:
```typescript
interface CortexClient {
  search(query: string, limit?: number): Promise<Fact[]>
  store(text: string): Promise<void>
  graph(factId: string): Promise<GraphData>
  stale(limit?: number): Promise<Fact[]>
  stats(): Promise<CortexStats>
  sync(): Promise<SyncResult>
}

class LocalCortexClient implements CortexClient { /* shells out to cortex binary */ }
class CloudCortexClient implements CortexClient { /* HTTPS to cloud API */ }
class HybridCortexClient implements CortexClient { /* reads local, writes both, syncs */ }
```

Migrate existing 5 Cortex API routes to use `getCortexClient()` instead of `exec(cortex ...)`.
Client selection based on user settings (local/cloud/hybrid).

### Issue: Cloud Cortex Go HTTP Service
Labels: enhancement, priority:p0, area:memory

Hosted Cortex service for cloud memory.

What to build:
- Go HTTP server wrapping the Cortex engine
- Multi-tenant: namespace per user ID
- API endpoints:
  - POST `/api/v1/search` — hybrid search (BM25 + semantic)
  - POST `/api/v1/store` — store memory + extract facts
  - GET `/api/v1/graph/:factId` — provenance graph
  - GET `/api/v1/stats` — memory statistics
  - POST `/api/v1/sync` — receive sync payload from local client
- Storage: PostgreSQL with pgvector for embeddings
- Auth: JWT validation (same tokens as IDE)
- Deploy: Fly.io (Go binary in Docker, 256MB RAM per instance)

Separate repo: `hurttlocker/cortex-cloud` or folder in `hurttlocker/cortex`.

### Issue: Local ↔ Cloud Sync Protocol
Labels: enhancement, priority:p1, area:memory

Bidirectional sync between local Cortex SQLite and Cloud Cortex.

Sync protocol:
1. Local tracks last_sync_timestamp
2. On sync: query local for facts modified after last_sync
3. Upload new/modified facts to cloud (encrypted payload)
4. Download cloud facts modified after last_sync (from other devices/team)
5. Apply remote facts to local SQLite
6. Update last_sync_timestamp

Conflict handling:
- Same fact modified on both → keep both versions, flag for resolution
- Leverage existing conflict resolution UI (#82)
- Provenance chain preserved across sync

Sync triggers:
- Every 5 minutes (background timer)
- On explicit "Sync Now" button
- On app launch
- On significant memory operation (store 10+ facts)

Changes needed in Cortex Go binary:
- `cortex sync export --since TIMESTAMP` — exports facts as JSON
- `cortex sync import --file payload.json` — imports facts
- `cortex sync status` — shows last sync time, pending changes

### Issue: Team Memory Pools
Labels: enhancement, priority:p2, area:memory

Shared memory spaces for team collaboration.

What to build:
- Team admin creates a "memory pool" (named shared fact space)
- Team members can opt facts into the shared pool
- Agents can search both personal + team memory
- Access control: admin, member, read-only roles
- Use case: one agent learns a codebase pattern → entire team benefits

Database additions:
```sql
CREATE TABLE teams (id, name, owner_id, created_at);
CREATE TABLE team_members (team_id, user_id, role, joined_at);
CREATE TABLE memory_pools (id, team_id, name, created_at);
CREATE TABLE pool_facts (pool_id, fact_id, contributed_by, created_at);
```

---

## LAYER 4: Cloud Agents (Weeks 9-10)

### Issue: Cloud Agent Container Launcher
Labels: enhancement, priority:p1, area:runtime

Launch agents in cloud containers instead of locally.

Add `target: 'local' | 'cloud'` to LaunchConfig in `src/lib/runtime/launch.ts`.

When `target === 'cloud'`:
1. Call Fly Machines API to create a container
2. Pass: repo URL, git branch, task description, user's Cortex cloud token
3. Container clones repo, runs agent CLI, streams output via WebSocket
4. On completion: push git changes, destroy container

Container image (pre-built, stored in registry):
- Base: Ubuntu 22.04 + Node 20 + Python 3.12 + Git
- Pre-installed: `codex`, `claude`, `cortex` binaries
- Entrypoint: reads env vars (REPO_URL, TASK, RUNTIME, WS_URL)
- Streams all stdout/stderr to WS_URL

Fly Machine config:
- Size: shared-cpu-2x, 2GB RAM (enough for agent CLI)
- Auto-stop after 30min idle
- Max lifetime: 2 hours
- Region: auto (closest to user)

### Issue: Cloud Agent WebSocket Bridge
Labels: enhancement, priority:p1, area:runtime

Bridge cloud container output into the existing WS server.

`ws-server.ts` changes:
- New message type: `{ type: "cloud-agent-stream", containerId, data }`
- Cloud container connects to our WS server as a client
- WS server rebroadcasts container output to the user's IDE connection
- Same channel format as local terminal (`terminal` channel)

The IDE frontend doesn't change — it already renders terminal output from ws-server.ts. Whether data comes from local PTY or remote container is invisible to the UI.

### Issue: Cloud Agent Cleanup + Cost Control
Labels: enhancement, priority:p2, area:runtime

Ensure cloud containers don't run forever and costs are controlled.

What to build:
- Container watchdog: kill containers exceeding 2h lifetime
- Usage tracking: compute-minutes per user per month
- Cost allocation: cloud compute billed separately from token usage
- Plan limits: Pro = 100 compute-hours/mo, Team = 500/mo
- Idle detection: no output for 10min → warn user → 15min → auto-stop
- Cleanup cron: sweep orphaned containers every hour
