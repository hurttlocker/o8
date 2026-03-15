'use client';

import { useRouter } from 'next/navigation';
import { DesktopChat } from '@/components/desktop/DesktopChat';

export default function DashboardPage() {
  const router = useRouter();

  return (
    <div style={{
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      background: 'linear-gradient(135deg, #0a0a0a 0%, #111827 50%, #0a0a0a 100%)',
      color: '#f2f2f7',
      fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", system-ui, sans-serif',
      overflow: 'hidden',
    }}>
      {/* Top nav bar */}
      <nav style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 20px',
        borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        background: 'rgba(10, 10, 10, 0.8)',
        flexShrink: 0,
        zIndex: 100,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{
            fontSize: 18,
            fontWeight: 700,
            letterSpacing: '-0.03em',
            background: 'linear-gradient(135deg, #60a5fa, #a78bfa)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
          }}>
            Cortex IDE
          </span>
          <span style={{
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: '0.05em',
            textTransform: 'uppercase' as const,
            padding: '2px 7px',
            borderRadius: 5,
            background: 'rgba(96, 165, 250, 0.15)',
            color: '#60a5fa',
          }}>
            v1
          </span>
        </div>

        <button
          onClick={() => router.push('/')}
          style={{
            padding: '6px 14px',
            borderRadius: 7,
            border: '1px solid rgba(255, 255, 255, 0.1)',
            background: 'rgba(255, 255, 255, 0.05)',
            color: '#8e8e93',
            fontSize: 12,
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

      {/* Main content area */}
      <div style={{
        flex: 1,
        display: 'flex',
        overflow: 'hidden',
      }}>
        {/* Left panel — future workspace area */}
        <div style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
        }}>
          <div style={{ textAlign: 'center', maxWidth: 480 }}>
            <div style={{
              fontSize: 48,
              marginBottom: 16,
              opacity: 0.15,
            }}>
              ◇
            </div>
            <h1 style={{
              fontSize: 24,
              fontWeight: 700,
              letterSpacing: '-0.03em',
              marginBottom: 8,
              color: '#f2f2f7',
            }}>
              Workspace
            </h1>
            <p style={{
              fontSize: 14,
              color: '#5b6475',
              lineHeight: 1.5,
              letterSpacing: '-0.01em',
            }}>
              Agent activity, diffs, and project context will live here.
            </p>
          </div>
        </div>

        {/* Right panel — Chat sidebar */}
        <div style={{
          width: 420,
          flexShrink: 0,
          height: '100%',
        }}>
          <DesktopChat />
        </div>
      </div>
    </div>
  );
}
