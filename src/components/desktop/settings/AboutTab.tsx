'use client';

import packageJson from '../../../../package.json';
import {
  APP_FONT_STACK,
  MONO_FONT_STACK,
  RAMS_ACCENT,
  RAMS_HAIRLINE_SOFT,
  RAMS_INK_QUIET,
  HairlineRule,
  SectionLabel,
  TabBreadcrumb,
  TabHeading,
  normalizeVersion,
} from './shared';

export function AboutTab() {
  const isProduction = process.env.NODE_ENV === 'production';
  const platform = (() => {
    if (typeof navigator !== 'undefined' && navigator.platform) return navigator.platform;
    return '—';
  })();

  const nowIso = (() => {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  })();

  return (
    <div style={{
      paddingTop: 8,
      paddingLeft: 8,
      paddingRight: 32,
      paddingBottom: 40,
      maxWidth: 780,
      fontFamily: APP_FONT_STACK,
    }}>
      <TabBreadcrumb tab="about" />
      <TabHeading
        title="about"
        subtitle="A precision instrument for autonomous engineering teams. Built with Next.js and Tauri."
      />

      {/* 01 — VERSION */}
      <section style={{ marginBottom: 32 }}>
        <SectionLabel number="01">VERSION</SectionLabel>

        <div style={{
          paddingTop: 4,
          paddingBottom: 20,
          borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
        }}>
          <div style={{
            fontFamily: MONO_FONT_STACK,
            fontSize: 10,
            fontWeight: 400,
            letterSpacing: '0.22em',
            textTransform: 'uppercase',
            color: RAMS_INK_QUIET,
            marginBottom: 10,
          }}>
            (version)
          </div>
          <div style={{
            fontFamily: MONO_FONT_STACK,
            fontSize: 32,
            fontWeight: 500,
            color: 'var(--t-text)',
            letterSpacing: '0.02em',
            lineHeight: 1,
          }}>
            {normalizeVersion(packageJson.version)}
          </div>
          <div style={{
            marginTop: 10,
            fontFamily: MONO_FONT_STACK,
            fontSize: 10,
            fontWeight: 400,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            color: RAMS_INK_QUIET,
          }}>
            UPDATED {nowIso}
          </div>
          <div style={{
            marginTop: 16,
            display: 'flex',
            gap: 28,
            flexWrap: 'wrap',
          }}>
            <InfoField label="PLATFORM" value={platform} />
            <InfoField label="MODE" value={isProduction ? 'production' : 'development'} />
          </div>
        </div>
      </section>

      {/* 02 — LINKS */}
      <section style={{ marginBottom: 32 }}>
        <SectionLabel number="02">LINKS</SectionLabel>
        <div style={{
          paddingTop: 4,
          paddingBottom: 20,
          borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}>
          {[
            { label: 'github', href: 'https://github.com/hurttlocker/cortex-ide' },
            { label: 'docs', href: 'https://github.com/hurttlocker/cortex-ide/tree/main/docs' },
            { label: 'releases', href: 'https://github.com/hurttlocker/cortex-ide/releases/latest' },
          ].map((link) => (
            <a
              key={link.label}
              href={link.href}
              target="_blank"
              rel="noreferrer"
              style={{
                fontFamily: APP_FONT_STACK,
                fontSize: 14,
                fontWeight: 400,
                color: RAMS_ACCENT,
                textDecoration: 'underline',
                textUnderlineOffset: 3,
                textDecorationColor: RAMS_HAIRLINE_SOFT,
                letterSpacing: '-0.01em',
                width: 'fit-content',
              }}
            >
              {link.label} ›
            </a>
          ))}
        </div>
      </section>

      {/* 03 — CREDITS */}
      <section style={{ marginBottom: isProduction ? 0 : 32 }}>
        <SectionLabel number="03">CREDITS</SectionLabel>
        <div style={{
          paddingTop: 4,
          paddingBottom: 20,
          borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
          fontSize: 13,
          color: 'var(--t-text-secondary)',
          lineHeight: 1.6,
          maxWidth: 620,
        }}>
          o8 is built on Next.js 16, Tauri v2, and the runtime adapter system. It ships with the Codex and Claude Code adapters and the operator MCP server that lets Claude drive the webview. Design language is Dieter Rams × Swiss-Korean editorial — less, but better.
        </div>
      </section>

      {/* Developer tools (dev only) */}
      {!isProduction ? (
        <section>
          <SectionLabel number="04">DEVELOPER</SectionLabel>
          <div style={{
            paddingTop: 4,
            paddingBottom: 4,
            display: 'flex',
            gap: 24,
            flexWrap: 'wrap',
          }}>
            <button
              type="button"
              onClick={async () => {
                await fetch('/api/setup/config', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ setupComplete: false, completedAt: null }),
                });
                window.location.href = '/dashboard';
              }}
              style={accentLinkStyle(false)}
            >
              reset + run onboarding
            </button>
            <button
              type="button"
              onClick={() => {
                window.dispatchEvent(new CustomEvent('o8-trigger-onboarding'));
              }}
              style={accentLinkStyle(false)}
            >
              preview onboarding
            </button>
            <button
              type="button"
              onClick={async () => {
                const res = await fetch('/api/setup/detect');
                const data = await res.json();
                alert(JSON.stringify(data, null, 2));
              }}
              style={quietLinkStyle(false)}
            >
              view detection
            </button>
          </div>
          <div style={{ marginTop: 20 }}>
            <HairlineRule />
          </div>
        </section>
      ) : null}

      {/* Footer timestamp */}
      <div style={{
        marginTop: 32,
        fontFamily: MONO_FONT_STACK,
        fontSize: 11,
        fontWeight: 400,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        color: RAMS_INK_QUIET,
      }}>
        {nowIso} · viewed
      </div>
    </div>
  );
}

function InfoField({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{
        fontFamily: MONO_FONT_STACK,
        fontSize: 10,
        fontWeight: 400,
        letterSpacing: '0.18em',
        textTransform: 'uppercase',
        color: RAMS_INK_QUIET,
      }}>
        {label}
      </span>
      <span style={{
        fontSize: 13,
        fontWeight: 400,
        color: 'var(--t-text)',
        letterSpacing: '-0.005em',
      }}>
        {value}
      </span>
    </div>
  );
}

function accentLinkStyle(disabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    height: 30,
    paddingLeft: 12,
    paddingRight: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: disabled ? RAMS_HAIRLINE_SOFT : 'rgba(255, 90, 31, 0.32)',
    background: disabled ? 'transparent' : 'rgba(255, 90, 31, 0.1)',
    color: disabled ? RAMS_INK_QUIET : RAMS_ACCENT,
    fontFamily: MONO_FONT_STACK,
    fontSize: 11.5,
    fontWeight: 500,
    letterSpacing: '0.04em',
    textTransform: 'uppercase' as const,
    cursor: disabled ? 'default' : 'pointer',
    transition: 'background 150ms ease, border-color 150ms ease',
    opacity: disabled ? 0.6 : 1,
  };
}

function quietLinkStyle(disabled: boolean): React.CSSProperties {
  return {
    fontFamily: APP_FONT_STACK,
    fontSize: 13,
    fontWeight: 400,
    color: 'var(--t-text-muted)',
    background: 'transparent',
    border: 'none',
    borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
    paddingTop: 2,
    paddingBottom: 2,
    paddingLeft: 0,
    paddingRight: 0,
    cursor: disabled ? 'default' : 'pointer',
    letterSpacing: '-0.005em',
    opacity: disabled ? 0.6 : 1,
  };
}
