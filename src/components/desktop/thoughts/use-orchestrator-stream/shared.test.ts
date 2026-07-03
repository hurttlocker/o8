import { describe, it, expect } from 'vitest';
import { scoreTelemetryPath } from './shared';

describe('scoreTelemetryPath', () => {
  it('scores an exact match highest', () => {
    expect(scoreTelemetryPath('/Users/marquisehurtt/o8', '/Users/marquisehurtt/o8')).toBe(4);
  });

  it('scores a suffix overlap below an exact match', () => {
    expect(scoreTelemetryPath('marquisehurtt/o8', '/Users/marquisehurtt/o8')).toBe(3);
  });

  it('scores a basename-only match below a suffix overlap', () => {
    expect(scoreTelemetryPath('/tmp/work/o8', '/Users/marquisehurtt/o8')).toBe(1);
  });

  it('scores unrelated paths as no match', () => {
    expect(scoreTelemetryPath('/tmp/work/o8-mobile', '/Users/marquisehurtt/o8')).toBe(0);
  });
});
