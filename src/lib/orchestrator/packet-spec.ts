/**
 * Packet spec storage — closes #773.
 *
 * Each packet can have a free-form `spec.md` document the operator edits
 * inline in the Mission panel. The orchestrator re-reads the file at dispatch
 * time so the agent always sees the *current* content, not whatever was
 * captured when the packet was created. This is the visible UI for
 * Augment Intent's "living spec" pattern, with o8's governance moat:
 * edits never reach an in-flight agent — only NEW dispatches pick them up.
 *
 * Storage: `<dataDir>/packet-specs/<packet-id>.md`. One file per packet, no
 * SQLite migration. Durable across restarts because the data dir survives the
 * app cycle. Returning JSON is intentional (vs raw .md) so the API can carry
 * `updatedAt` alongside the content without parsing front-matter.
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

const SPEC_DIR_NAME = 'packet-specs';
const MAX_SPEC_BYTES = 64 * 1024; // 64 KB. A spec longer than this should be a doc, not a packet brief.
const PACKET_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export interface PacketSpecRecord {
  /** Markdown body the operator typed. Empty string when no spec exists. */
  content: string;
  /** ISO timestamp of the most recent successful write, or null if no spec exists. */
  updatedAt: string | null;
}

function getSpecDir(): string {
  return join(getDataDir(), SPEC_DIR_NAME);
}

function getSpecPath(packetId: string): string {
  if (!PACKET_ID_PATTERN.test(packetId)) {
    throw new Error('Invalid packet id.');
  }
  return join(getSpecDir(), `${packetId}.md`);
}

/**
 * Read the spec for a packet. Returns an empty record (`content=''`,
 * `updatedAt=null`) when the file doesn't exist — callers shouldn't need to
 * handle ENOENT manually.
 */
export async function readPacketSpec(packetId: string): Promise<PacketSpecRecord> {
  const path = getSpecPath(packetId);
  try {
    const [content, info] = await Promise.all([
      readFile(path, 'utf8'),
      stat(path),
    ]);
    return {
      content,
      updatedAt: info.mtime.toISOString(),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { content: '', updatedAt: null };
    }
    throw error;
  }
}

/**
 * Write the spec for a packet. Trims trailing whitespace and creates the
 * parent directory on first use. Returns the new `updatedAt` so the UI can
 * render the "Updated Xs ago" stamp without re-reading the file.
 */
export async function writePacketSpec(
  packetId: string,
  content: string,
): Promise<{ updatedAt: string }> {
  const path = getSpecPath(packetId);
  const normalized = typeof content === 'string' ? content.replace(/\s+$/u, '') : '';
  if (Buffer.byteLength(normalized, 'utf8') > MAX_SPEC_BYTES) {
    throw new Error(`Spec exceeds ${MAX_SPEC_BYTES} bytes — break into linked docs.`);
  }

  await mkdir(getSpecDir(), { recursive: true });
  await writeFile(path, normalized, 'utf8');
  const info = await stat(path);
  return { updatedAt: info.mtime.toISOString() };
}

/**
 * Build the prompt-side <spec> block. Returns null when no spec exists or the
 * stored body is whitespace-only — `buildPacketPrompt` filters falsy entries
 * before joining, so a null short-circuits cleanly.
 *
 * The wrapper labels the section explicitly so weaker models can scope-check
 * the request against the operator's intent. Truncation is intentional: a
 * 64 KB spec would dwarf the packet brief; we cap at 8 KB for the prompt
 * window. Operators with longer specs see a "...truncated" footer.
 */
const PROMPT_SPEC_LIMIT = 8_192;
export async function buildPacketSpecPromptSection(packetId: string): Promise<string | null> {
  const record = await readPacketSpec(packetId);
  const body = record.content.trim();
  if (!body) {
    return null;
  }

  const truncated = body.length > PROMPT_SPEC_LIMIT
    ? `${body.slice(0, PROMPT_SPEC_LIMIT)}\n\n[...spec truncated; full content visible in o8 UI]`
    : body;

  return [
    'Live spec (editable in the Mission panel — this is the operator\'s current intent):',
    truncated,
  ].join('\n');
}
