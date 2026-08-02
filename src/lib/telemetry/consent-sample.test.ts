import { describe, expect, it } from 'vitest';

import { buildScrubbedCrashSample } from './consent-sample';

describe('first-run crash disclosure sample', () => {
  it('is produced by the real scrubber and shows exactly what survives it', () => {
    const sample = buildScrubbedCrashSample();

    expect(sample).toMatchObject({
      message: 'TypeError: lane state was unavailable at /Users/…/private-repo/src/app.tsx',
      request: { url: 'http://127.0.0.1:47120/api/lane/resume' },
      breadcrumbs: [{ message: 'clicked resume', data: { count: 1 } }],
      extra: { surface: 'orchestrator' },
    });
    expect(sample.user).toBeUndefined();
    expect(sample.server_name).toBeUndefined();
    expect(sample.request?.headers).toBeUndefined();
    expect(sample.request?.cookies).toBeUndefined();
    expect(sample.request?.data).toBeUndefined();
  });
});
