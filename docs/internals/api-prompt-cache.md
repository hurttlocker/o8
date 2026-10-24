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

Immediately after the worker initializes a session, the host starts one
background prewarm using its rendered system prompt and tools, with a one-token
output cap and tool selection disabled. Session creation does not wait for it.
The first real model call waits only if this session prewarm is still in flight.
If it has finished during idle time, the real call starts directly. Later prompts
never send or wait for a new prewarm, including after a successful model call
within the requested cache lifetime. There is no tool-time keepalive or refresh
timer. Real model calls populate and reuse the same stable prefix normally.

The prewarm has a ten-second timeout, no retries, and resolves the current host
credential. Stop, session close and worker exit cancel it. Failure does not
directly fail the real turn, but an admitted request with unknown cost retains
its ceiling reservation. An immediate first prompt can still wait up to ten
seconds for the initial prewarm. Request TTFT receipts exclude that wait and
must not be presented as end-to-end latency savings.

The session prewarm counts against the first run's existing spend ceiling;
starting that run preserves its reservation and receipts. The reservation covers
a cache write even when a hit is expected. Missing provider cost retains the
reservation. New usage receipts include `purpose` (`turn`, `prewarm`),
cache reads and writes, cached-token ratio, time to first streamed token, and
the provider-reported cost. Background output never enters model history.

Set `O8_PROMPT_CACHE_WARMING=off` in the app host environment before launch to
opt out of host prewarming and extended-retention controls. This also takes
effect before a new session prewarm is sent in an existing host.
The user Pi CLI has its separate existing `cacheWarming` setting. Subscription
CLIs and the managed transport do not use this host policy.

## Verification boundary

`tests/pi-prompt-cache-real-path.test.ts` runs the actual bundled worker,
SDK request serializer, host transport and tools, and reads the persisted
session and usage rows. Provider streams are synthetic recorded protocol
fixtures. Two prompts on one session verify that exactly one prewarm is sent
before the first prompt, a completed prewarm adds no per-run preparation wait,
and opt-out sends no prewarm. Fixture timings and cache ratios verify telemetry
propagation and request reachability; they do not measure live provider latency, cache hit
rates or savings. Actual cache admission, eviction, routing and token minima
remain provider decisions. No provider account or external inference request
is used by these tests.

## Provider references

- [OpenRouter prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching)
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
