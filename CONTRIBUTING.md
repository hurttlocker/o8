# Contributing

o8 is maintained by one person, and review capacity is limited. Small, focused changes have a realistic path to review; large unsolicited patches usually do not.

## What we accept

- Bug fixes with a clear reproduction.
- Reliability and performance improvements with evidence.
- New runtime adapters that follow the six-file recipe in [`docs/internals/runtime-adapter-contract.md`](./docs/internals/runtime-adapter-contract.md).

## What we do not accept

- Large refactors without prior agreement.
- Features that were not requested or discussed.
- Style-only churn, dependency reshuffling, or rewrites that do not change behavior.

Open an issue before starting any non-trivial change. An issue is not a promise that a pull request will be accepted, but it can prevent both sides from spending time on work that does not fit the project.

## Pull requests

Keep each pull request to one concern. Explain the problem, why the change belongs in o8, and how you verified it. Include before-and-after images for visible UI changes and call out any test or gate you could not run.

Before submitting, run:

```bash
npx tsc --noEmit          # must be clean
npm test                  # judge by the final summary, not by stderr
npx eslint <files you changed>
```

Rust changes also need the relevant Cargo check or test from `src-tauri/`.

Three things about those gates that will otherwise waste your time:

- **The suite prints alarming output on purpose.** Negative-path tests emit things like `LOCKOUT BREACH`, authorization failures, and timeouts to stderr while passing. The Vitest summary and exit code are the verdict.
- **Lint the files you touched, not the repo.** A repo-wide `npm run lint` still reports known baseline warnings; fixing unrelated ones expands your diff and makes review harder.
- **Tests are not yet fully isolated from a running install.** A few suites reach global paths outside `CORTEX_IDE_DATA_DIR`, so quit the desktop app before running the full suite, or expect flakes that are not your fault.

Use one of the established commit prefixes: `feat:`, `fix:`, `chore:`, `docs:`, `perf:`, or `refactor:`. Files have an 800-line ceiling unless an existing waiver applies. New TSX styling uses inline style objects rather than new CSS classes.

Cross-process seams, persistence paths, authorization changes, and tool arguments must be tested through the real production entry point. A helper-only unit test does not prove that callers can reach the behavior. [`CLAUDE.md`](./CLAUDE.md) and [`AGENTS.md`](./AGENTS.md) are the full contributor contracts for architecture, reachability testing, verification, and repository rules.

## AI-assisted contributions

AI-assisted pull requests are welcome. The person submitting the pull request is responsible for understanding the entire diff, reviewing it for scope and security, and running the stated verification. Unreviewed agent output, generated explanations that do not match the code, and pull requests whose author cannot explain the change will be closed.

## Review expectations

Review may take time because o8 has a solo maintainer. Opening a pull request does not create a review deadline or guarantee acceptance. Focused fixes with a reproduction and complete verification will be reviewed before speculative or broad changes.
