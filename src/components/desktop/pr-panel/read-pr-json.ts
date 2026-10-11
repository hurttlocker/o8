/** A shared read can survive a tab switch, but must never pin Retry forever. */
export async function readPrJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  // Hot reload can compile this route on its first read; the installed app
  // has precompiled routes and keeps the shorter deadline.
  const timeout = setTimeout(() => controller.abort(), process.env.NODE_ENV === 'development' ? 60_000 : 25_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const data = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(data.error || 'Pull request could not be read. Retry.');
    return data;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Pull request read timed out. Retry.');
    if ((error as { name?: string } | null)?.name === 'AbortError') throw new Error('Pull request read was interrupted. Retry.');
    throw error;
  } finally { clearTimeout(timeout); }
}
