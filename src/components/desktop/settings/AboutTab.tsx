'use client';

import packageJson from '../../../../package.json';
import { toast } from '@/components/shared/ConfirmToastHost';
import {
  APP_FONT_STACK,
  GitHubIcon,
  InfoIcon,
  TabHeading,
  normalizeVersion,
  SETTINGS_CONTENT_MAX_WIDTH,
} from './shared';
import { SettingsGroup, SettingsRow } from './grouped';
import { ReportIssueSection } from './ReportIssueSection';

// ── Minimal raw-SVG glyphs for row icon tiles ──

function LaptopIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <rect x="4" y="4" width="16" height="12" rx="2" />
      <line x1="2" y1="20" x2="22" y2="20" />
    </svg>
  );
}

function CodeIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}

function BookIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}

function TagIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
      <line x1="7" y1="7" x2="7.01" y2="7" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <polygon points="6 3 20 12 6 21 6 3" />
    </svg>
  );
}

function RotateIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

export function AboutTab() {
  const isProduction = process.env.NODE_ENV === 'production';
  const platform = (() => {
    if (typeof navigator !== 'undefined' && navigator.platform) return navigator.platform;
    return '—';
  })();

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
        title="about"
        subtitle="A precision instrument for autonomous engineering teams. Built with Next.js and Tauri."
      />

      <section>
        <SettingsGroup header="Version">
          <SettingsRow icon={<InfoIcon />} label="Version" value={normalizeVersion(packageJson.version)} divider />
          <SettingsRow icon={<LaptopIcon />} label="Platform" value={platform} divider />
          <SettingsRow icon={<CodeIcon />} label="Mode" value={isProduction ? 'Production' : 'Development'} />
        </SettingsGroup>
      </section>

      <section style={{ marginTop: 28 }}>
        <SettingsGroup header="Links">
          <SettingsRow
            icon={<GitHubIcon size={16} />}
            label="GitHub"
            subtitle="hurttlocker/o8"
            onPress={() => window.open('https://github.com/hurttlocker/o8', '_blank', 'noopener,noreferrer')}
            chevron
            divider
          />
          <SettingsRow
            icon={<BookIcon />}
            label="Documentation"
            subtitle="Architecture, workflows, and guides"
            onPress={() => window.open('https://github.com/hurttlocker/o8/tree/main/docs', '_blank', 'noopener,noreferrer')}
            chevron
            divider
          />
          <SettingsRow
            icon={<TagIcon />}
            label="Releases"
            subtitle="Changelog and downloads"
            onPress={() => window.open('https://github.com/hurttlocker/o8/releases/latest', '_blank', 'noopener,noreferrer')}
            chevron
          />
        </SettingsGroup>
      </section>

      <section style={{ marginTop: 28 }}>
        <SettingsGroup
          header="Onboarding"
          footnote="Replays the welcome flow — the o8 intro, repos, and runtimes. Handy to revisit, or to walk a teammate through it."
        >
          <SettingsRow
            icon={<PlayIcon />}
            label="Replay onboarding"
            onPress={() => { window.dispatchEvent(new CustomEvent('o8-trigger-onboarding')); }}
            chevron
          />
        </SettingsGroup>
      </section>

      <ReportIssueSection />

      <section style={{ marginTop: 28 }}>
        <SettingsGroup header="Credits">
          <div style={{
            paddingTop: 14,
            paddingBottom: 14,
            paddingLeft: 14,
            paddingRight: 14,
            fontSize: 13,
            color: 'var(--t-text-secondary)',
            lineHeight: 1.6,
            maxWidth: 620,
          }}>
            o8 is built on Next.js 16, Tauri v2, and the runtime adapter system. It ships with the Codex, Claude Code, and Gemini adapters and the operator MCP server that lets Claude drive the webview. Design language is Dieter Rams × Swiss-Korean editorial — less, but better.
          </div>
        </SettingsGroup>
      </section>

      {/* Developer tools (dev only) */}
      {!isProduction ? (
        <section style={{ marginTop: 28 }}>
          <SettingsGroup header="Developer">
            <SettingsRow
              icon={<RotateIcon />}
              label="Reset + run onboarding"
              subtitle="Clears setup state and restarts the flow"
              onPress={async () => {
                await fetch('/api/setup/config', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ setupComplete: false, completedAt: null }),
                });
                window.location.href = '/dashboard';
              }}
              chevron
              divider
            />
            <SettingsRow
              icon={<EyeIcon />}
              label="Preview onboarding"
              subtitle="Runs the flow without resetting state"
              onPress={() => { window.dispatchEvent(new CustomEvent('o8-trigger-onboarding')); }}
              chevron
              divider
            />
            <SettingsRow
              icon={<TerminalIcon />}
              label="View detection"
              subtitle="Logs the setup/detect result to the console"
              onPress={async () => {
                const res = await fetch('/api/setup/detect');
                const data = await res.json();
                console.log('[setup/detect]', data);
                toast('Detection result logged to the console.', 'info');
              }}
              chevron
            />
          </SettingsGroup>
        </section>
      ) : null}
    </div>
  );
}
