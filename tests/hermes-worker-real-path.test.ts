import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = mkdtempSync(path.join(os.tmpdir(), 'o8-hermes-worker-real-'));
const userHome = path.join(root, 'user-home');
const workspace = path.join(userHome, 'repo');
const sessionsRoot = path.join(root, 'sessions');
const pidLog = path.join(root, 'pids.log');
const permissionLog = path.join(root, 'permissions.log');
const launchLog = path.join(root, 'launches.log');
const modelLog = path.join(root, 'models.log');
const executedModelLog = path.join(root, 'executed-models.log');
const fixture = path.join(process.cwd(), 'tests', 'fixtures', 'hermes-acp-runtime.mjs');
const wrapper = path.join(root, 'hermes');
const previousHome = process.env.HOME;

beforeAll(() => {
  mkdirSync(workspace, { recursive: true });
  mkdirSync(path.join(userHome, '.hermes'), { recursive: true });
  writeFileSync(path.join(userHome, '.hermes', 'config.yaml'), 'model: fixture\n', 'utf8');
  writeFileSync(path.join(userHome, '.hermes', '.env'), 'FIXTURE_TOKEN=1\n', 'utf8');
  writeFileSync(
    wrapper,
    `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`,
    { encoding: 'utf8', mode: 0o755 },
  );
  chmodSync(wrapper, 0o755);

  process.env.HOME = userHome;
  process.env.O8_DATA_DIR = path.join(root, 'data');
  process.env.O8_OWNED_HERMES_ROOT = sessionsRoot;
  process.env.O8_HERMES_BIN = wrapper;
  process.env.O8_HERMES_PID_LOG = pidLog;
  process.env.O8_HERMES_PERMISSION_LOG = permissionLog;
  process.env.O8_HERMES_LAUNCH_LOG = launchLog;
  process.env.O8_HERMES_MODEL_LOG = modelLog;
  process.env.O8_HERMES_EXECUTED_MODEL_LOG = executedModelLog;
});

afterAll(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  delete process.env.O8_DATA_DIR;
  delete process.env.O8_OWNED_HERMES_ROOT;
  delete process.env.O8_HERMES_BIN;
  delete process.env.O8_HERMES_PID_LOG;
  delete process.env.O8_HERMES_PERMISSION_LOG;
  delete process.env.O8_HERMES_LAUNCH_LOG;
  delete process.env.O8_HERMES_MODEL_LOG;
  delete process.env.O8_HERMES_EXECUTED_MODEL_LOG;
  rmSync(root, { recursive: true, force: true });
});

describe('Hermes worker production runtime seam', () => {
  it('refuses file-dependent subscription launch and leaves operator config untouched until #4340', async () => {
    const { hermesRuntime } = await import('@/lib/runtimes/hermes');
    const file = path.join(userHome, '.hermes', 'config.yaml');
    const before = readFileSync(file, 'utf8');
    const launched = await hermesRuntime.launch({ cwd: workspace, prompt: 'must not execute', packetId: 'packet-fixture', model: 'fixture/model' });
    expect(launched).toMatchObject({ ok: false, sideEffect: 'none' });
    expect(launched.note).toContain('#4340');
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(existsSync(pidLog)).toBe(false);
  });

  it.each([
    ['fixture/unavailable', '#4340'],
    ['fixture/unconfirmed', '#4340'],
  ])('does not submit a prompt when model %s is not confirmed', async (model, reason) => {
    const { hermesRuntime } = await import('@/lib/runtimes/hermes');
    const previousPrompts = existsSync(pidLog) ? readFileSync(pidLog, 'utf8') : '';
    const result = await hermesRuntime.launch({
      cwd: workspace, prompt: 'must not execute', model,
    });
    expect(result).toMatchObject({ ok: false, sideEffect: 'none' });
    expect(result.note).toContain(reason);
    expect(existsSync(pidLog) ? readFileSync(pidLog, 'utf8') : '').toBe(previousPrompts);
  });
});
