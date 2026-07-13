'use client';

import { useState, type CSSProperties, type ReactNode } from 'react';
import type { ClaudePermissionDecision } from '@/components/desktop/workspace-terminal/workspace-stream-events';
import type { ClaudeCodeStreamJsonChatEvent } from '@/lib/claude-code/stream-json-parser';
import type { MobileTranscriptEntry, MobileTranscriptSource } from '@/lib/mobile/types';

type PermissionRequest = Extract<ClaudeCodeStreamJsonChatEvent, { type: 'permission_request' }>;
type PlanStep = Extract<ClaudeCodeStreamJsonChatEvent, { type: 'plan_step' }>;

const UI_FONT = 'var(--font-sans-system)';
const MONO_FONT = '"SF Mono", ui-monospace, Menlo, monospace';
const WEB_TOOL_RE = /(?:web|search|fetch|browse|browser)/i;
const URL_RE = /https?:\/\/[^\s)<>"']+/g;

function hostnameFor(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function sourceLinks(sources?: MobileTranscriptSource[]) {
  return (sources ?? [])
    .filter((source): source is MobileTranscriptSource & { url: string } => (
      typeof source.url === 'string' && source.url.trim().length > 0
    ))
    .map((source) => ({
      title: source.title.trim() || hostnameFor(source.url),
      url: source.url,
      domain: hostnameFor(source.url),
    }));
}

function linksFromToolResults(events: ClaudeCodeStreamJsonChatEvent[]) {
  const links: Array<{ title: string; url: string; domain: string }> = [];
  for (const event of events) {
    if (event.type !== 'tool_result') continue;
    const name = event.name ?? '';
    if (!WEB_TOOL_RE.test(name) && !WEB_TOOL_RE.test(event.preview ?? '')) continue;
    const haystack = [event.output, event.preview].filter(Boolean).join('\n');
    const matches = haystack.match(URL_RE) ?? [];
    for (const rawUrl of matches) {
      const url = rawUrl.replace(/[.,;:!?]+$/, '');
      links.push({ title: hostnameFor(url), url, domain: hostnameFor(url) });
    }
  }
  return links;
}

function webLinksFor(entry: MobileTranscriptEntry) {
  const links = [
    ...sourceLinks(entry.sources),
    ...linksFromToolResults(entry.claudeCodeEvents ?? []),
  ];
  const seen = new Set<string>();
  return links.filter((link) => {
    if (seen.has(link.url)) return false;
    seen.add(link.url);
    return true;
  });
}

function statusColor(status?: string) {
  if (status === 'complete') return 'var(--t-brand-green, var(--t-accent))';
  if (status === 'active') return 'var(--t-brand-orange, var(--t-accent))';
  return 'var(--t-text-faint)';
}

function cardStyle(): CSSProperties {
  return {
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--t-panel-border)',
    borderRadius: 12,
    backgroundColor: 'var(--t-bg-card)',
    boxShadow: 'var(--t-panel-shadow)',
    overflow: 'hidden',
  };
}

function HeaderButton({
  children,
  expanded,
  onClick,
}: {
  children: ReactNode;
  expanded: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        width: '100%',
        minHeight: 38,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        paddingTop: 8,
        paddingRight: 12,
        paddingBottom: 8,
        paddingLeft: 12,
        borderWidth: 0,
        backgroundColor: 'transparent',
        color: 'var(--t-text)',
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: UI_FONT,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          color: 'var(--t-text-faint)',
          transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
          transition: 'transform 160ms cubic-bezier(0.22, 1, 0.36, 1)',
          flexShrink: 0,
        }}
      >
        ›
      </span>
      {children}
    </button>
  );
}

function WebSearchList({ links }: { links: Array<{ title: string; url: string; domain: string }> }) {
  if (links.length === 0) return null;
  return (
    <div style={cardStyle()}>
      <div
        style={{
          paddingTop: 10,
          paddingRight: 12,
          paddingBottom: 8,
          paddingLeft: 12,
          borderBottomWidth: 1,
          borderBottomStyle: 'solid',
          borderBottomColor: 'var(--t-divider-subtle)',
          fontFamily: UI_FONT,
          fontSize: 11,
          fontWeight: 800,
          color: 'var(--t-text)',
        }}
      >
        Web search
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', paddingTop: 4, paddingBottom: 6 }}>
        {links.map((link) => (
          <a
            key={link.url}
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'grid',
              gridTemplateColumns: '14px minmax(0, 1fr)',
              columnGap: 6,
              paddingTop: 5,
              paddingRight: 12,
              paddingBottom: 5,
              paddingLeft: 14,
              color: 'var(--t-text-secondary)',
              textDecoration: 'none',
              fontFamily: UI_FONT,
            }}
          >
            <span aria-hidden="true" style={{ color: 'var(--t-accent)', fontSize: 15, lineHeight: '16px' }}>•</span>
            <span style={{ display: 'flex', minWidth: 0, flexDirection: 'column', gap: 1 }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--t-text)', fontSize: 12, fontWeight: 650 }}>
                {link.title}
              </span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--t-text-faint)', fontSize: 10.5 }}>
                {link.domain}
              </span>
            </span>
          </a>
        ))}
      </div>
    </div>
  );
}

function PlanPill({ steps }: { steps: PlanStep[] }) {
  const [expanded, setExpanded] = useState(false);
  if (steps.length === 0) return null;
  const done = steps.filter((step) => step.status === 'complete').length;
  const active = steps.filter((step) => step.status === 'active').length;
  const numerator = done > 0 ? done : active > 0 ? active : 0;

  return (
    <div style={cardStyle()}>
      <HeaderButton expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--t-text)' }}>
          Plan {numerator}/{steps.length} steps
        </span>
        <span style={{ color: 'var(--t-text-faint)', fontSize: 11, marginLeft: 'auto' }}>
          {expanded ? 'Hide' : 'Open'}
        </span>
      </HeaderButton>
      {expanded ? (
        <div
          style={{
            borderTopWidth: 1,
            borderTopStyle: 'solid',
            borderTopColor: 'var(--t-divider-subtle)',
            paddingTop: 8,
            paddingRight: 12,
            paddingBottom: 10,
            paddingLeft: 12,
          }}
        >
          {steps.map((step, index) => (
            <div
              key={`${step.id ?? step.text}-${index}`}
              style={{
                display: 'grid',
                gridTemplateColumns: '18px minmax(0, 1fr)',
                columnGap: 8,
                paddingTop: 4,
                paddingBottom: 4,
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  backgroundColor: statusColor(step.status),
                  marginTop: 5,
                }}
              />
              <span style={{ color: 'var(--t-text-secondary)', fontSize: 12, lineHeight: 1.45, fontFamily: UI_FONT }}>
                {step.text}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PermissionPrompt({
  request,
  onDecision,
}: {
  request: PermissionRequest;
  onDecision?: (request: PermissionRequest, decision: ClaudePermissionDecision) => Promise<void> | void;
}) {
  const [state, setState] = useState<'idle' | 'approve' | 'deny' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: ClaudePermissionDecision) => {
    if (!onDecision || state === 'approve' || state === 'deny') return;
    setState(decision);
    setError(null);
    try {
      await onDecision(request, decision);
      setState('done');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to send decision.');
      setState('error');
    }
  };

  return (
    <div style={{ ...cardStyle(), borderColor: 'var(--t-brand-orange, var(--t-panel-border))' }}>
      <div
        style={{
          paddingTop: 10,
          paddingRight: 12,
          paddingBottom: 10,
          paddingLeft: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          fontFamily: UI_FONT,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: 999, backgroundColor: 'var(--t-brand-orange, var(--t-accent))' }} />
          <span style={{ color: 'var(--t-text)', fontSize: 12, fontWeight: 850 }}>Permission request</span>
          {request.name ? <span style={{ color: 'var(--t-text-faint)', fontSize: 11, fontFamily: MONO_FONT }}>{request.name}</span> : null}
        </div>
        <div style={{ color: 'var(--t-text-secondary)', fontSize: 12, lineHeight: 1.45 }}>
          {request.text}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            disabled={!onDecision || state === 'approve' || state === 'deny' || state === 'done'}
            onClick={() => { void decide('approve'); }}
            style={{
              minHeight: 28,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'var(--t-accent-border)',
              borderRadius: 8,
              backgroundColor: 'var(--t-accent)',
              color: 'var(--t-on-accent)',
              cursor: state === 'idle' || state === 'error' ? 'pointer' : 'default',
              paddingTop: 0,
              paddingRight: 12,
              paddingBottom: 0,
              paddingLeft: 12,
              fontFamily: UI_FONT,
              fontSize: 11.5,
              fontWeight: 800,
              opacity: state === 'approve' ? 0.72 : 1,
            }}
          >
            {state === 'approve' ? 'Approving...' : state === 'done' ? 'Sent' : 'Approve'}
          </button>
          <button
            type="button"
            disabled={!onDecision || state === 'approve' || state === 'deny' || state === 'done'}
            onClick={() => { void decide('deny'); }}
            style={{
              minHeight: 28,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'var(--t-divider-subtle)',
              borderRadius: 8,
              backgroundColor: 'var(--t-input-bg)',
              color: 'var(--t-brand-red, var(--t-text-secondary))',
              cursor: state === 'idle' || state === 'error' ? 'pointer' : 'default',
              paddingTop: 0,
              paddingRight: 12,
              paddingBottom: 0,
              paddingLeft: 12,
              fontFamily: UI_FONT,
              fontSize: 11.5,
              fontWeight: 800,
              opacity: state === 'deny' ? 0.72 : 1,
            }}
          >
            {state === 'deny' ? 'Denying...' : 'Deny'}
          </button>
          {error ? <span style={{ alignSelf: 'center', color: 'var(--t-brand-red, var(--t-text-secondary))', fontSize: 11 }}>{error}</span> : null}
        </div>
      </div>
    </div>
  );
}

export function WorkspaceTranscriptEventExtras({
  entry,
  onPermissionDecision,
}: {
  entry: MobileTranscriptEntry;
  onPermissionDecision?: (request: PermissionRequest, decision: ClaudePermissionDecision) => Promise<void> | void;
}) {
  const events = entry.claudeCodeEvents ?? [];
  const plans = events.filter((event): event is PlanStep => event.type === 'plan_step');
  const permissions = events.filter((event): event is PermissionRequest => event.type === 'permission_request');
  const webLinks = webLinksFor(entry);

  if (plans.length === 0 && permissions.length === 0 && webLinks.length === 0) return null;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        width: '100%',
        maxWidth: '90%',
        marginTop: 4,
        fontFamily: UI_FONT,
      }}
    >
      <PlanPill steps={plans} />
      {permissions.map((request, index) => (
        <PermissionPrompt
          key={`${request.id ?? request.text}-${index}`}
          request={request}
          onDecision={onPermissionDecision}
        />
      ))}
      <WebSearchList links={webLinks} />
    </div>
  );
}
