import { controlledProviderPins } from './controlled-provider';
import type { OwnedSessionRecord } from './types';

const BASE_KEYS = ['HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT'];
const ADAPTER_KEYS = ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_TMPDIR', 'CLAUDE_CODE_OAUTH_TOKEN'];
const CONTROLLED_KEYS = ['TMPDIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'];
const RUN_KEYS = ['PWD', 'PATH', 'NODE_ENV', 'FORCE_COLOR', 'NO_COLOR', 'BROWSER',
  'O8_WORKER_TOKEN', 'O8_OWNED_RUN_MARKER', 'O8_API_PORT', 'O8_WS_PORT'];

function pick(input: Record<string, string | undefined>, keys: string[]): Record<string, string> {
  return Object.fromEntries(keys.filter((key) => input[key] !== undefined).map((key) => [key, input[key]!]));
}

/** Native login is pinned by the adapter; ambient API keys and shell hooks are excluded. */
export function ownedSpawnEnvironment(session: OwnedSessionRecord, env: Record<string, string>): NodeJS.ProcessEnv {
  if (session.executionPolicy === undefined) return { ...process.env, ...env };
  return { NODE_ENV: 'development', ...pick(process.env, BASE_KEYS), ...pick(env, [...ADAPTER_KEYS, ...RUN_KEYS,
    ...(session.controlledTask && controlledProviderPins(session.model, session.effort, session.runtimeConfig) ? CONTROLLED_KEYS : [])]) };
}
