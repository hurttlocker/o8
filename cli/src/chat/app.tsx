import React, { useEffect, useMemo, useRef, useState } from 'react';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Box, Text, render, useApp, useInput, useStdout } from 'ink';
import type { ResolvedConfig } from '../config.js';
import { ChatClient, historyMessages, readThread, type ThreadHistory } from './client.js';
import { editInput, graphemes, type InputValue } from './input.js';
import { initialChatState, receiveEvent, safeText, type ChatRoute } from './state.js';
import { Composer, Transcript, Welcome, composerLines, palette, transcriptLines, type ViewLine } from './view.js';
import { terminalInput } from './terminal-input.js';

const HELP = [
  '/help        This guide',
  '/session     Conversation identity and resume command',
  '/reconnect   Reopen the connection and read saved history',
  '/quit        Leave chat; active work continues in o8',
  '',
  'Enter sends   Ctrl+J adds a line   Esc requests stop',
  'Ctrl+O expands tools   Page Up/Down reads the transcript',
  '↑/↓ recalls prompts   Ctrl+U clears the draft',
  '',
  'This is the existing o8 orchestrator. Its normal approval',
  'and workspace rules still apply. No saved settings change.',
].map((text): ViewLine => ({ text, tone: 'muted' }));
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function Activity({ busy, noMotion, text }: { busy: boolean; noMotion: boolean; text: string }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!busy || noMotion) return;
    const timer = setInterval(() => setFrame((value) => (value + 1) % (text.length + 8)), 100);
    return () => clearInterval(timer);
  }, [busy, noMotion, text.length]);
  const start = Math.max(0, frame - 4);
  return <Text color={busy ? palette.accent : palette.muted}>
    {busy ? noMotion ? '◌' : FRAMES[frame % FRAMES.length] : '·'}{' '}
    {busy && !noMotion
      ? <>{text.slice(0, start)}<Text color={palette.soft}>{text.slice(start, frame)}</Text>{text.slice(frame)}</>
      : text}
  </Text>;
}

function ChatApp({ cfg, route, history, noMotion, terminal }: {
  cfg: ResolvedConfig; route: ChatRoute; history: ThreadHistory; noMotion: boolean; terminal: ReturnType<typeof terminalInput>;
}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [size, setSize] = useState({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
  const [state, setState] = useState(() => {
    const initial = initialChatState();
    initial.messages = historyMessages(history);
    return initial;
  });
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [input, setInput] = useState<InputValue>({ text: '', cursor: 0 });
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState<'chat' | 'help' | 'session'>('chat');
  const [offset, setOffset] = useState(0);
  const [hint, setHint] = useState('');
  const clientRef = useRef<ChatClient | null>(null);
  const generation = useRef(0);
  const alive = useRef(true);
  const promptHistory = useRef(historyMessages(history).filter((m) => m.role === 'user').map((m) => m.text));
  const historyIndex = useRef(promptHistory.current.length);
  const savedDraft = useRef('');
  const exitArmed = useRef(0);

  const turnEpoch = useRef(0);
  const historyRequest = useRef(0);
  const recovering = useRef(false);
  const refreshTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const refreshPending = useRef(false);
  const stopRefresh = () => { clearInterval(refreshTimer.current); refreshTimer.current = undefined; };

  const reconcile = async () => {
    const epoch = generation.current;
    const turn = turnEpoch.current;
    const request = ++historyRequest.current;
    refreshPending.current = true;
    try {
      const saved = await readThread(cfg, route.threadId);
      if (!alive.current || epoch !== generation.current || turn !== turnEpoch.current || request !== historyRequest.current) return;
      setState((previous) => ({ ...previous,
        messages: historyMessages(saved).map((m) => ({ ...m,
          tools: previous.messages.find((old) => old.id === m.id)?.tools ?? [],
        })),
      }));
    } catch {
      if (alive.current && request === historyRequest.current) setHint('Saved history could not be refreshed. Live output is preserved.');
    } finally {
      if (request === historyRequest.current) refreshPending.current = false;
    }
  };

  const connect = async (reload: boolean) => {
    clientRef.current?.close();
    stopRefresh();
    setConnection('connecting');
    const epoch = ++generation.current;
    recovering.current = reload || Boolean(history.repoPath);
    setState((previous) => ({ ...previous, busy: false, cursor: 0, error: null, notice: null }));
    try {
      const client = new ChatClient(cfg, route, (event) => {
        if (!alive.current || epoch !== generation.current) return;
        const wire = event as { event?: string; data?: { status?: string; snapshot?: boolean } };
        // An attached active turn may predate the bounded replay window. Read
        // complete saved snapshots during that turn instead of guessing where
        // streamed deltas join the persisted prefix. New turns stream normally.
        if (!(recovering.current && wire.event === 'output')) {
          setState((previous) => receiveEvent(previous, event, route));
        }
        if (wire.event === 'status' && wire.data?.snapshot && wire.data.status === 'busy') {
          recovering.current = true;
          setHint('Reattached to active work. Refreshing the saved response.');
          void reconcile();
          stopRefresh();
          refreshTimer.current = setInterval(() => {
            if (!refreshPending.current) void reconcile();
          }, 2000);
        }
        if (wire.event === 'status' && !wire.data?.snapshot && wire.data?.status === 'busy') turnEpoch.current += 1;
        if ((wire.event === 'status' && ['ready', 'dead'].includes(wire.data?.status ?? '')) || wire.event === 'error') {
          stopRefresh(); recovering.current = false;
          setHint('');
          void reconcile();
        }
      }, () => {
        if (!alive.current || epoch !== generation.current) return;
        stopRefresh();
        setConnection('disconnected');
        setState((previous) => ({ ...previous, busy: false, activity: 'Connection lost',
          notice: 'Delivery and turn state may be unknown. /reconnect checks saved history. Nothing is resent automatically.' }));
      });
      clientRef.current = client;
      await client.connect();
      if (alive.current && epoch === generation.current) setConnection('connected');
    } catch (error) {
      if (!alive.current || epoch !== generation.current) return;
      clientRef.current?.close(); stopRefresh();
      setConnection('disconnected');
      setState((previous) => ({ ...previous, error: safeText(error instanceof Error ? error.message : String(error)) }));
    }
  };

  useEffect(() => {
    alive.current = true;
    void connect(false);
    const resize = () => setSize({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
    stdout.on('resize', resize);
    const paste = (text: string) => setInput((value) => editInput(value, text, {}));
    const overflow = () => setHint('Paste exceeds 1 MiB. Use a smaller excerpt or reference the file.');
    terminal.paste.on('paste', paste);
    terminal.paste.on('overflow', overflow);
    return () => {
      alive.current = false; stopRefresh(); clientRef.current?.close(); stdout.off('resize', resize);
      terminal.paste.off('paste', paste); terminal.paste.off('overflow', overflow);
    };
    // A ChatApp owns one route for its entire mounted lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const interrupt = () => {
    try { clientRef.current?.interrupt(); setHint('Stop requested. Waiting for o8 to confirm.'); }
    catch (error) { setHint(safeText(error instanceof Error ? error.message : String(error))); }
  };
  const leave = () => {
    if (Date.now() - exitArmed.current < 2000) { clientRef.current?.close(); exit(); return; }
    exitArmed.current = Date.now();
    setHint('Press Ctrl+D again to leave. Active work continues in o8.');
  };
  const submit = () => {
    const text = input.text.trim();
    if (!text) return;
    if (text.startsWith('/')) {
      if (text === '/quit' || text === '/exit') { clientRef.current?.close(); exit(); return; }
      if (text === '/help') setPage('help');
      else if (text === '/session') setPage('session');
      else if (text === '/reconnect') { if (connection !== 'connecting') void connect(true); }
      else { setHint('Unknown command. Type /help for the short guide.'); return; }
      setInput({ text: '', cursor: 0 });
      setOffset(0);
      return;
    }
    if (connection !== 'connected') { setHint('Waiting for a connection. /reconnect retries without resending your draft.'); return; }
    if (state.busy) { setHint('This turn is still running. Your draft is saved here; Esc requests stop.'); return; }
    try {
      const id = randomUUID();
      turnEpoch.current += 1; recovering.current = false; stopRefresh();
      clientRef.current!.send(text, id);
      setState((previous) => ({ ...previous, busy: true, error: null, notice: null, activity: 'Sending', activeMessageId: null,
        messages: [...previous.messages, { id, role: 'user', text, tools: [] }],
      }));
      promptHistory.current.push(text);
      historyIndex.current = promptHistory.current.length;
      savedDraft.current = '';
      setInput({ text: '', cursor: 0 });
      setPage('chat'); setOffset(0); setHint('');
    } catch (error) { setHint(safeText(error instanceof Error ? error.message : String(error))); }
  };

  useInput((text, key) => {
    if (key.ctrl && text === 'd') { leave(); return; }
    if (key.ctrl && text === 'c') {
      if (state.busy) interrupt();
      else if (input.text) setInput({ text: '', cursor: 0 });
      else leave();
      return;
    }
    if (key.escape) {
      if (page !== 'chat') setPage('chat');
      else if (state.busy) interrupt();
      else setHint('');
      return;
    }
    if (size.columns < 36 || size.rows < 12) return;
    if (key.ctrl && text === 'o') { setExpanded((value) => !value); return; }
    if (key.pageUp) { setOffset((value) => value + Math.max(4, size.rows - 12)); return; }
    if (key.pageDown) { setOffset((value) => Math.max(0, value - Math.max(4, size.rows - 12))); return; }
    if ((key.upArrow || key.downArrow) && !input.text.includes('\n')) {
      if (historyIndex.current === promptHistory.current.length) savedDraft.current = input.text;
      historyIndex.current = Math.max(0, Math.min(promptHistory.current.length, historyIndex.current + (key.upArrow ? -1 : 1)));
      const recalled = promptHistory.current[historyIndex.current] ?? savedDraft.current;
      setInput({ text: recalled, cursor: graphemes(recalled).length }); return;
    }
    if (key.return && !(key.ctrl || key.shift || key.meta)) { submit(); return; }
    if (key.return) { setInput((value) => editInput(value, 'j', { ctrl: true })); return; }
    setInput((value) => editInput(value, text, key));
  });

  const width = Math.max(20, Math.min(108, size.columns - 4));
  const inputHeight = Math.min(4, composerLines(input, width - 6).lines.length) + 2;
  const bodyHeight = Math.max(2, size.rows - inputHeight - 9);
  const lines = useMemo(() => transcriptLines(state.messages, width, expanded), [state.messages, width, expanded]);
  const sessionLines: ViewLine[] = [
    { text: 'This conversation', tone: 'accent', bold: true },
    ...transcriptLines([{ id: 'session', role: 'notice', tools: [], text:
      `${route.threadId}\n${route.repoPath}\n${route.backend} · ${route.model ?? 'backend default'}\n\nResume:\no8 chat --resume ${route.threadId}\n\nLeaving the terminal does not stop active work.\nUse Esc during a turn to request interruption.` }], width, true),
  ];
  const displayed = page === 'help' ? HELP : page === 'session' ? sessionLines : lines;
  const status = state.error || hint || state.notice;
  if (size.columns < 36 || size.rows < 12) return <Text wrap="truncate-end">Resize to at least 36 × 12 to use chat.</Text>;
  return <Box flexDirection="column" paddingLeft={2} paddingRight={2} height={Math.max(10, size.rows - 1)}>
    <Box width={width} justifyContent="space-between">
      <Text bold color={palette.accent}>o8 <Text color={palette.muted}>/ {safeText(basename(route.repoPath))}</Text></Text>
      <Text color={palette.dim}>{connection === 'connected' ? '● connected' : connection === 'connecting' ? '◌ connecting' : '○ disconnected'}</Text>
    </Box>
    <Text color={palette.muted} wrap="truncate-end">{safeText(route.backend)} · {safeText(route.model ?? 'backend default')} · {route.permissionMode === 'plan' ? 'plan mode' : 'full access'}</Text>
    <Text color={palette.dim}>{'─'.repeat(width)}</Text>
    <Box height={bodyHeight} flexDirection="column" overflow="hidden">
      {!state.messages.length && page === 'chat'
        ? <Welcome repo={route.repoPath} width={width} />
        : <Transcript lines={displayed} height={bodyHeight} offset={Math.min(offset, Math.max(0, displayed.length - bodyHeight))} />}
    </Box>
    <Activity busy={state.busy || connection === 'connecting'} noMotion={noMotion} text={connection === 'connecting' ? 'Connecting to o8' : state.activity} />
    <Text color={state.error ? palette.error : palette.muted} wrap="truncate-end">{status ? safeText(status) : offset > 0 ? 'Reading earlier messages · Page Down to return' : ' '}</Text>
    <Composer value={input} width={width} connected={connection === 'connected'} />
    <Text color={palette.dim} wrap="truncate-end">↵ send  ·  Ctrl+J newline  ·  {state.busy ? 'Esc stop' : '/help'}  ·  Ctrl+O tools  ·  Ctrl+D leave</Text>
  </Box>;
}

export async function startChat(cfg: ResolvedConfig, route: ChatRoute, history: ThreadHistory, noMotion: boolean): Promise<void> {
  process.stdout.write('\x1b[?1049h\x1b[?2004h');
  const terminal = terminalInput(process.stdin);
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    process.stdout.write('\x1b[?2004l\x1b[?25h\x1b[?1049l');
  };
  // Standard synchronized frames avoid the incremental renderer's trailing-
  // newline cursor drift inside an alternate buffer.
  const app = render(<ChatApp cfg={cfg} route={route} history={history} noMotion={noMotion} terminal={terminal} />,
    { stdin: terminal.stream, exitOnCtrlC: false, patchConsole: false, maxFps: 30 });
  const terminate = () => { app.unmount(); restore(); };
  process.once('SIGTERM', terminate);
  process.once('SIGHUP', terminate);
  try { await app.waitUntilExit(); }
  finally {
    app.unmount(); terminal.close(); restore();
    process.off('SIGTERM', terminate); process.off('SIGHUP', terminate);
  }
  process.stdout.write(`\nResume this conversation: o8 chat --resume ${route.threadId}\n`);
}
