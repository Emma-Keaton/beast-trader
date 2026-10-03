/**
 * Local retrieval over the project's own notes and research.
 *
 * Why this exists. The app has accumulated a body of written reasoning — docs/,
 * research notes, the strategy findings — and when it makes a call it reads none
 * of it. It sees a price and a feature vector, in a vacuum. Giving it back the
 * reasoning already written about an asset is the cheapest possible improvement,
 * and it costs nothing at inference time because it is all local.
 *
 * Why not a hosted retrieval service. The obvious candidate is a managed RAG API
 * (Needle, Pinecone, and so on): you upload your documents, pay per query, and
 * the query and your corpus both leave the machine. That is a poor trade for a
 * trading app whose entire value proposition is that every decision is locally
 * auditable against realised prices. It also does not do what is wanted here —
 * those services retrieve passages; they do not reason, and they cannot be
 * queried without a network round trip on every forecast.
 *
 * BM25 rather than embeddings, deliberately. The corpus here is small (a few
 * dozen documents), and the queries are technical and keyword-shaped: "solana
 * liquidity", "14 day horizon", "spread cost". Embeddings are excellent at
 * fuzzy semantic similarity and poor at exact identifier matching, which is the
 * opposite of what a lookup by asset symbol needs. BM25 gets exact matches right,
 * needs no model, no API key, no data leaving the process, and is auditable: you
 * can read exactly why a document ranked where it did. Embeddings would be the
 * right call at 100x the corpus size or for paraphrased questions.
 *
 * Everything here is O(corpus) per query and cached, so a forecast can afford to
 * consult it on every call.
 */

/* ── tokenisation ─────────────────────────────────────────────────────────── */

import fs from "node:fs";
import path from "node:path";

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "else", "of", "to", "in", "on",
  "at", "for", "with", "by", "from", "as", "is", "are", "was", "were", "be", "been",
  "it", "its", "this", "that", "these", "those", "we", "i", "you", "they", "not",
  "no", "do", "does", "did", "can", "will", "would", "should", "there", "here",
  "what", "which", "who", "how", "why", "when", "about", "into", "over", "under",
  "so", "than", "too", "very", "just", "also", "any", "all", "some", "more",
  "most", "other", "such", "only", "own", "same", "up", "out", "get", "got",
]);

/**
 * Lowercase, split on anything that is not alphanumeric, drop stopwords.
 *
 * Symbols matter more than prose here, so `$sol`, `SOL/USDT` and `btc` must
 * survive as findable tokens rather than being stripped as punctuation. Splitting
 * on non-alphanumerics turns all three into bare `sol`/`btc`, which is what makes
 * an exact identifier lookup work.
 */
export function tokenise(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/\$/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/* ── BM25 scoring ─────────────────────────────────────────────────────────── */

// Standard Okapi BM25 constants. k1 controls how fast term frequency saturates;
// b controls how much a document's length is penalised. These are the values from
// the original Robertson/Sparck Jones formulation as commonly implemented, not
// tuned to this corpus — tuning retrieval against one small corpus would be
// fitting the index to the test set.
const K1 = 1.2;
const B = 0.75;

function scoreBm25(queryTokens, docTokens, df, totalDocs, avgLen) {
  const tf = new Map();
  for (const t of docTokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  let score = 0;
  for (const term of queryTokens) {
    const f = tf.get(term);
    if (!f) continue;
    const n = df.get(term) ?? 0;
    // Robertson/Sparck Jones IDF with the +0.5 smoothing. Floored at a small
    // positive value: a term present in every document carries no information,
    // but allowing it to go negative would let a common word *subtract* score and
    // rank an unrelated document above a relevant one.
    const idf = Math.max(1e-6, Math.log(1 + (totalDocs - n + 0.5) / (n + 0.5)));
    score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * docTokens.length) / avgLen)));
  }
  return score;
}

/* ── index ────────────────────────────────────────────────────────────────── */

/**
 * An in-memory BM25 index over text documents.
 *
 * Built once and cached. Re-indexing on every query would be wasteful but also
 * self-limiting at this corpus size; the cache exists so that a forecast calling
 * this on every 30s poll does not re-read the filesystem each time.
 */
export class BM25Index {
  constructor(docs = []) {
    this.docs = [];
    for (const d of docs) this.add(d);
    this._recomputeStats();
  }

  add(doc) {
    const tokens = tokenise(`${doc.title ?? ""} ${doc.text ?? ""}`);
    if (!tokens.length) return;
    this.docs.push({ ...doc, tokens, len: tokens.length });
    this._stale = true;
  }

  _recomputeStats() {
    this.df = new Map();
    let total = 0;
    for (const d of this.docs) {
      total += d.len;
      for (const term of new Set(d.tokens)) this.df.set(term, (this.df.get(term) ?? 0) + 1);
    }
    this.avgLen = this.docs.length ? total / this.docs.length : 0;
    this._stale = false;
  }

  /** Best-matching documents, highest score first. */
  search(query, limit = 5) {
    if (this._stale) this._recomputeStats();
    const q = tokenise(query);
    if (!q.length || !this.docs.length) return [];
    return this.docs
      .map((d) => ({ ...d, score: scoreBm25(q, d.tokens, this.df, this.docs.length, this.avgLen) }))
      // A zero score means nothing in the query matched; returning it would pad
      // the results with irrelevant documents and imply more confidence than
      // exists. "I found nothing" is a useful, honest answer here.
      .filter((d) => d.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ tokens: _tokens, ...rest }) => ({ ...rest, score: Number(rest.score.toFixed(4)) }));
  }
}

/**
 * A one-line excerpt around the best-matching region of a document.
 *
 * Returns the single densest window rather than the document head, because the
 * useful sentence in a research note is rarely the first one and a caller
 * reading "the first 300 characters" gets the summary instead of the finding.
 */
export function bestExcerpt(text, query, width = 320) {
  if (!text) return "";
  const tokens = [...tokenise(query)];
  if (!tokens.length) return text.slice(0, width).trim();
  const lower = text.toLowerCase();
  let best = { at: 0, hits: -1 };
  const step = Math.max(1, Math.floor(width / 2));
  for (let i = 0; i < lower.length; i += step) {
    const win = lower.slice(i, i + width);
    let hits = 0;
    for (const t of tokens) if (win.includes(t)) hits++;
    if (hits > best.hits) best = { at: i, hits };
    if (hits === tokens.length) break;
  }
  const out = text.slice(best.at, best.at + width).trim();
  return (best.at > 0 ? "…" : "") + out + (best.at + width < text.length ? "…" : "");
}

/* ── corpus ───────────────────────────────────────────────────────────────── */

/**
 * Load the project's own markdown notes into an index.
 *
 * Markdown only, and only under the directories listed. Reading arbitrary files
 * would mean the retrieval index could surface a secret that happens to sit in a
 * readable path — an allowlist of extensions and directories is the cheap way to
 * make that impossible rather than unlikely.
 *
 * Missing directories are skipped rather than fatal: a deployment without docs/
 * should still boot, it should just retrieve nothing.
 */
export function loadCorpus(roots) {
  const docs = [];
  for (const root of roots) {
    let dir;
    try {
      dir = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of dir) {
      if (!entry.isFile()) continue;
      // Allowlist: markdown only. No .env, no .json, no source.
      if (!/\.(md|markdown)$/i.test(entry.name)) continue;
      try {
        const text = fs.readFileSync(path.join(root, entry.name), "utf8");
        docs.push({
          id: path.relative(path.dirname(root), path.join(root, entry.name)),
          title: firstHeading(text) ?? entry.name,
          source: path.basename(root),
          text,
        });
      } catch {
        // An unreadable file is not a reason to fail the whole index.
      }
    }
  }
  return docs;
}

function firstHeading(text) {
  const m = text.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

/**
 * Build (and memoise) the index over the project docs.
 *
 * Memoised because the poller runs every 30s and re-reading every markdown file
 * on each forecast would be pure waste. `reload()` exists for tests and for a
 * long-running process that should pick up edits.
 */
let cached = null;

export function getIndex(docsRoot) {
  if (cached) return cached;
  const roots = [path.join(docsRoot, "docs"), docsRoot].filter((p, i, a) => a.indexOf(p) === i);
  cached = new BM25Index(loadCorpus(roots));
  return cached;
}

export function reloadIndex(docsRoot) {
  cached = null;
  return getIndex(docsRoot);
}

/**
 * Search the corpus, returning passages rather than whole documents.
 *
 * Returning whole documents would push a lot of irrelevant text into any prompt
 * built from this, and the model's attention is the scarcest resource in the
 * call. An excerpt around the best match keeps the signal and drops the rest.
 */
export function searchDocs(query, { limit = 4, docsRoot, excerptWidth = 320 } = {}) {
  const index = getIndex(docsRoot);
  return index.search(query, limit).map((d) => ({
    id: d.id,
    title: d.title,
    source: d.source,
    score: d.score,
    excerpt: bestExcerpt(d.text, query, excerptWidth),
  }));
}

/**
 * Everything the corpus says about one asset, for handing to a model as context.
 *
 * Queried by symbol *and* by name, because the notes refer to assets
 * inconsistently ("BTC", "bitcoin", "Bitcoin") and a miss here is invisible —
 * the model simply gets thinner context and nobody notices the retrieval failed.
 */
export function contextForAsset(symbol, { docsRoot, limit = 3 } = {}) {
  const queries = [symbol, symbol.replace(/USDT?$/i, ""), `${symbol} strategy`];
  const seen = new Set();
  const out = [];
  for (const q of queries) {
    for (const hit of searchDocs(q, { docsRoot, limit })) {
      if (seen.has(hit.id)) continue;
      seen.add(hit.id);
      out.push(hit);
    }
  }
  return out.slice(0, limit);
}
