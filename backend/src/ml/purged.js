/**
 * Purged cross-validation, from López de Prado (AFML ch. 7).
 *
 * The problem this solves: a training row is not a single point in time, it is
 * an *interval* — the feature bar at `t` plus the label window that follows it.
 * A plain chronological split trains on a row whose label window reaches
 * straight into the test set, so the model has already seen the answer it is
 * being asked to predict. On a 3-day horizon that is a 3-day leak, and it is
 * the most common way a crypto backtest lies to you.
 *
 * Two mechanisms, both implemented here:
 *  - **Purge**: drop any training row whose label window overlaps the test
 *    window at all.
 *  - **Embargo**: additionally drop rows immediately *after* the test window,
 *    because serial correlation means the bar right after a test set still
 *    carries information about it.
 *
 * The reference implementations are `purgedcv` (MIT) and `skfolio`'s
 * `CombinatorialPurgedCV` (BSD-3); both are Python, so the maths is
 * reimplemented here in dependency-free JS.
 */

/** A labelled row with its label window resolved to bar indices. */
export function makeEvent(index, horizon) {
  return { index, start: index, end: index + horizon };
}

/**
 * Do two label windows overlap? Uses the closed-interval test from AFML: an
 * event is purged when `max(start) <= min(end)`. Touching endpoints count as
 * overlapping, which is correct — a row whose label ends on the first test bar
 * shares that bar's price.
 */
export function windowsOverlap(a, b) {
  return Math.max(a.start, b.start) <= Math.min(a.end, b.end);
}

/**
 * One purged, embargoed train/test split.
 *
 * @param events   rows in chronological order, each {index,start,end}
 * @param testStart first test row index
 * @param testEnd   last test row index (inclusive)
 * @param embargo   extra rows after the test block to drop from training
 */
export function purgedSplit(events, testStart, testEnd, embargo = 0) {
  const test = events.slice(testStart, testEnd + 1);
  if (!test.length) throw new Error("purgedSplit: empty test block");

  // Purging is only sound if label windows really are `[t, t+horizon]`. A bug
  // in the labeller would otherwise silently reintroduce leakage, so the
  // assumption is checked rather than documented and hoped for.
  const widths = new Set(test.map((e) => e.end - e.start));
  if (widths.size > 1) {
    throw new Error(`purgedSplit: label windows are not a fixed horizon (widths: ${[...widths].join(",")})`);
  }

  const testMinStart = Math.min(...test.map((e) => e.start));
  const testMaxEnd = Math.max(...test.map((e) => e.end));
  const train = [];

  for (const e of events) {
    if (e.index >= testStart && e.index <= testEnd) continue;
    if (windowsOverlap(e, { start: testMinStart, end: testMaxEnd })) continue;
    // Embargo: rows just past the test block, where serial correlation still
    // leaks the test outcome into the training set.
    if (e.start > testMaxEnd && e.start <= testMaxEnd + embargo) continue;
    train.push(e.index);
  }

  return { trainIndices: train, testIndices: test.map((e) => e.index) };
}

/**
 * Combinatorial Purged Cross-Validation: CPCV(N, k).
 *
 * The series is cut into N contiguous groups; every combination of k groups
 * becomes a test set, and the rest becomes training data (purged and
 * embargoed). The resulting many-path estimate is far more stable than a
 * single split, which is the entire reason AFML recommends it.
 *
 * @returns array of splits, length C(N, k)
 */
export function combinatorialPurgedCV(events, nGroups = 6, k = 2, embargo = 0) {
  const N = Math.min(nGroups, events.length);
  if (N < 2 || k < 1 || k >= N) throw new Error("combinatorialPurgedCV: need 1 <= k < N <= events.length");

  const size = Math.floor(events.length / N);
  const groups = [];
  for (let g = 0; g < N; g++) {
    const from = g * size;
    const to = g === N - 1 ? events.length - 1 : from + size - 1;
    groups.push([from, to]);
  }

  const splits = [];
  for (const combo of combinations(N, k)) {
    const testRanges = combo.map((g) => groups[g]);
    const testIndices = [];
    for (const [a, b] of testRanges) for (let i = a; i <= b; i++) testIndices.push(events[i].index);
    testIndices.sort((a, b) => a - b);

    // Purge against the *union* of the chosen test blocks, not just one.
    const maxTestEnd = Math.max(...testRanges.map(([, b]) => events[b].end));
    const trainIndices = [];
    for (const e of events) {
      if (testIndices.includes(e.index)) continue;
      const clashes = testRanges.some(([a, b]) =>
        windowsOverlap(e, { start: events[a].start, end: events[b].end }),
      );
      if (clashes) continue;
      if (e.start > maxTestEnd && e.start <= maxTestEnd + embargo) continue;
      trainIndices.push(e.index);
    }

    splits.push({ trainIndices, testIndices });
  }
  return splits;
}

/** All k-combinations of 0..n-1, in order. */
export function combinations(n, k) {
  const out = [];
  const current = [];
  (function walk(start) {
    if (current.length === k) {
      out.push([...current]);
      return;
    }
    for (let i = start; i < n; i++) {
      current.push(i);
      walk(i + 1);
      current.pop();
    }
  })(0);
  return out;
}

/**
 * Rebuild the single equity path that CPCV implies.
 *
 * Each observation is tested by C(N-1, k-1) of the splits, so its return is
 * divided by that multiplicity — the same reconstruction as
 * `reconstruct_paths()` in `purgedcv`. Without this, overlapping test sets
 * would count the same trade many times and inflate every metric.
 */
export function reconstructPath(splits, returnsByIndex) {
  const counts = new Map();
  for (const s of splits) for (const i of s.testIndices) counts.set(i, (counts.get(i) ?? 0) + 1);

  const path = [];
  let equity = 1;
  for (const [i, n] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
    const r = returnsByIndex.get(i);
    if (r == null || n === 0) continue;
    equity *= 1 + r / n;
    path.push({ index: i, ret: r / n, equity });
  }
  return path;
}
