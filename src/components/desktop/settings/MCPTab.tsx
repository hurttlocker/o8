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

import { useCallback, useEffect, useState } from 'react';
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
  HairlineRule,
  SectionLabel,
  TabBreadcrumb,
  TabHeading,
  SETTINGS_CONTENT_MAX_WIDTH,
} from './shared';
import { ChevronDown, ChevronRight } from '../lucide-shims';
import { ExternalMcpServersSection } from './mcp/ExternalMcpServersSection';
import { MONO_FONT } from './mcp/shared';

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
type ExternalTarget = 'hermes' | 'openclaw';
type AnyTarget = Target | ExternalTarget;

interface ClaudeTargetStatus {
  target: Target;
  path: string;
  fileExists: boolean;
  alreadyRegistered: boolean;
  alreadyUpToDate: boolean;
  otherServers: string[];
  size: number;
}

interface ExternalTargetStatus {
  target: ExternalTarget;
  installed: boolean;
  cliPath: string | null;
  registered: boolean;
  hint?: string;
}

export function MCPTab() {
  const [data, setData] = useState<McpConfigResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [desktopStatus, setDesktopStatus] = useState<ClaudeTargetStatus | null>(null);
  const [codeStatus, setCodeStatus] = useState<ClaudeTargetStatus | null>(null);
  const [hermesStatus, setHermesStatus] = useState<ExternalTargetStatus | null>(null);
  const [openclawStatus, setOpenclawStatus] = useState<ExternalTargetStatus | null>(null);
  const [installing, setInstalling] = useState<AnyTarget | null>(null);
  const [installNote, setInstallNote] = useState<{ target: AnyTarget; message: string; ok: boolean } | null>(null);

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

  const loadExternalStatus = useCallback(async () => {
    try {
      const [hermes, openclaw] = await Promise.all([
        fetch('/api/setup/external-client?target=hermes').then((r) => r.json() as Promise<ExternalTargetStatus>),
        fetch('/api/setup/external-client?target=openclaw').then((r) => r.json() as Promise<ExternalTargetStatus>),
      ]);
      setHermesStatus(hermes);
      setOpenclawStatus(openclaw);
    } catch {
      // Silent — fall back to "not installed" rendering.
    }
  }, []);

  useEffect(() => {
    void load();
    void loadClaudeStatus();
    void loadExternalStatus();
  }, [load, loadClaudeStatus, loadExternalStatus]);

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

  const installExternal = useCallback(async (target: ExternalTarget) => {
    setInstalling(target);
    setInstallNote(null);
    try {
      const res = await fetch('/api/setup/external-client', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target }),
      });
      const body = await res.json() as { ok: boolean; detail?: string; error?: string };
      if (res.ok && body.ok) {
        setInstallNote({ target, message: body.detail || 'Installed.', ok: true });
        await loadExternalStatus();
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
  }, [loadExternalStatus]);

  const removeExternal = useCallback(async (target: ExternalTarget) => {
    setInstalling(target);
    setInstallNote(null);
    try {
      const res = await fetch('/api/setup/external-client', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target, remove: true }),
      });
      const body = await res.json() as { ok: boolean; detail?: string; error?: string };
      if (res.ok && body.ok) {
        setInstallNote({ target, message: body.detail || 'Removed.', ok: true });
        await loadExternalStatus();
      } else {
        setInstallNote({ target, message: body.error || body.detail || 'Failed.', ok: false });
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
  }, [loadExternalStatus]);

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

  const copyToClipboard = useCallback(async () => {
    if (!data) return;
    const text = JSON.stringify(data.fullConfig, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
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

  if (error) {
    return (
      <div style={{
        paddingTop: 40,
        color: 'var(--t-text-muted)',
        fontSize: 13,
        fontFamily: APP_FONT_STACK,
      }}>
        Failed to load MCP config: {error}
      </div>
    );
  }

  if (!data) {
    return (
      <div style={{
        paddingTop: 40,
        color: 'var(--t-text-muted)',
        fontSize: 13,
        fontFamily: APP_FONT_STACK,
      }}>
        Loading MCP config...
      </div>
    );
  }

  const configJson = JSON.stringify(data.fullConfig, null, 2);
  const d = data.diagnostics;
  const ready = d.nodeInstalled;

  return (
    <div style={{
      paddingTop: 8,
      paddingLeft: 8,
      paddingRight: 32,
      paddingBottom: 40,
      maxWidth: SETTINGS_CONTENT_MAX_WIDTH,
      fontFamily: APP_FONT_STACK,
    }}>
      <TabBreadcrumb tab="MCP" />
      <TabHeading
        title="MCP"
        subtitle="One click to let Claude Desktop or Claude Code dispatch work to your o8 fleet. Your other MCP servers stay untouched — we only write the o8 entry."
      />

      {!ready ? (
        <div style={{
          marginBottom: 28,
          paddingTop: 2,
          paddingBottom: 2,
        }}>
          <div style={{
            fontSize: 13,
            fontWeight: 500,
            color: 'var(--t-text)',
            marginBottom: 4,
            letterSpacing: '-0.005em',
          }}>
            <span style={{
              fontFamily: MONO_FONT_STACK,
              fontSize: 11,
              fontWeight: 500,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: '#ef4444',
              marginRight: 8,
            }}>
              [error]
            </span>
            Install Node.js first
          </div>
          <div style={{ color: 'var(--t-text-secondary)', fontSize: 12, lineHeight: 1.55 }}>
            o8&apos;s MCP server runs on Node. Grab the latest LTS from{' '}
            <a
              href="https://nodejs.org"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                color: RAMS_ACCENT,
                textDecoration: 'underline',
                textUnderlineOffset: 2,
              }}
            >
              nodejs.org
            </a>
            {' '}(v22+), then relaunch o8.
          </div>
        </div>
      ) : null}

      {/* 01 — CLAUDE DESKTOP */}
      <section style={{ marginBottom: 28 }}>
        <SectionLabel number="01">CLAUDE DESKTOP</SectionLabel>
        <ClaudeTargetRow
          target="claude-desktop"
          status={desktopStatus}
          installing={installing === 'claude-desktop'}
          disabled={!ready}
          note={installNote?.target === 'claude-desktop' ? installNote : null}
          onInstall={() => { void installToClaude('claude-desktop'); }}
          onRemove={() => { void removeFromClaude('claude-desktop'); }}
          restartHint="Quit Claude Desktop (Cmd+Q) and reopen it."
        />
      </section>

      {/* 02 — CLAUDE CODE */}
      <section style={{ marginBottom: 28 }}>
        <SectionLabel number="02">CLAUDE CODE</SectionLabel>
        <ClaudeTargetRow
          target="claude-code"
          status={codeStatus}
          installing={installing === 'claude-code'}
          disabled={!ready}
          note={installNote?.target === 'claude-code' ? installNote : null}
          onInstall={() => { void installToClaude('claude-code'); }}
          onRemove={() => { void removeFromClaude('claude-code'); }}
          restartHint="Restart Claude Code or run /mcp reload."
        />
      </section>

      {/* 03 — HERMES AGENT */}
      <section style={{ marginBottom: 28 }}>
        <SectionLabel number="03">HERMES AGENT</SectionLabel>
        <ExternalClientRow
          target="hermes"
          status={hermesStatus}
          installing={installing === 'hermes'}
          disabled={!ready}
          note={installNote?.target === 'hermes' ? installNote : null}
          onInstall={() => { void installExternal('hermes'); }}
          onRemove={() => { void removeExternal('hermes'); }}
          restartHint="Run /reload-mcp inside hermes to load the o8 tools."
        />
      </section>

      {/* 04 — OPENCLAW */}
      <section style={{ marginBottom: 28 }}>
        <SectionLabel number="04">OPENCLAW</SectionLabel>
        <ExternalClientRow
          target="openclaw"
          status={openclawStatus}
          installing={installing === 'openclaw'}
          disabled={!ready}
          note={installNote?.target === 'openclaw' ? installNote : null}
          onInstall={() => { void installExternal('openclaw'); }}
          onRemove={() => { void removeExternal('openclaw'); }}
          restartHint="Restart your OpenClaw gateway / agent session to pick up the new server."
        />
      </section>

      {/* 05 — EXTERNAL SERVERS */}
      <section style={{ marginBottom: 28 }}>
        <SectionLabel number="05">EXTERNAL SERVERS</SectionLabel>
        <ExternalMcpServersSection />
      </section>

      {/* 06 — DIAGNOSTICS */}
      <section style={{ marginBottom: 24 }}>
        <SectionLabel number="06">DIAGNOSTICS</SectionLabel>
        <Disclosure title="System details" subtitle="Show the runtime environment o8 is using.">
          <div style={{
            paddingTop: 8,
            borderTop: `1px solid ${RAMS_HAIRLINE_SOFT}`,
          }}>
            <DiagnosticRow label="Backend" ok detail={`${d.apiBase}${d.portSource ? ` (${d.portSource === 'env' ? 'env var' : d.portSource === 'file' ? 'port file' : 'default'})` : ''}`} />
            <DiagnosticRow label="Install mode" ok detail={d.bundled ? 'Packaged Tauri app' : 'Dev checkout'} />
            <DiagnosticRow label="Node.js" ok={d.nodeInstalled} detail={d.nodeBin} />
            <DiagnosticRow label="Codex CLI" ok={d.codexInstalled} detail={d.codexBin} />
            <DiagnosticRow label="GitHub CLI" ok={d.ghInstalled} detail={d.ghBin} />
            <DiagnosticRow label="Database" ok={d.dbExists} detail={d.dbExists ? `${(d.dbSize / 1024 / 1024).toFixed(1)} MB` : 'not initialized'} />
            <DiagnosticRow
              label="Webview tools"
              ok={d.webviewToolsAvailable}
              detail={d.webviewToolsAvailable
                ? `Connected to ${d.webviewSocketPath}`
                : 'Off — launch with --features dev-mcp-plugin'}
            />
          </div>
          {d.nodeInstalled && !d.codexInstalled ? (
            <div style={{
              marginTop: 14,
            }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--t-text)', marginBottom: 4 }}>
                <span style={{
                  fontFamily: MONO_FONT_STACK,
                  fontSize: 11,
                  fontWeight: 500,
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  color: '#f59e0b',
                  marginRight: 8,
                }}>
                  [warn]
                </span>
                Codex CLI not found
              </div>
              <div style={{ color: 'var(--t-text-secondary)', fontSize: 12, lineHeight: 1.55 }}>
                Install with{' '}
                <code style={{ fontFamily: MONO_FONT_STACK, fontSize: 11, color: RAMS_ACCENT }}>
                  npm i -g @openai/codex-cli
                </code>
                {' '}and sign in with ChatGPT Plus or an OPENAI_API_KEY. Without Codex, missions still dispatch via Claude Code or Gemini — but Codex is the recommended default workhorse.
              </div>
            </div>
          ) : null}
          {d.nodeInstalled && d.codexInstalled && !d.ghInstalled ? (
            <div style={{
              marginTop: 14,
            }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--t-text)', marginBottom: 4 }}>
                <span style={{
                  fontFamily: MONO_FONT_STACK,
                  fontSize: 11,
                  fontWeight: 500,
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  color: RAMS_INK_QUIET,
                  marginRight: 8,
                }}>
                  [optional]
                </span>
                GitHub CLI not found
              </div>
              <div style={{ color: 'var(--t-text-muted)', fontSize: 12, lineHeight: 1.55 }}>
                Install with{' '}
                <code style={{ fontFamily: MONO_FONT_STACK, fontSize: 11, color: 'var(--t-text-secondary)' }}>
                  brew install gh
                </code>
                {' '}to enable create_mission from GitHub issues.
              </div>
            </div>
          ) : null}
        </Disclosure>

        <div style={{ marginTop: 8 }}>
          <Disclosure title="Manual config" subtitle="Prefer to edit the file yourself?">
            <div style={{
              position: 'relative',
              border: `1px solid ${RAMS_HAIRLINE_SOFT}`,
              background: 'var(--t-input-bg)',
              overflow: 'hidden',
              borderRadius: 4,
            }}>
              <button
                type="button"
                onClick={() => { void copyToClipboard(); }}
                style={{
                  position: 'absolute',
                  top: 8,
                  right: 8,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  minHeight: 36,
                  paddingLeft: 10,
                  paddingRight: 10,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderStyle: 'solid',
                  borderColor: copied ? RAMS_CONTROL_ACTIVE_BORDER : RAMS_CONTROL_BORDER,
                  background: copied ? RAMS_CONTROL_ACTIVE_BG : RAMS_CONTROL_BG,
                  color: copied ? RAMS_ACCENT : 'var(--t-text-muted)',
                  fontSize: 11,
                  fontFamily: MONO_FONT_STACK,
                  fontWeight: 600,
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                  cursor: 'pointer',
                  zIndex: 1,
                }}
              >
                {copied ? 'copied' : 'copy'}
              </button>
              <pre style={{
                margin: 0,
                paddingTop: 14,
                paddingBottom: 14,
                paddingLeft: 14,
                paddingRight: 14,
                fontFamily: MONO_FONT,
                fontSize: 12,
                color: 'var(--t-text)',
                overflow: 'auto',
                maxHeight: 260,
                lineHeight: 1.6,
              }}>
                {configJson}
              </pre>
            </div>
          </Disclosure>
        </div>

        <div style={{ marginTop: 20 }}>
          <HairlineRule />
        </div>
      </section>
    </div>
  );
}

// ── Disclosure ──

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
          minHeight: 44,
          paddingTop: 8,
          paddingBottom: 8,
          paddingLeft: 0,
          paddingRight: 0,
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          textAlign: 'left',
          fontFamily: APP_FONT_STACK,
        }}
      >
        <span style={{ display: 'inline-flex', color: 'var(--t-text-muted)' }}>
          {open ? <ChevronDown size={13} strokeWidth={2} /> : <ChevronRight size={13} strokeWidth={2} />}
        </span>
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--t-text)', letterSpacing: '-0.01em' }}>
          {title}
        </span>
        {subtitle ? (
          <span style={{ fontSize: 12, color: 'var(--t-text-muted)', marginLeft: 4 }}>
            — {subtitle}
          </span>
        ) : null}
      </button>
      {open ? <div style={{ marginTop: 4 }}>{children}</div> : null}
    </div>
  );
}

// ── Claude target row ──

function ClaudeTargetRow({
  status,
  installing,
  disabled = false,
  note,
  onInstall,
  onRemove,
  restartHint,
}: {
  target: Target;
  status: ClaudeTargetStatus | null;
  installing: boolean;
  disabled?: boolean;
  note: { target: AnyTarget; message: string; ok: boolean } | null;
  onInstall: () => void;
  onRemove: () => void;
  restartHint: string;
}) {
  const connected = Boolean(status?.alreadyUpToDate);
  const needsUpdate = Boolean(status?.alreadyRegistered && !status?.alreadyUpToDate);

  const statusLine = !status
    ? 'Checking...'
    : connected
      ? 'Connected. o8 tools available in this client.'
      : needsUpdate
        ? 'Older o8 entry found. Update to the current config.'
        : status.fileExists
          ? `Ready to connect${status.otherServers.length > 0 ? ` (${status.otherServers.length} other server${status.otherServers.length === 1 ? '' : 's'} preserved)` : ''}.`
          : 'Not connected yet.';

  const primaryLabel = connected ? 'connected' : needsUpdate ? 'update' : 'install';
  const primaryDisabled = disabled || installing || connected;

  return (
    <div style={{
      paddingTop: 10,
      paddingBottom: 16,
      borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
      opacity: disabled ? 0.55 : 1,
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 20,
        flexWrap: 'wrap',
      }}>
        <div style={{ flex: 1, minWidth: 0, maxWidth: 520 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
            <BracketLabel tone={connected ? 'quiet' : 'accent'}>
              {connected ? 'connected' : needsUpdate ? 'needs update' : 'not connected'}
            </BracketLabel>
          </div>
          <div style={{
            fontSize: 13,
            color: 'var(--t-text-secondary)',
            lineHeight: 1.55,
          }}>
            {statusLine}
          </div>
          {status?.path ? (
            <div style={{
              marginTop: 6,
              fontFamily: MONO_FONT_STACK,
              fontSize: 11,
              letterSpacing: '0.02em',
              color: RAMS_INK_QUIET,
              wordBreak: 'break-all',
            }}>
              {status.path}
            </div>
          ) : null}
          {note ? (
            <div style={{
              marginTop: 8,
              fontSize: 12,
              lineHeight: 1.55,
              color: note.ok ? '#15803d' : '#dc2626',
            }}>
              {note.ok ? `${note.message} ${restartHint}` : note.message}
            </div>
          ) : null}
        </div>

        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          {status?.alreadyRegistered ? (
            <button
              type="button"
              onClick={onRemove}
              disabled={installing || disabled}
              style={quietActionStyle(installing || disabled)}
            >
              remove
            </button>
          ) : null}
          <button
            type="button"
            onClick={onInstall}
            disabled={primaryDisabled}
            style={accentActionStyle(primaryDisabled)}
          >
            {installing ? 'working...' : primaryLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function ExternalClientRow({
  target,
  status,
  installing,
  disabled = false,
  note,
  onInstall,
  onRemove,
  restartHint,
}: {
  target: ExternalTarget;
  status: ExternalTargetStatus | null;
  installing: boolean;
  disabled?: boolean;
  note: { target: AnyTarget; message: string; ok: boolean } | null;
  onInstall: () => void;
  onRemove: () => void;
  restartHint: string;
}) {
  const cliInstalled = Boolean(status?.installed);
  const registered = Boolean(status?.registered);

  const labelText = target === 'hermes' ? 'Hermes Agent' : 'OpenClaw';

  const statusLine = !status
    ? 'Checking...'
    : !cliInstalled
      ? `${labelText} CLI not found.`
      : registered
        ? `Connected. The o8 tools are wired into ${labelText}.`
        : `Ready to connect. ${labelText} CLI detected.`;

  const primaryLabel = registered ? 'connected' : 'install';
  const primaryDisabled = disabled || installing || !cliInstalled || registered;

  return (
    <div style={{
      paddingTop: 10,
      paddingBottom: 16,
      borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
      opacity: disabled ? 0.55 : 1,
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 20,
        flexWrap: 'wrap',
      }}>
        <div style={{ flex: 1, minWidth: 0, maxWidth: 520 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
            <BracketLabel tone={registered ? 'quiet' : cliInstalled ? 'accent' : 'quiet'}>
              {!cliInstalled ? 'not installed' : registered ? 'connected' : 'not connected'}
            </BracketLabel>
          </div>
          <div style={{
            fontSize: 13,
            color: 'var(--t-text-secondary)',
            lineHeight: 1.55,
          }}>
            {statusLine}
          </div>
          {status?.cliPath ? (
            <div style={{
              marginTop: 6,
              fontFamily: MONO_FONT_STACK,
              fontSize: 11,
              letterSpacing: '0.02em',
              color: RAMS_INK_QUIET,
              wordBreak: 'break-all',
            }}>
              {status.cliPath}
            </div>
          ) : null}
          {!cliInstalled && status?.hint ? (
            <div style={{
              marginTop: 8,
              fontFamily: MONO_FONT_STACK,
              fontSize: 11,
              color: 'var(--t-text-muted)',
              lineHeight: 1.5,
              wordBreak: 'break-all',
            }}>
              {status.hint}
            </div>
          ) : null}
          {note ? (
            <div style={{
              marginTop: 8,
              fontSize: 12,
              lineHeight: 1.55,
              color: note.ok ? '#15803d' : '#dc2626',
            }}>
              {note.ok ? `${note.message} ${restartHint}` : note.message}
            </div>
          ) : null}
        </div>

        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          {registered ? (
            <button
              type="button"
              onClick={onRemove}
              disabled={installing || disabled}
              style={quietActionStyle(installing || disabled)}
            >
              remove
            </button>
          ) : null}
          <button
            type="button"
            onClick={onInstall}
            disabled={primaryDisabled}
            style={accentActionStyle(primaryDisabled)}
          >
            {installing ? 'working...' : primaryLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function DiagnosticRow({ label, ok, detail }: { label: string; ok: boolean; detail?: string | null }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      paddingTop: 10,
      paddingBottom: 10,
      borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
    }}>
      <span style={{
        width: 6,
        height: 6,
        borderRadius: 3,
        background: ok ? '#22c55e' : '#ef4444',
        flexShrink: 0,
      }} />
      <span style={{
        fontFamily: MONO_FONT_STACK,
        fontSize: 11,
        fontWeight: 400,
        color: RAMS_INK_QUIET,
        textTransform: 'uppercase',
        letterSpacing: '0.14em',
        minWidth: 130,
      }}>
        {label}
      </span>
      <span style={{
        fontFamily: MONO_FONT_STACK,
        fontSize: 12,
        color: 'var(--t-text-secondary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        flex: 1,
      }}>
        {detail || (ok ? 'installed' : 'missing')}
      </span>
    </div>
  );
}

function accentActionStyle(disabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    paddingLeft: 14,
    paddingRight: 14,
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: disabled ? RAMS_CONTROL_BORDER : RAMS_CONTROL_ACTIVE_BORDER,
    background: disabled ? 'transparent' : RAMS_CONTROL_ACTIVE_BG,
    fontFamily: MONO_FONT_STACK,
    fontSize: 11.5,
    fontWeight: 600,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    color: disabled ? RAMS_INK_QUIET : RAMS_ACCENT,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.6 : 1,
    transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), border-color 150ms cubic-bezier(0.22, 1, 0.36, 1), color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
  };
}

function quietActionStyle(disabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    paddingLeft: 14,
    paddingRight: 14,
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: RAMS_CONTROL_BORDER,
    background: disabled ? 'transparent' : RAMS_CONTROL_BG,
    fontFamily: MONO_FONT_STACK,
    fontSize: 11.5,
    fontWeight: 600,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    color: 'var(--t-text-muted)',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.6 : 1,
    transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), border-color 150ms cubic-bezier(0.22, 1, 0.36, 1), color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
  };
}
