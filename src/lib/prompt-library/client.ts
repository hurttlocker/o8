'use client';

export type PromptLibraryScope = 'global' | 'repo';
export type PromptLibraryScopeFilter = 'available' | 'global' | 'repo' | 'all';

export const OPEN_PROMPT_LIBRARY_EVENT = 'o8:prompt-library:open';
export const SAVE_PROMPT_LIBRARY_EVENT = 'o8:prompt-library:save';

export interface PromptLibraryEntry {
  id: string;
  title: string;
  body: string;
  tags: string[];
  scope: PromptLibraryScope;
  repoPath: string | null;
  sourceKind: 'manual' | 'automation' | 'watched_agent';
  sourceId: string | null;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  useCount: number;
}

export interface PromptLibraryImportSource {
  key: string;
  sourceKind: 'automation' | 'watched_agent';
  sourceId: string;
  title: string;
  preview: string;
  repoPath: string;
}

interface PromptLibraryErrorPayload {
  error?: { message?: string };
}

async function readResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as (T & PromptLibraryErrorPayload) | null;
  if (!response.ok || !payload) {
    throw new Error(payload?.error?.message ?? 'The prompt library request failed.');
  }
  return payload;
}

export async function listSavedPrompts(input: {
  query?: string;
  repoPath?: string | null;
  scope?: PromptLibraryScopeFilter;
  signal?: AbortSignal;
} = {}): Promise<PromptLibraryEntry[]> {
  const params = new URLSearchParams();
  if (input.query?.trim()) params.set('query', input.query.trim());
  if (input.repoPath?.trim()) params.set('repoPath', input.repoPath.trim());
  params.set('scope', input.scope ?? 'available');
  params.set('limit', '100');
  const payload = await readResponse<{ prompts: PromptLibraryEntry[] }>(await fetch(
    `/api/prompt-library?${params.toString()}`,
    { signal: input.signal },
  ));
  return payload.prompts;
}

export async function createSavedPrompt(input: {
  title: string;
  body: string;
  tags: string[];
  scope: PromptLibraryScope;
  repoPath: string | null;
}): Promise<{ prompt: PromptLibraryEntry; created: boolean }> {
  return readResponse(await fetch('/api/prompt-library', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }));
}

export async function updateSavedPrompt(
  id: string,
  input: { title: string; body: string; tags: string[]; scope: PromptLibraryScope; repoPath: string | null },
): Promise<PromptLibraryEntry> {
  const payload = await readResponse<{ prompt: PromptLibraryEntry }>(await fetch(
    `/api/prompt-library/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  ));
  return payload.prompt;
}

export async function deleteSavedPrompt(id: string): Promise<void> {
  await readResponse(await fetch(`/api/prompt-library/${encodeURIComponent(id)}`, { method: 'DELETE' }));
}

export async function recordSavedPromptUse(id: string): Promise<void> {
  await readResponse(await fetch(`/api/prompt-library/${encodeURIComponent(id)}/use`, { method: 'POST' }));
}

export async function listPromptImportSources(
  repoPath: string | null,
  signal?: AbortSignal,
): Promise<PromptLibraryImportSource[]> {
  const params = new URLSearchParams();
  if (repoPath?.trim()) params.set('repoPath', repoPath.trim());
  const payload = await readResponse<{ sources: PromptLibraryImportSource[] }>(await fetch(
    `/api/prompt-library/import?${params.toString()}`,
    { signal },
  ));
  return payload.sources;
}

export async function importSavedPromptSources(
  sources: PromptLibraryImportSource[],
  repoPath: string | null,
): Promise<{ entries: PromptLibraryEntry[]; created: number; skipped: number }> {
  return readResponse(await fetch('/api/prompt-library/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sources: sources.map(({ sourceKind, sourceId }) => ({ sourceKind, sourceId })),
      repoPath,
    }),
  }));
}

export function derivePromptTitle(body: string): string {
  const firstLine = body.split('\n').map((line) => line.trim()).find(Boolean) ?? 'Saved prompt';
  return firstLine.length <= 72 ? firstLine : `${firstLine.slice(0, 69).trimEnd()}...`;
}

export function insertPromptIntoActiveComposer(body: string): boolean {
  if (typeof document === 'undefined') return false;
  const composer = document.querySelector<HTMLTextAreaElement>('textarea[data-o8-active-composer="true"]');
  if (!composer) return false;

  const start = composer.selectionStart ?? composer.value.length;
  const end = composer.selectionEnd ?? start;
  const nextValue = `${composer.value.slice(0, start)}${body}${composer.value.slice(end)}`;
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (valueSetter) valueSetter.call(composer, nextValue);
  else composer.value = nextValue;
  const inputEvent = typeof InputEvent === 'function'
    ? new InputEvent('input', { bubbles: true, inputType: 'insertText', data: body })
    : new Event('input', { bubbles: true });
  composer.dispatchEvent(inputEvent);
  const cursor = start + body.length;
  window.requestAnimationFrame(() => {
    composer.focus();
    composer.setSelectionRange(cursor, cursor);
  });
  return true;
}

export async function copyPromptText(body: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(body);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = body;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}
