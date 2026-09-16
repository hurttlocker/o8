/**
 * #2404. The flag reads an environment variable nothing in the repo sets, so
 * whatever it returns with the variable absent is what every desktop does.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { mobileE2eeEnabled } from './e2ee-flag';

const original = process.env.O8_MOBILE_E2EE;

afterEach(() => {
  if (original === undefined) delete process.env.O8_MOBILE_E2EE;
  else process.env.O8_MOBILE_E2EE = original;
});

describe('mobileE2eeEnabled', () => {
  it('is on when nothing sets the variable', () => {
    delete process.env.O8_MOBILE_E2EE;
    expect(mobileE2eeEnabled()).toBe(true);
  });

  it('treats an empty value as unset rather than as off', () => {
    process.env.O8_MOBILE_E2EE = '   ';
    expect(mobileE2eeEnabled()).toBe(true);
  });

  for (const value of ['0', 'false', 'off', 'no', 'OFF', 'False']) {
    it(`opts out on ${value}`, () => {
      process.env.O8_MOBILE_E2EE = value;
      expect(mobileE2eeEnabled()).toBe(false);
    });
  }

  for (const value of ['1', 'true', 'on', 'yes']) {
    it(`stays on for the old opt-in value ${value}`, () => {
      process.env.O8_MOBILE_E2EE = value;
      expect(mobileE2eeEnabled()).toBe(true);
    });
  }
});
