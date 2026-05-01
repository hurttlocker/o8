# Test 6 — MCP-as-API external composition (#943)

> **STATUS:** pending — runs last

## Goal

Demonstrate that an external MCP client (Claude Desktop) can drive a complete o8 dispatch lifecycle end-to-end.

## Methodology

1. Open Claude Desktop with the o8 operator MCP server registered (via `Settings → MCP → install`).
2. From Claude Desktop, run the full sequence:
   - `o8_status`
   - `create_mission`
   - `dispatch_mission`
   - `get_mission_status` (poll until done)
   - `submit_review`
   - `approve_and_merge`
3. The packet should be a real (small) issue from the backlog.
4. Capture the conversation transcript and a screenshot of the final merged commit.

## Pass bar

It works at all. Numbers don't matter; the demo does. If it fails, surface the specific MCP tool that broke and stop.

## Cost budget

~$0.10 for the Claude Desktop session.

## Transcript

(filled in)

## Screenshots

(filled in — paths under this folder)

## Surprises

(filled in)

---

## RESULT

(filled in — `PASS | FAIL | INCONCLUSIVE` + which MCP tool failed if any + one paragraph analysis)
