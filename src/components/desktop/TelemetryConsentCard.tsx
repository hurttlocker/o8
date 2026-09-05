'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { PRODUCT_EVENT_DISCLOSURES } from '@/lib/analytics/events';
import { SCRUBBED_CRASH_SAMPLE } from '@/lib/telemetry/consent-sample';
import { fetchOperatorDefaults } from './settings/operator-defaults-client';

type ConsentChoice = boolean | null;
type LoadState = 'loading' | 'hidden' | 'visible';

interface ConsentResponse {
  values?: {
    telemetryConsentAnswered?: unknown;
  };
  error?: unknown;
}

function ShieldGlyph() {
  return (
    <svg
      aria-hidden
      width={22}
      height={22}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'block' }}
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
      <path d="m9 12 2 2 4-5" />
    </svg>
  );
}

function ChoiceButton({
  label,
  selected,
  disabled,
  onPress,
}: {
  label: string;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onPress}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        minHeight: 44,
        width: '100%',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        paddingTop: 10,
        paddingBottom: 10,
        paddingLeft: 14,
        paddingRight: 14,
        borderRadius: 10,
        border: selected
          ? '1px solid var(--t-text)'
          : '1px solid var(--t-divider-strong)',
        background: selected
          ? 'var(--t-text)'
          : hovered
            ? 'var(--t-hover)'
            : 'var(--t-chat-surface-bg)',
        color: selected ? 'var(--t-chat-surface-bg)' : 'var(--t-text)',
        fontFamily: 'var(--font-sans-system)',
        fontSize: 12.5,
        fontWeight: 400,
        letterSpacing: -0.1,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), color 150ms cubic-bezier(0.22, 1, 0.36, 1), border-color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    >
      {selected ? (
        <svg aria-hidden width={13} height={13} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          <path d="m3 8 3 3 7-7" />
        </svg>
      ) : null}
      {label}
    </button>
  );
}

function DecisionButtons({
  value,
  shareLabel,
  declineLabel,
  disabled,
  onChange,
}: {
  value: ConsentChoice;
  shareLabel: string;
  declineLabel: string;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div
      role="group"
      aria-label={`${shareLabel} or ${declineLabel}`}
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
        gap: 8,
        marginTop: 16,
      }}
    >
      <ChoiceButton
        label={shareLabel}
        selected={value === true}
        disabled={disabled}
        onPress={() => onChange(true)}
      />
      <ChoiceButton
        label={declineLabel}
        selected={value === false}
        disabled={disabled}
        onPress={() => onChange(false)}
      />
    </div>
  );
}

function DisclosureCard({ children }: { children: React.ReactNode }) {
  return (
    <section style={{
      minWidth: 0,
      display: 'flex',
      flexDirection: 'column',
      paddingTop: 20,
      paddingBottom: 20,
      paddingLeft: 20,
      paddingRight: 20,
      borderRadius: 14,
      border: '1px solid var(--t-chat-surface-border)',
      background: 'var(--t-chat-surface-card-bg)',
    }}>
      {children}
    </section>
  );
}

export function TelemetryConsentCard({
  blocked = false,
  request = fetchOperatorDefaults,
}: {
  blocked?: boolean;
  request?: typeof fetchOperatorDefaults;
}) {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [crashReports, setCrashReports] = useState<ConsentChoice>(null);
  const [productUsage, setProductUsage] = useState<ConsentChoice>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const crashSample = useMemo(() => JSON.stringify(SCRUBBED_CRASH_SAMPLE, null, 2), []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const response = await request({}, { fresh: true, includeRuntime: false });
        const payload = await response.json().catch(() => ({})) as ConsentResponse;
        if (!response.ok) return;
        if (alive) {
          setLoadState(payload.values?.telemetryConsentAnswered === true ? 'hidden' : 'visible');
        }
      } catch {
        // A missing consent read fails closed and must never block the dashboard.
      }
    })();
    return () => { alive = false; };
  }, [request]);

  useEffect(() => {
    if (loadState === 'visible' && !blocked) dialogRef.current?.focus();
  }, [blocked, loadState]);

  if (loadState !== 'visible' || blocked) return null;

  const canSave = crashReports !== null && productUsage !== null && !saving;
  const keepFocusInDialog = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusable = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled])'),
    );
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  const saveChoices = async () => {
    if (crashReports === null || productUsage === null || saving) return;
    setSaving(true);
    setError(null);
    try {
      const response = await request({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          crashReportsEnabled: crashReports,
          productTelemetryEnabled: productUsage,
          telemetryConsentAnswered: true,
        }),
      });
      const payload = await response.json().catch(() => ({})) as ConsentResponse;
      if (!response.ok || payload.values?.telemetryConsentAnswered !== true) {
        throw new Error(typeof payload.error === 'string' ? payload.error : 'Your choices could not be saved.');
      }
      setLoadState('hidden');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Your choices could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 99997,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        paddingTop: 32,
        paddingBottom: 32,
        paddingLeft: 32,
        paddingRight: 32,
        background: 'var(--t-bg)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
      } as React.CSSProperties}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="telemetry-consent-title"
        tabIndex={-1}
        onKeyDown={keepFocusInDialog}
        style={{
          width: 'min(960px, 100%)',
          maxHeight: '100%',
          overflowY: 'auto',
          paddingTop: 32,
          paddingBottom: 28,
          paddingLeft: 32,
          paddingRight: 32,
          borderRadius: 16,
          border: '1px solid var(--t-chat-surface-border)',
          background: 'var(--t-chat-surface-bg)',
          color: 'var(--t-chat-surface-text)',
          boxShadow: 'var(--t-glass-shadow)',
          fontFamily: 'var(--font-sans-system)',
        }}
      >
        <header style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 24 }}>
          <div style={{
            width: 44,
            height: 44,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 12,
            border: '1px solid var(--t-divider-subtle)',
            background: 'var(--t-code-bg)',
            color: 'var(--t-text)',
          }}>
            <ShieldGlyph />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{
              marginBottom: 8,
              fontSize: 10,
              fontWeight: 300,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: 'var(--t-text-muted)',
            }}>
              01 — Privacy <span style={{ marginLeft: 10, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', letterSpacing: '0.04em' }}>(first run)</span>
            </div>
            <h1 id="telemetry-consent-title" style={{
              marginTop: 0,
              marginBottom: 8,
              fontSize: 28,
              fontWeight: 400,
              letterSpacing: -0.4,
              lineHeight: 1.2,
              color: 'var(--t-text)',
            }}>
              You choose what o8 sends.
            </h1>
            <p style={{
              maxWidth: 720,
              marginTop: 0,
              marginBottom: 0,
              fontSize: 13.5,
              fontWeight: 300,
              letterSpacing: -0.1,
              lineHeight: 1.55,
              color: 'var(--t-text-secondary)',
            }}>
              New installs share neither, and nothing is selected for you here. Choose each option independently, save once, and o8 will not ask again. You can change either choice later in Settings → General → Privacy.
            </p>
          </div>
        </header>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 390px), 1fr))',
          gap: 16,
        }}>
          <DisclosureCard>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
              <h2 style={{ marginTop: 0, marginBottom: 0, fontSize: 16, fontWeight: 400, letterSpacing: -0.1, color: 'var(--t-text)' }}>
                Crash reports
              </h2>
              <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', fontSize: 10, color: 'var(--t-text-faint)' }}>
                (errors + stacks)
              </span>
            </div>
            <p style={{ marginTop: 0, marginBottom: 12, fontSize: 12.5, fontWeight: 300, lineHeight: 1.5, color: 'var(--t-text-secondary)' }}>
              Sends scrubbed errors and stack traces when o8 breaks. The sample below is generated in this build by the same <code style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', fontSize: 11.5 }}>scrubSentryEvent</code> path used before browser and server reports leave the machine.
            </p>
            <div style={{ marginBottom: 6, fontSize: 10, fontWeight: 300, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t-text-muted)' }}>
              Scrubbed sample payload
            </div>
            <pre style={{
              flex: 1,
              minHeight: 176,
              maxHeight: 230,
              overflow: 'auto',
              marginTop: 0,
              marginBottom: 0,
              paddingTop: 12,
              paddingBottom: 12,
              paddingLeft: 12,
              paddingRight: 12,
              borderRadius: 10,
              border: '1px solid var(--t-divider-subtle)',
              background: 'var(--t-code-bg)',
              color: 'var(--t-text-secondary)',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              fontSize: 10.5,
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
            }}>
              {crashSample}
            </pre>
            <p style={{ marginTop: 10, marginBottom: 0, fontSize: 10.5, fontWeight: 300, lineHeight: 1.45, color: 'var(--t-text-muted)' }}>
              The input uses placeholders. The output is live scrubber output, not hand-written copy. Native fault reporting starts on the next launch and may include thread-stack memory and loaded-module paths, so keep this off if you do not want that diagnostic context to leave your machine.
            </p>
            <DecisionButtons
              value={crashReports}
              shareLabel="Share crash reports"
              declineLabel="Keep crash reports off"
              disabled={saving}
              onChange={setCrashReports}
            />
          </DisclosureCard>

          <DisclosureCard>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
              <h2 style={{ marginTop: 0, marginBottom: 0, fontSize: 16, fontWeight: 400, letterSpacing: -0.1, color: 'var(--t-text)' }}>
                Product usage
              </h2>
              <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', fontSize: 10, color: 'var(--t-text-faint)' }}>
                (six events)
              </span>
            </div>
            <p style={{ marginTop: 0, marginBottom: 12, fontSize: 12.5, fontWeight: 300, lineHeight: 1.5, color: 'var(--t-text-secondary)' }}>
              Sends only these allowlisted events and fields. Unknown events fail closed, and extra fields are discarded.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--t-divider-subtle)' }}>
              {PRODUCT_EVENT_DISCLOSURES.map(({ event, fields }) => (
                <div key={event} style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(132px, 0.8fr) minmax(0, 1.4fr)',
                  gap: 12,
                  paddingTop: 10,
                  paddingBottom: 10,
                  borderBottom: '1px solid var(--t-divider-subtle)',
                }}>
                  <code style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', fontSize: 10.5, color: 'var(--t-text)' }}>
                    {event}
                  </code>
                  <span style={{ fontSize: 10.5, fontWeight: 300, lineHeight: 1.4, color: 'var(--t-text-muted)' }}>
                    {fields}
                  </span>
                </div>
              ))}
            </div>
            <div style={{
              marginTop: 12,
              paddingTop: 12,
              paddingBottom: 12,
              paddingLeft: 12,
              paddingRight: 12,
              borderRadius: 10,
              border: '1px solid var(--t-divider-subtle)',
              background: 'var(--t-code-bg)',
            }}>
              <div style={{ marginBottom: 5, fontSize: 10, fontWeight: 400, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t-text)' }}>
                Never sent in product usage
              </div>
              <div style={{ fontSize: 11, fontWeight: 300, lineHeight: 1.5, color: 'var(--t-text-secondary)' }}>
                Code, prompts, repo names, paths, diffs, transcripts, file contents, credentials, user identity, or machine identity.
              </div>
            </div>
            <DecisionButtons
              value={productUsage}
              shareLabel="Share product usage"
              declineLabel="Keep product usage off"
              disabled={saving}
              onChange={setProductUsage}
            />
          </DisclosureCard>
        </div>

        <footer style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          marginTop: 20,
          paddingTop: 20,
          borderTop: '1px solid var(--t-divider-subtle)',
        }}>
          <div style={{ minHeight: 20, fontSize: 11.5, fontWeight: 300, lineHeight: 1.45, color: error ? 'var(--t-danger)' : 'var(--t-text-muted)' }} role={error ? 'alert' : undefined}>
            {error ?? (canSave ? 'Both choices are ready to save.' : 'Choose one option in each card to continue.')}
          </div>
          <button
            type="button"
            disabled={!canSave}
            onClick={() => { void saveChoices(); }}
            style={{
              minHeight: 44,
              flexShrink: 0,
              paddingTop: 10,
              paddingBottom: 10,
              paddingLeft: 20,
              paddingRight: 20,
              border: '1px solid var(--t-text)',
              borderRadius: 10,
              background: canSave ? 'var(--t-text)' : 'var(--t-chat-surface-bg)',
              color: canSave ? 'var(--t-chat-surface-bg)' : 'var(--t-text-faint)',
              fontFamily: 'var(--font-sans-system)',
              fontSize: 12.5,
              fontWeight: 400,
              cursor: canSave ? 'pointer' : 'default',
              opacity: canSave ? 1 : 0.7,
              transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
          >
            {saving ? 'Saving choices…' : 'Save both choices'}
          </button>
        </footer>
      </div>
    </div>
  );
}
