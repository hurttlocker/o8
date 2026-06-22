/**
 * Boot-time ensure that edge-tts is installed in the same `python3` the
 * /api/tts route spawns — the Steffan male voice the message action-bar "play"
 * button uses to read an orchestrator reply aloud.
 *
 * Without the package, /api/tts exits non-zero and the client TTS engine
 * silently falls back to the browser SpeechSynthesis voice (Siri on macOS) —
 * the "stupid-ass computer voice" a fresh machine / downloader hears instead of
 * the male voice. Sydney's laptop hit exactly this: edge-tts was never in her
 * python; the iMac happened to have it, so the bug was invisible here.
 *
 * Runs once per server process (fire-and-forget from instrumentation.ts):
 * checks `python3 -c "import edge_tts"`; if missing, pip-installs in the
 * background so the NEXT play uses the real voice. Never throws, never blocks
 * boot. PEP-668 ("externally-managed") pythons reject a bare install, so a
 * first attempt that trips that guard retries with --break-system-packages.
 *
 * The route resolves `python3` off the server PATH (the Tauri sidecar augments
 * it from the login shell), and this runs in the same process — so both target
 * the same interpreter. Override with O8_TTS_PYTHON if needed.
 */

import { spawn } from 'child_process';

let attempted = false;

const PYTHON = process.env.O8_TTS_PYTHON || 'python3';

function importsEdgeTts(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const proc = spawn(PYTHON, ['-c', 'import edge_tts'], { stdio: 'ignore', timeout: 10_000 });
      proc.on('close', (code) => resolve(code === 0));
      proc.on('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

function pipInstall(breakSystem: boolean): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const args = ['-m', 'pip', 'install', '--quiet'];
    if (breakSystem) args.push('--break-system-packages');
    args.push('edge-tts');
    try {
      const proc = spawn(PYTHON, args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 120_000 });
      let stderr = '';
      proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      proc.on('close', (code) => resolve({ ok: code === 0, stderr }));
      proc.on('error', (err) => resolve({ ok: false, stderr: err.message }));
    } catch (err) {
      resolve({ ok: false, stderr: err instanceof Error ? err.message : String(err) });
    }
  });
}

/** Fire-and-forget: install edge-tts if the play voice can't find it. */
export async function ensureEdgeTtsInstalled(): Promise<void> {
  if (attempted) return;
  attempted = true;
  try {
    if (await importsEdgeTts()) return; // already good — the common case, ~100ms
    console.log('[tts] edge-tts missing — installing the Steffan play voice in the background…');
    let result = await pipInstall(false);
    if (!result.ok && /externally-managed-environment|break-system-packages/i.test(result.stderr)) {
      result = await pipInstall(true);
    }
    if (result.ok && (await importsEdgeTts())) {
      console.log('[tts] edge-tts installed — play voice ready');
    } else {
      console.warn('[tts] edge-tts auto-install failed; play falls back to the system voice. stderr:', result.stderr.slice(0, 300));
    }
  } catch (err) {
    console.warn('[tts] edge-tts ensure errored (non-fatal):', err);
  }
}
