'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  deletePromptStash,
  popPromptStash,
  subscribePromptStash,
  type PromptStashEntry,
} from '@/lib/orchestrator/prompt-stash';

const PROMPT_PREVIEW_LENGTH = 40;

function promptPreview(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= PROMPT_PREVIEW_LENGTH) return normalized;
  return `${normalized.slice(0, PROMPT_PREVIEW_LENGTH - 1)}…`;
}

function relativeAge(createdAt: number, now: number): string {
  const ageSeconds = Math.max(0, Math.floor((now - createdAt) / 1000));
  if (ageSeconds < 60) return 'now';
  const ageMinutes = Math.floor(ageSeconds / 60);
  if (ageMinutes < 60) return `${ageMinutes}m ago`;
  const ageHours = Math.floor(ageMinutes / 60);
  if (ageHours < 24) return `${ageHours}h ago`;
  const ageDays = Math.floor(ageHours / 24);
  if (ageDays < 7) return `${ageDays}d ago`;
  const ageWeeks = Math.floor(ageDays / 7);
  if (ageWeeks < 5) return `${ageWeeks}w ago`;
  const ageMonths = Math.floor(ageDays / 30);
  if (ageMonths < 12) return `${ageMonths}mo ago`;
  return `${Math.floor(ageDays / 365)}y ago`;
}

function promptTooltip(entry: PromptStashEntry): string {
  return [
    entry.text,
    '',
    `Repo: ${entry.repoPath}`,
    `Thread: ${entry.threadId ?? 'New thread'}`,
    `Stashed: ${new Date(entry.createdAt).toLocaleString()}`,
  ].join('\n');
}

function PromptStashChip({
  entry,
  now,
  onRestore,
  onDelete,
}: {
  entry: PromptStashEntry;
  now: number;
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const active = hovered || focused;
  const preview = promptPreview(entry.text);

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        flexShrink: 0,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-divider-subtle)',
        borderRadius: 999,
        background: active ? 'var(--t-hover)' : 'transparent',
        color: 'var(--t-text-secondary)',
        fontFamily: 'var(--font-sans-system)',
        transition: 'background 120ms ease, color 120ms ease',
      }}
    >
      <button
        type="button"
        aria-label={`Restore stashed prompt: ${preview}`}
        title={promptTooltip(entry)}
        onClick={() => onRestore(entry.id)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 7,
          minWidth: 0,
          paddingTop: 6,
          paddingRight: 5,
          paddingBottom: 6,
          paddingLeft: 10,
          borderWidth: 0,
          background: 'transparent',
          color: 'inherit',
          cursor: 'pointer',
          fontFamily: 'var(--font-sans-system)',
          fontSize: 12,
          fontWeight: 300,
          letterSpacing: '-0.1px',
          lineHeight: 1.25,
        }}
      >
        <span style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {preview}
        </span>
        <span
          style={{
            flexShrink: 0,
            color: 'var(--t-text-faint)',
            fontSize: 10,
            fontWeight: 300,
            letterSpacing: '-0.1px',
          }}
        >
          {relativeAge(entry.createdAt, now)}
        </span>
      </button>
      <button
        type="button"
        aria-label={`Delete stashed prompt: ${preview}`}
        title="Delete stashed prompt"
        onClick={() => onDelete(entry.id)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 18,
          height: 18,
          marginRight: 4,
          paddingTop: 0,
          paddingRight: 0,
          paddingBottom: 0,
          paddingLeft: 0,
          borderWidth: 0,
          borderRadius: 999,
          background: 'transparent',
          color: 'var(--t-text-faint)',
          cursor: 'pointer',
          opacity: active ? 1 : 0,
          pointerEvents: active ? 'auto' : 'none',
          transition: 'opacity 120ms ease, color 120ms ease',
        }}
      >
        <svg
          width={10}
          height={10}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

export function PromptStashRow({ onRestore }: { onRestore: (text: string) => void }) {
  const [entries, setEntries] = useState<PromptStashEntry[]>([]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => subscribePromptStash(setEntries), []);
  useEffect(() => {
    if (entries.length === 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [entries.length]);

  const handleRestore = useCallback((id: string) => {
    const entry = popPromptStash(id);
    if (entry) onRestore(entry.text);
  }, [onRestore]);

  const handleDelete = useCallback((id: string) => {
    deletePromptStash(id);
  }, []);

  if (entries.length === 0) return null;

  return (
    <div
      aria-label="Prompt stash"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        minWidth: 0,
        paddingBottom: 8,
        overflowX: 'auto',
        overflowY: 'hidden',
        fontFamily: 'var(--font-sans-system)',
      }}
    >
      {entries.map((entry) => (
        <PromptStashChip
          key={entry.id}
          entry={entry}
          now={now}
          onRestore={handleRestore}
          onDelete={handleDelete}
        />
      ))}
    </div>
  );
}
