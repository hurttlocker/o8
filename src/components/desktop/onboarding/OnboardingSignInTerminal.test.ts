// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { DesktopWsCallbacks } from '../hooks/useDesktopWebSocket';

const transport = vi.hoisted(() => ({
  callbacks: {} as DesktopWsCallbacks,
  commands: { isConnected: true, sendTerminalCreate: vi.fn(), sendTerminalAttach: vi.fn(), sendTerminalInput: vi.fn(), sendTerminalResize: vi.fn(), sendTerminalVisibility: vi.fn(), sendTerminalDetach: vi.fn(), sendAgentKill: vi.fn() },
  write: vi.fn(), focus: vi.fn(),
}));
vi.mock('../hooks/DesktopWebSocketContext', () => ({
  DesktopWebSocketProvider: ({ children }: { children: React.ReactNode }) => children,
  useSharedDesktopWs: (_key: unknown, callbacks: DesktopWsCallbacks) => { transport.callbacks = callbacks; return transport.commands; },
}));
vi.mock('../workspace-terminal/XtermPanel', async () => {
  const React = await import('react');
  return { XtermPanel: React.forwardRef(function Terminal(props: { tmuxSession: string; inputLocked: boolean; sendTerminalAttach: (name: string, cols: number, rows: number) => void }, ref) {
    React.useImperativeHandle(ref, () => ({ writeData: transport.write, focus: transport.focus, setExited: vi.fn() }));
    React.useEffect(() => { props.sendTerminalAttach(props.tmuxSession, 90, 12); }, [props.sendTerminalAttach, props.tmuxSession]);
    return createElement('div', { 'data-input-locked': props.inputLocked }, 'Interactive terminal');
  }) };
});
import { OnboardingSignInTerminal } from './OnboardingSignInTerminal';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
afterEach(() => { act(() => root?.unmount()); document.body.replaceChildren(); vi.clearAllMocks(); transport.commands.isConnected = true; });
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === label)!;
async function render() {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const close = vi.fn();
  const props = { command: 'codex login', onClose: close };
  await act(async () => root.render(createElement(OnboardingSignInTerminal, props)));
  return { props, close };
}
async function attach() {
  const owner = transport.commands.sendTerminalCreate.mock.calls[0]![2] as string;
  await act(async () => transport.callbacks.onTerminalCreated?.('cortex-dash-owned', owner));
  await act(async () => transport.callbacks.onTerminalAttached?.('cortex-dash-owned'));
  return owner;
}

it('opens a fresh direct shell without executing sign-in, then runs once only after an explicit press', async () => {
  await render();
  expect(transport.commands.sendTerminalCreate).toHaveBeenCalledOnce();
  expect(transport.commands.sendTerminalCreate.mock.calls[0]).toEqual([90, 12, expect.any(String), undefined, expect.any(String), true]);
  expect(transport.commands.sendTerminalInput).not.toHaveBeenCalled();
  expect(button('Run sign-in command').disabled).toBe(true);
  await act(async () => transport.callbacks.onTerminalCreated?.('cortex-dash-other', 'wrong-owner'));
  expect(document.querySelector('[aria-label="Sign-in terminal"]')).toBeNull();
  await attach();
  expect(transport.commands.sendTerminalInput).not.toHaveBeenCalled();
  const run = button('Run sign-in command');
  await act(async () => { run.click(); run.click(); });
  expect(transport.commands.sendTerminalInput).toHaveBeenCalledExactlyOnceWith('cortex-dash-owned', 'codex login\r');
  expect(transport.focus).toHaveBeenCalledOnce();
  expect(document.querySelector('[data-input-locked="false"]')).not.toBeNull();
});
it('filters other terminal output, never reruns on reconnect, and cleans up only its own shell', async () => {
  const { props } = await render(); await attach();
  await act(async () => button('Run sign-in command').click());
  await act(async () => transport.callbacks.onTerminalData?.('other-session', 'Unrelated output'));
  expect(transport.write).not.toHaveBeenCalled();
  await act(async () => transport.callbacks.onTerminalData?.('cortex-dash-owned', 'Login instructions'));
  expect(transport.write).toHaveBeenCalledExactlyOnceWith('Login instructions');
  transport.commands.isConnected = false;
  await act(async () => root.render(createElement(OnboardingSignInTerminal, props)));
  expect(document.querySelector('[data-input-locked="true"]')).not.toBeNull();
  transport.commands.isConnected = true;
  await act(async () => root.render(createElement(OnboardingSignInTerminal, props)));
  expect(transport.commands.sendTerminalInput).toHaveBeenCalledOnce();
  expect(transport.commands.sendTerminalCreate).toHaveBeenCalledOnce();
  act(() => root.unmount());
  expect(transport.commands.sendAgentKill).toHaveBeenCalledExactlyOnceWith('cortex-dash-owned', 'SIGTERM');
});
it('keeps the copy fallback available when terminal creation fails', async () => {
  await render();
  await act(async () => transport.callbacks.onTerminalError?.('', 'Unavailable'));
  expect(document.body.textContent).toContain('Copy the command above');
  expect(button('Run sign-in command').disabled).toBe(true);
  expect(transport.commands.sendTerminalInput).not.toHaveBeenCalled();
});
