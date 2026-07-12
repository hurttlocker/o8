import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pathWithNodeRuntime } from './node-on-path';

const nodeDir = path.dirname(process.execPath);

describe('pathWithNodeRuntime', () => {
  it('prepends the running node runtime dir when absent', () => {
    const result = pathWithNodeRuntime('/usr/bin:/bin');
    expect(result.split(path.delimiter)[0]).toBe(nodeDir);
    expect(result).toContain('/usr/bin');
  });

  it('is idempotent when the dir is already present', () => {
    const base = [nodeDir, '/usr/bin'].join(path.delimiter);
    expect(pathWithNodeRuntime(base)).toBe(base);
  });

  it('handles an empty base PATH', () => {
    expect(pathWithNodeRuntime('')).toBe(nodeDir);
  });
});
