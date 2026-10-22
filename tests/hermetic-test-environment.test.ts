import { afterEach, describe, expect, it, vi } from 'vitest';

const credentialNames = ['O8_WORKER_TOKEN', 'O8_API_TOKEN', 'O8_SPECTATOR_TOKEN'] as const;

afterEach(() => vi.unstubAllEnvs());

describe('test entry environment', () => {
  it('starts test workers without ambient o8 credentials', () => {
    for (const name of credentialNames) expect(process.env[name]).toBeUndefined();
  });

  it('selects test behavior even when the caller runs in development mode', () => {
    expect(process.env.NODE_ENV).toBe('test');
  });

  it('allows tests to opt into synthetic credentials explicitly', () => {
    vi.stubEnv('O8_WORKER_TOKEN', 'synthetic-test-worker');
    expect(process.env.O8_WORKER_TOKEN).toBe('synthetic-test-worker');
  });

  it('normalizes a polluted caller at the shared config boundary without dropping harness settings', async () => {
    for (const name of credentialNames) vi.stubEnv(name, `synthetic-${name}`);
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('O8_TEST_GATE_MARKER', 'synthetic-gate-marker');
    const originalPath = process.env.PATH;
    vi.resetModules();

    await import('../config/vitest/vitest.shared');

    for (const name of credentialNames) expect(process.env[name]).toBeUndefined();
    expect(process.env.NODE_ENV).toBe('test');
    expect(process.env.O8_TEST_GATE_MARKER).toBe('synthetic-gate-marker');
    expect(process.env.PATH).toBe(originalPath);
  });
});
