# Local operating agreement

An owner may create `OPERATING_AGREEMENT.md` in the active o8 data directory. o8 reads it before every registered orchestrator turn, including resumed conversations. Editing the file changes the next turn; restarting is unnecessary.

The file is optional, limited to 32 KiB, and never created with shipped preferences. Missing or empty files leave behavior unchanged. Read errors and oversized files stop the turn instead of silently dropping the agreement. Keep account-specific text outside the repository.

A reader skill can point external agents at the same file. That skill is separate from the in-app loader, which covers all registered backends regardless of their skill discovery support.
