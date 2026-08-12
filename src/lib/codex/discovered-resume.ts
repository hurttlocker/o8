import 'server-only';

import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { getRuntime } from '@/lib/runtimes/registry';
import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';
import { resolveCodexDiscoveredSessionHome } from './sessions';

export async function resumeDiscoveredCodexSession(
  sessionKey: string,
  message: string,
): Promise<{ ok: boolean; note: string; responseText: string; status: number; threadId: string }> {
  const threadId = sessionKey.replace(/^codex:/, '').replace(/^codex-discovered:/, '');
  const identityId = await getRuntime('codex')?.getSessionIdentityId?.(sessionKey);
  const providerSession = await resolveCodexDiscoveredSessionHome(
    sessionKey,
    identityId ?? undefined,
  );
  if (!providerSession || providerSession.threadId !== threadId) {
    return {
      ok: false,
      note: 'The Codex session is missing or ambiguous across registered identities, so it was not resumed.',
      responseText: '',
      status: 409,
      threadId,
    };
  }

  const codexBin = path.join(os.homedir(), '.npm-global', 'bin', 'codex');
  const args = ['exec', 'resume', threadId, message, '--json', '--dangerously-bypass-approvals-and-sandbox'];
  const probe = cliInvocation(codexBin, args);
  const stdout = execFileSync(probe.command, probe.args, {
    windowsHide: true,
    cwd: process.env.HOME || os.homedir(),
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      CODEX_HOME: providerSession.configHomeRef,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    },
    encoding: 'utf-8',
  });

  let responseText = '';
  for (const line of stdout.split('\n').filter(Boolean)) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type !== 'item.completed') continue;
      const item = event.item as { type?: string; text?: string } | undefined;
      if (item?.type === 'agent_message' && item.text) responseText += item.text;
    } catch {
      continue;
    }
  }
  return { ok: true, note: 'Sent to Codex.', responseText, status: 200, threadId };
}
