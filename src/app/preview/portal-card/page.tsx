'use client';

import { type CSSProperties } from 'react';
import { PortalCard } from './PortalCard';

const FONT = 'var(--font-sans-system)';

const cta = (dark: boolean): CSSProperties => ({
  width: '100%',
  paddingTop: 12,
  paddingBottom: 12,
  borderRadius: 12,
  border: dark ? '1px solid rgba(255,255,255,0.16)' : '1px solid rgba(20,32,46,0.12)',
  background: dark ? '#f2f5f8' : '#1b2430',
  color: dark ? '#16202c' : '#fff',
  fontSize: 14,
  fontWeight: 560,
  letterSpacing: '-0.2px',
  cursor: 'pointer',
});

function Check({ dark }: { dark: boolean }) {
  return (
    <span
      style={{
        width: 16,
        height: 16,
        borderRadius: 999,
        background: dark ? 'rgba(255,255,255,0.12)' : 'rgba(20,32,46,0.08)',
        color: dark ? '#cfe6ff' : '#2c6df0',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 10,
        flexShrink: 0,
      }}
    >
      ✓
    </span>
  );
}

export default function PortalCardPreviewPage() {
  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--t-bg, #f1f3f5)',
        color: 'var(--t-text, #111827)',
        fontFamily: FONT,
        paddingTop: 40,
        paddingBottom: 90,
        paddingLeft: 40,
        paddingRight: 40,
      }}
    >
      <header style={{ maxWidth: 1180, margin: '0 auto', marginBottom: 30 }}>
        <h1 style={{ fontSize: 22, fontWeight: 440, letterSpacing: '-0.4px', margin: 0 }}>Portal card lab</h1>
        <p style={{ fontSize: 13, color: 'var(--t-text-muted, #6b7280)', marginTop: 6, lineHeight: 1.5, maxWidth: 720 }}>
          The o8 motif — a clean glass card with the animated landscape inside a framed <strong>portal/window</strong>,
          light spilling out. Not a photo background. Light &amp; dark, as pricing / feature / modal.
        </p>
      </header>

      <div
        style={{
          maxWidth: 1180,
          margin: '0 auto',
          display: 'flex',
          gap: 36,
          flexWrap: 'wrap',
          alignItems: 'flex-start',
          justifyContent: 'center',
        }}
      >
        {/* LIGHT pricing card */}
        <PortalCard variant="light" width={360} height={520} portalHeight={196}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <div style={{ fontSize: 11.5, fontWeight: 560, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#5d6a78' }}>Founding Operator</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 7 }}>
                <span style={{ fontSize: 42, fontWeight: 600, letterSpacing: '-1.4px' }}>$150</span>
                <span style={{ fontSize: 13.5, color: '#5d6a78' }}>/ once</span>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9, fontSize: 13.5 }}>
              {['Full governed fleet — no extra sub', 'Build-in-public roadmap priority', 'Founding status & voice', 'Lifetime — never a locked door'].map((f) => (
                <div key={f} style={{ display: 'flex', gap: 9, alignItems: 'center', color: '#3a4654' }}>
                  <Check dark={false} />
                  {f}
                </div>
              ))}
            </div>
            <button type="button" style={cta(false)}>Become a Founding Operator</button>
          </div>
        </PortalCard>

        {/* DARK feature / hero card */}
        <PortalCard variant="dark" width={360} height={520} portalHeight={210}>
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div style={{ fontSize: 11.5, fontWeight: 560, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#9aa6b3' }}>Workspace, opened</div>
            <div style={{ fontSize: 27, fontWeight: 580, letterSpacing: '-0.7px', marginTop: 6, lineHeight: 1.1 }}>Open the next move.</div>
            <div style={{ fontSize: 13.5, color: '#9aa6b3', marginTop: 8, lineHeight: 1.55 }}>
              A system-wide IDE that plans, codes, and operates — your fleet, governed.
            </div>
            <div style={{ flex: 1 }} />
            <button type="button" style={cta(true)}>Step through</button>
          </div>
        </PortalCard>

        {/* LIGHT modal mock */}
        <div style={{ position: 'relative', width: 360, height: 520, borderRadius: 22, overflow: 'hidden', background: '#e9edf1', boxShadow: '0 20px 50px -22px rgba(20,30,45,0.4)' }}>
          <div style={{ position: 'absolute', inset: 0, background: 'repeating-linear-gradient(180deg, rgba(20,30,45,0.04) 0 14px, transparent 14px 28px)' }} />
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(225,232,238,0.6)' }} />
          <div style={{ position: 'absolute', left: 28, right: 28, top: 86 }}>
            <PortalCard variant="light" width={304} height={348} portalHeight={158}>
              <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                <div style={{ fontSize: 19, fontWeight: 600, letterSpacing: '-0.5px' }}>A portal to clarity</div>
                <div style={{ fontSize: 13, color: '#5d6a78', marginTop: 6, lineHeight: 1.5 }}>
                  Open the workspace and the whole system comes into view.
                </div>
                <div style={{ flex: 1 }} />
                <div style={{ display: 'flex', gap: 10 }}>
                  <button type="button" style={{ flex: 1, paddingTop: 10, paddingBottom: 10, borderRadius: 11, border: '1px solid rgba(20,32,46,0.14)', background: 'transparent', color: '#3a4654', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>Later</button>
                  <button type="button" style={{ flex: 1, paddingTop: 10, paddingBottom: 10, borderRadius: 11, border: 'none', background: '#1b2430', color: '#fff', fontSize: 13, fontWeight: 560, cursor: 'pointer' }}>Get started</button>
                </div>
              </div>
            </PortalCard>
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 1180, margin: '0 auto', marginTop: 18, fontSize: 11, color: 'var(--t-text-muted, #6b7280)', textAlign: 'center' }}>
        light pricing card · dark feature card · light modal — landscape lives in the portal, not the background
      </div>
    </div>
  );
}
