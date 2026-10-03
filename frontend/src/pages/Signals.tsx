import { useEffect, useState } from "react";
import { Activity, Zap } from "lucide-react";
import { api, type Order, type SignalLog } from "../lib/api";
import { fmtUsd } from "../lib/format";
import { useToast } from "../components/Toast";
import { Card, ChainBadge, ConfidenceBar, Empty, SignalChip, SkeletonRows } from "../components/ui";

export default function Signals() {
  const toast = useToast();
  const [signals, setSignals] = useState<SignalLog[]>([]);
  const [trades, setTrades] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    try {
      const [s, t] = await Promise.all([api.signals(), api.trades()]);
      setSignals(s);
      setTrades(t);
    } catch {
      /* offline */
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  async function execute(sig: SignalLog) {
    setBusy(sig.id);
    try {
      const order = await api.execute(sig.token, sig.signal, sig.data_json?.token?.chain);
      toast("success", `Practice ${order.side === "BUY" ? "buy" : "sell"} placed for ${sig.token}`);
      await load();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="animate-fade-up space-y-8">
      <header>
        <p className="eyebrow">What Beast has been thinking</p>
        <h1 className="page-title">Tips &amp; Trades</h1>
        <p className="muted-caption mt-1">
          Every tip Beast gives you, and every practice trade it has made. You can also trade a tip yourself with one tap.
        </p>
      </header>

      <section>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-600 dark:text-slate-300">
          <Activity className="h-4 w-4 text-brand-500" /> Recent tips
        </h2>
        {loading ? (
          <SkeletonRows n={2} h="h-16" />
        ) : signals.length === 0 ? (
          <Empty title="No tips yet" hint="Follow a coin and Beast will start giving you tips within a minute." />
        ) : (
          <div className="space-y-2">
            {signals.map((s) => (
              <Card key={s.id} className="flex flex-wrap items-center gap-3 border-l-2 border-l-plasma p-4">
                <span className="font-display font-bold">{s.token}</span>
                <SignalChip signal={s.signal} />
                <ConfidenceBar value={Number(s.confidence)} />
                <ChainBadge chain={s.data_json?.token?.chain} />
                <span className="tnum font-mono text-xs text-slate-500 dark:text-slate-400">
                  ${fmtUsd(s.data_json?.market?.price_usd)}
                </span>
                <span className="ml-auto flex items-center gap-2">
                  <span className="hidden text-xs text-slate-500 sm:block dark:text-slate-400">
                    {new Date(s.created_at).toLocaleString()}
                  </span>
                  {s.signal !== "HOLD" && (
                    <button
                      type="button"
                      disabled={busy === s.id}
                      onClick={() => execute(s)}
                      className="btn-primary !px-3 !py-1.5 text-xs"
                    >
                      <Zap size={12} /> Trade this
                    </button>
                  )}
                </span>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-600 dark:text-slate-300">
          <Zap className="h-4 w-4 text-alpha" /> Your trades
        </h2>
        {trades.length === 0 ? (
          <Empty title="No trades yet" hint="When you (or Beast) trade, it will show up here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:text-slate-400">
                  <th className="py-2 pr-3">When</th>
                  <th className="py-2 pr-3">Coin</th>
                  <th className="py-2 pr-3">Action</th>
                  <th className="py-2 pr-3 text-right">Amount</th>
                  <th className="py-2 pr-3 text-right">Value</th>
                  <th className="py-2 pr-3">Where</th>
                  <th className="py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((o) => (
                  <tr key={o.id} className="border-b border-slate-100 dark:border-slate-800/60">
                    <td className="tnum py-2 pr-3 font-mono text-xs text-slate-500 dark:text-slate-400">
                      {new Date(o.created_at).toLocaleString()}
                    </td>
                    <td className="py-2 pr-3 font-semibold">{o.symbol}</td>
                    <td className="py-2 pr-3"><SignalChip signal={o.side} /></td>
                    <td className="tnum py-2 pr-3 text-right font-mono">{o.qty}</td>
                    <td className="tnum py-2 pr-3 text-right font-mono">${fmtUsd(o.notional_usd)}</td>
                    <td className="py-2 pr-3 text-xs text-slate-500 dark:text-slate-400">
                      {o.venue === "dex" ? "Decentralised" : "Exchange"}
                    </td>
                    <td className="py-2 text-xs">
                      <span className={o.status.startsWith("filled") ? "text-bull" : "text-alpha"}>{o.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
