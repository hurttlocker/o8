'use client';

import { useState, type CSSProperties } from 'react';

const FONT_INTER = 'var(--font-sans-system)';
const LS = '-0.31px';

const BG_PRIMARY = '#FFFFFF';
const BG_CHROME = '#FCFCFC';

const N = {
  100: '#f5f5f5',
  200: '#e5e5e5',
  300: '#d4d4d4',
  400: '#a3a3a3',
  500: '#737373',
  700: '#404040',
  800: '#262626',
  900: '#171717',
} as const;

const STATUS = {
  resolved: { color: '#22c55e', label: 'Resolved' },
  firstCall: { color: '#3b82f6', label: '1st Call' },
  needsReply: { color: '#ec4899', label: 'Needs Reply' },
  pending: { color: '#f97316', label: 'Pending' },
  open: { color: N[400], label: 'Open' },
} as const;

type StatusKey = keyof typeof STATUS;

const CHANNEL = {
  email: { color: '#3b82f6', label: 'Email' },
  phone: { color: '#ef4444', label: 'Phone' },
  telegram: { color: '#0ea5e9', label: 'Telegram' },
  facebook: { color: '#1877f2', label: 'Facebook' },
  slack: { color: '#611f69', label: 'Slack' },
} as const;

type Stroke = { d: string };

function HugeIcon({ size = 18, strokeWidth = 1.5, color = N[700], paths }: { size?: number; strokeWidth?: number; color?: string; paths: Stroke[] }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      {paths.map((p, i) => (
        <path key={i} d={p.d} />
      ))}
    </svg>
  );
}

const ICON = {
  newMessage: [{ d: 'M20 13.5v5a2.5 2.5 0 0 1-2.5 2.5H5.5A2.5 2.5 0 0 1 3 18.5V6.5A2.5 2.5 0 0 1 5.5 4h5' }, { d: 'M17 3l4 4-9.5 9.5H7.5V12.5L17 3z' }],
  inbox: [{ d: 'M3 7l2-3h14l2 3v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z' }, { d: 'M3 10h5l1.5 2h5l1.5-2H21' }],
  user: [{ d: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z' }, { d: 'M4 21a8 8 0 0 1 16 0' }],
  sparkle: [{ d: 'M12 3l1.8 5.4L19 10l-5.2 1.6L12 17l-1.8-5.4L5 10l5.2-1.6L12 3z' }],
  branch: [{ d: 'M6 4v16' }, { d: 'M18 4v6a4 4 0 0 1-4 4H6' }, { d: 'M6 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4z' }, { d: 'M18 14a2 2 0 1 0 0 4 2 2 0 0 0 0-4z' }],
  files: [{ d: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6z' }, { d: 'M14 3v6h6' }],
  calendar: [{ d: 'M5 6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6z' }, { d: 'M5 10h14' }, { d: 'M9 3v4' }, { d: 'M15 3v4' }],
  contact: [{ d: 'M5 5h14v14H5z' }, { d: 'M12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z' }, { d: 'M8 17a4 4 0 0 1 8 0' }],
  building: [{ d: 'M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16' }, { d: 'M9 8h1M9 12h1M9 16h1M14 8h1M14 12h1M14 16h1' }, { d: 'M3 21h18' }],
  message: [{ d: 'M21 12a8 8 0 1 1-3.5-6.6L21 5l-1 3.5A7.9 7.9 0 0 1 21 12z' }],
  analytics: [{ d: 'M4 19V5' }, { d: 'M4 19h16' }, { d: 'M8 15v-3M12 15V9M16 15v-6' }],
  apple: [{ d: 'M16 3c.2 1.3-.4 2.6-1.2 3.5-.9 1-2.4 1.7-3.6 1.6-.2-1.3.4-2.6 1.2-3.5.9-1 2.4-1.7 3.6-1.6z' }, { d: 'M19.5 17.2c-.6 1.2-.9 1.8-1.6 2.9-1 1.5-2.5 3.4-4.3 3.4-1.6 0-2-1-4.2-1-2.2 0-2.7 1-4.3 1-1.8 0-3.2-1.7-4.2-3.2-2.9-4.2-3.2-9.2-1.4-11.9 1.3-1.9 3.3-3 5.2-3 1.9 0 3.1 1 4.7 1 1.5 0 2.5-1 4.7-1 1.7 0 3.4.9 4.7 2.5-4.1 2.3-3.4 8.2.7 9.3z' }],
  squares: [{ d: 'M4 4h7v7H4z' }, { d: 'M13 4h7v7h-7z' }, { d: 'M4 13h7v7H4z' }, { d: 'M13 13h7v7h-7z' }],
  search: [{ d: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z' }, { d: 'M21 21l-4.3-4.3' }],
  sort: [{ d: 'M3 6h13M3 12h9M3 18h5' }, { d: 'M18 14l3 3 3-3' }, { d: 'M21 17V7' }],
  filter: [{ d: 'M4 4h16l-6 8v7l-4-2v-5L4 4z' }],
  plus: [{ d: 'M12 5v14M5 12h14' }],
} satisfies Record<string, Stroke[]>;

function StatusCircle({ kind, size = 14 }: { kind: StatusKey; size?: number }) {
  const c = STATUS[kind].color;
  if (kind === 'resolved') {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" style={{ flexShrink: 0 }}>
        <circle cx="7" cy="7" r="7" fill={c} />
        <path d="M3.8 7.1l2.3 2.3L10.3 5" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </svg>
    );
  }
  if (kind === 'firstCall') {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" style={{ flexShrink: 0 }}>
        <circle cx="7" cy="7" r="6.25" fill="none" stroke={c} strokeWidth="1.5" />
        <path d="M7 3.4 V 7 L 9.5 8.5" stroke={c} strokeWidth="1.5" strokeLinecap="round" fill="none" />
      </svg>
    );
  }
  if (kind === 'needsReply') {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" style={{ flexShrink: 0 }}>
        <circle cx="7" cy="7" r="6.25" fill="none" stroke={c} strokeWidth="1.5" />
        <path d="M7 7 L 7 1 A 6 6 0 0 1 13 7 Z" fill={c} />
      </svg>
    );
  }
  if (kind === 'pending') {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" style={{ flexShrink: 0 }}>
        <circle cx="7" cy="7" r="7" fill={c} />
        <path d="M7 3.4 V 7 L 9.5 8.5" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" fill="none" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" style={{ flexShrink: 0 }}>
      <circle cx="7" cy="7" r="6.25" fill="none" stroke={c} strokeWidth="1.4" strokeDasharray="2 2.2" />
    </svg>
  );
}

type Convo = {
  id: string;
  name: string;
  preview: string;
  time: string;
  status: StatusKey;
  channel: keyof typeof CHANNEL;
  initials: string;
  avatarBg: string;
};

const CONVOS: Convo[] = [
  { id: '1', name: 'David',   preview: 'Hey how are you? Are you about?...',          time: '3d', status: 'pending',    channel: 'email',   initials: 'D', avatarBg: '#fcd34d' },
  { id: '2', name: 'Raul',    preview: 'Hey how are you? Are you about?...',          time: '3d', status: 'firstCall',  channel: 'phone',   initials: 'R', avatarBg: '#fda4af' },
  { id: '3', name: 'Jet',     preview: 'I’m good! Working on something e...',     time: '3d', status: 'needsReply', channel: 'telegram', initials: 'J', avatarBg: '#fda4af' },
  { id: '4', name: 'Grayson', preview: 'Hey how are you? Are you about?...',          time: '3d', status: 'open',       channel: 'email',   initials: 'G', avatarBg: '#fcd34d' },
  { id: '5', name: 'Lazar',   preview: 'I’m doing well! Diving into some ne...',  time: '3d', status: 'resolved',   channel: 'facebook',initials: 'L', avatarBg: '#fdba74' },
  { id: '6', name: 'Tudor',   preview: 'Just finished a project. What’s ne...',   time: '3d', status: 'resolved',   channel: 'slack',   initials: 'T', avatarBg: '#7dd3fc' },
  { id: '7', name: 'Pawel',   preview: 'Just finished a project. What’s ne...',   time: '3d', status: 'needsReply', channel: 'phone',   initials: 'P', avatarBg: '#fda4af' },
];

const NAV_RAIL: { key: string; paths: Stroke[] }[] = [
  { key: 'compose', paths: ICON.newMessage },
  { key: 'inbox',   paths: ICON.inbox },
  { key: 'me',      paths: ICON.user },
  { key: 'sparkle', paths: ICON.sparkle },
  { key: 'branch',  paths: ICON.branch },
];

const NAV_RAIL_MID: { key: string; paths: Stroke[] }[] = [
  { key: 'sparkle2', paths: ICON.sparkle },
  { key: 'files',    paths: ICON.files },
  { key: 'calendar', paths: ICON.calendar },
  { key: 'contact',  paths: ICON.contact },
  { key: 'building', paths: ICON.building },
  { key: 'message',  paths: ICON.message },
  { key: 'analytics',paths: ICON.analytics },
];

const baseText: CSSProperties = {
  fontFamily: FONT_INTER,
  letterSpacing: LS,
  color: N[800],
  fontFeatureSettings: '"cv02","cv03","cv04","cv11","ss01"',
};

export default function RicoInboxLab() {
  const [selectedId, setSelectedId] = useState('1');
  const [selectedNav, setSelectedNav] = useState('compose');
  const [selectedSidebar, setSelectedSidebar] = useState('all');

  const selected = CONVOS.find((c) => c.id === selectedId) ?? CONVOS[0];

  return (
    <div style={{ ...baseText, height: '100vh', background: BG_PRIMARY, display: 'flex', overflow: 'hidden' }}>
      <NavRail selected={selectedNav} onSelect={setSelectedNav} />
      <Sidebar selected={selectedSidebar} onSelect={setSelectedSidebar} />
      <ConversationList selectedId={selectedId} onSelect={setSelectedId} />
      <DetailPanel convo={selected} />
    </div>
  );
}

function NavRail({ selected, onSelect }: { selected: string; onSelect: (k: string) => void }) {
  return (
    <div style={{ width: 56, background: BG_CHROME, borderRight: `1px solid ${N[200]}`, display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 12, paddingBottom: 12, gap: 4 }}>
      <div style={{ width: 32, height: 32, borderRadius: 8, background: N[900], display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 8 }}>
        <HugeIcon paths={ICON.sparkle} size={18} color="#fff" />
      </div>
      {NAV_RAIL.map((item) => (
        <RailButton key={item.key} active={selected === item.key} onClick={() => onSelect(item.key)} paths={item.paths} />
      ))}
      <div style={{ height: 1, width: 24, background: N[200], marginTop: 8, marginBottom: 8 }} />
      {NAV_RAIL_MID.map((item) => (
        <RailButton key={item.key} active={selected === item.key} onClick={() => onSelect(item.key)} paths={item.paths} />
      ))}
      <div style={{ flex: 1 }} />
      <div style={{ width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <HugeIcon paths={ICON.apple} size={18} color={N[800]} />
      </div>
    </div>
  );
}

function RailButton({ active, onClick, paths }: { active: boolean; onClick: () => void; paths: Stroke[] }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: 36, height: 36, borderRadius: 10, border: 'none', cursor: 'pointer',
        background: active ? '#fff' : 'transparent',
        boxShadow: active ? `inset 0 0 0 1px ${N[200]}, 0 1px 2px rgba(0,0,0,0.04)` : 'none',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <HugeIcon paths={paths} size={18} color={active ? N[800] : N[500]} />
    </button>
  );
}

const SIDEBAR_STATUS: { key: string; status: StatusKey }[] = [
  { key: 'resolved',   status: 'resolved' },
  { key: 'firstCall',  status: 'firstCall' },
  { key: 'needsReply', status: 'needsReply' },
  { key: 'pending',    status: 'pending' },
  { key: 'open',       status: 'open' },
];

const SIDEBAR_CHANNELS: { key: keyof typeof CHANNEL }[] = [
  { key: 'email' }, { key: 'phone' }, { key: 'telegram' }, { key: 'facebook' }, { key: 'slack' },
];

function Sidebar({ selected, onSelect }: { selected: string; onSelect: (k: string) => void }) {
  return (
    <div style={{ width: 280, background: BG_PRIMARY, borderRight: `1px solid ${N[200]}`, display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 56, paddingLeft: 20, paddingRight: 16, display: 'flex', alignItems: 'center', borderBottom: `1px solid ${N[200]}` }}>
        <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: LS, color: N[900] }}>Inbox</span>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', paddingTop: 14 }}>
        <SidebarSection label="Overview" iconPaths={ICON.squares}>
          <SidebarRow
            label="All Inboxes"
            count={0}
            active={selected === 'all'}
            onClick={() => onSelect('all')}
            leading={<DotIcon color={N[400]} />}
          />
          <SidebarRow
            label="My Inbox"
            count={0}
            active={selected === 'my'}
            onClick={() => onSelect('my')}
            leading={<Avatar initials="Q" bg="#fcd34d" size={20} />}
          />
        </SidebarSection>

        <SidebarSection label="Status" trailing={<MiniPlus />}>
          {SIDEBAR_STATUS.map((s) => (
            <SidebarRow
              key={s.key}
              label={STATUS[s.status].label}
              count={0}
              active={selected === s.key}
              onClick={() => onSelect(s.key)}
              leading={<StatusCircle kind={s.status} size={16} />}
            />
          ))}
        </SidebarSection>

        <SidebarSection label="View" trailing={<MiniPlus />}>
          {SIDEBAR_CHANNELS.map((c) => (
            <SidebarRow
              key={c.key}
              label={CHANNEL[c.key].label}
              count={0}
              active={selected === c.key}
              onClick={() => onSelect(c.key)}
              leading={<ChannelSquare color={CHANNEL[c.key].color} />}
            />
          ))}
        </SidebarSection>
      </div>
    </div>
  );
}

function SidebarSection({ label, iconPaths, trailing, children }: { label: string; iconPaths?: Stroke[]; trailing?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ paddingLeft: 8, paddingRight: 8, marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', height: 28, paddingLeft: 12, paddingRight: 8 }}>
        {iconPaths ? <HugeIcon paths={iconPaths} size={14} color={N[500]} /> : null}
        <span style={{ marginLeft: iconPaths ? 8 : 0, fontSize: 12, fontWeight: 500, color: N[500], letterSpacing: LS, flex: 1 }}>{label}</span>
        {trailing}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1, marginTop: 2 }}>{children}</div>
    </div>
  );
}

function MiniPlus() {
  return (
    <button style={{ width: 22, height: 22, borderRadius: 6, border: `1px solid ${N[200]}`, background: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <HugeIcon paths={ICON.plus} size={12} color={N[500]} />
    </button>
  );
}

function SidebarRow({ label, count, active, onClick, leading }: { label: string; count: number; active: boolean; onClick: () => void; leading: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        height: 34, paddingLeft: 12, paddingRight: 12,
        display: 'flex', alignItems: 'center', gap: 10,
        border: 'none', borderRadius: 8,
        background: active ? N[100] : 'transparent',
        cursor: 'pointer', textAlign: 'left',
      }}
    >
      {leading}
      <span style={{ flex: 1, fontSize: 13.5, fontWeight: active ? 600 : 500, color: active ? N[900] : N[800], letterSpacing: LS }}>{label}</span>
      <span style={{ fontSize: 12, color: N[400], letterSpacing: LS, fontVariantNumeric: 'tabular-nums' }}>{count}</span>
    </button>
  );
}

function DotIcon({ color }: { color: string }) {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" style={{ flexShrink: 0 }}>
      <circle cx="8" cy="8" r="3" fill={color} />
    </svg>
  );
}

function ChannelSquare({ color }: { color: string }) {
  return <span style={{ width: 18, height: 18, borderRadius: 5, background: color, flexShrink: 0, display: 'inline-block' }} />;
}

function Avatar({ initials, bg, size = 28 }: { initials: string; bg: string; size?: number }) {
  return (
    <span style={{
      width: size, height: size, borderRadius: Math.round(size * 0.32),
      background: bg, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0,
      fontSize: Math.round(size * 0.42), fontWeight: 600, color: '#7c2d12', letterSpacing: LS,
    }}>
      {initials}
    </span>
  );
}

function ConversationList({ selectedId, onSelect }: { selectedId: string; onSelect: (id: string) => void }) {
  return (
    <div style={{ width: 380, background: BG_PRIMARY, borderRight: `1px solid ${N[200]}`, display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 56, paddingLeft: 18, paddingRight: 14, display: 'flex', alignItems: 'center', borderBottom: `1px solid ${N[200]}` }}>
        <HugeIcon paths={ICON.inbox} size={15} color={N[700]} />
        <span style={{ marginLeft: 10, fontSize: 13.5, fontWeight: 600, color: N[900], letterSpacing: LS, flex: 1 }}>All Inboxes</span>
        <IconBtn paths={ICON.search} />
        <IconBtn paths={ICON.sort} />
        <IconBtn paths={ICON.filter} />
      </div>
      <div style={{ flex: 1, overflowY: 'auto', paddingTop: 6, paddingBottom: 6 }}>
        {CONVOS.map((c) => (
          <ConvoRow key={c.id} convo={c} active={c.id === selectedId} onClick={() => onSelect(c.id)} />
        ))}
      </div>
    </div>
  );
}

function IconBtn({ paths }: { paths: Stroke[] }) {
  return (
    <button style={{ width: 30, height: 30, borderRadius: 7, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', marginLeft: 2 }}>
      <HugeIcon paths={paths} size={15} color={N[500]} />
    </button>
  );
}

function ConvoRow({ convo, active, onClick }: { convo: Convo; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: 'calc(100% - 12px)', marginLeft: 6, marginRight: 6, marginTop: 1, marginBottom: 1,
        paddingTop: 10, paddingBottom: 10, paddingLeft: 10, paddingRight: 10,
        display: 'flex', alignItems: 'flex-start', gap: 10,
        border: 'none', borderRadius: 10, cursor: 'pointer', textAlign: 'left',
        background: active ? N[100] : 'transparent',
      }}
    >
      <Avatar initials={convo.initials} bg={convo.avatarBg} size={36} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 1 }}>
        <span style={{ fontSize: 13.5, fontWeight: 600, color: N[900], letterSpacing: LS }}>{convo.name}</span>
        <span style={{ fontSize: 12.5, color: N[500], letterSpacing: LS, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 280 }}>{convo.preview}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, paddingTop: 2 }}>
        <StatusCircle kind={convo.status} size={14} />
        <span style={{ fontSize: 11.5, color: N[400], letterSpacing: LS, fontVariantNumeric: 'tabular-nums' }}>{convo.time}</span>
      </div>
    </button>
  );
}

function DetailPanel({ convo }: { convo: Convo }) {
  return (
    <div style={{ flex: 1, background: BG_PRIMARY, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <div style={{ height: 56, paddingLeft: 20, paddingRight: 20, display: 'flex', alignItems: 'center', borderBottom: `1px solid ${N[200]}` }}>
        <span style={{ fontSize: 15, fontWeight: 600, color: N[900], letterSpacing: LS }}>{convo.name}</span>
      </div>

      <div style={{ flex: 1, paddingLeft: 24, paddingRight: 24, paddingTop: 20, paddingBottom: 20, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
        <div style={{ fontSize: 11, fontWeight: 500, letterSpacing: LS, color: N[500], textTransform: 'uppercase', marginBottom: 12 }}>Activity</div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 24 }}>
          <Avatar initials="D" bg="#fcd34d" size={24} />
          <Avatar initials="N" bg="#fda4af" size={24} />
          <Avatar initials="R" bg="#7dd3fc" size={24} />
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
          <Bubble own>Hey {convo.name}, are you around today?</Bubble>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 12 }}>
          <Bubble>{convo.preview}</Bubble>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 24 }}>
          <Bubble own>Great, talk soon.</Bubble>
        </div>

        <div style={{ flex: 1 }} />

        <Composer />
      </div>
    </div>
  );
}

function Bubble({ children, own = false }: { children: React.ReactNode; own?: boolean }) {
  return (
    <div style={{
      maxWidth: '70%',
      paddingTop: 9, paddingBottom: 9, paddingLeft: 14, paddingRight: 14,
      borderRadius: 14,
      background: own ? N[900] : N[100],
      color: own ? '#fff' : N[800],
      fontSize: 13.5,
      letterSpacing: LS,
      lineHeight: 1.45,
    }}>
      {children}
    </div>
  );
}

function Composer() {
  return (
    <div style={{ borderRadius: 14, border: `1px solid ${N[200]}`, background: BG_CHROME, paddingTop: 12, paddingBottom: 8, paddingLeft: 14, paddingRight: 14 }}>
      <div style={{ fontSize: 13.5, color: N[400], letterSpacing: LS, minHeight: 36 }}>Reply to {/* contact */} …</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
        <IconBtn paths={ICON.plus} />
        <IconBtn paths={ICON.sparkle} />
        <div style={{ flex: 1 }} />
        <button style={{ height: 30, paddingLeft: 12, paddingRight: 12, borderRadius: 8, background: N[900], color: '#fff', fontSize: 12.5, fontWeight: 600, letterSpacing: LS, border: 'none', cursor: 'pointer' }}>Send</button>
      </div>
    </div>
  );
}
