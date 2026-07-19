export async function worktreeExistsOnDisk(worktreePath: string): Promise<boolean> {
  try {
    const { stat } = await import('node:fs/promises');
    const dirStat = await stat(worktreePath);
    if (!dirStat.isDirectory()) return false;
    const gitStat = await stat(`${worktreePath}/.git`);
    return gitStat.isFile() || gitStat.isDirectory();
  } catch {
    return false;
  }
}
