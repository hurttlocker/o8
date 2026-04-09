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
  };
}

const MONO_FONT = '"SF Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

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

  useEffect(() => { void load(); }, [load]);

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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      {/* Status */}
      <div>
        <SectionHeader
          title="MCP Integration"
          subtitle="Connect Claude Desktop or Claude Code to o8 so the orchestrator can dispatch work, approve merges, and read agent status via MCP tools."
        />
        <div style={{
          padding: 14,
          borderRadius: 12,
          background: 'var(--t-panel)',
          border: '1px solid var(--t-panel-border)',
        }}>
          <StatusRow label="Backend" ok={true} detail={d.apiBase} />
          <StatusRow label="Install mode" ok={true} detail={d.bundled ? 'Packaged Tauri app' : 'Dev checkout'} />
          <StatusRow label="Node.js" ok={d.nodeInstalled} detail={d.nodeBin} />
          <StatusRow label="Codex CLI" ok={d.codexInstalled} detail={d.codexBin} />
          <StatusRow label="GitHub CLI" ok={d.ghInstalled} detail={d.ghBin} />
          <StatusRow label="Database" ok={d.dbExists} detail={d.dbExists ? `${(d.dbSize / 1024 / 1024).toFixed(1)} MB` : 'not initialized'} />
        </div>
        {(!d.nodeInstalled || !d.codexInstalled) ? (
          <div style={{
            marginTop: 10,
            padding: 10,
            borderRadius: 10,
            background: 'rgba(239, 68, 68, 0.08)',
            border: '1px solid rgba(239, 68, 68, 0.2)',
            fontSize: 12,
            color: 'var(--t-text)',
            lineHeight: 1.5,
          }}>
            {!d.nodeInstalled ? (
              <div>Install Node.js from <span style={{ color: 'var(--t-accent)' }}>nodejs.org</span> (required for the MCP server).</div>
            ) : null}
            {!d.codexInstalled ? (
              <div>Install Codex CLI: <code style={{ fontFamily: MONO_FONT }}>npm i -g @openai/codex-cli</code></div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Config JSON */}
      <div>
        <SectionHeader
          title="Configuration"
          subtitle="Copy this JSON into your Claude Desktop or Claude Code MCP config."
        />
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
              fontFamily: 'system-ui, sans-serif',
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
      </div>

      {/* Instructions */}
      <div>
        <SectionHeader title="Setup instructions" />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{
            padding: 14,
            borderRadius: 12,
            background: 'var(--t-panel)',
            border: '1px solid var(--t-panel-border)',
          }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text)', marginBottom: 6 }}>
              Claude Desktop
            </div>
            <pre style={{
              margin: 0,
              fontSize: 12,
              color: 'var(--t-text-muted)',
              fontFamily: 'system-ui, sans-serif',
              whiteSpace: 'pre-wrap',
              lineHeight: 1.6,
            }}>
              {data.instructions.claudeDesktop}
            </pre>
          </div>
          <div style={{
            padding: 14,
            borderRadius: 12,
            background: 'var(--t-panel)',
            border: '1px solid var(--t-panel-border)',
          }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text)', marginBottom: 6 }}>
              Claude Code
            </div>
            <pre style={{
              margin: 0,
              fontSize: 12,
              color: 'var(--t-text-muted)',
              fontFamily: 'system-ui, sans-serif',
              whiteSpace: 'pre-wrap',
              lineHeight: 1.6,
            }}>
              {data.instructions.claudeCode}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
