# First-run receipt — 2026-09-12

This run measured the README's macOS **From source** path from clone start to the first local packet merge. It used a fresh clone, a fresh data directory, and a disposable local Git repository. The installed app was not started or controlled; reuse of browser-origin state became a recorded first-run friction.

Wall-clock timestamps are EDT. The end-to-end clock started at `00:09:05` and stopped at the recorded `mergedAt` time, `00:15:52`. Setup is clone through the ready dev server. Waiting is dispatch claim through `awaiting_review`. Active human time is the remainder, including reading output, choosing the next documented command, and resolving stalls.

| Step | Docs said | Actually did | Wall-clock minutes | Stall | Maintainer knowledge used |
| --- | --- | --- | ---: | --- | --- |
| 1. Clone | README: clone the repository and enter it. | Cloned into `~/o8-firstrun-2026-09-12/o8`. | 0.05 | None. | No |
| 2. Select Node 22 | README: `nvm install && nvm use`. | The command failed, then `node --version` confirmed the existing `v22.23.2`. | 0.10 | **S1.** `nvm` was not installed and the README did not state that prerequisite or an alternative. | No |
| 3. Install dependencies | README: `npm install`. | Installed 1,397 packages; both native modules and three patches completed. | 0.42 | None. The audit reported seven vulnerabilities, but installation completed. | No |
| 4. Start the source stack | README: `npm run dev` on API `47120` and WS `47125`; AGENTS documents port overrides. | Confirmed `47120`–`47129` were free, then started with `CORTEX_IDE_DATA_DIR=~/o8-firstrun-2026-09-12/data`. Next reported ready in 512 ms. | 0.02 to ready | **S2.** The server repeatedly logged unauthorized broadcast polling ([#2240](https://github.com/hurttlocker/o8/issues/2240)). | No |
| 5. Create the target | Measurement brief: make a local repository with one file and one commit. | Initialized `target` on `main` and committed `README.md`. | 0.10 | None. | No |
| 6. Reach a control surface | README starts a web loop; AGENTS says the global CLI appears after the native app runs once. | Confirmed the source install had no CLI binary. Tried first-run setup in the web UI, then inspected the source package scripts, ran `npm run build:cli`, and used `node cli/dist/o8.mjs` with the isolated data directory and API port. | 2.23 | **S3.** The README stopped before a usable source control command. **S4.** Browser state restored a repository absent from the fresh registry ([#2236](https://github.com/hurttlocker/o8/issues/2236)). **S5.** The local-folder picker waited 60 seconds with no chooser or error ([#2235](https://github.com/hurttlocker/o8/issues/2235)). | Yes |
| 7. Register the target | AGENTS: `o8 repo add <path>`. | Registered the target through the built source CLI. | <0.01 | **S6.** The result said `registered: true` but `readiness: "blocked"`, `exists: null`, and gave no cause; dispatch still worked ([#2237](https://github.com/hurttlocker/o8/issues/2237)). | No |
| 8. Create and dispatch | AGENTS: `mission create`, then `mission dispatch`. | Created one mission and dispatched its one packet on runtime `codex`. | 0.07 | None. | No |
| 9. Wait | AGENTS: `mission wait` or `mission status`. | Waited until `awaiting_review`. The recorded worker startup was 9.6 s; first output was 87.3 s after worker-ready; review-ready arrived 98.8 s after launch started. | 1.65 waiting | None. | No |
| 10. Review the diff | AGENTS: `packet diff`, then `packet review --approve`. | Read the one-line diff and approved its exact HEAD. The first review call omitted `--packet` because the reference did not show the operator form; the error supplied the missing flag. | 0.13 | **S7.** The operator-side review form was missing from the CLI reference. | No |
| 11. Clear the review gate | AGENTS: review uses the gated merge path; `inbox list` and `inbox approve` handle operator cards. | Review approval was recorded, but merge was refused for missing task-contract coverage. Listed and approved the generated inbox card. | 0.42 | **S8.** The CLI exposed no way to record the required coverage, forcing a second approval ([#2238](https://github.com/hurttlocker/o8/issues/2238)). | No |
| 12. Merge and verify | The roadmap outcome ends at a first merged packet. | The approval fast-forwarded the target's local `main` to `33473b7`; `git log`, the file contents, mission `mergedAt`, and the clean target worktree confirmed the merge. | 0.03 to merge | **S9.** The successful local merge still reported a fatal push failure because the test repository had no remote ([#2239](https://github.com/hurttlocker/o8/issues/2239)). | No |

**Totals:** setup 0.9 min · active human 4.2 min · waiting 1.7 min · end to end 6.8 min · stalls 9 · maintainer knowledge used: yes for step 6; no for steps 1–5 and 7–12.

The fresh-run mission recorded one attempt, no retry, a local merge at `00:15:52`, and terminal cleanup at `00:15:54`. Two post-merge log findings did not add wall-clock stalls: worktree evidence capture ran after the path disappeared ([#2241](https://github.com/hurttlocker/o8/issues/2241)), and the successful merge emitted a refused terminal transition after archival ([#2242](https://github.com/hurttlocker/o8/issues/2242)).

## What a stranger would hit first

1. **High — state boundary:** a normal browser profile can restore a repository that the fresh server never registered and attempt work before setup finishes ([#2236](https://github.com/hurttlocker/o8/issues/2236)).
2. **High — no working repository picker:** the README's web loop presents a local-folder action that waits without opening a chooser or showing a fallback ([#2235](https://github.com/hurttlocker/o8/issues/2235)).
3. **High — no source control command:** the documented source install starts the servers but does not install `o8` or tell the operator to build and invoke `cli/dist/o8.mjs`. This PR adds those commands.
4. **Medium — approval has an undocumented second gate:** an approved review cannot supply the coverage evidence the merge gate requires ([#2238](https://github.com/hurttlocker/o8/issues/2238)).
5. **Medium — local repository signals conflict:** registration reports blocked readiness, then the packet can run and merge, after which the receipt reports a remote push failure ([#2237](https://github.com/hurttlocker/o8/issues/2237), [#2239](https://github.com/hurttlocker/o8/issues/2239)).
6. **Low — prerequisite wording:** the README assumes `nvm` exists. This PR states the prerequisite and the direct Node 22 alternative.
