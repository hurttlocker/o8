export const REVIEW_THREAD_STORAGE_VERSION = 1;

export const REVIEW_THREAD_CLIENT_RETRY_DELAYS_MS = [250, 700];

export const prStateStyles: Record<string, { color: string; label: string; bg: string }> = {
  OPEN: { color: '#22c55e', label: 'Open', bg: 'rgba(34,197,94,0.08)' },
  MERGED: { color: '#8b5cf6', label: 'Merged', bg: 'rgba(139,92,246,0.08)' },
  CLOSED: { color: '#ef4444', label: 'Closed', bg: 'rgba(239,68,68,0.08)' },
};
