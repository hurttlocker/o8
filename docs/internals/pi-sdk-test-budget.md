# Managed Pi test budget guard

This is a source-only, opt-in test safeguard over the SDK prototype in #3233.
It is not an account quota service and does not authorize a live request.
The generic `createPiSdkSession` default transport remains unbudgeted; a live
test must explicitly use `createBudgetedPiTestTransport` and its one approved
persistent ledger in trusted host storage outside the tool workspace. The guarded
transport rejects a canonical ledger path inside that workspace. No UI or public route selects this test entry today.

## Live testing remains blocked

`resolveLivePiTestContract()` deliberately returns no contract. The production
test-transport entry refuses to resolve an entitlement or make a request until
there is authoritative evidence of the hosted model's all-in billing bounds.
The repository does not establish that contract today. No endpoint, price,
reservation API, or server-side guarantee has been invented to fill the gap.

The resolver injection is for trusted host code and offline tests, never a
request field, worker tool, environment JSON value, or checkbox that a caller
can label “verified.” A real integration must replace it with a reviewed source
of authoritative billing evidence before live testing is enabled.

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

If any item is unknown, the resolver must remain empty. A cached client price
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
