# Onboarding release checklist

Owner: first-run workstream. Last reconciled: 2026-09-26.

These are candidates for the next release, not shipped claims. Rows stay pending
until their acceptance checks pass and release inclusion is verified. GitHub may
close an issue when its PR merges; keep that row here until it ships.

## Candidate closures

| Issue | Change | PR | Remaining acceptance |
| --- | --- | --- | --- |
| #2773 | Installed-tool discovery and preserved defaults | #2774 | Release inclusion |
| #2777 | Resumable first run and explicit privacy choices | #2778 | Release inclusion; final flow supersedes its original tour |
| #2779 | Project-first entry without a forced task | #2780 | Release inclusion |
| #2783 | Team choices and contextual workspace guidance | #2787 | Native folder selection (automation focus blocked); release inclusion |
| #2785 | Opaque onboarding with readable glass-theme controls | #2788 | Release inclusion |
| #2789 | All Glass default for fresh macOS profiles | #2791 | Release inclusion |
| #2790 | Hidden scrollbars with scrolling preserved | #2792 | Release inclusion |
| #2784 | Native folder picker and manual fallback | #2793 | Native folder selection (automation focus blocked); release inclusion |
| #2795 | Optional local operating-agreement loader | #2797 | Release inclusion |
| #2794 | Agent setup with durable app acknowledgments | #2798 | Release inclusion |
| #2796 | Permission checks, microphone test, restart recovery | #2800 | Spoken-input success; release inclusion |
| #2801 | Consistent confirmations, recovery, and project context | #2802 | Release inclusion |
| #2799 | Slow native debug restart | #2803 | Idle/release timings; release inclusion |

## Final acceptance

- [x] Existing runtime, model, worker, and privacy choices remain preserved.
- [x] No task or provider request is submitted automatically.
- [x] Permission grants and detected audio are distinct results.
- [x] Native restart restores onboarding and rechecks access.
- [x] Agent-requested project opening reaches the actual workspace.
- [ ] Native folder selection reaches that same workspace.
- [ ] Final success and recovery UI verified at laptop size, with keyboard access.
- [x] Final changed-stack tests, typecheck, lint, and build pass.
- [ ] Published installer contains the reviewed stack; clean-profile and restart checks pass.

## Latest verification

- Continuity: 19 focused tests pass; TypeScript passes; touched lint has no errors.
- Runtime persistence integration: 3 tests pass.
- Setup-saved confirmation, retained project identity, explicit privacy choices, and keyboard handoff verified in the isolated preview at 1024 × 700.
- Native picker opens; automated selection is blocked by macOS focus delivery. This is not a completed selection check.
- Native workspace shows the selected project and waits for the first message at 1024 × 700.
- Optimized debug launch: window at 17.5s; dashboard connection at 20.6s under concurrent load. Restart-and-return: window at 38.2s; dashboard at 43.4s; permissions page restored, all four statuses rechecked, resume marker consumed. Idle/release timings remain unmeasured.
- Continuity stack CI: https://github.com/hurttlocker/o8/actions/runs/36265555314. All gates passed, including build. Hermetic suite: 5,109 passed, 4 skipped.
- Debug-profile stack CI: https://github.com/hurttlocker/o8/actions/runs/36265768866. All gates passed; subsequent changes only record these receipts.

## Deferred

- #2781: Produce onboarding media.
- #2782: Integrate approved onboarding media.
- #2634: Model catalogue compatibility remains its own acceptance boundary.

## At the next ship

Record the release tag, exact included commits, CI run, and native installer
acceptance here. Close only the candidate issues whose acceptance is complete.
Carry incomplete rows forward with their blocker. Update the relevant roadmap
trackers after release verification. Do not include personal agreement contents,
local paths, or raw screenshots in release notes.
