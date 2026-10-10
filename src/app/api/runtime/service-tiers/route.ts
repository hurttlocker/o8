import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { requirePanelAuth } from '@/lib/panel/auth';
import { getCodexSpeedCatalogue } from '@/lib/codex/service-tier-catalogue';
import { readClaudeCodeWorkerProfileSync } from '@/lib/claude-code/worker-profile';
import { claudeModelSupportsFast, STANDARD_SERVICE_TIER } from '@/lib/orchestrator/service-tier';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request); if (denied) return denied;
  const backend = request.nextUrl.searchParams.get('backend');
  const model = request.nextUrl.searchParams.get('model') ?? '';
  if (model.length > 200) return NextResponse.json({ error: 'Invalid model.' }, { status: 400 });
  const headers = { 'Cache-Control': 'no-store' };
  try {
    if (backend === 'codex') {
      const catalogue = await getCodexSpeedCatalogue();
      return NextResponse.json({ options: catalogue.models[model] ?? [STANDARD_SERVICE_TIER], configuredTier: catalogue.configuredTier ?? 'default', source: 'codex-model-list' }, { headers });
    }
    if (backend === 'claude') {
      const native = readClaudeCodeWorkerProfileSync().source === 'native';
      const fast = native && claudeModelSupportsFast(model) && process.env.CLAUDE_CODE_DISABLE_FAST_MODE !== '1';
      const settings = await readFile(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'), 'settings.json'), 'utf8').then((value) => JSON.parse(value)).catch(() => ({}));
      return NextResponse.json({ options: fast ? [STANDARD_SERVICE_TIER, { id: 'fast', label: 'Fast', description: 'Uses paid Claude usage credits. Your CLI checks account access.' }] : [STANDARD_SERVICE_TIER], configuredTier: fast && settings.fastMode === true ? 'fast' : 'default', source: 'claude-code' }, { headers });
    }
    return NextResponse.json({ options: [], source: 'runtime-default' }, { headers });
  } catch {
    return NextResponse.json({ options: [STANDARD_SERVICE_TIER], error: 'Service tiers could not be checked. Try again.' }, { status: 503, headers });
  }
}
