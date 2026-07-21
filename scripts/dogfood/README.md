# Supervised dogfood loop

The launcher is the security boundary for the PR-only dogfood loop. It owns one
atomic driver lock for the entire Claude session, exposes only the o8 webview
MCP profile, removes Claude task/workflow entrypoints, and injects a pre-push
hook into every descendant Git process so `refs/heads/main` cannot be pushed.

Install the stable home entrypoints once:

```bash
bash scripts/dogfood/install.sh
```

For a supervised run, close o8, clear the deliberate kill switch, and launch:

```bash
rm ~/.o8/.dogfood.STOP
~/o8-dogfood-loop.sh
```

Inside that guarded Claude session, schedule the built-in loop against the
already-loaded dogfood instructions. `~/o8-dogfood-stop.sh` is the kill switch;
it stands down the gate, stops the owned app and Claude child, lifts the merge
wall, and releases the lock without touching an operator-owned o8 process.

The source-controlled scripts are authoritative. `install.sh` backs up any old
home artifacts before replacing them with links, so previous versions remain
recoverable under `~/.o8/dogfood-artifact-backups/`.
