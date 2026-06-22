/**
 * /api/panel/o8-mission-summary — explains a just-completed mission to the
 * operator in plain language.
 *
 * The mission-complete status card carries only lightweight packet identity
 * ({id, title, referenceLabel}). When the operator opens the detail modal, it
 * POSTs that list here; we hydrate each packet from the `session_outcomes`
 * ledger (the agent's own summary + changed-file count + outcome) and run the
 * combined material through one of the free OpenRouter models — the same pool
 * the UpdateCard / scratch-chat summarizers use. Returns a short prose
 * paragraph plus the per-packet lines so the modal can render both.
 *
 * Read-only against the ledger, never throws (degrades to per-packet titles if
 * the ledger is empty or no OpenRouter key is configured). Gated as a
 * /api/panel/* route — loopback (the webview) passes automatically.
 */

import { NextRequest, NextResponse } from 'next/server';
import { desc, eq } from 'drizzle-orm';
import { resolveOpenRouterRoute } from '@/lib/cortex/qa/llm/inference-route';
import { getDb, sessionOutcomes } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SUMMARY_MODELS = [
  'poolside/laguna-m.1:free',
  'openai/gpt-oss-120b:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
];

const MAX_PACKETS = 12;
const SUMMARY_CLAMP = 320;

interface InputPacket {
  id?: string;
  title?: string;
  referenceLabel?: string;
}

interface PacketLine {
  referenceLabel?: string;
  title: string;
  outcome?: string | null;
  summary?: string | null;
  fileCount?: number;
}

function summaryModels() {
  const raw = process.env.O8_SCRATCH_OPENROUTER_MODELS?.trim()
    || process.env.O8_SCRATCH_OPENROUTER_MODEL?.trim()
    || '';
  if (!raw) return SUMMARY_MODELS;
  const configured = raw.split(',').map((item) => item.trim()).filter(Boolean);
  return configured.length > 0 ? configured : SUMMARY_MODELS;
}

function clamp(text: string, max: number) {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function parseFileCount(json: string | null | undefined): number {
  if (!json) return 0;
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

async function loadPacketLines(packets: InputPacket[]): Promise<PacketLine[]> {
  const db = getDb();
  const lines: PacketLine[] = [];

  for (const packet of packets.slice(0, MAX_PACKETS)) {
    const title = (packet.title ?? '').trim() || 'Untitled packet';
    const line: PacketLine = { title, referenceLabel: packet.referenceLabel?.trim() || undefined };
    const packetId = packet.id?.trim();

    if (db && packetId) {
      try {
        const rows = await db.select({
          outcome: sessionOutcomes.outcome,
          summary: sessionOutcomes.summary,
          changedFilesJson: sessionOutcomes.changedFilesJson,
        })
          .from(sessionOutcomes)
          .where(eq(sessionOutcomes.packetId, packetId))
          .orderBy(desc(sessionOutcomes.completedAt))
          .limit(1);
        const row = rows[0];
        if (row) {
          line.outcome = row.outcome ?? null;
          if (row.summary?.trim()) line.summary = clamp(row.summary, SUMMARY_CLAMP);
          line.fileCount = parseFileCount(row.changedFilesJson);
        }
      } catch {
        // Ledger is best-effort — degrade to the packet title alone.
      }
    }

    lines.push(line);
  }

  return lines;
}

async function summarizeMission(lines: PacketLine[], missionSummary: string | null): Promise<string | null> {
  const route = await resolveOpenRouterRoute();
  if (!route) return null;

  const material = lines.map((line, idx) => {
    const ref = line.referenceLabel ? `${line.referenceLabel} ` : '';
    const files = typeof line.fileCount === 'number' && line.fileCount > 0
      ? ` (${line.fileCount} file${line.fileCount === 1 ? '' : 's'} changed)`
      : '';
    const detail = line.summary ? `: ${line.summary}` : '';
    return `${idx + 1}. ${ref}${line.title}${files}${detail}`;
  }).join('\n');

  const messages = [
    {
      role: 'system',
      content: [
        'You are o8 explaining a just-completed engineering mission to the operator.',
        'Several work packets were reviewed and merged. Write ONE plain-language paragraph (2-4 short sentences, max ~70 words) describing what the work accomplished across the packets, as a whole.',
        'Write for a smart non-engineer: focus on the outcome and intent, not file names or jargon.',
        'No bullet points, no headings, no markdown — just prose.',
        'Never invent work that is not described in the packet list.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: missionSummary
        ? `Merged packets:\n${material}\n\nOrchestrator's mission summary: ${clamp(missionSummary, SUMMARY_CLAMP)}`
        : `Merged packets:\n${material}`,
    },
  ];

  for (const model of route.model ? [route.model] : summaryModels()) {
    try {
      const response = await fetch(route.url, {
        method: 'POST',
        headers: route.headers,
        body: JSON.stringify({ model, messages }),
      });
      if (!response.ok) continue;
      const parsed = JSON.parse(await response.text()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const summary = parsed.choices?.[0]?.message?.content?.trim();
      if (summary) return summary;
    } catch {
      // Try the next model in the free pool.
    }
  }

  return null;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null) as
      | { repoPath?: string | null; summary?: string | null; packets?: InputPacket[] }
      | null;

    const packets = Array.isArray(body?.packets)
      ? body!.packets.filter((packet): packet is InputPacket => Boolean(packet) && typeof packet.title === 'string')
      : [];

    if (packets.length === 0) {
      return NextResponse.json({ prose: null, packets: [] });
    }

    const lines = await loadPacketLines(packets);
    const missionSummary = typeof body?.summary === 'string' && body.summary.trim() ? body.summary.trim() : null;
    const prose = await summarizeMission(lines, missionSummary);

    return NextResponse.json({ prose, packets: lines });
  } catch (error) {
    return NextResponse.json({
      prose: null,
      packets: [],
      error: error instanceof Error ? error.message : 'Unable to summarize mission.',
    });
  }
}
