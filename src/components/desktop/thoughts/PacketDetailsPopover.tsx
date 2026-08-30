'use client';

/**
 * PacketDetailsPopover (#615) — read-only floating popover anchored to the
 * DETAILS row on an expanded packet card. Renders four sections:
 * PROMPT / FILE ALLOWLIST / LEARNED RULES / ISSUE.
 *
 * Positioning: absolutely-positioned via React portal (escapes card overflow).
 * Anchored to the left of the row (opens left). Dismisses on Esc +
 * pointerdown outside the popover.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { TerminalStatusEvidenceDisclosure } from '@/components/desktop/TerminalStatusEvidenceRows';
import { useOrchestratorData } from '@/components/desktop/orchestrator-data-context';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const FONT_BODY = 'var(--font-sans-system)';
const FONT_MONO = "'SF Mono', Menlo, monospace";
const POPOVER_WIDTH = 360;
const POPOVER_MAX_HEIGHT = 480;
const POPOVER_GAP = 12;
const VIEWPORT_MARGIN = 12;

interface PacketDetailsPopoverProps {
  packet: OrchestratorPacket;
  anchorRect: DOMRect | null;
  onClose: () => void;
}

interface PopoverPosition {
  top: number;
  left: number;
}

function computePosition(anchorRect: DOMRect): PopoverPosition {
  const viewportWidth = typeof window === 'undefined' ? POPOVER_WIDTH + 64 : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? POPOVER_MAX_HEIGHT + 64 : window.innerHeight;

  const desiredLeft = anchorRect.left - POPOVER_GAP - POPOVER_WIDTH;
  const canOpenLeft = desiredLeft >= VIEWPORT_MARGIN;
  const left = canOpenLeft
    ? desiredLeft
    : Math.max(VIEWPORT_MARGIN, Math.min(anchorRect.right + POPOVER_GAP, viewportWidth - POPOVER_WIDTH - VIEWPORT_MARGIN));

  const desiredTop = anchorRect.top;
  const top = Math.max(
    VIEWPORT_MARGIN,
    Math.min(desiredTop, viewportHeight - POPOVER_MAX_HEIGHT - VIEWPORT_MARGIN),
  );

  return { top, left };
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div
        style={{
          fontFamily: FONT_BODY,
          fontSize: 9,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--t-text-muted)',
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function EmptyValue() {
  return (
    <div
      style={{
        fontFamily: FONT_BODY,
        fontSize: 11,
        color: 'var(--t-text-faint)',
        fontStyle: 'italic',
      }}
    >
      —
    </div>
  );
}

export function PacketDetailsPopover({ packet, anchorRect, onClose }: PacketDetailsPopoverProps) {
  const orchestratorData = useOrchestratorData();
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [viewportRevision, setViewportRevision] = useState(0);
  const portalHost = useSyncExternalStore(() => () => {}, () => document.body, () => null);
  const position = (() => {
    void viewportRevision;
    return anchorRect ? computePosition(anchorRect) : null;
  })();

  useEffect(() => {
    if (!anchorRect) return;
    function handleResize() {
      setViewportRevision((current) => current + 1);
    }
    window.addEventListener('resize', handleResize);
    window.addEventListener('scroll', handleResize, true);
    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('scroll', handleResize, true);
    };
  }, [anchorRect]);

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    }
    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node | null;
      if (!target) return;
      if (popoverRef.current && popoverRef.current.contains(target)) return;
      onClose();
    }
    window.addEventListener('keydown', handleKey, true);
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      window.removeEventListener('keydown', handleKey, true);
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [onClose]);

  const prompt = useMemo(() => {
    if (packet.prompt && packet.prompt.trim()) return packet.prompt.trim();
    const fallback = [packet.title, packet.summary]
      .map((value) => value?.trim() ?? '')
      .filter(Boolean)
      .join('\n\n');
    return fallback || null;
  }, [packet.prompt, packet.title, packet.summary]);

  const allowedFiles = useMemo(() => {
    const files = packet.allowedFiles ?? packet.predictedFiles ?? [];
    return files.filter((file) => typeof file === 'string' && file.trim().length > 0);
  }, [packet.allowedFiles, packet.predictedFiles]);

  const learnedRules = useMemo(() => {
    const rules = packet.learnedRules ?? [];
    return rules.filter((rule) => typeof rule === 'string' && rule.trim().length > 0);
  }, [packet.learnedRules]);

  const issueBody = useMemo(() => {
    const raw = packet.issue?.body?.trim() ?? '';
    if (!raw) return null;
    if (raw.length <= 600) return raw;
    return `${raw.slice(0, 600).trimEnd()}…`;
  }, [packet.issue?.body]);

  const issueUrl = packet.issue?.url?.trim() ?? null;
  const issueNumber = packet.issue?.number ?? null;
  const hasIssueSection = Boolean(issueBody || issueUrl || issueNumber);
  const statusEvidence = useMemo(() => {
    if (packet.statusEvidence) return packet.statusEvidence;
    const sessionKey = packet.lane?.sessionKey;
    if (!sessionKey) return undefined;
    return orchestratorData?.agents.find((agent) => agent.sessionKey === sessionKey)?.statusEvidence;
  }, [orchestratorData?.agents, packet.lane?.sessionKey, packet.statusEvidence]);

  if (!portalHost || !anchorRect || !position) return null;

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-label="Packet details"
      style={{
        position: 'fixed',
        top: position.top,
        left: position.left,
        width: POPOVER_WIDTH,
        maxHeight: POPOVER_MAX_HEIGHT,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--t-bg-card)',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-border-subtle)',
        borderRadius: 14,
        boxShadow: '0 16px 42px rgba(0, 0, 0, 0.22)',
        zIndex: 1000,
        overflow: 'hidden',
        fontFamily: FONT_BODY,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingTop: 10,
          paddingRight: 12,
          paddingBottom: 10,
          paddingLeft: 14,
          borderBottomWidth: 1,
          borderBottomStyle: 'solid',
          borderBottomColor: 'var(--t-border-subtle)',
          background: 'var(--t-bg-card)',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span
            style={{
              fontSize: 9,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: 'var(--t-text-muted)',
            }}
          >
            {packet.referenceLabel} · Details
          </span>
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--t-text)',
              letterSpacing: '-0.01em',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              marginTop: 2,
            }}
          >
            {packet.title}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close details"
          style={{
            flexShrink: 0,
            width: 22,
            height: 22,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderWidth: 0,
            background: 'transparent',
            color: 'var(--t-text-muted)',
            fontSize: 16,
            lineHeight: 1,
            cursor: 'pointer',
            borderRadius: 6,
          }}
          onMouseEnter={(event) => {
            event.currentTarget.style.background = 'var(--t-divider-subtle)';
            event.currentTarget.style.color = 'var(--t-text)';
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.background = 'transparent';
            event.currentTarget.style.color = 'var(--t-text-muted)';
          }}
        >
          &times;
        </button>
      </div>

      <div
        style={{
          overflowY: 'auto',
          paddingTop: 12,
          paddingRight: 14,
          paddingBottom: 14,
          paddingLeft: 14,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        {statusEvidence ? (
          <Section label="Status diagnostics">
            <TerminalStatusEvidenceDisclosure evidence={statusEvidence} defaultExpanded />
          </Section>
        ) : null}

        <Section label="Prompt">
          {prompt ? (
            <pre
              style={{
                margin: 0,
                fontFamily: FONT_MONO,
                fontSize: 11,
                lineHeight: 1.5,
                color: 'var(--t-text)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                background: 'var(--t-panel, rgba(0,0,0,0.02))',
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: 'var(--t-border-subtle)',
                borderRadius: 8,
                paddingTop: 8,
                paddingRight: 10,
                paddingBottom: 8,
                paddingLeft: 10,
              }}
            >
              {prompt}
            </pre>
          ) : (
            <EmptyValue />
          )}
        </Section>

        <Section label="File Allowlist">
          {allowedFiles.length > 0 ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {allowedFiles.map((file) => (
                <span
                  key={file}
                  title={file}
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 10.5,
                    color: 'var(--t-text)',
                    background: 'var(--t-divider-subtle)',
                    borderRadius: 6,
                    paddingTop: 3,
                    paddingRight: 7,
                    paddingBottom: 3,
                    paddingLeft: 7,
                    maxWidth: '100%',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    display: 'inline-block',
                  }}
                >
                  {file}
                </span>
              ))}
            </div>
          ) : (
            <EmptyValue />
          )}
        </Section>

        <Section label="Learned Rules">
          {learnedRules.length > 0 ? (
            <ul
              style={{
                listStyle: 'disc',
                paddingLeft: 18,
                margin: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              {learnedRules.map((rule, index) => (
                <li
                  key={`${index}-${rule.slice(0, 24)}`}
                  style={{
                    fontFamily: FONT_BODY,
                    fontSize: 11.5,
                    lineHeight: 1.45,
                    color: 'var(--t-text)',
                    letterSpacing: '-0.005em',
                  }}
                >
                  {rule}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyValue />
          )}
        </Section>

        {hasIssueSection ? (
          <Section label={issueNumber ? `Issue #${issueNumber}` : 'Issue'}>
            {issueBody ? (
              <pre
                style={{
                  margin: 0,
                  fontFamily: FONT_BODY,
                  fontSize: 11.5,
                  lineHeight: 1.5,
                  color: 'var(--t-text)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  letterSpacing: '-0.005em',
                }}
              >
                {issueBody}
              </pre>
            ) : null}
            {issueUrl ? (
              <a
                href={issueUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  fontFamily: FONT_BODY,
                  fontSize: 11,
                  fontWeight: 600,
                  color: '#2563eb',
                  textDecoration: 'none',
                  marginTop: 4,
                  letterSpacing: '-0.005em',
                }}
              >
                View on GitHub &rsaquo;
              </a>
            ) : null}
          </Section>
        ) : null}
      </div>
    </div>,
    portalHost,
  );
}
