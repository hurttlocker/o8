/**
 * o8's own Messages receiver for Symon (#3454): on macOS, o8 reads new
 * messages from the handles the operator authorized and answers them through
 * the same inbound path an external connector uses, so a user needs no other
 * software to text Symon.
 *
 * Off until the operator turns it on. The first enabled pass records the
 * newest message as the starting point, so history is never answered. Each
 * message is answered at most once: its id is recorded before the reply is
 * sent, and a restart never replays a recorded message.
 */

import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { ChatDbError, defaultChatDbPath, latestRowId, readAuthorizedMessages, type ChatDbMessage } from './chat-db';

export type MessagesReceiverState = 'off' | 'unsupported' | 'missing_permission' | 'unavailable' | 'listening';

export interface MessagesReceiverFile {
  enabled: boolean;
  /** Authorized senders, as Messages stores them: `+15555550100` or an email address. */
  handles: string[];
  /** Newest message row already handled; null until the first enabled pass. */
  cursor: number | null;
  /** Recent message ids already answered, newest last. */
  answered: string[];
}

export interface MessagesReceiverStatus {
  state: MessagesReceiverState;
  enabled: boolean;
  handles: string[];
}

export interface InboundMessage {
  eventId: string;
  conversationId: string;
  messageId: string;
  sender: string;
  recipient: string;
  text: string;
  context: string;
}

export interface MessagesReceiverDeps {
  statePath?: string;
  chatDbPath?: string;
  platform?: NodeJS.Platform;
  /** Answers one message; null when no answer is ready yet. */
  answer: (message: InboundMessage) => Promise<string | null>;
  send: (handle: string, text: string) => Promise<void>;
}

const HANDLE = /^(?:\+[1-9]\d{6,14}|[^\s@]{1,64}@[^\s@]{1,190})$/;
const MAX_HANDLES = 20;
const MAX_ANSWERED = 500;

export function isMessagesHandle(value: unknown): value is string {
  return typeof value === 'string' && HANDLE.test(value);
}

export function messagesReceiverPath(): string {
  return join(getDataDir(), 'symon', 'messages-receiver.json');
}

export function readMessagesReceiverFile(path = messagesReceiverPath()): MessagesReceiverFile {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<MessagesReceiverFile>;
    return {
      enabled: parsed.enabled === true,
      handles: Array.isArray(parsed.handles) ? parsed.handles.filter(isMessagesHandle).slice(0, MAX_HANDLES) : [],
      cursor: typeof parsed.cursor === 'number' && Number.isSafeInteger(parsed.cursor) && parsed.cursor >= 0 ? parsed.cursor : null,
      answered: Array.isArray(parsed.answered) ? parsed.answered.filter((id): id is string => typeof id === 'string').slice(-MAX_ANSWERED) : [],
    };
  } catch {
    return { enabled: false, handles: [], cursor: null, answered: [] };
  }
}

export function writeMessagesReceiverFile(file: MessagesReceiverFile, path = messagesReceiverPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.messages-receiver.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify({ ...file, answered: file.answered.slice(-MAX_ANSWERED) }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}

/**
 * Turns the receiver on or off and sets its handles. Turning it on, or changing
 * the handles, starts again from the newest message.
 */
export function configureMessagesReceiver(input: { enabled: boolean; handles: string[] }, path = messagesReceiverPath()): MessagesReceiverFile {
  const current = readMessagesReceiverFile(path);
  const handles = [...new Set(input.handles.filter(isMessagesHandle))].slice(0, MAX_HANDLES);
  const restart = input.enabled && (!current.enabled || handles.join('\n') !== current.handles.join('\n'));
  const next = { ...current, enabled: input.enabled, handles, cursor: restart ? null : current.cursor };
  writeMessagesReceiverFile(next, path);
  return next;
}

export class MessagesReceiver {
  private state: MessagesReceiverState = 'off';
  private readonly statePath: string;
  private readonly chatDbPath: string;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly deps: MessagesReceiverDeps) {
    this.statePath = deps.statePath ?? messagesReceiverPath();
    this.chatDbPath = deps.chatDbPath ?? defaultChatDbPath();
    this.platform = deps.platform ?? process.platform;
  }

  status(): MessagesReceiverStatus {
    const file = readMessagesReceiverFile(this.statePath);
    return { state: file.enabled ? this.state : 'off', enabled: file.enabled, handles: file.handles };
  }

  /** One pass. Returns the receiver state after it. */
  async tick(): Promise<MessagesReceiverState> {
    let file = readMessagesReceiverFile(this.statePath);
    if (!file.enabled) return (this.state = 'off');
    if (this.platform !== 'darwin') return (this.state = 'unsupported');
    let messages: ChatDbMessage[];
    try {
      if (file.cursor === null) {
        writeMessagesReceiverFile({ ...file, cursor: latestRowId(this.chatDbPath) }, this.statePath);
        return (this.state = 'listening');
      }
      messages = readAuthorizedMessages(file.handles, file.cursor, this.chatDbPath);
    } catch (error) {
      return (this.state = error instanceof ChatDbError ? error.reason : 'unavailable');
    }
    this.state = 'listening';
    for (const message of messages) {
      file = readMessagesReceiverFile(this.statePath);
      if (!file.enabled || !file.handles.includes(message.handle)) break;
      if (!file.answered.includes(message.guid) && message.text) {
        const reply = await this.deps.answer({
          eventId: `imessage:${message.guid}`,
          conversationId: `imessage:direct:${message.handle}`,
          messageId: message.guid,
          sender: message.handle,
          recipient: 'imessage',
          text: message.text,
          context: '',
        });
        // Not answered yet: keep the cursor so the next pass asks again.
        if (reply === null) return this.state;
        file = readMessagesReceiverFile(this.statePath);
        writeMessagesReceiverFile({ ...file, answered: [...file.answered, message.guid] }, this.statePath);
        try {
          await this.deps.send(message.handle, reply);
        } catch {
          // Recorded as answered before sending, so a failed send is never repeated.
        }
      }
      file = readMessagesReceiverFile(this.statePath);
      writeMessagesReceiverFile({ ...file, cursor: Math.max(file.cursor ?? 0, message.rowId) }, this.statePath);
    }
    return this.state;
  }
}

const SEND_SCRIPT = `on run argv
  set targetHandle to item 1 of argv
  set messageText to item 2 of argv
  tell application "Messages"
    set targetService to first service whose service type = iMessage
    send messageText to participant targetHandle of targetService
  end tell
end run`;

/** Sends through Messages. The handle and text travel as arguments, never inside the script. */
export function sendWithMessages(handle: string, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-e', SEND_SCRIPT, handle, text], { timeout: 30_000 }, (error) => {
      if (error) reject(new Error('Messages could not send the reply.'));
      else resolve();
    });
  });
}
