/**
 * Deterministic synthetic market generator for tests.
 *
 * Tests must never hit the network: they need to be fast, offline and
 * identical on every machine. A seeded PRNG plus a regime-switching price
 * process gives us a series with realistic properties — trends, noise,
 * volatility clustering — without depending on a real coin's history.
 */

import { mulberry32 } from "./logistic.js";

/**
 * @param n    number of bars
 * @param opts `{ seed, drift, vol, regimeEvery, startPrice }`
 * @returns bars oldest-first, same shape the live pipeline consumes
 */
export function synthBars(n, opts = {}) {
  const {
    seed = 7,
    drift = 0.0006,
    vol = 0.03,
    regimeEvery = 40,
    startPrice = 100,
  } = opts;
  const rand = mulberry32(seed);
  const bars = [];
  let price = startPrice;

  for (let i = 0; i < n; i++) {
    // Regime switching: the drift flips sign every `regimeEvery` bars, which
    // is what makes trend-following features genuinely informative rather
    // than trivially so.
    const regime = Math.floor(i / regimeEvery);
    const d = regime % 2 === 0 ? drift : -drift;
    // Volatility clusters: quiet stretches and loud ones.
    const volMult = 0.6 + (Math.floor(i / regimeEvery) % 3) * 0.35;
    const shock = (rand() * 2 - 1) * vol * volMult;

    const o = price;
    price = Math.max(0.0001, price * (1 + d + shock));
    const c = price;
    const range = c * (0.002 + rand() * 0.01);

    bars.push({
      t: 1_700_000_000_000 + i * 86_400_000,
      o,
      h: Math.max(o, c) + range,
      l: Math.max(0.0001, Math.min(o, c) - range),
      c,
      v: 1e6 * (0.5 + rand()),
    });
  }
  return bars;
}
