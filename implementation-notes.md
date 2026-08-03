# Implementation notes

## Plan

- Bundle the WebSocket server's Sentry SDK instead of leaving it as a runtime external.
- Fail the packaged export if the generated WS bundle still contains a runtime Sentry import.
- Warn clearly when a non-dormant Sentry initialization fails, and cover that path with a focused test.

## Deviations
No deviations.
