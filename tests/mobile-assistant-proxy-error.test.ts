import { describe, expect, it } from 'vitest';
import { readMobileProxyError } from '@/app/mobile/mobile-assistant-chat-model';

describe('mobile Assistant proxy errors', () => {
  it('surfaces the runtime route explanation instead of an API-key catch-all', async () => {
    const response = Response.json(
      {
        error: 'Codex is not installed. Install Codex CLI, then try again.',
        code: 'runtime_not_installed',
      },
      { status: 503 },
    );

    await expect(readMobileProxyError(response)).resolves.toBe(
      'Codex is not installed. Install Codex CLI, then try again.',
    );
  });
});
