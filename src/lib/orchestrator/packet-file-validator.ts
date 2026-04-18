import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const PACKET_FILE_REFERENCE_PATTERN = /src\/[^\s\)`'"]+\.(?:ts|tsx|js|jsx|json|md)\b/g;

export interface PacketFileValidationResult {
  referencedPaths: string[];
  missingPaths: string[];
}

export function extractPacketFileReferences(text: string) {
  return [...new Set(text.match(PACKET_FILE_REFERENCE_PATTERN) ?? [])];
}

export function validatePacketFileReferences(text: string, repoPath: string): PacketFileValidationResult {
  const referencedPaths = extractPacketFileReferences(text);
  const missingPaths = referencedPaths.filter((relativePath) => !existsSync(resolve(repoPath, relativePath)));
  return {
    referencedPaths,
    missingPaths,
  };
}

export function appendPacketFileValidationWarning(text: string, repoPath: string) {
  const { missingPaths } = validatePacketFileReferences(text, repoPath);
  if (missingPaths.length === 0) {
    return text;
  }

  return [
    text,
    [
      'Missing file references to verify:',
      ...missingPaths.map((relativePath) => `- ${relativePath}`),
    ].join('\n'),
  ].join('\n\n');
}
