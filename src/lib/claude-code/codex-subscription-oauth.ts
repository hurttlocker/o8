export function findLatestCodexOAuthUrl(log: string): string | null {
  const matches = log.match(/https:\/\/auth\.openai\.com\/oauth\/authorize\?[^\s]+/g);
  const candidate = matches?.at(-1);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com' || url.pathname !== '/oauth/authorize') {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function browserOpenInvocation(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } | null {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') {
    return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] };
  }
  if (platform === 'linux') return { command: 'xdg-open', args: [url] };
  return null;
}
