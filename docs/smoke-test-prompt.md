# o8 — Reusable Smoke Test Prompt

Copy everything below the line and paste it into a fresh Claude Code conversation.

---

Run an end-to-end smoke test of the o8 dashboard at
http://localhost:47120/dashboard using the o8 browser tools.

## Setup
- Verify the dev server is running on port 47120 and WS server on 47125
- If not running, start with `npm run desktop:dev`

## Test Plan

### 1. Dashboard Load & Connectivity
- Navigate to http://localhost:47120/dashboard
- Wait for "Live — WebSocket connected" status in the title bar
- Verify the session timeline loads with today's activity
- Verify the left panel shows the cortex-ide repo with branch info
- Screenshot the initial state

### 2. Repo Activity Panel
- Open the Repo Activity section (click the activity button in the left panel)
- Click the "Issues" tab filter
- Record all visible issue numbers and their states (open/closed)
- Note any issues that appear to be missing or incorrectly showing as open/closed
- Click the "PRs" tab — record open PR count
- Click the "CI" tab — record pass/fail status of recent checks
- Screenshot the repo activity state

### 3. Workspace & Lane Status
- Check the Workspaces header for live lane count
- Expand the branch tree — record how many branches show "Ready", "Waiting", "Needs attention"
- Check workspace tabs at the bottom — record tab count and their statuses (Launching, Running, Waiting)
- Verify no tabs show stale or orphaned sessions
- Screenshot the workspace state

### 4. Orchestrator Launch via ThoughtsCard
- Open the Thoughts panel (click the brain icon in the nav rail)
- Type a test message into the orchestrator chat: "What open issues need attention? List the top 3 by priority."
- Send the message and wait for the orchestrator to process
- Verify the orchestrator response appears (not blank or error)
- Screenshot the orchestrator's response

### 5. Message Integrity Check
- In the ThoughtsCard chat, verify each message appears ONLY ONCE (not duplicated)
- Check that tool call entries (e.g., "[tool: ToolSearch]") are not doubled
- Take a snapshot and count unique vs duplicate message IDs
- Record PASS or FAIL for dedup

### 6. Agent Liveness Check (if an agent is running)
- If any agent shows "Working" or "Running" status in the left panel or workspace tabs:
  - Wait at least 30 seconds
  - Verify the agent does NOT falsely report "completed" or "Waiting" prematurely
  - Check the transcript panel (right side) for active progress
- If no agent is running, record as SKIPPED

### 7. Console Health Check
- Read all console messages and check for:
  - React errors (especially "Encountered two children with the same key")
  - WebSocket connection failures or rapid reconnect loops
  - HMR / Fast Refresh frequency — should be sparse after initial load, NOT continuous 100ms intervals
  - Any unhandled promise rejections or thrown errors
- Save console errors to a file for the report

### 8. Final State Screenshot
- Take a full-page screenshot showing the complete dashboard state

## Report Format

After completing all tests, provide a structured report:

```
# o8 Smoke Test Report — [DATE]

## Results Summary
| Test | Result | Notes |
|------|--------|-------|
| 1. Dashboard Load | PASS/FAIL | ... |
| 2. Repo Activity | PASS/FAIL | ... |
| 3. Workspace Status | PASS/FAIL | ... |
| 4. Orchestrator Launch | PASS/FAIL | ... |
| 5. Message Integrity | PASS/FAIL | ... |
| 6. Agent Liveness | PASS/FAIL/SKIPPED | ... |
| 7. Console Health | PASS/FAIL | ... |
| 8. Final Screenshot | Captured | ... |

## Bugs Found
- [severity] Description — root cause hypothesis

## Regressions
- Any previously-fixed bugs that have returned

## Screenshots
- List of captured screenshots with descriptions
```

After the report, ask: "Should I create a GitHub issue for any of the bugs found?"
