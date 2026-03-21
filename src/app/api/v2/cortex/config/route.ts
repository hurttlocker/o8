/**
 * Cortex Configuration API
 *
 * GET  — Read current Cortex config + stats + doctor health
 * POST — Update Cortex config fields
 */

import { NextResponse } from 'next/server';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CORTEX_HOME = join(process.env.HOME || '/Users/marquisehurtt', '.cortex');
const CONFIG_PATH = join(CORTEX_HOME, 'config.yaml');
const CORTEX_BIN = process.env.CORTEX_BINARY || join(process.env.HOME || '/Users/marquisehurtt', 'bin', 'cortex');

function safeExec(cmd: string, timeoutMs = 8000): string {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: timeoutMs }).trim();
  } catch {
    return '';
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getSectionBlock(configRaw: string, section: string): string {
  const match = configRaw.match(new RegExp(`^${escapeRegExp(section)}:\\s*\\n((?:\\s{2}.*(?:\\n|$))*)`, 'm'));
  return match ? match[1] : '';
}

function getBlockValue(block: string, key: string): string {
  const match = block.match(new RegExp(`^\\s*${escapeRegExp(key)}:\\s*(.+)$`, 'm'));
  return match ? match[1].trim() : '';
}

function getBooleanValue(block: string, key: string): boolean | undefined {
  const value = getBlockValue(block, key).toLowerCase();
  if (!value) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function getNumberValue(block: string, key: string): number | undefined {
  const raw = getBlockValue(block, key);
  if (!raw) return undefined;
  const value = Number(raw.replace(/^['"]|['"]$/g, ''));
  return Number.isFinite(value) ? value : undefined;
}

function upsertSectionValue(config: string, section: string, key: string, value: string | number | boolean): string {
  const renderedValue = String(value);
  const sectionRegex = new RegExp(`^(${escapeRegExp(section)}:\\s*\\n)((?:\\s{2}.*(?:\\n|$))*)`, 'm');
  const match = sectionRegex.exec(config);

  if (!match) {
    const separator = config.trimEnd().length ? '\n\n' : '';
    return `${config.trimEnd()}${separator}${section}:\n  ${key}: ${renderedValue}\n`;
  }

  const header = match[1];
  const body = match[2] ?? '';
  const keyRegex = new RegExp(`^(\\s{2}${escapeRegExp(key)}:\\s*).*$`, 'm');
  let updatedBody = body;

  if (keyRegex.test(body)) {
    updatedBody = body.replace(keyRegex, `$1${renderedValue}`);
  } else if (/^  source_boost:/m.test(body)) {
    updatedBody = body.replace(/^  source_boost:/m, `  ${key}: ${renderedValue}\n  source_boost:`);
  } else {
    updatedBody = `${body}${body && !body.endsWith('\n') ? '\n' : ''}  ${key}: ${renderedValue}\n`;
  }

  const start = match.index;
  const end = start + match[0].length;
  return `${config.slice(0, start)}${header}${updatedBody}${config.slice(end)}`;
}

/** List locally available Ollama models */
function getOllamaModels(): string[] {
  try {
    const raw = safeExec('ollama list 2>/dev/null', 5000);
    if (!raw) return [];
    return raw
      .split('\n')
      .slice(1)
      .map(line => line.split(/\s+/)[0])
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function GET() {
  try {
    let configRaw = '';
    if (existsSync(CONFIG_PATH)) {
      configRaw = readFileSync(CONFIG_PATH, 'utf-8');
    }

    const llmBlock = getSectionBlock(configRaw, 'llm');
    const searchBlock = getSectionBlock(configRaw, 'search');
    const embedBlock = getSectionBlock(configRaw, 'embed');

    const llmProvider = getBlockValue(llmBlock, 'provider');
    const llmApiKey = getBlockValue(llmBlock, 'api_key');
    const enrichModel = getBlockValue(llmBlock, 'enrich_model');
    const classifyModel = getBlockValue(llmBlock, 'classify_model');
    const expandModel = getBlockValue(llmBlock, 'expand_model');
    const embedModel = getBlockValue(embedBlock, 'provider');

    const sourceBoostCount = (searchBlock.match(/- prefix:/g) || []).length;
    const recallEnabled = getBooleanValue(searchBlock, 'recall_enabled');
    const recallMaxResults = getNumberValue(searchBlock, 'recall_max_results');
    const recallTokenBudget = getNumberValue(searchBlock, 'recall_token_budget');
    const recallMinConfidence = getNumberValue(searchBlock, 'recall_min_confidence');

    const statsRaw = safeExec(`${CORTEX_BIN} stats --json 2>/dev/null`);
    let stats: Record<string, unknown> | null = null;
    try {
      stats = JSON.parse(statsRaw) as Record<string, unknown>;
    } catch {
      stats = null;
    }

    const doctorRaw = safeExec(`${CORTEX_BIN} doctor 2>&1`);
    const ollamaModels = getOllamaModels();

    const memories = typeof stats?.memories === 'number' ? stats.memories : 0;
    const doctorMatch = doctorRaw.match(/(\d+)\s+embedding/);
    const embeddings = doctorMatch ? parseInt(doctorMatch[1], 10) : 0;
    const embedCoverage = memories > 0 ? (embeddings / memories * 100) : 0;

    return NextResponse.json({
      config: {
        embedModel,
        enrichModel,
        classifyModel,
        expandModel,
        llmProvider,
        llmApiKey: llmApiKey ? `${llmApiKey.slice(0, 8)}${'•'.repeat(Math.max(0, llmApiKey.length - 12))}${llmApiKey.slice(-4)}` : '',
        llmApiKeySet: llmApiKey.length > 0,
        configPath: CONFIG_PATH,
        dbPath: join(CORTEX_HOME, 'cortex.db'),
        sourceBoostCount,
        recallEnabled,
        recallMaxResults,
        recallTokenBudget,
        recallMinConfidence,
      },
      stats: stats ? {
        memories: typeof stats.memories === 'number' ? stats.memories : 0,
        facts: typeof stats.facts === 'number' ? stats.facts : 0,
        sources: typeof stats.sources === 'number' ? stats.sources : 0,
        storageMb: typeof stats.storage_bytes === 'number' ? (stats.storage_bytes / 1024 / 1024).toFixed(1) : '0',
        avgConfidence: typeof stats.avg_confidence === 'number' ? (stats.avg_confidence * 100).toFixed(1) : '0',
        factsByType: (stats.facts_by_type as Record<string, number>) || {},
        confidenceDistribution: (stats.confidence_distribution as Record<string, number>) || {},
        growth: (stats.growth as Record<string, number>) || {},
        embeddings,
        embedCoverage: embedCoverage.toFixed(1),
      } : null,
      ollamaModels,
      healthy: doctorRaw.includes('0 fail'),
      doctorSummary: doctorRaw.match(/Summary:.*/)?.[0] || '',
      version: safeExec(`${CORTEX_BIN} version 2>/dev/null`) || 'unknown',
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      embedModel,
      enrichModel,
      classifyModel,
      expandModel,
      llmProvider,
      llmApiKey,
      recallEnabled,
      recallMaxResults,
      recallTokenBudget,
      recallMinConfidence,
    } = body;

    if (!existsSync(CONFIG_PATH)) {
      return NextResponse.json({ error: 'Config file not found' }, { status: 404 });
    }

    let config = readFileSync(CONFIG_PATH, 'utf-8');

    if (embedModel !== undefined) {
      config = upsertSectionValue(config, 'embed', 'provider', embedModel);
    }

    if (llmProvider !== undefined) {
      config = upsertSectionValue(config, 'llm', 'provider', llmProvider);
    }

    if (llmApiKey !== undefined && !String(llmApiKey).includes('•')) {
      config = upsertSectionValue(config, 'llm', 'api_key', llmApiKey);
    }

    if (enrichModel !== undefined) {
      config = upsertSectionValue(config, 'llm', 'enrich_model', enrichModel);
    }

    if (classifyModel !== undefined) {
      config = upsertSectionValue(config, 'llm', 'classify_model', classifyModel);
    }

    if (expandModel !== undefined) {
      config = upsertSectionValue(config, 'llm', 'expand_model', expandModel);
    }

    if (recallEnabled !== undefined) {
      config = upsertSectionValue(config, 'search', 'recall_enabled', Boolean(recallEnabled));
    }

    if (recallMaxResults !== undefined) {
      config = upsertSectionValue(config, 'search', 'recall_max_results', Number(recallMaxResults));
    }

    if (recallTokenBudget !== undefined) {
      config = upsertSectionValue(config, 'search', 'recall_token_budget', Number(recallTokenBudget));
    }

    if (recallMinConfidence !== undefined) {
      config = upsertSectionValue(config, 'search', 'recall_min_confidence', Number(recallMinConfidence));
    }

    writeFileSync(CONFIG_PATH, config, 'utf-8');

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
