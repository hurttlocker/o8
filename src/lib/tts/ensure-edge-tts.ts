/**
 * Lazy ensure that edge-tts is installed in the same `python3` the
 * /api/tts route spawns — the Steffan male voice the message action-bar "play"
 * button uses to read an orchestrator reply aloud.
 *
 * Without the package, /api/tts exits non-zero and the client TTS engine
 * silently falls back to the browser SpeechSynthesis voice (Siri on macOS) —
 * the generic system voice a fresh machine hears instead of the intended male
 * voice. The dependency can be present on one development machine and absent
 * on another, which can hide the failure during local testing.
 *
 * Runs once per server process on the first TTS request: checks
 * `python3 -c "import edge_tts"`; if missing, pip-installs in the background
 * so the next play uses the real voice. Never throws. PEP-668
 * ("externally-managed") pythons reject a bare install, so a
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

function pipInstall(opts: { breakSystem?: boolean; user?: boolean }): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const args = ['-m', 'pip', 'install', '--quiet'];
    if (opts.breakSystem) args.push('--break-system-packages');
    if (opts.user) args.push('--user');
    args.push('edge-tts');
    try {
      // Capture stdout too — pip writes some failures there, and the old
      // stderr-only capture produced the useless "failed. stderr:" (empty)
      // log that hid the free laptop's real failure (2026-07-12).
      const proc = spawn(PYTHON, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 });
      let out = '';
      proc.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString(); });
      proc.stderr?.on('data', (chunk: Buffer) => { out += chunk.toString(); });
      proc.on('close', (code, signal) => resolve({ ok: code === 0, detail: `exit=${code ?? `signal:${signal}`} ${out.trim()}` }));
      proc.on('error', (err) => resolve({ ok: false, detail: err.message }));
    } catch (err) {
      resolve({ ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  });
}

/** Fire-and-forget: install edge-tts if the play voice can't find it. */
export async function ensureEdgeTtsInstalled(): Promise<void> {
  if (attempted) return;
  attempted = true;
  try {
    if (await importsEdgeTts()) return; // already good — the common case, ~100ms
    console.log('[tts] first use: edge-tts is missing; installing the optional Python fallback');
    let result = await pipInstall({});
    if (!result.ok && /externally-managed-environment|break-system-packages/i.test(result.detail)) {
      result = await pipInstall({ breakSystem: true });
    }
    if (!result.ok && /permission denied|not writeable|errno 13/i.test(result.detail)) {
      // System-python site-packages unwritable → per-user install.
      result = await pipInstall({ user: true });
    }
    if (result.ok && (await importsEdgeTts())) {
      console.log('[tts] edge-tts installed — play voice ready');
    } else {
      console.warn('[tts] edge-tts auto-install failed; play falls back to the system voice.', result.detail.slice(0, 400));
    }
  } catch (err) {
    console.warn('[tts] edge-tts ensure errored (non-fatal):', err);
  }
}
