'use client';

/**
 * Agent Beta tab — the voice agent's advanced capabilities + safety (Symon's
 * Agent page). Surfaces o8's advanced-context prefs (workspace_context_enabled,
 * agent_can_warp_cursor), the allowed-actions reference, and a safety banner.
 * All toggles persist via voice_prefs_set.
 */
import {
  ICONS, TEXT_SECONDARY, GLASS_BORDER_SUBTLE, WARN_AMBER,
  INK_ON_GLASS_1, INK_ON_GLASS_3,
} from '../tokens';
import { SectionCard, SectionTitle, SectionHint, ToggleRow, Icon, PageHeader, ProPill } from '../primitives';
import { prefBool, type TabProps } from '../helpers';

const ALLOWED = [
  'Read recently-touched repo names + branches (never file contents)',
  'Warp the cursor to point at on-screen targets',
  'Read the screen on request (Ask · what it sees)',
];
const NEVER = [
  'Synthesize clicks or keystrokes on its own',
  'Send your dictation anywhere except the polish service',
  'Run shell commands from the voice surface',
];

export default function AgentTab({ prefs, setPref }: TabProps) {
  const workspaceCtx = prefBool(prefs, 'workspace_context_enabled', false);
  const warpCursor = prefBool(prefs, 'agent_can_warp_cursor', false);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <PageHeader icon={ICONS.robot} title="Agent" right={<ProPill />} />

      <SectionCard>
        <SectionTitle icon={ICONS.robot}>Advanced context</SectionTitle>
        <SectionHint>Extra context the voice agent can use when answering. Off by default — turn on only what you want it to see.</SectionHint>
        <ToggleRow
          label="Let o8 see your recent repos"
          detail="When Ask sees the screen, it also gets a short list of git repos you've recently touched — names and branch only, never file contents."
          checked={workspaceCtx} onChange={(v) => setPref('workspace_context_enabled', v)}
        />
        <ToggleRow
          label="Allow cursor warp when answering"
          detail="When the answer points at something on screen, o8 can move the cursor there as a teaching aid. The click is never synthesized — only the cursor position."
          checked={warpCursor} onChange={(v) => setPref('agent_can_warp_cursor', v)}
        />
      </SectionCard>

      <SectionCard>
        <SectionTitle icon={ICONS.eye}>What it can do</SectionTitle>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {ALLOWED.map((a, i) => (
            <div key={a} style={{ display: 'flex', gap: 9, alignItems: 'flex-start', paddingTop: 9, paddingBottom: 9, borderTop: i === 0 ? 'none' : `1px solid ${GLASS_BORDER_SUBTLE}` }}>
              <span style={{ color: '#34D399', display: 'flex', marginTop: 1, flexShrink: 0 }}><Icon icon={ICONS.eye} size={13} /></span>
              <span style={{ fontSize: 12.5, color: TEXT_SECONDARY, lineHeight: 1.45 }}>{a}</span>
            </div>
          ))}
        </div>
      </SectionCard>

      <div style={{
        display: 'flex', gap: 12, alignItems: 'flex-start', padding: '14px 16px',
        borderRadius: 14, border: `1px solid rgba(245,158,11,0.24)`, background: 'linear-gradient(180deg, rgba(245,158,11,0.10), rgba(255,255,255,0.02))',
      }}>
        <span style={{ color: WARN_AMBER, display: 'flex', marginTop: 1, flexShrink: 0 }}><Icon icon={ICONS.warning} size={16} /></span>
        <div>
          <div style={{ fontSize: 12.5, fontWeight: 500, color: INK_ON_GLASS_1, textShadow: '0 1px 3px rgba(0,0,0,0.28)', marginBottom: 6 }}>Safety — what it never does</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {NEVER.map((n) => <span key={n} style={{ fontSize: 12, color: INK_ON_GLASS_3, textShadow: '0 1px 2px rgba(0,0,0,0.22)', lineHeight: 1.45 }}>· {n}</span>)}
          </div>
        </div>
      </div>
    </div>
  );
}
