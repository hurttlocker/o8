import { readFile, rename, writeFile } from 'node:fs/promises';

export async function readJsonFile<T>(filePath: string) {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw) as T;
}

export async function writeJsonFile(filePath: string, value: unknown) {
  // Write-then-rename so concurrent readers (refresh timers, discovery,
  // resume/interrupt) never observe a torn/partial JSON file.
  const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmpPath, filePath);
}
