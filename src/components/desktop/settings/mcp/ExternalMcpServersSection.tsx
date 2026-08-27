'use client';

import { useMemo, useState, type ReactNode } from 'react';
import {
  APP_FONT_STACK,
  MONO_FONT_STACK,
  RAMS_ACCENT,
  RAMS_CONTROL_BG,
  RAMS_CONTROL_BORDER,
  RAMS_CONTROL_ACTIVE_BG,
  RAMS_CONTROL_ACTIVE_BORDER,
  RAMS_HAIRLINE_SOFT,
  RAMS_INK_QUIET,
  BracketLabel,
  FieldLabel,
  SettingsToggleButton,
} from '../shared';
import { Globe, Plus, Terminal } from '../../lucide-shims';
import {
  countEnvKeys,
  MONO_FONT,
  type ExternalMcpTransport,
} from './shared';
import { ExternalMcpServerRow } from './ExternalMcpServerRow';
import { useExternalMcpServers } from './useExternalMcpServers';
import {
  parseMcpAnyInput,
  parsedServerToFormValues,
  type ParsedMcpServer,
} from '@/lib/mcp/parse-config';

function BuiltinServerPill({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      fontFamily: APP_FONT_STACK,
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
    createServer,
    toggleWorkerInjection,
    remove,
    testingId,
    testingNpxFamily,
    testResults,
    test,
  } = useExternalMcpServers();

  const [pasteText, setPasteText] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [expandedStderrId, setExpandedStderrId] = useState<string | null>(null);
  // Inline remove confirmation — replaces window.confirm (disabled in Tauri).
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);

  // Smart box (operator, 2026-07-06 — "typing JSON args is 2024"): the input
  // live-parses as you type. JSON config, a raw "npx ..." command line, or a
  // bare URL all resolve to candidate cards; Add lands the server directly.
  const pasteCandidates = useMemo<ParsedMcpServer[] | null>(() => {
    const trimmed = pasteText.trim();
    if (!trimmed) return null;
    try {
      return parseMcpAnyInput(trimmed).servers;
    } catch {
      return null; // stay quiet while typing — Add surfaces the real error
    }
  }, [pasteText]);

  const applyParsedServer = (server: ParsedMcpServer, fallbackName?: string) => {
    const values = parsedServerToFormValues(server);
    setForm((current) => ({
      ...current,
      name: values.name || fallbackName || current.name,
      transport: values.transport,
      command: values.transport === 'http' ? (server.url ?? values.command) : values.command,
      argsJson: values.transport === 'stdio' ? values.argsJson : current.argsJson,
      envJson: values.transport === 'stdio' ? values.envJson : current.envJson,
    }));
  };

  const handleAddCandidate = async (server: ParsedMcpServer) => {
    setPasteError(null);
    const ok = await createServer({
      name: server.name || 'server',
      transport: server.transport,
      command: server.transport === 'http' ? (server.url ?? server.command) : server.command,
      args: server.transport === 'stdio' ? server.args : [],
      env: server.transport === 'stdio' && Object.keys(server.env).length > 0 ? server.env : null,
    });
    if (ok) setPasteText('');
  };

  const handleEditCandidate = (server: ParsedMcpServer) => {
    applyParsedServer(server);
    setManualOpen(true);
  };

  const handleSmartAdd = () => {
    setPasteError(null);
    try {
      const parsed = parseMcpAnyInput(pasteText);
      void handleAddCandidate(parsed.servers[0]);
    } catch (e) {
      setPasteError(e instanceof Error ? e.message : 'Could not parse that.');
    }
  };

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
            fontFamily: APP_FONT_STACK,
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

        {/* ── Smart add box — paste anything, we figure it out ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <FieldLabel>add a server</FieldLabel>
          <textarea
            value={pasteText}
            onChange={(e) => {
              setPasteText(e.target.value);
              if (pasteError) setPasteError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleSmartAdd();
              }
            }}
            rows={3}
            spellCheck={false}
            placeholder={'Paste anything — a config JSON, an "npx …" command line, or a server URL'}
            style={textareaStyle()}
            onFocus={(e) => { e.currentTarget.style.borderColor = RAMS_ACCENT; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = RAMS_HAIRLINE_SOFT; }}
          />

          {pasteError ? (
            <div style={{ fontSize: 12, color: '#dc2626', lineHeight: 1.55 }}>
              {pasteError}
            </div>
          ) : null}

          {pasteText.trim() && !pasteCandidates && !pasteError ? (
            <div style={{ fontSize: 12, color: RAMS_INK_QUIET, lineHeight: 1.55 }}>
              Keep going — a full JSON config, a command line, or a URL will light up here.
            </div>
          ) : null}

          {pasteCandidates ? (
            <div style={{
              border: `1px solid ${RAMS_HAIRLINE_SOFT}`,
              borderRadius: 10,
              background: 'var(--t-panel)',
              paddingTop: 4,
              paddingBottom: 4,
            }}>
              {pasteCandidates.map((candidate, idx) => (
                <div
                  key={`${candidate.name ?? 'srv'}-${idx}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    minHeight: 44,
                    paddingTop: 8,
                    paddingBottom: 8,
                    paddingLeft: 14,
                    paddingRight: 10,
                    borderBottom: idx < pasteCandidates.length - 1 ? `1px solid ${RAMS_HAIRLINE_SOFT}` : 'none',
                    color: 'var(--t-text)',
                    fontFamily: APP_FONT_STACK,
                    fontSize: 13,
                  }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
                    <span style={{ display: 'inline-flex', color: RAMS_INK_QUIET }}>
                      {candidate.transport === 'http'
                        ? <Globe size={13} strokeWidth={1.8} />
                        : <Terminal size={13} strokeWidth={1.8} />}
                    </span>
                    <span style={{ fontWeight: 400, flexShrink: 0 }}>{candidate.name ?? 'unnamed'}</span>
                    <span style={{
                      fontFamily: MONO_FONT,
                      fontSize: 11,
                      color: 'var(--t-text-secondary)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      minWidth: 0,
                    }}>
                      {candidate.transport === 'http'
                        ? (candidate.url ?? candidate.command)
                        : `${candidate.command}${candidate.args.length ? ' ' + candidate.args.join(' ') : ''}`}
                    </span>
                    {candidate.transport === 'stdio' && Object.keys(candidate.env).length > 0 ? (
                      <BracketLabel tone="quiet">env {Object.keys(candidate.env).length}</BracketLabel>
                    ) : null}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleEditCandidate(candidate)}
                    style={quietActionStyle(false)}
                  >
                    edit
                  </button>
                  <button
                    type="button"
                    onClick={() => { void handleAddCandidate(candidate); }}
                    disabled={creating}
                    style={submitButtonStyle(creating)}
                  >
                    <Plus size={12} strokeWidth={2} />
                    {creating ? 'adding…' : 'add'}
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        {note ? (
          <div style={{
            fontSize: 12,
            color: note.ok ? '#15803d' : '#dc2626',
            lineHeight: 1.55,
          }}>
            <span style={{
              fontFamily: MONO_FONT_STACK,
              fontSize: 11,
              fontWeight: 300,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: note.ok ? '#22c55e' : '#ef4444',
              marginRight: 8,
            }}>
              {note.ok ? '[ok]' : '[error]'}
            </span>
            {note.message}
          </div>
        ) : null}

        {error ? (
          <div style={{
            fontSize: 12,
            color: '#dc2626',
            lineHeight: 1.55,
          }}>
            <span style={{
              fontFamily: MONO_FONT_STACK,
              fontSize: 11,
              fontWeight: 300,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: '#ef4444',
              marginRight: 8,
            }}>
              [error]
            </span>
            {error}
          </div>
        ) : null}

        {/* Manual setup — the old field-by-field form, demoted to a disclosure
            (the smart box above covers the normal path). */}
        <button
          type="button"
          onClick={() => setManualOpen((v) => !v)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            border: 'none',
            background: 'transparent',
            padding: 0,
            cursor: 'pointer',
            fontFamily: APP_FONT_STACK,
            fontSize: 10,
            fontWeight: 400,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: RAMS_INK_QUIET,
          }}
        >
          <svg width={9} height={9} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} aria-hidden style={{ transform: manualOpen ? 'rotate(90deg)' : 'none', transition: 'transform 120ms ease' }}>
            <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Manual setup
        </button>

        {manualOpen ? (<>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 200px)',
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
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', paddingTop: 4, paddingBottom: 4 }}>
              {(['stdio', 'http'] as ExternalMcpTransport[]).map((transport) => {
                const active = form.transport === transport;
                return (
                  <button
                    key={transport}
                    type="button"
                    onClick={() => setForm((current) => ({ ...current, transport }))}
                    style={transportPillStyle(active)}
                  >
                    {transport}
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
          gap: 20,
          flexWrap: 'wrap',
          paddingTop: 4,
        }}>
          <button
            type="button"
            onClick={() => { void create(); }}
            disabled={creating}
            style={submitButtonStyle(creating)}
          >
            <Plus size={12} strokeWidth={2} />
            {creating ? 'adding...' : 'add server'}
          </button>
          <SettingsToggleButton
            checked={form.enabled}
            onChange={(next) => setForm((current) => ({ ...current, enabled: next }))}
            activeLabel="Enabled"
            inactiveLabel="Disabled"
          />
        </div>
        </>) : null}
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
            No external servers configured. Paste a config above or fill the form to add a stdio process or HTTP endpoint.
          </div>
        ) : servers.map((server) => {
          const busy = actionId === server.id;
          const testing = testingId === server.id;
          const outcome = testResults[server.id];
          const envCount = countEnvKeys(server.envJson);
          return (
            <ExternalMcpServerRow
              key={server.id}
              server={server}
              busy={busy}
              testing={testing}
              testingNpxFamily={testing && testingNpxFamily}
              outcome={outcome}
              envCount={envCount}
              expandedStderr={expandedStderrId === server.id}
              pendingRemoval={pendingRemoval === server.id}
              onTest={() => { void test(server); }}
              onToggleWorkerInjection={() => { void toggleWorkerInjection(server); }}
              onRemoveRequest={() => { setPendingRemoval(server.id); }}
              onRemoveConfirm={() => { setPendingRemoval(null); void remove(server); }}
              onRemoveCancel={() => { setPendingRemoval(null); }}
              onToggleStderr={() => {
                setExpandedStderrId((cur) => cur === server.id ? null : server.id);
              }}
            />
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

function transportPillStyle(active: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 32,
    minWidth: 44,
    fontFamily: APP_FONT_STACK,
    fontSize: 12,
    fontWeight: 400,
    letterSpacing: '-0.01em',
    textTransform: 'capitalize',
    color: active ? RAMS_ACCENT : 'var(--t-text-secondary)',
    background: active ? RAMS_CONTROL_ACTIVE_BG : RAMS_CONTROL_BG,
    border: `1px solid ${active ? RAMS_CONTROL_ACTIVE_BORDER : RAMS_CONTROL_BORDER}`,
    borderRadius: 9,
    paddingLeft: 12,
    paddingRight: 12,
    cursor: 'pointer',
    outline: 'none',
    transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), border-color 150ms cubic-bezier(0.22, 1, 0.36, 1), color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
  };
}


function submitButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    minHeight: 32,
    paddingLeft: 14,
    paddingRight: 14,
    borderRadius: 9,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: disabled ? RAMS_CONTROL_BORDER : RAMS_CONTROL_ACTIVE_BORDER,
    background: disabled ? 'transparent' : RAMS_CONTROL_ACTIVE_BG,
    color: disabled ? RAMS_INK_QUIET : RAMS_ACCENT,
    fontFamily: APP_FONT_STACK,
    fontSize: 12,
    fontWeight: 400,
    letterSpacing: '-0.01em',
    textTransform: 'capitalize',
    cursor: disabled ? 'default' : 'pointer',
    transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), border-color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
    opacity: disabled ? 0.6 : 1,
  };
}

function quietActionStyle(disabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 32,
    paddingLeft: 14,
    paddingRight: 14,
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
    color: 'var(--t-text-secondary)',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.6 : 1,
    transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), border-color 150ms cubic-bezier(0.22, 1, 0.36, 1), color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
  };
}
