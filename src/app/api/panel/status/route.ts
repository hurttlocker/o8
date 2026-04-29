import { NextResponse } from 'next/server';
import { ensureCodebaseMemoryBootIndex } from '@/lib/codebase-memory/indexer';

export async function GET() {
  // Tauri shell hits /api/panel/status as a liveness probe right after the
  // bundled Node sidecar boots. Piggyback on that to kick the
  // codebase-memory boot index pass (closes #741). Idempotent — fires once
  // per server process. Runs in the background, never blocks the response.
  ensureCodebaseMemoryBootIndex();

  return NextResponse.json({
    connected: false,
    gatewayUrl: null,
    version: null,
    platform: process.platform,
    nodeVersion: process.version,
    mode: 'local-cli',
    runtime: 'codex+claude-code',
  });
}
