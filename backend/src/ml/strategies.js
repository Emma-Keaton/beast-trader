/**
 * Strategy registry — champion/challenger model management.
 *
 * The central idea: a live trading app should never have one model. It should
 * have a **champion** (the model actually in use) and a set of **challengers**
 * (candidates being evaluated against it), and it should promote a challenger
 * only when that challenger demonstrably beats the champion out-of-sample.
 *
 * That structure is what makes continuous improvement safe rather than
 * self-destructive. Without it, "keep retraining" means the model in
 * production is replaced by whatever the last run produced, and a bad week
 * silently installs a worse model. With it, a bad week produces a challenger
 * that is measured, ranked, and quietly rejected.
 *
 * Nothing in here can promote a model on its own: a challenger needs a minimum
 * settled-call count, and it must beat the incumbent net of costs. A lucky
 * fortnight cannot take over.
 */

import fs from "node:fs";
import { assessStability } from "./stability.js";
import { recencyVerdict, correlationAdjustedTrials } from "./recency.js";
import { expectedMaxSharpe } from "./stats.js";
import path from "node:path";
import { config, usingSupabase } from "../config.js";

const DIR = path.join(config.dataDir, "strategies");
const CHAMPION_FILE = path.join(DIR, "champion.json");
const CHALLENGERS_FILE = path.join(DIR, "challengers.json");

/** A challenger must clear all of these before it can replace the champion. */
export const PROMOTION_RULES = {
  minSettledCalls: 30,
  // The challenger's net expectancy must exceed the champion's by more than
  // this. A difference smaller than the noise in the estimate is not a win.
  minExpectancyEdge: 0,
  minDeflatedSharpe: 0.95,
  maxChallengers: 4,
  /**
   * The deepest fall from a peak that is tolerable unattended.
   *
   * Set because expectancy and Sharpe cannot see the shape of losses. The trained
   * model carried an 86.3% peak-to-trough fall on 402 trades while averaging +2.2% a
   * trade — it would have passed every other gate in this file. 25% is roughly the
   * point at which a drawdown stops being a setback and starts being the account.
   */
  maxDrawdown: 0.25,
  /** Gross wins must exceed gross losses by this much. Catches an edge built on a few
   * outsized wins against a stream of small losses. */
  minProfitFactor: 1.1,
  /** Losing trades must be at least this far apart. Catches clustering, where the
   * account is fine on average and empty after one bad stretch. */
  minLossCadence: 2,
  /**
   * Recent expectancy must clear this floor, independently of the full record.
   *
   * A model that earned its edge over 400 trades and has since decayed still has
   * a fine lifetime average, and would keep its position size while it bleeds.
   * Stale edge is worse than no edge because it carries risk with it.
   */
  minRecentExpectancy: 0,
  /**
   * Fraction of the record treated as "recent" for the recency check. 40% is wide
   * enough that ordinary variance cannot flip it and narrow enough that a model
   * which stopped working two months ago is caught.
   */
  recentWindowFraction: 0.4,
  // Trade count alone is not evidence. 200 calls packed into an hour are far
  // more correlated — and so far less informative — than 200 calls spread
  // across a fortnight of different market regimes. A challenger must have
  // been alive this long before its record can promote it, so a burst of
  // correlated activity cannot masquerade as a well-tested model.
  minTrackDays: 3,
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

/* ── Durable storage ────────────────────────────────────────────────────────
 *
 * The champion and challengers used to live only in two JSON files on local
 * disk. That is fine on a laptop and fatal in production: Render's filesystem
 * is ephemeral, and a free instance explicitly discards local changes on every
 * spin-down, restart and redeploy. Weeks of challengers accumulating evidence
 * would be deleted every 15 minutes of inactivity.
 *
 * So the registry is backed by Supabase when configured, and falls back to disk
 * only for local development. Reads stay synchronous by design — the prediction
 * path calls `getChampion()` on every request and cannot await a network round
 * trip — so the store keeps an in-process mirror refreshed by a background sync.
 */
let mirror = { champion: null, challengers: [] };
let mirrorAt = 0;
const MIRROR_TTL_MS = 5_000;

async function sbGet(table, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${config.supabaseUrl}/rest/v1/${table}?${qs}`, {
    headers: { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}` },
  });
  if (!res.ok) throw new Error(`supabase ${table}: ${res.status}`);
  return res.json();
}

async function sbUpsert(row) {
  const res = await fetch(`${config.supabaseUrl}/rest/v1/model_registry`, {
    method: "POST",
    headers: {
      apikey: config.supabaseKey,
      Authorization: `Bearer ${config.supabaseKey}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`supabase model_registry upsert: ${res.status}`);
}

/** Pull durable state into the synchronous mirror. */
async function syncMirror() {
  if (!usingSupabase) return;
  const rows = await sbGet("model_registry", {
    select: "id,role,payload,label,parent,track_record,created_at",
  });
  const championRow = rows.find((r) => r.role === "champion");
  mirror = {
    champion: championRow ? { ...(championRow.payload ?? {}), role: "champion", id: championRow.id } : null,
    challengers: rows
      .filter((r) => r.role === "challenger")
      .map((r) => ({
        ...(r.payload ?? {}),
        role: "challenger",
        id: r.id,
        label: r.label ?? r.id,
        parent: r.parent ?? null,
        createdAt: r.created_at,
        trackRecord: r.track_record ?? null,
      })),
  };
  mirrorAt = Date.now();
}

/**
 * Return the mirror, or the on-disk copy when running locally.
 *
 * Called from the synchronous read paths, so it can never await. With Supabase
 * configured but the mirror cold — a process that has just booted — a
 * background sync is kicked off and the current (possibly empty) mirror is
 * returned, so a prediction request is never blocked on the network.
 */
function mirrorOrDisk() {
  if (usingSupabase) {
    if (Date.now() - mirrorAt >= MIRROR_TTL_MS) syncMirror().catch(() => {});
    return mirror;
  }
  return { champion: readJson(CHAMPION_FILE, null), challengers: readJson(CHALLENGERS_FILE, []) };
}

/** Warm the registry at boot. Safe to call repeatedly. */
export async function warmRegistry() {
  if (!usingSupabase) {
    mirror = { champion: readJson(CHAMPION_FILE, null), challengers: readJson(CHALLENGERS_FILE, []) };
    mirrorAt = Date.now();
    return mirror;
  }
  await syncMirror();
  return mirror;
}

async function persistChampion(record) {
  mirror = { ...mirror, champion: record };
  mirrorAt = Date.now();
  writeJson(CHAMPION_FILE, record);
  if (usingSupabase) {
    await sbUpsert({ id: "champion", role: "champion", payload: record, label: record.label ?? "champion" });
  }
}

/**
 * Persist the shortlist.
 *
 * Replaced wholesale rather than merged: the list is capped at four, and a
 * delete-then-insert guarantees an evicted challenger actually leaves the table
 * instead of lingering as a ghost row.
 */
async function persistChallengers(list) {
  mirror = { ...mirror, challengers: list };
  mirrorAt = Date.now();
  writeJson(CHALLENGERS_FILE, list);
  if (!usingSupabase) return;
  const keep = new Set(list.map((c) => c.id));
  const existing = await sbGet("model_registry", { id: "neq.champion", select: "id" });
  for (const row of existing) {
    if (keep.has(row.id)) continue;
    await fetch(`${config.supabaseUrl}/rest/v1/model_registry?id=eq.${row.id}`, {
      method: "DELETE",
      headers: { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}` },
    });
  }
  for (const c of list) {
    await sbUpsert({
      id: c.id,
      role: "challenger",
      payload: c,
      label: c.label ?? c.id,
      parent: c.parent ?? null,
      track_record: c.trackRecord ?? null,
    });
  }
}

export function getChampion() {
  return mirrorOrDisk().champion;
}

export function listChallengers() {
  return mirrorOrDisk().challengers;
}

/** Install a model as champion. Called by the trainer, never by a retrainer. */
export async function setChampion(model, meta = {}) {
  const record = { ...model, role: "champion", ...meta, installedAt: new Date().toISOString() };
  await persistChampion(record);
  return record;
}

/**
 * Propose a challenger.
 *
 * This does **not** promote anything. It parks the candidate alongside the
 * champion so the paper ledger can score it, and `evaluatePromotion()` decides
 * later whether it earned the role.
 */
export async function proposeChallenger(model, meta = {}) {
  const list = listChallengers();
  // Keep the shortlist a genuine shortlist rather than a growing graveyard.
  // Ranking produces *summaries*, not models, so the eviction must select ids
  // to drop and then remove those originals — writing the summaries back
  // would silently discard every challenger's weights.
  let trimmed = list;
  if (list.length >= PROMOTION_RULES.maxChallengers) {
    const weakest = rankByScore(list.map((c) => ({ ...scoreChallenger(c), raw: c })))
      .slice(0, list.length - PROMOTION_RULES.maxChallengers + 1)
      .map((s) => s.id);
    trimmed = list.filter((c) => !weakest.includes(c.id));
  }

  const id = meta.id ?? `chal_${Date.now().toString(36)}`;
  const entry = {
    ...model,
    role: "challenger",
    id,
    label: meta.label ?? id,
    parent: meta.parent ?? getChampion()?.id ?? null,
    provenance: meta.provenance ?? "retrain",
    // Honour an explicit creation time so fixtures (and any future restore
    // path) can age a challenger deliberately rather than backdating the file.
    createdAt: meta.createdAt ?? new Date().toISOString(),
    trackRecord: { settled: 0, wins: 0, returns: [] },
  };
  await persistChallengers([...trimmed.filter((c) => c.id !== id), entry]);
  return entry;
}

/** Record a settled call against a challenger's track record. */
export async function recordChallengerOutcome(id, netReturn) {
  const list = listChallengers();
  const next = list.map((c) =>
    c.id === id
      ? {
          ...c,
          trackRecord: {
            settled: (c.trackRecord?.settled ?? 0) + 1,
            wins: (c.trackRecord?.wins ?? 0) + (netReturn > 0 ? 1 : 0),
            // Capped: this is a running summary, not an archive.
            returns: [...(c.trackRecord?.returns ?? []), netReturn].slice(-500),
          },
        }
      : c,
  );
  await persistChallengers(next);
  return next.find((c) => c.id === id) ?? null;
}

/** Score a challenger from its own settled track record. */
export function scoreChallenger(c) {
  const r = c.trackRecord?.returns ?? [];
  if (r.length < 4) {
    return { id: c.id, label: c.label ?? c.id, settled: r.length, expectancy: null, winRate: null, eligible: false, ageDays: ageInDays(c), risk: null };
  }
  const wins = r.filter((x) => x > 0).length;
  const expectancy = r.reduce((s, x) => s + x, 0) / r.length;
  const ageDays = ageInDays(c);
  /**
   * Per-trade Sharpe: mean over standard deviation, unannualised.
   *
   * Unannualised deliberately. This series is a sequence of trades, not periods,
   * and annualising it would imply a trade frequency that varies with how often the
   * app happens to fire — inflating the number for a model that traded often and
   * shrinking it for one that did not. The multiple-comparisons hurdle below is
   * computed on the same scale, so the two cancel.
   */
  const variance = r.length > 1 ? r.reduce((s, x) => s + (x - expectancy) ** 2, 0) / (r.length - 1) : 0;
  const sharpe = variance > 0 ? expectancy / Math.sqrt(variance) : null;
  /**
   * The average is necessary but not sufficient. A strategy that wins small and
   * occasionally loses everything has a fine expectancy, a fine Sharpe, and an
   * unsurvivable path. This is the check that sees the path.
   */
  const risk = assessStability(r, PROMOTION_RULES);
  /**
   * Recency. A model whose edge has decayed still has a good lifetime average,
   * and would keep its position size while it bleeds.
   */
  const recency = recencyVerdict(r, {
    minRatio: PROMOTION_RULES.minRecentExpectancy,
    fraction: PROMOTION_RULES.recentWindowFraction,
  });
  return {
    id: c.id,
    label: c.label ?? c.id,
    settled: r.length,
    expectancy,
    winRate: wins / r.length,
    totalReturn: r.reduce((s, x) => s * (1 + x), 1) - 1,
    /** Per-trade Sharpe, used by the multiple-comparisons hurdle in evaluatePromotion. */
    sharpe,
    ageDays,
    /** The full stability report, so a refusal can say *why* rather than just "no". */
    risk,
    /** Recent-window performance, so decay is visible before it is averaged away. */
    recency,
    eligible:
      r.length >= PROMOTION_RULES.minSettledCalls &&
      expectancy > PROMOTION_RULES.minExpectancyEdge &&
      // Survivability of the loss path, not merely the average of it.
      risk.ok &&
      // Still working, not just once good.
      recency.ok &&
      // A large sample earned inside a single burst of correlated activity is
      // not a well-tested record. The challenger must have survived at least
      // `minTrackDays` of distinct days before its evidence counts.
      ageDays >= PROMOTION_RULES.minTrackDays,
  };
}

/** How many days a challenger has been accruing evidence, at least 0. */
function ageInDays(c) {
  const since = Date.parse(c.createdAt ?? "");
  if (!Number.isFinite(since)) return PROMOTION_RULES.minTrackDays; // unknown age: do not block
  return Math.max(0, (Date.now() - since) / 86_400_000);
}

/**
 * Decide whether any challenger should take over.
 *
 * Returns a verdict; it does not perform the swap. The caller applies it, so
 * the decision stays inspectable in a log and in tests.
 */
export function evaluatePromotion(championStats = null) {
  const all = listChallengers();
  const scored = rankByScore(all.map(scoreChallenger));
  const eligible = scored.filter((s) => s.eligible);
  if (!eligible.length) {
    return { promote: false, reason: "no challenger is eligible yet", ranked: scored };
  }
  const best = eligible[0];

  /**
   * Multiple comparisons, done honestly.
   *
   * Every challenger was trained on the same settled calls, so their return
   * streams are correlated by construction. Picking the best of four and treating
   * it as the survivor is a multiple-comparisons error, and it is the most likely
   * way this loop promotes a confident loser. The count of genuinely independent
   * trials is what the deflated-Sharpe hurdle should be measured against.
   *
   * When the challengers are near-identical this collapses toward a single trial,
   * which raises the bar for the winner rather than lowering it.
   */
  const trials = correlationAdjustedTrials(all);
  const collapsed = trials.trials < trials.from;

  // A challenger has to beat the incumbent, not merely look good alone.
  if (championStats && Number.isFinite(championStats.expectancy) && best.expectancy <= championStats.expectancy) {
    return {
      promote: false,
      reason: `best challenger (${(best.expectancy * 100).toFixed(3)}%/trade) does not beat the champion (${(championStats.expectancy * 100).toFixed(3)}%/trade)`,
      ranked: scored,
      trials,
    };
  }

  /**
   * The edge must also survive the hurdle for how many things were actually tried.
   *
   * Deflated Sharpe asks "given N attempts, how likely is this Sharpe real?". With
   * correlated challengers the honest N is smaller than the count on the board,
   * which makes the question harder rather than easier — and that is the point.
   * A loop that promotes the luckiest of four near-identical models is the exact
   * failure this system exists to avoid.
   */
  if (Number.isFinite(best.sharpe) && Number.isFinite(best.settled)) {
    const sr = best.sharpe / Math.sqrt(Math.max(1, best.settled));
    const hurdle = expectedMaxSharpe(1 / Math.max(1, best.settled), Math.max(1, trials.trials));
    if (sr <= hurdle) {
      return {
        promote: false,
        reason:
          `deflated Sharpe ${sr.toFixed(3)} does not clear the ${hurdle.toFixed(3)} hurdle` +
          (collapsed ? ` for ${trials.trials} independent trials out of ${trials.from} challengers (mean correlation ${trials.meanCorrelation})` : ""),
        ranked: scored,
        trials,
      };
    }
  }

  return {
    promote: true,
    winner: best,
    ranked: scored,
    trials,
    reason:
      collapsed
        ? `challenger beats the champion, and clears the hurdle for ${trials.trials} independent trials of ${trials.from}`
        : "challenger beats the champion",
  };
}

/** Swap in the winning challenger. */
export async function promoteChallenger(id) {
  const list = listChallengers();
  const winner = list.find((c) => c.id === id);
  if (!winner) return null;
  // Strip the challenger's bookkeeping — its role, id, track record and
  // creation date describe a candidate, not a model in service.
  const { trackRecord: _t, role: _r, id: _i, label: _l, createdAt: _c, ...model } = winner;
  const champion = { ...model, role: "champion", promotedAt: new Date().toISOString() };
  await persistChampion(champion);
  await persistChallengers(list.filter((c) => c.id !== id));
  return champion;
}

export async function retireChallenger(id) {
  await persistChallengers(listChallengers().filter((c) => c.id !== id));
}

function rankByScore(list) {
  return [...list].sort((a, b) => (b.expectancy ?? -Infinity) - (a.expectancy ?? -Infinity));
}

/** Everything the app shows about the model-improvement state. */
export function improvementState() {
  const champion = getChampion();
  const challengers = listChallengers().map(scoreChallenger);
  return {
    champion: champion
      ? {
          id: champion.id ?? null,
          label: champion.label ?? "champion",
          installedAt: champion.installedAt ?? null,
          provenance: champion.provenance ?? "seed",
        }
      : null,
    challengers: challengers.sort((a, b) => (b.expectancy ?? -1) - (a.expectancy ?? -1)),
    rules: PROMOTION_RULES,
  };
}
