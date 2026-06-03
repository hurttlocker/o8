import { NextResponse, type NextRequest } from 'next/server';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { findRepoByLocalPath } from '@/lib/repos/registry';
import { getActiveProjectScopeForRepoSync } from '@/lib/repos/projects';
import { readIdeSurfaceState } from '@/lib/runtime/ide-surface-state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_WEBHOOK_URL = 'https://discord.com/api/webhooks/1511754353743233055/qVbE00fdbM741Z364P1R8d-UDF1r8h6R1VXEw10Fj-rqtzKc3NWdlBvU6XktYgGR8rlR';
const MESSAGE_LIMIT = 4000;
const DISCORD_DESCRIPTION_LIMIT = 4096;
const DISCORD_FIELD_VALUE_LIMIT = 1024;
const DISCORD_TITLE_LIMIT = 256;
const DISCORD_EMBED_TOTAL_LIMIT = 6000;

type FeedbackCategory = 'bug' | 'request';

interface FeedbackBody {
  category?: unknown;
  message?: unknown;
  route?: unknown;
  userAgent?: unknown;
}

interface ReportDiagnostics {
  version: string;
  osLabel: string;
  nodeVersion: string;
  route: string;
  userAgent: string;
  projectLabel: string | null;
  timestamp: string;
}

let cachedVersion: string | null = null;

function jsonError(error: string, status = 400) {
  return NextResponse.json({ ok: false, error }, { status });
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);
  return `${value.slice(0, maxLength - 3)}...`;
}

function readServerVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const raw = readFileSync(join(process.cwd(), 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    cachedVersion = typeof parsed.version === 'string' && parsed.version.trim()
      ? parsed.version.trim()
      : 'unknown';
  } catch {
    cachedVersion = 'unknown';
  }
  return cachedVersion;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function validateBody(body: FeedbackBody): { ok: true; category: FeedbackCategory; message: string; route: string; userAgent: string } | { ok: false; error: string } {
  const category = typeof body.category === 'string' ? body.category.trim().toLowerCase() : '';
  if (category !== 'bug' && category !== 'request') {
    return { ok: false, error: 'Choose Bug or Request before sending.' };
  }

  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) {
    return { ok: false, error: 'Add a short report before sending.' };
  }
  if (message.length > MESSAGE_LIMIT) {
    return { ok: false, error: `Report must be ${MESSAGE_LIMIT} characters or fewer.` };
  }

  return {
    ok: true,
    category,
    message,
    route: truncate(stringValue(body.route, 'unknown'), DISCORD_FIELD_VALUE_LIMIT),
    userAgent: truncate(stringValue(body.userAgent, 'unknown'), DISCORD_FIELD_VALUE_LIMIT),
  };
}

async function resolveProjectLabel(): Promise<string | null> {
  try {
    const surface = readIdeSurfaceState();
    const activeRepoPath = surface?.activeRepoPath ?? surface?.terminalRepoPaths[0] ?? null;
    const repo = activeRepoPath ? await findRepoByLocalPath(activeRepoPath) : null;
    const scope = getActiveProjectScopeForRepoSync(activeRepoPath);
    const projectName = scope.project.name.trim();
    const repoName = repo?.name?.trim() || null;

    if (projectName && repoName && projectName !== repoName) {
      return truncate(`${projectName} / ${repoName}`, DISCORD_FIELD_VALUE_LIMIT);
    }
    if (repoName) return truncate(repoName, DISCORD_FIELD_VALUE_LIMIT);
    if (projectName && projectName !== 'Workspace') return truncate(projectName, DISCORD_FIELD_VALUE_LIMIT);
  } catch {
    return null;
  }
  return null;
}

async function buildDiagnostics(route: string, userAgent: string): Promise<ReportDiagnostics> {
  const platform = os.platform();
  const release = os.release();
  const arch = os.arch();
  return {
    version: readServerVersion(),
    osLabel: `${platform} ${release} ${arch}`,
    nodeVersion: process.version,
    route,
    userAgent,
    projectLabel: await resolveProjectLabel(),
    timestamp: new Date().toISOString(),
  };
}

function shortTitle(category: FeedbackCategory, message: string): string {
  const prefix = category === 'bug' ? '[BUG]' : '[REQUEST]';
  const firstLine = message.replace(/\s+/g, ' ').trim();
  return truncate(`${prefix} ${firstLine}`, DISCORD_TITLE_LIMIT);
}

function field(name: string, value: string) {
  return {
    name,
    value: truncate(value, DISCORD_FIELD_VALUE_LIMIT),
    inline: true,
  };
}

function buildEmbed(category: FeedbackCategory, message: string, diagnostics: ReportDiagnostics) {
  const fields = [
    field('Version', diagnostics.version),
    field('OS', diagnostics.osLabel),
    field('Node', diagnostics.nodeVersion),
    field('Route', diagnostics.route),
    field('User Agent', diagnostics.userAgent),
    ...(diagnostics.projectLabel ? [field('Project', diagnostics.projectLabel)] : []),
    field('Timestamp', diagnostics.timestamp),
  ];

  const footer = { text: 'o8 beta · one-way intake' };
  const baseTextLength = shortTitle(category, message).length
    + footer.text.length
    + fields.reduce((sum, item) => sum + item.name.length + item.value.length, 0);
  const allowedDescription = Math.max(0, DISCORD_EMBED_TOTAL_LIMIT - baseTextLength);

  return {
    title: shortTitle(category, message),
    description: truncate(message, Math.min(DISCORD_DESCRIPTION_LIMIT, allowedDescription)),
    color: category === 'bug' ? 0xd94f3a : 0x1d4ed8,
    fields,
    footer,
  };
}

async function postDiscordReport(category: FeedbackCategory, message: string, diagnostics: ReportDiagnostics): Promise<{ ok: true } | { ok: false; error: string }> {
  const webhookUrl = process.env.O8_FEEDBACK_WEBHOOK_URL?.trim() || DEFAULT_WEBHOOK_URL;
  const payload = {
    username: 'o8 Report',
    embeds: [buildEmbed(category, message, diagnostics)],
  };

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const suffix = detail.trim() ? `: ${truncate(detail.trim(), 180)}` : '';
      return { ok: false, error: `Discord webhook returned HTTP ${response.status}${suffix}` };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Discord webhook request failed.',
    };
  }
}

export async function POST(request: NextRequest) {
  let body: FeedbackBody;
  try {
    body = (await request.json()) as FeedbackBody;
  } catch {
    return jsonError('Invalid JSON body.');
  }

  const validated = validateBody(body);
  if (!validated.ok) return jsonError(validated.error);

  try {
    const diagnostics = await buildDiagnostics(validated.route, validated.userAgent);
    const posted = await postDiscordReport(validated.category, validated.message, diagnostics);
    if (!posted.ok) return jsonError(posted.error, 502);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'Failed to send report.', 500);
  }
}
