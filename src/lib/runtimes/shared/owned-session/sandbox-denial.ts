export interface SandboxDenial {
  operation: 'file-read' | 'file-write' | 'process-exec' | 'sandbox-apply' | 'unknown';
  resource: string;
  line: string;
}

const OPERATION_NOT_PERMITTED = /operation not permitted/i;

function trimResource(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '').replace(/[.,;]$/, '');
}

function operationForCommand(command: string): SandboxDenial['operation'] {
  const name = command.trim().split(/[ /]/).at(-1)?.toLowerCase() ?? '';
  if (['cat', 'head', 'tail', 'stat', 'ls', 'find', 'rg', 'grep'].includes(name)) return 'file-read';
  if (['chmod', 'chown', 'cp', 'ln', 'mkdir', 'mv', 'rm', 'touch'].includes(name)) return 'file-write';
  if (['env', 'sh', 'bash', 'zsh', 'sandbox-exec'].includes(name)) return 'process-exec';
  return 'unknown';
}

/** Parse the stderr forms emitted by macOS sandbox-exec and denied children. */
export function detectSandboxDenial(raw: string): SandboxDenial | null {
  for (const originalLine of raw.split(/\r?\n/)) {
    const line = originalLine.trim();
    if (!line) continue;

    const sandboxLog = line.match(/\bdeny(?:\(\d+\))?\s+(file-read[^ ]*|file-write[^ ]*|process-exec)\s+(.+)$/i);
    if (sandboxLog) {
      const operation = sandboxLog[1]?.toLowerCase().startsWith('file-read')
        ? 'file-read'
        : sandboxLog[1]?.toLowerCase().startsWith('file-write')
          ? 'file-write'
          : 'process-exec';
      return { operation, resource: trimResource(sandboxLog[2] ?? 'unknown resource'), line };
    }

    const execFailure = line.match(/execvp\(\) of ['"](.+?)['"] failed:\s*Operation not permitted/i);
    if (execFailure) {
      return { operation: 'process-exec', resource: trimResource(execFailure[1] ?? ''), line };
    }

    const modeFailure = line.match(/Unable to change file mode on (.+?):\s*Operation not permitted/i);
    if (modeFailure) {
      return { operation: 'file-write', resource: trimResource(modeFailure[1] ?? ''), line };
    }

    if (/sandbox-exec:\s*sandbox_apply:/i.test(line) && OPERATION_NOT_PERMITTED.test(line)) {
      return { operation: 'sandbox-apply', resource: 'generated worker sandbox profile', line };
    }

    const childFailure = line.match(/^([^:]+):\s+(.+?):\s*Operation not permitted\s*$/i);
    if (childFailure) {
      return {
        operation: operationForCommand(childFailure[1] ?? ''),
        resource: trimResource(childFailure[2] ?? 'unknown resource'),
        line,
      };
    }
  }
  return null;
}

export function sandboxDenialOperatorMessage(runtime: string, denial: SandboxDenial): string {
  return `${runtime} worker sandbox blocked ${denial.operation} access to ${denial.resource}. `
    + 'The worker stopped; review the opt-in sandbox profile before retrying.';
}
