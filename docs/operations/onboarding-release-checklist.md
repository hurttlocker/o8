# Onboarding release checklist

Owner: first-run workstream. Last reconciled: 2026-09-27.

The completed non-media stack shipped in [v0.1.771](https://github.com/hurttlocker/o8-releases/releases/tag/v0.1.771), source `034875099c1b93cfc0e1d7a3438dc18f7a367f59`. Published artifact verification is recorded below. Broader first-use outcomes remain separate.

Integration PR #2812 carries the completed stack onto main without draft worker
layout changes. The original PRs below retain their individual review evidence.
Restart receipt recovery is tracked separately in #2813.

## Released scope

| Issue | Change | PR | Release state |
| --- | --- | --- | --- |
| #2773 | Installed-tool discovery and preserved defaults | #2774 | Shipped in v0.1.771 |
| #2777 | Resumable first run and explicit privacy choices | #2778 | Shipped; final flow supersedes its original tour |
| #2779 | Project-first entry without a forced task | #2780 | Shipped in v0.1.771 |
| #2783 | Team choices and contextual workspace guidance | #2787 | Shipped in v0.1.771 |
| #2785 | Opaque onboarding with readable glass-theme controls | #2788 | Shipped in v0.1.771 |
| #2789 | All Glass default for fresh macOS profiles | #2791 | Shipped in v0.1.771 |
| #2790 | Hidden scrollbars with scrolling preserved | #2792 | Shipped in v0.1.771 |
| #2784 | Native folder picker and manual fallback | #2793 | Shipped in v0.1.771 |
| #2795 | Optional local operating-agreement loader | #2797 | Shipped in v0.1.771 |
| #2794 | Agent setup with durable app acknowledgments | #2798 | Shipped in v0.1.771 |
| #2796 | Permission checks, microphone test, restart recovery | #2800 | Shipped in v0.1.771 |
| #2801 | Consistent confirmations, recovery, and project context | #2802 | Shipped in v0.1.771 |
| #2799 | Slow native debug restart | #2803 | Shipped in v0.1.771 |
| #2804 | Align dialog packages for native bundling | #2805 | Shipped in v0.1.771 |
| #2806 | Keep keyboard focus inside onboarding | #2807 | Shipped in v0.1.771 |
| #2808 | Visible microphone-test button | #2809 | Shipped in v0.1.771 |
| #2811 | Recover unfinished agent setup receipts after restart | #2813 | Shipped in v0.1.771 |

## Final acceptance

The agreed non-media local acceptance scope is complete and included in v0.1.771.

- [x] Existing runtime, model, worker, and privacy choices remain preserved.
- [x] No task or provider request is submitted automatically.
- [x] Permission grants and detected audio are distinct results.
- [x] Real microphone input reaches the successful audio-check state.
- [x] Native restart restores onboarding and rechecks access.
- [x] Agent-requested project opening reaches the actual workspace.
- [x] Native folder selection reaches that same workspace.
- [x] Final success and recovery UI verified at laptop size, with keyboard access.
- [x] Final changed-stack tests, typecheck, lint, and build pass.
- [x] Local production candidate passes clean-profile launch and restart checks.
- [x] Published installer contains the reviewed stack; clean-profile launch and permission restart repeated. Native folder selection passed on the candidate; the published picker opened, but the automation driver could not complete text entry in its macOS sheet.

## Published artifact verification

- Version PR [#2825](https://github.com/o8-run/o8/pull/2825) passed all required checks. The release tag points to the exact merged source above.
- Public updater archive signature, strict app signature, Gatekeeper assessment, and notarization tickets passed. The downloaded DMG contains the same app code signature as the updater archive.
- Installed release launches with a disposable profile. At 1024 × 700, all four permission rows show Ready, the microphone test is a visible button, and scrolling has no visible scrollbar. Restart and return restores the permissions page and rechecks all four grants. Tool discovery settles on a suggested installed lead.
- Microphone audio-input acceptance remains the previously recorded operator test on unchanged code; no new recording was made for this release.
- Published native picker opens. Dialog automation could not complete its text entry, so published-build folder selection is not claimed as a repeated pass. Candidate selection evidence remains below.

## Earlier verification

- Continuity: 19 focused tests pass; TypeScript passes; touched lint has no errors.
- Runtime persistence integration: 3 tests pass.
- Setup-saved confirmation, retained project identity, explicit privacy choices, and keyboard handoff verified in the isolated preview at 1024 × 700.
- Native picker acceptance passes: selected the fixture folder through the macOS dialog, confirmed Open, then verified onboarding closed into that project workspace with no task submitted.
- Native workspace shows the selected project and waits for the first message at 1024 × 700.
- Keyboard acceptance found focus escaping into the obscured workspace through Tab navigation and late composer focus after startup. Both regressions fail before #2806 and all 16 flow tests pass afterward. Native Shift-Tab and Tab wrap within setup at 1024 × 700; a separate Help dialog can still own focus.
- Final keyboard stack and subsequent microphone-button polish: hermetic suite passes with 5,111 tests passed and 4 skipped; TypeScript, touched ESLint, rule-check, and roadmap checks pass.
- Final keyboard code CI (`515031de0`): https://github.com/o8-run/o8/actions/runs/36269653069. Later ledger-only commits do not change the tested application.
- Local production candidate at `325038fb9`: real WKWebView boot and idle footprint gates pass. Clean-profile window appears at 3.962s, server ready at 7.978s. Restart window appears at 5.150s, server ready at 8.293s; permissions page restored, four permissions rechecked, resume marker consumed. These are startup milestones, not measured time to first interaction. No fatal WebView errors. The artifact is local, ad-hoc signed, and not notarized or published.
- Idle sample: 15 seconds after cooldown, approximately 945 MB physical memory across the app process tree, 2.33% CPU, zero process churn. Loaded-worker footprint was not requested.
- Final packaged UI at `515031de0`: production build and signature verification pass; initial and post-restart focus stay inside onboarding. Restart restores permissions and consumes the resume marker. At 1024 × 700, keyboard navigation reaches the microphone test and scrolls the return button fully into view. Launch milestones: window 4.044s, server 7.789s; restart: window 4.951s, server 8.160s.
- Real microphone input passes: the operator completed the live check and its "We can hear you" success state was observed in the native app. Earlier silence correctly produced no success. The test and stop actions now use the established outlined button with a 44-pixel target; native layout verified at 1024 × 700.
- Optimized debug launch: window at 17.5s; dashboard connection at 20.6s under concurrent load. Restart-and-return: window at 38.2s; dashboard at 43.4s; permissions page restored, all four statuses rechecked, resume marker consumed. Production timings are recorded above.
- Continuity stack CI: https://github.com/o8-run/o8/actions/runs/36265555314. All gates passed, including build. Hermetic suite: 5,109 passed, 4 skipped.
- Debug-profile stack CI: https://github.com/o8-run/o8/actions/runs/36265768866. All gates passed; subsequent changes only record these receipts.

- Installer acceptance found a dialog package mismatch (JavaScript 2.6.0, Rust 2.7.2). #2805 aligns the JavaScript package to 2.7.3; installed files were verified after repairing a stale local npm install. Four folder-opening integration tests and TypeScript pass. All CI gates pass: https://github.com/o8-run/o8/actions/runs/36267205775.

## Deferred

- #2781: Produce onboarding media.
- #2782: Integrate approved onboarding media.
- #2634: Model catalogue compatibility remains its own acceptance boundary.

## Follow-up

Onboarding media remains deferred. Broader download-to-first-merge measurement remains tracked separately in #2211. Keep candidate evidence distinct from published-build checks.
