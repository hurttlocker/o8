'use client';

export function SideChatIntro() {
  return <div role="note" aria-label="About side chat" style={{ flexShrink: 0, paddingTop: 12, paddingRight: 14, paddingBottom: 12, paddingLeft: 14, borderBottom: '1px solid var(--t-divider-subtle)' }}>
    <div style={{ fontSize: 12, fontWeight: 400, color: 'var(--t-text)' }}>Side chat</div>
    <div style={{ marginTop: 4, fontSize: 11, lineHeight: 1.45, color: 'var(--t-text-muted)' }}>A separate conversation with its own messages. Your main conversation stays in place.</div>
  </div>;
}
