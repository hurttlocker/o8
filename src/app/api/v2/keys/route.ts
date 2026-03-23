export const dynamic = 'force-dynamic';

/**
 * API Key Management (BYOK — Bring Your Own Key)
 *
 * GET  /api/v2/keys — list configured providers (keys masked)
 * POST /api/v2/keys — set/update a provider key
 * DELETE /api/v2/keys — remove a provider key
 *
 * Keys are stored in .env.local on the server side (self-hosted model).
 * For cloud, they'll go in the encrypted api_keys DB table.
 */

import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Config lives in ~/.cortex-ide/ so it survives app updates
const CONFIG_DIR = join(homedir(), '.cortex-ide');
const ENV_FILE = join(CONFIG_DIR, '.env.local');

// Also check project-local .env.local as fallback (dev mode)
const LOCAL_ENV = join(process.cwd(), '.env.local');

interface ProviderKeyConfig {
  id: string;
  label: string;
  envVar: string;
  placeholder: string;
  docsUrl: string;
}

const PROVIDERS: ProviderKeyConfig[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    envVar: 'ANTHROPIC_API_KEY',
    placeholder: 'sk-ant-...',
    docsUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    envVar: 'OPENAI_API_KEY',
    placeholder: 'sk-...',
    docsUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'google',
    label: 'Google AI',
    envVar: 'GOOGLE_AI_API_KEY',
    placeholder: 'AIza...',
    docsUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'github',
    label: 'GitHub',
    envVar: 'GH_TOKEN',
    placeholder: 'ghp_...',
    docsUrl: 'https://github.com/settings/tokens',
  },
];

function parseEnvFromPath(path: string): Map<string, string> {
  const vars = new Map<string, string>();
  if (!existsSync(path)) return vars;
  const content = readFileSync(path, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    vars.set(key, value);
  }
  return vars;
}

function parseEnvFile(): Map<string, string> {
  // Merge: project-local first, then ~/.cortex-ide/ overrides
  const local = parseEnvFromPath(LOCAL_ENV);
  const global = parseEnvFromPath(ENV_FILE);
  // Also check process.env for runtime-set values
  return new Map([...local, ...global]);
}

function writeEnvFile(vars: Map<string, string>) {
  // Ensure config dir exists
  mkdirSync(CONFIG_DIR, { recursive: true });
  // Read existing file to preserve comments and ordering
  let lines: string[] = [];
  if (existsSync(ENV_FILE)) {
    lines = readFileSync(ENV_FILE, 'utf-8').split('\n');
  }

  const written = new Set<string>();

  // Update existing lines
  const updated = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) return line;
    const key = trimmed.slice(0, eqIdx).trim();
    if (vars.has(key)) {
      written.add(key);
      return `${key}=${vars.get(key)}`;
    }
    return line;
  });

  // Append new vars
  for (const [key, value] of vars) {
    if (!written.has(key)) {
      updated.push(`${key}=${value}`);
    }
  }

  writeFileSync(ENV_FILE, updated.join('\n'));
}

function maskKey(key: string): string {
  if (key.length <= 8) return '••••••••';
  return key.slice(0, 4) + '••••' + key.slice(-4);
}

// GET — list providers with masked keys
export async function GET() {
  const envVars = parseEnvFile();
  // Also check process.env (may be set outside .env.local)
  const providers = PROVIDERS.map((p) => {
    const envValue = envVars.get(p.envVar) || process.env[p.envVar] || '';
    return {
      id: p.id,
      label: p.label,
      envVar: p.envVar,
      placeholder: p.placeholder,
      docsUrl: p.docsUrl,
      configured: !!envValue,
      maskedKey: envValue ? maskKey(envValue) : null,
    };
  });

  return NextResponse.json({ providers });
}

// POST — set/update a key
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body?.provider || !body?.key) {
    return NextResponse.json({ error: 'provider and key are required' }, { status: 400 });
  }

  const config = PROVIDERS.find((p) => p.id === body.provider);
  if (!config) {
    return NextResponse.json({ error: `Unknown provider: ${body.provider}` }, { status: 400 });
  }

  const key = body.key.trim();
  if (!key) {
    return NextResponse.json({ error: 'Key cannot be empty' }, { status: 400 });
  }

  // Write to .env.local
  const envVars = parseEnvFile();
  envVars.set(config.envVar, key);
  writeEnvFile(envVars);

  // Also set in process.env so it takes effect immediately (no restart needed)
  process.env[config.envVar] = key;

  return NextResponse.json({
    success: true,
    provider: config.id,
    maskedKey: maskKey(key),
  });
}

// DELETE — remove a key
export async function DELETE(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body?.provider) {
    return NextResponse.json({ error: 'provider is required' }, { status: 400 });
  }

  const config = PROVIDERS.find((p) => p.id === body.provider);
  if (!config) {
    return NextResponse.json({ error: `Unknown provider: ${body.provider}` }, { status: 400 });
  }

  // Remove from .env.local
  const envVars = parseEnvFile();
  envVars.delete(config.envVar);
  writeEnvFile(envVars);

  // Clear from process.env
  delete process.env[config.envVar];

  return NextResponse.json({ success: true, provider: config.id });
}
