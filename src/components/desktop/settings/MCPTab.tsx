'use client';

/**
 * MCPTab — Claude Desktop / Claude Code integration.
 *
 * Fetches /api/setup/mcp-config, shows the generated JSON snippet, and lets
 * the user copy it or (on macOS) write it directly into their Claude Desktop
 * config file.
 *
 * This closes the "how do I connect Claude to o8?" gap. Without this tab a
 * real user has no discoverable path from "installed o8" to "Claude sees
 * the o8 tools."
 */

import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { APP_FONT_STACK } from './shared';
import { ClaudeIcon } from '../repo-registry/shared';
import { ChevronDown, ChevronRight, Globe, Plus, Terminal, Trash2 } from '../lucide-shims';

interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface McpConfigResponse {
  server: McpServerConfig;
  fullConfig: { mcpServers: Record<string, McpServerConfig> };
  instructions: { claudeDesktop: string; claudeCode: string };
  diagnostics: {
    apiBase: string;
    apiPort?: number;
    wsPort?: number;
    portSource?: 'env' | 'file' | 'default';
    bundled: boolean;
    platform: string;
    nodeInstalled: boolean;
    nodeBin: string | null;
    codexInstalled: boolean;
    codexBin: string | null;
    ghInstalled: boolean;
    ghBin: string | null;
    dataDir: string;
    dbExists: boolean;
    dbSize: number;
    webviewSocketPath: string;
    webviewToolsAvailable: boolean;
  };
}

type Target = 'claude-desktop' | 'claude-code';

interface ClaudeTargetStatus {
  target: Target;
  path: string;
  fileExists: boolean;
  alreadyRegistered: boolean;
  alreadyUpToDate: boolean;
  otherServers: string[];
  size: number;
}

type ExternalMcpTransport = 'stdio' | 'http';

interface ExternalMcpServer {
  id: string;
  name: string;
  transport: ExternalMcpTransport;
  command: string;
  args: string[];
  argsJson: string;
  envJson: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ExternalMcpFormState {
  name: string;
  transport: ExternalMcpTransport;
  command: string;
  argsJson: string;
  envJson: string;
  enabled: boolean;
}

const MONO_FONT = '"SF Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
const EMPTY_EXTERNAL_SERVER_FORM: ExternalMcpFormState = {
  name: '',
  transport: 'stdio',
  command: '',
  argsJson: '[]',
  envJson: '{}',
  enabled: true,
};

function parseArgsInput(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  const parsed = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) {
    throw new Error('Args must be a JSON array of strings');
  }

  const args = parsed
    .map((entry) => typeof entry === 'string' ? entry.trim() : '')
    .filter(Boolean);

  if (args.length !== parsed.length) {
    throw new Error('Args must be a JSON array of strings');
  }

  return args;
}

function parseEnvInput(raw: string): Record<string, string> | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Env must be a JSON object of string values');
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      throw new Error('Env must be a JSON object of string values');
    }
    const trimmedKey = key.trim();
    if (!trimmedKey) {
      continue;
    }
    env[trimmedKey] = value;
  }

  return Object.keys(env).length > 0 ? env : null;
}

function formatServerDetail(server: ExternalMcpServer): string {
  if (server.transport === 'http') {
    return server.command;
  }

  const args = server.args.length > 0 ? ` ${server.args.join(' ')}` : '';
  return `${server.command}${args}`;
}

function countEnvKeys(raw: string | null): number {
  if (!raw?.trim()) {
    return 0;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return 0;
    }
    return Object.keys(parsed).length;
  } catch {
    return 0;
  }
}

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

function StatusRow({ label, ok, detail }: { label: string; ok: boolean; detail?: string | null }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      fontSize: 12,
      padding: '6px 0',
    }}>
      <span style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: ok ? '#22c55e' : '#ef4444',
        flexShrink: 0,
      }} />
      <span style={{ color: 'var(--t-text)', fontWeight: 500, minWidth: 120 }}>
        {label}
      </span>
      <span style={{
        color: 'var(--t-text-muted)',
        fontFamily: MONO_FONT,
        fontSize: 11,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>
        {detail || (ok ? 'installed' : 'missing')}
      </span>
    </div>
  );
}

export function MCPTab() {
  const [data, setData] = useState<McpConfigResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [desktopStatus, setDesktopStatus] = useState<ClaudeTargetStatus | null>(null);
  const [codeStatus, setCodeStatus] = useState<ClaudeTargetStatus | null>(null);
  const [installing, setInstalling] = useState<Target | null>(null);
  const [installNote, setInstallNote] = useState<{ target: Target; message: string; ok: boolean } | null>(null);
  const [externalServers, setExternalServers] = useState<ExternalMcpServer[]>([]);
  const [externalServersLoading, setExternalServersLoading] = useState(true);
  const [externalServersError, setExternalServersError] = useState<string | null>(null);
  const [externalServerNote, setExternalServerNote] = useState<{ message: string; ok: boolean } | null>(null);
  const [externalServerActionId, setExternalServerActionId] = useState<string | null>(null);
  const [creatingExternalServer, setCreatingExternalServer] = useState(false);
  const [externalForm, setExternalForm] = useState<ExternalMcpFormState>(EMPTY_EXTERNAL_SERVER_FORM);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/setup/mcp-config');
      if (!res.ok) throw new Error(`${res.status}`);
      const json = await res.json() as McpConfigResponse;
      setData(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load MCP config');
    }
  }, []);

  const loadClaudeStatus = useCallback(async () => {
    try {
      const [desktop, code] = await Promise.all([
        fetch('/api/setup/claude-desktop?target=claude-desktop').then((r) => r.json() as Promise<ClaudeTargetStatus>),
        fetch('/api/setup/claude-desktop?target=claude-code').then((r) => r.json() as Promise<ClaudeTargetStatus>),
      ]);
      setDesktopStatus(desktop);
      setCodeStatus(code);
    } catch {
      // Silent — the status cards just don't render.
    }
  }, []);

  const loadExternalServers = useCallback(async () => {
    try {
      const res = await fetch('/api/setup/mcp-servers');
      const json = await res.json().catch(() => ({})) as { servers?: ExternalMcpServer[]; error?: string };
      if (!res.ok) {
        throw new Error(json.error || 'Failed to load external MCP servers');
      }
      setExternalServers(Array.isArray(json.servers) ? json.servers : []);
      setExternalServersError(null);
    } catch (e) {
      setExternalServersError(e instanceof Error ? e.message : 'Failed to load external MCP servers');
    } finally {
      setExternalServersLoading(false);
    }
  }, []);

  useEffect(() => { void load(); void loadClaudeStatus(); void loadExternalServers(); }, [load, loadClaudeStatus, loadExternalServers]);

  const installToClaude = useCallback(async (target: Target) => {
    setInstalling(target);
    setInstallNote(null);
    try {
      const res = await fetch('/api/setup/claude-desktop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target }),
      });
      const body = await res.json() as { ok: boolean; detail?: string; error?: string };
      if (res.ok && body.ok) {
        setInstallNote({ target, message: body.detail || 'Installed.', ok: true });
        await loadClaudeStatus();
      } else {
        setInstallNote({ target, message: body.error || body.detail || 'Failed to install.', ok: false });
      }
    } catch (e) {
      setInstallNote({
        target,
        message: e instanceof Error ? e.message : 'Request failed.',
        ok: false,
      });
    } finally {
      setInstalling(null);
    }
  }, [loadClaudeStatus]);

  const removeFromClaude = useCallback(async (target: Target) => {
    setInstalling(target);
    setInstallNote(null);
    try {
      const res = await fetch('/api/setup/claude-desktop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target, remove: true }),
      });
      const body = await res.json() as { ok: boolean; detail?: string; error?: string };
      if (res.ok && body.ok) {
        setInstallNote({ target, message: body.detail || 'Removed.', ok: true });
        await loadClaudeStatus();
      } else {
        setInstallNote({ target, message: body.error || body.detail || 'Failed.', ok: false });
      }
    } finally {
      setInstalling(null);
    }
  }, [loadClaudeStatus]);

  const copyToClipboard = useCallback(async () => {
    if (!data) return;
    const text = JSON.stringify(data.fullConfig, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback for Tauri webview / environments without clipboard API
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }, [data]);

  const createExternalServer = useCallback(async () => {
    setCreatingExternalServer(true);
    setExternalServerNote(null);
    try {
      const transport = externalForm.transport;
      const args = transport === 'stdio' ? parseArgsInput(externalForm.argsJson) : [];
      const env = transport === 'stdio' ? parseEnvInput(externalForm.envJson) : null;

      const res = await fetch('/api/setup/mcp-servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: externalForm.name,
          transport,
          command: externalForm.command,
          args,
          env,
          enabled: externalForm.enabled,
        }),
      });
      const body = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) {
        throw new Error(body.error || 'Failed to add MCP server');
      }

      setExternalForm(EMPTY_EXTERNAL_SERVER_FORM);
      setExternalServerNote({ message: 'External MCP server added.', ok: true });
      await loadExternalServers();
    } catch (e) {
      setExternalServerNote({ message: e instanceof Error ? e.message : 'Failed to add MCP server.', ok: false });
    } finally {
      setCreatingExternalServer(false);
    }
  }, [externalForm, loadExternalServers]);

  const toggleExternalServer = useCallback(async (server: ExternalMcpServer) => {
    setExternalServerActionId(server.id);
    setExternalServerNote(null);
    try {
      const res = await fetch('/api/setup/mcp-servers', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: server.id, enabled: !server.enabled }),
      });
      const body = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) {
        throw new Error(body.error || 'Failed to update MCP server');
      }

      setExternalServerNote({
        message: `${server.name} ${server.enabled ? 'disabled' : 'enabled'} for orchestrator runs.`,
        ok: true,
      });
      await loadExternalServers();
    } catch (e) {
      setExternalServerNote({ message: e instanceof Error ? e.message : 'Failed to update MCP server.', ok: false });
    } finally {
      setExternalServerActionId(null);
    }
  }, [loadExternalServers]);

  const removeExternalServer = useCallback(async (server: ExternalMcpServer) => {
    if (typeof window !== 'undefined' && !window.confirm(`Remove external MCP server "${server.name}"?`)) {
      return;
    }

    setExternalServerActionId(server.id);
    setExternalServerNote(null);
    try {
      const res = await fetch('/api/setup/mcp-servers', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: server.id }),
      });
      const body = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) {
        throw new Error(body.error || 'Failed to remove MCP server');
      }

      setExternalServerNote({ message: `${server.name} removed.`, ok: true });
      await loadExternalServers();
    } catch (e) {
      setExternalServerNote({ message: e instanceof Error ? e.message : 'Failed to remove MCP server.', ok: false });
    } finally {
      setExternalServerActionId(null);
    }
  }, [loadExternalServers]);

  if (error) {
    return (
      <div style={{ color: 'var(--t-text-muted)', fontSize: 13 }}>
        Failed to load MCP config: {error}
      </div>
    );
  }

  if (!data) {
    return (
      <div style={{ color: 'var(--t-text-muted)', fontSize: 13 }}>
        Loading MCP config...
      </div>
    );
  }

  const configJson = JSON.stringify(data.fullConfig, null, 2);
  const d = data.diagnostics;
  const ready = d.nodeInstalled;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* ── Hero ── */}
      <div>
        <SectionHeader
          title="Connect Claude"
          subtitle="One click to let Claude Desktop or Claude Code dispatch work to your o8 fleet. Your other MCP servers stay untouched — we only write the o8 entry."
        />

        {!ready ? (
          <div style={{
            marginBottom: 14,
            padding: '14px 16px',
            borderRadius: 12,
            background: 'rgba(239, 68, 68, 0.08)',
            border: '1px solid rgba(239, 68, 68, 0.22)',
            fontSize: 13,
            color: 'var(--t-text)',
            lineHeight: 1.55,
          }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Install Node.js first</div>
            <div style={{ color: 'var(--t-text-muted)', fontSize: 12 }}>
              o8&apos;s MCP server runs on Node. Grab the latest LTS from{' '}
              <a
                href="https://nodejs.org"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'var(--t-accent)', textDecoration: 'underline' }}
              >
                nodejs.org
              </a>
              {' '}(v22+), then relaunch o8.
            </div>
          </div>
        ) : null}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <ClaudeTargetCard
            label="Claude Desktop"
            target="claude-desktop"
            status={desktopStatus}
            installing={installing === 'claude-desktop'}
            disabled={!ready}
            note={installNote?.target === 'claude-desktop' ? installNote : null}
            onInstall={() => { void installToClaude('claude-desktop'); }}
            onRemove={() => { void removeFromClaude('claude-desktop'); }}
            restartHint="Quit Claude Desktop (⌘Q) and reopen it."
          />
          <ClaudeTargetCard
            label="Claude Code"
            target="claude-code"
            status={codeStatus}
            installing={installing === 'claude-code'}
            disabled={!ready}
            note={installNote?.target === 'claude-code' ? installNote : null}
            onInstall={() => { void installToClaude('claude-code'); }}
            onRemove={() => { void removeFromClaude('claude-code'); }}
            restartHint="Restart Claude Code or run /mcp reload."
          />
        </div>
      </div>

      <div>
        <SectionHeader
          title="External context servers"
          subtitle="Attach extra MCP servers to orchestrator turns. Built-in operator + cortex servers always stay attached; these rows only add more context sources."
        />

        <div style={{
          padding: 16,
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

          {externalServerNote ? (
            <div style={{
              padding: '10px 12px',
              borderRadius: 10,
              border: `1px solid ${externalServerNote.ok ? 'rgba(34, 197, 94, 0.24)' : 'rgba(239, 68, 68, 0.22)'}`,
              background: externalServerNote.ok ? 'rgba(34, 197, 94, 0.08)' : 'rgba(239, 68, 68, 0.08)',
              fontSize: 12,
              color: externalServerNote.ok ? '#15803d' : '#dc2626',
              lineHeight: 1.5,
            }}>
              {externalServerNote.message}
            </div>
          ) : null}

          {externalServersError ? (
            <div style={{
              padding: '10px 12px',
              borderRadius: 10,
              border: '1px solid rgba(239, 68, 68, 0.22)',
              background: 'rgba(239, 68, 68, 0.08)',
              fontSize: 12,
              color: '#dc2626',
              lineHeight: 1.5,
            }}>
              {externalServersError}
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
                value={externalForm.name}
                onChange={(event) => setExternalForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="slack-context"
                style={inputStyle}
              />
            </label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--t-text)' }}>Transport</span>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: 4,
                borderRadius: 12,
                border: '1px solid var(--t-panel-border)',
                background: 'var(--t-input-bg)',
              }}>
                {(['stdio', 'http'] as ExternalMcpTransport[]).map((transport) => {
                  const active = externalForm.transport === transport;
                  return (
                    <button
                      key={transport}
                      type="button"
                      onClick={() => setExternalForm((current) => ({ ...current, transport }))}
                      style={{
                        flex: 1,
                        padding: '8px 10px',
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
              {externalForm.transport === 'http' ? 'Endpoint URL' : 'Command'}
            </span>
            <input
              value={externalForm.command}
              onChange={(event) => setExternalForm((current) => ({ ...current, command: event.target.value }))}
              placeholder={externalForm.transport === 'http' ? 'https://mcp.example.com/mcp' : 'npx'}
              style={inputStyle}
            />
          </label>

          {externalForm.transport === 'stdio' ? (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
              gap: 12,
            }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--t-text)' }}>Args JSON array</span>
                <textarea
                  value={externalForm.argsJson}
                  onChange={(event) => setExternalForm((current) => ({ ...current, argsJson: event.target.value }))}
                  rows={4}
                  spellCheck={false}
                  style={textAreaStyle}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--t-text)' }}>Env JSON object</span>
                <textarea
                  value={externalForm.envJson}
                  onChange={(event) => setExternalForm((current) => ({ ...current, envJson: event.target.value }))}
                  rows={4}
                  spellCheck={false}
                  style={textAreaStyle}
                />
              </label>
            </div>
          ) : (
            <div style={{
              padding: '10px 12px',
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
              onClick={() => setExternalForm((current) => ({ ...current, enabled: !current.enabled }))}
              style={{
                padding: '7px 12px',
                borderRadius: 999,
                border: `1px solid ${externalForm.enabled ? 'rgba(34, 197, 94, 0.24)' : 'var(--t-panel-border)'}`,
                background: externalForm.enabled ? 'rgba(34, 197, 94, 0.12)' : 'transparent',
                color: externalForm.enabled ? '#15803d' : 'var(--t-text-muted)',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: APP_FONT_STACK,
              }}
            >
              {externalForm.enabled ? 'Enabled on add' : 'Added disabled'}
            </button>

            <button
              type="button"
              onClick={() => { void createExternalServer(); }}
              disabled={creatingExternalServer}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '9px 14px',
                borderRadius: 10,
                border: '1px solid rgba(143, 180, 255, 0.34)',
                background: creatingExternalServer ? 'rgba(143, 180, 255, 0.12)' : 'rgba(143, 180, 255, 0.22)',
                color: 'var(--t-accent)',
                fontSize: 12,
                fontWeight: 700,
                cursor: creatingExternalServer ? 'default' : 'pointer',
                fontFamily: APP_FONT_STACK,
                opacity: creatingExternalServer ? 0.7 : 1,
                boxShadow: creatingExternalServer ? 'none' : '0 0 12px rgba(143, 180, 255, 0.18)',
              }}
            >
              <Plus size={13} strokeWidth={2.1} />
              {creatingExternalServer ? 'Adding…' : 'Add server'}
            </button>
          </div>

          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}>
            {externalServersLoading ? (
              <div style={{ fontSize: 12, color: 'var(--t-text-muted)' }}>
                Loading external MCP servers...
              </div>
            ) : externalServers.length === 0 ? (
              <div style={{
                padding: '14px 16px',
                borderRadius: 12,
                border: '1px dashed var(--t-panel-border)',
                color: 'var(--t-text-muted)',
                fontSize: 12,
                lineHeight: 1.6,
                background: 'rgba(255, 255, 255, 0.38)',
              }}>
                No external servers configured yet. Add a stdio process or an HTTP endpoint to make extra MCP context available on orchestrator turns.
              </div>
            ) : externalServers.map((server) => {
              const busy = externalServerActionId === server.id;
              const envCount = countEnvKeys(server.envJson);
              return (
                <div
                  key={server.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 14,
                    padding: '13px 14px',
                    borderRadius: 14,
                    border: `1px solid ${server.enabled ? 'rgba(124, 156, 255, 0.24)' : 'var(--t-panel-border)'}`,
                    background: server.enabled ? 'rgba(124, 156, 255, 0.07)' : 'rgba(255, 255, 255, 0.4)',
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
                        padding: '2px 8px',
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
                        padding: '2px 8px',
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
                      onClick={() => { void toggleExternalServer(server); }}
                      disabled={busy}
                      style={{
                        padding: '7px 12px',
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
                      onClick={() => { void removeExternalServer(server); }}
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

      {/* ── System details (collapsed) ── */}
      <Disclosure title="System details" subtitle="Show the runtime environment o8 is using.">
        <div style={{
          padding: 14,
          borderRadius: 12,
          background: 'var(--t-panel)',
          border: '1px solid var(--t-panel-border)',
        }}>
          <StatusRow
            label="Backend"
            ok={true}
            detail={`${d.apiBase}${d.portSource ? ` (${d.portSource === 'env' ? 'env var' : d.portSource === 'file' ? 'port file' : 'default'})` : ''}`}
          />
          <StatusRow label="Install mode" ok={true} detail={d.bundled ? 'Packaged Tauri app' : 'Dev checkout'} />
          <StatusRow label="Node.js" ok={d.nodeInstalled} detail={d.nodeBin} />
          <StatusRow label="Codex CLI" ok={d.codexInstalled} detail={d.codexBin} />
          <StatusRow label="GitHub CLI" ok={d.ghInstalled} detail={d.ghBin} />
          <StatusRow label="Database" ok={d.dbExists} detail={d.dbExists ? `${(d.dbSize / 1024 / 1024).toFixed(1)} MB` : 'not initialized'} />
          <StatusRow
            label="Webview tools"
            ok={d.webviewToolsAvailable}
            detail={d.webviewToolsAvailable
              ? `Connected to ${d.webviewSocketPath}`
              : 'Off — launch with --features dev-mcp-plugin'}
          />
        </div>
        {d.nodeInstalled && !d.codexInstalled ? (
          <div style={{
            marginTop: 10,
            padding: 12,
            borderRadius: 10,
            background: 'rgba(245, 158, 11, 0.1)',
            border: '1px solid rgba(245, 158, 11, 0.28)',
            fontSize: 12,
            color: 'var(--t-text)',
            lineHeight: 1.55,
          }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Codex CLI not found</div>
            <div style={{ color: 'var(--t-text-muted)' }}>
              Install with{' '}
              <code style={{ fontFamily: MONO_FONT, background: 'var(--t-input-bg)', padding: '1px 6px', borderRadius: 4, fontSize: 11 }}>
                npm i -g @openai/codex-cli
              </code>
              {' '}and sign in with ChatGPT Plus or an OPENAI_API_KEY. Without Codex, mission dispatch won&apos;t work — but o8_status, directives, and the desktop UI still do.
            </div>
          </div>
        ) : null}
        {d.nodeInstalled && d.codexInstalled && !d.ghInstalled ? (
          <div style={{
            marginTop: 10,
            padding: 12,
            borderRadius: 10,
            background: 'var(--t-bg-card, rgba(148, 163, 184, 0.08))',
            border: '1px solid var(--t-panel-border)',
            fontSize: 12,
            color: 'var(--t-text-muted)',
            lineHeight: 1.55,
          }}>
            <div style={{ fontWeight: 600, marginBottom: 4, color: 'var(--t-text)' }}>GitHub CLI not found (optional)</div>
            <div>
              Install with{' '}
              <code style={{ fontFamily: MONO_FONT, background: 'var(--t-input-bg)', padding: '1px 6px', borderRadius: 4, fontSize: 11 }}>
                brew install gh
              </code>
              {' '}to enable create_mission from GitHub issues.
            </div>
          </div>
        ) : null}
      </Disclosure>

      {/* ── Manual config (collapsed) ── */}
      <Disclosure title="Manual config" subtitle="Prefer to edit the file yourself? Copy the JSON here.">
        <div style={{
          position: 'relative',
          borderRadius: 12,
          border: '1px solid var(--t-panel-border)',
          background: 'var(--t-input-bg)',
          overflow: 'hidden',
        }}>
          <button
            type="button"
            onClick={() => { void copyToClipboard(); }}
            style={{
              position: 'absolute',
              top: 10,
              right: 10,
              padding: '5px 12px',
              borderRadius: 8,
              border: '1px solid var(--t-accent-border)',
              background: copied ? 'var(--t-accent)' : 'var(--t-accent-soft)',
              color: copied ? '#ffffff' : 'var(--t-accent)',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: APP_FONT_STACK,
              letterSpacing: '-0.01em',
              transition: 'background 120ms ease, color 120ms ease',
              zIndex: 1,
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          <pre style={{
            margin: 0,
            padding: 14,
            fontFamily: MONO_FONT,
            fontSize: 12,
            color: 'var(--t-text)',
            overflow: 'auto',
            maxHeight: 260,
            lineHeight: 1.55,
          }}>
            {configJson}
          </pre>
        </div>
      </Disclosure>
    </div>
  );
}

// ── Disclosure ──

const inputStyle: CSSProperties = {
  width: '100%',
  height: 40,
  padding: '0 12px',
  borderRadius: 10,
  border: '1px solid var(--t-panel-border)',
  background: 'var(--t-input-bg)',
  color: 'var(--t-text)',
  fontSize: 13,
  fontFamily: APP_FONT_STACK,
  outline: 'none',
  boxSizing: 'border-box',
};

const textAreaStyle: CSSProperties = {
  width: '100%',
  minHeight: 94,
  padding: '10px 12px',
  borderRadius: 10,
  border: '1px solid var(--t-panel-border)',
  background: 'var(--t-input-bg)',
  color: 'var(--t-text)',
  fontSize: 12,
  fontFamily: MONO_FONT,
  outline: 'none',
  boxSizing: 'border-box',
  resize: 'vertical',
  lineHeight: 1.5,
};

function Disclosure({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '10px 2px',
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          textAlign: 'left',
          fontFamily: APP_FONT_STACK,
        }}
      >
        <span style={{ display: 'inline-flex', color: 'var(--t-text-muted)' }}>
          {open ? <ChevronDown size={14} strokeWidth={2.2} /> : <ChevronRight size={14} strokeWidth={2.2} />}
        </span>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text)', letterSpacing: '-0.01em' }}>
          {title}
        </span>
        {subtitle ? (
          <span style={{ fontSize: 12, color: 'var(--t-text-muted)', marginLeft: 4 }}>
            {subtitle}
          </span>
        ) : null}
      </button>
      {open ? <div style={{ marginTop: 8 }}>{children}</div> : null}
    </div>
  );
}

function BuiltinServerPill({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: '6px 10px',
      borderRadius: 999,
      border: '1px solid rgba(143, 180, 255, 0.24)',
      background: 'rgba(143, 180, 255, 0.12)',
      color: 'var(--t-text)',
      fontSize: 11,
      fontWeight: 600,
    }}>
      <span style={{ display: 'inline-flex', color: 'var(--t-accent)' }}>{icon}</span>
      {label}
    </span>
  );
}

// ── Claude target card ──

function ClaudeTargetCard({
  label,
  target: _target,
  status,
  installing,
  disabled = false,
  note,
  onInstall,
  onRemove,
  restartHint,
}: {
  label: string;
  target: Target;
  status: ClaudeTargetStatus | null;
  installing: boolean;
  disabled?: boolean;
  note: { target: Target; message: string; ok: boolean } | null;
  onInstall: () => void;
  onRemove: () => void;
  restartHint: string;
}) {
  const connected = Boolean(status?.alreadyUpToDate);
  const needsUpdate = Boolean(status?.alreadyRegistered && !status?.alreadyUpToDate);

  const statusLine = !status
    ? 'Checking…'
    : connected
      ? 'Connected to o8'
      : needsUpdate
        ? 'Older o8 entry found — click Update'
        : status.fileExists
          ? `Ready to connect${status.otherServers.length > 0 ? ` (${status.otherServers.length} other server${status.otherServers.length === 1 ? '' : 's'})` : ''}`
          : 'Not connected yet';

  const primary = connected
    ? { label: 'Connected', disabled: true }
    : needsUpdate
      ? { label: 'Update', disabled: false }
      : { label: 'Connect', disabled: false };

  const primaryDisabled = disabled || installing || primary.disabled;

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      padding: '14px 16px',
      borderRadius: 14,
      background: 'var(--t-panel)',
      border: `1px solid ${connected ? 'rgba(34, 197, 94, 0.24)' : 'var(--t-panel-border)'}`,
      boxShadow: connected ? '0 0 0 1px rgba(34, 197, 94, 0.1) inset' : 'none',
      transition: 'border-color 180ms ease, box-shadow 180ms ease',
      opacity: disabled ? 0.55 : 1,
    }}>
      {/* Logo */}
      <div style={{
        width: 40,
        height: 40,
        borderRadius: 10,
        display: 'grid',
        placeItems: 'center',
        background: 'var(--t-bg-card, rgba(148, 163, 184, 0.1))',
        flexShrink: 0,
      }}>
        <ClaudeIcon size={22} />
      </div>

      {/* Name + status */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--t-text)', letterSpacing: '-0.01em' }}>
            {label}
          </span>
          {connected ? (
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '2px 8px',
              borderRadius: 999,
              background: 'rgba(34, 197, 94, 0.14)',
              color: '#16a34a',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.02em',
              textTransform: 'uppercase',
            }}>
              Connected
            </span>
          ) : null}
        </div>
        <div style={{
          marginTop: 2,
          fontSize: 12,
          color: 'var(--t-text-muted)',
          lineHeight: 1.4,
        }}>
          {statusLine}
        </div>
        {note ? (
          <div style={{
            marginTop: 8,
            padding: '7px 10px',
            borderRadius: 8,
            fontSize: 11,
            lineHeight: 1.5,
            background: note.ok ? 'rgba(34, 197, 94, 0.08)' : 'rgba(239, 68, 68, 0.08)',
            border: `1px solid ${note.ok ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)'}`,
            color: note.ok ? '#16a34a' : '#ef4444',
          }}>
            {note.ok ? `${note.message} ${restartHint}` : note.message}
          </div>
        ) : null}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        {status?.alreadyRegistered ? (
          <button
            type="button"
            onClick={onRemove}
            disabled={installing || disabled}
            style={{
              padding: '7px 12px',
              borderRadius: 9,
              border: '1px solid var(--t-btn-secondary-border)',
              background: 'transparent',
              color: 'var(--t-text-muted)',
              fontSize: 12,
              fontWeight: 500,
              cursor: installing || disabled ? 'default' : 'pointer',
              opacity: installing ? 0.6 : 1,
              fontFamily: APP_FONT_STACK,
              minHeight: 32,
            }}
          >
            Remove
          </button>
        ) : null}
        <button
          type="button"
          onClick={onInstall}
          disabled={primaryDisabled}
          style={{
            padding: '7px 14px',
            borderRadius: 9,
            border: connected
              ? '1px solid rgba(34, 197, 94, 0.32)'
              : '1px solid rgba(143, 180, 255, 0.36)',
            background: connected
              ? 'rgba(34, 197, 94, 0.14)'
              : primaryDisabled
                ? 'rgba(143, 180, 255, 0.1)'
                : 'rgba(143, 180, 255, 0.22)',
            color: connected ? '#16a34a' : 'var(--t-accent)',
            fontSize: 12,
            fontWeight: 700,
            cursor: primaryDisabled ? 'default' : 'pointer',
            opacity: installing ? 0.7 : 1,
            fontFamily: APP_FONT_STACK,
            minHeight: 32,
            letterSpacing: '-0.01em',
            boxShadow: !primaryDisabled && !connected ? '0 0 10px rgba(143, 180, 255, 0.24)' : 'none',
            transition: 'background 140ms ease, box-shadow 140ms ease',
          }}
        >
          {installing ? 'Working…' : primary.label}
        </button>
      </div>
    </div>
  );
}
