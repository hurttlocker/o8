#!/usr/bin/env node
'use strict';

function readStdin() {
  return new Promise((resolve, reject) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', reject);
  });
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function extractCommand(input) {
  const candidates = [
    input.command,
    input.cmd,
    input.input,
    input.text,
    input.script,
  ];
  return candidates.map(normalizeString).find(Boolean) || '';
}

function extractFilePath(input) {
  const candidates = [
    input.file_path,
    input.path,
    input.target_path,
    input.filePath,
  ];
  return candidates.map(normalizeString).find(Boolean) || '';
}

function isProtectedPath(filePath) {
  const normalized = filePath.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return normalized.includes('/.git/')
    || normalized.endsWith('/.git')
    || normalized.includes('.env')
    || normalized.includes('credentials')
    || normalized.includes('secret')
    || normalized.includes('token');
}

function evaluateToolUse(input) {
  if (input.tool_name === 'Bash') {
    const command = extractCommand(input.tool_input);
    const destructivePattern = /(^|[;&|]\s*)(rm\b|kill\b|pkill\b|truncate\b|mkfs\b|fdisk\b|diskutil\s+eraseDisk\b|format\b|dd\b|dropdb\b|drop\s+table\b)/i;
    if (destructivePattern.test(command)) {
      return {
        decision: 'block',
        reason: 'Destructive command blocked by o8 policy',
      };
    }
    if (/\bgit\s+reset\s+--hard\b/i.test(command)) {
      return {
        decision: 'block',
        reason: 'git reset --hard blocked — use git stash or git checkout <file> instead',
      };
    }
    if (/\bgit\s+clean\s+-[a-z]*f/i.test(command)) {
      return {
        decision: 'block',
        reason: 'git clean -f blocked — removes untracked files permanently',
      };
    }
    if (/\bgit\s+checkout\s+\.\s*$/i.test(command)) {
      return {
        decision: 'block',
        reason: 'git checkout . blocked — discards all unstaged changes',
      };
    }
    if (/\bgit\s+push\b/i.test(command) && /(?:--force|-f)(?:\s|$)/i.test(command)) {
      return {
        decision: 'block',
        reason: 'Force push blocked by o8 policy — never force push',
      };
    }
    if (/\bgit\s+(?:push|merge|rebase)\b/i.test(command)) {
      return {
        decision: 'ask_user',
        reason: 'Git push/merge/rebase requires confirmation',
      };
    }
  }

  if (input.tool_name === 'FileWrite'
    || input.tool_name === 'FileEdit'
    || input.tool_name === 'Write'
    || input.tool_name === 'Edit'
    || input.tool_name === 'MultiEdit') {
    const filePath = extractFilePath(input.tool_input);
    if (isProtectedPath(filePath)) {
      return {
        decision: 'block',
        reason: 'Protected file path blocked by o8 policy',
      };
    }
  }

  return { decision: 'approve' };
}

async function createApproval(input, outcome) {
  if (!outcome.reason) {
    return;
  }

  const command = input.tool_name === 'Bash' ? extractCommand(input.tool_input) : undefined;
  const filePath = extractFilePath(input.tool_input) || undefined;
  const risk = outcome.decision === 'block' ? 'high' : 'medium';

  try {
    await fetch('http://localhost:3001/api/panel/approvals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'create',
        approval: {
          source: 'runtime',
          runtime: 'claude-code',
          agent: 'Claude Code Hook',
          sessionKey: `claude-code:${input.session_id}`,
          title: outcome.decision === 'block' ? 'Blocked Claude Code tool use' : 'Claude Code tool requires confirmation',
          description: outcome.reason,
          summary: command
            ? `${input.tool_name}: ${command}`
            : `${input.tool_name}${filePath ? `: ${filePath}` : ''}`,
          toolName: input.tool_name,
          args: input.tool_input,
          command,
          editable: false,
          risk,
          metadata: {
            Session: input.session_id,
            Tool: input.tool_name,
            ToolUseId: input.tool_use_id,
            ...(filePath ? { Path: filePath } : {}),
          },
        },
      }),
      signal: AbortSignal.timeout(1500),
    });
  } catch {}
}

function toHookPayload(output) {
  const permissionDecision = output.decision === 'approve'
    ? 'allow'
    : output.decision === 'ask_user'
      ? 'ask'
      : 'deny';

  return {
    decision: output.decision,
    reason: output.reason,
    hookSpecificOutput: {
      permissionDecision,
    },
    systemMessage: output.reason,
  };
}

async function main() {
  let parsed = null;

  try {
    const raw = await readStdin();
    parsed = JSON.parse(raw);
  } catch {
    const fallback = toHookPayload({ decision: 'approve' });
    process.stdout.write(`${JSON.stringify(fallback)}\n`);
    process.exit(0);
    return;
  }

  const outcome = evaluateToolUse(parsed);
  if (outcome.decision !== 'approve') {
    await createApproval(parsed, outcome);
  }

  const payload = `${JSON.stringify(toHookPayload(outcome))}\n`;
  process.stdout.write(payload);
  if (outcome.decision === 'block') {
    process.stderr.write(payload);
    process.exit(2);
    return;
  }
  process.exit(0);
}

void main();
