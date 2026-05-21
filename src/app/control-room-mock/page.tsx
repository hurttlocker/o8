'use client';

import { useMemo, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import {
  Archive,
  CheckCircle2,
  Clipboard,
  Clock,
  FileText,
  GitPullRequest,
  Lightbulb,
  MessageSquare,
  MoreHorizontal,
  Play,
  Plus,
  Send,
  ShieldCheck,
  Sparkles,
  Zap,
} from '@/components/desktop/lucide-shims';

type WorkState = 'intake' | 'shaping' | 'ready' | 'motion' | 'review' | 'archived';
type SourceKind = 'issue' | 'epic' | 'comment' | 'note' | 'file';
type WorkerIntent = 'orchestrator' | 'heavy_worker' | 'reviewer' | 'diagnostic';
type IntakePath = 'create_mission' | 'o8_task_create';

interface WorkItem {
  id: string;
  packetId: string | null;
  referenceLabel: string | null;
  laneId: string | null;
  title: string;
  detail: string;
  sourceKind: SourceKind;
  sourceLabel: string;
  sourceRepository: string;
  sourceNumber?: number;
  sourceUrl?: string | null;
  repo: string;
  state: WorkState;
  age: string;
  intent: WorkerIntent;
  runtime: 'codex';
  intakePath: IntakePath;
  branchTarget: string;
  allowedFiles: string[];
}

interface ContextMenuState {
  itemId: string;
  x: number;
  y: number;
}

const INITIAL_ITEMS: WorkItem[] = [
  {
    id: 'w1',
    packetId: null,
    referenceLabel: null,
    laneId: null,
    title: 'Merge PR page into Activity without losing PR actions',
    detail: 'Keep checks, commits, reviews, local comments, and file drawer. Route the old PR page through Activity.',
    sourceKind: 'epic',
    sourceLabel: 'GitHub epic #1097',
    sourceRepository: 'hurttlocker/cortex-ide',
    sourceNumber: 1097,
    sourceUrl: 'https://github.com/hurttlocker/cortex-ide/issues/1097',
    repo: 'cortex-ide',
    state: 'shaping',
    age: '8m',
    intent: 'orchestrator',
    runtime: 'codex',
    intakePath: 'create_mission',
    branchTarget: 'issue/1097-activity-pr-merge',
    allowedFiles: ['src/components/desktop/o8-activity-helpers.tsx', 'src/components/desktop/pr-panel/**'],
  },
  {
    id: 'w2',
    packetId: 'pkt-review-drawer',
    referenceLabel: 'P2',
    laneId: null,
    title: 'Fix the Review file drawer slide-in',
    detail: 'Right side file list should attach to Review and jump to the selected diff file.',
    sourceKind: 'comment',
    sourceLabel: 'operator note',
    sourceRepository: 'local/operator',
    repo: 'cortex-ide',
    state: 'ready',
    age: '18m',
    intent: 'heavy_worker',
    runtime: 'codex',
    intakePath: 'o8_task_create',
    branchTarget: 'agent/fix-review-file-drawer',
    allowedFiles: ['src/components/desktop/review/ReviewPanel.tsx'],
  },
  {
    id: 'w3',
    packetId: 'pkt-agent-composer',
    referenceLabel: 'P3',
    laneId: 'lane-agent-composer',
    title: 'Audit agent composer after spawn',
    detail: 'Make Codex agent chat input match orchestrator controls without model or checkpoint chrome.',
    sourceKind: 'issue',
    sourceLabel: 'GitHub issue #1097',
    sourceRepository: 'hurttlocker/cortex-ide',
    sourceNumber: 1097,
    sourceUrl: 'https://github.com/hurttlocker/cortex-ide/issues/1097',
    repo: 'cortex-ide',
    state: 'motion',
    age: '24m',
    intent: 'reviewer',
    runtime: 'codex',
    intakePath: 'create_mission',
    branchTarget: 'issue/1097-agent-composer',
    allowedFiles: ['src/components/desktop/workspace-terminal/WorkspaceChatComposer.tsx'],
  },
  {
    id: 'w4',
    packetId: 'pkt-zero-diff',
    referenceLabel: 'P4',
    laneId: 'lane-zero-diff',
    title: 'Blocked lane needs a human decision',
    detail: 'Worker says zero diff was produced after dispatch. Decide whether to re-brief or archive.',
    sourceKind: 'comment',
    sourceLabel: 'lane report',
    sourceRepository: 'o8/lane-events',
    repo: 'cortex-ide',
    state: 'review',
    age: '41m',
    intent: 'diagnostic',
    runtime: 'codex',
    intakePath: 'o8_task_create',
    branchTarget: 'agent/zero-diff-decision',
    allowedFiles: [],
  },
  {
    id: 'w5',
    packetId: null,
    referenceLabel: null,
    laneId: null,
    title: 'Capture o8-mobile repo context for desktop project',
    detail: 'Add related repo context to the project brief, but keep cortex-ide as the main repo.',
    sourceKind: 'note',
    sourceLabel: 'project note',
    sourceRepository: 'local/project',
    repo: 'o8-mobile',
    state: 'intake',
    age: '1h',
    intent: 'orchestrator',
    runtime: 'codex',
    intakePath: 'o8_task_create',
    branchTarget: 'agent/capture-mobile-context',
    allowedFiles: ['docs/project-hardening.md'],
  },
];

const SOURCE_OPTIONS: Array<{ kind: SourceKind; label: string; icon: ReactNode }> = [
  { kind: 'issue', label: 'Issue', icon: <GitPullRequest size={13} strokeWidth={2} /> },
  { kind: 'epic', label: 'Epic', icon: <Sparkles size={13} strokeWidth={2} /> },
  { kind: 'comment', label: 'Comment', icon: <MessageSquare size={13} strokeWidth={2} /> },
  { kind: 'note', label: 'Note', icon: <Clipboard size={13} strokeWidth={2} /> },
  { kind: 'file', label: 'File task', icon: <FileText size={13} strokeWidth={2} /> },
];

const SECTIONS: Array<{
  id: WorkState;
  label: string;
  helper: string;
  icon: ReactNode;
}> = [
  { id: 'intake', label: 'Inbox', helper: 'GitHub or operator sources before they become packets.', icon: <Lightbulb size={14} strokeWidth={2} /> },
  { id: 'shaping', label: 'Needs shaping', helper: 'Sources that need a stronger task brief.', icon: <Sparkles size={14} strokeWidth={2} /> },
  { id: 'ready', label: 'Queued packets', helper: 'OrchestratorPacket rows ready for claim or dispatch.', icon: <Play size={14} strokeWidth={2} /> },
  { id: 'motion', label: 'In motion', helper: 'Claimed lanes and running Codex worktrees.', icon: <Zap size={14} strokeWidth={2} /> },
  { id: 'review', label: 'Needs review', helper: 'Blocked, finished, or waiting on a human decision.', icon: <CheckCircle2 size={14} strokeWidth={2} /> },
];

const STATE_LABELS: Record<WorkState, string> = {
  intake: 'Inbox',
  shaping: 'Shape',
  ready: 'Ready',
  motion: 'Running',
  review: 'Review',
  archived: 'Archived',
};

const STATE_COLORS: Record<WorkState, string> = {
  intake: '#64748b',
  shaping: '#f59e0b',
  ready: '#2563eb',
  motion: '#16a34a',
  review: '#f97316',
  archived: '#94a3b8',
};

function sourceIcon(kind: SourceKind) {
  switch (kind) {
    case 'issue':
      return <GitPullRequest size={13} strokeWidth={2} />;
    case 'epic':
      return <Sparkles size={13} strokeWidth={2} />;
    case 'comment':
      return <MessageSquare size={13} strokeWidth={2} />;
    case 'file':
      return <FileText size={13} strokeWidth={2} />;
    default:
      return <Clipboard size={13} strokeWidth={2} />;
  }
}

function intentLabel(value: WorkerIntent) {
  return value.replace(/_/g, ' ');
}

function canonicalStatus(state: WorkState) {
  switch (state) {
    case 'intake':
    case 'shaping':
      return 'not queued';
    case 'ready':
      return 'queued';
    case 'motion':
      return 'running';
    case 'review':
      return 'awaiting_review';
    default:
      return 'archived';
  }
}

function actionPath(item: WorkItem) {
  if (item.intakePath === 'create_mission') {
    return 'create_mission(LoadedIssue[])';
  }
  return 'o8_task_create(TaskCreateInput)';
}

function packetLabel(item: WorkItem) {
  if (item.packetId && item.referenceLabel) return `${item.referenceLabel} / ${item.packetId}`;
  if (item.packetId) return item.packetId;
  return item.intakePath === 'create_mission' ? 'P1..Pn after mission create' : 'created on queue';
}

function sourceShape(item: WorkItem) {
  if (item.intakePath === 'create_mission') {
    return [
      'LoadedIssue',
      `number: ${item.sourceNumber ?? 'issue.number'}`,
      `title: ${item.title}`,
      `body: ${item.detail}`,
      `url: ${item.sourceUrl ?? 'github url'}`,
    ].join('\n');
  }

  return [
    'TaskCreateInput',
    `title: ${item.title}`,
    `summary: ${item.detail}`,
    'projectId: o8',
    `repoPath: ${item.repo}`,
    `workerIntent: ${item.intent}`,
    'requestedRuntime: codex',
  ].join('\n');
}

function packetShape(item: WorkItem) {
  return [
    'OrchestratorPacket',
    `id: ${item.packetId ?? 'assigned when queued'}`,
    `referenceLabel: ${item.referenceLabel ?? 'assigned by mission/task queue'}`,
    item.laneId ? `lane: ${item.laneId}` : 'lane: assigned on claim/dispatch',
    `status: ${canonicalStatus(item.state)}`,
    `runtime: ${item.runtime}`,
    `workerIntent: ${item.intent}`,
    'workerRouting.enforcement: codex_only_production',
    `branchTarget: ${item.branchTarget}`,
    item.allowedFiles.length > 0 ? `allowedFiles: ${item.allowedFiles.join(', ')}` : 'allowedFiles: project scope',
  ].join('\n');
}

function buildTaskBrief(item: WorkItem) {
  return [
    'Project: o8 (3 repos)',
    'Main repo: cortex-ide [fullstack] at /Users/marquisehurtt/cortex-ide',
    item.repo !== 'cortex-ide' ? `Current repo: ${item.repo} at /Users/marquisehurtt/${item.repo}` : null,
    'Related repos: o8-site [site], o8-mobile [mobile]',
    `Task: ${item.title}`,
    `Task detail: ${item.detail}`,
    'Repo policy: treat the main repo as the product anchor, use the current repo for repo-specific work, read sibling repos as context, and edit sibling repos only when the task explicitly requires cross-repo changes.',
    'Output policy: call out which repo(s) changed, any locks/conflicts encountered, and whether follow-up project wiring is needed.',
  ].filter((line): line is string => Boolean(line)).join('\n');
}

export default function ControlRoomMockPage() {
  const [items, setItems] = useState<WorkItem[]>(INITIAL_ITEMS);
  const [selectedId, setSelectedId] = useState(INITIAL_ITEMS[0]?.id ?? '');
  const [composerOpen, setComposerOpen] = useState(false);
  const [draftKind, setDraftKind] = useState<SourceKind>('comment');
  const [draftTitle, setDraftTitle] = useState('');
  const [draftDetail, setDraftDetail] = useState('');
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [chatPreview, setChatPreview] = useState('Select a work card or send one to chat.');

  const selected = useMemo(
    () => items.find((item) => item.id === selectedId) ?? items[0] ?? null,
    [items, selectedId],
  );

  const counts = useMemo(() => {
    return items.reduce<Record<WorkState, number>>((acc, item) => {
      acc[item.state] += 1;
      return acc;
    }, { intake: 0, shaping: 0, ready: 0, motion: 0, review: 0, archived: 0 });
  }, [items]);

  function moveItem(itemId: string, state: WorkState) {
    setItems((current) => current.map((item) => (
      item.id === itemId ? { ...item, state, age: 'now' } : item
    )));
    setMenu(null);
  }

  function addDraft(target: WorkState) {
    const title = draftTitle.trim();
    if (!title) return;
    const item: WorkItem = {
      id: `w${Date.now()}`,
      packetId: target === 'ready' ? `pkt-mock-${Date.now().toString(36)}` : null,
      referenceLabel: target === 'ready' ? 'P-new' : null,
      laneId: null,
      title,
      detail: draftDetail.trim() || title,
      sourceKind: draftKind,
      sourceLabel: draftKind === 'issue' ? 'GitHub issue' : draftKind === 'epic' ? 'GitHub epic' : draftKind === 'comment' ? 'operator note' : draftKind,
      sourceRepository: draftKind === 'issue' || draftKind === 'epic' ? 'hurttlocker/cortex-ide' : 'local/operator',
      sourceUrl: null,
      repo: 'cortex-ide',
      state: target,
      age: 'now',
      intent: target === 'shaping' ? 'orchestrator' : 'heavy_worker',
      runtime: 'codex',
      intakePath: draftKind === 'issue' || draftKind === 'epic' ? 'create_mission' : 'o8_task_create',
      branchTarget: `agent/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 42) || 'task'}`,
      allowedFiles: [],
    };
    setItems((current) => [item, ...current]);
    setSelectedId(item.id);
    setDraftTitle('');
    setDraftDetail('');
    setComposerOpen(false);
  }

  function sendToChat(item: WorkItem) {
    setChatPreview([
      `Use the canonical o8 work shape via ${actionPath(item)}:`,
      '',
      item.title,
      item.detail,
      '',
      `Packet: ${packetLabel(item)}`,
      'Task pool: o8/task.pool/v1',
      'Packet scope: o8/packet.scope/v1',
      `Worker intent: ${intentLabel(item.intent)}`,
      `Runtime: ${item.runtime} (Codex-only production lock)`,
      `Source: ${item.sourceLabel}`,
      `Repo: ${item.repo}`,
    ].join('\n'));
    setMenu(null);
  }

  function openMenu(event: MouseEvent, itemId: string) {
    event.preventDefault();
    setSelectedId(itemId);
    setMenu({
      itemId,
      x: Math.min(event.clientX, window.innerWidth - 238),
      y: Math.min(event.clientY, window.innerHeight - 260),
    });
  }

  return (
    <main className="mock-shell" onClick={() => setMenu(null)}>
      <style>{styles}</style>

      <section className="mock-panel" aria-label="Control room mock">
        <header className="mock-header">
          <div>
            <div className="mock-overline">Control Room</div>
            <h1>Work intake</h1>
            <p>GitHub issues, epics, comments, and operator notes become the same packets agents already receive.</p>
            <p className="mock-note">No second task store. Control Room is a source adapter plus a task-pool view.</p>
          </div>
          <button
            type="button"
            className="primary-action"
            onClick={(event) => {
              event.stopPropagation();
              setComposerOpen((open) => !open);
            }}
          >
            <Plus size={14} strokeWidth={2.2} />
            Add work
          </button>
        </header>

        <div className="policy-row">
          <ShieldCheck size={14} strokeWidth={2} />
          <span>Canonical path: source to OrchestratorPacket to TaskPoolTask to PacketScope.</span>
          <strong>{counts.motion} running</strong>
        </div>

        {composerOpen ? (
          <section className="composer-card" onClick={(event) => event.stopPropagation()}>
            <div className="source-picker">
              {SOURCE_OPTIONS.map((option) => (
                <button
                  key={option.kind}
                  type="button"
                  className={option.kind === draftKind ? 'source-pill source-pill-active' : 'source-pill'}
                  onClick={() => setDraftKind(option.kind)}
                >
                  {option.icon}
                  {option.label}
                </button>
              ))}
            </div>
            <input
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.currentTarget.value)}
              placeholder="Paste a GitHub issue, epic, comment, or instruction"
            />
            <textarea
              value={draftDetail}
              onChange={(event) => setDraftDetail(event.currentTarget.value)}
              placeholder="Optional detail or success criteria"
              rows={3}
            />
            <div className="composer-actions">
              <button type="button" onClick={() => addDraft('shaping')}>Needs shaping</button>
              <button type="button" className="accent-button" onClick={() => addDraft('ready')}>
                Ready to dispatch
              </button>
            </div>
          </section>
        ) : null}

        <div className="metrics-row" aria-label="Work state counts">
          {(['intake', 'shaping', 'ready', 'motion', 'review'] as WorkState[]).map((state) => (
            <span key={state} className="metric-chip">
              <i style={{ background: STATE_COLORS[state] }} />
              {STATE_LABELS[state]}
              <strong>{counts[state]}</strong>
            </span>
          ))}
        </div>

        <div className="section-stack">
          {SECTIONS.map((section) => {
            const sectionItems = items.filter((item) => item.state === section.id);
            return (
              <section key={section.id} className="work-section">
                <div className="section-head">
                  <span>{section.icon}</span>
                  <div>
                    <h2>{section.label}</h2>
                    <p>{section.helper}</p>
                  </div>
                  <strong>{sectionItems.length}</strong>
                </div>
                {sectionItems.length === 0 ? (
                  <div className="empty-row">Nothing here right now.</div>
                ) : (
                  sectionItems.map((item) => (
                    <WorkCard
                      key={item.id}
                      item={item}
                      selected={item.id === selected?.id}
                      onClick={() => setSelectedId(item.id)}
                      onContextMenu={(event) => openMenu(event, item.id)}
                      onMore={(event) => openMenu(event, item.id)}
                    />
                  ))
                )}
              </section>
            );
          })}
        </div>
      </section>

      <aside className="mock-detail" aria-label="Selected work detail">
        {selected ? (
          <>
            <div className="detail-top">
              <span className="detail-icon">{sourceIcon(selected.sourceKind)}</span>
              <div>
                <div className="detail-source">{selected.sourceLabel}</div>
                <h3>{selected.title}</h3>
              </div>
            </div>
            <p className="detail-body">{selected.detail}</p>
            <div className="detail-grid">
              <Info label="Repo" value={selected.repo} />
              <Info label="Packet" value={packetLabel(selected)} />
              <Info label="Status" value={canonicalStatus(selected.state)} tone={STATE_COLORS[selected.state]} />
              <Info label="Runtime" value={selected.runtime} />
              <Info label="Worker" value={intentLabel(selected.intent)} />
              <Info label="Source" value={selected.sourceRepository} />
              <Info label="Branch" value={selected.branchTarget} />
            </div>
            <div className="detail-actions">
              <button type="button" onClick={() => sendToChat(selected)}>
                <Send size={13} strokeWidth={2} />
                Add to chat
              </button>
              <button type="button" onClick={() => moveItem(selected.id, 'ready')}>Make ready</button>
              <button type="button" className="accent-button" onClick={() => moveItem(selected.id, 'motion')}>
                <Play size={13} strokeWidth={2} />
                Dispatch
              </button>
            </div>
            <div className="shape-panel">
              <div className="shape-head">
                <ShieldCheck size={13} strokeWidth={2} />
                Canonical shape
              </div>
              <div className="shape-columns">
                <pre>{sourceShape(selected)}</pre>
                <pre>{packetShape(selected)}</pre>
              </div>
              <div className="shape-row">
                <span>Pool</span>
                <code>o8/task.pool/v1</code>
              </div>
              <div className="shape-row">
                <span>Scope</span>
                <code>o8/packet.scope/v1</code>
              </div>
              <div className="shape-row">
                <span>Intake</span>
                <code>{actionPath(selected)}</code>
              </div>
              <div className="shape-row">
                <span>Dispatch</span>
                <code>o8_task_dispatch / o8 task dispatch</code>
              </div>
              <div className="shape-brief-label">PacketScope project task brief</div>
              <pre className="brief-preview">{buildTaskBrief(selected)}</pre>
            </div>
            <div className="chat-preview">
              <div className="chat-preview-head">
                <MessageSquare size={13} strokeWidth={2} />
                Operator handoff preview
              </div>
              <pre>{chatPreview}</pre>
            </div>
          </>
        ) : null}
      </aside>

      {menu ? (
        <ContextMenu
          item={items.find((item) => item.id === menu.itemId) ?? null}
          style={{ left: menu.x, top: menu.y }}
          onClose={() => setMenu(null)}
          onSend={sendToChat}
          onMove={moveItem}
        />
      ) : null}
    </main>
  );
}

function WorkCard({
  item,
  selected,
  onClick,
  onContextMenu,
  onMore,
}: {
  item: WorkItem;
  selected: boolean;
  onClick: () => void;
  onContextMenu: (event: MouseEvent) => void;
  onMore: (event: MouseEvent) => void;
}) {
  return (
    <article
      className={selected ? 'work-card work-card-selected' : 'work-card'}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <span className="work-icon">{sourceIcon(item.sourceKind)}</span>
      <div className="work-copy">
        <h3>{item.title}</h3>
        <p>{item.sourceLabel} - {packetLabel(item)} - {item.age}</p>
      </div>
      <span className="state-pill" style={{ color: STATE_COLORS[item.state] }}>
        {STATE_LABELS[item.state]}
      </span>
      <button
        type="button"
        className="more-button"
        aria-label={`Actions for ${item.title}`}
        onClick={(event) => {
          event.stopPropagation();
          onMore(event);
        }}
      >
        <MoreHorizontal size={13} strokeWidth={2} />
      </button>
    </article>
  );
}

function ContextMenu({
  item,
  style,
  onClose,
  onSend,
  onMove,
}: {
  item: WorkItem | null;
  style: CSSProperties;
  onClose: () => void;
  onSend: (item: WorkItem) => void;
  onMove: (itemId: string, state: WorkState) => void;
}) {
  if (!item) return null;
  return (
    <>
      <button type="button" aria-label="Close menu" className="menu-scrim" onClick={onClose} />
      <div className="context-menu" style={style} onClick={(event) => event.stopPropagation()}>
        <div className="context-title">{item.title}</div>
        <MenuButton icon={<Send size={13} strokeWidth={2} />} label="Add to chat" onClick={() => onSend(item)} />
        <MenuButton icon={<Sparkles size={13} strokeWidth={2} />} label="Needs shaping" onClick={() => onMove(item.id, 'shaping')} />
        <MenuButton icon={<CheckCircle2 size={13} strokeWidth={2} />} label="Make ready" onClick={() => onMove(item.id, 'ready')} />
        <MenuButton icon={<Play size={13} strokeWidth={2} />} label="Dispatch Codex" onClick={() => onMove(item.id, 'motion')} />
        <MenuButton icon={<Clock size={13} strokeWidth={2} />} label="Needs review" onClick={() => onMove(item.id, 'review')} />
        <MenuButton icon={<Archive size={13} strokeWidth={2} />} label="Archive" danger onClick={() => onMove(item.id, 'archived')} />
      </div>
    </>
  );
}

function MenuButton({
  icon,
  label,
  danger = false,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className={danger ? 'menu-button menu-button-danger' : 'menu-button'} onClick={onClick}>
      {icon}
      {label}
    </button>
  );
}

function Info({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="info-cell">
      <span>{label}</span>
      <strong style={tone ? { color: tone } : undefined}>{value}</strong>
    </div>
  );
}

const styles = `
  .mock-shell {
    min-height: 100vh;
    display: grid;
    grid-template-columns: minmax(360px, 520px) minmax(360px, 1fr);
    gap: 18px;
    padding: 22px;
    background:
      radial-gradient(circle at 18% -10%, rgba(37, 99, 235, 0.12), transparent 30%),
      linear-gradient(180deg, var(--t-bg, #f8f6f1), color-mix(in srgb, var(--t-bg, #f8f6f1) 88%, #ffffff));
    color: var(--t-text, #0f172a);
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
  }

  .mock-panel,
  .mock-detail {
    min-width: 0;
    border: 1px solid var(--t-divider-subtle, rgba(100, 116, 139, 0.18));
    border-radius: 22px;
    background: color-mix(in srgb, var(--t-panel, #ffffff) 86%, transparent);
    box-shadow: 0 24px 70px rgba(15, 23, 42, 0.08);
    overflow: hidden;
  }

  .mock-panel {
    display: flex;
    flex-direction: column;
  }

  .mock-header {
    display: flex;
    align-items: flex-start;
    gap: 16px;
    padding: 20px;
    border-bottom: 1px solid var(--t-divider-subtle, rgba(100, 116, 139, 0.16));
  }

  .mock-header > div {
    flex: 1;
    min-width: 0;
  }

  .mock-overline {
    color: var(--t-text-faint, #94a3b8);
    font-size: 11px;
    line-height: 14px;
    font-weight: 650;
    letter-spacing: 0.13em;
    text-transform: uppercase;
  }

  .mock-header h1 {
    margin: 4px 0 0;
    font-size: 24px;
    line-height: 30px;
    letter-spacing: -0.02em;
  }

  .mock-header p {
    margin: 5px 0 0;
    max-width: 430px;
    color: var(--t-text-muted, #64748b);
    font-size: 13px;
    line-height: 18px;
  }

  button {
    font: inherit;
  }

  .primary-action,
  .accent-button {
    color: var(--t-accent, #2563eb);
    background: color-mix(in srgb, var(--t-accent, #2563eb) 9%, var(--t-panel, #ffffff));
    border-color: color-mix(in srgb, var(--t-accent, #2563eb) 25%, var(--t-divider-subtle, #dbe3ef));
  }

  .primary-action,
  .composer-actions button,
  .detail-actions button {
    min-height: 32px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    border: 1px solid var(--t-divider-subtle, rgba(100, 116, 139, 0.18));
    border-radius: 11px;
    padding: 0 12px;
    cursor: pointer;
    font-size: 12px;
    line-height: 16px;
    font-weight: 560;
  }

  .policy-row,
  .metrics-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 10px 20px 0;
  }

  .policy-row {
    min-height: 30px;
    color: var(--t-text-muted, #64748b);
    font-size: 12px;
    line-height: 16px;
  }

  .policy-row span {
    flex: 1;
    min-width: 0;
  }

  .policy-row strong {
    color: var(--t-text-faint, #94a3b8);
    font-weight: 560;
  }

  .metrics-row {
    flex-wrap: wrap;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--t-divider-subtle, rgba(100, 116, 139, 0.14));
  }

  .metric-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-height: 24px;
    color: var(--t-text-muted, #64748b);
    font-size: 11px;
    line-height: 14px;
  }

  .metric-chip i {
    width: 6px;
    height: 6px;
    border-radius: 99px;
  }

  .metric-chip strong {
    color: var(--t-text, #0f172a);
    font-weight: 620;
  }

  .composer-card {
    margin: 12px 20px 0;
    border: 1px solid var(--t-divider-subtle, rgba(100, 116, 139, 0.18));
    border-radius: 18px;
    background: color-mix(in srgb, var(--t-panel, #ffffff) 92%, transparent);
    padding: 12px;
  }

  .source-picker {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 9px;
  }

  .source-pill {
    min-height: 27px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 0;
    border-radius: 10px;
    background: transparent;
    color: var(--t-text-muted, #64748b);
    padding: 0 9px;
    cursor: pointer;
    font-size: 11.5px;
  }

  .source-pill-active {
    background: color-mix(in srgb, var(--t-accent, #2563eb) 10%, transparent);
    color: var(--t-accent, #2563eb);
  }

  .composer-card input,
  .composer-card textarea {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid var(--t-divider-subtle, rgba(100, 116, 139, 0.18));
    border-radius: 13px;
    background: color-mix(in srgb, var(--t-panel, #ffffff) 72%, transparent);
    color: var(--t-text, #0f172a);
    outline: none;
    padding: 10px 11px;
    font-size: 12.5px;
    line-height: 17px;
  }

  .composer-card textarea {
    margin-top: 8px;
    resize: vertical;
  }

  .composer-actions {
    display: flex;
    justify-content: flex-end;
    gap: 7px;
    margin-top: 9px;
  }

  .section-stack {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 0 20px 20px;
  }

  .work-section {
    padding-top: 15px;
  }

  .section-head {
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr) auto;
    gap: 8px;
    align-items: start;
    margin-bottom: 7px;
    color: var(--t-text-faint, #94a3b8);
  }

  .section-head h2 {
    margin: 0;
    color: var(--t-text-muted, #64748b);
    font-size: 11px;
    line-height: 14px;
    font-weight: 650;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .section-head p {
    margin: 2px 0 0;
    color: var(--t-text-faint, #94a3b8);
    font-size: 11.5px;
    line-height: 15px;
  }

  .section-head strong {
    color: var(--t-text-faint, #94a3b8);
    font-size: 11px;
    font-weight: 560;
  }

  .empty-row {
    border-top: 1px solid var(--t-divider-subtle, rgba(100, 116, 139, 0.12));
    color: var(--t-text-faint, #94a3b8);
    padding: 10px 0;
    font-size: 12px;
  }

  .work-card {
    width: 100%;
    box-sizing: border-box;
    display: grid;
    grid-template-columns: 24px minmax(0, 1fr) auto 24px;
    align-items: center;
    gap: 8px;
    border-top: 1px solid var(--t-divider-subtle, rgba(100, 116, 139, 0.12));
    background: transparent;
    cursor: pointer;
    padding: 8px 0;
  }

  .work-card:hover {
    background: color-mix(in srgb, var(--t-hover, #eff4ff) 48%, transparent);
  }

  .work-card-selected {
    background: color-mix(in srgb, var(--t-accent, #2563eb) 7%, transparent);
  }

  .work-icon,
  .detail-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--t-accent, #2563eb);
  }

  .work-copy {
    min-width: 0;
  }

  .work-copy h3 {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--t-text, #0f172a);
    font-size: 12.5px;
    line-height: 16px;
    font-weight: 560;
  }

  .work-copy p {
    margin: 1px 0 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--t-text-faint, #94a3b8);
    font-size: 11px;
    line-height: 14px;
  }

  .state-pill {
    font-size: 10.5px;
    line-height: 14px;
    font-weight: 620;
  }

  .more-button {
    width: 24px;
    height: 24px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--t-text-faint, #94a3b8);
    cursor: pointer;
    opacity: 0;
  }

  .work-card:hover .more-button,
  .work-card-selected .more-button {
    opacity: 1;
  }

  .mock-detail {
    align-self: start;
    padding: 22px;
  }

  .detail-top {
    display: grid;
    grid-template-columns: 30px minmax(0, 1fr);
    gap: 10px;
    align-items: start;
  }

  .detail-source {
    color: var(--t-text-faint, #94a3b8);
    font-size: 11px;
    line-height: 14px;
    font-weight: 650;
    letter-spacing: 0.11em;
    text-transform: uppercase;
  }

  .detail-top h3 {
    margin: 4px 0 0;
    font-size: 22px;
    line-height: 28px;
    letter-spacing: -0.02em;
  }

  .detail-body {
    margin: 16px 0 0;
    color: var(--t-text-muted, #64748b);
    font-size: 14px;
    line-height: 21px;
  }

  .detail-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
    margin-top: 18px;
  }

  .info-cell {
    border: 1px solid var(--t-divider-subtle, rgba(100, 116, 139, 0.16));
    border-radius: 15px;
    padding: 10px;
    background: color-mix(in srgb, var(--t-panel, #ffffff) 70%, transparent);
  }

  .info-cell span {
    display: block;
    color: var(--t-text-faint, #94a3b8);
    font-size: 10.5px;
    line-height: 14px;
  }

  .info-cell strong {
    display: block;
    margin-top: 2px;
    color: var(--t-text, #0f172a);
    font-size: 12.5px;
    line-height: 16px;
    font-weight: 580;
  }

  .detail-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 18px;
  }

  .shape-panel {
    margin-top: 18px;
    border: 1px solid var(--t-divider-subtle, rgba(100, 116, 139, 0.16));
    border-radius: 18px;
    background: color-mix(in srgb, var(--t-panel, #ffffff) 78%, transparent);
    overflow: hidden;
  }

  .shape-head {
    display: flex;
    align-items: center;
    gap: 7px;
    border-bottom: 1px solid var(--t-divider-subtle, rgba(100, 116, 139, 0.14));
    color: var(--t-text-muted, #64748b);
    padding: 10px 12px;
    font-size: 12px;
    line-height: 16px;
  }

  .shape-columns {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
    padding: 10px;
  }

  .shape-columns pre,
  .brief-preview {
    margin: 0;
    white-space: pre-wrap;
    color: var(--t-text, #0f172a);
    font: 11.5px/17px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }

  .shape-columns pre {
    min-height: 140px;
    border: 1px solid var(--t-divider-subtle, rgba(100, 116, 139, 0.14));
    border-radius: 14px;
    background: color-mix(in srgb, var(--t-bg, #f8f6f1) 72%, transparent);
    padding: 10px;
  }

  .shape-row {
    display: grid;
    grid-template-columns: 74px minmax(0, 1fr);
    gap: 8px;
    align-items: center;
    border-top: 1px solid var(--t-divider-subtle, rgba(100, 116, 139, 0.1));
    padding: 8px 12px;
    color: var(--t-text-muted, #64748b);
    font-size: 11.5px;
    line-height: 16px;
  }

  .shape-row code {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--t-text, #0f172a);
    font: 11.5px/16px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }

  .shape-brief-label {
    border-top: 1px solid var(--t-divider-subtle, rgba(100, 116, 139, 0.12));
    color: var(--t-text-faint, #94a3b8);
    padding: 10px 12px 0;
    font-size: 10.5px;
    line-height: 14px;
    font-weight: 650;
    letter-spacing: 0.11em;
    text-transform: uppercase;
  }

  .brief-preview {
    padding: 9px 12px 13px;
  }

  .chat-preview {
    margin-top: 18px;
    border: 1px solid var(--t-divider-subtle, rgba(100, 116, 139, 0.16));
    border-radius: 18px;
    background: color-mix(in srgb, var(--t-panel, #ffffff) 76%, transparent);
    overflow: hidden;
  }

  .chat-preview-head {
    display: flex;
    align-items: center;
    gap: 7px;
    border-bottom: 1px solid var(--t-divider-subtle, rgba(100, 116, 139, 0.14));
    color: var(--t-text-muted, #64748b);
    padding: 10px 12px;
    font-size: 12px;
    line-height: 16px;
  }

  .chat-preview pre {
    margin: 0;
    min-height: 150px;
    white-space: pre-wrap;
    color: var(--t-text, #0f172a);
    padding: 13px;
    font: 12.5px/18px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }

  .menu-scrim {
    position: fixed;
    inset: 0;
    z-index: 30;
    border: 0;
    background: transparent;
  }

  .context-menu {
    position: fixed;
    z-index: 31;
    width: 226px;
    border: 1px solid var(--t-divider-subtle, rgba(100, 116, 139, 0.18));
    border-radius: 16px;
    background: color-mix(in srgb, var(--t-panel, #ffffff) 92%, transparent);
    box-shadow: 0 22px 60px rgba(15, 23, 42, 0.14);
    padding: 8px;
  }

  .context-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--t-text, #0f172a);
    padding: 7px 8px 8px;
    font-size: 12px;
    line-height: 16px;
    font-weight: 580;
  }

  .menu-button {
    width: 100%;
    min-height: 31px;
    display: flex;
    align-items: center;
    gap: 8px;
    border: 0;
    border-radius: 10px;
    background: transparent;
    color: var(--t-text-muted, #64748b);
    cursor: pointer;
    padding: 0 8px;
    text-align: left;
    font-size: 12px;
    line-height: 16px;
  }

  .menu-button:hover {
    background: color-mix(in srgb, var(--t-hover, #eff4ff) 62%, transparent);
    color: var(--t-text, #0f172a);
  }

  .menu-button-danger {
    color: #ef4444;
  }

  @media (max-width: 900px) {
    .mock-shell {
      grid-template-columns: minmax(0, 1fr);
      padding: 12px;
    }
  }
`;
