'use client';

/**
 * /text — Typography specimen page for o8.
 *
 * Shows font candidates at various weights/styles so we can pick the
 * right typeface for the whole product before rolling it out. Each
 * section renders the same sample text in a different font family so
 * you can compare side-by-side on a dark background (matching midnight
 * theme).
 */

const SAMPLE_HERO = 'Good afternoon.';
const SAMPLE_SUB = 'Command your fleet.';
const SAMPLE_BODY = 'The orchestrator dispatched 3 agents across cortex-ide and UGC. Two are running, one is awaiting review. Total cost: $0.42.';
const SAMPLE_MONO = '#511  perf: push idle RSS below 500 MB';
const SAMPLE_LABEL = 'CORTEX-IDE';
const SAMPLE_META = 'Opus 4.6 (1M) · cortex-ide · 12 issues · main';

interface FontCandidate {
  name: string;
  family: string;
  description: string;
  /** Google Fonts import URL (null = system font, no import needed) */
  importUrl: string | null;
}

const FONTS: FontCandidate[] = [
  {
    name: 'SF Pro (System Default)',
    family: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", system-ui, sans-serif',
    description: 'Current font. Apple system font — native feel, great on macOS, invisible on Windows.',
    importUrl: null,
  },
  {
    name: 'Inter',
    family: '"Inter", -apple-system, system-ui, sans-serif',
    description: 'The Vercel/Linear standard. Designed for screens, excellent at small sizes, tight letter-spacing. Open source.',
    importUrl: 'https://fonts.googleapis.com/css2?family=Inter:wght@100;200;300;400;500;600;700;800;900&display=swap',
  },
  {
    name: 'Geist Sans',
    family: '"Geist", -apple-system, system-ui, sans-serif',
    description: 'Vercel\'s custom typeface. Clean, modern, built for developer tools. Pairs with Geist Mono.',
    importUrl: 'https://fonts.googleapis.com/css2?family=Geist:wght@100;200;300;400;500;600;700;800;900&display=swap',
  },
  {
    name: 'DM Sans',
    family: '"DM Sans", -apple-system, system-ui, sans-serif',
    description: 'Geometric sans with warmth. Great thin weights, distinctive at large sizes. Google open source.',
    importUrl: 'https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,100..1000;1,9..40,100..1000&display=swap',
  },
  {
    name: 'Plus Jakarta Sans',
    family: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
    description: 'Modern geometric with personality. Popular in fintech/SaaS. Beautiful thin and bold extremes.',
    importUrl: 'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:ital,wght@0,200;0,300;0,400;0,500;0,600;0,700;0,800;1,200;1,300;1,400;1,500;1,600;1,700;1,800&display=swap',
  },
];

function FontSection({ font }: { font: FontCandidate }) {
  return (
    <div style={{
      marginBottom: 64,
      paddingBottom: 64,
      borderBottomWidth: 1,
      borderBottomStyle: 'solid',
      borderBottomColor: 'rgba(255, 255, 255, 0.06)',
    }}>
      {/* Font name + description */}
      <div style={{ marginBottom: 32 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' as const, color: '#2563eb', fontFamily: 'ui-monospace, monospace', marginBottom: 8 }}>
          {font.name}
        </div>
        <div style={{ fontSize: 13, color: 'rgba(255, 255, 255, 0.5)', fontFamily: font.family, fontWeight: 400 }}>
          {font.description}
        </div>
      </div>

      {/* Hero — thin/light (weight 300) */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase' as const, color: 'rgba(255, 255, 255, 0.3)', marginBottom: 8, fontFamily: 'ui-monospace, monospace' }}>
          Hero — Weight 300 (Light)
        </div>
        <div style={{ fontSize: 36, fontWeight: 300, fontFamily: font.family, color: 'rgba(255, 255, 255, 0.85)', letterSpacing: '-0.03em', lineHeight: 1.15 }}>
          {SAMPLE_HERO}
        </div>
        <div style={{ fontSize: 16, fontWeight: 400, fontFamily: font.family, color: 'rgba(255, 255, 255, 0.5)', letterSpacing: '-0.01em', marginTop: 4 }}>
          {SAMPLE_SUB}
        </div>
      </div>

      {/* Body — regular (weight 400) */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase' as const, color: 'rgba(255, 255, 255, 0.3)', marginBottom: 8, fontFamily: 'ui-monospace, monospace' }}>
          Body — Weight 400 (Regular)
        </div>
        <div style={{ fontSize: 14, fontWeight: 400, fontFamily: font.family, color: 'rgba(255, 255, 255, 0.75)', lineHeight: 1.6, maxWidth: 600 }}>
          {SAMPLE_BODY}
        </div>
      </div>

      {/* Medium — weight 500 */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase' as const, color: 'rgba(255, 255, 255, 0.3)', marginBottom: 8, fontFamily: 'ui-monospace, monospace' }}>
          Medium — Weight 500
        </div>
        <div style={{ fontSize: 13, fontWeight: 500, fontFamily: font.family, color: 'rgba(255, 255, 255, 0.7)', letterSpacing: '-0.005em' }}>
          {SAMPLE_META}
        </div>
      </div>

      {/* Semibold — weight 600 */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase' as const, color: 'rgba(255, 255, 255, 0.3)', marginBottom: 8, fontFamily: 'ui-monospace, monospace' }}>
          Semibold — Weight 600
        </div>
        <div style={{ fontSize: 12, fontWeight: 600, fontFamily: font.family, color: 'rgba(255, 255, 255, 0.8)', letterSpacing: '-0.008em' }}>
          cortex-ide · Orchestrator · Active
        </div>
      </div>

      {/* Bold — weight 700 */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase' as const, color: 'rgba(255, 255, 255, 0.3)', marginBottom: 8, fontFamily: 'ui-monospace, monospace' }}>
          Bold — Weight 700
        </div>
        <div style={{ fontSize: 13, fontWeight: 700, fontFamily: font.family, color: 'rgba(255, 255, 255, 0.9)', letterSpacing: '-0.01em' }}>
          Review pending changes
        </div>
      </div>

      {/* Uppercase label — weight 600 + tracked */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase' as const, color: 'rgba(255, 255, 255, 0.3)', marginBottom: 8, fontFamily: 'ui-monospace, monospace' }}>
          Section Label — Weight 600, Uppercase, Tracked
        </div>
        <div style={{ fontSize: 11, fontWeight: 600, fontFamily: font.family, color: 'rgba(255, 255, 255, 0.5)', letterSpacing: '0.05em', textTransform: 'uppercase' as const }}>
          {SAMPLE_LABEL}
        </div>
      </div>

      {/* Italic — weight 400 italic */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase' as const, color: 'rgba(255, 255, 255, 0.3)', marginBottom: 8, fontFamily: 'ui-monospace, monospace' }}>
          Italic — Weight 400
        </div>
        <div style={{ fontSize: 13, fontWeight: 400, fontStyle: 'italic', fontFamily: font.family, color: 'rgba(255, 255, 255, 0.6)' }}>
          Thinking through the problem...
        </div>
      </div>

      {/* Mono context — issue row */}
      <div>
        <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase' as const, color: 'rgba(255, 255, 255, 0.3)', marginBottom: 8, fontFamily: 'ui-monospace, monospace' }}>
          Mixed — Mono number + Sans title (issue row)
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 11, fontWeight: 700, fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace', color: 'rgba(255, 255, 255, 0.4)', width: 42 }}>
            #511
          </span>
          <span style={{ fontSize: 13, fontWeight: 400, fontFamily: font.family, color: 'rgba(255, 255, 255, 0.75)' }}>
            perf: push idle RSS below 500 MB (v1 perf pass)
          </span>
        </div>
      </div>
    </div>
  );
}

export default function TextPage() {
  return (
    <>
      {/* Google Fonts imports */}
      {FONTS.filter((f) => f.importUrl).map((f) => (
        <link key={f.name} rel="stylesheet" href={f.importUrl!} />
      ))}
      <div style={{
        minHeight: '100vh',
        background: '#0d1117',
        color: '#e6edf3',
        padding: '60px 80px',
        fontFamily: '-apple-system, system-ui, sans-serif',
      }}>
        <div style={{ maxWidth: 800 }}>
          <div style={{ marginBottom: 48 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase' as const, color: '#2563eb', fontFamily: 'ui-monospace, monospace', marginBottom: 12 }}>
              o8 Typography Specimen
            </div>
            <div style={{ fontSize: 24, fontWeight: 300, color: 'rgba(255, 255, 255, 0.7)', letterSpacing: '-0.02em' }}>
              Compare font candidates for the fleet control surface.
            </div>
            <div style={{ fontSize: 13, color: 'rgba(255, 255, 255, 0.35)', marginTop: 8 }}>
              Each section shows the same text at different weights and styles. Pick the one that feels right for a professional engineering tool.
            </div>
          </div>

          {FONTS.map((font) => (
            <FontSection key={font.name} font={font} />
          ))}
        </div>
      </div>
    </>
  );
}
