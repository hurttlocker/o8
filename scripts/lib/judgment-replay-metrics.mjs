/**
 * Calibration metrics for the judgment replay (#2438).
 *
 * Every function takes rows of `{ p, y, packet }` where `p` is the predicted
 * probability of the positive class (0..1), `y` is 1 or 0, and `packet` names
 * the fold a row belongs to. Rows with a null `p` (abstains) or null `y`
 * (unlabeled) must be filtered out by the caller, which reports how many.
 */

/** Rank AUC (Mann-Whitney U), ties count half. Null without both classes. */
export function auc(rows) {
  const positives = rows.filter((row) => row.y === 1);
  const negatives = rows.filter((row) => row.y === 0);
  if (positives.length === 0 || negatives.length === 0) return null;
  let wins = 0;
  for (const positive of positives) {
    for (const negative of negatives) {
      if (positive.p > negative.p) wins += 1;
      else if (positive.p === negative.p) wins += 0.5;
    }
  }
  return wins / (positives.length * negatives.length);
}

/** Mean squared error of `p` against `y`. Null for no rows. */
export function brier(rows) {
  if (rows.length === 0) return null;
  return rows.reduce((sum, row) => sum + (row.p - row.y) ** 2, 0) / rows.length;
}

/** Ten equal-width bins on `p`; 1.0 falls in the last bin. */
export function reliabilityTable(rows, bins = 10) {
  const table = Array.from({ length: bins }, (_, index) => ({
    low: index / bins,
    high: (index + 1) / bins,
    n: 0,
    meanPredicted: null,
    observedRate: null,
  }));
  const sums = table.map(() => ({ p: 0, y: 0 }));
  for (const row of rows) {
    const index = Math.min(bins - 1, Math.max(0, Math.floor(row.p * bins)));
    table[index].n += 1;
    sums[index].p += row.p;
    sums[index].y += row.y;
  }
  table.forEach((bin, index) => {
    if (bin.n === 0) return;
    bin.meanPredicted = sums[index].p / bin.n;
    bin.observedRate = sums[index].y / bin.n;
  });
  return table;
}

/**
 * The threshold that catches every positive, fit and evaluated with
 * leave-one-packet-out. For each packet: fit the threshold on all other
 * packets (the lowest positive score there), then count false alarms and
 * misses on the held-out packet at that threshold. Never in-sample. A held-out
 * packet whose training set has no positive cannot be scored and is counted
 * separately.
 */
export function leaveOnePacketOutCatchAll(rows) {
  const packets = [...new Set(rows.map((row) => row.packet))].sort();
  const result = {
    folds: packets.length,
    scoredFolds: 0,
    falseAlarms: 0,
    negativesEvaluated: 0,
    misses: 0,
    positivesEvaluated: 0,
    rowsWithoutTrainingPositive: 0,
    thresholds: [],
  };
  for (const packet of packets) {
    const heldOut = rows.filter((row) => row.packet === packet);
    const training = rows.filter((row) => row.packet !== packet && row.y === 1);
    if (training.length === 0) {
      result.rowsWithoutTrainingPositive += heldOut.length;
      continue;
    }
    const threshold = Math.min(...training.map((row) => row.p));
    result.scoredFolds += 1;
    result.thresholds.push({ packet, threshold });
    for (const row of heldOut) {
      if (row.y === 0) {
        result.negativesEvaluated += 1;
        if (row.p >= threshold) result.falseAlarms += 1;
      } else {
        result.positivesEvaluated += 1;
        if (row.p < threshold) result.misses += 1;
      }
    }
  }
  return result;
}

/** All metrics for one label and predictor. */
export function summarize(rows) {
  const positives = rows.filter((row) => row.y === 1).length;
  return {
    n: rows.length,
    positives,
    negatives: rows.length - positives,
    auc: auc(rows),
    brier: brier(rows),
    reliability: reliabilityTable(rows),
    leaveOnePacketOut: leaveOnePacketOutCatchAll(rows),
  };
}
