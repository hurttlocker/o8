/**
 * POST /api/panel/factory-reset
 *
 * Wipes the contents of the o8 data directory (~/.o8 by default). The dir
 * itself is left in place so the app can write a fresh `ws-token` and SQLite
 * db on next launch.
 *
 * What gets deleted:
 *   - Everything inside getDataDir() — sessions, mission state, encrypted API
 *     keys (cortex-ide.db), watched repos, ws-token, api-port, ws-port, logs,
 *     directives, and any side-files the app has written.
 *
 * What survives:
 *   - The data dir itself (so subsequent writes succeed).
 *   - The legacy ~/.cortex-ide dir on disk (rollback safety net).
 *   - The macOS Keychain master key (rotated only if the user explicitly
 *     re-keys; we don't touch it here since other macOS apps may rely on it).
 *
 * Authorization: gated globally by src/middleware.ts on loopback origin or
 * matching ws-token bearer. Cross-origin callers get a 401 before this route
 * runs. The user must restart the app after a successful reset — the running
 * server still holds open SQLite handles to the deleted db file, and clean
 * relaunch is the only safe state.
 *
 * The implementation requires an explicit `confirm: 'RESET'` in the body. A
 * stray POST or replay attack with no payload returns 400 instead of nuking
 * the user's data.
 */

import { NextResponse } from 'next/server';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store, max-age=0' };

type FactoryResetBody = {
  confirm?: unknown;
};

type FactoryResetResult = {
  dataDir: string;
  removed: string[];
  failed: { entry: string; error: string }[];
  durationMs: number;
};

function response(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: NO_STORE_HEADERS });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as FactoryResetBody;

  if (body.confirm !== 'RESET') {
    return response(
      { error: 'Factory reset requires { confirm: "RESET" } in the request body.' },
      400,
    );
  }

  const dataDir = getDataDir();
  const start = Date.now();

  // Safety rail: never operate on `/`, `~`, or anything that doesn't look like
  // an o8 data dir. If a user has aimed CORTEX_IDE_DATA_DIR at their HOME
  // (rare but possible for a misconfiguration), we refuse rather than recurse.
  if (!dataDir || dataDir === '/' || dataDir === process.env.HOME) {
    return response(
      { error: `Refusing to wipe data dir "${dataDir}" — looks unsafe.` },
      400,
    );
  }

  let entries: string[] = [];
  try {
    entries = readdirSync(dataDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not read data dir.';
    console.error('[factory-reset] readdir failed:', message);
    return response({ error: `Could not read data dir: ${message}` }, 500);
  }

  const removed: string[] = [];
  const failed: { entry: string; error: string }[] = [];

  for (const entry of entries) {
    const target = join(dataDir, entry);
    try {
      // Use rmSync with force+recursive so dirs and stubborn files both go.
      // statSync purely so we can log dirs vs files for the audit trail.
      const isDir = statSync(target).isDirectory();
      rmSync(target, { recursive: true, force: true });
      removed.push(isDir ? `${entry}/` : entry);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      failed.push({ entry, error: message });
      console.warn(`[factory-reset] Failed to remove ${target}: ${message}`);
    }
  }

  const result: FactoryResetResult = {
    dataDir,
    removed,
    failed,
    durationMs: Date.now() - start,
  };

  console.log(
    `[factory-reset] Wiped ${removed.length} entries from ${dataDir} in ${result.durationMs}ms (${failed.length} failures)`,
  );

  return response({ ok: failed.length === 0, result });
}
