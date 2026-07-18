'use client';

import { useCallback, useState } from 'react';

interface NoGitRepoErrorCureProps {
  repoPath: string;
}

type InitState = 'idle' | 'initializing' | 'initialized';

export function NoGitRepoErrorCure({ repoPath }: NoGitRepoErrorCureProps) {
  const [state, setState] = useState<InitState>('idle');
  const [errorText, setErrorText] = useState<string | null>(null);

  const handleInitialize = useCallback(async () => {
    if (state === 'initializing') return;
    setState('initializing');
    setErrorText(null);
    try {
      const response = await fetch('/api/panel/repos/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: repoPath }),
      });
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.error?.trim() || `Git initialization failed (HTTP ${response.status}).`);
      }
      setState('initialized');
    } catch (error) {
      setState('idle');
      setErrorText(error instanceof Error ? error.message : 'Git initialization failed.');
    }
  }, [repoPath, state]);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-start',
      gap: 6,
      marginTop: 10,
      paddingTop: 10,
      borderTop: '1px solid var(--t-divider-subtle)',
    }}>
      {state === 'initialized' ? (
        <span
          role="status"
          style={{
            color: 'var(--t-text-muted)',
            fontSize: 12,
            fontWeight: 450,
            lineHeight: 1.4,
          }}
        >
          Git initialized — send your message again.
        </span>
      ) : (
        <button
          type="button"
          onClick={handleInitialize}
          disabled={state === 'initializing'}
          aria-busy={state === 'initializing'}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: 44,
            paddingTop: 0,
            paddingRight: 14,
            paddingBottom: 0,
            paddingLeft: 14,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-divider)',
            borderRadius: 10,
            background: 'transparent',
            color: state === 'initializing' ? 'var(--t-text-faint)' : 'var(--t-text-secondary)',
            cursor: state === 'initializing' ? 'wait' : 'pointer',
            fontFamily: 'var(--font-sans-system)',
            fontSize: 12,
            fontWeight: 550,
            letterSpacing: '-0.005em',
            transition: 'background-color 140ms cubic-bezier(0.22, 1, 0.36, 1), color 140ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
          onMouseEnter={(event) => {
            if (state !== 'initializing') event.currentTarget.style.background = 'var(--t-hover)';
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.background = 'transparent';
          }}
        >
          {state === 'initializing' ? 'Initializing…' : 'Initialize Git here'}
        </button>
      )}
      {errorText ? (
        <span
          role="alert"
          style={{
            color: 'var(--t-danger)',
            fontSize: 11.5,
            fontWeight: 400,
            lineHeight: 1.4,
          }}
        >
          {errorText}
        </span>
      ) : null}
    </div>
  );
}
