'use client';

import { useRouter } from 'next/navigation';

export default function DashboardPage() {
  const router = useRouter();

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #0a0a0a 0%, #111827 50%, #0a0a0a 100%)',
      color: '#f2f2f7',
      fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", system-ui, sans-serif',
    }}>
      {/* Top nav bar */}
      <nav style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '16px 24px',
        borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        background: 'rgba(10, 10, 10, 0.8)',
        position: 'sticky',
        top: 0,
        zIndex: 100,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{
            fontSize: 20,
            fontWeight: 700,
            letterSpacing: '-0.03em',
            background: 'linear-gradient(135deg, #60a5fa, #a78bfa)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
          }}>
            Cortex IDE
          </span>
          <span style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.05em',
            textTransform: 'uppercase' as const,
            padding: '2px 8px',
            borderRadius: 6,
            background: 'rgba(96, 165, 250, 0.15)',
            color: '#60a5fa',
          }}>
            v1
          </span>
        </div>

        <button
          onClick={() => router.push('/')}
          style={{
            padding: '8px 16px',
            borderRadius: 8,
            border: '1px solid rgba(255, 255, 255, 0.1)',
            background: 'rgba(255, 255, 255, 0.05)',
            color: '#8e8e93',
            fontSize: 13,
            fontWeight: 500,
            cursor: 'pointer',
            transition: 'all 0.2s ease',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)';
            e.currentTarget.style.color = '#f2f2f7';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)';
            e.currentTarget.style.color = '#8e8e93';
          }}
        >
          ← Legacy View
        </button>
      </nav>

      {/* Empty canvas */}
      <main style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 'calc(100vh - 65px)',
        padding: 24,
      }}>
        <div style={{ textAlign: 'center', maxWidth: 480 }}>
          <div style={{
            fontSize: 48,
            marginBottom: 16,
            opacity: 0.3,
          }}>
            ◇
          </div>
          <h1 style={{
            fontSize: 28,
            fontWeight: 700,
            letterSpacing: '-0.03em',
            marginBottom: 8,
            color: '#f2f2f7',
          }}>
            Dashboard v1
          </h1>
          <p style={{
            fontSize: 15,
            color: '#5b6475',
            lineHeight: 1.5,
            letterSpacing: '-0.01em',
          }}>
            The new home. We build from here.
          </p>
        </div>
      </main>
    </div>
  );
}
