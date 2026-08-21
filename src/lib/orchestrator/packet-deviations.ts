/**
 * Worker deviations log (#1490).
 *
 * Every worker brief now carries a standing clause telling the agent to keep an
 * ignored, packet-scoped `implementation-notes.md` artifact and log any forced
 * departure from the plan under a `## Deviations` heading. When a packet reaches
 * review we read that file, extract the Deviations section, and surface it ABOVE
 * the diff so the human (and the auto-reviewer) sees where the worker went off-plan.
 *
 * This module is pure + fs-only (no store / mission-state imports) so the
 * parser is unit-testable in isolation.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Legacy tracked root filename. Merge governance ignores this path as worker noise. */
export const IMPLEMENTATION_NOTES_FILENAME = 'implementation-notes.md';
const PACKET_ARTIFACTS_DIR = join('.o8', 'packet-artifacts');

function safePacketSegment(packetId: string): string {
  return packetId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 160) || 'unassigned';
}

/** Ignored, worktree-relative notes path unique to one packet. */
export function packetImplementationNotesPath(packetId: string): string {
  return join(PACKET_ARTIFACTS_DIR, safePacketSegment(packetId), IMPLEMENTATION_NOTES_FILENAME);
}

/**
 * Cap on how much of implementation-notes.md we read. A bloated notes file would
 * otherwise flow verbatim into the reviewer LLM prompt and persist on the packet;
 * the Deviations section lives at the top, so a leading slice is sufficient.
 */
export const MAX_NOTES_BYTES = 64 * 1024;

/**
 * The standing brief clause. Rendered as its own section in every packet prompt
 * (see `buildPacketPrompt`). Kept here so the wording is asserted by a unit
 * test and never drifts silently.
 */
export function buildDeviationsClause(packetId: string): string {
  return `Keep worker notes at ${packetImplementationNotesPath(packetId)} (an ignored, per-packet artifact), not at the repository root. If an edge case forces you off the plan: `
  + `pick the conservative option, log it under a '## Deviations' heading `
  + `(one bullet per deviation: what + one line why), and keep going.`;
}

export interface PacketDeviations {
  /** The raw Deviations section body, verbatim (heading stripped). */
  raw: string;
  /** One entry per bullet under the heading. */
  entries: string[];
  /** ISO timestamp the file was read at review time. */
  capturedAt: string;
}

/**
 * Extract the `## Deviations` section from an implementation-notes.md body.
 * Returns null when there is no such heading. An empty section (heading present
 * but no bullets) returns `{ raw: '', entries: [] }` so callers can distinguish
 * "no notes file / no heading" (null) from "worker asserted no deviations".
 */
export function parseDeviations(content: string): { raw: string; entries: string[] } | null {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const headingIndex = lines.findIndex((line) => /^#{1,6}\s+deviations\s*$/i.test(line.trim()));
  if (headingIndex === -1) {
    return null;
  }

  const headingLevel = (lines[headingIndex].match(/^#+/)?.[0].length) ?? 2;
  const sectionLines: string[] = [];
  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    const headingMatch = line.trim().match(/^(#{1,6})\s+/);
    // Stop at the next heading of the same or higher level.
    if (headingMatch && headingMatch[1].length <= headingLevel) {
      break;
    }
    sectionLines.push(line);
  }

  const raw = sectionLines.join('\n').trim();
  const entries = sectionLines
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, '').trim())
    .filter(Boolean);

  return { raw, entries };
}

/**
 * Read + parse one packet's ignored notes artifact. Returns null when the file
 * is absent, unreadable, or has no Deviations heading — callers render the
 * asserted "No deviations reported" empty state in that case.
 */
export function readPacketDeviations(
  worktreePath: string | null | undefined,
  packetId: string,
): PacketDeviations | null {
  const dir = worktreePath?.trim();
  if (!dir) {
    return null;
  }
  let content: string;
  try {
    content = readFileSync(join(dir, packetImplementationNotesPath(packetId)), 'utf8');
  } catch {
    return null;
  }
  // Cap the read so a runaway notes file can't bloat the review prompt / packet.
  if (content.length > MAX_NOTES_BYTES) {
    content = content.slice(0, MAX_NOTES_BYTES);
  }
  const parsed = parseDeviations(content);
  if (!parsed) {
    return null;
  }
  return { raw: parsed.raw, entries: parsed.entries, capturedAt: new Date().toISOString() };
}
