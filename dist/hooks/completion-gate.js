#!/usr/bin/env node
'use strict';

/**
 * PostToolUse hook: Gate agent completion on passing typecheck.
 * Runs when the agent tries to stop/complete. If tsc --noEmit fails,
 * exit code 2 blocks the completion and sends errors back so the agent
 * fixes them before finishing.
 *
 * This is the hard gate — no green typecheck, no completion.
 */

const { execSync } = require('child_process');

function readStdin() {
  return new Promise((resolve, reject) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { raw += chunk; });
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', reject);
  });
}

async function main() {
  let parsed = null;

  try {
    const raw = await readStdin();
    parsed = JSON.parse(raw);
  } catch {
    process.exit(0);
    return;
  }

  // Only gate on task completion / stop events
  const completionTools = new Set(['Stop', 'TaskComplete', 'Attempt completion']);
  if (!completionTools.has(parsed.tool_name)) {
    process.exit(0);
    return;
  }

  try {
    execSync('npx tsc --noEmit 2>&1', {
      cwd: process.cwd(),
      timeout: 45000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Passed — allow completion
    process.exit(0);
  } catch (error) {
    const output = (error.stdout || error.stderr || 'typecheck failed').toString().trim();
    const lines = output.split('\n');
    const errorCount = lines.filter((l) => l.includes('error TS')).length;
    const preview = lines.slice(0, 10).join('\n');

    const message = `[completion-gate] BLOCKED: ${errorCount} typecheck error${errorCount !== 1 ? 's' : ''} must be fixed before completing:\n${preview}${lines.length > 10 ? `\n... (${lines.length - 10} more lines)` : ''}`;

    // Exit 2 blocks the action and sends the message back
    process.stdout.write(JSON.stringify({ systemMessage: message }) + '\n');
    process.stderr.write(message + '\n');
    process.exit(2);
  }
}

main().catch(() => process.exit(0));
