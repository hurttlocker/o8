import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { ensureV56ManagedSymonMessagesSchema } from '@/lib/db/v56-managed-symon-messages-migration';
import { ManagedSymonMessagesStore } from '@/lib/symon/managed-messages-store';
import { SymonBrain } from '@/lib/symon/durable/brain';
import { readAuthorizedMessages, textFromAttributedBody } from '@/lib/symon/messages-receiver/chat-db';
import {
  configureMessagesReceiver,
  MessagesReceiver,
  readMessagesReceiverFile,
  type InboundMessage,
} from '@/lib/symon/messages-receiver/receiver';

const h = vi.hoisted(() => ({ store: null as unknown }));
vi.mock('@/lib/symon/managed-messages-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/symon/managed-messages-store')>(),
  getManagedSymonMessagesStore: () => h.store,
}));
vi.mock('@/lib/mobile/symon-text-bridge-client', () => ({
  readSymonTextPlannerInfo: async () => { throw new Error('Symon text planner bridge is not mounted.'); },
  pollSymonTextTurn: async () => { throw new Error('unused'); },
}));

const OWNER = '+15555550100';
const STRANGER = '+15555550199';

let root: string;
let chatDbPath: string;
let statePath: string;
let chat: Database.Database;
let previousDataDir: string | undefined;

function createChatDb(path: string): Database.Database {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, style INTEGER);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, handle_id INTEGER, is_from_me INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    INSERT INTO handle (ROWID, id) VALUES (1, '${OWNER}'), (2, '${STRANGER}');
    INSERT INTO chat (ROWID, guid, chat_identifier, style) VALUES
      (1, 'iMessage;-;${OWNER}', '${OWNER}', 45),
      (2, 'iMessage;-;${STRANGER}', '${STRANGER}', 45),
      (3, 'iMessage;+;chat-group', 'chat-group', 43);
  `);
  return db;
}

let nextRow = 1;
function addMessage(input: { handle: 1 | 2; chat: 1 | 2 | 3; text: string | null; fromMe?: boolean; attributedBody?: Buffer }) {
  const row = nextRow++;
  chat.prepare('INSERT INTO message (ROWID, guid, text, attributedBody, handle_id, is_from_me) VALUES (?, ?, ?, ?, ?, ?)')
    .run(row, `GUID-${row}`, input.text, input.attributedBody ?? null, input.handle, input.fromMe ? 1 : 0);
  chat.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)').run(input.chat, row);
  return `GUID-${row}`;
}

function archivedString(text: string): Buffer {
  const bytes = Buffer.from(text, 'utf8');
  const length = bytes.length < 0x80 ? Buffer.from([bytes.length]) : Buffer.concat([Buffer.from([0x81]), Buffer.from([bytes.length & 0xff, bytes.length >> 8])]);
  return Buffer.concat([Buffer.from('\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString', 'latin1'),
    Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]), length, bytes, Buffer.from([0x86, 0x84])]);
}

function receiver(answer: (message: InboundMessage) => Promise<string | null>, send = vi.fn(async () => {})) {
  return { receiver: new MessagesReceiver({ statePath, chatDbPath, platform: 'darwin', answer, send }), send };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'o8-messages-receiver-'));
  chatDbPath = join(root, 'chat.db');
  statePath = join(root, 'data', 'symon', 'messages-receiver.json');
  chat = createChatDb(chatDbPath);
  nextRow = 1;
  previousDataDir = process.env.CORTEX_IDE_DATA_DIR;
  process.env.CORTEX_IDE_DATA_DIR = join(root, 'data');
});

afterEach(() => {
  chat.close();
  rmSync(root, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = previousDataDir;
  delete (globalThis as { __o8SymonBrain?: unknown }).__o8SymonBrain;
});

describe("o8's own Messages receiver (#3454)", () => {
  it('starts after existing history and answers only new messages from authorized handles', async () => {
    addMessage({ handle: 1, chat: 1, text: 'Old message before enabling' });
    configureMessagesReceiver({ enabled: true, handles: [OWNER] }, statePath);
    const answer = vi.fn(async (message: InboundMessage) => `Reply to ${message.text}`);
    const { receiver: first, send } = receiver(answer);

    expect(await first.tick()).toBe('listening');
    expect(answer).not.toHaveBeenCalled();

    const ownerGuid = addMessage({ handle: 1, chat: 1, text: 'What is next?' });
    addMessage({ handle: 2, chat: 2, text: 'Stranger text' });
    addMessage({ handle: 1, chat: 1, text: 'Sent from this Mac', fromMe: true });
    addMessage({ handle: 1, chat: 3, text: 'Group text' });
    await first.tick();

    expect(answer).toHaveBeenCalledTimes(1);
    expect(answer.mock.calls[0][0]).toEqual({
      eventId: `imessage:${ownerGuid}`,
      conversationId: `imessage:direct:${OWNER}`,
      messageId: ownerGuid,
      sender: OWNER,
      recipient: 'imessage',
      text: 'What is next?',
      context: '',
    });
    expect(send).toHaveBeenCalledExactlyOnceWith(OWNER, 'Reply to What is next?');
    // The cursor follows the newest answered row; rows the query never returns stay behind it unread.
    expect(readMessagesReceiverFile(statePath).cursor).toBe(Number(ownerGuid.slice('GUID-'.length)));
  });

  it('never reads text from unauthorized handles, from this Mac or from group chats', () => {
    addMessage({ handle: 2, chat: 2, text: 'Stranger text' });
    addMessage({ handle: 1, chat: 1, text: 'Mine', fromMe: true });
    addMessage({ handle: 1, chat: 3, text: 'Group text' });
    addMessage({ handle: 1, chat: 1, text: 'Allowed' });

    expect(readAuthorizedMessages([OWNER], 0, chatDbPath).map((message) => message.text)).toEqual(['Allowed']);
    expect(readAuthorizedMessages([], 0, chatDbPath)).toEqual([]);
  });

  it('does not answer a message again after a restart', async () => {
    configureMessagesReceiver({ enabled: true, handles: [OWNER] }, statePath);
    await receiver(async () => 'unused').receiver.tick();
    addMessage({ handle: 1, chat: 1, text: 'Once only' });
    const firstSend = vi.fn(async () => {});
    await receiver(async () => 'Answered', firstSend).receiver.tick();

    const restarted = receiver(async () => 'Answered again');
    await restarted.receiver.tick();

    expect(firstSend).toHaveBeenCalledTimes(1);
    expect(restarted.send).not.toHaveBeenCalled();
  });

  it('keeps a message until its answer is ready and never resends after a failed send', async () => {
    configureMessagesReceiver({ enabled: true, handles: [OWNER] }, statePath);
    await receiver(async () => 'unused').receiver.tick();
    const guid = addMessage({ handle: 1, chat: 1, text: 'Slow question' });

    const pending = receiver(async () => null);
    await pending.receiver.tick();
    expect(pending.send).not.toHaveBeenCalled();
    expect(readMessagesReceiverFile(statePath).answered).not.toContain(guid);

    const failing = vi.fn(async () => { throw new Error('Messages could not send the reply.'); });
    await receiver(async () => 'Ready now', failing).receiver.tick();
    const after = receiver(async () => 'Ready now');
    await after.receiver.tick();

    expect(failing).toHaveBeenCalledTimes(1);
    expect(after.send).not.toHaveBeenCalled();
    expect(readMessagesReceiverFile(statePath).answered).toContain(guid);
  });

  it('reads text kept only in the archived body', async () => {
    configureMessagesReceiver({ enabled: true, handles: [OWNER] }, statePath);
    await receiver(async () => 'unused').receiver.tick();
    addMessage({ handle: 1, chat: 1, text: null, attributedBody: archivedString('Archived hello') });
    const long = 'x'.repeat(300);
    addMessage({ handle: 1, chat: 1, text: null, attributedBody: archivedString(long) });
    const answer = vi.fn(async (message: InboundMessage) => `ok ${message.text.length}`);

    await receiver(answer).receiver.tick();

    expect(answer.mock.calls.map(([message]) => message.text)).toEqual(['Archived hello', long]);
    expect(textFromAttributedBody(Buffer.from('no marker'))).toBe('');
    expect(textFromAttributedBody(Buffer.concat([Buffer.from('NSString'), Buffer.from([1, 2, 3, 4, 5, 200])]))).toBe('');
  });

  it('reports a missing database without reading, and stays off until enabled', async () => {
    const answer = vi.fn(async () => 'unused');
    const off = new MessagesReceiver({ statePath, chatDbPath, platform: 'darwin', answer, send: vi.fn() });
    expect(await off.tick()).toBe('off');

    configureMessagesReceiver({ enabled: true, handles: [OWNER] }, statePath);
    const missing = new MessagesReceiver({ statePath, chatDbPath: join(root, 'missing', 'chat.db'), platform: 'darwin', answer, send: vi.fn() });
    expect(await missing.tick()).toBe('unavailable');
    const linux = new MessagesReceiver({ statePath, chatDbPath, platform: 'linux', answer, send: vi.fn() });
    expect(await linux.tick()).toBe('unsupported');
    expect(answer).not.toHaveBeenCalled();
  });

  it('answers through the shared inbound path on the built-in Pi brain', async () => {
    const sqlite = new Database(':memory:');
    ensureV56ManagedSymonMessagesSchema(sqlite);
    h.store = new ManagedSymonMessagesStore(sqlite);
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage('Hi from the built-in brain.')]);
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();
    const brain = await SymonBrain.open({ storagePath: join(root, 'data', 'symon', 'durable.sqlite'), models, model: { provider: model.provider, modelId: model.id } });
    (globalThis as { __o8SymonBrain?: Promise<SymonBrain> }).__o8SymonBrain = Promise.resolve(brain);
    try {
      const { answerThroughInbound } = await import('@/lib/symon/messages-receiver/loop');
      configureMessagesReceiver({ enabled: true, handles: [OWNER] }, statePath);
      await receiver(async () => 'unused').receiver.tick();
      addMessage({ handle: 1, chat: 1, text: 'Hello Symon' });
      const send = vi.fn(async () => {});

      await new MessagesReceiver({ statePath, chatDbPath, platform: 'darwin', answer: (message) => answerThroughInbound(message, 10_000), send }).tick();

      expect(send).toHaveBeenCalledExactlyOnceWith(OWNER, 'Hi from the built-in brain.');
      expect(await brain.transcript(`imessage:direct:${OWNER}`)).toHaveLength(2);
    } finally {
      await brain.close();
      sqlite.close();
    }
  });
});
