/** Permission refusals must not block an installation's unrelated actions. */
export async function isSecondaryGitHubLimit(response: Response): Promise<boolean> {
  if (response.status !== 403 || response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0') return false;
  const reader = response.clone().body?.getReader(); if (!reader) return false;
  let text = ''; let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = async () => {
      while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 4096) return false; text += Buffer.from(value).toString('utf8'); }
      const payload = JSON.parse(text) as { message?: unknown };
      return typeof payload.message === 'string' && /rate limit|abuse detection/i.test(payload.message);
    };
    return await Promise.race([read(), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 1000); })]);
  } catch { return false; }
  finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
}
