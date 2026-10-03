import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { api, type ResearchNote, type WatchlistItem } from "../lib/api";
import { fmtUsd } from "../lib/format";
import { useToast } from "../components/Toast";
import { Card, ChainBadge, ConfidenceBar, DeltaPill, Empty, SignalChip, SkeletonRows } from "../components/ui";

const REFRESH_COOLDOWN = 15_000; // matches backend throttle

export default function Watchlist() {
  const toast = useToast();
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [prices, setPrices] = useState<Record<string, ResearchNote>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const lastRefresh = useRef(0);

  const load = useCallback(async () => {
    try {
      const w = await api.watchlist();
      setItems(w);
    } catch {
      /* offline */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000); // auto poll cadence (mirrors server)
    return () => clearInterval(t);
  }, [load]);

  async function pollNow(manual = true) {
    if (manual && Date.now() - lastRefresh.current < REFRESH_COOLDOWN) {
      toast("info", "We just checked — we'll look again in a few seconds");
      return;
    }
    lastRefresh.current = Date.now();
    setRefreshing(true);
    try {
      await api.refresh();
      for (const it of items) {
        try {
          const note = await api.research(it.symbol, it.chain === "coingecko" ? undefined : it.chain ?? undefined);
          setPrices((p) => ({ ...p, [it.symbol]: note }));
        } catch {
          /* per-token failure just skips a cell */
        }
      }
      toast("success", "Checked — fresh tips are in");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }

  async function remove(symbol: string) {
    try {
      await api.unstar(symbol);
      setItems((xs) => xs.filter((x) => x.symbol !== symbol));
      toast("info", `${symbol} removed`);
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  return (
    <div className="animate-fade-up space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Checked every 30 seconds</p>
          <h1 className="page-title">Your Coins</h1>
          <p className="muted-caption mt-1">
            Beast keeps an eye on these for you, even when this app is closed.
          </p>
        </div>
        <button type="button" className="btn-primary" disabled={refreshing} onClick={() => pollNow(true)}>
          <RefreshCw className={refreshing ? "h-4 w-4 animate-spin" : "h-4 w-4"} /> Check now
        </button>
      </header>

      {loading ? (
        <SkeletonRows n={2} h="h-20" />
      ) : items.length === 0 ? (
        <Empty title="You're not following any coins yet" hint="Open Markets and tap the star on a coin to start following it." />
      ) : (
        <div className="space-y-3">{items.map(renderItem)}</div>
      )}

      {items.length > 0 && (
        <p className="muted-caption text-center">
          Following more coins?{" "}
          <Link to="/markets" className="font-semibold text-brand-600 dark:text-brand-400">
            Find more →
          </Link>
        </p>
      )}
    </div>
  );

  function renderItem(it: WatchlistItem) {
    const note = prices[it.symbol];
    return (
      <Card key={it.symbol} className="p-4 md:p-5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-display text-lg font-bold">{it.symbol}</span>
              <span className="truncate text-xs text-slate-500 dark:text-slate-400">{it.name}</span>
              <ChainBadge chain={it.chain} source={it.source} />
            </div>
            <p className="muted-caption mt-0.5 flex items-center gap-1.5">
              <span className="inline-block h-1.5 w-1.5 animate-soft-pulse rounded-full bg-brand-500" />
              Being watched · last check {note ? new Date(note.generated_at).toLocaleTimeString() : "waiting"}
            </p>
          </div>
          <div className="text-right">
            <p className="tnum font-mono text-lg font-semibold">
              ${fmtUsd(note?.market?.price_usd ?? it.price_usd)}
            </p>
            <div className="mt-1 flex justify-end">
              <DeltaPill value={note?.market?.change_24h ?? it.change_24h} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            {note && <SignalChip signal={note.prediction.signal} />}
            {note && <ConfidenceBar value={note.prediction.confidence} />}
            <button
              type="button"
              aria-label={`Remove ${it.symbol}`}
              onClick={() => remove(it.symbol)}
              className="rounded-full p-2 text-slate-400 transition hover:bg-red-500/10 hover:text-bear"
            >
              <Trash2 size={16} />
            </button>
          </div>
        </div>
        {note && (
          <div className="mt-3 border-l-2 border-l-plasma pl-3">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-plasma">
              <Sparkles size={12} /> What Beast thinks
            </p>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{note.summary}</p>
          </div>
        )}
      </Card>
    );
  }
}
