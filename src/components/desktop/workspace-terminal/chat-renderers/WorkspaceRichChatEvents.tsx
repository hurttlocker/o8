'use client';

import { useState, type CSSProperties, type ReactNode } from 'react';
import { DiffViewer } from '@/components/desktop/o8-panel/workspace-rail/DiffViewer';
import { ToolCallChipCluster } from '@/components/desktop/thoughts/chat-panel/ToolCallChipCluster';
import {
  deriveFileChangesFromTools,
  type FileChangePreview,
  type LLMMessage,
  type SourceInfo,
  type ToolCallInfo,
} from '@/components/desktop/llm-chat/shared';
import type { ClaudeCodeStreamJsonChatEvent } from '@/lib/claude-code/stream-json-parser';
import type { ClaudePermissionDecision } from '@/components/desktop/workspace-terminal/workspace-stream-events';
import type { MobileTranscriptToolCall } from '@/lib/mobile/types';

type PermissionRequest = Extract<ClaudeCodeStreamJsonChatEvent, { type: 'permission_request' }>;
type PlanStep = Extract<ClaudeCodeStreamJsonChatEvent, { type: 'plan_step' }>;
type ToolCallEvent = Extract<ClaudeCodeStreamJsonChatEvent, { type: 'tool_call' }>;
type ToolResultEvent = Extract<ClaudeCodeStreamJsonChatEvent, { type: 'tool_result' }>;

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

function eventToolCalls(events: ClaudeCodeStreamJsonChatEvent[]): ToolCallInfo[] {
  return events
    .filter((event): event is ToolCallEvent => event.type === 'tool_call')
    .map((event) => ({
      name: event.name,
      status: event.status,
      args: event.args,
      preview: event.preview,
    }));
}

function dedupeFileChanges(changes: FileChangePreview[]) {
  const seen = new Set<string>();
  return changes.filter((change) => {
    const key = [change.path, change.tool, change.oldText, change.newText, change.content].join('\u0000');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sourceLinks(sources?: SourceInfo[]) {
  return (sources ?? [])
    .filter((source): source is SourceInfo & { url: string } => typeof source.url === 'string' && source.url.trim().length > 0)
    .map((source) => ({
      title: source.title?.trim() || hostnameFor(source.url),
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

function webLinksFor(message: LLMMessage) {
  const links = [...sourceLinks(message.sources), ...linksFromToolResults(message.claudeCodeEvents ?? [])];
  const seen = new Set<string>();
  return links.filter((link) => {
    if (seen.has(link.url)) return false;
    seen.add(link.url);
    return true;
  });
}

function statusColor(status?: string) {
  if (status === 'done' || status === 'complete') return 'var(--t-brand-green, var(--t-accent))';
  if (status === 'active' || status === 'running' || status === 'calling') return 'var(--t-brand-orange, var(--t-accent))';
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

function FilesChangedBlock({ changes, repoPath }: { changes: FileChangePreview[]; repoPath?: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const [selectedPath, setSelectedPath] = useState(changes[0]?.path ?? null);
  if (changes.length === 0) return null;

  const additions = changes.reduce((sum, change) => sum + change.additions, 0);
  const deletions = changes.reduce((sum, change) => sum + change.deletions, 0);
  const selected = changes.some((change) => change.path === selectedPath)
    ? selectedPath
    : changes[0]?.path ?? null;

  return (
    <div style={cardStyle()}>
      <HeaderButton expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 750, color: 'var(--t-text)' }}>
          {changes.length} {changes.length === 1 ? 'file' : 'files'} changed
        </span>
        <span style={{ fontSize: 11, fontWeight: 750, color: 'var(--t-brand-green, var(--t-accent))' }}>+{additions}</span>
        <span style={{ fontSize: 11, fontWeight: 750, color: 'var(--t-brand-red, var(--t-text-secondary))' }}>-{deletions}</span>
      </HeaderButton>
      {expanded ? (
        <div
          style={{
            borderTopWidth: 1,
            borderTopStyle: 'solid',
            borderTopColor: 'var(--t-divider-subtle)',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {changes.map((change) => {
              const active = selected === change.path;
              return (
                <button
                  key={change.id}
                  type="button"
                  onClick={() => setSelectedPath(change.path)}
                  style={{
                    minHeight: 34,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    paddingTop: 7,
                    paddingRight: 12,
                    paddingBottom: 7,
                    paddingLeft: 28,
                    borderWidth: 0,
                    borderTopWidth: 1,
                    borderTopStyle: 'solid',
                    borderTopColor: 'var(--t-divider-subtle)',
                    backgroundColor: active ? 'var(--t-accent-soft)' : 'transparent',
                    color: active ? 'var(--t-accent)' : 'var(--t-text-secondary)',
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontFamily: UI_FONT,
                  }}
                >
                  <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11.5 }}>
                    {change.path}
                  </span>
                  <span style={{ fontSize: 10.5, fontWeight: 750, color: 'var(--t-brand-green, var(--t-accent))' }}>+{change.additions}</span>
                  <span style={{ fontSize: 10.5, fontWeight: 750, color: 'var(--t-brand-red, var(--t-text-secondary))' }}>-{change.deletions}</span>
                </button>
              );
            })}
          </div>
          {selected ? (
            <div
              style={{
                height: 230,
                display: 'flex',
                minHeight: 0,
                borderTopWidth: 1,
                borderTopStyle: 'solid',
                borderTopColor: 'var(--t-divider-subtle)',
                backgroundColor: 'var(--t-panel)',
              }}
            >
              <DiffViewer repoPath={repoPath} selectedFile={selected} mode="unified" />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
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
            <div key={`${step.id ?? step.text}-${index}`} style={{ display: 'grid', gridTemplateColumns: '18px minmax(0, 1fr)', columnGap: 8, paddingTop: 4, paddingBottom: 4 }}>
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

function ToolCards({
  events,
  toolCalls,
}: {
  events: ClaudeCodeStreamJsonChatEvent[];
  toolCalls?: ToolCallInfo[];
}) {
  const results = events.filter((event): event is ToolResultEvent => event.type === 'tool_result');
  const calls = events.filter((event): event is ToolCallEvent => event.type === 'tool_call');
  const visibleCalls: MobileTranscriptToolCall[] = calls.length > 0
    ? eventToolCalls(events).map((tool, index) => {
      const result = results.find((candidate) => (
        candidate.id && calls[index]?.id
          ? candidate.id === calls[index]?.id
          : candidate.name === tool.name
      ));
      return {
        ...tool,
        result: result?.output ?? result?.preview,
      };
    })
    : (toolCalls ?? []);
  if (visibleCalls.length === 0) return null;

  return (
    <ToolCallChipCluster toolCalls={visibleCalls} />
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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to send decision.');
      setState('error');
    }
  };

  return (
    <div
      style={{
        ...cardStyle(),
        borderColor: 'var(--t-brand-orange, var(--t-panel-border))',
      }}
    >
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

export function messageUsesWorkspaceRichRenderers(message: LLMMessage) {
  return Boolean(
    message.claudeCodeEvents?.length
    || message.toolCalls?.length
    || webLinksFor(message).length,
  );
}

export function stripWorkspaceRichRendererFallback(message: LLMMessage): LLMMessage {
  if (!messageUsesWorkspaceRichRenderers(message)) return message;
  return {
    ...message,
    toolCalls: undefined,
    sources: undefined,
  };
}

export function WorkspaceRichChatEvents({
  message,
  repoPath,
  onPermissionDecision,
}: {
  message: LLMMessage;
  repoPath?: string | null;
  onPermissionDecision?: (request: PermissionRequest, decision: ClaudePermissionDecision) => Promise<void> | void;
}) {
  const events = message.claudeCodeEvents ?? [];
  const plans = events.filter((event): event is PlanStep => event.type === 'plan_step');
  const permissions = events.filter((event): event is PermissionRequest => event.type === 'permission_request');
  const webLinks = webLinksFor(message);
  const fileChanges = dedupeFileChanges(deriveFileChangesFromTools([...(message.toolCalls ?? []), ...eventToolCalls(events)]));

  if (!messageUsesWorkspaceRichRenderers(message)) return null;

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
      <FilesChangedBlock changes={fileChanges} repoPath={repoPath} />
      <WebSearchList links={webLinks} />
      <ToolCards events={events} toolCalls={message.toolCalls} />
    </div>
  );
}
