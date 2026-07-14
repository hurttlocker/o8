#!/usr/bin/env node
/**
 * sync-reports — pull the private intake channel into the local report ledger.
 *
 * WHY THIS HAS TO EXIST (the bug it fixes):
 *
 * `recordReport()` writes the ledger on the machine that FILED the report. When a
 * user hits ⌘⇧E, report FYPPHK lands in THEIR ~/.o8/feedback/reports.jsonl.
 * The maintainer's machine has never heard of it.
 *
 * So the maintainer fixes it, commits `Fixes-Report: FYPPHK`, and publish-fixed
 * runs on the MAINTAINER's box, reads the MAINTAINER's ledger, finds nothing, and
 * drops it: no #fixed post, no manifest entry, no receipt. The loop worked only
 * for bugs you reported to yourself — exactly backwards.
 *
 * Discord is already the durable store: the report embed carries the id, the
 * title, the reporter's handle and the version. This reconstructs the ledger from
 * it, so the maintainer's ledger becomes a MIRROR of the channel rather than a
 * purely local file. Idempotent — an id already present is left alone.
 *
 * The REPORTER's local ledger is unaffected and still correct: that's what the
 * in-app receipt joins against.
 *
 * Usage:
 *   npm run sync:reports            # pull, then print what's new
 *   npm run sync:reports -- --dry-run
 *
 * Token (a bot token — NEVER bake this into the app):
 *   O8_DISCORD_BOT_TOKEN env, else ~/.o8/discord-bot-token (mode 0600).
 * Channel: O8_FEEDBACK_CHANNEL_ID env, else the o8 private intake channel.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { feedbackDir, ledgerPath, readLedger } from './lib/fixed-reports.mjs';
import path from 'node:path';
import os from 'node:os';

const DRY_RUN = process.argv.includes('--dry-run');
const CHANNEL_ID = process.env.O8_FEEDBACK_CHANNEL_ID?.trim() || '1511754310575460672';
const PAGE_LIMIT = 100;
const MAX_PAGES = 20; // 2000 messages — far past anything we'd need to backfill

function resolveBotToken() {
  const fromEnv = process.env.O8_DISCORD_BOT_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const file = path.join(process.env.O8_DATA_DIR || path.join(os.homedir(), '.o8'), 'discord-bot-token');
    const raw = readFileSync(file, 'utf8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

/**
 * Reconstruct a ledger record from a report embed.
 *
 * Returns null for a pre-id report (the `o8 beta · one-way intake` footer — those
 * predate report ids, so they can never be receipted) and for anything that isn't
 * one of our report cards.
 */
export function parseReportEmbed(message) {
  const embed = message?.embeds?.[0];
  if (!embed) return null;

  // The id is in BOTH the footer ("o8 · report FYPPHK · private intake") and the
  // title ("[BUG] FYPPHK · ..."). Prefer the footer — the title gets truncated at
  // Discord's 256-char cap and a long report could clip it.
  const fromFooter = /report\s+([2-9A-HJ-NP-TV-Z]{6})\b/i.exec(embed.footer?.text ?? '');
  const fromTitle = /^\[(?:BUG|REQUEST)\]\s+([2-9A-HJ-NP-TV-Z]{6})\s+·/i.exec(embed.title ?? '');
  const id = (fromFooter?.[1] ?? fromTitle?.[1])?.toUpperCase();
  if (!id) return null; // legacy pre-id report — nothing to receipt

  const title = /^\[(?:BUG|REQUEST)\]\s+[2-9A-HJ-NP-TV-Z]{6}\s+·\s+(.*)$/is.exec(embed.title ?? '')?.[1]?.trim();
  if (!title) return null;

  const field = (name) => embed.fields?.find((f) => f.name === name)?.value?.trim() ?? '';
  const reporterRaw = field('Reported by');
  const reporter = reporterRaw && reporterRaw !== 'anonymous'
    ? reporterRaw.replace(/^@/, '')
    : null;

  const stamped = Date.parse(field('Timestamp'));
  const ts = Number.isFinite(stamped) ? stamped : Date.parse(message.timestamp);

  return {
    id,
    ts: Number.isFinite(ts) ? ts : Date.now(),
    category: /^\[REQUEST\]/i.test(embed.title ?? '') ? 'request' : 'bug',
    title,
    reporter,
    version: field('Version') || 'unknown',
  };
}

async function fetchChannel(token) {
  const messages = [];
  let before = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`);
    url.searchParams.set('limit', String(PAGE_LIMIT));
    if (before) url.searchParams.set('before', before);

    const response = await fetch(url, { headers: { Authorization: `Bot ${token}` } });
    if (!response.ok) {
      throw new Error(`Discord returned HTTP ${response.status}: ${(await response.text()).slice(0, 160)}`);
    }
    const batch = await response.json();
    if (!Array.isArray(batch) || batch.length === 0) break;

    messages.push(...batch);
    before = batch[batch.length - 1].id;
    if (batch.length < PAGE_LIMIT) break;
  }
  return messages;
}

export async function syncReports({ dryRun = false } = {}) {
  const token = resolveBotToken();
  if (!token) {
    throw new Error(
      'No Discord bot token. Set O8_DISCORD_BOT_TOKEN, or write it to ~/.o8/discord-bot-token (chmod 600).',
    );
  }

  const messages = await fetchChannel(token);
  const known = readLedger();

  const fresh = [];
  let legacy = 0;
  for (const message of messages) {
    const record = parseReportEmbed(message);
    if (!record) { legacy += 1; continue; }
    if (known.has(record.id)) continue;
    // Guard the same channel being paged twice.
    if (fresh.some((r) => r.id === record.id)) continue;
    fresh.push(record);
  }

  // Oldest first, so the ledger reads chronologically like a locally-filed one.
  fresh.sort((a, b) => a.ts - b.ts);

  if (fresh.length > 0 && !dryRun) {
    const dir = feedbackDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(ledgerPath(), fresh.map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf8');
  }

  return { fresh, legacy, scanned: messages.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncReports({ dryRun: DRY_RUN })
    .then(({ fresh, legacy, scanned }) => {
      console.log(`${DRY_RUN ? '[dry-run] ' : ''}Scanned ${scanned} message(s); imported ${fresh.length} report(s).`);
      for (const r of fresh) {
        console.log(`  ${r.id}  ${r.reporter ? `@${r.reporter}` : 'anonymous'}  v${r.version}  ${r.title}`);
      }
      if (legacy > 0) {
        console.log(`\n  (${legacy} message(s) carry no report id — pre-id reports can never be receipted.)`);
      }
    })
    .catch((err) => {
      console.error('✗ sync-reports failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
