'use client';

import { useMemo } from 'react';

import {
  APP_FONT_STACK,
  RAMS_CONTROL_BG,
  RAMS_CONTROL_BORDER,
  RAMS_HAIRLINE_SOFT,
  RAMS_INK_QUIET,
  BracketLabel,
  SettingsToggleButton,
} from '../shared';
import { Globe, Terminal } from '../../lucide-shims';
import {
  formatServerDetail,
  MONO_FONT,
  type ExternalMcpServer,
} from './shared';
import type { McpServerTestOutcome } from './useExternalMcpServers';

export function ExternalMcpServerRow({
  server,
  busy,
  testing,
  testingNpxFamily,
  outcome,
  envCount,
  expandedStderr,
  pendingRemoval,
  onTest,
  onToggleWorkerInjection,
  onToggleSymonInjection,
  onRemoveRequest,
  onRemoveConfirm,
  onRemoveCancel,
  onToggleStderr,
}: {
  server: ExternalMcpServer;
  busy: boolean;
  testing: boolean;
  testingNpxFamily: boolean;
  outcome: McpServerTestOutcome | undefined;
  envCount: number;
  expandedStderr: boolean;
  pendingRemoval: boolean;
  onTest: () => void;
  onToggleWorkerInjection: () => void;
  onToggleSymonInjection: () => void;
  onRemoveRequest: () => void;
  onRemoveConfirm: () => void;
  onRemoveCancel: () => void;
  onToggleStderr: () => void;
}) {
  const status = useMemo<{ label: string; tone: 'quiet' | 'accent'; color: string }>(() => {
    if (testing) {
      const label = testingNpxFamily ? 'testing — fetching package…' : 'testing…';
      return { label, tone: 'quiet', color: RAMS_INK_QUIET };
    }
    if (outcome?.ok) {
      const count = typeof outcome.toolCount === 'number' ? outcome.toolCount : undefined;
      const secs = typeof outcome.durationMs === 'number'
        ? `${(outcome.durationMs / 1000).toFixed(1)}s`
        : undefined;
      const label = count !== undefined
        ? `ok · ${count} tool${count === 1 ? '' : 's'}${secs ? ` · ${secs}` : ''}`
        : 'ok';
      return { label, tone: 'quiet', color: 'var(--t-text)' };
    }
    if (outcome && !outcome.ok) return { label: 'failed', tone: 'accent', color: '#dc2626' };
    if (!server.enabled) return { label: 'disabled', tone: 'quiet', color: RAMS_INK_QUIET };
    return { label: 'pending', tone: 'quiet', color: RAMS_INK_QUIET };
  }, [outcome, server.enabled, testing, testingNpxFamily]);

  return (
    <div style={{
      paddingTop: 14,
      paddingBottom: 14,
      borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{
          width: 26,
          height: 26,
          display: 'grid',
          placeItems: 'center',
          color: server.transport === 'http' ? 'var(--t-text-secondary)' : 'var(--t-text-muted)',
          flexShrink: 0,
        }}>
          {server.transport === 'http'
            ? <Globe size={16} strokeWidth={1.8} />
            : <Terminal size={16} strokeWidth={1.8} />}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={{
              fontSize: 14,
              fontWeight: 300,
              color: 'var(--t-text)',
              letterSpacing: '-0.01em',
            }}>
              {server.name}
            </span>
            <BracketLabel tone="quiet">{server.transport}</BracketLabel>
            {envCount > 0 ? (
              <span style={{
                fontFamily: APP_FONT_STACK,
                fontSize: 10,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                color: RAMS_INK_QUIET,
              }}>
                env {envCount}
              </span>
            ) : null}
          </div>
          <div style={{
            marginTop: 4,
            fontSize: 12,
            color: 'var(--t-text-secondary)',
            fontFamily: MONO_FONT,
            lineHeight: 1.55,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {formatServerDetail(server)}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexShrink: 0 }}>
          {server.transport === 'stdio' ? (
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 10,
              color: 'var(--t-text-secondary)',
              fontFamily: APP_FONT_STACK,
              fontSize: 11,
              fontWeight: 300,
              letterSpacing: '-0.005em',
            }}>
              Attach to supported workers
              <SettingsToggleButton
                checked={server.workerInjection}
                onChange={onToggleWorkerInjection}
                disabled={busy || pendingRemoval}
                activeLabel="Attached to supported workers"
                inactiveLabel="Not attached to supported workers"
              />
            </span>
          ) : null}
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 10,
            color: 'var(--t-text-secondary)',
            fontFamily: APP_FONT_STACK,
            fontSize: 11,
            fontWeight: 300,
            letterSpacing: '-0.005em',
          }}>
            Attach to Symon
            <SettingsToggleButton
              checked={server.symonInjection}
              onChange={onToggleSymonInjection}
              disabled={busy || pendingRemoval}
              activeLabel="Attached to Symon"
              inactiveLabel="Not attached to Symon"
            />
          </span>
          <span style={{
            fontFamily: APP_FONT_STACK,
            fontSize: 11,
            fontWeight: 400,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: status.color,
          }}>
            ({status.label})
          </span>
          <span style={{ width: 1, height: 12, background: RAMS_HAIRLINE_SOFT }} />
          <button
            type="button"
            onClick={onTest}
            disabled={testing || busy || pendingRemoval}
            style={rowLinkStyle(testing || busy || pendingRemoval)}
          >
            {testing ? (testingNpxFamily ? 'fetching…' : 'testing…') : 'test'}
          </button>
          {pendingRemoval ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{
                fontFamily: APP_FONT_STACK,
                fontSize: 11,
                fontWeight: 400,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                color: '#dc2626',
              }}>
                remove?
              </span>
              <button type="button" onClick={onRemoveConfirm} style={rowLinkStyle(false)}>
                yes
              </button>
              <button type="button" onClick={onRemoveCancel} style={rowLinkStyle(false)}>
                cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={onRemoveRequest}
              disabled={busy}
              style={rowLinkStyle(busy)}
            >
              remove
            </button>
          )}
        </div>
      </div>

      {outcome && !outcome.ok ? (
        <div style={{
          marginTop: 8,
          marginLeft: 40,
          fontSize: 12,
          color: '#dc2626',
          lineHeight: 1.5,
        }}>
          <div>{outcome.error || 'Test failed.'}</div>
          {outcome.stderr ? (
            <div style={{ marginTop: 6 }}>
              <button type="button" onClick={onToggleStderr} style={rowLinkStyle(false)}>
                {expandedStderr ? 'hide stderr' : 'show stderr'}
              </button>
              {expandedStderr ? (
                <pre style={{
                  marginTop: 6,
                  marginBottom: 0,
                  background: 'var(--t-input-bg)',
                  border: `1px solid ${RAMS_HAIRLINE_SOFT}`,
                  borderRadius: 4,
                  paddingTop: 10,
                  paddingBottom: 10,
                  paddingLeft: 12,
                  paddingRight: 12,
                  fontFamily: MONO_FONT,
                  fontSize: 11,
                  color: 'var(--t-text-secondary)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  maxHeight: 240,
                  overflow: 'auto',
                }}>{outcome.stderr}</pre>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function rowLinkStyle(disabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 32,
    paddingLeft: 11,
    paddingRight: 11,
    borderRadius: 9,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: RAMS_CONTROL_BORDER,
    background: disabled ? 'transparent' : RAMS_CONTROL_BG,
    fontFamily: APP_FONT_STACK,
    fontSize: 12,
    fontWeight: 400,
    letterSpacing: '-0.01em',
    textTransform: 'capitalize',
    color: disabled ? RAMS_INK_QUIET : 'var(--t-text-secondary)',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.6 : 1,
    transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), border-color 150ms cubic-bezier(0.22, 1, 0.36, 1), color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
  };
}
