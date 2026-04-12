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
  {
    name: 'Satoshi',
    family: '"Satoshi", -apple-system, system-ui, sans-serif',
    description: 'Modern grotesque with character. Used by Framer, Raycast. Sharp at small sizes, distinctive g/a/t letterforms.',
    importUrl: 'https://api.fontshare.com/v2/css?f[]=satoshi@300,400,500,700,900,300i,400i,500i,700i&display=swap',
  },
  {
    name: 'Outfit',
    family: '"Outfit", -apple-system, system-ui, sans-serif',
    description: 'Geometric sans-serif with soft terminals. Clean, modern, wide weight range. Great for UI at small sizes.',
    importUrl: 'https://fonts.googleapis.com/css2?family=Outfit:wght@100;200;300;400;500;600;700;800;900&display=swap',
  },
  {
    name: 'Manrope',
    family: '"Manrope", -apple-system, system-ui, sans-serif',
    description: 'Semi-condensed grotesque. Notion, Figma community favorite. Excellent readability at tiny sizes, distinctive curves.',
    importUrl: 'https://fonts.googleapis.com/css2?family=Manrope:wght@200;300;400;500;600;700;800&display=swap',
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

      {/* Hero — thin/light (weight 300) — actual app uses 28px */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 8, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase' as const, color: 'rgba(255, 255, 255, 0.3)', marginBottom: 6, fontFamily: 'ui-monospace, monospace' }}>
          Hero — 28px / 300
        </div>
        <div style={{ fontSize: 28, fontWeight: 300, fontFamily: font.family, color: 'rgba(255, 255, 255, 0.85)', letterSpacing: '-0.03em', lineHeight: 1.2 }}>
          {SAMPLE_HERO}
        </div>
        <div style={{ fontSize: 13, fontWeight: 500, fontFamily: font.family, color: 'rgba(255, 255, 255, 0.5)', letterSpacing: '-0.01em', marginTop: 4 }}>
          {SAMPLE_SUB}
        </div>
      </div>

      {/* Body — regular (weight 400) — actual app uses 12-13px */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 8, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase' as const, color: 'rgba(255, 255, 255, 0.3)', marginBottom: 6, fontFamily: 'ui-monospace, monospace' }}>
          Body — 12px / 400
        </div>
        <div style={{ fontSize: 12, fontWeight: 400, fontFamily: font.family, color: 'rgba(255, 255, 255, 0.75)', lineHeight: 1.6, maxWidth: 500 }}>
          {SAMPLE_BODY}
        </div>
      </div>

      {/* Medium — weight 500 — actual app uses 10.5px for metadata */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 8, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase' as const, color: 'rgba(255, 255, 255, 0.3)', marginBottom: 6, fontFamily: 'ui-monospace, monospace' }}>
          Meta — 10.5px / 500
        </div>
        <div style={{ fontSize: 10.5, fontWeight: 500, fontFamily: font.family, color: 'rgba(255, 255, 255, 0.55)', letterSpacing: '-0.005em' }}>
          {SAMPLE_META}
        </div>
      </div>

      {/* Sidebar label — weight 440-540 — actual app uses 12-13px */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 8, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase' as const, color: 'rgba(255, 255, 255, 0.3)', marginBottom: 6, fontFamily: 'ui-monospace, monospace' }}>
          Sidebar — 12px / 540
        </div>
        <div style={{ fontSize: 12, fontWeight: 540, fontFamily: font.family, color: 'rgba(255, 255, 255, 0.8)', letterSpacing: '-0.008em' }}>
          cortex-ide · Orchestrator · Active
        </div>
      </div>

      {/* Bold — weight 700 — actual app uses 12px for headers */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 8, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase' as const, color: 'rgba(255, 255, 255, 0.3)', marginBottom: 6, fontFamily: 'ui-monospace, monospace' }}>
          Header — 12px / 700
        </div>
        <div style={{ fontSize: 12, fontWeight: 700, fontFamily: font.family, color: 'rgba(255, 255, 255, 0.9)', letterSpacing: '-0.01em' }}>
          Review pending changes
        </div>
      </div>

      {/* Section label — weight 600 + uppercase — actual app uses 10-11px */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 8, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase' as const, color: 'rgba(255, 255, 255, 0.3)', marginBottom: 6, fontFamily: 'ui-monospace, monospace' }}>
          Section — 11px / 600 / Uppercase
        </div>
        <div style={{ fontSize: 11, fontWeight: 600, fontFamily: font.family, color: 'rgba(255, 255, 255, 0.5)', letterSpacing: '0.05em', textTransform: 'uppercase' as const }}>
          {SAMPLE_LABEL}
        </div>
      </div>

      {/* Italic — weight 400 — actual app uses 12px for thinking state */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 8, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase' as const, color: 'rgba(255, 255, 255, 0.3)', marginBottom: 6, fontFamily: 'ui-monospace, monospace' }}>
          Italic — 12px / 400
        </div>
        <div style={{ fontSize: 12, fontWeight: 400, fontStyle: 'italic', fontFamily: font.family, color: 'rgba(255, 255, 255, 0.6)' }}>
          Thinking through the problem...
        </div>
      </div>

      {/* Issue row — mono number + sans title — actual app sizes */}
      <div>
        <div style={{ fontSize: 8, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase' as const, color: 'rgba(255, 255, 255, 0.3)', marginBottom: 6, fontFamily: 'ui-monospace, monospace' }}>
          Issue Row — 10px mono + 12px sans
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 10, fontWeight: 700, fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace', color: 'rgba(255, 255, 255, 0.4)', width: 42 }}>
            #511
          </span>
          <span style={{ fontSize: 12, fontWeight: 400, fontFamily: font.family, color: 'rgba(255, 255, 255, 0.75)' }}>
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
