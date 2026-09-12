# Standalone Worker CLI

## Current protocol boundary

This executable uses the legacy `/api/worker/*` contract described below. The
durable cloud adapter uses `/api/cloud/*` with a separate scoped cloud-worker key
lifecycle, job leases, persisted events, and control acknowledgements. These
contracts and credentials are not interchangeable. The current standalone poll
loop waits for execution to finish and does not cancel an in-flight run.

[#2278](https://github.com/hurttlocker/o8/issues/2278) tracks integrating this
existing executable with the durable protocol. The
[remote project milestone](../../docs/operations/remote-project-milestone.md)
defines the required dispatch, workspace, recovery, review, and operational proof.
The instructions below describe the legacy worker; they are not a runbook for
that planned durable integration.

The standalone worker CLI runs remote o8 packets on a separate machine, pushes the finished branch back to `origin`, and reports progress back to the o8 instance so the lane merge gate can pick it up.

## Prerequisites

- Node.js 22 or newer. The bundled build targets `node22`.
- `git` and the `codex` CLI available on `PATH`.
- `gh auth login` completed for GitHub repos, or an explicit `GITHUB_TOKEN` / `GH_TOKEN` in the environment. The worker clones and pushes with `git`, and GitHub auth is validated before it starts work.
- A running o8 instance reachable over HTTPS or loopback, such as `http://localhost:3001`.
- A worker token from `Settings -> Workers` in the desktop app. Tokens are generated there and use the `o8wt_...` format. The Workers tab shipped in `#554`.

## Build

Build the standalone worker bundle from the repo root:

```bash
npm run worker:build
```

That runs `node scripts/build-worker.mjs` and writes the CLI bundle to:

```text
dist/worker/o8-worker.mjs
```

## Run

Run the built worker with the o8 base URL and a worker token:

```bash
node dist/worker/o8-worker.mjs --o8-url <url> --token <token>
```

Example:

```bash
node dist/worker/o8-worker.mjs --o8-url http://localhost:3001 --token o8wt_...
```

The token is only shown once when you create it in `Settings -> Workers`, so paste it somewhere safe before closing that dialog.

## What The Worker Does At Runtime

- Polls `GET /api/worker/poll` for the next pending worker event tied to its token.
- For `launch` events, creates a per-run workspace under `~/.o8/worker/<runId>/repo` by default, clones the target repo, checks out the requested base ref, and creates the requested remote branch.
- Runs `codex exec --dangerously-bypass-approvals-and-sandbox --json` inside that cloned repo, streaming progress lines back to o8.
- Posts worker updates to `POST /api/worker/event` using the same bearer token, including `progress`, `branch_pushed`, `completed`, and `errored`.
- Pushes the result branch to `origin` with `git push -u origin <remoteBranch>` and reports the pushed branch and commit SHA back to o8.

## Troubleshooting

### `401 Unauthorized` / `auth missing`

The worker token is invalid, missing, empty, or revoked. Generate a new token in `Settings -> Workers`, then confirm `--token` is passed and not blank.

### `ECONNREFUSED` / o8 unreachable

The o8 app is not running, the URL is wrong, or the local port is occupied. Confirm o8 is up, the port in `~/.cortex-ide/api-port` matches `--o8-url`, and nothing is blocking loopback or LAN traffic.
