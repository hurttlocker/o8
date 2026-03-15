'use client';

import Link from 'next/link';
import { DesktopChat } from '@/components/desktop/DesktopChat';

export default function DashboardPage() {
  return (
    <div style={{
      height: '100vh',
      display: 'flex',
      background: 'linear-gradient(135deg, #0a0a0a 0%, #111827 50%, #0a0a0a 100%)',
      color: '#f2f2f7',
      fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", system-ui, sans-serif',
      overflow: 'hidden',
    }}>
      {/* Left panel — future workspace area */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        position: 'relative',
      }}>
        {/* Legacy view link — tucked in corner */}
        <Link
          href="/"
          style={{
            position: 'absolute',
            top: 16,
            left: 20,
            fontSize: 12,
            color: '#5b6475',
            textDecoration: 'none',
            padding: '4px 10px',
            borderRadius: 6,
            border: '1px solid rgba(255,255,255,0.06)',
            transition: 'all 0.2s ease',
          }}
        >
          ← Legacy View
        </Link>

        <div style={{ textAlign: 'center', maxWidth: 480 }}>
          <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.15 }}>◇</div>
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

      {/* Right panel — Chat sidebar (full height, no app-level header) */}
      <div style={{
        width: 420,
        flexShrink: 0,
        height: '100vh',
      }}>
        <DesktopChat />
      </div>
    </div>
  );
}
