import type { CliUpdateStage } from '@/lib/setup/cli-update-progress';

export async function readCliUpdateResponse(response: Response, report: (stage: CliUpdateStage) => void): Promise<void> {
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    const result = await response.json() as { status?: string; error?: string };
    if (!response.ok || result.status !== 'succeeded') throw new Error(result.error ?? 'The update could not be verified.');
    return;
  }
  if (!response.ok || !response.body) throw new Error('The update could not start.');
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  let buffer = ''; let succeeded = false; let failure: string | null = null;
  const apply = (frame: string) => {
    const lines = frame.split('\n');
    const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    const result = JSON.parse(data) as { stage?: CliUpdateStage; status?: string; error?: string };
    if (event === 'error') failure = result.error ?? 'The update could not finish.';
    if (event === 'result') succeeded = result.status === 'succeeded';
    if (event === 'progress' && result.stage && ['checking', 'installing', 'verifying'].includes(result.stage)) report(result.stage);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replaceAll('\r\n', '\n');
      let end = buffer.indexOf('\n\n');
      while (end >= 0) { apply(buffer.slice(0, end)); buffer = buffer.slice(end + 2); end = buffer.indexOf('\n\n'); }
      if (done) { if (buffer.trim()) apply(buffer); break; }
    }
  } finally { reader.releaseLock(); }
  if (failure || !succeeded) throw new Error(failure ?? 'The update connection closed before verification. Check the installed version before retrying.');
}
