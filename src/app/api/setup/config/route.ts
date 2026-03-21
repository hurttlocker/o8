import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SetupConfig {
  setupComplete: boolean;
  gateway?: {
    url: string;
    token: string;
    autoConnect: boolean;
  };
  cortex?: {
    binaryPath: string;
    detected: boolean;
  };
  completedAt?: string;
  skippedSteps?: string[];
}

const CONFIG_DIR = join(homedir(), '.cortex-ide');
const CONFIG_PATH = join(CONFIG_DIR, 'setup.json');

function getDefaultConfig(): SetupConfig {
  return {
    setupComplete: false,
    gateway: {
      url: 'http://127.0.0.1:18789',
      token: '',
      autoConnect: false,
    },
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
  const updated: SetupConfig = {
    ...current,
    ...body,
  };

  writeConfig(updated);
  return NextResponse.json({ success: true, config: updated });
}
