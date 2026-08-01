import { NextResponse } from 'next/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureCodebaseMemoryBootIndex } from '@/lib/codebase-memory/indexer';
import { ensureDecayBootHook } from '@/lib/cortex/decay';
import { ensureProposerBootTick } from '@/lib/cortex/proposer';
import { ensureStackSignatureBoot } from '@/lib/cortex/stack-signature';
import { ensureCrossRepoProposerBootTick } from '@/lib/cortex/cross-repo-proposer';
import { ensureExternalMergeBootHook } from '@/lib/cortex/external-merge-watcher';

// #926 / F40 follow-up: the CLI and other agents need a stable way to read
// the running server's version. sync-version.mjs keeps package.json#version
// in lockstep with Cargo.toml + tauri.conf.json, so reading it once at module
// load is authoritative. Cached so the liveness probe stays fast.
let cachedVersion: string | null = null;
function readServerVersion(): string | null {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const raw = readFileSync(join(process.cwd(), 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    cachedVersion = typeof parsed.version === 'string' ? parsed.version : '';
  } catch {
    cachedVersion = '';
  }
  return cachedVersion || null;
}

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
  // #841 — External merge ingestion. Most real merges happen outside o8
  // (gh CLI, GitHub web UI, teammate CLIs) and bypassed `appendDirectiveTrailer`
  // entirely. The watcher polls each registered repo's git log every 5 min,
  // appends trailers for new merges, and dedupes against internal-path
  // writes via the trailerLines.includes guard in directive-merges.ts.
  ensureExternalMergeBootHook();

  return NextResponse.json({
    product: 'o8',
    connected: false,
    gatewayUrl: null,
    version: readServerVersion(),
    platform: process.platform,
    nodeVersion: process.version,
    mode: 'local-cli',
    runtime: 'codex+claude-code',
  });
}
