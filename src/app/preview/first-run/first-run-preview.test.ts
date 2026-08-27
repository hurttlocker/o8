import { afterEach, describe, expect, it, vi } from 'vitest';
import FirstRunPreviewPage from './page';
import {
  createConsentPreviewRequest,
  FirstRunPreview,
  previewOnboardingRequest,
} from './FirstRunPreview';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('first-run preview harness boundary', () => {
  it('serves onboarding fixtures without calling a real gated route', async () => {
    const status = await previewOnboardingRequest('/api/panel/github-status');
    await expect(status.json()).resolves.toEqual({
      authenticated: false,
      deviceFlowEnabled: false,
    });

    const runtimeScan = await previewOnboardingRequest('/api/setup/detect');
    await expect(runtimeScan.json()).resolves.toMatchObject({
      tools: [{ id: 'local-preview', detected: true, ready: true }],
    });
  });

  it('keeps consent errors inside the injected preview client', async () => {
    const request = createConsentPreviewRequest('error');
    const read = await request();
    await expect(read.json()).resolves.toMatchObject({
      values: { telemetryConsentAnswered: false },
    });

    const write = await request({ method: 'POST' });
    expect(write.status).toBe(500);
    await expect(write.json()).resolves.toEqual({
      error: 'Preview: choices could not be saved.',
    });
  });

  it('mounts the harness outside production and fails closed in production', () => {
    expect(FirstRunPreviewPage()).toMatchObject({ type: FirstRunPreview });
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => FirstRunPreviewPage()).toThrow();
  });
});
