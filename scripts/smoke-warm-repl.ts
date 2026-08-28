/** Live smoke for the warm REPL pool — cold vs warm timing + streaming. */
import { askClaudeWarm, resetWarmReplPool } from '../src/lib/claude-code/warm-repl-pool';
import { REPL_HEALTH_PROMPTS_V1 } from '../src/lib/prompts/v1/health';

const BIN = process.env.CLAUDE_BIN || `${process.env.HOME}/.claude/local/claude`;
const MODEL = 'claude-haiku-4-5-20251001';

async function main() {
  // 1. Cold call (no pre-warm) — baseline.
  let t = Date.now();
  const a = await askClaudeWarm(REPL_HEALTH_PROMPTS_V1.cold, { binary: BIN, model: MODEL, timeoutMs: 60_000 });
  console.log(`cold: ${Date.now() - t}ms reply=${JSON.stringify(a)}`);

  // 2. The cold call should have triggered a refill. Give bootstrap a beat.
  await new Promise((r) => setTimeout(r, 6_000));

  // 3. Warm call — should skip bootstrap.
  t = Date.now();
  let deltas = 0;
  const b = await askClaudeWarm(REPL_HEALTH_PROMPTS_V1.warm, {
    binary: BIN, model: MODEL, timeoutMs: 60_000,
    onDelta: () => { deltas += 1; },
  });
  console.log(`warm: ${Date.now() - t}ms reply=${JSON.stringify(b)} deltas=${deltas}`);

  resetWarmReplPool();
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
