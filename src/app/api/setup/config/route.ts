import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { installClaudeCodePreToolHook } from '@/lib/hooks/install-hooks';
import { getDataDir } from '@/lib/data-dir-migration';
import type { SetupConfig } from '@/lib/setup/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CONFIG_DIR = getDataDir();
const CONFIG_PATH = join(CONFIG_DIR, 'setup.json');

function getDefaultConfig(): SetupConfig {
  return {
    setupComplete: false,
    skippedSteps: [],
  };
}

function readConfig(): SetupConfig {
  if (!existsSync(CONFIG_PATH)) {
    return getDefaultConfig();
  }

  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as SetupConfig;
  } catch {
    return getDefaultConfig();
  }
}

function writeConfig(config: SetupConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

function mergeConfig(current: SetupConfig, patch: Partial<SetupConfig>): SetupConfig {
  const { cortex: _legacyCurrentCortex, ...currentRest } = current as SetupConfig & { cortex?: unknown };
  const { cortex: _legacyPatchCortex, ...patchRest } = patch as Partial<SetupConfig> & { cortex?: unknown };
  void _legacyCurrentCortex;
  void _legacyPatchCortex;
  return {
    ...currentRest,
    ...patchRest,
    skippedSteps: patchRest.skippedSteps ?? currentRest.skippedSteps,
    warmState: patchRest.warmState ? {
      ...currentRest.warmState,
      ...patchRest.warmState,
      repos: patchRest.warmState.repos ?? currentRest.warmState?.repos,
      runtimes: patchRest.warmState.runtimes ?? currentRest.warmState?.runtimes,
      profile: patchRest.warmState.profile ?? currentRest.warmState?.profile ?? null,
    } : currentRest.warmState,
  };
}

export async function GET() {
  const config = readConfig();
  return NextResponse.json(config);
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const current = readConfig();
  const updated = mergeConfig(current, body as Partial<SetupConfig>);

  try {
    writeConfig(updated);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error writing setup config';
    return NextResponse.json(
      { ok: false, error: `Failed to persist setup config: ${message}` },
      { status: 500 },
    );
  }

  if (updated.setupComplete || updated.completedAt) {
    try {
      installClaudeCodePreToolHook(process.env.CORTEX_IDE_REPO_ROOT || process.cwd());
    } catch {
      // Hook installation is best-effort during onboarding.
    }
  }

  return NextResponse.json({ success: true, config: updated });
}
