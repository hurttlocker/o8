# o8 Dogfood Audit

You are auditing o8, a desktop app at `http://localhost:3001`. The dev server is already running.

## What to do

Go through each area below. For each one, spawn a subagent (using the Agent tool) to handle it in parallel. Wait for all agents to finish, then synthesize findings.

## Area 1: Orchestrator Chat
Spawn an agent to test the orchestrator via Playwright MCP:
- Navigate to localhost:3001, click Orchestrator tab
- Send "What repos do you have access to?" — verify it responds with both repos
- Click History pill — verify past conversations load
- Click Issues rocket icon — verify aggregated issues panel opens
- Take screenshots of each step

## Area 2: Repo Alignment
Spawn an agent to test repo switching via Playwright MCP:
- Click "cortex-ide" repo name in sidebar — verify Changes panel updates
- Click "ugc" repo name — verify it switches
- Verify both repos can be expanded simultaneously
- Take screenshots

## Area 3: Agent Sessions
Spawn an agent to test launching a CLI session via Playwright MCP:
- Click Launch (play) button → CLI Session → Claude Code
- Verify new tab appears as "cortex-ide (Claude)"
- Send it a simple task like "echo hello"
- Close the tab, verify cleanup
- Take screenshots

## Area 4: Visual Polish
Spawn an agent to take dev-browser screenshots and check:
- Plus Jakarta Sans rendering everywhere
- User bubbles are subtle tinted pills (not gradient)
- Desaturated diff colors in Changes panel
- All SVG icons visible (no zero-width bugs)
- Orchestrator tab has accent tint

## Area 5: Code Health
Spawn an agent to run:
- `npx tsc --noEmit` (should be zero errors)
- `grep -r "from 'lucide-react'" src/components/desktop/` (find remaining lucide imports)
- `grep -rn "'#ffffff'" src/components/desktop/` (find hardcoded white backgrounds)
- Check repos.json exists: `cat ~/.cortex-ide/repos.json`

## After all agents finish

Collect all findings and create a single summary:
- P0: Broken features
- P1: Degraded but functional  
- P2: Cosmetic issues
- Passed: What works correctly

Print the full summary.
