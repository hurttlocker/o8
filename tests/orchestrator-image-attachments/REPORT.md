# Orchestrator Image Attachment Blocker

The current `orchestrator-send` path cannot accept Anthropic Messages API image or document content blocks.

## Current Invocation

- The desktop composer sends `orchestrator-send` over the WebSocket bridge in `src/components/desktop/thoughts/useOrchestratorStream.ts`.
- `src/ws-server.ts` handles that message and calls `sendToOrchestrator(...)`.
- `sendToOrchestrator` is implemented in `src/lib/lane/orchestrator-session.ts` and spawns Claude Code as a CLI process:
  - `claude -p <message> --output-format stream-json ...`
- The message boundary is a single text prompt argument. There is no Anthropic SDK or Messages API request body in this path where the packet can add:
  - `{ type: "image", source: { type: "base64", media_type, data } }`
  - `{ type: "document", source: { type: "base64", media_type: "application/pdf", data } }`

The existing Assistant tab image support works because `src/app/api/v2/proxy/llm/provider-config.ts` builds Anthropic Messages API content blocks from inline data-URI markdown. The orchestrator path does not use that proxy; it uses the Claude Code CLI runtime directly.

## Why This Cannot Be Safely Plumbed Here

Passing base64 data URIs through the text prompt would not mirror the Anthropic content-block format requested by the packet and would likely degrade into plain text rather than model-visible media. Uploading attachments to temporary files and mentioning paths would also be a different contract unless Claude Code explicitly guarantees image/PDF ingestion from those paths in non-interactive `--print` mode.

## Proposed Paths Forward

1. Add an image-bearing orchestrator backend that can send structured content, either through the official Claude Code SDK if it supports image/PDF user content with streaming events and MCP config, or through `@anthropic-ai/sdk` direct Messages API calls with equivalent tool/MCP orchestration.
2. If Claude Code documents support for non-interactive file attachments, persist uploads to a scoped temp directory and pass the attachment paths through the supported CLI attachment mechanism instead of embedding data URIs in prompt text.
