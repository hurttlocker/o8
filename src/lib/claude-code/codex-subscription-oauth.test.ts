import { describe, expect, it } from 'vitest';

import { browserOpenInvocation, findLatestCodexOAuthUrl } from './codex-subscription-oauth';

describe('Codex subscription OAuth handoff', () => {
  it('extracts only the latest canonical OpenAI authorization URL', () => {
    const first = 'https://auth.openai.com/oauth/authorize?state=old';
    const latest = 'https://auth.openai.com/oauth/authorize?state=new&code_challenge=proof';
    expect(findLatestCodexOAuthUrl(`old ${first}\nVisit the following URL:\n${latest}\n`)).toBe(latest);
    expect(findLatestCodexOAuthUrl('https://example.com/oauth/authorize?state=wrong')).toBeNull();
  });

  it('opens the validated URL without a shell on supported desktop platforms', () => {
    const url = 'https://auth.openai.com/oauth/authorize?state=test';
    expect(browserOpenInvocation(url, 'darwin')).toEqual({ command: 'open', args: [url] });
    expect(browserOpenInvocation(url, 'win32')).toEqual({
      command: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', url],
    });
    expect(browserOpenInvocation(url, 'linux')).toEqual({ command: 'xdg-open', args: [url] });
  });
});
