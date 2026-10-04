# Managed Pi test budget guard

This is a source-only, opt-in test safeguard over the SDK prototype in #3233.
It is not an account quota service and does not authorize a live request.
The generic `createPiSdkSession` default transport remains unbudgeted; a live
test must explicitly use `createBudgetedPiTestTransport` and its one approved
persistent ledger in trusted host storage outside the tool workspace. The guarded
transport rejects a canonical ledger path inside that workspace. No UI or public route selects this test entry today.

## Live contract

`resolveLivePiTestContract()` returns one verified contract,
`O8_MANAGED_FLASH_LITE_CONTRACT` in `src/lib/pi/sdk/live-contract.ts`, until it
expires on 2026-10-25. It covers `google/gemini-2.5-flash-lite` at
`https://api.o8.run/v1/inference` only. The evidence, checked 2026-10-04:

- The hosted endpoint caps this model at 0.18 USD per million prompt tokens
  and 0.72 USD per million completion tokens, with at most 4096 output tokens
  per call.
- OpenRouter's published endpoint prices for the model topped out at exactly
  those rates, with no per-request fee.
- Billable input tokens cannot exceed the serialized request bytes; the bound
  adds 16 KiB for provider-added prompt tokens.

The contract caps each request at 64 KiB of serialized input and 4096 output
tokens, so the worst case is 17,696 micro-USD per request and at most 8 calls.
After expiry, validation refuses the contract and live testing is blocked
again until the evidence is rechecked.

`O8_MANAGED_FLASH_LITE_MODEL` describes the model to Pi so it sends only fields
the endpoint accepts: `max_tokens` instead of `max_completion_tokens`, no
`store`, and the system role. `tests/pi-sdk-live-contract.test.ts` checks the
serialized request offline.

The resolver injection is for trusted host code and offline tests, never a
request field, worker tool, environment JSON value, or checkbox that a caller
can label “verified.”

## What the guard enforces

`initializePiTestBudget` creates one owned ledger explicitly and exclusively.
It will not reopen and reset an existing budget. The approved limit is integer
micro-USD, at most 1,000,000 ($1). Keep this same ledger for the entire approved
test, including new sessions and process restarts. Creating another ledger is
another budget, requiring its own authorization; a model cannot select it.

`createBudgetedPiTestTransport` wraps the actual host fetch boundary. It checks
an exact model and endpoint, contract expiry, the complete serialized request
(including system text, tools and history), output limits, and absence of a
model fallback list or multiple completions. The SDK transport's client retries
and redirect following remain disabled.

Before any HTTP request, a SQLite immediate transaction reserves the contract's
worst-case all-in charge. Integer arithmetic rounds up fractional micro-dollars.
The input reserve covers the contract's full billable-input bound, not a chars/4
estimate. The output reserve includes the entire billable-output bound and a
fixed per-request charge allowance. This is deliberately conservative.

A ledger allows only one outstanding request. Concurrent processes cannot use
the same reservation or exceed its aggregate limit. Completed requests retain
their entire reservation; low token usage never refunds money. Failed, aborted,
incomplete or unverifiable-usage calls remain unknown and block subsequent
requests. A process crash leaves a pending reservation, also blocking the next
process. There is no automatic reset or reconciliation shortcut.

The ledger stores only a contract fingerprint, integer limits and reservation
states. It stores no prompt, token, credential, header, model output or raw
provider error. The transport keeps existing error sanitization. These are
host-side controls, not protection from a malicious process that can rewrite
its own application files or create another budget ledger.

## Contract required from the hosted owner

Before enabling a live test, verify all of the following for one exact model:

- The permitted hosted endpoint, model identifier, context bound and expiry;
  these bounds must cover the full lifetime of every request admitted before expiry
- Input and output rates, fixed fees and billing rounding, including any markup
- A billable-input upper bound for every accepted serialized request within the
  byte limit, including tool schemas, system messages and internal overhead
- The output-token limit covers reasoning and all other billed output
- Failed or interrupted calls and any upstream retries cannot exceed the stated
  per-request maximum
- Stream usage fields are complete and meaningful for checking the stated bounds

If any item is unknown or the evidence changes, the resolver must return no contract. A cached client price
estimate or a fail-open daily ledger is not sufficient evidence. A completed
stream is still charged its full reservation locally; no invoice equivalence is
claimed. Secure sign-in and a tested build containing the guard are separate
prerequisites.

## Offline verification

`tests/pi-sdk-budget-real-path.test.ts` drives the full transport through a real
SDK worker and mocked HTTP responses, plus two simultaneous processes against a
real SQLite ledger. All rates and billing contracts are explicitly synthetic.
No live model, auth flow, provider request, or payment is part of the suite.

```sh
npx vitest run tests/pi-sdk-budget-real-path.test.ts --maxWorkers=1
npm run test:integration -- tests/pi-sdk-budget-real-path.test.ts
```
