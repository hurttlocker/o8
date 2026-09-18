/**
 * The `compaction` label for the calibration replay (#2465, #2438).
 *
 * Reads the recorded compaction scorer output from the orchestrator archives
 * (`orchestrator-archives/*.json`, written by auto-compaction) and scores it
 * against a label derived from stored data with no human labels: a compacted
 * entry is needed (positive) when an identifier from it reappears in a turn
 * after the compaction point in the same thread. Identifiers are file paths,
 * packet and lane ids, issue or PR numbers (`#123`), and backtick-quoted
 * symbols. Later turns are the thread's current messages plus the turns of its
 * later archives, with compaction entries excluded (their summaries restate
 * the segment). Reads files only; sends nothing.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const PATH_RE = /(?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z0-9]{1,6}\b/g;
const FILE_RE = /\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|rs|py|sh|yml|yaml|toml|css|sql)\b/g;
const ID_RE = /\b(?:pkt|packet|lane)[-_][A-Za-z0-9][\w-]{2,}/g;
const ISSUE_RE = /(?<![\w&])#\d{2,}\b/g;
const SYMBOL_RE = /`([^`\s]{3,80})`/g;

const readJson = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
};

/** Text of a stored turn: its text plus tool names, arguments, and results. */
function turnText(turn) {
  const text = typeof turn?.text === 'string' ? turn.text : typeof turn?.content === 'string' ? turn.content : '';
  const tools = Array.isArray(turn?.toolCalls)
    ? turn.toolCalls.map((tool) => [tool?.name, tool?.args ? JSON.stringify(tool.args) : '', typeof tool?.result === 'string' ? tool.result : ''].join(' '))
    : [];
  return [text, ...tools].join('\n');
}

/** Identifiers in a text, deduplicated. */
export function extractIdentifiers(text) {
  const found = new Set();
  for (const re of [PATH_RE, FILE_RE, ID_RE, ISSUE_RE]) for (const match of text.matchAll(re)) found.add(match[0]);
  for (const match of text.matchAll(SYMBOL_RE)) found.add(match[1]);
  return [...found];
}

/**
 * One row per scored entry: `{ p, y, packet, entryId, identifiers }`, where
 * `p` is the recorded probability the entry is needed and `packet` is the
 * archive ref (one leave-one-out fold per compaction).
 */
export function labelCompaction(archives, threads) {
  const byTab = new Map();
  for (const archive of archives) {
    const list = byTab.get(archive.tabId) ?? [];
    list.push(archive);
    byTab.set(archive.tabId, list);
  }
  const rows = [];
  const notes = { archivesRead: archives.length, scored: 0, withoutScorer: 0, withoutLaterTurns: 0, entriesWithoutIdentifiers: 0 };
  for (const archive of archives) {
    const scores = archive.scorer?.scores;
    if (!scores || typeof scores !== 'object') { notes.withoutScorer += 1; continue; }
    const compactedAt = Date.parse(archive.archivedAt);
    const later = new Map();
    const candidates = [...(threads.get(archive.tabId) ?? []), ...(byTab.get(archive.tabId) ?? []).flatMap((other) => other.turns ?? [])];
    for (const turn of candidates) {
      if (!turn || typeof turn.id !== 'string' || turn.type === 'compaction') continue;
      if (typeof turn.timestamp === 'number' && turn.timestamp > compactedAt) later.set(turn.id, turnText(turn));
    }
    if (later.size === 0) { notes.withoutLaterTurns += 1; continue; }
    notes.scored += 1;
    const laterText = [...later.values()].join('\n');
    for (const turn of archive.turns ?? []) {
      const p = scores[turn.id];
      if (typeof p !== 'number') continue;
      const identifiers = extractIdentifiers(turnText(turn));
      if (identifiers.length === 0) notes.entriesWithoutIdentifiers += 1;
      const y = identifiers.some((identifier) => laterText.includes(identifier)) ? 1 : 0;
      rows.push({ p, y, packet: archive.ref, entryId: turn.id, identifiers });
    }
  }
  return { rows, notes };
}

/** Archives and thread messages from a data dir. Missing dirs read as empty. */
export function loadCompactionHistory(dataDir) {
  const archiveDir = path.join(dataDir, 'orchestrator-archives');
  const historyDir = path.join(dataDir, 'chat-history');
  let files = [];
  try { files = readdirSync(archiveDir).filter((file) => file.endsWith('.json')); } catch { /* no archives yet */ }
  const archives = files.map((file) => ({ ref: file, ...(readJson(path.join(archiveDir, file)) ?? {}) }))
    .filter((archive) => Array.isArray(archive.turns) && typeof archive.archivedAt === 'string');
  const threads = new Map();
  for (const tabId of new Set(archives.map((archive) => archive.tabId).filter((id) => typeof id === 'string'))) {
    const payload = readJson(path.join(historyDir, `${tabId}.json`));
    threads.set(tabId, Array.isArray(payload?.messages) ? payload.messages : []);
  }
  return { archives, threads };
}
