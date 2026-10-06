import { predict, predictBest } from "./predict.js";

/**
 * Research service — structures a market snapshot into the JSON contract the
 * rest of the pipeline consumes.
 *
 * This is the swap-in point for a larger model runtime: replace the body of
 * `research()` and the rest of the app keeps working, because every consumer
 * only depends on the note shape below.
 */
export function composeNote(snapshot, prediction) {
  return {
    token: {
      symbol: snapshot.symbol,
      name: snapshot.name ?? snapshot.symbol,
      chain: snapshot.chain ?? "coingecko",
      source: snapshot.source ?? "coingecko",
    },
    market: {
      price_usd: snapshot.price_usd ?? null,
      change_24h: snapshot.change_24h ?? null,
      volume_h24: snapshot.volume_h24 ?? null,
      liquidity_usd: snapshot.liquidity_usd ?? null,
    },
    summary: plainSummary(snapshot, prediction),
    prediction,
    generated_at: new Date().toISOString(),
    engine: prediction.basis === "model" ? prediction.model : "simple-rules",
  };
}

/**
 * A one-sentence takeaway written for someone new to trading:
 * where the price is, how it is doing today, and what the AI thinks.
 */
function plainSummary(snapshot, prediction) {
  const price = Number(snapshot.price_usd ?? 0);
  const chg = Number(snapshot.change_24h ?? 0);
  const where = price
    ? `${snapshot.symbol} is trading at ${formatPrice(price)}, ${chg >= 0 ? "up" : "down"} ${Math.abs(chg).toFixed(1)}% today.`
    : `${snapshot.symbol} is not trading right now.`;

  // The explanation usually opens by restating the day's move ("It is down
  // 3.1% today…"), which the sentence above already says. Concatenating
  // blindly printed it twice, so the redundant clause is dropped — but only
  // that clause, because the rest of the explanation is the actual point and
  // the price sentence must survive.
  const move = Math.abs(chg).toFixed(1);
  const sentences = String(prediction.reason ?? "")
    .split(/(?<=\.)\s+/)
    .filter((s) => !s.includes(move));
  const reason = sentences.join(" ").trim();
  return reason ? `${where} ${reason}` : where;
}

/**
 * Price formatting that stays useful for cheap coins. A fixed two decimals
 * would print every memecoin as "$0.00", which tells the user nothing.
 */
export function formatPrice(n) {
  if (!Number.isFinite(n)) return "$—";
  if (n >= 1) return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  if (n >= 0.000001) return `$${n.toPrecision(3)}`;
  return `$${n.toExponential(2)}`;
}

export async function research(snapshot) {
  const prediction = (await predictBest(snapshot)) ?? predict(snapshot);
  return composeNote(snapshot, prediction);
}

// --- Research-context retrieval, optional and off by default ----------------
//
// Originally stubbed here on the assumption that "@needle/needle" was a local
// model runtime that could do research by itself. That was wrong, and the
// assumption is worth recording so nobody re-adds it on the same misunderstanding.
//
// Needle is a *managed RAG service*: a hosted vector-search API over documents
// you upload to their cloud, called as `ndl.collections.search({collection_id,
// text})`, authenticated with a paid `NEEDLE_API_KEY`. It retrieves passages
// that are relevant to a question. It does not analyse markets, it does not
// build strategies, and it cannot be reasoned with — the LLM in a RAG pipeline
// is a separate component that you supply and pay for separately.
//
// So it does not belong on this path even though the shape looks right. Wiring a
// third-party service in to *generate* trading calls would put the app's signals
// behind a paid hosted dependency whose output nobody can reproduce or audit,
// which is incompatible with a system whose whole value is that every decision
// is scored locally against realised prices.
//
// The genuinely useful part is retrievable locally and with no key, which is
// what this app should do instead: search its own docs/ and research notes for
// prior reasoning about an asset, and hand *that* to a model as context. Worth
// building. Worth building here rather than in someone else's cloud.
