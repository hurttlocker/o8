/** Fixed schema guidance only: never echo task contents, paths or credentials. */
export const TASK_DRAFT_VALIDATION_HINTS: Record<string, string> = {
  invalid_arguments: 'Use the declared task arguments exactly: required fields, normalized non-empty strings and unique bounded lists.',
  invalid_file_scope: 'allowedFiles and contract file paths must be exact repository-relative regular files, without globs, traversal, symlinks or environment files.',
  invalid_task_contract: 'Provide sealedTaskContract version 1 with complete requirements, smallestRoute and exclusions; use the declared contract schema.',
  contract_file_scope_mismatch: 'Map every requirements[].productionPath and smallestRoute[].path to an exact allowedFiles entry; every allowed file must be mapped.',
  unsupported_work_mode_or_runtime: 'Select read-only workMode and a runtime returned by the current workspace options.',
  model_incompatible: 'Use an exact model from the selected runtime in the current workspace options.',
  effort_not_honored: 'Use an exact effort supported for the selected runtime and model in the current workspace options.',
};

export function taskDraftValidationMessage(code: string): string | undefined {
  const hint = Object.hasOwn(TASK_DRAFT_VALIDATION_HINTS, code) ? TASK_DRAFT_VALIDATION_HINTS[code] : undefined;
  return hint ? `${hint} Correct the generated contract, then use a new idempotency key. Exact retries must keep the original arguments and key.` : undefined;
}
