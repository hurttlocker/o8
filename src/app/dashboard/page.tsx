'use client';

import { AgentPanel } from '@/components/desktop/AgentPanel';
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
      {/* Left panel — Agent Command Center */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}>
        <AgentPanel />
      </div>

      {/* Right panel — Chat sidebar */}
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
