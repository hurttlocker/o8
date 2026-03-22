# Alibaba Page Agent Audit

Issue: #251  
Audit date: 2026-03-22

Audited snapshot:
- `alibaba/page-agent` @ `6dd0ceab73b8e612d0c1be6b53655e9c3ce4e7e5`
- repo version: `1.6.1`

## Bottom line

Page Agent is a strong reference for **in-page natural-language UI control**, but it is **not the right primary navigation/control architecture for Cortex IDE**.

Two separate answers matter here:

- **Does it technically run inside a Tauri webview?** Yes, with caveats.
- **Should Cortex use it as the main in-app copilot/navigation layer?** No.

The right recommendation for Cortex IDE is:

- **adapt selected ideas**
- **do not adopt the full Page Agent stack as the core UI copilot**
- **build a component-aware Cortex action layer first**
- optionally use a narrowed Page Agent-style DOM fallback for a read-only or guided `"Help me find..."` mode

## What was audited

### Upstream docs and packages

- `README.md`
- docs pages under `packages/website/src/pages/docs/`
- `packages/core/`
- `packages/page-controller/`
- `packages/llms/`
- `packages/page-agent/`
- `packages/extension/docs/extension_api.md`
- `packages/mcp/README.md`

### Cortex IDE surfaces checked for fit

- `src/app/dashboard/page.tsx`
- `src/components/desktop/NavRail.tsx`
- `src/components/desktop/SettingsPage.tsx`
- `src/components/shared/UniversalSearch.tsx`
- `src/lib/slash-commands.ts`
- `src/lib/tiles/`
- `src/lib/tauri/bridge.ts`
- `src-tauri/tauri.conf.json`
- `src-tauri/src/lib.rs`

## How Page Agent works

### 1. Page understanding model

Page Agent is **DOM-first**, not vision-first.

It does **not** use:

- screenshots
- multimodal models
- accessibility tree extraction as the core representation
- coordinates as its primary control primitive

It does use:

- a live DOM walk adapted from `browser-use`
- heuristics over tag name, role, cursor, attributes, event listeners, contenteditable state, scrollability, and top-element checks
- a flattened DOM tree that is converted into a text format for the LLM

The main representation is a simplified text tree like:

```text
[12]<button aria-label=Save>Save />
[13]<input placeholder=Search />
```

Important properties of that representation:

- interactive elements get numeric indexes like `[12]`
- newly appeared interactive elements are marked with `*[12]`
- indentation preserves parent/child structure
- the prompt includes page size, scroll position, and scroll hints

So the agent understands the page through a **compressed DOM transcript**, not through pixels.

### 2. Navigation and action generation

The LLM does not return selectors or coordinates.

Instead, it returns one forced macro tool call containing:

- `evaluation_previous_goal`
- `memory`
- `next_goal`
- `action`

Built-in actions are:

- `done`
- `wait`
- `ask_user`
- `click_element_by_index`
- `input_text`
- `select_dropdown_option`
- `scroll`
- `scroll_horizontally`
- optional `execute_javascript`

Element actions target the numeric DOM index. The `PageController` resolves that index back to a real element reference and dispatches DOM events for click, input, select, and scroll.

So the control loop is:

1. extract browser state
2. compress DOM to text
3. send prompt + tool schema to LLM
4. receive one action
5. execute it against the indexed DOM
6. repeat

### 3. LLM model and context construction

Page Agent is model-agnostic as long as the endpoint is **OpenAI-compatible** and supports tool calls.

The default client:

- calls `${baseURL}/chat/completions`
- sends one forced tool choice
- disables parallel tool calls

Context is constructed from:

- the system prompt
- optional system instructions
- optional per-page instructions
- optional `/llms.txt` from the current origin
- the user request
- current step info and current time
- persistent agent history from previous steps
- the current browser state

The browser state contains:

- current URL and title
- page/viewport geometry
- simplified interactive DOM content
- scroll-above/scroll-below hints

This is a clean design, but it also means token cost rises with page complexity and step count.

### 4. Single-page vs multi-page

The core library is designed for the **current page / SPA context**.

Multi-page support exists only through the optional Chrome extension and MCP bridge. That extension exposes `window.PAGE_AGENT_EXT` and controls tabs from the browser environment.

That matters for Cortex:

- the core library could run inside the Tauri app page
- the browser extension architecture does **not** transfer into Tauri

### 5. Setup reality: demo vs production

The demo story is genuinely easy:

- one script tag
- built-in panel
- free test API for technical evaluation

The real app story is not one-line.

For production use you need:

- an LLM endpoint or proxy
- authentication handling
- a model with reliable tool calling
- safety rules
- data masking
- likely a custom UI instead of the built-in floating panel
- per-page instructions and ignore/allow rules for risky elements

For Cortex, `PageAgentCore` is the realistic integration point, not the out-of-the-box `PageAgent` panel.

### 6. In-browser performance profile

I did not find an upstream benchmark suite. The performance read here is based on implementation.

Observed cost drivers:

- every step calls `getBrowserState()`
- `getBrowserState()` calls `updateTree()`
- `updateTree()` re-walks the DOM and rebuilds the simplified text view
- the DOM walker does cached but still non-trivial `getBoundingClientRect`, `getClientRects`, `getComputedStyle`, and `elementFromPoint` work
- highlight overlays and listeners are added around interactive elements
- the docs say a typical page can require roughly `15k` prompt tokens, increasing with steps

Important source-level note:

- the docs present `viewportExpansion` as if viewport-only is the default
- the actual source resolves the default to `-1`, which means **full-page extraction**

That makes the default runtime more token-heavy and DOM-heavy than the docs imply.

For a dense control-plane UI like Cortex, this is a real concern.

## Fit for Cortex IDE

### 1. Does it work in a Tauri webview?

**Yes, technically.**

Why:

- Cortex is a React app rendered in a normal DOM environment
- Tauri uses a webview, so `window`, `document`, DOM events, `elementFromPoint`, and `fetch` all exist
- Page Agent is plain in-page JavaScript with no headless browser requirement

But there are important caveats.

### Caveat 1: the extension path does not carry over

The Chrome extension, multi-tab APIs, and MCP flow are browser-extension-specific.

Inside Tauri you only get the **in-page** part:

- no extension side panel
- no `window.PAGE_AGENT_EXT`
- no browser tab control
- no multi-tab extension auth token flow

### Caveat 2: packaged Tauri CSP blocks remote LLM endpoints today

Cortex’s packaged Tauri CSP currently allows `connect-src` only to:

- `'self'`
- `http://localhost:*`
- `http://127.0.0.1:*`
- local websocket targets
- `wss://speech.platform.bing.com`

That means Page Agent cannot directly call OpenAI-compatible remote LLM endpoints from the packaged webview without one of these changes:

- route through a same-origin Cortex API proxy
- or loosen the Tauri CSP

This is the biggest real integration constraint.

### Caveat 3: the built-in Page Agent panel is the wrong product surface

The floating injected panel is good for demos, but it is not the right interaction model for Cortex’s desktop shell.

If Cortex uses Page Agent at all, it should use:

- `PageAgentCore`
- custom Cortex UI
- explicit safety rules

### 2. Could it power a `"Help me find..."` feature?

**Yes, in a narrow way.**

This is the best Cortex fit I found.

Good target surfaces:

- settings navigation
- connectors and API key setup
- memory configuration
- guided onboarding in complex forms

Bad target surfaces:

- terminal control
- xterm-backed panes
- drag/resize tile manipulation
- hidden keyboard shortcuts
- anything requiring semantic knowledge of sessions, repos, worktrees, or runtime state rather than visible DOM

So a Page Agent-style assistant could reasonably answer:

- `"Help me find memory settings"`
- `"Show me where agent model settings live"`
- `"Open the API keys tab"`

But it is a weak fit for:

- `"stop the stuck Codex session"`
- `"open issue 251"`
- `"show the preview for port 3000"`
- `"switch to Hawk’s worktree"`

Those are app-semantic actions, not DOM-discovery problems.

### 3. Could it replace or augment slash commands for UI navigation?

**Augment, yes. Replace, no.**

Current Cortex slash commands are very small and terminal-oriented:

- `/help`
- `/compact`
- `/clear`
- `/cost`
- `/status`
- `/review`

That is not a UI navigation system. It is a lightweight command relay into runtime/chat surfaces.

Page Agent could augment the product by adding natural-language UI navigation such as:

- `"take me to analytics"`
- `"show memory"`
- `"open appearance settings"`

But it should not replace:

- shell/runtime slash commands
- explicit app actions
- typed navigation for core operator workflows

### 4. Does it fit Cortex as the main in-app copilot architecture?

**No.**

This is the real recommendation.

Reasons:

### 1. Cortex owns its own UI and already has structured state

Cortex is not automating an unknown third-party admin panel.

It already has typed navigation and surface structure:

- nav sections: `agents`, `terminal`, `memory`, `analytics`, `settings`
- settings tabs: `connectors`, `api-keys`, `agents`, `memory`, `appearance`, `about`
- tile kinds: `workspace`, `terminal`, `preview`, `canvas`, `thoughts`, `bottom-terminal`
- a reusable `UniversalSearch`
- explicit canvas/tab/session/file open handlers in the dashboard

That means Cortex can build a much stronger action layer than DOM heuristics.

### 2. Page Agent is optimized for semantic admin UIs, not control-plane workbenches

Page Agent is strongest when the UI is:

- form-heavy
- button-heavy
- semantic
- mostly visible on one page

Cortex’s desktop shell includes:

- agent panels
- terminal surfaces
- canvas tabs
- previews
- floating/docked command surfaces
- search overlays
- custom workbench layout state

That is a much worse fit for DOM scraping than a typed command/action bus.

### 3. The token and latency cost are wrong for first-party navigation

For Cortex, most navigation intents should not require:

- a full DOM walk
- a multi-kilobyte prompt
- an LLM round-trip
- heuristic click execution

If the user asks for `"open memory settings"`, Cortex should issue a typed action, not run a browser agent.

### 4. Safety is harder than it needs to be

DOM agents can click the wrong thing unless heavily fenced.

In Cortex that would mean guarding:

- kill buttons
- agent control actions
- destructive repo/worktree actions
- auth/logout flows
- config writes

Because Cortex owns the components, it is safer to expose these as explicit actions with confirmation policies than to let a DOM agent infer them.

## Integration sketch if Cortex still wants it

If Cortex wants a narrow Page Agent integration, this is the shape I would use.

### Phase 1: narrow locator mode

Scope:

- settings page
- onboarding/setup surfaces
- read-only `"show me where"` interactions first

Implementation:

1. Use `PageAgentCore`, not `PageAgent`
2. Add a same-origin Cortex LLM proxy endpoint
3. Mount a custom Cortex UI wrapper
4. Disable `execute_javascript`
5. Add strict `interactiveBlacklist` rules for destructive controls
6. Add Cortex-specific instructions:
   - prefer navigation over mutation
   - ask before risky actions
   - never stop agents or mutate repos without confirmation
7. Consider highlight-only or suggest-only behavior before actual clicks

Estimated effort:

- **2-4 days** for a spike

### Phase 2: production hardening

Needed work:

- secret redaction via `transformPageContent`
- telemetry on action success/failure
- per-surface allowlists
- perf tuning and token budgeting
- Tauri CSP/proxy hardening
- manual QA across macOS and Windows webviews

Estimated effort:

- **1-2 weeks** for a safe narrow rollout

### Phase 3: broad mutation support across the dashboard

I do **not** recommend this as the main plan.

If attempted, expected work includes:

- deep safety policy design
- UI compatibility fixes across terminal/canvas/preview surfaces
- ongoing prompt tuning per feature area
- fallback logic for surfaces that are not semantically DOM-friendly

Estimated effort:

- **2-4 weeks**, with ongoing maintenance risk after that

## Better alternative for Cortex

Build a **component-aware action registry** and optionally add a DOM fallback later.

### Proposed Cortex-native design

### 1. Define typed app actions

Examples:

- `open_nav_section(section)`
- `open_settings_tab(tab)`
- `focus_universal_search(query?)`
- `open_canvas_tab(kind, resourceId, meta?)`
- `ensure_tile(kind)`
- `select_session(sessionKey)`
- `open_issue(number)`
- `open_memory_view()`

### 2. Generate LLM context from app state, not DOM

Provide the model a compact structured snapshot such as:

- current nav section
- available nav sections
- current settings tab
- open tiles
- active canvas tabs
- active session
- known previews/ports
- searchable entities

This gives the model semantic leverage without browser-agent overhead.

### 3. Route common intents without an LLM when possible

Many requests are deterministic:

- `"open settings"`
- `"show analytics"`
- `"go to memory"`
- `"open API keys"`

These should be handled by direct fuzzy matching.

### 4. Use `UniversalSearch` for entity lookup

Cortex already has a reusable search surface for:

- conversations
- agents
- memory
- issues
- files

That is a much better core primitive than DOM browsing for `"find X"` workflows.

### 5. Add DOM fallback only where structured actions run out

If Cortex later wants:

- `"show me the exact button"`
- `"walk me through this form"`
- `"highlight the relevant control"`

then a narrowed Page Agent-style fallback can be layered on top.

## Recommendation

**Recommendation: adapt, do not adopt.**

More specifically:

- **Adopt:** no
- **Adapt:** yes, selectively
- **Build our own:** yes, for the primary in-app copilot/navigation system

### What to borrow

- DOM-to-text dehydration as a fallback pattern
- indexed action model for locator mode
- separation of agent core from UI
- masking and allowlist/blocklist hooks

### What not to borrow as-is

- DOM scraping as the default navigation substrate
- the built-in floating panel
- extension/MCP architecture for Cortex desktop
- broad heuristic clicking for first-party control-plane actions

### Final call

For Cortex IDE, the right move is:

1. build a typed component-aware action layer
2. use natural language to select those actions
3. optionally spike a Page AgentCore-based `"Help me find..."` fallback on settings/onboarding surfaces

That gives Cortex the useful part of Page Agent without inheriting the wrong abstraction boundary.
