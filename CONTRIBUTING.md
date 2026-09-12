# Contributing

o8 is maintained by one person, and review capacity is limited. Small, focused changes have a realistic path to review; large unsolicited patches usually do not.

## What we accept

- Bug fixes with a clear reproduction.
- Reliability and performance improvements with evidence.
- New runtime adapters that follow the six-file recipe in [`docs/internals/runtime-adapter-contract.md`](./docs/internals/runtime-adapter-contract.md).

[`ROADMAP.md`](./ROADMAP.md) is the map of what is open and what each arc has to satisfy to be finished. Work that appears there has already been scoped and accepted.

## What we do not accept

- Large refactors without prior agreement.
- Features that were not requested or discussed.
- Style-only churn, dependency reshuffling, or rewrites that do not change behavior.

Open an issue before starting any non-trivial change. An issue is not a promise that a pull request will be accepted, but it can prevent both sides from spending time on work that does not fit the project.

The way we run issues, pull requests, and merges is written down in [docs/operations/github-operating-standard.md](./docs/operations/github-operating-standard.md).

## Claiming work

Find work through [`ROADMAP.md`](./ROADMAP.md). Each open arc there links to one tracking issue, and that issue's checklist lists its children. Pick an unchecked child labeled `claimable`: those have a brief that is complete enough to start from.

Comment "claiming" on the child issue. A maintainer flips the label to `claimed`, which expires seven days after the claim comment if no pull request links to the issue. That keeps an issue from sitting reserved by someone who moved on, and reclaiming it later is fine.

Branch from `main` in your fork, one branch per issue. Your pull request body needs an "Evidence" section that names the commit you tested and the exact commands you ran, with their results. A reviewer other than the author verifies the change, and a maintainer merges it. Pull requests carrying the `needs-review` label are the ones waiting on that independent review.

## Pull requests

Keep each pull request to one concern. Explain the problem, why the change belongs in o8, and how you verified it. Include before-and-after images for visible UI changes and call out any test or gate you could not run.

Pull requests from forks wait for maintainer approval before CI reports appear. After approval, the review bot writes its report to the workflow run summary instead of posting a pull request comment because fork workflow tokens are read-only.

Before submitting, run:

```bash
npx tsc --noEmit          # must be clean
npm test                  # judge by the final summary, not by stderr
npx eslint <files you changed>
```

Rust changes also need the relevant Cargo check or test from `src-tauri/`.

Three things about those gates that will otherwise waste your time:

- **The suite prints alarming output on purpose.** Negative-path tests emit things like `LOCKOUT BREACH`, authorization failures, and timeouts to stderr while passing. The Vitest summary and exit code are the verdict.
- **Treat repo-wide lint as a ratchet.** `npm run lint` permits the current warning baseline, and that ceiling only goes down. Keep lint fixes focused: when a pull request clears warnings, lower `--max-warnings` in `package.json` in the same pull request instead of leaving unused headroom.
- **Tests are not yet fully isolated from a running install.** A few suites reach global paths outside `CORTEX_IDE_DATA_DIR`, so quit the desktop app before running the full suite, or expect flakes that are not your fault.

Use one of the established commit prefixes: `feat:`, `fix:`, `chore:`, `docs:`, `perf:`, or `refactor:`. Files have an 800-line ceiling unless an existing waiver applies. New TSX styling uses inline style objects rather than new CSS classes.

Cross-process seams, persistence paths, authorization changes, and tool arguments must be tested through the real production entry point. A helper-only unit test does not prove that callers can reach the behavior. [`CLAUDE.md`](./CLAUDE.md) and [`AGENTS.md`](./AGENTS.md) are the full contributor contracts for architecture, reachability testing, verification, and repository rules.

## AI-assisted contributions

AI-assisted pull requests are welcome. The person submitting the pull request is responsible for understanding the entire diff, reviewing it for scope and security, and running the stated verification. Unreviewed agent output, generated explanations that do not match the code, and pull requests whose author cannot explain the change will be closed.

## Review expectations

Review may take time because o8 has a solo maintainer. Opening a pull request does not create a review deadline or guarantee acceptance. Focused fixes with a reproduction and complete verification will be reviewed before speculative or broad changes.

## Repository layout

- [`.agents/`](./.agents/) — repository-local agent skills.
- [`.claude/`](./.claude/) — Claude runtime settings, agents, hooks, and workflows.
- [`.codex/`](./.codex/) — Codex runtime settings and agent profiles.
- [`.github/`](./.github/) — CI workflows and GitHub contribution templates.
- [`assets/`](./assets/) — README and product media.
- [`brand/`](./brand/) — logo and application icon sources.
- [`cli/`](./cli/) — the `o8` command-line client.
- [`config/`](./config/) — checked-in tool configuration and release examples.
- [`dist/`](./dist/) — compiled hook scripts consumed by agent runtimes.
- [`docs/`](./docs/) — user guides, design references, internals, and operations runbooks.
- [`drizzle/`](./drizzle/) — database migration assets.
- [`examples/`](./examples/) — example directives and configuration patterns.
- [`licenses/`](./licenses/) — third-party license texts.
- [`patches/`](./patches/) — package-manager patches applied during install.
- [`protocol/`](./protocol/) — realtime protocol contracts and generated bindings.
- [`public/`](./public/) — static assets served by Next.js.
- [`scripts/`](./scripts/) — development, verification, build, and release tooling.
- [`src/`](./src/) — the Next.js application and shared TypeScript domain logic.
- [`src-tauri/`](./src-tauri/) — the Tauri shell and native Rust code.
- [`tauri-plugin-mcp/`](./tauri-plugin-mcp/) — the bundled Tauri MCP plugin.
- [`tests/`](./tests/) — cross-cutting Vitest suites, fixtures, and Playwright specs.
