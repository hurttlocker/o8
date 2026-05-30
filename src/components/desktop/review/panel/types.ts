type DiffMode = 'unified' | 'side';
/** Panel → row signal for bulk collapse/expand; rows re-apply `open` on each new identity. */
type CollapseSignal = { open: boolean; nonce: number };
type ReviewScope = 'all' | 'last-turn' | 'staged' | 'unstaged';
type LocalDiffComment = { id: string; key: string; label: string; body: string; createdAt: number };
type LocalCommentTarget = { key: string; label: string };

export type { DiffMode, CollapseSignal, ReviewScope, LocalDiffComment, LocalCommentTarget };
