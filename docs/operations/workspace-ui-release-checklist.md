# Workspace UI release acceptance

Source integration is not release proof. Keep issue closure and shipped acceptance separate.

| Scope | Tracking | Source state | Release acceptance |
| --- | --- | --- | --- |
| Compact worker layout | #2814, #2763 | Shipped in v0.1.771 | Four real workers and ten simulated panes at compact and large sizes; scroll, focus, close, drag, reload |
| Shared checkout | #2772 | Shipped in v0.1.771 | Packaged orchestrator, scoped workers, reviewed commit, team closure, cold restore |
| Shared workspace pages and navigation | #2817 | Shipped in v0.1.771 | Projects, Customize, Automations, Handoffs replies, tab ownership and retained pane layouts |
| Managed-run observation | #2816 | Shipped in v0.1.771 | Attach, resize, visibility and reconnect preserve worker input and dimensions |
| Account drawer release shortcut | #2769 | Shipped in v0.1.771 | Settings and help remain reachable |

Development-only worker previews and the compact rail study remain development-only. Onboarding media remains deferred under #2781 and #2782.

## Release receipt

Published [v0.1.771](https://github.com/hurttlocker/o8-releases/releases/tag/v0.1.771) contains integration #2819 at source `034875099c1b93cfc0e1d7a3438dc18f7a367f59`. Public updater signature, app and DMG notarization, Gatekeeper assessment, and matching app code signatures passed. Installed first-run launch and permission restart passed. The normal desktop profile reaches its workspace after the gateway reconnects; the account drawer shows v0.1.771 with Settings, Check for updates and Get help, and no release-note shortcut. Candidate worker tests below were not repeated with new paid workers after the version-only change.

Keep #2763, #2766, #2768, #2772 and #2814 open for their remaining outside-worker, terminal interaction, collision, ten-real-worker, isolated-mode and compact steer/drop acceptance. Four real workers and ten simulated panes are different evidence.

## Candidate evidence

- Rendered page tests cover shared headings, automation loading, tab ownership, worker identity and steer receipts.
- The packaged app exposes Projects, Customize and Automations with their shared headings and return actions; the Handoffs panel opens and reports its empty state.
- Native development preview: ten simulated workers remain readable at 1100 by 800 with independent scrolling; all ten fit at 2200 by 1200.
- TypeScript and touched-file ESLint passed. Shared checkout integration passed 37 tests across eight files; terminal integration passed all four real WebSocket/PTY tests.
- Observer-first attach, writer resize, reconnect and writer detach preserve read-only boundaries. Two views of the same session on one WebSocket still share one mode; the read-only guard wins.
- Exact-head hosted checks passed at product source `03dbc851f`, including the full hermetic suite, changed-file integration, security, governance, type, lint and Linux/Windows compilation.
- Shared scope review reports both sides of a rename; the real Git regression rejects finalization and retains ownership (#2818).
- Packaged Shared execution passed with four real workers, four disjoint file scopes, one verified commit, and archived team ownership. After #2821, all four panes attach to the selected parent.
- Native checks passed at 1100 by 800 and 2200 by 1200. Actual divider drag, pane focus and close, reload, and full restart preserved the expected layout and project scope.
- Final packaged source `03dbc851f`: an existing chat retained its explicitly selected project through restart and send. The runtime default directory matched that project, one real worker changed exactly its claimed file, and its mounted pane reached `complete · runtime` without reload. Exact bytes, a clean local commit, team archival, and a replacement persisted runtime thread were verified (#2820, #2822, #2823).
- Missing-rollout recovery now finds its diagnostic after startup warnings. The process-lifecycle regression failed before the fix and all 13 tests passed afterward; native recovery also passed.
- Final local full-suite run: 831 files passed and one service-command timeout failed; that file passed on an isolated rerun without changes. Final exact-head hosted checks are recorded on [the integration pull request](https://github.com/o8-run/o8/pull/2819).
- Isolated-mode placement requires storage admission. Do not bypass its reserve or silently substitute Shared mode.
