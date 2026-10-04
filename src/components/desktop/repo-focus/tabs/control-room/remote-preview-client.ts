export interface RemotePreviewAccess {
  status?: 'queued' | 'starting';
  id?: string;
  url?: string;
  service?: string;
  serviceJobId?: string;
  expiresAt?: string;
}

/** Poll the same durable session; reconnect never silently replaces its deadline. */
export async function connectRemotePreview(input: {
  endpoint: string; jobId: string; attempt: number; serviceJobId?: string;
  signal: AbortSignal; onAccess: (access: RemotePreviewAccess) => void;
}): Promise<RemotePreviewAccess> {
  const deadline = Date.now() + 60_000;
  let serviceJobId = input.serviceJobId;
  while (!input.signal.aborted && Date.now() < deadline) {
    // Read responses even after cancellation: they may contain an allocated resource to close.
    const response = await fetch(input.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      cache: 'no-store', signal: AbortSignal.timeout(12_000), body: JSON.stringify({ jobId: input.jobId, attempt: input.attempt, serviceJobId }) });
    const body = await response.json() as RemotePreviewAccess & { error?: string };
    if (!response.ok) throw new Error(body.error || 'Remote preview is unavailable.');
    input.onAccess(body);
    if (input.signal.aborted) throw new Error('Preview closed.');
    if (response.status !== 202) {
      if (!body.id || !body.url) throw new Error('Remote preview returned no usable connection.');
      return body;
    }
    if (!body.serviceJobId) throw new Error('Remote service returned no session.');
    serviceJobId = body.serviceJobId;
    await new Promise<void>((resolve) => {
      const finish = () => { clearTimeout(timer); input.signal.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, 1_000);
      input.signal.addEventListener('abort', finish, { once: true });
    });
  }
  throw new Error(input.signal.aborted ? 'Preview closed.' : 'The review service did not become ready. Reconnect to try again.');
}
