/**
 * Next.js 16 instrumentation hook — runs once when the server starts.
 *
 * Only runs on the `nodejs` runtime (server). Edge runtime skips this — the
 * Q&A pipeline is server-only and never reaches Edge.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // Windows resolves a bare command name against the CURRENT DIRECTORY before
  // PATH — for CreateProcess and for cmd.exe alike. o8 runs tools like `npx
  // tsc` with the cwd set to an agent's worktree, so a repo containing
  // `npx.cmd` at its root would be executed by us, with our privileges, during
  // provisioning and at the merge gate. Fork PRs are untrusted input by policy,
  // and this needs no agent cooperation at all to fire.
  //
  // Setting this once at server start covers every present and future spawn,
  // including sites that never route through cliInvocation — strictly better
  // coverage than hardening call sites one at a time. It only removes the
  // current directory from EXECUTABLE lookup; explicit paths still work.
  if (process.platform === 'win32') process.env.NoDefaultCurrentDirectoryInExePath = '1';

  // Crash telemetry (Rock 2): observe uncaught exceptions + unhandled
  // rejections in the Next server process and persist them to the local crash
  // store. Never throws; runs before any of the warm-up work below. The opt-in
  // uploader loop is a cheap no-op unless the operator enabled telemetry.
  try {
    const { installProcessCrashCapture } = await import('@/lib/telemetry/crash-capture');
    installProcessCrashCapture('next-server');
    const { startTelemetryUploadLoop } = await import('@/lib/telemetry/uploader');
    startTelemetryUploadLoop();
    // Sentry (dormant unless PACKAGED + a DSN was baked). Fire-and-forget so a
    // slow/failed SDK import can't delay boot. Crash semantics stay unchanged —
    // the crash-capture monitor above still writes the local JSONL sink.
    const { initSentryNode } = await import('@/lib/telemetry/sentry-node');
    void initSentryNode('server');
  } catch {
    // never block boot on telemetry
  }

  // One-time, marker-gated repair of transcripts flipped by the pre-v0.1.229
  // assistant-timestamp bug — so every install self-heals its old threads on
  // update (the persistence clamp already prevents new flips). Deferred to a
  // microtask + never awaited so it can't block boot; idempotent after the
  // marker lands.
  void (async () => {
    try {
      const {
        repairComposerPreamblePollution,
        repairFlippedOrchestratorTranscripts,
      } = await import('@/lib/mobile/orchestrator-thread-history');
      repairFlippedOrchestratorTranscripts();
      repairComposerPreamblePollution();
    } catch {
      // never blocks boot
    }
  })();

  // #984 — legacy search ingestion is resumable and deliberately deferred so
  // schema initialization and app boot never scan transcript/history stores.
  setTimeout(() => {
    void import('@/lib/search/backfill')
      .then(({ runUnifiedSearchBackfills }) => runUnifiedSearchBackfills())
      .catch((error) => console.warn('[search] backfill bootstrap failed', { error: String(error) }));
  }, 1_500);
}
