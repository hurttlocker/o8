import { describe, expect, it } from 'vitest';

import { parseLeaseTtlMs, resolveLeaseOwnerPid } from './lease';

describe('lease CLI TTL parsing', () => {
  it('accepts explicit duration suffixes and bare milliseconds', () => {
    expect(parseLeaseTtlMs('1500')).toBe(1_500);
    expect(parseLeaseTtlMs('30s')).toBe(30_000);
    expect(parseLeaseTtlMs('5m')).toBe(300_000);
    expect(parseLeaseTtlMs('2h')).toBe(7_200_000);
  });

  it('rejects ambiguous or unsafe durations', () => {
    expect(() => parseLeaseTtlMs('1')).toThrow(/1 second through 24 hours/);
    expect(() => parseLeaseTtlMs('forever')).toThrow(/must use ms, s, m, or h/);
    expect(() => parseLeaseTtlMs('25h')).toThrow(/1 second through 24 hours/);
  });
});

describe('lease CLI owner process', () => {
  it('uses the immediate parent for an ordinary interactive shell', () => {
    expect(resolveLeaseOwnerPid({
      ppid: 200,
      env: {},
      readProcess: () => ({ pid: 200, ppid: 100, command: '/bin/zsh' }),
    })).toBe(200);
  });

  it('walks transient command parents to the stable agent session process', () => {
    const rows = new Map([
      [300, { pid: 300, ppid: 200, command: '/bin/sh -lc o8 lease acquire resource' }],
      [200, { pid: 200, ppid: 100, command: '/usr/local/bin/node agent-runtime.js' }],
    ]);
    expect(resolveLeaseOwnerPid({
      ppid: 300,
      env: { O8_WORKER_PACKET_ID: 'packet-owner' },
      readProcess: (pid) => rows.get(pid) ?? null,
    })).toBe(200);
  });

  it('recognizes an explicit command shell without provider-specific environment', () => {
    const rows = new Map([
      [300, { pid: 300, ppid: 200, command: '/bin/sh -lc o8 lease acquire resource' }],
      [200, { pid: 200, ppid: 100, command: '/usr/local/bin/agent-runtime' }],
    ]);
    expect(resolveLeaseOwnerPid({
      ppid: 300,
      env: {},
      readProcess: (pid) => rows.get(pid) ?? null,
    })).toBe(200);
  });

  it('fails closed when agent-session ancestry cannot be read', () => {
    expect(resolveLeaseOwnerPid({
      ppid: 300,
      env: { O8_WORKER_PACKET_ID: 'packet-owner' },
      readProcess: () => null,
    })).toBeNull();
  });
});
