import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMasterKeyCache } from '@/lib/db/master-key';
import { nativeWorkerTokenEnv, readNativeWorkerToken, saveNativeWorkerToken } from './worker-token';
import { extractSetupWorkerToken } from './worker-token-output';

const token = `sk-ant-oat01-${'synthetic'.repeat(12)}`;
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'o8-worker-token-test-'));
  vi.stubEnv('CORTEX_IDE_DATA_DIR', directory);
  vi.stubEnv('O8_DATA_DIR', directory);
  vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 7).toString('base64url'));
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  clearMasterKeyCache();
});
afterEach(() => {
  clearMasterKeyCache();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe('dedicated worker credential boundary', () => {
  it('round-trips through encrypted private storage without changing the parent environment', async () => {
    await saveNativeWorkerToken(token);
    const filename = path.join(directory, 'native-worker-token.json');
    expect(readFileSync(filename, 'utf8')).not.toContain(token);
    expect(statSync(filename).mode & 0o777).toBe(0o600);
    expect(await readNativeWorkerToken()).toBe(token);
    expect(await nativeWorkerTokenEnv()).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: token });
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('');
  });

  it('fails closed for missing, corrupt, and wrong-key storage', async () => {
    expect(await readNativeWorkerToken()).toBeNull();
    writeFileSync(path.join(directory, 'native-worker-token.json'), 'broken');
    expect(await readNativeWorkerToken()).toBeNull();
    await saveNativeWorkerToken(token);
    clearMasterKeyCache();
    vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 8).toString('base64url'));
    expect(await readNativeWorkerToken()).toBeNull();
  });

  it.each(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'])('does not replace an explicit %s', async (key) => {
    await saveNativeWorkerToken(token);
    vi.stubEnv(key, 'explicit-synthetic');
    expect(await nativeWorkerTokenEnv()).toEqual({});
  });

  it('rejects a login refresh blob and incomplete setup output', async () => {
    await expect(saveNativeWorkerToken('{"refreshToken":"synthetic"}')).rejects.toThrow('Invalid worker token format');
    expect(extractSetupWorkerToken(`Long-lived authentication token created successfully!\n${token}`)).toBeNull();
    expect(extractSetupWorkerToken(`\x1b[32m${token}\x1b[0m\n`, true)).toBe(token);
    expect(extractSetupWorkerToken(`${token}\n${token}`, true)).toBe(token);
    expect(extractSetupWorkerToken(`${token}\n${token}other`, true)).toBeNull();
  });
});
