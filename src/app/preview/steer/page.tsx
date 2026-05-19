'use client';

/**
 * /preview/steer — dev scaffold for the pending-steer card + composer pairing.
 *
 * Stacks each state (empty / single / multi / mid-edit) over a mock composer
 * so the operator can visual-approve before it lands in ComposerArea +
 * ThoughtsChatPanel. Screenshot via dev-browser light + no-transparent recipe
 * ([[dev-browser-default-light-no-transparent]]).
 *
 * Not part of the shipped chrome.
 */

import { useState } from 'react';
import { ThemeProvider } from '@/lib/theme/context';
import {
  PendingSteerCard,
  type PendingSteer,
} from '@/components/desktop/thoughts/chat-panel/PendingSteerCard';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        marginTop: 0,
        marginBottom: 24,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          color: 'var(--t-text-muted)',
        }}
      >
        {title}
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 14,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: 'var(--t-divider)',
          background: 'var(--t-bg-card)',
          paddingTop: 10,
          paddingRight: 0,
          paddingBottom: 10,
          paddingLeft: 0,
          overflow: 'hidden',
        }}
      >
        {children}
      </div>
    </div>
  );
}

function MockComposer({ busy }: { busy: boolean }) {
  return (
    <div
      style={{
        marginTop: 0,
        marginRight: 12,
        marginBottom: 4,
        marginLeft: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-divider)',
        background: 'var(--t-input-bg)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          paddingTop: 11,
          paddingRight: 14,
          paddingBottom: 4,
          paddingLeft: 14,
          color: 'var(--t-text-muted)',
          fontSize: 13,
          minHeight: 52,
        }}
      >
        {busy ? 'Ask for follow-up changes' : 'Ask Codex anything…'}
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          paddingTop: 6,
          paddingRight: 10,
          paddingBottom: 8,
          paddingLeft: 10,
        }}
      >
        <Pill>+</Pill>
        <Pill>
          <span style={{ color: '#f97316' }}>⚠</span>&nbsp;Full access&nbsp;▾
        </Pill>
        <div style={{ flex: 1 }} />
        <Pill>5.5 Extra High ▾</Pill>
        <Pill>🎤</Pill>
        <button
          type="button"
          style={{
            width: 26,
            height: 26,
            borderWidth: 0,
            borderRadius: 999,
            background: busy ? 'var(--t-text)' : 'var(--t-accent)',
            color: busy ? 'var(--t-bg)' : 'var(--t-bg)',
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          aria-label={busy ? 'Stop' : 'Send'}
        >
          {busy ? (
            <svg width="9" height="9" viewBox="0 0 9 9">
              <rect width="9" height="9" fill="currentColor" />
            </svg>
          ) : (
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 14 V3" />
              <path d="M3 8 L8 3 L13 8" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        height: 24,
        paddingTop: 0,
        paddingRight: 8,
        paddingBottom: 0,
        paddingLeft: 8,
        borderRadius: 7,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-divider)',
        background: 'transparent',
        color: 'var(--t-text-muted)',
        fontSize: 11,
      }}
    >
      {children}
    </span>
  );
}

function SteerPreviewInner() {
  const [single, setSingle] = useState<PendingSteer[]>([
    { id: '1', text: 'add eslint config Codex suggested' },
  ]);
  const [multi, setMulti] = useState<PendingSteer[]>([
    { id: 'a', text: 'apply the eslint config Codex suggested' },
    { id: 'b', text: 'also wire the github action' },
    { id: 'c', text: 'rerun the typecheck after both' },
  ]);

  const noop = () => {};

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--t-bg)',
        color: 'var(--t-text)',
      }}
    >
      <div
        style={{
          maxWidth: 560,
          marginTop: 32,
          marginRight: 'auto',
          marginBottom: 32,
          marginLeft: 'auto',
          paddingTop: 0,
          paddingRight: 24,
          paddingBottom: 0,
          paddingLeft: 24,
          display: 'flex',
          flexDirection: 'column',
          gap: 0,
        }}
      >
        <div
          style={{
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: '-0.02em',
            marginBottom: 8,
          }}
        >
          Pending Steer Card
        </div>
        <div
          style={{
            fontSize: 13,
            color: 'var(--t-text-muted)',
            marginBottom: 28,
          }}
        >
          ⌘⏎ queues a steer. Auto-fires when agent goes idle. ↪ Steer button preempts now.
        </div>

        <Section title="01 — idle (no queue)">
          <MockComposer busy={false} />
        </Section>

        <Section title="02 — busy + 1 queued steer">
          <PendingSteerCard
            steers={single}
            onSteerNow={(id) => setSingle((s) => s.filter((x) => x.id !== id))}
            onDelete={(id) => setSingle((s) => s.filter((x) => x.id !== id))}
            onEdit={(id, text) =>
              setSingle((s) => s.map((x) => (x.id === id ? { ...x, text } : x)))
            }
          />
          <MockComposer busy={true} />
        </Section>

        <Section title="03 — busy + 3 queued steers (stacked)">
          <PendingSteerCard
            steers={multi}
            onSteerNow={(id) => setMulti((s) => s.filter((x) => x.id !== id))}
            onDelete={(id) => setMulti((s) => s.filter((x) => x.id !== id))}
            onEdit={(id, text) =>
              setMulti((s) => s.map((x) => (x.id === id ? { ...x, text } : x)))
            }
          />
          <MockComposer busy={true} />
        </Section>

        <Section title="04 — inline edit on a row (click ✎)">
          <PendingSteerCard
            steers={[
              { id: 'e', text: 'this row would be in edit state when you click ✎' },
            ]}
            onSteerNow={noop}
            onDelete={noop}
            onEdit={noop}
          />
          <MockComposer busy={true} />
        </Section>
      </div>
    </div>
  );
}

export default function SteerPreviewPage() {
  return (
    <ThemeProvider>
      <SteerPreviewInner />
    </ThemeProvider>
  );
}
