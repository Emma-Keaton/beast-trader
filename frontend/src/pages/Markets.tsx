import { useCallback, useEffect, useRef, useState } from "react";
import { Compass, Flame, Search, TrendingUp, X } from "lucide-react";
import { api, type Token, type WatchlistItem } from "../lib/api";
import { TokenCard } from "../components/TokenCard";
import { Empty, SkeletonRows } from "../components/ui";

export default function Markets() {
  const [trending, setTrending] = useState<Token[]>([]);
  const [movers, setMovers] = useState<Token[]>([]);
  const [watched, setWatched] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Token[]>([]);
  const [searching, setSearching] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const syncWatched = useCallback(async () => {
    try {
      const w: WatchlistItem[] = await api.watchlist();
      // Identity is chain + symbol: the same ticker can exist on several
      // chains, and starring one must not light up all of them.
      setWatched(new Set(w.map((x) => `${x.chain ?? ""}:${x.symbol}`)));
    } catch {
      /* backend offline */
    }
  }, []);

  useEffect(() => {
    Promise.all([api.trending().catch(() => []), api.movers().catch(() => []), syncWatched()])
      .then(([t, m]) => {
        setTrending(Array.isArray(t) ? t : []);
        setMovers(Array.isArray(m) ? m : []);
      })
      .finally(() => setLoading(false));
  }, [syncWatched]);

  // Debounced search (350ms)
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!query.trim()) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    timer.current = setTimeout(async () => {
      try {
        setResults(await api.search(query.trim()));
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query]);

  const onStar = async (token: Token, nowStarred: boolean) => {
    const key = `${token.chain ?? ""}:${token.symbol}`;
    setWatched((prev) => {
      const next = new Set(prev);
      if (nowStarred) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  /** True when this exact coin (chain + ticker) is already followed. */
  const isWatched = (t: Token) => watched.has(`${t.chain ?? ""}:${t.symbol}`);

  return (
    <div className="animate-fade-up space-y-6">
      <header>
        <p className="eyebrow">Find coins</p>
        <h1 className="page-title">Markets</h1>
        <p className="muted-caption mt-1">
          Search for any coin. Tap the star and Beast starts watching it for you.
        </p>
      </header>

      {/* Search */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          className="input pl-10 pr-10"
          placeholder="Search BTC, SOL, JUP, PEPE…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search tokens"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="Clear search"
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
          >
            <X size={16} />
          </button>
        )}
      </div>

      {/* Results / trending */}
      <section>
        {query.trim() ? (
          <>
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-600 dark:text-slate-300">
              <Compass className="h-4 w-4 text-brand-500" />
              {searching ? "Searching…" : `${results.length} result${results.length === 1 ? "" : "s"}`}
            </h2>
            {searching ? (
              <SkeletonRows />
            ) : results.length === 0 ? (
              <Empty title="No coins found" hint="Try a ticker like SOL, or part of a name like bonk." />
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {results.map((t) => (
                  <TokenCard
                    key={`${t.chain ?? "x"}:${t.address ?? t.symbol}`}
                    token={t}
                    starred={isWatched(t)}
                    onStar={onStar}
                  />
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            {/* Top performers first: this is the section users act on. */}
            {movers.length > 0 && (
              <section className="mb-8">
                <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-600 dark:text-slate-300">
                  <Flame className="h-4 w-4 text-orange-500" /> Big movers right now
                </h2>
                <p className="muted-caption mb-3 text-xs">
                  Biggest moves of the last day, from every chain. Only coins with enough buyers to actually trade are shown.
                </p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                  {movers.map((t) => (
                    <TokenCard
                      key={`mv-${t.chain ?? "x"}:${t.address ?? t.symbol}`}
                      token={t}
                      starred={isWatched(t)}
                      onStar={onStar}
                    />
                  ))}
                </div>
              </section>
            )}

            <section>
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-600 dark:text-slate-300">
                <TrendingUp className="h-4 w-4 text-brand-500" /> Popular right now
              </h2>
              {loading ? (
                <SkeletonRows />
              ) : trending.length === 0 ? (
                <Empty
                  title="We can't load prices right now"
                  hint="Check your connection and try again in a moment."
                />
              ) : (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                  {trending.map((t) => (
                    <TokenCard
                      key={`tr-${t.chain ?? "x"}:${t.address ?? t.symbol}`}
                      token={t}
                      starred={isWatched(t)}
                      onStar={onStar}
                    />
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </section>
    </div>
  );
}
