import { describe, expect, it } from 'vitest';

import { getRuntimeInstallInfo } from './runtime-install';

describe('runtime install metadata', () => {
  it('routes missing 3code users to the official setup page', () => {
    expect(getRuntimeInstallInfo('3code')).toEqual({
      id: '3code',
      label: '3code CLI',
      link: 'https://3code.capocasa.dev/',
      hint: 'Install 3code, then run it once to configure a model provider.',
    });
  });
});
