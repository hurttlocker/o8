export async function interruptRuntimeSurface(surfaceId: string | null | undefined): Promise<void> {
  if (!surfaceId) return;
  try {
    const response = await fetch('/api/runtime/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'interrupt', surfaceId }),
    });
    if (!response.ok) {
      console.warn('[thoughts-chat] Failed to interrupt runtime steer target.');
    }
  } catch {
    console.warn('[thoughts-chat] Failed to interrupt runtime steer target.');
  }
}
