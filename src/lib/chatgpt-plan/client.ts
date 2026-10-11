'use client';

let tokenGetter: (() => Promise<string | null>) | null = null;
let binding: Promise<void> | null = null;

/** Shares the existing short-lived o8 identity, never OpenAI credentials. */
export function registerPlanAccountToken(getter: () => Promise<string | null>): () => void {
  tokenGetter = getter;
  binding = null;
  return () => { if (tokenGetter === getter) { tokenGetter = null; binding = null; } };
}

export async function planAccountHeaders(): Promise<Record<string, string>> {
  const getter = tokenGetter;
  const token = await getter?.();
  if (!token || getter !== tokenGetter) throw new Error('Sign in to o8 before using your ChatGPT plan.');
  if (!binding) {
    const attempt = (async () => {
      const response = await fetch('/api/panel/models/chatgpt', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-clerk-session-token': token }, body: JSON.stringify({ action: 'bind' }) });
      if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || 'The desktop account could not be connected.'); }
    })();
    binding = attempt;
    void attempt.catch(() => { if (getter === tokenGetter && binding === attempt) binding = null; });
  }
  await binding;
  if (getter !== tokenGetter) throw new Error('The o8 account changed while connecting.');
  return { 'x-clerk-session-token': token };
}

export async function planConnectionRequest(path = '', init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(`/api/panel/models/chatgpt${path}`, { ...init, headers: { ...await planAccountHeaders(), ...init?.headers }, cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'The ChatGPT connection could not be reached.');
  return data;
}
