// Turn a raw agent progress line like "I'm editing NavRail first. The change
// is isolated" into a 3-word status (e.g. "Editing NavRail first"). Users
// want to glance at a sidebar row and see what the agent is doing, not a
// generic "Idle" when 30 rows would otherwise say the same thing. Returns
// null when there is nothing meaningful to summarize.
const TASK_PREFIX_PATTERN = /^(?:(?:I['']?m|I am|I['']?ve|I will|I['']?ll|Let me|Now I['']?m|Now|Next,?|Currently|Just|Also)\s+)+/i;
const TASK_TRAILING_PATTERN = /[.,;:!?—–-]+.*$/;

export function threeWordTaskSummary(text?: string | null): string | null {
  if (!text) return null;
  const cleaned = text
    .replace(TASK_PREFIX_PATTERN, '')
    .replace(TASK_TRAILING_PATTERN, '')
    .trim();
  if (!cleaned) return null;
  const words = cleaned.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return null;
  const trimmed = words.slice(0, 3).join(' ');
  return trimmed.length > 0
    ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
    : null;
}
