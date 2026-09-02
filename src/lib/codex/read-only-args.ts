/**
 * Read-only worker lockout for the owned Codex runtime.
 *
 * Codex is the DEFAULT worker runtime, so a read-only packet that only hardened
 * Claude Code was read-only in name for almost every real dispatch: the Codex
 * worker still launched with `--dangerously-bypass-approvals-and-sandbox -s
 * danger-full-access`, the widest mode Codex offers.
 *
 * ── Why the enforcement is the OUTER sandbox, not Codex's own ────────────────
 *
 * Codex has a native `-s read-only` sandbox, and using it here is the obvious
 * move. It does not work, and the failure is silent-ish and total.
 *
 * A read-only packet ALWAYS runs inside o8's own generated seatbelt profile —
 * `resolveReadOnlySandboxPlan` forces it on regardless of `O8_WORKER_SANDBOX`,
 * and the spawn is refused outright if that profile cannot be built. Asking
 * Codex to additionally apply its own macOS sandbox nests `sandbox-exec` inside
 * `sandbox-exec`, and the inner one cannot acquire the sandbox:
 *
 *     sandbox-exec: sandbox_apply: Operation not permitted   (exit 71)
 *
 * Measured directly against a generated read-only profile on this host, and the
 * same failure `lane/orchestrator-backends/orchestration-mode.ts` already
 * documents for single-orchestrator mode. Every `exec_command` the worker runs
 * would die — including `git log`, `o8 ask`, and `o8 packet report`, which are
 * exactly what a read-only packet exists to do.
 *
 * So the layers are split by what each can actually deliver:
 *
 *   o8 seatbelt profile (outer, FORCED, fail-closed)
 *       The real enforcement. Kernel-level write denial on the worktree, the
 *       backing repo, and the git metadata dirs, derived from the same single
 *       git probe that grants read access. Also denies the operator's `~/.o8`
 *       secrets. Strictly stronger than Codex's own read-only mode, and it
 *       cannot be talked out of by the model.
 *
 *   sandbox_mode="danger-full-access" (inner, Codex)
 *       Deliberately NOT a second sandbox. It tells Codex to skip its own
 *       seatbelt so the nesting failure above never happens. "Full access" is
 *       accurate only about the INNER layer — the process it describes is
 *       already wrapped in a kernel policy that refuses repository writes.
 *
 *   approval_policy="never" (inner, Codex)
 *       An owned worker is a one-shot `codex exec --json` process with nobody
 *       on the other end of an approval prompt. Without this, a write the
 *       kernel refuses could surface as an escalation request that stalls the
 *       turn instead of failing it — and an escalation path is exactly the kind
 *       of thing that gets auto-approved into a full-access retry later.
 *
 * INVARIANT: these flags are only safe because the outer sandbox is mandatory
 * for read-only packets and fail-closed. If `enforceReadOnly` ever becomes
 * best-effort in `owned-session/sandbox.ts`, a read-only Codex worker would run
 * with no write protection at all. Keep those two facts together.
 */

/** Approval policy for every read-only turn. `-c` works on `exec` and `exec resume`. */
export const CODEX_NEVER_APPROVE_ARGS = ['-c', 'approval_policy="never"'] as const;

/**
 * Codex's inner sandbox is disabled on purpose — see the nesting note above.
 * The write denial is the outer o8 seatbelt profile, which is forced on and
 * fail-closed for every read-only packet.
 */
export const CODEX_INNER_SANDBOX_OFF_ARGS = ['-c', 'sandbox_mode="danger-full-access"'] as const;

/** `codex exec` read-only flags. */
export const CODEX_READ_ONLY_LAUNCH_FLAGS = [
  ...CODEX_INNER_SANDBOX_OFF_ARGS,
  ...CODEX_NEVER_APPROVE_ARGS,
] as const;

/**
 * `codex exec resume` read-only flags.
 *
 * Same policy. Note `codex exec resume` has NO `-s/--sandbox` flag — passing it
 * makes the CLI exit 2 before the turn starts (live-hit 2026-07-05, #1415) —
 * which is another reason both paths express the policy as `-c` overrides.
 */
export const CODEX_READ_ONLY_RESUME_FLAGS = [
  ...CODEX_INNER_SANDBOX_OFF_ARGS,
  ...CODEX_NEVER_APPROVE_ARGS,
] as const;

/** Full-access flags a normal write packet keeps. Read-only launches drop them. */
export const CODEX_FULL_ACCESS_LAUNCH_FLAGS = [
  '--dangerously-bypass-approvals-and-sandbox',
  '-s',
  'danger-full-access',
] as const;

/** Full-access flag a normal write resume keeps. Read-only resumes drop it. */
export const CODEX_FULL_ACCESS_RESUME_FLAGS = [
  '--dangerously-bypass-approvals-and-sandbox',
] as const;

/**
 * The sandbox/approval fragment for a Codex launch. For a write packet this
 * returns exactly the flags that were previously hard-coded, in the same order,
 * so a normal dispatch stays byte-identical.
 */
export function codexSandboxLaunchArgs(readOnly: boolean): string[] {
  return readOnly ? [...CODEX_READ_ONLY_LAUNCH_FLAGS] : [...CODEX_FULL_ACCESS_LAUNCH_FLAGS];
}

/** The sandbox/approval fragment for a Codex resume turn. */
export function codexSandboxResumeArgs(readOnly: boolean): string[] {
  return readOnly ? [...CODEX_READ_ONLY_RESUME_FLAGS] : [...CODEX_FULL_ACCESS_RESUME_FLAGS];
}
