# API prompt cache lifecycle

The bundled Pi worker and Pi orchestrator share the host OpenRouter transport.
For documented cache routes it requests an extended lifetime for the stable
system instructions and tool definitions:

| OpenRouter model | Requested lifetime | Cache write reservation |
| --- | --- | --- |
| OpenAI GPT-5.6 and newer | 12 hours, explicit prefix | 2.5 times input rate |
| Anthropic Claude | 1 hour, explicit prefix | 2 times input rate |
| Other models | Existing SDK behavior | Existing input rate |

The model id, rendered system messages and tool schemas determine the hashed
routing key. Task text, credentials and reasoning effort do not enter that key.
A changed model, instruction or tool schema changes the key. OpenAI documents
that GPT-6 effort changes preserve caches; older models can change their
rendered context with effort changes even when the routing key stays constant.
This transport currently declares reasoning effort unsupported, so it sends no
effort setting. Anthropic thinking changes can alter cache reuse; no guarantee
of cross-effort hits is made.

Before a worker starts its first predictable model call, the host sends its
rendered system prompt and tools with a one-token output cap and tool selection
disabled. During a tool call, a timer can refresh the same prefix one minute
before its requested lifetime expires. Refreshes stop when the tool finishes or
the run stops. Each run allows one prewarm and at most two refreshes. Each
background request has a ten-second timeout, no retries, and resolves the
current host credential. Failure does not directly fail the real turn, but an admitted request with unknown cost retains its ceiling reservation. The real model request waits for an in-flight prewarm; the initial turn can therefore include up to ten seconds of preparation latency. Request TTFT receipts exclude that wait and must not be presented as end-to-end latency savings.

All requests share the existing run spend ceiling. The reservation covers a
cache write even when a hit is expected. Missing provider cost retains the
reservation. Usage receipts include `purpose` (`turn`, `prewarm`, `keepalive`),
cache reads and writes, cached-token ratio, time to first streamed token, and
the provider-reported cost. Background output never enters model history.

Set `O8_PROMPT_CACHE_WARMING=off` in the app host environment before launch to
opt out of host prewarming, refreshes and extended-retention controls. This
also takes effect before each new background request in an existing host.
The user Pi CLI has its separate existing `cacheWarming` setting. Subscription
CLIs and the managed transport do not use this host policy.

## Verification boundary

`tests/pi-prompt-cache-real-path.test.ts` runs the actual bundled worker,
SDK request serializer, host transport and tools, and reads the persisted
session and usage rows. Provider streams are synthetic recorded protocol
fixtures. Fixture timings and cache ratios verify telemetry propagation and
request reachability; they do not measure live provider latency, cache hit
rates or savings. Actual cache admission, eviction, routing and token minima
remain provider decisions. No provider account or external inference request
is used by these tests.

## Provider references

- [OpenRouter prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching)
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
