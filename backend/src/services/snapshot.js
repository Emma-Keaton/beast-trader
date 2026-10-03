/**
 * Market snapshot assembly.
 *
 * One place that decides *where* a coin's data comes from, so the research
 * endpoint and the background poller can never disagree about a price.
 *
 *  - DEX coins (Solana, EVM) come from DexScreener, carrying the liquidity
 *    figure that decides whether they are safe to trade at all, and are
 *    cross-checked against DefiLlama by contract address.
 *  - Listed coins come from Binance's keyless ticker, and are also given
 *    their recent daily history so the trained model can score them.
 *
 * Getting this wrong is not cosmetic: a major coin priced off a random DEX
 * pool shows a flat 0% day and produces the wrong verdict.
 */

import { bestPair, listedTicker, llamaPrice } from "./data.js";
import { fetchDailyBars } from "../ml/history.js";

/**
 * @param item `{ symbol, chain?, token_id?, name?, address? }`
 * @returns a snapshot ready for `research()`, or null when unpriceable
 */
export async function marketSnapshot(item) {
  const symbol = String(item.symbol || "").toUpperCase();
  if (!symbol) return null;

  // DEX route: the chain hint means "this coin lives on a DEX".
  if (item.chain && item.chain !== "coingecko" && item.chain !== "binance") {
    const pair = await bestPair(symbol, item.chain);
    if (!pair || !pair.price_usd) return null;
    return {
      ...item,
      symbol,
      chain: item.chain,
      source: "dexscreener",
      asset_class: item.chain === "solana" ? "solana" : "evm_dex",
      ...priceFields(pair),
      liquidity_usd: pair.liquidity_usd,
      address: item.address ?? pair.address ?? null,
    };
  }

  // Listed-coin route: Binance ticker, plus history for the model.
  const fromBinance = await listedTicker(symbol).catch(() => null);
  if (fromBinance) {
    return {
      ...item,
      symbol,
      chain: "binance",
      source: "binance",
      asset_class: "crypto",
      price_usd: fromBinance.price_usd,
      change_24h: fromBinance.change_24h,
      change_1h: null,
      volume_h24: fromBinance.volume_h24,
      liquidity_usd: null,
      history: await recentHistory(symbol),
    };
  }

  // Last resort: a DEX pool, for a listed coin Binance does not carry.
  const pair = await bestPair(symbol);
  if (pair?.price_usd) {
    return {
      ...item,
      symbol,
      chain: pair.chain,
      source: "dexscreener",
      asset_class: pair.chain === "solana" ? "solana" : "evm_dex",
      ...priceFields(pair),
      liquidity_usd: pair.liquidity_usd,
    };
  }
  return null;
}

/**
 * Cross-check a DEX price against DefiLlama, which aggregates far more pools.
 *
 * If the two disagree by more than 5%, the DEX figure is flagged so the
 * trader knows the number is suspect rather than being handed a confident
 * wrong price. This is the cheapest integrity check available for free.
 */
export async function crossCheck(snapshot) {
  if (!snapshot?.address || !snapshot.chain) return snapshot;
  const ref = await llamaPrice(snapshot.chain, snapshot.address).catch(() => null);
  if (!ref?.price || !snapshot.price_usd) return { ...snapshot, cross_checked: false };
  const diff = Math.abs(ref.price - snapshot.price_usd) / snapshot.price_usd;
  return {
    ...snapshot,
    cross_checked: true,
    reference_price: ref.price,
    // Beyond 5% apart, one of the two feeds is stale or on a broken pool.
    price_conflict: diff > 0.05,
  };
}

/** Carries only the fields a snapshot needs, so callers stay explicit. */
function priceFields(pair) {
  return {
    price_usd: pair.price_usd,
    change_24h: pair.change_24h,
    change_1h: pair.change_1h ?? null,
    volume_h24: pair.volume_h24,
    buys_1h: pair.buys_1h ?? null,
    sells_1h: pair.sells_1h ?? null,
  };
}


/** Last ~120 daily bars for a coin, or null if unavailable. */
async function recentHistory(symbol) {
  try {
    // Keyed by symbol so the training cache and the live cache read the same
    // file for the same coin — one fetch serves both.
    const data = await fetchDailyBars(symbol, symbol, 1000);
    return data.bars.slice(-120);
  } catch {
    return null;
  }
}

/** Current price for a symbol, used to settle matured paper calls. */
export async function livePrice(symbol) {
  const b = await listedTicker(symbol).catch(() => null);
  if (b?.price_usd) return b.price_usd;
  try {
    const pair = await bestPair(symbol);
    if (pair?.price_usd) return pair.price_usd;
  } catch {
    return null;
  }
  return null;
}
