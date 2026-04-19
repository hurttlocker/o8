'use client';

import type { ReactNode } from 'react';
import {
  APP_FONT_STACK,
  MONO_FONT_STACK,
  RAMS_ACCENT,
  RAMS_HAIRLINE_SOFT,
  RAMS_INK_QUIET,
  BracketLabel,
  FieldLabel,
} from '../shared';
import { Globe, Plus, Terminal, Trash2 } from '../../lucide-shims';
import {
  countEnvKeys,
  formatServerDetail,
  MONO_FONT,
  type ExternalMcpTransport,
} from './shared';
import { useExternalMcpServers } from './useExternalMcpServers';

function BuiltinServerPill({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      fontFamily: MONO_FONT_STACK,
      fontSize: 11,
      fontWeight: 400,
      letterSpacing: '0.12em',
      textTransform: 'uppercase',
      color: RAMS_INK_QUIET,
    }}>
      <span style={{ display: 'inline-flex', color: RAMS_INK_QUIET }}>{icon}</span>
      ({label})
    </span>
  );
}

export function ExternalMcpServersSection() {
  const {
    servers,
    loading,
    error,
    note,
    actionId,
    creating,
    form,
    setForm,
    create,
    toggle,
    remove,
  } = useExternalMcpServers();

  return (
    <div>
      <p style={{
        fontSize: 13,
        color: 'var(--t-text-secondary)',
        lineHeight: 1.55,
        maxWidth: 580,
        margin: 0,
        marginBottom: 12,
      }}>
        Attach extra MCP servers to orchestrator turns. Built-in operator + cortex servers always stay attached; these rows only add more context sources.
      </p>

      <div style={{
        paddingTop: 16,
        paddingBottom: 16,
        borderTop: `1px solid ${RAMS_HAIRLINE_SOFT}`,
        borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          flexWrap: 'wrap',
        }}>
          <span style={{
            fontFamily: MONO_FONT_STACK,
            fontSize: 10,
            fontWeight: 400,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: RAMS_INK_QUIET,
          }}>
            always attached
          </span>
          <BuiltinServerPill icon={<Terminal size={11} strokeWidth={1.8} />} label="operator" />
          <BuiltinServerPill icon={<Globe size={11} strokeWidth={1.8} />} label="cortex" />
        </div>

        {note ? (
          <div style={{
            borderLeft: `2px solid ${note.ok ? '#22c55e' : '#ef4444'}`,
            paddingLeft: 12,
            fontSize: 12,
            color: note.ok ? '#15803d' : '#dc2626',
            lineHeight: 1.55,
          }}>
            {note.message}
          </div>
        ) : null}

        {error ? (
          <div style={{
            borderLeft: `2px solid #ef4444`,
            paddingLeft: 12,
            fontSize: 12,
            color: '#dc2626',
            lineHeight: 1.55,
          }}>
            {error}
          </div>
        ) : null}

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 160px)',
          gap: 18,
        }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <FieldLabel>name</FieldLabel>
            <input
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              placeholder="slack-context"
              style={inputStyle()}
              onFocus={(e) => { e.currentTarget.style.borderBottomColor = RAMS_ACCENT; }}
              onBlur={(e) => { e.currentTarget.style.borderBottomColor = RAMS_HAIRLINE_SOFT; }}
            />
          </label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <FieldLabel>transport</FieldLabel>
            <div style={{ display: 'flex', gap: 18, alignItems: 'center', paddingTop: 6, paddingBottom: 7 }}>
              {(['stdio', 'http'] as ExternalMcpTransport[]).map((transport) => {
                const active = form.transport === transport;
                return (
                  <button
                    key={transport}
                    type="button"
                    onClick={() => setForm((current) => ({ ...current, transport }))}
                    style={{
                      fontFamily: MONO_FONT_STACK,
                      fontSize: 11,
                      fontWeight: 400,
                      letterSpacing: '0.14em',
                      textTransform: 'uppercase',
                      color: active ? RAMS_ACCENT : 'var(--t-text-muted)',
                      background: 'transparent',
                      border: 'none',
                      borderBottom: `1px solid ${active ? RAMS_ACCENT : RAMS_HAIRLINE_SOFT}`,
                      paddingTop: 2,
                      paddingBottom: 2,
                      paddingLeft: 0,
                      paddingRight: 0,
                      cursor: 'pointer',
                    }}
                  >
                    ({transport})
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <FieldLabel>{form.transport === 'http' ? 'endpoint url' : 'command'}</FieldLabel>
          <input
            value={form.command}
            onChange={(event) => setForm((current) => ({ ...current, command: event.target.value }))}
            placeholder={form.transport === 'http' ? 'https://mcp.example.com/mcp' : 'npx'}
            style={inputStyle()}
            onFocus={(e) => { e.currentTarget.style.borderBottomColor = RAMS_ACCENT; }}
            onBlur={(e) => { e.currentTarget.style.borderBottomColor = RAMS_HAIRLINE_SOFT; }}
          />
        </label>

        {form.transport === 'stdio' ? (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
            gap: 18,
          }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <FieldLabel>args json array</FieldLabel>
              <textarea
                value={form.argsJson}
                onChange={(event) => setForm((current) => ({ ...current, argsJson: event.target.value }))}
                rows={4}
                spellCheck={false}
                style={textareaStyle()}
                onFocus={(e) => { e.currentTarget.style.borderColor = RAMS_ACCENT; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = RAMS_HAIRLINE_SOFT; }}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <FieldLabel>env json object</FieldLabel>
              <textarea
                value={form.envJson}
                onChange={(event) => setForm((current) => ({ ...current, envJson: event.target.value }))}
                rows={4}
                spellCheck={false}
                style={textareaStyle()}
                onFocus={(e) => { e.currentTarget.style.borderColor = RAMS_ACCENT; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = RAMS_HAIRLINE_SOFT; }}
              />
            </label>
          </div>
        ) : (
          <div style={{
            fontSize: 12,
            color: RAMS_INK_QUIET,
            lineHeight: 1.55,
          }}>
            HTTP servers use the endpoint URL above. Args and env are only stored for stdio transports.
          </div>
        )}

        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 20,
          flexWrap: 'wrap',
        }}>
          <button
            type="button"
            onClick={() => setForm((current) => ({ ...current, enabled: !current.enabled }))}
            style={{
              fontFamily: MONO_FONT_STACK,
              fontSize: 11,
              fontWeight: 400,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: form.enabled ? RAMS_ACCENT : 'var(--t-text-muted)',
              background: 'transparent',
              border: 'none',
              borderBottom: `1px solid ${form.enabled ? RAMS_ACCENT : RAMS_HAIRLINE_SOFT}`,
              paddingTop: 2,
              paddingBottom: 2,
              paddingLeft: 0,
              paddingRight: 0,
              cursor: 'pointer',
            }}
          >
            {form.enabled ? '(enabled on add)' : '(added disabled)'}
          </button>

          <button
            type="button"
            onClick={() => { void create(); }}
            disabled={creating}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              fontFamily: APP_FONT_STACK,
              fontSize: 13,
              fontWeight: 400,
              color: creating ? RAMS_INK_QUIET : RAMS_ACCENT,
              background: 'transparent',
              border: 'none',
              borderBottom: `1px solid ${creating ? RAMS_HAIRLINE_SOFT : RAMS_ACCENT}`,
              paddingTop: 2,
              paddingBottom: 2,
              paddingLeft: 0,
              paddingRight: 0,
              cursor: creating ? 'default' : 'pointer',
              letterSpacing: '-0.005em',
              opacity: creating ? 0.6 : 1,
            }}
          >
            <Plus size={12} strokeWidth={2} />
            {creating ? 'adding...' : 'add server ›'}
          </button>
        </div>
      </div>

      <div style={{
        display: 'flex',
        flexDirection: 'column',
      }}>
        {loading ? (
          <div style={{
            fontSize: 13,
            color: RAMS_INK_QUIET,
            paddingTop: 14,
            paddingBottom: 14,
          }}>
            Loading external MCP servers...
          </div>
        ) : servers.length === 0 ? (
          <div style={{
            fontSize: 13,
            color: RAMS_INK_QUIET,
            lineHeight: 1.55,
            paddingTop: 14,
            paddingBottom: 14,
          }}>
            No external servers configured. Add a stdio process or HTTP endpoint to make extra MCP context available on orchestrator turns.
          </div>
        ) : servers.map((server) => {
          const busy = actionId === server.id;
          const envCount = countEnvKeys(server.envJson);
          return (
            <div
              key={server.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                paddingTop: 14,
                paddingBottom: 14,
                borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
              }}
            >
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
                    fontWeight: 500,
                    color: 'var(--t-text)',
                    letterSpacing: '-0.01em',
                  }}>
                    {server.name}
                  </span>
                  <BracketLabel tone="quiet">{server.transport}</BracketLabel>
                  <BracketLabel tone={server.enabled ? 'accent' : 'quiet'}>
                    {server.enabled ? 'enabled' : 'disabled'}
                  </BracketLabel>
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
                {server.transport === 'stdio' && envCount > 0 ? (
                  <div style={{
                    marginTop: 4,
                    fontSize: 11,
                    color: RAMS_INK_QUIET,
                    fontFamily: MONO_FONT_STACK,
                    letterSpacing: '0.04em',
                  }}>
                    env {envCount} var{envCount === 1 ? '' : 's'}
                  </div>
                ) : null}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexShrink: 0 }}>
                <button
                  type="button"
                  onClick={() => { void toggle(server); }}
                  disabled={busy}
                  style={{
                    fontFamily: MONO_FONT_STACK,
                    fontSize: 11,
                    fontWeight: 400,
                    letterSpacing: '0.14em',
                    textTransform: 'uppercase',
                    color: 'var(--t-text-muted)',
                    background: 'transparent',
                    border: 'none',
                    borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
                    paddingTop: 2,
                    paddingBottom: 2,
                    paddingLeft: 0,
                    paddingRight: 0,
                    cursor: busy ? 'default' : 'pointer',
                    opacity: busy ? 0.6 : 1,
                  }}
                >
                  {busy ? 'working...' : server.enabled ? 'disable' : 'enable'}
                </button>
                <button
                  type="button"
                  onClick={() => { void remove(server); }}
                  disabled={busy}
                  aria-label={`Remove ${server.name}`}
                  style={{
                    color: 'var(--t-text-muted)',
                    background: 'transparent',
                    border: 'none',
                    padding: 0,
                    display: 'inline-flex',
                    cursor: busy ? 'default' : 'pointer',
                    opacity: busy ? 0.6 : 1,
                  }}
                >
                  <Trash2 size={14} strokeWidth={1.8} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function inputStyle(): React.CSSProperties {
  return {
    fontFamily: APP_FONT_STACK,
    fontSize: 13,
    fontWeight: 400,
    letterSpacing: '-0.005em',
    color: 'var(--t-text)',
    background: 'transparent',
    border: 'none',
    borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
    paddingTop: 6,
    paddingBottom: 6,
    paddingLeft: 0,
    paddingRight: 0,
    outline: 'none',
    width: '100%',
  };
}

function textareaStyle(): React.CSSProperties {
  return {
    fontFamily: MONO_FONT,
    fontSize: 12,
    fontWeight: 400,
    letterSpacing: '0.02em',
    lineHeight: 1.55,
    color: 'var(--t-text)',
    background: 'transparent',
    border: `1px solid ${RAMS_HAIRLINE_SOFT}`,
    borderRadius: 4,
    paddingTop: 8,
    paddingBottom: 8,
    paddingLeft: 10,
    paddingRight: 10,
    outline: 'none',
    width: '100%',
    resize: 'vertical',
  };
}
