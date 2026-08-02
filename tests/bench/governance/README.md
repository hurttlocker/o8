# Governance benchmark fixtures

Each neutral `case-*` directory contains a committed base tree and a unified `change.patch`. The manifest carries scoring ground truth, but the reviewer receives only that fixture's task, acceptance criteria, and patch.

To inspect or re-apply a fixture:

```sh
cp -R tests/bench/governance/case-01/base /tmp/o8-governance-case-01
git -C /tmp/o8-governance-case-01 apply "$PWD/tests/bench/governance/case-01/change.patch"
```

`npm run bench:governance` applies all 20 patches to temporary copies, requires TypeScript and ESLint to pass, shuffles the inputs, assigns fresh neutral labels, and then invokes the AI review tier. The set contains 10 planted defects and 10 clean controls. Each review runs with plan/proposer permissions from its own empty temporary Git repository. The prompt states that the supplied patch is self-contained and that tools will abort the review. Any tool-use or tool-result event still fails closed as inconclusive. Backends whose tool activity cannot be observed also return inconclusive without reviewing an input. Ground truth is opened only after all reviews return. A reviewer miss remains a miss; fixtures are never adjusted after seeing a result.

A planted defect counts as caught only when the reviewer requests changes and a finding matches the committed defect signals. Clean controls have two separate measures: `clean diffs BLOCKED` counts `request_changes` verdicts, while `clean diffs with any finding` also counts non-blocking findings attached to an approve verdict. Inconclusive reviews are reported by classification and are never counted as a catch, clean block, or clean finding. Every rate keeps the full committed fixture denominator, so the separate inconclusive count remains necessary when interpreting it.

This track measures the AI review tier. It does not measure the human approval gate above it.

The fixture manifest names each failure or control shape so the sample composition is auditable without exposing ground truth to the reviewer.
