/**
 * Promotion gate.
 *
 * A model is only allowed to drive trades if it clears a bar that is written
 * down *before* the numbers are seen. This is the difference between a
 * research pipeline and a random-number generator with a nice dashboard.
 *
 * Three conditions must all hold, measured out-of-sample and net of the
 * costs a real trade pays:
 *
 *  1. `brier < 0.25`          — better-calibrated than a coin flip.
 *  2. `accuracy > 0.53`       — a real, if modest, directional edge.
 *  3. `expectancy > 0`        — positive average return *after* fees and
 *                               slippage. This is the condition that matters;
 *                               a model can be well-calibrated and still lose
 *                               money on every trade it takes.
 *  4. `deflated_sharpe >= 0.95` — the edge survives being deflated for the
 *                               number of configurations tried. This is what
 *                               separates a real edge from the best of a
 *                               hundred lucky runs.
 *
 * When the gate fails, the model is still saved and still used to explain
 * what it sees — it simply never auto-trades. The app then runs the rules
 * tier, or nothing at all, and says so plainly.
 */

export const PROMOTION_BAR = {
  maxBrier: 0.25,
  minAccuracy: 0.53,
  minExpectancy: 0,
  minTrades: 30,
  minDeflatedSharpe: 0.95,
};

/**
 * @param report  aggregate stats from `backtest()` across the universe
 * @returns `{ promoted, reasons[], headline }` — `reasons` is user-facing.
 */
export function evaluate(report, bar = PROMOTION_BAR) {
  const reasons = [];
  if (report.brier >= bar.maxBrier) {
    reasons.push(`Not accurate enough (${pct(report.accuracy)} right — needs ${pct(bar.minAccuracy)}).`);
  }
  if (report.accuracy <= bar.minAccuracy) {
    reasons.push(`Its picks are no better than a guess (${pct(report.accuracy)} right).`);
  }
  if (report.expectancy <= bar.minExpectancy) {
    reasons.push("It does not make money after fees — so it will not trade automatically.");
  }
  if (report.trades < bar.minTrades) {
    reasons.push(`Not enough practice trades to trust it yet (${report.trades}).`);
  }
  // Absent significance data (too few trades to compute it) is not a pass.
  if ((report.deflated_sharpe ?? 0) < bar.minDeflatedSharpe) {
    reasons.push("Its edge could be luck rather than skill, so it will not trade on its own.");
  }
  const promoted = reasons.length === 0;
  return {
    promoted,
    reasons,
    headline: promoted
      ? "This model passed every test and may trade automatically."
      : "This model is not good enough to trade automatically yet, so it only gives ideas.",
  };
}

/**
 * The win rate a strategy needs just to break even, given how unevenly its
 * wins and losses are. A 50% win rate that wins small and loses big still
 * loses money, and this is the number that shows it.
 */
export function breakevenWinRate(trades) {
  if (!trades.length) return 0;
  const wins = trades.filter((t) => t.netReturn > 0);
  const losses = trades.filter((t) => t.netReturn <= 0);
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.netReturn, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + t.netReturn, 0) / losses.length) : 0;
  if (avgLoss === 0) return 0;
  return avgLoss / (avgWin + avgLoss);
}

function pct(x) {
  return `${Math.round((x ?? 0) * 100)}%`;
}
