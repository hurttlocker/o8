/**
 * Next.js 16 instrumentation hook — runs once when the server starts.
 *
 * Currently fires a single fire-and-forget probe to warm the OpenRouter
 * undici connection pool (#1123). Without this, the first cortex_ask call
 * after dev-server / prod-app startup pays ~1.7s for DNS + TLS + HTTP/2
 * setup before the classifier request lands; with the warm-up the pool is
 * already hot by the time a user question arrives.
 *
 * The probe never throws and never blocks boot. Real calls retry on failure.
 *
 * Only runs on the `nodejs` runtime (server). Edge runtime skips this — the
 * Q&A pipeline is server-only and never reaches Edge.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

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

  // Dynamic import so the warm-up module isn't pulled into Edge bundles.
  const { warmupOpenRouter } = await import('@/lib/cortex/qa/llm/openrouter-adapter');

  // Fire-and-forget — don't await. The boot path returns immediately and the
  // probe completes in the background (~200ms typical in prod, ~900ms in dev
  // because Turbopack compiles the module on first registration).
  void warmupOpenRouter();

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

  // Ensure the edge-tts Steffan play voice is installed in the route's python —
  // without it, "play" on an orchestrator message silently degrades to the
  // system SpeechSynthesis voice (Siri). Self-heals fresh machines/downloaders
  // in the background so the next play uses the real voice. Never blocks boot.
  void (async () => {
    try {
      const { ensureEdgeTtsInstalled } = await import('@/lib/tts/ensure-edge-tts');
      void ensureEdgeTtsInstalled();
    } catch {
      // never blocks boot
    }
  })();
}
