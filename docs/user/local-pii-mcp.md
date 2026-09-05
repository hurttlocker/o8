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

The model package comes from an index run by its authors, not PyPI. Pin the version you tested and review that index before installing. The server is meant to run inference on-device; confirm it makes no network calls in your environment before trusting it with real transcripts.

## Register in Settings

1. **Settings → MCP → add a server**
2. Fields:
   - **Name:** `paw-pii` (pattern `^[A-Za-z0-9_-]+$`)
   - **Transport:** stdio
   - **Command:** absolute path to your venv/`python3`
   - **Args:** `-m` `paw_pii.mcp_server`
   - **Env (optional):** `PAW_PII_PLACEHOLDER=[PII]`, `PAW_PII_PROGRAM_ID=…`
3. Enable the server.
4. Toggle **Attach to supported workers** so codex/claude-code packet workers receive the same stdio MCP (`workerInjection`).
5. Toggle **Attach to Symon** separately if voice conversations should see these tools; every Symon call still shows the normal confirmation card.

Enabled externals are assembled into the tool-spine for Claude/Codex orchestrator surfaces automatically (`src/lib/mcp/tool-spine/build.ts`).

## Register via API

o8 picks its API port at launch and writes it to `~/.o8/api-port`. Calls from loopback need no bearer token. A non-loopback client must send `Authorization: Bearer $(cat ~/.o8/ws-token)`.

```bash
O8_PORT=$(cat ~/.o8/api-port)
curl -sS -X POST "http://127.0.0.1:${O8_PORT}/api/setup/mcp-servers" \
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
- Follow-ups (builtin promotion, automatic pre-LLM scrub): [#2074](https://github.com/hurttlocker/o8/issues/2074)
