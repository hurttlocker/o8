import { spawn } from 'node:child_process';

import { buildNode22ReexecPlan, NODE22_REEXEC_GUARD } from './operator-node22-locator';

const NODE22_CHECKED = 'O8_MCP_NODE22_CHECKED';

async function reexecOnNode22IfNeeded(): Promise<void> {
  if (process.env[NODE22_CHECKED] === '1') {
    return;
  }
  process.env[NODE22_CHECKED] = '1';

  const plan = buildNode22ReexecPlan();
  if (plan.action === 'proceed') {
    return;
  }
  if (plan.action === 'warn') {
    console.error(`[o8 operator MCP] ${plan.message}`);
    return;
  }

  await new Promise<void>((resolve) => {
    const child = spawn(plan.nodePath, plan.argv, {
      env: { ...process.env, [NODE22_REEXEC_GUARD]: '1', [NODE22_CHECKED]: '1' },
      stdio: 'inherit',
    });

    child.once('error', (error) => {
      console.error(`[o8 operator MCP] failed to re-exec on Node 22 at ${plan.nodePath}: ${error.message}; continuing on Node ${process.versions.node}`);
      resolve();
    });
    child.once('close', (code, signal) => {
      process.exit(code ?? (signal ? 1 : 0));
    });
  });
}

await reexecOnNode22IfNeeded();
