import { digest, id, list, number, object, text, unique } from './harness-improvement.mjs';

const STAGES = ['proposal', 'probe', 'compose', 'selection', 'review', 'reflection'];
const BINDINGS = ['modelId', 'runtimeId', 'baselineRevision', 'verifierDigest', 'permissionsDigest'];

/** Analyze supplied receipts only. No provenance here authenticates an external run. */
export function analyzeEvidence(admission, manifest, proposals, evidence) {
  object(evidence, ['schema', 'manifestDigest', 'origin', 'costComplete', 'runs', 'costs', 'lessonTargetTask', 'lessons'], 'evidence');
  if (evidence.schema !== 'o8/harness-improvement-evidence/v1' || evidence.manifestDigest !== admission.manifestDigest) throw new Error('evidence manifest/schema mismatch');
  if (!['fixture', 'manual', 'observed'].includes(evidence.origin)) throw new Error('unknown evidence origin');
  if (typeof evidence.costComplete !== 'boolean') throw new Error('costComplete must be boolean');
  const variants = ['baseline', ...proposals.map((proposal) => proposal.id)];
  const taskOrder = [...manifest.discoveryTasks, ...manifest.heldOutTasks];
  if (!taskOrder.includes(evidence.lessonTargetTask)) throw new Error('unknown lesson target task');
  const costs = list(evidence.costs, 'costs', 1_000, 0);
  unique(costs.map((cost) => {
    object(cost, ['id', 'variantId', 'stage', 'usd', 'payer', 'tokens', 'wallMs', 'humanMs', 'attempts'], 'cost');
    id(cost.id, 'cost.id');
    if (!variants.includes(cost.variantId) || !STAGES.includes(cost.stage)) throw new Error('unknown cost variant/stage');
    for (const key of ['usd', 'tokens', 'wallMs', 'humanMs']) if (cost[key] !== null) number(cost[key], `cost.${key}`, key === 'usd' ? 1_000_000 : 1_000_000_000);
    if (cost.payer !== null) text(cost.payer, 'payer');
    number(cost.attempts, 'attempts', 1_000);
    if (!Number.isInteger(cost.attempts)) throw new Error('attempts must be a nonnegative integer');
    if (cost.attempts === 0 && (cost.stage === 'probe' || ['usd', 'tokens', 'wallMs', 'humanMs'].some((key) => cost[key] !== 0))) throw new Error('zero attempts requires an explicit zero-work non-probe receipt');
    return cost.id;
  }), 'costs');
  const runs = list(evidence.runs, 'runs', 1_000, 0);
  unique(runs.map((run) => {
    object(run, ['id', 'taskId', 'variantId', 'proposalDigest', ...BINDINGS, 'budgetDigest', 'partition', 'status', 'score', 'independent', 'verification', 'evidenceRef', 'costIds'], 'run');
    id(run.id, 'run.id');
    if (!taskOrder.includes(run.taskId) || !variants.includes(run.variantId)) throw new Error('unknown run task/variant');
    for (const key of BINDINGS) if (run[key] !== manifest[key]) throw new Error(`run ${key} mismatch`);
    if (run.budgetDigest !== digest(manifest.budget)) throw new Error('run budget mismatch');
    const expectedProposal = run.variantId === 'baseline' ? manifest.baselineRevision : admission.proposals.find((p) => p.id === run.variantId).digest;
    if (run.proposalDigest !== expectedProposal) throw new Error('run proposal digest mismatch');
    const partition = manifest.discoveryTasks.includes(run.taskId) ? 'discovery' : 'held_out';
    if (run.partition !== partition) throw new Error('run partition mismatch');
    if (!['completed', 'failed', 'inconclusive'].includes(run.status)) throw new Error('unknown run status');
    if (run.score !== null) number(run.score, 'score', 1);
    if (typeof run.independent !== 'boolean' || !['deterministic', 'human', 'model'].includes(run.verification)) throw new Error('invalid verification provenance');
    text(run.evidenceRef, 'evidenceRef', 2_000);
    unique(list(run.costIds, 'costIds', 100, 0), 'costIds');
    for (const costId of run.costIds) {
      const cost = costs.find((row) => row.id === costId);
      if (!cost || cost.variantId !== run.variantId || cost.stage !== 'probe') throw new Error('run cost reference mismatch');
    }
    return run.id;
  }), 'run IDs');
  unique(runs.map((run) => `${run.taskId}/${run.variantId}`), 'task/variant pairs');
  unique(runs.flatMap((run) => run.costIds), 'probe cost allocation');
  const reasons = [];
  const unknownCost = !evidence.costComplete || costs.some((cost) => cost.usd === null || cost.payer === null || cost.tokens === null || cost.wallMs === null || cost.humanMs === null)
    || variants.some((variant) => STAGES.some((stage) => !costs.some((cost) => cost.variantId === variant && cost.stage === stage)))
    || runs.some((run) => run.costIds.length === 0)
    || costs.some((cost) => cost.stage === 'probe' && !runs.some((run) => run.costIds.includes(cost.id)));
  const totalUsd = costs.some((cost) => cost.usd === null) ? null : costs.reduce((sum, cost) => sum + cost.usd, 0);
  const attempts = costs.reduce((sum, cost) => sum + cost.attempts, 0);
  if (unknownCost) reasons.push('Incomplete or unknown all-in cost/provenance.');
  if (totalUsd !== null && totalUsd > manifest.budget.maxUsd) reasons.push('All-in dollar budget exceeded.');
  if (attempts > manifest.budget.maxAttempts) reasons.push('All-in attempt budget exceeded.');
  const comparisons = proposals.map((proposal) => {
    const pairs = manifest.heldOutTasks.map((taskId) => {
      const baseline = runs.find((run) => run.taskId === taskId && run.variantId === 'baseline');
      const candidate = runs.find((run) => run.taskId === taskId && run.variantId === proposal.id);
      const usable = [baseline, candidate].every((run) => run && run.status === 'completed' && run.score !== null && run.independent && run.verification !== 'model');
      return { taskId, baselineReceipt: baseline?.id ?? null, candidateReceipt: candidate?.id ?? null, delta: usable ? candidate.score - baseline.score : null };
    });
    const complete = pairs.every((pair) => pair.delta !== null);
    return {
      candidateId: proposal.id, pairs,
      meanDelta: complete ? pairs.reduce((sum, pair) => sum + pair.delta, 0) / pairs.length : null,
      noRegression: complete && pairs.every((pair) => pair.delta >= 0),
    };
  });
  // Incomplete evidence for any proposed alternative cannot silently disappear.
  if (comparisons.some((row) => row.meanDelta === null)) reasons.push('Missing, failed, dependent or model-only held-out verification.');
  const ranked = comparisons.filter((row) => row.noRegression && row.meanDelta > 0).sort((a, b) => b.meanDelta - a.meanDelta);
  let selected = null;
  if (reasons.length === 0 && ranked.length && (ranked.length === 1 || ranked[0].meanDelta > ranked[1].meanDelta)) selected = ranked[0].candidateId;
  if (!selected && reasons.length === 0) reasons.push('No unique positive non-regressing candidate; keep baseline.');
  const lessons = list(evidence.lessons, 'lessons', 100, 0);
  const eligibleLessons = [];
  const excludedLessons = [];
  unique(lessons.map((lesson) => {
    object(lesson, ['id', 'candidateId', 'repository', ...BINDINGS, 'componentKey', 'sourceTaskId', 'sourceReceiptIds', 'expiresAfterTask', 'revoked', 'text'], 'lesson');
    id(lesson.id, 'lesson.id');
    text(lesson.text, 'lesson.text', 4_000);
    if (typeof lesson.revoked !== 'boolean') throw new Error('lesson.revoked must be boolean');
    unique(list(lesson.sourceReceiptIds, 'sourceReceiptIds', 100), 'lesson receipts');
    const sourceIndex = taskOrder.indexOf(lesson.sourceTaskId);
    const targetIndex = taskOrder.indexOf(evidence.lessonTargetTask);
    const expiry = taskOrder.indexOf(lesson.expiresAfterTask);
    const proposal = proposals.find((row) => row.id === lesson.candidateId);
    const valid = !lesson.revoked && lesson.repository === manifest.repository
      && BINDINGS.every((key) => lesson[key] === manifest[key])
      && proposal?.changes.some((change) => change.componentKey === lesson.componentKey)
      && sourceIndex >= 0 && sourceIndex < targetIndex && expiry >= targetIndex
      && manifest.discoveryTasks.includes(lesson.sourceTaskId)
      && lesson.sourceReceiptIds.every((ref) => runs.some((run) => run.id === ref && run.taskId === lesson.sourceTaskId && run.variantId === lesson.candidateId && run.status === 'completed' && run.score !== null && run.independent && run.verification !== 'model'));
    if (valid) eligibleLessons.push({ ...lesson, authority: 'data_only', evidenceOrigin: evidence.origin });
    else excludedLessons.push(lesson.id);
    return lesson.id;
  }), 'lessons');
  return {
    ...admission,
    schema: 'o8/harness-improvement-report/v1',
    evidenceDigest: digest(evidence),
    evidenceOrigin: evidence.origin,
    receiptsAuthenticated: false,
    decision: selected ? 'CANDIDATE_FOR_REVIEW' : 'KEEP_BASE',
    reason: selected ? 'Supplied evidence supports review of one tested candidate only; operator approval and real validation remain required.' : reasons.join(' '),
    selectedCandidate: selected,
    comparisons,
    costs: { complete: !unknownCost, totalUsd: unknownCost ? null : totalUsd, knownSubtotalUsd: costs.reduce((sum, cost) => sum + (cost.usd ?? 0), 0), attempts, entries: costs },
    lessons: eligibleLessons,
    excludedLessons,
    lessonTargetTask: evidence.lessonTargetTask,
  };
}
