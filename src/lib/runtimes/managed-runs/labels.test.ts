import { describe, expect, it } from 'vitest';
import { deriveManagedRunLabel } from './labels';

describe('deriveManagedRunLabel', () => {
  it('prefers a declared title', () => {
    expect(deriveManagedRunLabel({
      title: 'Side stack for operator review',
      command: 'sh -c PORT=3998 npm run desktop:dev:side',
    })).toBe('Side stack for operator review');
  });

  it('summarizes side-stack dev commands with their port', () => {
    expect(deriveManagedRunLabel({
      command: 'sh -c "PORT=3998 O8_API_PORT=3998 O8_WS_PORT=3999 npm run desktop:dev:side"',
    })).toBe('dev side-stack :3998');
  });

  it('summarizes known checks instead of showing raw commands', () => {
    expect(deriveManagedRunLabel({ command: 'npm test' })).toBe('tests');
    expect(deriveManagedRunLabel({ command: 'npx tsc --noEmit' })).toBe('typecheck');
  });

  it('falls back to a compact raw command for unknown commands', () => {
    expect(deriveManagedRunLabel({
      command: 'node scripts/really-long-command-name-with-many-flags --alpha --beta --gamma',
    })).toBe('node scripts/really-long-command-name-with…');
  });
});
