# Governance benchmark fixtures

Each neutral `case-*` directory contains a committed base tree and a unified `change.patch`. The manifest carries scoring ground truth, but the reviewer receives only that fixture's task, acceptance criteria, and patch.

To inspect or re-apply a fixture:

```sh
cp -R tests/bench/governance/case-01/base /tmp/o8-governance-case-01
git -C /tmp/o8-governance-case-01 apply "$PWD/tests/bench/governance/case-01/change.patch"
```

`npm run bench:governance` applies every patch to a temporary copy, requires TypeScript and ESLint to pass, shuffles the inputs, assigns fresh neutral labels, and then invokes the AI review tier. Each review runs with plan/proposer permissions from its own empty temporary Git repository. Reviewer tools are forbidden; any tool-use or tool-result event aborts the turn and records it as inconclusive. Backends whose tool activity cannot be observed fail closed as inconclusive without reviewing an input. Ground truth is used only after all reviews return. A reviewer miss remains a miss; fixtures are not adjusted after seeing a result.

A planted defect counts as caught only when the reviewer requests changes and a finding matches the committed defect signals. Any finding on a clean control counts as a false positive, including a non-blocking finding attached to an approve verdict.

This track measures the AI review tier. It does not measure the human approval gate above it.

The corrected blind boundary has not yet completed an end-to-end run, so no result from this fixture set is valid evidence yet.
