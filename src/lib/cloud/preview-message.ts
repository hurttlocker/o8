/** Bound both streamed bytes and time before parsing an untrusted relay message. */
export async function readPreviewMessage(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  if (Number(request.headers.get('content-length')) > maxBytes) throw new Error('Preview message too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Preview message missing.');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const bytes = await Promise.race([
      (async () => {
        let length = 0;
        const parts: Buffer[] = [];
        while (true) {
          const result = await reader.read();
          if (result.done) return Buffer.concat(parts, length);
          length += result.value.byteLength;
          if (length > maxBytes) throw new Error('Preview message too large.');
          parts.push(Buffer.from(result.value));
        }
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Preview message timed out.')), 5_000); }),
    ]);
    const value = JSON.parse(bytes.toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid preview message.');
    return value as Record<string, unknown>;
  } finally { if (timer) clearTimeout(timer); void reader.cancel().catch(() => {}); }
}
