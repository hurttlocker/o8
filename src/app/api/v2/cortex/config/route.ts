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

/** List locally available Ollama models */
function getOllamaModels(): string[] {
  try {
    const raw = safeExec('ollama list 2>/dev/null', 5000);
    if (!raw) return [];
    return raw
      .split('\n')
      .slice(1) // skip header
      .map(line => line.split(/\s+/)[0])
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function GET() {
  try {
    // Read config file
    let configRaw = '';
    if (existsSync(CONFIG_PATH)) {
      configRaw = readFileSync(CONFIG_PATH, 'utf-8');
    }

    // Parse YAML manually (simple key extraction — avoid adding yaml dep)
    const getVal = (key: string): string => {
      const match = configRaw.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm'));
      return match ? match[1].trim() : '';
    };

    // Extract config values
    const llmProvider = getVal('provider');
    const embedProvider = getVal('provider') || '';
    // More precise extraction for nested keys
    const embedLine = configRaw.match(/embed:\s*\n\s*provider:\s*(.+)/m);
    const embedModel = embedLine ? embedLine[1].trim() : '';
    const enrichModel = getVal('enrich_model');
    const classifyModel = getVal('classify_model');

    // Get stats
    const statsRaw = safeExec(`${CORTEX_BIN} stats --json 2>/dev/null`);
    let stats = null;
    try { stats = JSON.parse(statsRaw); } catch { /* ignore */ }

    // Get doctor output
    const doctorRaw = safeExec(`${CORTEX_BIN} doctor 2>&1`);

    // Get ollama models
    const ollamaModels = getOllamaModels();

    // Get embedding coverage
    const memories = stats?.memories ?? 0;
    const doctorMatch = doctorRaw.match(/(\d+)\s+embedding/);
    const embeddings = doctorMatch ? parseInt(doctorMatch[1]) : 0;
    const embedCoverage = memories > 0 ? (embeddings / memories * 100) : 0;

    return NextResponse.json({
      config: {
        embedModel,
        enrichModel,
        classifyModel,
        llmProvider,
        configPath: CONFIG_PATH,
        dbPath: join(CORTEX_HOME, 'cortex.db'),
      },
      stats: stats ? {
        memories: stats.memories,
        facts: stats.facts,
        sources: stats.sources,
        storageMb: stats.storage_bytes ? (stats.storage_bytes / 1024 / 1024).toFixed(1) : '0',
        avgConfidence: stats.avg_confidence ? (stats.avg_confidence * 100).toFixed(1) : '0',
        factsByType: stats.facts_by_type || {},
        confidenceDistribution: stats.confidence_distribution || {},
        growth: stats.growth || {},
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
    const { embedModel, enrichModel, classifyModel } = body;

    if (!existsSync(CONFIG_PATH)) {
      return NextResponse.json({ error: 'Config file not found' }, { status: 404 });
    }

    let config = readFileSync(CONFIG_PATH, 'utf-8');

    // Update embed provider
    if (embedModel !== undefined) {
      config = config.replace(
        /^(\s*embed:\s*\n\s*provider:\s*)(.+)$/m,
        `$1${embedModel}`
      );
    }

    // Update enrich model
    if (enrichModel !== undefined) {
      config = config.replace(
        /^(\s*enrich_model:\s*)(.+)$/m,
        `$1${enrichModel}`
      );
    }

    // Update classify model
    if (classifyModel !== undefined) {
      config = config.replace(
        /^(\s*classify_model:\s*)(.+)$/m,
        `$1${classifyModel}`
      );
    }

    writeFileSync(CONFIG_PATH, config, 'utf-8');

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
