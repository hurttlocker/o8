import { describe, expect, it } from 'vitest';
import { DEFAULT_SYMON_MACHINE, parseSymonMachineIdentity, SYMON_MACHINES } from './machine-registry';

describe('local machine display identity', () => {
  it('uses a neutral local name without changing the machine id or named remote', () => {
    expect(DEFAULT_SYMON_MACHINE).toEqual({ id: 'local', displayName: 'This computer' });
    expect(SYMON_MACHINES).toEqual([
      { id: 'local', displayName: 'This computer' },
      { id: 'macbook', displayName: 'MacBook' },
    ]);
  });

  it.each(['This computer', 'This Mac'])('normalizes the local label %s to the same canonical identity', (displayName) => {
    expect(parseSymonMachineIdentity({ id: 'local', displayName })).toBe(DEFAULT_SYMON_MACHINE);
    expect(parseSymonMachineIdentity({ id: 'local', displayName })?.displayName).toBe('This computer');
  });

  it('preserves the explicitly named remote identity', () => {
    expect(parseSymonMachineIdentity({ id: 'macbook', displayName: 'MacBook' })).toBe(SYMON_MACHINES[1]);
  });

  it.each([
    null, [], 'local', {},
    { id: 'local', displayName: 'MacBook' },
    { id: 'local', displayName: 'arbitrary' },
    { id: 'macbook', displayName: 'This Mac' },
    { id: 'macbook', displayName: 'This computer' },
    { id: 'unknown', displayName: 'This Mac' },
  ])('rejects malformed or mismatched identities: %j', (value) => {
    expect(parseSymonMachineIdentity(value)).toBeNull();
  });
});
