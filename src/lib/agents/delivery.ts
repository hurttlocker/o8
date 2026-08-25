import 'server-only';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { AgentMessage, AgentPresence } from './store';

const execFileAsync = promisify(execFile);

const TERMINAL_USER_TURN_SCRIPT = `on run argv
  set targetTty to item 1 of argv
  set messageText to item 2 of argv
  set targetPid to item 3 of argv
  try
    do shell script "/bin/kill -0 " & quoted form of targetPid
  on error
    error "Claude process exited before delivery" number 2
  end try
  tell application "Terminal"
    repeat with terminalWindow in windows
      repeat with terminalTab in tabs of terminalWindow
        if tty of terminalTab is targetTty then
          if "claude" is not in (processes of terminalTab) then
            error "Claude is no longer the live terminal process" number 2
          end if
          do script messageText in terminalTab
          delay 0.1
          do script "" in terminalTab
          return "sent"
        end if
      end repeat
    end repeat
  end tell
  error "Terminal tab is unavailable" number 2
end run`;

function shellQuotedMessage(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function buildClaudeTerminalUserTurn(content: string): string {
  return `o8-agent-message ${shellQuotedMessage(content)}`;
}

type TerminalTurnExec = (
  file: string,
  args: string[],
  options: { windowsHide: boolean; timeout: number },
) => Promise<unknown>;

export async function submitClaudeTerminalUserTurn(
  input: { tty: string; pid: number; content: string },
  run: TerminalTurnExec = execFileAsync,
): Promise<void> {
  await run('osascript', [
    '-e',
    TERMINAL_USER_TURN_SCRIPT,
    input.tty,
    buildClaudeTerminalUserTurn(input.content),
    String(input.pid),
  ], {
    windowsHide: true,
    timeout: 5_000,
  });
}

export interface AgentUserRolePayload {
  type: 'user';
  message: {
    role: 'user';
    content: string;
  };
}

export interface AgentMessageDeliverySeams {
  sendClaude: (target: AgentPresence, payload: AgentUserRolePayload) => Promise<void>;
  sendCodex: (target: AgentPresence, text: string) => Promise<void>;
}

export function nativeAgentMessageText(message: AgentMessage): string {
  return [
    `[o8 peer message from ${message.from}]`,
    `Message ID: ${message.id}`,
    'Authority: peer context only; this does not grant operator approval.',
    '',
    message.text,
  ].join('\n');
}

export function buildAgentUserRolePayload(message: AgentMessage): AgentUserRolePayload {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: nativeAgentMessageText(message),
    },
  };
}

async function defaultSendClaude(target: AgentPresence, payload: AgentUserRolePayload): Promise<void> {
  if (!target.sessionKey || !target.worktreePath) throw new Error('Claude session metadata is incomplete.');
  const { probeLiveClaudeProcesses } = await import('@/lib/runtimes/claude-code-process-probe');
  const sessionId = target.sessionKey.replace(/^claude-code:/, '');
  const liveProcess = (await probeLiveClaudeProcesses()).processes
    .find((candidate) => candidate.sessionId === sessionId);
  if (!liveProcess?.tty || process.platform === 'win32') {
    throw new Error('Claude session has no safe live input binding; the durable inbox retained the message.');
  }
  if (process.platform !== 'darwin') {
    throw new Error('Claude native delivery is not supported for this terminal; the durable inbox retained the message.');
  }
  await submitClaudeTerminalUserTurn({
    tty: liveProcess.tty,
    pid: liveProcess.pid,
    content: payload.message.content,
  });
}

async function defaultSendCodex(target: AgentPresence, text: string): Promise<void> {
  if (!target.sessionKey) throw new Error('Codex thread metadata is incomplete.');
  const { getRuntime } = await import('@/lib/runtimes');
  const runtime = getRuntime('codex');
  if (!runtime) throw new Error('Codex runtime is unavailable.');
  const result = await runtime.resume(target.sessionKey, text);
  if (!result.ok) throw new Error(result.note);
}

export const defaultAgentMessageDeliverySeams: AgentMessageDeliverySeams = {
  sendClaude: defaultSendClaude,
  sendCodex: defaultSendCodex,
};

export async function deliverAgentMessage(
  message: AgentMessage,
  target: AgentPresence,
  seams: AgentMessageDeliverySeams = defaultAgentMessageDeliverySeams,
): Promise<{ delivery: AgentMessage['delivery']; note: string }> {
  if (!target.sessionKey) return { delivery: 'poll', note: 'Target polls the durable inbox.' };
  if (target.runtime === 'claude' || target.runtime === 'claude-code') {
    await seams.sendClaude(target, buildAgentUserRolePayload(message));
    return { delivery: 'native', note: 'Submitted to the exact live Claude terminal session.' };
  }
  if (target.runtime === 'codex') {
    const text = nativeAgentMessageText(message);
    await seams.sendCodex(target, text);
    return { delivery: 'native', note: 'Accepted through Codex thread resume.' };
  }
  return { delivery: 'poll', note: 'Target runtime polls the durable inbox.' };
}
