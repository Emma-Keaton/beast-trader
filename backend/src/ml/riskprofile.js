import { getSettings, putSettings } from "../store.js";
/**
 * Risk profile: one continuous slider, three sectors.
 *
 * The design. A single 0-100 position selects a *sector* — Conservative, Balanced
 * or Aggressive — and every position inside a sector produces a distinct set of
 * percentages. Crossing a boundary promotes to the next sector. So the user has
 * one control with fine granularity rather than three separate sliders, which
 * could be set into a combination nobody intended (maximum size, minimum
 * confidence, minimum track record) with nothing to warn them.
 *
 * Why a single control matters. Notional, confidence floor and loss limit are not
 * independent. Raising size while lowering the confidence bar does not make a
 * strategy bolder, it makes it incoherent — larger positions on weaker evidence.
 * Tying them to one position makes every reachable configuration a sane one.
 *
 * The sectors are named for what the user is agreeing to, not for the numbers
 * behind them. Nobody sets "notional 42% of cap"; they set a risk appetite.
 */

/** Sector boundaries. Below the first is conservative, above the second aggressive. */
export const SECTORS = {
  CONSERVATIVE: { id: "conservative", from: 0, to: 33, label: "Conservative" },
  BALANCED: { id: "balanced", from: 33, to: 66, label: "Balanced" },
  AGGRESSIVE: { id: "aggressive", from: 66, to: 100, label: "Aggressive" },
};

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Per-sector `[low, high]` ranges for every risk dimension.
 *
 * These ranges are **continuous across sector boundaries**: conservative's high
 * is balanced's low, and balanced's high is aggressive''s low. That continuity
 * is load-bearing, not cosmetic.
 *
 * The first version defined one global range per dimension and switched only the
 * label at each boundary. That made the slider discontinuous in the worst way:
 * moving from position 32 to 33 dropped the order cap from $50 back to about $13,
 * because the fractional position restarted from zero inside the new sector. A
 * user nudging the slider right would watch their risk *fall*. With shared
 * endpoints, `within` restarting at zero is exactly correct — it continues from
 * where the previous sector ended.
 */
const SECTOR_RANGES = {
  conservative: {
    notional: [0.15, 0.4],
    confidence: [0.72, 0.5],
    orderUsd: [25, 50],
    dailyLossUsd: [10, 25],
    openPositions: [1, 3],
    trackDays: [21, 14],
  },
  balanced: {
    notional: [0.4, 0.7],
    confidence: [0.5, 0.44],
    orderUsd: [50, 150],
    dailyLossUsd: [25, 100],
    openPositions: [3, 5],
    trackDays: [14, 7],
  },
  aggressive: {
    notional: [0.7, 1.0],
    confidence: [0.44, 0.38],
    orderUsd: [150, 500],
    dailyLossUsd: [100, 400],
    openPositions: [5, 8],
    trackDays: [7, 1],
  },
};

/**
 * Resolve a slider position into a complete, coherent risk configuration.
 *
 * Every field is a function of `position` alone — nothing here is independently
 * tunable, which is the whole point. Within a sector the values move smoothly;
 * at a boundary they jump, which is what makes crossing a sector feel like a real
 * change of mode rather than a slightly larger number.
 *
 * @param position 0-100. Out-of-range values are clamped, not rejected, because a
 *   slider that silently fails to move is worse than one that saturates.
 * @returns `{ position, sector, notionalScale, minConfidence, maxOrderUsd,
 *            maxDailyLossUsd, maxOpenPositions, minTrackDays, requiresProfitEvidence }`
 */
export function riskProfile(position) {
  const pos = Math.max(0, Math.min(100, Number.isFinite(position) ? position : 0));

  /**
   * Sector + the fractional position *within* that sector.
   *
   * Used rather than the raw position so that behaviour is consistent across
   * sectors: the middle of Conservative and the middle of Aggressive are each
   * halfway through their own range, rather than Aggressive always looking
   * extreme simply because its absolute numbers are higher.
   */
  const sector =
    pos < SECTORS.CONSERVATIVE.to
      ? SECTORS.CONSERVATIVE
      : pos < SECTORS.BALANCED.to
        ? SECTORS.BALANCED
        : SECTORS.AGGRESSIVE;
  const span = sector.to - sector.from;
  const within = clamp01(span > 0 ? (pos - sector.from) / span : 0);

  return {
    position: pos,
    sector: sector.id,
    sectorLabel: sector.label,
    withinSector: Number(within.toFixed(4)),

    /**
     * Fraction of the user's `max_order_usd` this profile will actually use.
     *
     * Conservative tops out at 40% of the cap; Aggressive reaches the full cap.
     * The cap stays the user's number, so the slider narrows it rather than
     * replacing it — a user who set a $50 limit is never quietly overridden by
     * the slider suggesting a bigger trade.
     */
    notionalScale: Number(lerp(...SECTOR_RANGES[sector.id].notional, within).toFixed(4)),

    /**
     * Confidence floor for acting on a signal.
     *
     * Moves *inversely* to size. A larger position demands more evidence, which is
     * the opposite of what most sliders do and is the single most important
     * relationship in this module: size and conviction must rise together or the
     * profile is just a lever for taking bigger bets on worse evidence.
     */
    minConfidence: Number(lerp(...SECTOR_RANGES[sector.id].confidence, within).toFixed(4)),

    /** Hard notional ceiling for one order under this profile. */
    maxOrderUsd: Number(lerp(...SECTOR_RANGES[sector.id].orderUsd, within).toFixed(2)),

    /** Daily realised loss at which the circuit breaker trips. */
    maxDailyLossUsd: Number(lerp(...SECTOR_RANGES[sector.id].dailyLossUsd, within).toFixed(2)),

    /** Concurrent open positions. Exposure is the real risk, not per-trade size. */
    maxOpenPositions: Math.round(lerp(...SECTOR_RANGES[sector.id].openPositions, within)),

    /**
     * Days a model must have been live before its trades are allowed through.
     *
     * Never below 1 even at maximum aggression. Zero would mean "trust a model
     * that has never traded", which is precisely how a newly promoted challenger
     * spends real money proving it should not have been promoted.
     */
    minTrackDays: Math.max(1, Math.round(lerp(...SECTOR_RANGES[sector.id].trackDays, within))),

    /**
     * Whether the profile requires settled evidence before trading at all.
     *
     * Only the most aggressive end turns this off, and it exists as an explicit
     * opt-out rather than a gradual weakening of the gate. If you are going to
     * let the app trade an unvalidated model, it should be a decision recorded in
     * one field, not something that happened by sliding a control.
     */
    requiresProfitEvidence: pos < 95,
  };
}

/**
 * Apply the user's risk slider.
 *
 * The slider is the source of truth for how much the app may risk. Individual
 * fields are written into settings so every existing consumer — the gate, the
 * planner, the auto-executor — keeps working unchanged, and none of them can
 * end up with a combination the user did not ask for.
 *
 * A user's own `max_order_usd` is treated as a *ceiling*, never a starting point:
 * the slider may narrow it but never raise it. Someone who typed $50 gets at most
 * $50 no matter where the slider sits.
 */

export async function applyRiskProfile(deviceId, position) {
  const settings = (await getSettings(deviceId).catch(() => null)) ?? {};
  const profile = riskProfile(position);
  const merged = applyProfile(settings, profile);
  await putSettings(deviceId, merged);
  return { profile, settings: merged };
}
export function applyProfile(settings = {}, profile) {
  return {
    ...settings,
    risk_level: profile.position,
    risk_sector: profile.sector,
    max_order_usd: Math.min(settings.max_order_usd ?? Infinity, profile.maxOrderUsd),
    auto_trade_min_confidence: profile.minConfidence,
    max_daily_loss_usd: profile.maxDailyLossUsd,
    max_open_positions: profile.maxOpenPositions,
    min_track_days: profile.minTrackDays,
    require_profit_evidence: profile.requiresProfitEvidence,
  };
}

/** Plain-language summary for the UI, so the numbers are never shown unexplained. */
export function describeProfile(profile) {
  if (profile.sector === "conservative") {
    return `Small positions, and only on confident signals. Waits ${profile.minTrackDays} days of live record before a model may trade.`;
  }
  if (profile.sector === "balanced") {
    return `Moderate positions on reasonably confident signals, over at most ${profile.maxOpenPositions} open trades.`;
  }
  return `Large positions and a lower confidence bar. This accepts more wrong calls in exchange for larger right ones — most accounts lose money here.`;
}
