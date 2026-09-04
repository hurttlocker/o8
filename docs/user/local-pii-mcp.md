# Local PII MCP (on-device redaction)

o8 can attach a **local** PII detect/redact MCP so orchestrators and supported workers call `detect_pii` / `redact_pii` without sending text to a cloud NER service.

This uses the existing **external MCP** + optional **worker injection** path (tool-spine). It does **not** replace broadcast/token redaction in `src/lib/broadcast/redaction.ts`.

Upstream model and adapters: [programasweights/pii](https://github.com/programasweights/pii) · harness package [kvnloo/pii](https://github.com/kvnloo/pii).

## Install the Python side

```bash
git clone https://github.com/kvnloo/pii
cd pii
pip install -e .
pip install programasweights --extra-index-url https://pypi.programasweights.com/simple/
python -m paw_pii.mcp_server   # stdio MCP: detect_pii, redact_pii
```

## Register in Settings

1. **Settings → MCP → Add external server**
2. Fields:
   - **Name:** `paw-pii` (pattern `^[A-Za-z0-9_-]+$`)
   - **Transport:** stdio
   - **Command:** absolute path to your venv/`python3`
   - **Args:** `-m` `paw_pii.mcp_server`
   - **Env (optional):** `PAW_PII_PLACEHOLDER=[PII]`, `PAW_PII_PROGRAM_ID=…`
3. Enable the server.
4. Toggle **Attach to supported workers** so codex/claude-code packet workers receive the same stdio MCP (`workerInjection`).

Enabled externals are assembled into the tool-spine for Claude/Codex orchestrator surfaces automatically (`src/lib/mcp/tool-spine/build.ts`).

## Register via API

```bash
curl -sS -X POST "http://127.0.0.1:3000/api/setup/mcp-servers" \
  -H "Authorization: Bearer $O8_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "paw-pii",
    "transport": "stdio",
    "command": "/usr/bin/python3",
    "args": ["-m", "paw_pii.mcp_server"],
    "env": {"PAW_PII_PLACEHOLDER": "[PII]"},
    "enabled": true,
    "workerInjection": true
  }'
```

## What this covers

| Goal | Supported |
|------|-----------|
| Orchestrator can call redact tools | Yes — external MCP on tool-spine |
| Workers (codex / claude-code) can call redact tools | Yes — `workerInjection` |
| Always scrub every LLM egress without a tool call | No — needs a new middleware seam (open an issue first) |
| Credential / path scrub on Broadcast | Existing `broadcast/redaction.ts` (not NER) |

## Related code

- `src/lib/mcp/external-servers.ts` — persistence/CRUD
- `src/lib/mcp/worker-injection.ts` — attach to supported runtimes
- `src/lib/mcp/tool-spine/build.ts` — catalog assembly
- `docs/user/operator-mcp-bridge.md` — operator MCP
- `docs/internals/runtime-adapter-contract.md` — worker MCP injection
- Issue tracking first-class follow-ups: see the linked GitHub issue on this PR
