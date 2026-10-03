import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Activity, RefreshCw, ShieldCheck, Star, TrendingUp } from "lucide-react";
import { api, type Order, type PaperRecord, type SignalLog, type WatchlistItem } from "../lib/api";
import { fmtCompact, fmtUsd } from "../lib/format";
import { Card, ConfidenceBar, Empty, SignalChip, SkeletonRows } from "../components/ui";

function pct(n: number | null): string {
  return n == null ? "—" : `${Math.round(n * 100)}%`;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  return (
    <div className="rounded-control border border-slate-200 px-3 py-2 dark:border-slate-800">
      <p className="muted-caption text-[11px]">{label}</p>
      <p
        className={cxNum(
          "tnum mt-0.5 font-mono text-lg font-semibold",
          tone === "up" && "text-bull",
          tone === "down" && "text-bear",
        )}
      >
        {value}
      </p>
    </div>
  );
}

const cxNum = (...c: (string | false)[]) => c.filter(Boolean).join(" ");

export default function Dashboard() {
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([]);
  const [signals, setSignals] = useState<SignalLog[]>([]);
  const [trades, setTrades] = useState<Order[]>([]);
  const [paper, setPaper] = useState<PaperRecord | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);

  async function load() {
    try {
      const [w, s, t, p] = await Promise.all([
        api.watchlist(),
        api.signals(),
        api.trades(),
        api.paper().catch(() => null),
      ]);
      setWatchlist(w);
      setSignals(s);
      setTrades(t);
      setPaper(p);
    } catch {
      /* backend offline — empty states guide the user */
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000); // mirror the backend poll cadence
    return () => clearInterval(t);
  }, []);

  const paperPnl = trades
    .filter((o) => o.status === "filled_paper")
    .reduce((sum, o) => sum + (o.notional_usd ?? 0), 0);

  return (
    <div className="animate-fade-up space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Your trading desk</p>
          <h1 className="page-title">Dashboard</h1>
        </div>
        <button
          type="button"
          className="btn-secondary"
          disabled={refreshing}
          onClick={async () => {
            setRefreshing(true);
            try {
              await api.refresh();
            } catch {
              /* already checked moments ago — nothing to tell the user */
            }
            await load();
            setRefreshing(false);
          }}
        >
          <RefreshCw className={refreshing ? "h-4 w-4 animate-spin" : "h-4 w-4"} /> Check now
        </button>
      </header>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="p-4">
          <p className="muted-caption flex items-center gap-1.5"><Star size={14} /> Coins you follow</p>
          <p className="tnum mt-1 font-mono text-2xl font-semibold">{watchlist.length}</p>
        </Card>
        <Card className="p-4">
          <p className="muted-caption flex items-center gap-1.5"><TrendingUp size={14} /> Tips today</p>
          <p className="tnum mt-1 font-mono text-2xl font-semibold">
            {signals.filter((s) => new Date(s.created_at) > new Date(Date.now() - 864e5)).length}
          </p>
        </Card>
        <Card className="p-4">
          <p className="muted-caption flex items-center gap-1.5"><Activity size={14} /> Practice trades</p>
          <p className="tnum mt-1 font-mono text-2xl font-semibold">
            {trades.filter((o) => o.mode === "paper").length}
          </p>
        </Card>
        <Card className="p-4">
          <p className="muted-caption">Practice money in play</p>
          <p className="tnum mt-1 font-mono text-2xl font-semibold">${fmtCompact(paperPnl)}</p>
        </Card>
      </section>

      <section>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-600 dark:text-slate-300">
          <ShieldCheck className="h-4 w-4 text-brand-500" /> How good is Beast?
        </h2>
        {paper && (
          <Card className="p-5">
            <p className="text-sm text-slate-600 dark:text-slate-300">
              {paper.model.verdict?.headline ??
                "Beast is still learning. It gives tips, but it will not trade on its own yet."}
            </p>

            {paper.settled > 0 ? (
              <>
                <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Stat label="Tips checked" value={String(paper.settled)} />
                  <Stat label="Right" value={pct(paper.winRate)} />
                  <Stat
                    label="Beat just holding"
                    value={pct(paper.beatMarket)}
                  />
                  <Stat
                    label="Practice result"
                    value={`${paper.totalReturn >= 0 ? "+" : ""}${(paper.totalReturn * 100).toFixed(1)}%`}
                    tone={paper.totalReturn >= 0 ? "up" : "down"}
                  />
                </div>
                <p className="muted-caption mt-3 text-xs">
                  Just holding the same coins for the same time would have returned{" "}
                  {paper.marketReturn >= 0 ? "+" : ""}
                  {(paper.marketReturn * 100).toFixed(1)}%. {paper.open > 0 && `${paper.open} more still being watched.`}
                </p>
              </>
            ) : (
              <p className="muted-caption mt-2 text-xs">
                {paper.open > 0
                  ? `${paper.open} tip${paper.open === 1 ? "" : "s"} being checked now. Results show up once they have had time to play out.`
                  : "Follow a coin and Beast will start checking its tips here, so you can see how it actually does."}
              </p>
            )}

            {paper.model.metrics && (
              <p className="muted-caption mt-4 border-t border-slate-200 pt-3 text-xs dark:border-slate-800">
                From testing: {pct(paper.model.metrics.accuracy)} of its calls were right, and it makes{" "}
                {(paper.model.metrics.expectancy * 100).toFixed(2)}% per trade after fees.{" "}
                {paper.model.promoted
                  ? "That is good enough for Beast to trade on its own."
                  : "That is not good enough, so trades only happen when you tap them."}
              </p>
            )}
          </Card>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-display font-bold">Latest tips from Beast</h2>
          <Link to="/signals" className="text-sm font-medium text-brand-600 dark:text-brand-400">
            See all
          </Link>
        </div>
        {loading ? (
          <div className="mt-4"><SkeletonRows n={2} h="h-16" /></div>
        ) : signals.length === 0 ? (
          <div className="mt-4">
            <Empty title="No tips yet" hint="Follow a few coins and Beast will start giving you tips within a minute." />
          </div>
        ) : (
          <div className="mt-4 space-y-2">
            {signals.slice(0, 6).map((s) => (
              <Card key={s.id} className="flex flex-wrap items-center gap-3 border-l-2 border-l-plasma p-4">
                <span className="font-display font-bold">{s.token}</span>
                <SignalChip signal={s.signal} />
                <ConfidenceBar value={Number(s.confidence)} />
                <span className="ml-auto tnum font-mono text-xs text-slate-500 dark:text-slate-400">
                  ${fmtUsd(s.data_json?.market?.price_usd)} · {new Date(s.created_at).toLocaleTimeString()}
                </span>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
