'use client';

import { formatRelative, outcomeTone } from '@/components/desktop/thoughts/recall-card/shared';
import { REPO_FOCUS_FONT, REPO_FOCUS_MONO } from './utils';
import { useRepoFocusRecall } from './useRepoFocusRecall';

interface RepoFocusContextTabProps {
  repoPath: string;
  symbolText: string;
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        borderRadius: 14,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-divider-subtle)',
        background: 'var(--t-bg-card)',
        paddingTop: 12,
        paddingRight: 12,
        paddingBottom: 12,
        paddingLeft: 12,
      }}
    >
      <div style={{ color: 'var(--t-text-muted)', fontSize: 11, fontWeight: 560, letterSpacing: '-0.01em' }}>
        {title}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ color: 'var(--t-text-faint)', fontSize: 12, lineHeight: 1.45 }}>{children}</div>;
}

export function RepoFocusContextTab({ repoPath, symbolText }: RepoFocusContextTabProps) {
  const { directives, outcomes, outcomesError, symbols, symbolHint } = useRepoFocusRecall(repoPath, symbolText);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        paddingTop: 14,
        paddingRight: 14,
        paddingBottom: 18,
        paddingLeft: 14,
        fontFamily: REPO_FOCUS_FONT,
      }}
    >
      <Section title="Directives">
        {directives === null ? (
          <Empty>Loading directives...</Empty>
        ) : directives.length === 0 ? (
          <Empty>No repo directives configured.</Empty>
        ) : directives.map((directive) => (
          <div key={directive.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', minWidth: 0 }}>
            <span style={{ color: 'var(--t-text)', fontSize: 12, fontWeight: 560, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {directive.title}
            </span>
            <span style={{ color: 'var(--t-text-faint)', fontFamily: REPO_FOCUS_MONO, fontSize: 10, flexShrink: 0 }}>
              {directive.scope}
            </span>
          </div>
        ))}
      </Section>

      <Section title="Recent Outcomes">
        {outcomes === null && !outcomesError ? (
          <Empty>Loading outcomes...</Empty>
        ) : outcomesError ? (
          <Empty>Couldn’t load outcomes.</Empty>
        ) : (outcomes ?? []).length === 0 ? (
          <Empty>No recent outcomes recorded.</Empty>
        ) : outcomes?.map((outcome) => {
          const tone = outcomeTone(outcome.outcome, outcome.reviewApproved);
          return (
            <div key={outcome.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', minWidth: 0 }}>
              <span style={{ width: 6, height: 6, marginTop: 6, borderRadius: '50%', background: tone.dot, flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', color: 'var(--t-text)', fontSize: 12, lineHeight: 1.35 }}>
                  {outcome.summary}
                </span>
                <span style={{ display: 'block', marginTop: 2, color: 'var(--t-text-faint)', fontSize: 10.5 }}>
                  {tone.label} · {outcome.branch ?? 'branch'} · {formatRelative(outcome.completedAt)}
                </span>
              </span>
            </div>
          );
        })}
      </Section>

      <Section title="Symbol Graph">
        {symbols === null && !symbolHint ? (
          <Empty>Loading symbols...</Empty>
        ) : symbolHint ? (
          <Empty>{symbolHint}</Empty>
        ) : (symbols ?? []).length === 0 ? (
          <Empty>No matching symbols.</Empty>
        ) : symbols?.slice(0, 10).map((edge) => (
          <div key={edge.symbol} style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
              <span style={{ color: 'var(--t-text)', fontSize: 12, fontWeight: 560, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {edge.symbol}
              </span>
              {edge.kind ? <span style={{ color: 'var(--t-text-faint)', fontFamily: REPO_FOCUS_MONO, fontSize: 10 }}>{edge.kind}</span> : null}
            </div>
            <div style={{ color: 'var(--t-text-faint)', fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {edge.file ? `${edge.file}${edge.line ? `:${edge.line}` : ''}` : 'definition not recorded'}
              {edge.neighbours.length > 0 ? ` · ${edge.neighbours.slice(0, 4).join(', ')}` : ''}
            </div>
          </div>
        ))}
      </Section>
    </div>
  );
}
