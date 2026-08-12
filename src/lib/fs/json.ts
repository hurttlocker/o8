import { chmod, readFile, rename, writeFile } from 'node:fs/promises';

export async function readJsonFile<T>(filePath: string) {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw) as T;
}

export async function writeJsonFile(filePath: string, value: unknown, options?: { mode?: number }) {
  // Write-then-rename so concurrent readers (refresh timers, discovery,
  // resume/interrupt) never observe a torn/partial JSON file.
  const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    ...(options?.mode !== undefined ? { mode: options.mode } : {}),
  });
  await rename(tmpPath, filePath);
  if (options?.mode !== undefined) await chmod(filePath, options.mode);
}
