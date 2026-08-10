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

  it('provides the official Magnitude npm install command', () => {
    expect(getRuntimeInstallInfo('magnitude')).toEqual({
      id: 'magnitude',
      label: 'Magnitude CLI',
      command: 'npm i -g @magnitudedev/cli',
      hint: 'On macOS or Linux, install Magnitude, then launch it in a visible repository terminal to choose a local model or custom endpoint.',
    });
  });
});
