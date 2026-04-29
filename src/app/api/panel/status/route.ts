import { NextResponse } from 'next/server';
import { ensureCodebaseMemoryBootIndex } from '@/lib/codebase-memory/indexer';
import { ensureDecayBootHook } from '@/lib/cortex/decay';
import { ensureProposerBootTick } from '@/lib/cortex/proposer';
import { ensureStackSignatureBoot } from '@/lib/cortex/stack-signature';
import { ensureCrossRepoProposerBootTick } from '@/lib/cortex/cross-repo-proposer';

export async function GET() {
  // Tauri shell hits /api/panel/status as a liveness probe right after the
  // bundled Node sidecar boots. Piggyback on that to kick the
  // codebase-memory boot index pass (closes #741). Idempotent — fires once
  // per server process. Runs in the background, never blocks the response.
  ensureCodebaseMemoryBootIndex();
  // #745 — Temporal validity windows. Same idempotent pattern: first call
  // fires an immediate decay sweep on a microtask and schedules a 6h tick.
  ensureDecayBootHook();
  // #746 — Auto-directive proposer tick. Same pattern: idempotent boot hook,
  // self-schedules every 30 min, never blocks the liveness probe.
  ensureProposerBootTick();
  // #748 — Cross-repo learning. First call seeds the stack-signature cache,
  // then the proposer tick fans out matching directives across registered
  // repos every 30 min. Both boot hooks are idempotent + microtask-driven.
  ensureStackSignatureBoot();
  ensureCrossRepoProposerBootTick();

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
