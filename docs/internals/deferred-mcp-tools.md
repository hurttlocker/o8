# Deferred MCP tool definitions

Full-profile owned Claude and Codex orchestrators receive a small core plus
`o8_tool_search` and `o8_tool_call` from the built-in operator and Cortex stdio
servers. Search returns complete descriptions and input schemas on demand.
Call takes the discovered name and a JSON object string, then forwards to the
original handler. Original results, errors and images pass through unchanged.
This portable bridge uses ordinary MCP calls; it needs no provider-specific
tool-search extension or changing `tools/list` notifications.

The core is the union of every tool named by the rendered orchestrator prompts
(including Codex's Brain instruction), plus `o8_status` and `o8_send`:

- Operator: `o8_status`, `o8_send`, `o8_lane_events`, `o8_render`,
  `o8_html_preview`, `o8_html_render`, `o8_visualization_read`, `cortex_ask`,
  `create_mission`, `dispatch_mission`, `get_mission_status`, `get_packet_scope`,
  `mission_tail`, `steer_packet`, `submit_review`, `approve_and_merge`,
  `reset_packet`, `retry_packet`.
- Cortex: `cortex_ask`, `cortex_ci_status`, `cortex_correct_workers`,
  `cortex_fleet_status`, `cortex_interrupt_agent`, `cortex_launch_agent`,
  `cortex_list_approvals`, `cortex_list_issues`, `cortex_list_prs`,
  `cortex_read_packets`, `cortex_read_transcript`, `cortex_resolve_approval`,
  `cortex_steer_agent`, `cortex_update_packet`, `cortex_wait_workers`,
  `cortex_worker_catalog`.

These are 33 unique names; `cortex_ask` is advertised by both servers. Every
other built-in tool stays deferred. Dispatch and review can call the named
tools immediately. The prompt instructs the model to reach tools outside its
list with `o8_tool_search`, then `o8_tool_call`.

Search accepts a query, an optional offset and a limit
from 1 to 10. An empty query enumerates all definitions. Follow `nextOffset`
until it is null. Exact names rank before keyword matches. Definitions are
neither truncated nor cached across requests.

## Runtime boundaries

- Only the Claude and Codex orchestrator emitters enable automatic deferral,
  and only for the full tool profile. The neutral registry retains the full
  transport configuration and the complete server catalogs.
- Proposer, Solo and Fable profiles retain full loading, including when the
  parent process requests deferral. This preserves their existing runtime
  guards and named-tool deny rules.
- Desktop, OpenClaw, Gemini and OpenCode client configuration retains full
  loading. User-configured external servers are unchanged.
- Registered worker attachments preserve their explicit server configuration.
  A registered built-in stdio proxy can opt in with
  `O8_MCP_TOOL_LOADING=deferred`; the attachment test exercises that route.
  Existing registrations retain full loading. Clients with named-tool policies
  must keep full loading so each verb retains its own permission identity.
- Pi already exposes `o8_commands`, `o8_command_help` and `o8_run`. It continues
  to read the complete catalogs and uses its existing bridge.
- Set `O8_MCP_TOOL_LOADING=full` before generating orchestrator configuration
  to opt out. Direct HTTP and headless compatibility consumers retain full
  loading. No subscription CLI setting or model request format changes.

Both search and wrapped calls consult the current profile-filtered catalog.
Calls still run through the original server checks. Wrapped worker launches
also count as launches for the false-dispatch retry guard.

## Definition payload measurement

Snapshot from real server processes, using compact JSON tool definitions and
the `cl100k_base` tokenizer. These counts exclude native runtime tools, provider
envelopes, user-configured servers, prompt text and later search results. They
measure definition payloads, not billed provider tokens or latency.

| Runtime or built-in surface | Before tools / tokens | After tools / tokens |
| --- | ---: | ---: |
| Full Claude orchestrator | 160 / 33,045 | 38 / 13,366 |
| Full Codex orchestrator | 160 / 33,045 | 38 / 13,366 |
| Worker with an explicitly deferred operator attachment | 128 / 28,511 | 20 / 10,483 |
| Pi command bridge | 3 / 195 | 3 / 195 |
| External clients, operator only | 128 / 28,511 | 128 / 28,511 |

Combined operator/Cortex definition bytes fall from 150,890 to 61,455. Counts
include both servers' discovery bridges and the shared `cortex_ask` definition.
Restricted profiles and existing worker registrations retain their own complete
catalogs.

To capture the actual before/after operator and Cortex payloads:

```sh
O8_TOOL_DEFINITION_RECEIPT=/tmp/o8-tool-definitions.json \
  npx vitest run tests/mcp-deferred-tools-real-path.test.ts
```

Tokenize each compact JSON array with `getEncoding('cl100k_base')` from
`js-tiktoken`. Combine the operator and Cortex arrays before counting combined
totals. Pi's three definitions come from `createO8CommandTools([])`; their
schemas do not depend on the command catalog. Map Pi's `parameters` field to
`inputSchema` for the same definition shape used in the table.

The real-path tests discover and invoke non-core tools through generated
Claude/Codex configurations and a persisted worker attachment. They inspect
persisted project state, enumerate every operator verb, verify profile-hidden
tools remain unavailable, and compare complete HTTP and stdio catalogs.
The prompt-scope tests render every prompt backend, including first-run and
Codex Brain instructions, and require every named tool to be initially loaded.
They also require every other catalog tool to stay deferred.
