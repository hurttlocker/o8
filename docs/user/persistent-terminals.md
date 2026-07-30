# Persistent terminals

Interactive o8 terminals are backed by tmux so their shell process and scrollback can survive a WebSocket-server restart or a full app restart.

## What persists

Terminal tabs store their tmux session identity with the workspace state. When o8 reconnects, it checks that session, reattaches the live shell, and replays captured scrollback into the terminal view. Detaching the UI does not end the shell; explicitly closing the terminal does.

Persistence is enabled by default. Set `O8_PERSISTENT_TERMINALS=0` to use the legacy process-bound terminal behavior.

## Requirements and fallback

tmux must be available on the host for a terminal to survive the owning process. If tmux is missing or a session cannot be created, o8 falls back to a normal shell terminal instead of failing the launch. That terminal works normally but ends with the WebSocket server.

## Recovery checks

- `tmux ls` shows the live terminal sessions independently of the app.
- `o8 run --list` shows long-running commands launched through the managed-run surface.
- `o8 doctor` checks the local control plane when tabs do not reconnect.

If a restored tab has no live tmux session, o8 treats it as dead and starts a fresh shell only through the normal restore path. It never represents a missing session as recovered.
