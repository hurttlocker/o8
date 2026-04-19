'use client';

import { useMemo, useState, type ReactNode } from 'react';
import {
  APP_FONT_STACK,
  MONO_FONT_STACK,
  RAMS_ACCENT,
  RAMS_HAIRLINE_SOFT,
  RAMS_INK_QUIET,
  BracketLabel,
  FieldLabel,
} from '../shared';
import { Globe, Plus, Terminal } from '../../lucide-shims';
import {
  countEnvKeys,
  formatServerDetail,
  MONO_FONT,
  type ExternalMcpTransport,
} from './shared';
import { useExternalMcpServers, type McpServerTestOutcome } from './useExternalMcpServers';
import type { ExternalMcpServer } from './shared';
import {
  parseMcpConfigInput,
  parsedServerToFormValues,
  type ParsedMcpServer,
} from '@/lib/mcp/parse-config';

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
    remove,
    testingId,
    testResults,
    test,
  } = useExternalMcpServers();

  const [pasteText, setPasteText] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [pasteNote, setPasteNote] = useState<string | null>(null);
  const [pasteCandidates, setPasteCandidates] = useState<ParsedMcpServer[] | null>(null);
  const [expandedStderrId, setExpandedStderrId] = useState<string | null>(null);

  const applyParsedServer = (server: ParsedMcpServer, fallbackName?: string) => {
    const values = parsedServerToFormValues(server);
    setForm((current) => ({
      ...current,
      name: values.name || fallbackName || current.name,
      transport: values.transport,
      command: values.command,
      argsJson: values.transport === 'stdio' ? values.argsJson : current.argsJson,
      envJson: values.transport === 'stdio' ? values.envJson : current.envJson,
    }));
  };

  const handleParsePaste = () => {
    setPasteError(null);
    setPasteNote(null);
    setPasteCandidates(null);
    try {
      const parsed = parseMcpConfigInput(pasteText);
      if (parsed.servers.length === 1) {
        applyParsedServer(parsed.servers[0]);
        setPasteNote('Parsed — review the fields below and add the server.');
      } else {
        setPasteCandidates(parsed.servers);
        setPasteNote(`${parsed.servers.length} servers detected — pick which one to populate.`);
      }
    } catch (e) {
      setPasteError(e instanceof Error ? e.message : 'Failed to parse config');
    }
  };

  const handlePickCandidate = (server: ParsedMcpServer) => {
    applyParsedServer(server);
    setPasteCandidates(null);
    setPasteNote(`Populated with "${server.name ?? 'unnamed'}". Edit and add the server when ready.`);
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

        {/* ── Paste config (JSON) ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <FieldLabel>paste config</FieldLabel>
          <textarea
            value={pasteText}
            onChange={(e) => {
              setPasteText(e.target.value);
              if (pasteError) setPasteError(null);
              if (pasteNote && !pasteCandidates) setPasteNote(null);
            }}
            rows={5}
            spellCheck={false}
            placeholder={'{"mcpServers": {...}} or a single server object'}
            style={textareaStyle()}
            onFocus={(e) => { e.currentTarget.style.borderColor = RAMS_ACCENT; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = RAMS_HAIRLINE_SOFT; }}
          />
          <div style={{
            fontFamily: MONO_FONT_STACK,
            fontSize: 10,
            fontWeight: 400,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: RAMS_INK_QUIET,
          }}>
            reads the standard Claude Desktop / Cursor config shape.
          </div>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 20,
            flexWrap: 'wrap',
            marginTop: 4,
          }}>
            <button
              type="button"
              onClick={handleParsePaste}
              disabled={!pasteText.trim()}
              style={parseButtonStyle(!pasteText.trim())}
            >
              parse &amp; populate
            </button>
            {pasteText ? (
              <button
                type="button"
                onClick={() => {
                  setPasteText('');
                  setPasteError(null);
                  setPasteNote(null);
                  setPasteCandidates(null);
                }}
                style={quietActionStyle(false)}
              >
                clear
              </button>
            ) : null}
          </div>

          {pasteError ? (
            <div style={{
              marginTop: 4,
              border: `1px solid ${RAMS_HAIRLINE_SOFT}`,
              borderRadius: 4,
              paddingTop: 8,
              paddingBottom: 8,
              paddingLeft: 12,
              paddingRight: 12,
              fontSize: 12,
              lineHeight: 1.55,
              color: '#dc2626',
              background: 'transparent',
            }}>
              {pasteError}
            </div>
          ) : null}

          {pasteNote && !pasteCandidates ? (
            <div style={{
              marginTop: 4,
              fontSize: 12,
              color: RAMS_INK_QUIET,
              lineHeight: 1.55,
            }}>
              {pasteNote}
            </div>
          ) : null}

          {pasteCandidates ? (
            <div style={{
              marginTop: 6,
              border: `1px solid ${RAMS_HAIRLINE_SOFT}`,
              borderRadius: 4,
              background: 'var(--t-panel)',
              paddingTop: 4,
              paddingBottom: 4,
            }}>
              {pasteCandidates.map((candidate, idx) => (
                <button
                  key={`${candidate.name ?? 'srv'}-${idx}`}
                  type="button"
                  onClick={() => handlePickCandidate(candidate)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                    width: '100%',
                    paddingTop: 10,
                    paddingBottom: 10,
                    paddingLeft: 14,
                    paddingRight: 14,
                    background: 'transparent',
                    border: 'none',
                    borderBottom: idx < pasteCandidates.length - 1 ? `1px solid ${RAMS_HAIRLINE_SOFT}` : 'none',
                    cursor: 'pointer',
                    textAlign: 'left',
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
                    <span style={{ fontWeight: 500 }}>{candidate.name ?? 'unnamed'}</span>
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
                        ? candidate.command
                        : `${candidate.command}${candidate.args.length ? ' ' + candidate.args.join(' ') : ''}`}
                    </span>
                  </span>
                  <span style={{
                    fontFamily: MONO_FONT_STACK,
                    fontSize: 10,
                    letterSpacing: '0.14em',
                    textTransform: 'uppercase',
                    color: RAMS_ACCENT,
                  }}>
                    use ›
                  </span>
                </button>
              ))}
            </div>
          ) : null}
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
          <button
            type="button"
            onClick={() => setForm((current) => ({ ...current, enabled: !current.enabled }))}
            style={quietActionStyle(false)}
          >
            {form.enabled ? '(enabled on add)' : '(added disabled)'}
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
            No external servers configured. Paste a config above or fill the form to add a stdio process or HTTP endpoint.
          </div>
        ) : servers.map((server) => {
          const busy = actionId === server.id;
          const testing = testingId === server.id;
          const outcome = testResults[server.id];
          const envCount = countEnvKeys(server.envJson);
          return (
            <ServerRow
              key={server.id}
              server={server}
              busy={busy}
              testing={testing}
              outcome={outcome}
              envCount={envCount}
              expandedStderr={expandedStderrId === server.id}
              onTest={() => { void test(server); }}
              onRemove={() => { void remove(server); }}
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

function ServerRow({
  server,
  busy,
  testing,
  outcome,
  envCount,
  expandedStderr,
  onTest,
  onRemove,
  onToggleStderr,
}: {
  server: ExternalMcpServer;
  busy: boolean;
  testing: boolean;
  outcome: McpServerTestOutcome | undefined;
  envCount: number;
  expandedStderr: boolean;
  onTest: () => void;
  onRemove: () => void;
  onToggleStderr: () => void;
}) {
  const status = useMemo<{ label: string; tone: 'quiet' | 'accent'; color: string }>(() => {
    if (testing) return { label: 'testing…', tone: 'quiet', color: RAMS_INK_QUIET };
    if (outcome?.ok) {
      const count = typeof outcome.toolCount === 'number' ? outcome.toolCount : undefined;
      return {
        label: count !== undefined ? `ok · ${count} tool${count === 1 ? '' : 's'}` : 'ok',
        tone: 'quiet',
        color: 'var(--t-text)',
      };
    }
    if (outcome && !outcome.ok) return { label: 'failed', tone: 'accent', color: '#dc2626' };
    if (!server.enabled) return { label: 'disabled', tone: 'quiet', color: RAMS_INK_QUIET };
    return { label: 'pending', tone: 'quiet', color: RAMS_INK_QUIET };
  }, [outcome, server.enabled, testing]);

  return (
    <div style={{
      paddingTop: 14,
      paddingBottom: 14,
      borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
      }}>
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
            {envCount > 0 ? (
              <span style={{
                fontFamily: MONO_FONT_STACK,
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
          <span style={{
            fontFamily: MONO_FONT_STACK,
            fontSize: 11,
            fontWeight: 400,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: status.color,
          }}>
            ({status.label}
            {outcome?.ok && typeof outcome.durationMs === 'number' ? (
              <span style={{ color: RAMS_INK_QUIET, marginLeft: 6 }}>· {outcome.durationMs}ms</span>
            ) : null}
            )
          </span>
          <span style={{
            width: 1,
            height: 12,
            background: RAMS_HAIRLINE_SOFT,
          }} />
          <button
            type="button"
            onClick={onTest}
            disabled={testing || busy}
            style={rowLinkStyle(testing || busy)}
          >
            {testing ? 'testing…' : 'test'}
          </button>
          <button
            type="button"
            onClick={onRemove}
            disabled={busy}
            style={rowLinkStyle(busy)}
          >
            remove
          </button>
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
              <button
                type="button"
                onClick={onToggleStderr}
                style={{
                  fontFamily: MONO_FONT_STACK,
                  fontSize: 10,
                  fontWeight: 400,
                  letterSpacing: '0.14em',
                  textTransform: 'uppercase',
                  color: RAMS_INK_QUIET,
                  background: 'transparent',
                  border: 'none',
                  paddingTop: 0,
                  paddingBottom: 0,
                  paddingLeft: 0,
                  paddingRight: 0,
                  cursor: 'pointer',
                }}
              >
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
    fontFamily: MONO_FONT_STACK,
    fontSize: 11,
    fontWeight: 400,
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    color: active ? 'var(--t-text)' : RAMS_INK_QUIET,
    background: active ? 'rgba(255, 90, 31, 0.1)' : 'transparent',
    border: `1px solid ${active ? RAMS_ACCENT : RAMS_HAIRLINE_SOFT}`,
    borderRadius: 4,
    paddingTop: 4,
    paddingBottom: 4,
    paddingLeft: 10,
    paddingRight: 10,
    cursor: 'pointer',
    outline: 'none',
  };
}

function parseButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    fontFamily: APP_FONT_STACK,
    fontSize: 13,
    fontWeight: 500,
    color: disabled ? RAMS_INK_QUIET : RAMS_ACCENT,
    background: 'transparent',
    border: 'none',
    borderBottom: `1px solid ${disabled ? RAMS_HAIRLINE_SOFT : RAMS_ACCENT}`,
    paddingTop: 2,
    paddingBottom: 2,
    paddingLeft: 0,
    paddingRight: 0,
    cursor: disabled ? 'default' : 'pointer',
    letterSpacing: '-0.005em',
    opacity: disabled ? 0.6 : 1,
  };
}

function submitButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    fontFamily: APP_FONT_STACK,
    fontSize: 13,
    fontWeight: 500,
    color: disabled ? RAMS_INK_QUIET : RAMS_ACCENT,
    background: 'transparent',
    border: 'none',
    borderBottom: `1px solid ${disabled ? RAMS_HAIRLINE_SOFT : RAMS_ACCENT}`,
    paddingTop: 2,
    paddingBottom: 2,
    paddingLeft: 0,
    paddingRight: 0,
    cursor: disabled ? 'default' : 'pointer',
    letterSpacing: '-0.005em',
    opacity: disabled ? 0.6 : 1,
  };
}

function quietActionStyle(disabled: boolean): React.CSSProperties {
  return {
    fontFamily: MONO_FONT_STACK,
    fontSize: 11,
    fontWeight: 400,
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    color: 'var(--t-text-muted)',
    background: 'transparent',
    border: 'none',
    paddingTop: 2,
    paddingBottom: 2,
    paddingLeft: 0,
    paddingRight: 0,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.6 : 1,
  };
}

function rowLinkStyle(disabled: boolean): React.CSSProperties {
  return {
    fontFamily: MONO_FONT_STACK,
    fontSize: 11,
    fontWeight: 400,
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    color: disabled ? RAMS_INK_QUIET : 'var(--t-text-muted)',
    background: 'transparent',
    border: 'none',
    paddingTop: 2,
    paddingBottom: 2,
    paddingLeft: 0,
    paddingRight: 0,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.6 : 1,
  };
}
