'use client';

import { useCallback, useMemo, useState, type CSSProperties } from 'react';
import {
  APP_FONT_STACK,
  MONO_FONT_STACK,
  RAMS_ACCENT,
  RAMS_INK_QUIET,
  CornerBrackets,
  RamsButton,
  SectionLabel,
} from './shared';

type ReportCategory = 'bug' | 'request';
type ReportState = 'idle' | 'sending' | 'sent' | 'error';

interface ReportResponse {
  ok?: boolean;
  error?: string;
}

const MAX_MESSAGE_LENGTH = 4000;

export function ReportIssueSection({ number }: { number: string }) {
  const [category, setCategory] = useState<ReportCategory>('bug');
  const [message, setMessage] = useState('');
  const [state, setState] = useState<ReportState>('idle');
  const [error, setError] = useState<string | null>(null);

  const trimmedMessage = message.trim();
  const canSend = trimmedMessage.length > 0 && state !== 'sending';
  const countLabel = useMemo(() => `${message.length}/${MAX_MESSAGE_LENGTH}`, [message.length]);

  const sendReport = useCallback(async () => {
    if (!trimmedMessage) {
      setState('error');
      setError('Add a short report before sending.');
      return;
    }

    setState('sending');
    setError(null);

    const route = typeof window !== 'undefined'
      ? `${window.location.pathname}${window.location.hash}`
      : 'unknown';
    const userAgent = typeof navigator !== 'undefined' && navigator.userAgent
      ? navigator.userAgent
      : 'unknown';

    try {
      const response = await fetch('/api/feedback/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category,
          message: trimmedMessage,
          route,
          userAgent,
        }),
      });
      const body = await response.json().catch(() => null) as ReportResponse | null;
      if (!response.ok || !body?.ok) {
        setState('error');
        setError(body?.error || `Report failed with HTTP ${response.status}.`);
        return;
      }
      setState('sent');
      setMessage('');
    } catch (sendError) {
      setState('error');
      setError(sendError instanceof Error ? sendError.message : 'Report failed.');
    }
  }, [category, trimmedMessage]);

  return (
    <section style={{ marginBottom: 32 }}>
      <SectionLabel number={number}>REPORT AN ISSUE</SectionLabel>

      <div style={{
        position: 'relative',
        paddingTop: 18,
        paddingRight: 18,
        paddingBottom: 18,
        paddingLeft: 18,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-divider-subtle)',
        borderRadius: 4,
        background: 'var(--t-bg-card)',
      }}>
        <CornerBrackets armLength={9} inset={5} />

        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
          maxWidth: 680,
        }}>
          <div>
            <h2 style={{
              margin: 0,
              marginBottom: 8,
              fontFamily: APP_FONT_STACK,
              fontSize: 18,
              fontWeight: 300,
              letterSpacing: '-0.02em',
              lineHeight: 1.2,
              color: 'var(--t-text)',
            }}>
              Report an issue
            </h2>
            <p style={{
              margin: 0,
              fontFamily: APP_FONT_STACK,
              fontSize: 13,
              fontWeight: 300,
              letterSpacing: '-0.005em',
              lineHeight: 1.5,
              color: 'var(--t-text-muted)',
            }}>
              Send a bug or request to the o8 team. One-way — we read every report but won&apos;t reply here.
            </p>
          </div>

          <div style={{
            display: 'inline-grid',
            gridTemplateColumns: '1fr 1fr',
            width: 220,
            padding: 3,
            gap: 3,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-divider-subtle)',
            borderRadius: 9,
            background: 'var(--t-input-bg)',
          }}>
            <CategoryButton
              active={category === 'bug'}
              label="Bug"
              onClick={() => {
                setCategory('bug');
                if (state === 'sent') setState('idle');
              }}
            />
            <CategoryButton
              active={category === 'request'}
              label="Request"
              onClick={() => {
                setCategory('request');
                if (state === 'sent') setState('idle');
              }}
            />
          </div>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={{
              fontFamily: MONO_FONT_STACK,
              fontSize: 10,
              fontWeight: 400,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: RAMS_INK_QUIET,
            }}>
              Message
            </span>
            <textarea
              value={message}
              maxLength={MAX_MESSAGE_LENGTH}
              placeholder="What broke, or what should o8 support?"
              onChange={(event) => {
                setMessage(event.target.value);
                if (state === 'sent' || state === 'error') {
                  setState('idle');
                  setError(null);
                }
              }}
              rows={6}
              style={textareaStyle}
              onFocus={(event) => {
                event.currentTarget.style.borderColor = RAMS_ACCENT;
              }}
              onBlur={(event) => {
                event.currentTarget.style.borderColor = 'var(--t-panel-border)';
              }}
            />
          </label>

          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            flexWrap: 'wrap',
          }}>
            <div style={{
              fontFamily: MONO_FONT_STACK,
              fontSize: 10,
              fontWeight: 300,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: RAMS_INK_QUIET,
            }}>
              {countLabel}
            </div>
            <RamsButton
              type="button"
              onClick={() => { void sendReport(); }}
              disabled={!canSend}
              busy={state === 'sending'}
            >
              {state === 'sending' ? 'Sending' : 'Send'}
            </RamsButton>
          </div>

          {state === 'sent' ? (
            <StatusLine tone="success">
              Sent — thanks. We&apos;ll pick it up from the report channel.
            </StatusLine>
          ) : null}

          {state === 'error' && error ? (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 14,
              flexWrap: 'wrap',
            }}>
              <StatusLine tone="error">{error}</StatusLine>
              <RamsButton
                type="button"
                variant="ghost"
                onClick={() => { void sendReport(); }}
                disabled={!trimmedMessage}
              >
                Retry
              </RamsButton>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function CategoryButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      style={{
        minHeight: 32,
        borderRadius: 7,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: active ? 'var(--t-panel-border)' : 'transparent',
        background: active ? 'var(--t-bg-card)' : 'transparent',
        color: active ? RAMS_ACCENT : 'var(--t-text-muted)',
        cursor: 'pointer',
        fontFamily: MONO_FONT_STACK,
        fontSize: 10,
        fontWeight: 300,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), color 120ms, border-color 120ms',
      }}
    >
      {label}
    </button>
  );
}

function StatusLine({ children, tone }: { children: React.ReactNode; tone: 'success' | 'error' }) {
  return (
    <div style={{
      fontFamily: APP_FONT_STACK,
      fontSize: 13,
      fontWeight: 300,
      letterSpacing: '-0.005em',
      lineHeight: 1.45,
      color: tone === 'success' ? 'var(--t-success, #16a34a)' : 'var(--t-danger, #ef4444)',
    }}>
      {children}
    </div>
  );
}

const textareaStyle: CSSProperties = {
  width: '100%',
  minHeight: 132,
  boxSizing: 'border-box',
  resize: 'vertical',
  paddingTop: 12,
  paddingRight: 12,
  paddingBottom: 12,
  paddingLeft: 12,
  borderRadius: 8,
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--t-panel-border)',
  background: 'var(--t-input-bg)',
  color: 'var(--t-text)',
  outline: 'none',
  fontFamily: APP_FONT_STACK,
  fontSize: 13.5,
  fontWeight: 300,
  letterSpacing: '-0.005em',
  lineHeight: 1.5,
};
