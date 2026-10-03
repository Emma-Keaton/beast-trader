/**
 * Multi-model forecasting ensemble.
 *
 * Origin: `services/forecasting/` in E:\Projects\aegis-quant and
 * E:\Projects\jasper-trades, which both use a tiered forecaster as a stand-in
 * for Kronos — Holt-Winters exponential smoothing when statsmodels is
 * available, a deterministic trend model otherwise.
 *
 * Kept from that design because it is right:
 *  1. **Tiering.** No single model is trusted. Each is fitted independently and
 *     the ensemble reports disagreement as uncertainty, so a period where the
 *     models contradict each other yields a low-confidence forecast rather than
 *     a confident wrong one.
 *  2. **Sufficiency gating.** Too little history caps confidence. Forecasting
 *     from 20 candles is guessing and the model should say so.
 *
 * Changed, and why:
 *  - **Zero dependencies.** The original needs Python + statsmodels. This is
 *    pure JS so it runs in the free Render tier beside everything else.
 *  - **Holt-Winters is implemented, not delegated**, with smoothing parameters
 *    chosen by walk-forward error rather than assumed.
 *  - **Confidence comes from out-of-sample error**, not a heuristic blend of
 *    trend strength and volatility that produces confident numbers on series it
 *    was never validated against.
 *  - **A mean-reversion tier was added and then demoted to a non-voting
 *    observer.** It was added on the plausible-sounding premise that crypto
 *    "ranges most of the time", so a fade-the-stretch model would balance the
 *    trend model. Nine years of this app's own history says the opposite:
 *    stretched prices *continue* (0.564 continuation at 2σ+ over 30d). The
 *    premise was wrong, so the member now reports its view without voting on it,
 *    and `fitTrendDistance` holds the vote with the sign the data supports.
 *    This is the clearest case in the codebase of why a model here must earn its
 *    weight rather than be assigned one.
 *
 * Every model emits a **probability that the horizon close is above the
 * current close**, not a raw price path — that is the quantity the trading
 * system needs, and converting at the end keeps models comparable.
 */

/* ── Small statistical helpers ────────────────────────────────────────────── */

function mean(xs) {
  if (!xs.length) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function std(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return Math.sqrt(s / (xs.length - 1));
}

function median(xs) {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

/** Standard normal CDF — the same approximation used in stats.js. */
function normalCDF(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t *
      Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

/** Log returns, guarding non-positive prices. */
function logReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) out.push(Math.log(closes[i] / closes[i - 1]));
  }
  return out;
}

/* ── Model 1: Holt-Winters (level + trend, optional seasonality) ──────────── */

/**
 * Fit Holt's linear trend, optionally with additive seasonality.
 *
 * The smoothing parameters are chosen by walk-forward validation rather than
 * assumed: fit on a prefix, score what follows. This matters more than it
 * sounds — the usual defaults (0.9, 0.1) over-react to the last candle on a
 * noisy hourly series and produce forecasts that are confidently wrong.
 */
function holtWinters(values, { alpha, beta, gamma = 0, period = 0 } = {}) {
  if (values.length < 8) return null;
  const season = period >= 2 ? period : 0;
  const a = alpha ?? 0.5;
  const b = beta ?? 0.1;
  const g = gamma ?? 0;

  let level = values[0];
  let trend = values.length > 1 ? values[1] - values[0] : 0;
  const seasonal = season ? new Array(season).fill(0) : null;
  if (seasonal) {
    const cycles = Math.floor(values.length / season);
    for (let s = 0; s < season; s++) {
      const idx = [];
      for (let c = 0; c < cycles; c++) idx.push(values[c * season + s]);
      seasonal[s] = idx.length ? mean(idx) : 0;
    }
    // Centre the indices so seasonality shifts the path, not the level.
    const sm = mean(seasonal);
    for (let s = 0; s < season; s++) seasonal[s] -= sm;
    level = values[season] ?? level;
  }

  const fitted = [];
  for (let t = 0; t < values.length; t++) {
    const sIdx = seasonal ? t % season : 0;
    const lastLevel = level;
    const lastTrend = trend;
    fitted.push(level + lastTrend + (seasonal ? seasonal[sIdx] : 0));
    const err = values[t] - fitted[t];
    if (seasonal) seasonal[sIdx] += g * err;
    level = a * (values[t] - (seasonal ? seasonal[sIdx] : 0)) + (1 - a) * (lastLevel + lastTrend);
    trend = b * (level - lastLevel) + (1 - b) * lastTrend;
  }

  const resid = values.map((v, i) => v - fitted[i]);
  const self = {
    level,
    trend,
    seasonal,
    residStd: Math.max(std(resid), 1e-9),
    /** Expected value `h` steps ahead, in the series' own units. */
    at(h) {
      const sIdx = seasonal ? (values.length + h - 1) % season : 0;
      return self.level + h * self.trend + (seasonal ? self.seasonal[sIdx] : 0);
    },
  };
  return self;
}

/** Choose Holt-Winters parameters by walk-forward RMSE, and return the fit. */
function fitHoltWinters(values, horizon) {
  const alphas = [0.2, 0.35, 0.5, 0.7, 0.9];
  const betas = [0.02, 0.05, 0.1, 0.25];
  // Seasonality is only meaningful when several whole cycles are present.
  const periods = [0, 24];
  const minSeason = 60;
  const hold = Math.min(horizon, Math.floor(values.length / 4));

  let best = null;
  for (const alpha of alphas) {
    for (const beta of betas) {
      for (const period of periods) {
        if (period && values.length < minSeason + period) continue;
        if (hold < 2) return null;
        const train = values.slice(0, values.length - hold);
        const holdout = values.slice(values.length - hold);
        const wf = holtWinters(train, { alpha, beta, period });
        if (!wf) continue;
        // Score on relative error, so a coin with a different price level is
        // comparable to one at $100.
        let err = 0;
        const scale = values[values.length - 1] || 1;
        for (let h = 1; h <= holdout.length; h++) {
          const d = (holdout[h - 1] - wf.at(h)) / scale;
          err += d * d;
        }
        const rmse = Math.sqrt(err / holdout.length);
        if (!best || rmse < best.rmse) best = { alpha, beta, period, rmse };
      }
    }
  }
  if (!best) return null;
  const fit = holtWinters(values, best);
  return fit ? { fit, rmse: best.rmse, ...best } : null;
}

/* ── Model 2: drift (random walk with drift) ──────────────────────────────── */

/**
 * A random walk with drift — the honest null model.
 *
 * Included deliberately: it is what "no edge" looks like, so every other model
 * has to beat it. A trend model that cannot beat a random walk is not a model,
 * and including this makes that visible instead of hiding it.
 */
function fitDrift(values, horizon) {
  const rets = logReturns(values);
  if (rets.length < 5) return null;
  const mu = mean(rets);
  const sigma = Math.max(std(rets), 1e-9);
  const hold = Math.min(horizon, Math.floor(values.length / 4));
  if (hold < 2) return { mu, sigma, rmse: null };
  const train = values.slice(0, values.length - hold);
  const holdout = values.slice(values.length - hold);
  let err = 0;
  for (let h = 1; h <= holdout.length; h++) {
    const pred = train[train.length - 1] * Math.exp(mu * h);
    const d = (holdout[h - 1] - pred) / (values[values.length - 1] || 1);
    err += d * d;
  }
  return { mu, sigma, rmse: Math.sqrt(err / holdout.length) };
}

/* ── Model 3: mean reversion ──────────────────────────────────────────────── */

/**
 * Fades moves that are large relative to their own recent distribution.
 *
 * Crypto trends and reverts within the same week, so a pure trend model is
 * structurally wrong half the time. This one buys the exhaustion of a stretched
 * price and stands down when price sits near the middle of its range, where
 * there is nothing to fade.
 */
function fitMeanReversion(values, lookback = 48) {
  if (values.length < lookback + 5) return null;
  const win = values.slice(-lookback);
  const mu = mean(win);
  const sigma = Math.max(std(win), 1e-9);
  const z = (values[values.length - 1] - mu) / sigma;
  // Only act on genuinely stretched prices.
  if (Math.abs(z) < 1.2) return { z: 0, strength: 0, active: false };
  return {
    z,
    active: true,
    // Reversion of a z of 2 gets roughly halfway back to the mean.
    strength: -Math.sign(z) * Math.min(1, (Math.abs(z) - 1.2) / 2),
  };
}

/* ── Model 4: trend distance (continuation) ───────────────────────────────── */

/**
 * The deviation-from-mean signal that the 9-year research pass actually
 * supported, and the direct opposite of Model 3.
 *
 * `scripts/research.js` measured, over 3,332 aligned daily bars, whether a price
 * sitting far from its own 20-day mean tends to revert or to keep going. It
 * keeps going, and the effect strengthens with distance:
 *
 *   |dev20| 0-0.5σ -> 0.509 continuation at 30d
 *   |dev20| 2σ+    -> 0.564 continuation at 30d   (net +2.90% after costs, t=+2.0)
 *   best single result in the study: net +0.73% at 7d, t=+3.0
 *
 * So the honest reading of "price is stretched" in crypto is *continuation*, not
 * exhaustion. Model 3 bets the other way, which is why it is demoted below.
 *
 * The same study is equally clear about the limit: at 7 days the continuation
 * rate is ~0.50 in every bucket. This member carries information over weeks, not
 * over days, so a caller at a 3-bar horizon should expect it to be near a coin
 * flip and should not read its vote as agreement.
 */
function fitTrendDistance(closes, lookback = 20) {
  if (closes.length < lookback + 5) return null;
  const win = closes.slice(-lookback);
  const mu = mean(win);
  const sigma = Math.max(std(win), 1e-9);
  if (!(mu > 0)) return null;
  const last = closes[closes.length - 1];
  const z = (last - mu) / sigma;
  // Sign carries the direction; magnitude saturates at 2σ so one extreme day
  // cannot make this the loudest vote in the room.
  const strength = clamp(z / 2, -1, 1);
  return { z: Number(z.toFixed(3)), strength };
}

/* ── Model 5: volatility ──────────────────────────────────────────────────── */

/**
 * Forecast the per-bar return volatility over the next `horizon` bars.
 *
 * This is the most surprising result of the research pass and the single most
 * useful one. Cross-sectionally, predicting next-week volatility from an EWMA
 * estimate has rank IC **0.187** — roughly six times the strongest *directional*
 * signal found, and the only quantity in the whole study that is predictable with
 * any confidence.
 *
 * That matters for a different reason than direction does. You do not need to
 * know where price is going to improve expectancy: sizing down when the next
 * week is likely to be violent, and declining to trade at all when the spread
 * and fees exceed what that week is likely to move, is profitable with zero
 * directional skill. So this is exported as a first-class forecast rather than
 * folded into a probability nobody asked for.
 *
 * EWMA of squared log returns (RiskMetrics-style, λ=0.94) with a per-bar
 * sqrt(horizon) scaling. Deliberately not GARCH: it needs no optimiser, has no
 * failure mode on short series, and on this data the gap is not worth the risk.
 */
export function forecastVolatility(closes, { horizon = 1, lambda = 0.94 } = {}) {
  const rets = logReturns(closes);
  if (rets.length < 10) return null;
  let varSum = 0;
  let wSum = 0;
  for (let i = rets.length - 1, w = 1; i >= 0 && w > 1e-4; i--, w *= lambda) {
    varSum += w * rets[i] * rets[i];
    wSum += w;
  }
  if (!(wSum > 0)) return null;
  const perBar = Math.sqrt(varSum / wSum);
  const h = Math.max(1, Math.floor(horizon));
  // Median absolute return is the robust companion figure: the EWMA is
  // quadratic, so a single flash crash inflates it far more than reality.
  const medAbs = median(rets.slice(-60).map(Math.abs));
  return {
    perBar: Number(perBar.toFixed(6)),
    overHorizon: Number((perBar * Math.sqrt(h)).toFixed(6)),
    medianAbsReturn: Number(medAbs.toFixed(6)),
    horizon: h,
    samples: rets.length,
  };
}

/* ── Ensemble ─────────────────────────────────────────────────────────────── */

/** One model's view: P(close higher in `horizon` bars), and how much to trust it. */
function modelVote({ probUp, weight, label, rmse }) {
  return { label, probUp: clamp(probUp, 0.01, 0.99), weight: Math.max(0, weight), rmse };
}

/**
 * Strategic horizon, in the bars the caller supplies.
 *
 * Set by measurement, not taste. The research pass found the trend signal is
 * real at 7-30 days (net +0.73% at 7d, t=+3.0; +2.90% at 30d, t=+2.0) and is a
 * coin flip at every bucket at 3-7 days. The ensemble used to default to
 * `horizon: 3` on **daily** bars, i.e. it was asked about three days when the
 * pattern it keys on needs two to four weeks to express. Forecasting too early
 * is not a small inaccuracy — it is reading noise and calling it conviction,
 * which is the mechanism behind the confident-and-wrong behaviour.
 *
 * Keep a short horizon for entry timing. Do not use one for the directional call.
 */
export const STRATEGIC_HORIZON = 14;

/**
 * Recalibrate a raw conviction score against realised outcomes.
 *
 * The ensemble's confidence used to be `|p - 0.5| x (1 - disagreement)`, which
 * measures how far the models are from a coin flip and nothing else. The research
 * pass found that on the app's own history this number was *anti-correlated* with
 * being right: the more confident the ensemble was, the worse it did, because it
 * was most confident exactly when price had run hardest from its fitted level.
 *
 * So confidence is now an obligation rather than a claim: given past calls made at
 * each conviction level, what fraction were actually right? `scoreboard.js` holds
 * those outcomes. A model that was right 45% of the time when "confident" gets a
 * confidence near zero, not a number that flatters it.
 *
 * Returns null when there is not enough history to have an opinion, which the
 * caller must handle as "unknown", never as "high".
 */
export function calibrateConfidence(raw, outcomes) {
  if (!Number.isFinite(raw)) return null;
  const rows = Array.isArray(outcomes) ? outcomes.filter((o) => Number.isFinite(o?.conviction) && typeof o?.hit === "boolean") : [];
  // Fewer than this and any monotone map is fitting noise.
  if (rows.length < 30) return null;
  // Rank-based (isotonic-style) calibration: sort by conviction and compare the
  // hit rate of everything at or below this call's conviction against the raw
  // claim. Rank-based survives outliers that a bucketed mean would not.
  const sorted = [...rows].sort((a, b) => a.conviction - b.conviction);
  const upTo = sorted.filter((o) => o.conviction <= raw);
  if (upTo.length < 15) return null;
  const hitRate = upTo.reduce((s, o) => s + (o.hit ? 1 : 0), 0) / upTo.length;
  // Map the realised hit rate onto [0,1] around the coin flip, so 50% realised
  // accuracy yields zero confidence whatever the model's own score said.
  const mapped = clamp((hitRate - 0.5) * 4, 0, 1);
  const n = upTo.length;
  // Shrink toward zero with sample size: 30 observations of a 55% hit rate is a
  // hint, not a property of the universe (standard error alone is ~9%).
  const shrink = clamp(Math.log10(n / 30) / Math.log10(10), 0, 1);
  return Number((mapped * shrink).toFixed(4));
}

/**
 * Forecast the probability that the price is higher `horizon` bars from now.
 *
 * @param closes oldest-first close prices
 * @param opts   `{ horizon, minHistory, reversionWeight, trendWeight, outcomes }`
 * @returns a forecast, or `{ ok: false }` when there is too little data
 */
export function forecast(closes, opts = {}) {
  const horizon = opts.horizon ?? STRATEGIC_HORIZON;
  const minHistory = opts.minHistory ?? 30;
  // Both default to the evidence: continuation is supported, reversion is not.
  const reversionWeight = opts.reversionWeight ?? 0;
  const trendWeight = opts.trendWeight ?? 1;
  const last = Array.isArray(closes) ? closes[closes.length - 1] : null;

  if (!Array.isArray(closes) || closes.length < minHistory || !(last > 0)) {
    return {
      ok: false,
      reason: `need at least ${minHistory} closes, got ${Array.isArray(closes) ? closes.length : 0}`,
      probUp: 0.5,
      confidence: 0,
    };
  }

  const votes = [];

  // 1. Trend, if a walk-forward fit exists.
  const hw = fitHoltWinters(closes, horizon);
  if (hw) {
    const sigma = hw.fit.residStd * Math.sqrt(horizon) || 1e-9;
    // Convert the point forecast into a probability: how many standard errors
    // above the current price does the ensemble expect to be?
    const z = (hw.fit.at(horizon) - last) / sigma;
    // A model that could not beat nothing carries no weight. 5% relative RMSE
    // is the point at which a forecast is worth roughly nothing.
    const skill = hw.rmse == null ? 0.3 : clamp(1 - hw.rmse / 0.05, 0, 1);
    votes.push(modelVote({ probUp: normalCDF(z), weight: skill, label: "holt-winters", rmse: hw.rmse }));
  }

  // 2. Drift (the null model), so the trend model has something to beat.
  const drift = fitDrift(closes, horizon);
  if (drift) {
    const z = (drift.mu * horizon) / (drift.sigma * Math.sqrt(horizon) || 1e-9);
    const skill = drift.rmse == null ? 0.3 : clamp(1 - drift.rmse / 0.05, 0, 1);
    votes.push(modelVote({ probUp: normalCDF(z), weight: skill, label: "drift", rmse: drift.rmse }));
  }

  if (!votes.length) {
    return { ok: false, reason: "no model could be fitted", probUp: 0.5, confidence: 0 };
  }

  // 3. Mean reversion — DEMOTED, and deliberately kept out of the vote by default.
  //
  // The research pass contradicts this member outright. Over 9 years of daily
  // bars, stretched prices continue rather than fade (0.564 continuation at 2σ+
  // over 30d), so a member whose whole premise is "fade the stretch" is not a
  // hedge here — it is a systematic drag pointed the wrong way, and it was
  // carrying a fixed weight of 0.5 with no evidence behind it.
  //
  // It stays fitted and reported, because disagreement is still information and
  // because if a venue or regime ever does mean-revert, the scoreboard will show
  // it and `reversionWeight` can be raised from the caller. The default is zero:
  // an unproven member gets no vote, exactly like every trading model here.
  const mr = fitMeanReversion(closes);
  let reversion = null;
  if (mr?.active) {
    const mrProb = normalCDF(mr.strength * 2.2);
    reversion = { probUp: mrProb, z: mr.z };
    if (reversionWeight > 0) {
      votes.push(modelVote({ probUp: mrProb, weight: reversionWeight, label: "mean-reversion", rmse: null }));
    }
  }

  // 4. Trend distance — the continuation signal, the opposite sign to Model 3.
  //    Weighted by how far price actually sits from its mean, so near the middle
  //    it contributes nothing rather than a confident shrug.
  const td = fitTrendDistance(closes);
  let trendDistance = null;
  if (td) {
    trendDistance = { z: td.z, strength: td.strength };
    if (td.strength !== 0) {
      votes.push(
        modelVote({
          probUp: normalCDF(td.strength * 2.2),
          weight: Math.min(1, Math.abs(td.z) / 2) * trendWeight,
          label: "trend-distance",
          rmse: null,
        }),
      );
    }
  }

  const totalWeight = votes.reduce((s, v) => s + v.weight, 0);
  // If every model was shown to have no skill, fall back to an equal-weight
  // blend. The honest answer is "no view", not a division by zero.
  const probUp =
    totalWeight > 1e-9
      ? votes.reduce((s, v) => s + v.probUp * v.weight, 0) / totalWeight
      : votes.reduce((s, v) => s + v.probUp, 0) / votes.length;

  // Disagreement is the uncertainty signal. When the models spread apart, the
  // forecast is worth less, and confidence must fall with it.
  const spread = Math.max(...votes.map((v) => v.probUp)) - Math.min(...votes.map((v) => v.probUp));
  const conviction = Math.abs(probUp - 0.5) * 2;
  const rawConfidence = clamp(conviction * (1 - spread / 2), 0, 1);
  // Prefer the evidence. Where realised outcomes exist, they overrule the model's
  // self-assessment outright — including when they say the model is worse than a
  // coin flip, which is precisely the case the old formula got wrong.
  const calibrated = calibrateConfidence(rawConfidence, opts.outcomes);
  const confidence = calibrated === null ? rawConfidence : calibrated;
  const vol = forecastVolatility(closes, { horizon });

  return {
    ok: true,
    probUp: Number(clamp(probUp, 0.01, 0.99).toFixed(4)),
    confidence: Number(confidence.toFixed(4)),
    rawConfidence: Number(rawConfidence.toFixed(4)),
    // False whenever the self-assessment was overruled or unverified, so a
    // caller can tell an earned confidence from an assumed one at a glance.
    confidenceCalibrated: calibrated !== null,
    horizon,
    last,
    models: votes.map((v) => ({
      label: v.label,
      probUp: Number(v.probUp.toFixed(4)),
      weight: Number(v.weight.toFixed(4)),
      rmse: v.rmse == null ? null : Number(v.rmse.toFixed(5)),
    })),
    disagreement: Number(spread.toFixed(4)),
    reversionZ: reversion ? Number(reversion.z.toFixed(3)) : null,
    trendDistanceZ: trendDistance ? trendDistance.z : null,
    volatility: Number((drift ? drift.sigma : 0).toFixed(6)),
    volForecast: vol,
    /**
     * The cost wall: expected move over the horizon vs the round-trip cost of
     * trading. When costs exceed what the horizon is likely to move, no signal
     * can be monetised here regardless of direction, and the correct action is
     * to not trade. This is the one use of the volatility forecast that needs no
     * directional skill at all.
     */
    tradable: vol ? vol.overHorizon > (opts.roundTripCostBps ?? 34) / 1e4 : true,
    medianAbsReturn: Number(median(logReturns(closes).map(Math.abs)).toFixed(6)),
  };
}

/**
 * Turn a forecast into the app's standard prediction shape.
 *
 * Deliberately kept separate so the ensemble can be scored and ranked as its own
 * model alongside the logistic one, rather than being special-cased into the
 * prediction path where it could never be compared against anything.
 */
export function toPrediction(f) {
  if (!f?.ok) {
    return {
      signal: "HOLD",
      probability: 0.5,
      confidence: 0,
      basis: "ensemble",
      features: null,
      reason: f?.reason ?? "forecast unavailable",
    };
  }
  return {
    signal: !f.tradable ? "HOLD" : f.probUp > 0.55 ? "LONG" : f.probUp < 0.45 ? "SHORT" : "HOLD",
    probability: f.probUp,
    confidence: f.confidence,
    basis: "ensemble",
    // The contract requires a horizon, and the ensemble's is genuinely different
    // from the logistic model's: that one predicts the next daily bar (24h), this
    // one predicts STRATEGIC_HORIZON bars ahead. Omitting it let the UI print one
    // horizon label over two different claims.
    horizon: `${f.horizon}d`,
    // The ensemble is a price-path forecaster, so it has no learned feature
    // vector to record. It is scored on Brier and hit rate instead, and it must
    // not masquerade as a feature-based model in the ledger.
    features: null,
    // Two independent reasons to stand down, stated separately because they mean
    // different things: `tradable: false` is "the costs exceed the expected move",
    // which no signal can overcome; low conviction is "we do not know the
    // direction", which more data might. The first is a property of the venue.
    reason: !f.tradable
      ? `stand down: expected ${f.horizon}-bar move ${(f.volForecast.overHorizon * 100).toFixed(2)}% does not clear round-trip cost`
      : `ensemble P(up)=${(f.probUp * 100).toFixed(1)}% over ${f.horizon} bars ` +
        `(${f.models.map((m) => m.label).join("+")}, disagreement ${(f.disagreement * 100).toFixed(0)}%)` +
        (f.confidenceCalibrated ? "" : ", confidence uncalibrated"),
    stop_price: null,
    target_price: null,
  };
}