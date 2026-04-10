import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { installClaudeCodePreToolHook } from '@/lib/hooks/install-hooks';
import type { SetupConfig } from '@/lib/setup/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CONFIG_DIR = join(homedir(), '.cortex-ide');
const CONFIG_PATH = join(CONFIG_DIR, 'setup.json');

function getDefaultConfig(): SetupConfig {
  return {
    setupComplete: false,
    cortex: {
      binaryPath: join(homedir(), 'bin', 'cortex'),
      detected: false,
    },
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
  return {
    ...current,
    ...patch,
    cortex: patch.cortex ? {
      ...current.cortex,
      ...patch.cortex,
    } : current.cortex,
    skippedSteps: patch.skippedSteps ?? current.skippedSteps,
    warmState: patch.warmState ? {
      ...current.warmState,
      ...patch.warmState,
      repos: patch.warmState.repos ?? current.warmState?.repos,
      runtimes: patch.warmState.runtimes ?? current.warmState?.runtimes,
      profile: patch.warmState.profile ?? current.warmState?.profile ?? null,
    } : current.warmState,
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

  writeConfig(updated);

  if (updated.setupComplete || updated.completedAt) {
    try {
      installClaudeCodePreToolHook(process.env.CORTEX_IDE_REPO_ROOT || process.cwd());
    } catch {
      // Hook installation is best-effort during onboarding.
    }
  }

  return NextResponse.json({ success: true, config: updated });
}
