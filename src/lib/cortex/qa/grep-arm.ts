import 'server-only';

import { tokenizeForGrep } from '@/lib/cortex/qa/literal-lookup';
import type { TypedRow } from '@/lib/cortex/qa/types';
import { buildStrongGrepTopRowsImpl } from './eval/strong-grep-baseline';

export async function buildGrepArmTopRows(
  question: string,
  repoPath: string | undefined,
): Promise<TypedRow[]> {
  return buildStrongGrepTopRowsImpl(question, repoPath, {
    tokenize: tokenizeForGrep,
    fallback: async () => [],
  });
}
