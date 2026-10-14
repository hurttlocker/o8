# Headless manual review hold

Start a headless profile with `O8_REVIEW_MODE=manual o8 serve` to hold background
review work for that process lifetime. `o8 serve status` reports `reviewMode`.
The default is `automatic`; values other than these two are rejected at startup.
Use the same environment on a subsequent restart to retain the hold. A supervised
restart retains its existing mode and refuses an explicitly different or invalid
mode before signaling. Stop the profile, then start it again to change its mode.

Manual mode does not reclaim abandoned review attempts, claim queued reviews,
start packet explainers, or enqueue review continuations. The headless children
also receive per-run overrides disabling the heal bot, supervisor escalation,
packet explainer, and Brain warmup. Background sprint ticks from the WebSocket
bridge are held. Saved operator defaults and existing review claims are preserved.

The hold is a startup recovery control. It does not cancel already-running turns
or prohibit explicitly requested tasks. Stop the previous runtime and verify its
owned processes have exited before starting a profile in manual mode. Inspect the
preserved review state before returning that profile to automatic mode.
