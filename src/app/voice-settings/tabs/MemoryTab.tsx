'use client';

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import {
  symonMemoryAcceptSuggestion,
  symonMemoryAdd,
  symonMemoryDismissSuggestion,
  symonMemoryForget,
  symonMemoryGet,
  symonMemoryUpdate,
  type SymonMemoryEntry,
  type SymonMemorySnapshot,
} from '@/lib/tauri/bridge';
import {
  ACCENT,
  ACCENT_GLOW,
  GLASS_BG,
  GLASS_BG_HOVER,
  GLASS_BORDER_SUBTLE,
  OK_GREEN,
  SF,
  TEXT_PRIMARY,
  TEXT_SECONDARY,
  TEXT_TERTIARY,
  TRANS_FAST,
  WARN_AMBER,
  ICONS,
} from '../tokens';
import { AccentButton, GhostButton, Icon, PageHeader, SectionCard, SectionHint, SectionTitle } from '../primitives';

const EMPTY: SymonMemorySnapshot = { facts: [], suggestions: [] };
const INPUT: CSSProperties = {
  width: '100%',
  minHeight: 36,
  boxSizing: 'border-box',
  paddingTop: 8,
  paddingRight: 11,
  paddingBottom: 8,
  paddingLeft: 11,
  borderRadius: 9,
  border: `1px solid ${GLASS_BORDER_SUBTLE}`,
  background: GLASS_BG,
  color: TEXT_PRIMARY,
  fontFamily: SF,
  fontSize: 12.5,
  lineHeight: 1.45,
  outline: 'none',
};

export default function MemoryTab() {
  const [snapshot, setSnapshot] = useState<SymonMemorySnapshot>(EMPTY);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setSnapshot(await symonMemoryGet());
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Memory could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const refresh = () => { void load(); };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [load]);

  const add = async () => {
    const fact = draft.trim();
    if (!fact) return;
    try {
      await symonMemoryAdd(fact);
      setDraft('');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Memory could not be saved.');
    }
  };

  const runAndReload = async (operation: () => Promise<unknown>) => {
    try {
      await operation();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Memory could not be changed.');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <PageHeader icon={ICONS.bookOpen} title="Memory" right={<GhostButton label="Refresh" onClick={() => { void load(); }} />} />

      <SectionCard>
        <SectionTitle icon={ICONS.bookOpen} status="Local">What Symon knows</SectionTitle>
        <SectionHint>
          Only approved facts shape future conversations and action cards. Everything stays in o8 on this Mac, and forgetting deletes the fact.
        </SectionHint>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 13 }}>
          <textarea
            aria-label="New memory fact"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void add();
              }
            }}
            placeholder="Add one fact you want Symon to remember"
            rows={2}
            style={{ ...INPUT, resize: 'vertical', minHeight: 52 }}
          />
          <AccentButton label="Remember" onClick={() => { void add(); }} />
        </div>

        {loading ? (
          <p style={{ fontSize: 12.5, color: TEXT_TERTIARY }}>Loading approved memory…</p>
        ) : snapshot.facts.length === 0 ? (
          <p style={{ fontSize: 12.5, color: TEXT_TERTIARY }}>
            Nothing saved yet. Say “remember that…” or add a fact here.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {snapshot.facts.map((entry, index) => (
              <FactRow
                key={`${entry.id}:${entry.updatedAt}`}
                entry={entry}
                first={index === 0}
                onSave={(fact) => runAndReload(() => symonMemoryUpdate(entry.id, fact))}
                onForget={() => runAndReload(() => symonMemoryForget(entry.id))}
              />
            ))}
          </div>
        )}
      </SectionCard>

      {snapshot.suggestions.length > 0 ? (
        <SectionCard>
          <SectionTitle icon={ICONS.sparkle}>Suggestions to review</SectionTitle>
          <SectionHint>
            Symon noticed these during conversation, but they are not active memory. Approve or dismiss each one.
          </SectionHint>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {snapshot.suggestions.map((entry, index) => (
              <SuggestionRow
                key={entry.id}
                entry={entry}
                first={index === 0}
                onAccept={() => runAndReload(() => symonMemoryAcceptSuggestion(entry.id))}
                onDismiss={() => runAndReload(() => symonMemoryDismissSuggestion(entry.id))}
              />
            ))}
          </div>
        </SectionCard>
      ) : null}

      {error ? (
        <div style={{ color: WARN_AMBER, fontSize: 12, lineHeight: 1.45 }} role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

function FactRow({ entry, first, onSave, onForget }: {
  entry: SymonMemoryEntry;
  first: boolean;
  onSave: (fact: string) => Promise<unknown>;
  onForget: () => Promise<unknown>;
}) {
  const [value, setValue] = useState(entry.fact);
  const [focus, setFocus] = useState(false);
  const changed = value.trim() !== entry.fact;

  return (
    <div style={{ paddingTop: first ? 2 : 12, paddingBottom: 12, borderTop: first ? 'none' : `1px solid ${GLASS_BORDER_SUBTLE}` }}>
      <textarea
        aria-label="Saved memory fact"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        rows={2}
        style={{
          ...INPUT,
          minHeight: 50,
          resize: 'vertical',
          borderColor: focus ? ACCENT : GLASS_BORDER_SUBTLE,
          boxShadow: focus ? `0 0 0 2px ${ACCENT_GLOW}` : 'none',
        }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 7 }}>
        <span style={{ fontSize: 10.5, color: TEXT_TERTIARY }}>Approved · stored locally</span>
        <div style={{ display: 'flex', gap: 6 }}>
          {changed ? <GhostButton label="Save edit" tone="ok" onClick={() => { void onSave(value.trim()); }} /> : null}
          <GhostButton label="Forget" tone="danger" onClick={() => { void onForget(); }} />
        </div>
      </div>
    </div>
  );
}

function SuggestionRow({ entry, first, onAccept, onDismiss }: {
  entry: SymonMemoryEntry;
  first: boolean;
  onAccept: () => Promise<unknown>;
  onDismiss: () => Promise<unknown>;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        paddingTop: first ? 2 : 12,
        paddingBottom: 12,
        borderTop: first ? 'none' : `1px solid ${GLASS_BORDER_SUBTLE}`,
        background: hover ? GLASS_BG_HOVER : 'transparent',
        transition: `background ${TRANS_FAST}`,
      }}
    >
      <span style={{ color: OK_GREEN, display: 'flex', marginTop: 2, flexShrink: 0 }}>
        <Icon icon={ICONS.sparkle} size={13} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: TEXT_PRIMARY, fontSize: 12.5, lineHeight: 1.5 }}>{entry.fact}</div>
        <div style={{ color: TEXT_SECONDARY, fontSize: 10.5, marginTop: 4 }}>Inactive until you approve it</div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        <GhostButton label="Approve" tone="ok" onClick={() => { void onAccept(); }} />
        <GhostButton label="Dismiss" onClick={() => { void onDismiss(); }} />
      </div>
    </div>
  );
}
