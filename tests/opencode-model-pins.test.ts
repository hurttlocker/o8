/**
 * Real-path coverage for the opencode model pins (#1729).
 *
 * The Settings pickers save each pin with a FIELD-LEVEL POST to
 * /api/panel/operator-defaults — and that exact path shipped broken: the pins
 * existed in the defaults model, the TOML layer, and the writer, but the
 * route's normalizeUpdate never forwarded the keys, so the UI's save 400'd
 * with "No supported fields in request body" while every pure-module test
 * stayed green. This suite drives the real route handler the way the UI does,
 * per the reachability rule: the mechanism is only proven through the entry
 * point real callers use.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const originalEnv = {
  HOME: process.env.HOME,
  CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR,
  O8_DATA_DIR: process.env.O8_DATA_DIR,
};

let home = '';
let dataDir = '';
let route: typeof import('@/app/api/panel/operator-defaults/route');
let defaults: typeof import('@/lib/operator/defaults');

function post(body: unknown): Request {
  return new Request('http://127.0.0.1/api/panel/operator-defaults', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  home = mkdtempSync(join(os.tmpdir(), 'o8-opencode-pins-'));
  dataDir = join(home, '.o8');
  mkdirSync(dataDir, { recursive: true });
  process.env.HOME = home;
  process.env.CORTEX_IDE_DATA_DIR = dataDir;
  process.env.O8_DATA_DIR = dataDir;

  route = await import('@/app/api/panel/operator-defaults/route');
  defaults = await import('@/lib/operator/defaults');
});

afterAll(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (home) rmSync(home, { recursive: true, force: true });
});

describe.sequential('opencode model pins — the real Settings save path', () => {
  it('sets the worker pin field-level, exactly as the Settings picker posts it', async () => {
    const response = await route.POST(post({ opencodeWorkerModel: 'openrouter/deepseek/deepseek-v4-flash' }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.values.opencodeWorkerModel).toBe('openrouter/deepseek/deepseek-v4-flash');
    // The dispatch ladder reads through this resolver (scheduling.ts).
    expect(defaults.resolveOpencodeWorkerModelSync()).toBe('openrouter/deepseek/deepseek-v4-flash');
  });

  it('sets the orchestrator pin the same way', async () => {
    const response = await route.POST(post({ opencodeOrchestratorModel: 'openrouter/qwen/qwen3-max' }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.values.opencodeOrchestratorModel).toBe('openrouter/qwen/qwen3-max');
  });

  it('clears a pin with null — the picker popover Clear action', async () => {
    await route.POST(post({ opencodeWorkerModel: 'openrouter/deepseek/deepseek-v4-flash' }));
    const response = await route.POST(post({ opencodeWorkerModel: null }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.values.opencodeWorkerModel).toBeNull();
    expect(defaults.resolveOpencodeWorkerModelSync()).toBeNull();
  });

  it('rejects an implausible id with the writer’s guidance, not a generic 400', async () => {
    const response = await route.POST(post({ opencodeWorkerModel: 'not a model id!!' }));
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(String(body.error)).toContain('opencodeWorkerModel');
    // The regression fingerprint: the field must never fall through to the
    // "no supported fields" branch again.
    expect(String(body.error)).not.toContain('No supported fields');
  });
});
