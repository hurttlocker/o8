import type { ActivityStep } from './worker-activity';

export interface ActivityGroup extends ActivityStep {
  steps: ActivityStep[];
}

export const activityRepetitions = (count: number) => count === 1 ? '' : count === 2 ? ' twice' : ` ${count} times`;

/** Preserve command order and identities; a failure always forms its own group. */
export function groupActivitySteps(steps: ActivityStep[]): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  for (const step of steps) {
    const previous = groups.at(-1);
    const key = (item: ActivityStep) => item.kind === 'read' || item.kind === 'edit' ? item.kind : item.label;
    if (previous && previous.status !== 'failed' && step.status !== 'failed' && key(previous.steps[0]) === key(step)) {
      previous.steps.push(step);
    } else {
      groups.push({ ...step, steps: [step] });
    }
  }
  return groups.map(group => {
    if (group.steps.length === 1) return group;
    const files = [...new Set(group.steps.flatMap(step => step.files))];
    const searchTerms = [...new Set(group.steps.flatMap(step => step.searchTerms))];
    const status = group.steps.some(step => step.status === 'running') ? 'running'
      : group.steps.some(step => step.status === 'stopped') ? 'stopped' : 'ok';
    const stopped = group.steps.filter(step => step.status === 'stopped').length;
    const reason = stopped ? `${stopped} command${stopped === 1 ? '' : 's'} stopped` : undefined;
    const object = `${files.length || group.steps.length} file${(files.length || group.steps.length) === 1 ? '' : 's'}`;
    const suffix = activityRepetitions(group.steps.length);
    return { ...group, files, searchTerms, status, reason,
      label: group.kind === 'read' ? `Read ${object}` : group.kind === 'edit' ? `Edited ${object}` : `${group.label}${suffix}`,
      liveLabel: group.kind === 'read' ? `Reading ${object}` : group.kind === 'edit' ? `Editing ${object}` : `${group.liveLabel}${suffix}`,
      command: group.steps.map(step => step.command).join('\n') };
  });
}
