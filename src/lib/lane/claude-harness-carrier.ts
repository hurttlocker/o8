import 'server-only';

import { createHash } from 'node:crypto';

import {
  buildClaudeCodeWorkerSpawnEnv,
  readClaudeCodeWorkerProfileSync,
  resolveClaudeCodeWorkerGatewayKey,
  selectedClaudeCodeWorkerModelSync,
} from '@/lib/claude-code/worker-profile';
import type { ClaudeCodeModelSource } from '@/lib/claude-code/worker-profile-types';
import {
  ensureCodexSubscriptionClaudeConfigDir,
  ensureCodexSubscriptionProxyReady,
} from '@/lib/claude-code/codex-subscription-proxy';

export interface ClaudeHarnessCarrier {
  source: ClaudeCodeModelSource;
  model: string;
  spawnEnv: Record<string, string>;
  fingerprint: string;
}

export function nativeClaudeHarnessCarrier(model: string): ClaudeHarnessCarrier {
  return {
    source: 'native',
    model,
    spawnEnv: {},
    fingerprint: carrierFingerprint('native', model, null, null),
  };
}

function carrierFingerprint(
  source: ClaudeCodeModelSource,
  model: string,
  baseUrl: string | null,
  credential: string | null,
): string {
  return createHash('sha256')
    .update(JSON.stringify({ source, model, baseUrl, credential }))
    .digest('hex');
}

export async function resolveClaudeHarnessCarrier(input: {
  requestedModel: string;
  sessionDir: string;
}): Promise<ClaudeHarnessCarrier> {
  const profile = readClaudeCodeWorkerProfileSync();
  if (profile.source === 'native') return nativeClaudeHarnessCarrier(input.requestedModel);

  const model = selectedClaudeCodeWorkerModelSync() ?? input.requestedModel;
  if (profile.source === 'openrouter') {
    const credential = await resolveClaudeCodeWorkerGatewayKey();
    if (!credential) {
      throw new Error('The Claude Code harness is set to OpenRouter, but no API key is configured in Settings > Models > API keys.');
    }
    const spawnEnv = buildClaudeCodeWorkerSpawnEnv('openrouter', model, credential);
    return {
      source: 'openrouter',
      model,
      spawnEnv,
      fingerprint: carrierFingerprint('openrouter', model, spawnEnv.ANTHROPIC_BASE_URL ?? null, credential),
    };
  }

  const connection = await ensureCodexSubscriptionProxyReady();
  const spawnEnv = {
    ...buildClaudeCodeWorkerSpawnEnv(
      'codex-subscription',
      model,
      connection.clientToken,
      connection.baseUrl,
    ),
    CLAUDE_CONFIG_DIR: await ensureCodexSubscriptionClaudeConfigDir(input.sessionDir),
  };
  return {
    source: 'codex-subscription',
    model,
    spawnEnv,
    fingerprint: carrierFingerprint('codex-subscription', model, connection.baseUrl, connection.clientToken),
  };
}
