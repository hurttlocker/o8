export interface ManagedRunLabelInput {
  command: string;
  title?: string | null;
}

const MAX_LABEL_LENGTH = 42;

function compact(value: string, max = MAX_LABEL_LENGTH): string {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function stripShellWrapper(command: string): string {
  const trimmed = command.trim();
  const match = trimmed.match(/^(?:\/bin\/)?(?:sh|bash|zsh)\s+-l?c\s+(?:(['"])([\s\S]*)\1|([\s\S]+))$/);
  return (match?.[2] ?? match?.[3])?.trim() || trimmed;
}

function detectPort(command: string): string | null {
  const match = command.match(/(?:^|\s)(?:PORT|O8_API_PORT)=([0-9]{2,5})(?:\s|$)/);
  return match?.[1] ? `:${match[1]}` : null;
}

function detectScriptLabel(command: string): string | null {
  if (/\bnpm\s+run\s+desktop:dev:side\b/.test(command)) return 'dev side-stack';
  if (/\bnpm\s+run\s+desktop:dev\b/.test(command)) return 'dev stack';
  if (/\bnpm\s+run\s+dev:ws:side\b/.test(command)) return 'ws side-bridge';
  if (/\bnpm\s+run\s+dev:side\b/.test(command)) return 'dev side-app';
  if (/\bnpm\s+run\s+dev:ws\b/.test(command) || /\btsx\s+src\/ws-server\.ts\b/.test(command)) return 'ws bridge';
  if (/\bnpm\s+run\s+dev\b/.test(command) || /\bnext\s+dev\b/.test(command)) return 'dev app';
  if (/\bnpm\s+(?:run\s+)?typecheck\b/.test(command) || /\btsc\s+--noEmit\b/.test(command)) return 'typecheck';
  if (/\bnpm\s+(?:run\s+)?test\b/.test(command) || /\bvitest\b/.test(command)) return 'tests';
  if (/\bnpm\s+run\s+build\b/.test(command) || /\bnext\s+build\b/.test(command)) return 'build';
  return null;
}

export function deriveManagedRunLabel(input: ManagedRunLabelInput): string {
  const declaredTitle = input.title?.trim();
  if (declaredTitle) return compact(declaredTitle);

  const normalized = stripShellWrapper(input.command);
  const scriptLabel = detectScriptLabel(normalized);
  if (scriptLabel) {
    const port = detectPort(normalized);
    return port ? `${scriptLabel} ${port}` : scriptLabel;
  }

  return compact(normalized);
}
