#!/usr/bin/env node
'use strict';

/**
 * PostToolUse hook: Run npx tsc --noEmit after every file edit.
 * If typecheck fails, the errors go back to the agent as a system message
 * so it can fix them immediately — 2-3x quality improvement per Boris Cherny.
 *
 * Only runs after Write, Edit, MultiEdit, FileWrite, FileEdit tools.
 * Skips non-TS/TSX files to avoid unnecessary checks.
 */

const { execSync } = require('child_process');

const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);

function readStdin() {
  return new Promise((resolve, reject) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { raw += chunk; });
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', reject);
  });
}

function extractFilePath(input) {
  const candidates = [
    input.file_path,
    input.path,
    input.target_path,
    input.filePath,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return '';
}

function getExtension(filePath) {
  const dot = filePath.lastIndexOf('.');
  return dot >= 0 ? filePath.slice(dot).toLowerCase() : '';
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

  // Only run after file edit tools
  const editTools = new Set(['Write', 'Edit', 'MultiEdit', 'FileWrite', 'FileEdit']);
  if (!editTools.has(parsed.tool_name)) {
    process.exit(0);
    return;
  }

  // Only run for TS/JS files
  const filePath = extractFilePath(parsed.tool_input || {});
  if (filePath && !TS_EXTENSIONS.has(getExtension(filePath))) {
    process.exit(0);
    return;
  }

  try {
    execSync('npx tsc --noEmit 2>&1', {
      cwd: process.cwd(),
      timeout: 30000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Typecheck passed — no output needed
    process.exit(0);
  } catch (error) {
    // Typecheck failed — send errors back to agent
    const output = (error.stdout || error.stderr || 'typecheck failed').toString().trim();
    const lines = output.split('\n');
    const errorCount = lines.filter((l) => l.includes('error TS')).length;
    const preview = lines.slice(0, 8).join('\n');

    const message = `[typecheck] ${errorCount} error${errorCount !== 1 ? 's' : ''} after editing ${filePath || 'file'}:\n${preview}${lines.length > 8 ? `\n... (${lines.length - 8} more lines)` : ''}`;

    process.stdout.write(JSON.stringify({ systemMessage: message }) + '\n');
    process.exit(0); // exit 0 so we don't block — just inform
  }
}

main().catch(() => process.exit(0));
