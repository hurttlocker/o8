'use client';

import { useEffect, useMemo, useState } from 'react';
import type { AmbientSelectedFile } from '../useAmbientMode';

const MONO = 'var(--font-mono, "SF Mono", Menlo, monospace)';

interface DiffResponse {
  diff?: string;
  hasDiff?: boolean;
  error?: string;
}

interface DiffState {
  key: string;
  loading: boolean;
  error: string | null;
  diff: string;
}

export function DiffMode({ selectedFile }: { selectedFile: AmbientSelectedFile | null }) {
  const selectedKey = selectedFile ? `${selectedFile.repoPath}\n${selectedFile.filePath}` : '';
  const [state, setState] = useState<DiffState>({
    key: '',
    loading: false,
    error: null,
    diff: '',
  });

  useEffect(() => {
    if (!selectedFile) return;
    let cancelled = false;
    const params = new URLSearchParams({
      workspace: selectedFile.repoPath,
      path: selectedFile.filePath,
    });
    const timer = window.setTimeout(() => {
      setState({ key: selectedKey, loading: true, error: null, diff: '' });
      fetch(`/api/panel/file-diff?${params.toString()}`, { credentials: 'same-origin' })
        .then(async (response) => {
          const payload = await response.json().catch(() => null) as DiffResponse | null;
          if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
          return payload ?? {};
        })
        .then((payload) => {
          if (cancelled) return;
          setState({ key: selectedKey, loading: false, error: null, diff: payload.diff ?? '' });
        })
        .catch((err) => {
          if (cancelled) return;
          setState({
            key: selectedKey,
            loading: false,
            error: err instanceof Error ? err.message : 'Unable to load file diff.',
            diff: '',
          });
        });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [selectedFile, selectedKey]);

  const activeState = state.key === selectedKey
    ? state
    : { key: selectedKey, loading: selectedFile !== null, error: null, diff: '' };
  const lines = useMemo(() => activeState.diff.split(/\r?\n/), [activeState.diff]);

  if (!selectedFile) {
    return <DiffEmpty text="[DIFF] · select a file in the focus drawer Files tab" />;
  }

  if (activeState.loading && !activeState.diff) {
    return <DiffEmpty text="[DIFF] · loading unified diff" />;
  }

  if (activeState.error) {
    return <DiffEmpty text={`[DIFF] · ${activeState.error}`} />;
  }

  if (!activeState.diff.trim()) {
    return <DiffEmpty text="[DIFF] · no HEAD diff for selected file" />;
  }

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--t-canvas-bg)',
        color: 'var(--t-chat-surface-text)',
        overflow: 'hidden',
      }}
    >
      <div
        title={selectedFile.filePath}
        style={{
          flexShrink: 0,
          paddingTop: 8,
          paddingRight: 10,
          paddingBottom: 8,
          paddingLeft: 10,
          borderBottomWidth: 1,
          borderBottomStyle: 'solid',
          borderBottomColor: 'var(--t-divider-subtle)',
          color: 'var(--t-chat-surface-text-secondary)',
          fontFamily: MONO,
          fontSize: 11,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {selectedFile.filePath}
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          paddingTop: 8,
          paddingRight: 0,
          paddingBottom: 12,
          paddingLeft: 0,
          fontFamily: MONO,
          fontSize: 11,
          lineHeight: 1.55,
          letterSpacing: 0,
        }}
      >
        {lines.map((line, index) => (
          <DiffLine key={`${index}:${line}`} line={line} />
        ))}
      </div>
    </div>
  );
}

function DiffEmpty({ text }: { text: string }) {
  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        paddingTop: 24,
        paddingRight: 16,
        paddingBottom: 24,
        paddingLeft: 16,
        color: 'var(--t-text-muted)',
        fontSize: 12,
        letterSpacing: '-0.01em',
        textAlign: 'center',
      }}
    >
      {text}
    </div>
  );
}

function DiffLine({ line }: { line: string }) {
  const isHunk = line.startsWith('@@');
  const isAdd = line.startsWith('+') && !line.startsWith('+++');
  const isDelete = line.startsWith('-') && !line.startsWith('---');
  const color = isAdd
    ? 'var(--t-terminal-ansi-green, #16a34a)'
    : isDelete
      ? 'var(--t-brand-red, #ef4444)'
      : isHunk
        ? 'var(--t-brand-orange, #FF5A1F)'
        : 'var(--t-chat-surface-text-secondary)';
  const background = isAdd
    ? 'color-mix(in srgb, var(--t-terminal-ansi-green, #16a34a) 12%, transparent)'
    : isDelete
      ? 'color-mix(in srgb, var(--t-brand-red, #ef4444) 10%, transparent)'
      : isHunk
        ? 'color-mix(in srgb, var(--t-brand-orange, #FF5A1F) 9%, transparent)'
        : 'transparent';

  return (
    <div
      style={{
        minHeight: 17,
        paddingTop: 0,
        paddingRight: 10,
        paddingBottom: 0,
        paddingLeft: 10,
        whiteSpace: 'pre',
        color,
        background,
      }}
    >
      {line || ' '}
    </div>
  );
}
