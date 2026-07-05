'use client';

/**
 * #899 wave 2 — AI project suggestions section.
 *
 * Drops into the Settings → Projects panel as a sibling. Renders:
 *  1. A "Suggest projects" button that POSTs /api/projects/suggest
 *  2. A loading state with the analyzing N repos line
 *  3. Two horizontal strips of cards: "Confident" and "Plausible"
 *
 * Each card supports inline accept (creates a project), edit (calls the
 * onEditBeforeCreating prop with prefill data — wired by the Settings
 * panel), and dismiss (records to dismissed_suggestions).
 *
 * This component does NOT manage its own routing into the manual create
 * form — it raises the prefill via `onEditBeforeCreating` so the parent
 * panel can swap views.
 */

import { useCallback, useState } from 'react';
import {
  APP_FONT_STACK,
  RAMS_ACCENT,
  RAMS_HAIRLINE,
  RAMS_HAIRLINE_SOFT,
  RAMS_INK_QUIET,
  RamsButton,
  SectionLabel,
} from '../shared';

// Mirrors the public type from src/lib/projects/suggest.ts. Kept inline so
// this component has zero server-only imports.
type SuggestionConfidence = 'confident' | 'plausible';
type EvidenceKind =
  | 'shared-org'
  | 'cross-link'
  | 'shared-dep'
  | 'deploy-pair'
  | 'topic-overlap'
  | 'language-overlap'
  | 'naming-pattern';

interface SuggestionEvidence {
  kind: EvidenceKind;
  repoId: string;
  snippet: string;
}

type ProjectRole =
  | 'frontend'
  | 'backend'
  | 'fullstack'
  | 'mobile'
  | 'library'
  | 'service'
  | 'infra'
  | 'docs'
  | 'site'
  | 'shared';

export interface ProjectSuggestion {
  id: string;
  suggestedName: string;
  repoIds: string[];
  primaryRepoId?: string;
  evidence: SuggestionEvidence[];
  confidence: SuggestionConfidence;
  rationale: string;
  detectedRoles: Record<string, ProjectRole>;
}

export interface SuggestionsSectionProps {
  /** Map of repoId → display name, for chip labels. Optional. */
  repoNames?: Record<string, string>;
  /** Called after a successful Create. Parent should refresh its project list. */
  onProjectCreated?: (projectId: string) => void;
  /** Called when the operator chooses "Edit before creating" — parent swaps to its create form. */
  onEditBeforeCreating?: (suggestion: ProjectSuggestion) => void;
}

interface SuggestProjectsResult {
  suggestions: ProjectSuggestion[];
  generatedAt: number;
  cached: boolean;
}

const EVIDENCE_LABELS: Record<EvidenceKind, string> = {
  'shared-org': 'shared org',
  'cross-link': 'cross-link',
  'shared-dep': 'shared dep',
  'deploy-pair': 'deploy pair',
  'topic-overlap': 'topic overlap',
  'language-overlap': 'language overlap',
  'naming-pattern': 'naming pattern',
};

// ── Component ──

export function SuggestionsSection({
  repoNames,
  onProjectCreated,
  onEditBeforeCreating,
}: SuggestionsSectionProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SuggestProjectsResult | null>(null);
  const [analyzingCount, setAnalyzingCount] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());

  const fetchSuggestions = useCallback(async (force: boolean) => {
    setLoading(true);
    setError(null);
    setBusyId(null);

    try {
      // Probe the repo count so the loading state can show "Analyzing N repos…"
      try {
        const reposRes = await fetch('/api/panel/repos', { headers: { 'Cache-Control': 'no-store' } });
        if (reposRes.ok) {
          const reposJson = (await reposRes.json()) as { repos?: unknown[] };
          if (Array.isArray(reposJson?.repos)) {
            setAnalyzingCount(reposJson.repos.length);
          }
        }
      } catch {
        // Probe failure is non-fatal — keep null and the spinner just says "Analyzing…"
      }

      const url = force ? '/api/projects/suggest?force=1' : '/api/projects/suggest';
      const res = await fetch(url, { method: 'POST' });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errBody.error || `Request failed (${res.status})`);
      }
      const payload = (await res.json()) as SuggestProjectsResult;
      setResult(payload);
      setDismissedIds(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setAnalyzingCount(null);
    }
  }, []);

  const onCreate = useCallback(async (suggestion: ProjectSuggestion) => {
    setBusyId(suggestion.id);
    setError(null);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: suggestion.suggestedName,
          description: suggestion.rationale,
          repoIds: suggestion.repoIds,
          roles: suggestion.detectedRoles,
          suggestionOrigin: 'ai-semantic',
        }),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errBody.error || `Request failed (${res.status})`);
      }
      const created = (await res.json()) as { project?: { id?: string } };
      // Mark this suggestion as dismissed locally so the card fades out.
      setDismissedIds((prev) => new Set([...prev, suggestion.id]));
      // Persist removal from the live cache so a non-force refresh stays in sync.
      // Best-effort — failure is fine; the cache will rebuild on the next force run.
      void fetch('/api/projects/suggest/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suggestionId: suggestion.id, reason: 'accepted' }),
      }).catch(() => null);
      if (created.project?.id) {
        onProjectCreated?.(created.project.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }, [onProjectCreated]);

  const onDismiss = useCallback(async (suggestion: ProjectSuggestion) => {
    setBusyId(suggestion.id);
    setError(null);
    try {
      const res = await fetch('/api/projects/suggest/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suggestionId: suggestion.id }),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errBody.error || `Request failed (${res.status})`);
      }
      setDismissedIds((prev) => new Set([...prev, suggestion.id]));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }, []);

  const visibleSuggestions = (result?.suggestions ?? []).filter((s) => !dismissedIds.has(s.id));
  const confident = visibleSuggestions.filter((s) => s.confidence === 'confident');
  const plausible = visibleSuggestions.filter((s) => s.confidence === 'plausible');

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <SectionLabel number="01">AI suggestions</SectionLabel>

      <p style={{
        fontFamily: APP_FONT_STACK,
        fontSize: 13,
        fontWeight: 400,
        color: 'var(--t-text-secondary)',
        lineHeight: 1.55,
        margin: 0,
        marginTop: -8,
        maxWidth: 640,
      }}>
        Stage 2 reads each registered repo&apos;s ≤2KB fingerprint (READMEs, deps, deploy hints — never source) and asks Gemini Flash to group repos that ship together. Confident groupings have 3+ shared signals; plausible groupings have weaker evidence.
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <RamsButton
          onClick={() => fetchSuggestions(false)}
          busy={loading}
          disabled={loading}
        >
          {result ? 'Re-run suggest' : 'Suggest projects'}
        </RamsButton>
        {result ? (
          <RamsButton
            variant="ghost"
            onClick={() => fetchSuggestions(true)}
            busy={loading}
            disabled={loading}
          >
            Force fresh
          </RamsButton>
        ) : null}
        {result && !loading ? (
          <span style={{
            fontFamily: APP_FONT_STACK,
            fontSize: 10,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: RAMS_INK_QUIET,
          }}>
            {result.cached ? 'cached' : 'fresh'}
            <span style={{ marginLeft: 8, marginRight: 8, opacity: 0.5 }}>·</span>
            {visibleSuggestions.length} suggestion{visibleSuggestions.length === 1 ? '' : 's'}
          </span>
        ) : null}
      </div>

      {loading ? (
        <LoadingStrip count={analyzingCount} />
      ) : null}

      {error ? (
        <ErrorStrip message={error} onDismiss={() => setError(null)} />
      ) : null}

      {!loading && result && visibleSuggestions.length === 0 ? (
        <EmptyResultStrip />
      ) : null}

      {confident.length > 0 ? (
        <ConfidentStrip>
          {confident.map((suggestion) => (
            <ConfidentCard
              key={suggestion.id}
              suggestion={suggestion}
              repoNames={repoNames}
              busy={busyId === suggestion.id}
              onCreate={() => onCreate(suggestion)}
              onEdit={onEditBeforeCreating ? () => onEditBeforeCreating(suggestion) : undefined}
              onDismiss={() => onDismiss(suggestion)}
            />
          ))}
        </ConfidentStrip>
      ) : null}

      {plausible.length > 0 ? (
        <PlausibleStrip>
          {plausible.map((suggestion) => (
            <PlausibleCard
              key={suggestion.id}
              suggestion={suggestion}
              repoNames={repoNames}
              busy={busyId === suggestion.id}
              onReview={onEditBeforeCreating ? () => onEditBeforeCreating(suggestion) : undefined}
              onDismiss={() => onDismiss(suggestion)}
            />
          ))}
        </PlausibleStrip>
      ) : null}
    </section>
  );
}

// ── Strips ──

function ConfidentStrip({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <StripHeading label="Confident" tone="accent" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {children}
      </div>
    </div>
  );
}

function PlausibleStrip({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 6 }}>
      <StripHeading label="Plausible" tone="quiet" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {children}
      </div>
    </div>
  );
}

function StripHeading({ label, tone }: { label: string; tone: 'accent' | 'quiet' }) {
  return (
    <div style={{
      fontFamily: APP_FONT_STACK,
      fontSize: 10,
      fontWeight: 300,
      letterSpacing: '0.22em',
      textTransform: 'uppercase',
      color: tone === 'accent' ? RAMS_ACCENT : RAMS_INK_QUIET,
    }}>
      {label}
    </div>
  );
}

// ── Cards ──

function ConfidentCard({
  suggestion,
  repoNames,
  busy,
  onCreate,
  onEdit,
  onDismiss,
}: {
  suggestion: ProjectSuggestion;
  repoNames?: Record<string, string>;
  busy: boolean;
  onCreate: () => void;
  onEdit?: () => void;
  onDismiss: () => void;
}) {
  const [evidenceOpen, setEvidenceOpen] = useState(false);

  return (
    <div style={{
      borderWidth: 1,
      borderStyle: 'solid',
      borderColor: RAMS_HAIRLINE,
      background: 'var(--t-panel)',
      borderRadius: 4,
      paddingTop: 18,
      paddingRight: 20,
      paddingBottom: 18,
      paddingLeft: 20,
      display: 'flex',
      flexDirection: 'column',
      gap: 14,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h3 style={{
          fontFamily: APP_FONT_STACK,
          fontSize: 18,
          fontWeight: 300,
          letterSpacing: '-0.02em',
          color: 'var(--t-text)',
          margin: 0,
        }}>
          {suggestion.suggestedName}
        </h3>
        <span style={{
          fontFamily: APP_FONT_STACK,
          fontSize: 10,
          fontWeight: 300,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: RAMS_ACCENT,
        }}>
          {suggestion.repoIds.length} repos
        </span>
      </div>

      <MemberChips suggestion={suggestion} repoNames={repoNames} />

      <p style={{
        fontFamily: APP_FONT_STACK,
        fontSize: 13,
        fontWeight: 400,
        color: 'var(--t-text-secondary)',
        lineHeight: 1.55,
        margin: 0,
        maxWidth: 720,
      }}>
        {suggestion.rationale}
      </p>

      <EvidencePanel
        evidence={suggestion.evidence}
        repoNames={repoNames}
        open={evidenceOpen}
        onToggle={() => setEvidenceOpen((v) => !v)}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', paddingTop: 4 }}>
        <RamsButton onClick={onCreate} busy={busy} disabled={busy}>
          Create project
        </RamsButton>
        {onEdit ? (
          <RamsButton variant="ghost" onClick={onEdit} disabled={busy}>
            Edit before creating
          </RamsButton>
        ) : null}
        <RamsButton variant="ghost" onClick={onDismiss} disabled={busy}>
          Dismiss
        </RamsButton>
      </div>
    </div>
  );
}

function PlausibleCard({
  suggestion,
  repoNames,
  busy,
  onReview,
  onDismiss,
}: {
  suggestion: ProjectSuggestion;
  repoNames?: Record<string, string>;
  busy: boolean;
  onReview?: () => void;
  onDismiss: () => void;
}) {
  const [evidenceOpen, setEvidenceOpen] = useState(false);

  return (
    <div style={{
      borderWidth: 1,
      borderStyle: 'dashed',
      borderColor: RAMS_HAIRLINE_SOFT,
      background: 'transparent',
      borderRadius: 4,
      paddingTop: 14,
      paddingRight: 16,
      paddingBottom: 14,
      paddingLeft: 16,
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      opacity: 0.92,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <h3 style={{
          fontFamily: APP_FONT_STACK,
          fontSize: 14,
          fontWeight: 300,
          letterSpacing: '-0.01em',
          color: 'var(--t-text-secondary)',
          margin: 0,
        }}>
          {suggestion.suggestedName}
        </h3>
        <span style={{
          fontFamily: APP_FONT_STACK,
          fontSize: 9,
          fontWeight: 400,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: RAMS_INK_QUIET,
        }}>
          {suggestion.repoIds.length} repos
        </span>
      </div>

      <MemberChips suggestion={suggestion} repoNames={repoNames} compact />

      <p style={{
        fontFamily: APP_FONT_STACK,
        fontSize: 12,
        fontWeight: 400,
        color: 'var(--t-text-muted)',
        lineHeight: 1.5,
        margin: 0,
        maxWidth: 720,
      }}>
        {suggestion.rationale}
      </p>

      <EvidencePanel
        evidence={suggestion.evidence}
        repoNames={repoNames}
        open={evidenceOpen}
        onToggle={() => setEvidenceOpen((v) => !v)}
        compact
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingTop: 2 }}>
        {onReview ? (
          <RamsButton onClick={onReview} disabled={busy}>
            Review
          </RamsButton>
        ) : null}
        <RamsButton variant="ghost" onClick={onDismiss} disabled={busy}>
          Dismiss
        </RamsButton>
      </div>
    </div>
  );
}

// ── Member chips ──

function MemberChips({
  suggestion,
  repoNames,
  compact = false,
}: {
  suggestion: ProjectSuggestion;
  repoNames?: Record<string, string>;
  compact?: boolean;
}) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {suggestion.repoIds.map((repoId) => {
        const role = suggestion.detectedRoles[repoId];
        const isPrimary = repoId === suggestion.primaryRepoId;
        const label = repoNames?.[repoId] ?? repoId;
        return (
          <span
            key={repoId}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              paddingTop: compact ? 3 : 4,
              paddingRight: compact ? 8 : 10,
              paddingBottom: compact ? 3 : 4,
              paddingLeft: compact ? 8 : 10,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: isPrimary ? 'var(--t-settings-accent-active-border, rgba(29, 78, 216, 0.32))' : RAMS_HAIRLINE_SOFT,
              borderRadius: 999,
              background: isPrimary ? 'var(--t-settings-accent-active-bg, rgba(29, 78, 216, 0.08))' : 'transparent',
              fontFamily: APP_FONT_STACK,
              fontSize: compact ? 11 : 12,
              fontWeight: 300,
              color: 'var(--t-text)',
              letterSpacing: '-0.01em',
            }}
          >
            <span>{label}</span>
            {role ? (
              <span style={{
                fontFamily: APP_FONT_STACK,
                fontSize: 9,
                fontWeight: 400,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                color: isPrimary ? RAMS_ACCENT : RAMS_INK_QUIET,
              }}>
                {role}
              </span>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

// ── Evidence panel ──

function EvidencePanel({
  evidence,
  repoNames,
  open,
  onToggle,
  compact = false,
}: {
  evidence: SuggestionEvidence[];
  repoNames?: Record<string, string>;
  open: boolean;
  onToggle: () => void;
  compact?: boolean;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          alignSelf: 'flex-start',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          fontFamily: APP_FONT_STACK,
          fontSize: 10,
          fontWeight: 300,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: RAMS_INK_QUIET,
          paddingTop: 0,
          paddingBottom: 0,
          paddingLeft: 0,
          paddingRight: 0,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <span>{open ? 'Hide evidence' : `Evidence (${evidence.length})`}</span>
        <ChevronGlyph rotated={open} />
      </button>
      {open ? (
        <ul style={{
          listStyle: 'none',
          paddingTop: compact ? 6 : 8,
          paddingRight: compact ? 10 : 12,
          paddingBottom: compact ? 6 : 8,
          paddingLeft: compact ? 10 : 12,
          marginTop: 0,
          marginBottom: 0,
          marginLeft: 0,
          marginRight: 0,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: RAMS_HAIRLINE_SOFT,
          borderRadius: 4,
          background: 'var(--t-settings-accent-active-bg, rgba(29, 78, 216, 0.03))',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}>
          {evidence.map((e, i) => (
            <li
              key={`${e.kind}-${e.repoId}-${i}`}
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 10,
                fontFamily: APP_FONT_STACK,
                fontSize: compact ? 11 : 12,
                color: 'var(--t-text-secondary)',
                lineHeight: 1.45,
              }}
            >
              <span style={{
                flexShrink: 0,
                fontFamily: APP_FONT_STACK,
                fontSize: 9,
                fontWeight: 300,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                color: RAMS_ACCENT,
                minWidth: 96,
              }}>
                {EVIDENCE_LABELS[e.kind]}
              </span>
              <span style={{
                flexShrink: 0,
                fontFamily: APP_FONT_STACK,
                fontSize: 10,
                color: RAMS_INK_QUIET,
                minWidth: 80,
              }}>
                {repoNames?.[e.repoId] ?? e.repoId}
              </span>
              <span style={{ flex: 1 }}>{e.snippet}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ChevronGlyph({ rotated }: { rotated: boolean }) {
  return (
    <svg
      width={10}
      height={10}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      style={{
        display: 'block',
        transition: 'transform 200ms',
        transform: rotated ? 'rotate(180deg)' : 'rotate(0)',
      }}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

// ── Side strips ──

function LoadingStrip({ count }: { count: number | null }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      paddingTop: 14,
      paddingRight: 16,
      paddingBottom: 14,
      paddingLeft: 16,
      borderWidth: 1,
      borderStyle: 'dashed',
      borderColor: RAMS_HAIRLINE_SOFT,
      borderRadius: 4,
    }}>
      <Spinner />
      <span style={{
        fontFamily: APP_FONT_STACK,
        fontSize: 13,
        fontWeight: 400,
        color: 'var(--t-text-secondary)',
      }}>
        {count != null ? `Analyzing ${count} repos…` : 'Analyzing…'}
      </span>
    </div>
  );
}

function ErrorStrip({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      gap: 12,
      paddingTop: 12,
      paddingRight: 14,
      paddingBottom: 12,
      paddingLeft: 14,
      borderWidth: 1,
      borderStyle: 'solid',
      borderColor: 'rgba(217, 79, 58, 0.32)',
      borderRadius: 4,
      background: 'rgba(217, 79, 58, 0.06)',
    }}>
      <span style={{
        fontFamily: APP_FONT_STACK,
        fontSize: 10,
        fontWeight: 300,
        letterSpacing: '0.18em',
        textTransform: 'uppercase',
        color: '#d94f3a',
        flexShrink: 0,
        paddingTop: 2,
      }}>
        error
      </span>
      <span style={{
        flex: 1,
        fontFamily: APP_FONT_STACK,
        fontSize: 12,
        color: 'var(--t-text)',
        lineHeight: 1.5,
      }}>
        {message}
      </span>
      <button
        type="button"
        onClick={onDismiss}
        style={{
          flexShrink: 0,
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          fontFamily: APP_FONT_STACK,
          fontSize: 10,
          fontWeight: 300,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: RAMS_INK_QUIET,
        }}
      >
        Dismiss
      </button>
    </div>
  );
}

function EmptyResultStrip() {
  return (
    <div style={{
      paddingTop: 14,
      paddingRight: 16,
      paddingBottom: 14,
      paddingLeft: 16,
      borderWidth: 1,
      borderStyle: 'dashed',
      borderColor: RAMS_HAIRLINE_SOFT,
      borderRadius: 4,
      background: 'transparent',
    }}>
      <span style={{
        fontFamily: APP_FONT_STACK,
        fontSize: 13,
        fontWeight: 400,
        color: 'var(--t-text-secondary)',
        lineHeight: 1.55,
      }}>
        No groupings surfaced. Either the registered repos are unrelated, the AI did not find enough shared signal, or every grouping has already been dismissed. Try adding more repos or running &quot;Force fresh&quot;.
      </span>
    </div>
  );
}

function Spinner() {
  return (
    <div
      aria-hidden
      style={{
        width: 14,
        height: 14,
        borderRadius: '50%',
        borderWidth: 2,
        borderStyle: 'solid',
        borderColor: RAMS_HAIRLINE,
        borderTopColor: RAMS_ACCENT,
        animation: 'o8-projects-suggestions-spin 0.9s linear infinite',
      } as React.CSSProperties}
    >
      <style>{`@keyframes o8-projects-suggestions-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
