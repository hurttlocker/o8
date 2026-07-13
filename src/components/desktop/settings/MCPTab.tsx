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
  RAMS_CONTROL_ACTIVE_BG,
  RAMS_CONTROL_ACTIVE_BORDER,
  RAMS_CONTROL_BG,
  RAMS_CONTROL_BORDER,
  RAMS_HAIRLINE_SOFT,
  RAMS_INK_QUIET,
  TabHeading,
  SETTINGS_CONTENT_MAX_WIDTH,
} from './shared';
import { SettingsGroup } from './grouped';
import { ChevronDown, ChevronRight } from '../lucide-shims';
import { ExternalMcpServersSection } from './mcp/ExternalMcpServersSection';
import { AccessPointDiagnostics, type AccessPointDiagnosticsData } from './mcp/AccessPointDiagnostics';
import {
  ClaudeTargetRow,
  ExternalClientRow,
  type AnyTarget,
  type ClaudeTargetStatus,
  type ExternalTarget,
  type ExternalTargetStatus,
  type Target,
} from './mcp/ClientRows';
import { MONO_FONT } from './mcp/shared';

interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface McpConfigResponse {
  setupReady?: boolean;
  setupBlockedDetail?: string | null;
  setupWarning?: string | null;
  server: McpServerConfig | null;
  fullConfig: { mcpServers: Record<string, McpServerConfig> };
  instructions: { claudeDesktop: string; claudeCode: string };
  diagnostics: AccessPointDiagnosticsData & {
    apiPort?: number;
    wsPort?: number;
    platform: string;
    dataDir: string;
  };
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
    if (!data || data.setupReady === false) return;
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
  const ready = d.cli.nodeResolvable;
  const setupReady = data.setupReady !== false;

  return (
    <div style={{
      paddingTop: 8,
      paddingLeft: 8,
      paddingRight: 32,
      paddingBottom: 40,
      maxWidth: SETTINGS_CONTENT_MAX_WIDTH,
      fontFamily: APP_FONT_STACK,
    }}>
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
            fontWeight: 300,
            color: 'var(--t-text)',
            marginBottom: 4,
            letterSpacing: '-0.005em',
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

      {!setupReady ? (
        <div style={{
          marginBottom: 28,
          paddingTop: 2,
          paddingBottom: 2,
        }}>
          <div style={{
            fontSize: 13,
            fontWeight: 300,
            color: 'var(--t-text)',
            marginBottom: 4,
            letterSpacing: '-0.005em',
          }}>
            <span style={{
              fontFamily: MONO_FONT_STACK,
              fontSize: 11,
              fontWeight: 300,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: '#f59e0b',
              marginRight: 8,
            }}>
              [wait]
            </span>
            MCP setup is still finishing
          </div>
          <div style={{ color: 'var(--t-text-secondary)', fontSize: 12, lineHeight: 1.55 }}>
            {data.setupBlockedDetail ?? 'Finish first launch, then reconnect your MCP client.'}
          </div>
        </div>
      ) : null}

      {/* Non-blocking degradation note (e.g. codebase-memory download failed):
          Connect stays ENABLED — the config generator simply omits the missing
          entry — so this renders as a calm footnote, never a [WAIT] block.
          (2026-07-09 beta bug: a failed optional download blocked setup for days.) */}
      {setupReady && data.setupWarning ? (
        <div style={{
          marginBottom: 28,
          paddingTop: 2,
          paddingBottom: 2,
          color: 'var(--t-text-secondary)',
          fontSize: 12,
          lineHeight: 1.55,
        }}>
          {data.setupWarning}
        </div>
      ) : null}

      <section>
        <SettingsGroup header="Clients">
          <ClaudeTargetRow
            target="claude-desktop"
            label="Claude Desktop"
            status={desktopStatus}
            installing={installing === 'claude-desktop'}
            disabled={!ready || !setupReady}
            note={installNote?.target === 'claude-desktop' ? installNote : null}
            onInstall={() => { void installToClaude('claude-desktop'); }}
            onRemove={() => { void removeFromClaude('claude-desktop'); }}
            restartHint="Quit Claude Desktop (Cmd+Q) and reopen it."
            divider
          />
          <ClaudeTargetRow
            target="claude-code"
            label="Claude Code"
            status={codeStatus}
            installing={installing === 'claude-code'}
            disabled={!ready || !setupReady}
            note={installNote?.target === 'claude-code' ? installNote : null}
            onInstall={() => { void installToClaude('claude-code'); }}
            onRemove={() => { void removeFromClaude('claude-code'); }}
            restartHint="Restart Claude Code or run /mcp reload."
            divider
          />
          <ExternalClientRow
            target="hermes"
            status={hermesStatus}
            installing={installing === 'hermes'}
            disabled={!ready}
            note={installNote?.target === 'hermes' ? installNote : null}
            onInstall={() => { void installExternal('hermes'); }}
            onRemove={() => { void removeExternal('hermes'); }}
            restartHint="Run /reload-mcp inside hermes to load the o8 tools."
            divider
          />
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
        </SettingsGroup>
      </section>

      <section style={{ marginTop: 28 }}>
        <SettingsGroup header="External servers">
          <div style={{ paddingTop: 14, paddingBottom: 14, paddingLeft: 14, paddingRight: 14 }}>
            <ExternalMcpServersSection />
          </div>
        </SettingsGroup>
      </section>

      <section style={{ marginTop: 28 }}>
        <SettingsGroup header="Diagnostics">
          <div style={{ paddingTop: 10, paddingBottom: 14, paddingLeft: 14, paddingRight: 14 }}>
            <Disclosure title="System details" subtitle="Show the runtime environment o8 is using.">
              <AccessPointDiagnostics diagnostics={d} />
              {d.nodeInstalled && !d.codexInstalled ? (
                <div style={{
                  marginTop: 14,
                }}>
                  <div style={{ fontSize: 13, fontWeight: 300, color: 'var(--t-text)', marginBottom: 4 }}>
                    <span style={{
                      fontFamily: MONO_FONT_STACK,
                      fontSize: 11,
                      fontWeight: 300,
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
                  <div style={{ fontSize: 13, fontWeight: 300, color: 'var(--t-text)', marginBottom: 4 }}>
                    <span style={{
                      fontFamily: MONO_FONT_STACK,
                      fontSize: 11,
                      fontWeight: 300,
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
              <Disclosure title="Manual config" subtitle={setupReady ? 'Prefer to edit the file yourself?' : 'Config appears after first launch finishes.'}>
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
                    disabled={!setupReady}
                    style={{
                      position: 'absolute',
                      top: 8,
                      right: 8,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      minHeight: 32,
                      paddingLeft: 12,
                      paddingRight: 12,
                      borderRadius: 9,
                      borderWidth: 1,
                      borderStyle: 'solid',
                      borderColor: copied ? RAMS_CONTROL_ACTIVE_BORDER : RAMS_CONTROL_BORDER,
                      background: copied ? RAMS_CONTROL_ACTIVE_BG : RAMS_CONTROL_BG,
                      color: copied ? RAMS_ACCENT : 'var(--t-text-muted)',
                      fontSize: 12,
                      fontFamily: APP_FONT_STACK,
                      fontWeight: 400,
                      letterSpacing: '-0.01em',
                      textTransform: 'capitalize',
                      cursor: setupReady ? 'pointer' : 'default',
                      opacity: setupReady ? 1 : 0.55,
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
          </div>
        </SettingsGroup>
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
        <span style={{ fontSize: 13, fontWeight: 300, color: 'var(--t-text)', letterSpacing: '-0.01em' }}>
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
