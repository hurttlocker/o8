export interface DesktopAuthError {
  id: number;
  message: string;
}

let currentError: DesktopAuthError | null = null;
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function getDesktopAuthError(): DesktopAuthError | null {
  return currentError;
}

export function subscribeDesktopAuthError(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function reportDesktopAuthError(reason: string): DesktopAuthError {
  currentError = {
    id: nextId,
    message: reason.trim() || 'The sign-in callback failed.',
  };
  nextId += 1;
  emit();
  return currentError;
}

export function clearDesktopAuthError(): void {
  if (!currentError) return;
  currentError = null;
  emit();
}
