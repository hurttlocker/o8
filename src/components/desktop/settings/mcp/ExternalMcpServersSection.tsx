'use client';

import type { ReactNode } from 'react';
import { APP_FONT_STACK } from '../shared';
import { Globe, Plus, Terminal, Trash2 } from '../../lucide-shims';
import {
  countEnvKeys,
  formatServerDetail,
  INPUT_STYLE,
  MONO_FONT,
  TEXTAREA_STYLE,
  type ExternalMcpTransport,
} from './shared';
import { useExternalMcpServers } from './useExternalMcpServers';

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{
        fontSize: 15,
        fontWeight: 600,
        color: 'var(--t-text)',
        letterSpacing: '-0.01em',
      }}>
        {title}
      </div>
      {subtitle ? (
        <div style={{
          fontSize: 12,
          color: 'var(--t-text-muted)',
          marginTop: 4,
          lineHeight: 1.5,
        }}>
          {subtitle}
        </div>
      ) : null}
    </div>
  );
}

function BuiltinServerPill({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      paddingTop: 6,
      paddingRight: 10,
      paddingBottom: 6,
      paddingLeft: 10,
      borderRadius: 999,
      border: '1px solid rgba(143, 180, 255, 0.24)',
      background: 'rgba(143, 180, 255, 0.12)',
      color: 'var(--t-text)',
      fontSize: 11,
      fontWeight: 600,
      fontFamily: APP_FONT_STACK,
    }}>
      <span style={{ display: 'inline-flex', color: 'var(--t-accent)' }}>{icon}</span>
      {label}
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
      <SectionHeader
        title="External context servers"
        subtitle="Attach extra MCP servers to orchestrator turns. Built-in operator + cortex servers always stay attached; these rows only add more context sources."
      />

      <div style={{
        paddingTop: 16,
        paddingRight: 16,
        paddingBottom: 16,
        paddingLeft: 16,
        borderRadius: 16,
        background: 'var(--t-panel)',
        border: '1px solid var(--t-panel-border)',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        boxShadow: '0 18px 40px rgba(15, 23, 42, 0.04)',
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
        }}>
          <span style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            color: 'var(--t-text-muted)',
          }}>
            Always attached
          </span>
          <BuiltinServerPill icon={<Terminal size={12} strokeWidth={2.1} />} label="operator" />
          <BuiltinServerPill icon={<Globe size={12} strokeWidth={2.1} />} label="cortex" />
        </div>

        {note ? (
          <div style={{
            paddingTop: 10,
            paddingRight: 12,
            paddingBottom: 10,
            paddingLeft: 12,
            borderRadius: 10,
            border: `1px solid ${note.ok ? 'rgba(34, 197, 94, 0.24)' : 'rgba(239, 68, 68, 0.22)'}`,
            background: note.ok ? 'rgba(34, 197, 94, 0.08)' : 'rgba(239, 68, 68, 0.08)',
            fontSize: 12,
            color: note.ok ? '#15803d' : '#dc2626',
            lineHeight: 1.5,
          }}>
            {note.message}
          </div>
        ) : null}

        {error ? (
          <div style={{
            paddingTop: 10,
            paddingRight: 12,
            paddingBottom: 10,
            paddingLeft: 12,
            borderRadius: 10,
            border: '1px solid rgba(239, 68, 68, 0.22)',
            background: 'rgba(239, 68, 68, 0.08)',
            fontSize: 12,
            color: '#dc2626',
            lineHeight: 1.5,
          }}>
            {error}
          </div>
        ) : null}

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 132px)',
          gap: 12,
        }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--t-text)' }}>Name</span>
            <input
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              placeholder="slack-context"
              style={INPUT_STYLE}
            />
          </label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--t-text)' }}>Transport</span>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              paddingTop: 4,
              paddingRight: 4,
              paddingBottom: 4,
              paddingLeft: 4,
              borderRadius: 12,
              border: '1px solid var(--t-panel-border)',
              background: 'var(--t-input-bg)',
            }}>
              {(['stdio', 'http'] as ExternalMcpTransport[]).map((transport) => {
                const active = form.transport === transport;
                return (
                  <button
                    key={transport}
                    type="button"
                    onClick={() => setForm((current) => ({ ...current, transport }))}
                    style={{
                      flex: 1,
                      paddingTop: 8,
                      paddingRight: 10,
                      paddingBottom: 8,
                      paddingLeft: 10,
                      borderRadius: 9,
                      border: active ? '1px solid rgba(143, 180, 255, 0.32)' : '1px solid transparent',
                      background: active ? 'rgba(143, 180, 255, 0.18)' : 'transparent',
                      color: active ? 'var(--t-accent)' : 'var(--t-text-muted)',
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: 'pointer',
                      fontFamily: APP_FONT_STACK,
                      textTransform: transport === 'stdio' ? 'none' : 'uppercase',
                    }}
                  >
                    {transport}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--t-text)' }}>
            {form.transport === 'http' ? 'Endpoint URL' : 'Command'}
          </span>
          <input
            value={form.command}
            onChange={(event) => setForm((current) => ({ ...current, command: event.target.value }))}
            placeholder={form.transport === 'http' ? 'https://mcp.example.com/mcp' : 'npx'}
            style={INPUT_STYLE}
          />
        </label>

        {form.transport === 'stdio' ? (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
            gap: 12,
          }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--t-text)' }}>Args JSON array</span>
              <textarea
                value={form.argsJson}
                onChange={(event) => setForm((current) => ({ ...current, argsJson: event.target.value }))}
                rows={4}
                spellCheck={false}
                style={TEXTAREA_STYLE}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--t-text)' }}>Env JSON object</span>
              <textarea
                value={form.envJson}
                onChange={(event) => setForm((current) => ({ ...current, envJson: event.target.value }))}
                rows={4}
                spellCheck={false}
                style={TEXTAREA_STYLE}
              />
            </label>
          </div>
        ) : (
          <div style={{
            paddingTop: 10,
            paddingRight: 12,
            paddingBottom: 10,
            paddingLeft: 12,
            borderRadius: 10,
            background: 'var(--t-input-bg)',
            border: '1px solid var(--t-panel-border)',
            fontSize: 12,
            color: 'var(--t-text-muted)',
            lineHeight: 1.5,
          }}>
            HTTP servers use the endpoint URL above. Args and env are only stored for stdio transports.
          </div>
        )}

        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}>
          <button
            type="button"
            onClick={() => setForm((current) => ({ ...current, enabled: !current.enabled }))}
            style={{
              paddingTop: 7,
              paddingRight: 12,
              paddingBottom: 7,
              paddingLeft: 12,
              borderRadius: 999,
              border: `1px solid ${form.enabled ? 'rgba(34, 197, 94, 0.24)' : 'var(--t-panel-border)'}`,
              background: form.enabled ? 'rgba(34, 197, 94, 0.12)' : 'transparent',
              color: form.enabled ? '#15803d' : 'var(--t-text-muted)',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: APP_FONT_STACK,
            }}
          >
            {form.enabled ? 'Enabled on add' : 'Added disabled'}
          </button>

          <button
            type="button"
            onClick={() => { void create(); }}
            disabled={creating}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              paddingTop: 9,
              paddingRight: 14,
              paddingBottom: 9,
              paddingLeft: 14,
              borderRadius: 10,
              border: '1px solid rgba(143, 180, 255, 0.34)',
              background: creating ? 'rgba(143, 180, 255, 0.12)' : 'rgba(143, 180, 255, 0.22)',
              color: 'var(--t-accent)',
              fontSize: 12,
              fontWeight: 700,
              cursor: creating ? 'default' : 'pointer',
              fontFamily: APP_FONT_STACK,
              opacity: creating ? 0.7 : 1,
              boxShadow: creating ? 'none' : '0 0 12px rgba(143, 180, 255, 0.18)',
            }}
          >
            <Plus size={13} strokeWidth={2.1} />
            {creating ? 'Adding…' : 'Add server'}
          </button>
        </div>

        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}>
          {loading ? (
            <div style={{ fontSize: 12, color: 'var(--t-text-muted)' }}>
              Loading external MCP servers...
            </div>
          ) : servers.length === 0 ? (
            <div style={{
              paddingTop: 14,
              paddingRight: 16,
              paddingBottom: 14,
              paddingLeft: 16,
              borderRadius: 12,
              border: '1px dashed var(--t-panel-border)',
              color: 'var(--t-text-muted)',
              fontSize: 12,
              lineHeight: 1.6,
              background: 'var(--t-panel)',
            }}>
              No external servers configured yet. Add a stdio process or an HTTP endpoint to make extra MCP context available on orchestrator turns.
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
                  paddingTop: 13,
                  paddingRight: 14,
                  paddingBottom: 13,
                  paddingLeft: 14,
                  borderRadius: 14,
                  border: `1px solid ${server.enabled ? 'rgba(124, 156, 255, 0.24)' : 'var(--t-panel-border)'}`,
                  background: server.enabled ? 'rgba(124, 156, 255, 0.07)' : 'var(--t-bg-card)',
                }}
              >
                <div style={{
                  width: 38,
                  height: 38,
                  borderRadius: 11,
                  display: 'grid',
                  placeItems: 'center',
                  background: server.transport === 'http' ? 'rgba(37, 99, 235, 0.12)' : 'rgba(15, 23, 42, 0.06)',
                  color: server.transport === 'http' ? '#2563eb' : 'var(--t-text)',
                  flexShrink: 0,
                }}>
                  {server.transport === 'http'
                    ? <Globe size={17} strokeWidth={2.1} />
                    : <Terminal size={17} strokeWidth={2.1} />}
                </div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t-text)' }}>
                      {server.name}
                    </span>
                    <span style={{
                      paddingTop: 2,
                      paddingRight: 8,
                      paddingBottom: 2,
                      paddingLeft: 8,
                      borderRadius: 999,
                      background: server.transport === 'http' ? 'rgba(37, 99, 235, 0.1)' : 'rgba(15, 23, 42, 0.06)',
                      color: server.transport === 'http' ? '#2563eb' : 'var(--t-text-muted)',
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: '0.04em',
                      textTransform: server.transport === 'http' ? 'uppercase' : 'none',
                    }}>
                      {server.transport}
                    </span>
                    <span style={{
                      paddingTop: 2,
                      paddingRight: 8,
                      paddingBottom: 2,
                      paddingLeft: 8,
                      borderRadius: 999,
                      background: server.enabled ? 'rgba(34, 197, 94, 0.12)' : 'rgba(148, 163, 184, 0.14)',
                      color: server.enabled ? '#15803d' : 'var(--t-text-muted)',
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: '0.04em',
                      textTransform: 'uppercase',
                    }}>
                      {server.enabled ? 'enabled' : 'disabled'}
                    </span>
                  </div>
                  <div style={{
                    marginTop: 4,
                    fontSize: 11,
                    color: 'var(--t-text-muted)',
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
                      marginTop: 5,
                      fontSize: 11,
                      color: 'var(--t-text-muted)',
                    }}>
                      env {envCount} var{envCount === 1 ? '' : 's'}
                    </div>
                  ) : null}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                  <button
                    type="button"
                    onClick={() => { void toggle(server); }}
                    disabled={busy}
                    style={{
                      paddingTop: 7,
                      paddingRight: 12,
                      paddingBottom: 7,
                      paddingLeft: 12,
                      borderRadius: 9,
                      border: `1px solid ${server.enabled ? 'rgba(245, 158, 11, 0.28)' : 'rgba(34, 197, 94, 0.24)'}`,
                      background: server.enabled ? 'rgba(245, 158, 11, 0.08)' : 'rgba(34, 197, 94, 0.1)',
                      color: server.enabled ? '#b45309' : '#15803d',
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: busy ? 'default' : 'pointer',
                      fontFamily: APP_FONT_STACK,
                      opacity: busy ? 0.65 : 1,
                    }}
                  >
                    {busy ? 'Working…' : server.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { void remove(server); }}
                    disabled={busy}
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 10,
                      border: '1px solid rgba(239, 68, 68, 0.18)',
                      background: 'rgba(239, 68, 68, 0.06)',
                      color: '#dc2626',
                      display: 'grid',
                      placeItems: 'center',
                      cursor: busy ? 'default' : 'pointer',
                      opacity: busy ? 0.65 : 1,
                    }}
                    aria-label={`Remove ${server.name}`}
                  >
                    <Trash2 size={15} strokeWidth={2.1} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
