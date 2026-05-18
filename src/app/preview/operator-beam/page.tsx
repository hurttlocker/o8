'use client';

import { OperatorBeamActivity } from '@/components/desktop/orchestrator/operator-beam/OperatorBeamActivity';

const FONT_FAMILY = 'var(--font-sans-system)';

function ChatBubble({
  role,
  children,
}: {
  role: 'user' | 'assistant';
  children: React.ReactNode;
}) {
  const isUser = role === 'user';
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        width: '100%',
      }}
    >
      <div
        style={{
          maxWidth: isUser ? 680 : 920,
          width: isUser ? 'auto' : '100%',
          borderRadius: isUser ? 18 : 22,
          border: isUser ? '1px solid rgba(37, 99, 235, 0.14)' : '1px solid rgba(148, 163, 184, 0.14)',
          background: isUser ? 'rgba(37, 99, 235, 0.08)' : 'rgba(255, 255, 255, 0.72)',
          boxShadow: isUser ? 'none' : '0 18px 54px rgba(15, 23, 42, 0.07)',
          padding: isUser ? '13px 16px' : 14,
          color: '#172033',
          fontSize: 13.5,
          lineHeight: 1.5,
          fontWeight: 480,
        }}
      >
        {children}
      </div>
    </div>
  );
}

export default function OperatorBeamPreviewPage() {
  return (
    <main
      style={{
        minHeight: '100vh',
        background: 'linear-gradient(180deg, #f8fafc 0%, #eef4fb 52%, #f8fafc 100%)',
        color: '#172033',
        fontFamily: FONT_FAMILY,
        padding: 24,
      }}
    >
      <div style={{ maxWidth: 1120, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
        <header
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: 18,
            padding: '8px 2px 2px',
          }}
        >
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 650, color: '#64748b', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              Preview / chat-native orchestration
            </div>
            <h1 style={{ margin: '6px 0 0', fontSize: 25, lineHeight: 1.08, letterSpacing: 0, color: '#111827', fontWeight: 720 }}>
              Animated beam update inside the transcript
            </h1>
          </div>
          <div
            style={{
              borderRadius: 999,
              border: '1px solid rgba(37, 99, 235, 0.16)',
              background: 'rgba(255,255,255,0.72)',
              padding: '7px 11px',
              color: '#526179',
              fontSize: 11,
              fontWeight: 560,
              boxShadow: '0 10px 26px rgba(15,23,42,0.06)',
              whiteSpace: 'nowrap',
            }}
          >
            Route: /preview/operator-beam
          </div>
        </header>

        <section
          style={{
            borderRadius: 26,
            border: '1px solid rgba(148, 163, 184, 0.16)',
            background: 'rgba(255,255,255,0.58)',
            boxShadow: '0 28px 90px rgba(15,23,42,0.08)',
            padding: 18,
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
          }}
        >
          <ChatBubble role="user">
            Orchestrate the slash command cleanup, keep it chat-native, and show me what is happening while the agents work.
          </ChatBubble>

          <ChatBubble role="assistant">
            <div style={{ marginBottom: 12, fontWeight: 520 }}>
              I split this into a planner lane, one worker lane, and a verifier lane. I’ll keep the updates inline here instead of moving you into a board.
            </div>
            <OperatorBeamActivity />
          </ChatBubble>

          <ChatBubble role="assistant">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#526179', fontSize: 12, fontWeight: 500 }}>
              <span
                aria-hidden="true"
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  background: '#16a34a',
                  boxShadow: '0 0 0 4px rgba(22,163,74,0.1)',
                }}
              />
              Next update lands here with diff, verification, or approval state.
            </div>
          </ChatBubble>
        </section>

        <section
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
            gap: 12,
          }}
        >
          {[
            ['No kanban', 'This is a transcript insert, not a separate planning board.'],
            ['Real later', 'V1 preview is mocked; production should read mission packets and lane events.'],
            ['Reusable pieces', 'Beam nodes, edges, and event rows live under operator-beam.'],
          ].map(([title, body]) => (
            <div
              key={title}
              style={{
                borderRadius: 18,
                border: '1px solid rgba(148, 163, 184, 0.14)',
                background: 'rgba(255,255,255,0.62)',
                padding: 14,
                boxShadow: '0 12px 34px rgba(15,23,42,0.05)',
              }}
            >
              <div style={{ fontSize: 11.5, fontWeight: 650, color: '#172033' }}>{title}</div>
              <div style={{ marginTop: 5, fontSize: 11, lineHeight: 1.4, color: '#7c8aa0', fontWeight: 440 }}>{body}</div>
            </div>
          ))}
        </section>
      </div>
    </main>
  );
}
