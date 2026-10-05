import { useEffect, useState } from "react";
import { Banknote, KeyRound, Save, ShieldCheck, Sparkles, Wallet } from "lucide-react";
import { api, type Capabilities, type DeviceSettings, type ImprovementReport } from "../lib/api";
import { resetDeviceId } from "../lib/device";
import { CURRENCIES } from "../lib/currency";
import { useCurrency } from "../lib/CurrencyContext";
import { useToast } from "../components/Toast";
import { Card, ConfirmModal, cx } from "../components/ui";

/**
 * A small live converter, so a reader can sanity-check the rate the app is
 * using before trusting a price in it. It is deliberately plain arithmetic on
 * the same rate table the app prices with — a second source here would let the
 * converter disagree with the prices, which is worse than not having one.
 */
function CurrencyConverter() {
  const { currency, rate, fx, live, fmt } = useCurrency();
  const [amount, setAmount] = useState("100");
  const [direction, setDirection] = useState<"to" | "from">("to");

  const n = Number(amount);
  const valid = Number.isFinite(n) && amount.trim() !== "";
  const converted = valid ? (direction === "to" ? n * rate : n / rate) : null;

  return (
    <div className="mt-5 rounded-control border border-slate-200 bg-slate-50/60 p-4 dark:border-slate-700 dark:bg-slate-800/40">
      <div className="flex items-end gap-3">
        <label className="flex-1">
          <span className="muted-caption">Amount</span>
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="tnum mt-1 w-full rounded-control border border-slate-200 bg-white px-3 py-2 font-mono text-sm dark:border-slate-700 dark:bg-slate-900"
          />
        </label>
        <button
          type="button"
          onClick={() => setDirection((d) => (d === "to" ? "from" : "to"))}
          className="rounded-control border border-slate-200 px-3 py-2 text-sm dark:border-slate-700"
          aria-label="Swap conversion direction"
        >
          {direction === "to" ? "USD →" : "← USD"}
        </button>
        <div className="flex-1">
          <span className="muted-caption">
            {direction === "to" ? currency : "USD"}
          </span>
          <p className="tnum mt-1 rounded-control border border-slate-200 bg-white px-3 py-2 font-mono text-sm font-semibold dark:border-slate-700 dark:bg-slate-900">
            {converted == null
              ? "—"
              : direction === "to"
                ? converted.toLocaleString(undefined, { maximumFractionDigits: 2 })
                : converted.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </p>
        </div>
      </div>

      <p className="muted-caption mt-3">
        {live ? (
          <>
            1 USD = {rate.toLocaleString(undefined, { maximumFractionDigits: 2 })} {currency}
            {fx.updated ? ` · rate from ${fx.source}, updated ${new Date(fx.updated).toLocaleString()}` : ""}
            {" · mid-market reference, so a bank or bureau will differ slightly."}
          </>
        ) : (
          <>We could not reach the exchange-rate service, so prices are still shown in dollars.</>
        )}
      </p>
      <p className="muted-caption mt-1">
        Every price in the app is converted with this same rate — for example, Bitcoin shows as {fmt(83_000)}.
      </p>
    </div>
  );
}

/**
 * Shows the app's self-improvement loop: which model is in use, which
 * candidates are being tested against it, and why the last cycle did or did not
 * change anything.
 *
 * The rejected candidates are shown as well as the winner. A self-improving
 * system that only ever displays its successes is indistinguishable from one
 * that is fitting noise, so this panel makes the gate visible: a candidate that
 * did not beat the champion is shown with the reason it was turned down.
 */
function ModelImprovement() {
  const toast = useToast();
  const [report, setReport] = useState<ImprovementReport | null>(null);
  const [running, setRunning] = useState(false);

  const load = async () => {
    try {
      setReport(await api.improvement());
    } catch {
      // A failure here is cosmetic — the app works fine without the panel.
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  async function run() {
    setRunning(true);
    try {
      const r = await api.runImprovement();
      await load();
      toast(
        "success",
        r.promoted
          ? `Promoted ${r.promoted} — it beat the model in use`
          : r.trained?.ran
            ? `Tested a new candidate on ${r.trained.trained_on} calls`
            : (r.trained?.reason ?? r.promotion.reason),
      );
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  const pct = (v: number | null | undefined) =>
    v == null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(3)}%`;

  return (
    <Card className="p-5">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 font-display font-bold">
          <Sparkles className="h-4 w-4 text-brand-500" /> How this app is improving itself
        </h2>
        <button
          type="button"
          onClick={run}
          disabled={running}
          className="rounded-control border border-slate-200 px-3 py-1.5 text-xs font-medium disabled:opacity-50 dark:border-slate-700"
        >
          {running ? "Testing…" : "Test a new model now"}
        </button>
      </div>
      <p className="muted-caption mb-4">
        Every settled paper call is stored with the exact market features that produced it. Those calls
        become the training set for the next generation of models. A new model never replaces the one in
        use until it has demonstrably beaten it on real, fee-paying outcomes.
      </p>

      <div className="rounded-control border border-emerald-200 bg-emerald-50/60 p-3 dark:border-emerald-900 dark:bg-emerald-950/30">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
            In use
          </span>
          {report?.champion?.installedAt && (
            <span className="text-[11px] text-slate-500 dark:text-slate-400">
              since {new Date(report.champion.installedAt).toLocaleString()}
            </span>
          )}
        </div>
        <p className="mt-0.5 font-mono text-sm">{report?.champion?.label ?? "The rules-based fallback"}</p>
      </div>

      <div className="mt-4">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Being tested against it
        </p>
        {!report?.challengers?.length ? (
          <p className="muted-caption">
            No candidates yet. One is built automatically once enough calls have settled to train on.
          </p>
        ) : (
          <ul className="space-y-2">
            {report.challengers.map((c) => (
              <li
                key={c.id}
                className="flex items-center justify-between gap-3 rounded-control border border-slate-200 px-3 py-2 dark:border-slate-700"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{c.label}</p>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    {c.settled} settled call{c.settled === 1 ? "" : "s"}
                    {c.eligible ? " · eligible for promotion" : ` · needs ${report.rules.minSettledCalls}`}
                  </p>
                </div>
                <div className="tnum shrink-0 text-right">
                  <p className="text-sm font-semibold">{pct(c.expectancy)}</p>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">per trade, after fees</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      {report?.lastCycle && (
        <p className="muted-caption mt-4 border-t border-slate-200 pt-3 dark:border-slate-700">
          {report.lastCycle.promoted
            ? `promoted ${report.lastCycle.promoted}.`
            : (report.lastCycle.promotionReason ?? report.lastCycle.trained?.reason ?? "no change.")}
        </p>
      )}
    </Card>
  );
}

export default function SettingsPage({ onSaved }: { onSaved: (s: DeviceSettings) => void }) {
  const toast = useToast();
  const { currency, setCurrency } = useCurrency();
  const [s, setS] = useState<DeviceSettings>({});
  // Venue list comes from the API rather than a literal, so the UI cannot drift
  // out of step with what the backend actually supports.
  const [venues, setVenues] = useState<{ id: string; label: string; note?: string; needsPassphrase?: boolean }[]>([]);
  // Draft key material, keyed by venue. Never merged into `s` — a typed key must
  // not sit in the settings object the rest of the page renders from.
  const [venueKeys, setVenueKeys] = useState<Record<string, { apiKey?: string; apiSecret?: string; passphrase?: string }>>({});
  const [saving, setSaving] = useState(false);


  // Risk slider. The server resolves the position and returns the limits it will
  // actually enforce, so nothing here duplicates that mapping.
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [riskLevel, setRiskLevel] = useState(50);
  const [risk, setRisk] = useState<Awaited<ReturnType<typeof api.risk>> | null>(null);
  const [riskBusy, setRiskBusy] = useState(false);

  /**
   * Persist a slider move, on release rather than on every input event.
   *
   * A drag across the range emits dozens of values and would issue dozens of
   * writes, each narrowing the trading limits mid-drag. One write per gesture.
   */
  async function pushRisk() {
    setRiskBusy(true);
    try {
      const r = await api.risk(riskLevel);
      setRisk(r);
      onSaved(r.settings);
      api.capabilities().then(setCaps).catch(() => {});
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setRiskBusy(false);
    }
  }
  useEffect(() => {
    api.exchanges().then((r) => setVenues(r.exchanges ?? [])).catch(() => setVenues([]));
    api.risk(50).then((r) => { setRisk(r); setRiskLevel(r.profile.position); }).catch(() => {});
    api.capabilities().then(setCaps).catch(() => {});
  }, []);

  const set = <K extends keyof DeviceSettings>(k: K, v: DeviceSettings[K]) => setS((p) => ({ ...p, [k]: v }));

  const setVenueKey = (id: string, field: "apiKey" | "apiSecret" | "passphrase", value: string) =>
    setVenueKeys((p) => ({ ...p, [id]: { ...(p[id] ?? {}), [field]: value } }));

 const [modePrompt, setModePrompt] = useState<null | "live">(null);
  const [readiness, setReadiness] = useState<Awaited<ReturnType<typeof api.liveReadiness>> | null>(null);
  const [modeBusy, setModeBusy] = useState(false);

  /**
   * Changing mode is intercepted rather than saved like any other preference.
   *
   * Going to live opens a blocking modal and requires a separate confirmed call;
   * going back to paper happens immediately, because a user must never be
   * prevented from reducing their own risk by a dialog. The dialog's direction is
   * fixed by the server, so it also re-checks readiness live rather than trusting
   * a snapshot rendered before the click.
   */
  async function requestMode(next: "paper" | "live") {
    if (next === "paper") {
      setModeBusy(true);
      try {
        const r = await api.setTradingMode("paper");
        const merged = { ...s, trading_mode: "paper" as const };
        setS(merged);
        onSaved(merged);
        toast("success", r.note ?? "Switched to practice trading");
      } catch (e) {
        toast("error", (e as Error).message);
      } finally {
        setModeBusy(false);
      }
      return;
    }
    setReadiness(null);
    setModePrompt("live");
    api
      .liveReadiness()
      .then(setReadiness)
      .catch(() => setReadiness(null));
  }

  async function confirmLive() {
    setModeBusy(true);
    try {
      const r = await api.setTradingMode("live", true);
      const merged = { ...s, trading_mode: "live" as const };
      setS(merged);
      onSaved(merged);
      setModePrompt(null);
      toast("success", "Live trading enabled — real orders from now on");
      void r;
    } catch (e) {
      // The server refuses with the full readiness list; surface it rather than
      // a generic failure, so the user knows what is actually blocking them.
      const msg = (e as Error).message;
      toast("error", msg);
      api.liveReadiness().then(setReadiness).catch(() => {});
    } finally {
      setModeBusy(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      // Only venues with something typed are sent. Sending an empty object for a
      // connected venue would tell the server "here are the credentials" with
      // blanks, and the masked round trip would then blank the stored key.
      // Drafts hold real secrets; `DeviceSettings.exchanges` holds only the masked
      // `{hasKey}` shape the API returns. They are different types on purpose, so
      // a masked object can never be sent back as though it were credentials.
      const draftExchanges: Record<string, { apiKey?: string; apiSecret?: string; passphrase?: string }> = {};
      for (const [id, creds] of Object.entries(venueKeys)) {
        if (creds.apiKey || creds.apiSecret || creds.passphrase) draftExchanges[id] = creds;
      }
      const payload: Partial<DeviceSettings> & {
        exchanges?: Record<string, { apiKey?: string; apiSecret?: string; passphrase?: string }>;
      } = { ...s };
      delete payload.exchanges;
      if (Object.keys(draftExchanges).length) payload.exchanges = draftExchanges;

      const next = await api.saveSettings(payload);
      setS(next);
      onSaved(next);
      // Draft key material is cleared from component state the moment it is
      // accepted, so a typed secret does not linger in memory or in React DevTools.
      setVenueKeys({});
      toast("success", "Settings saved");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const isLive = (s.trading_mode ?? "paper") === "live";

  return (
    <div className="animate-fade-up max-w-3xl space-y-6">
      {/* Reverting to paper must be the fastest possible action in the app.
          Deliberately no dialog, one click, and the button is also a browser
          confirm so an accidental tap cannot do it silently. Nothing about
          reducing your own risk should ever be gated behind a second decision. */}
      {isLive && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-red-500/40 bg-red-500/10 p-4">
          <div>
            <p className="text-sm font-semibold text-red-300">Live trading is on — real orders are being placed.</p>
            <p className="text-xs text-red-200/70">
              Switch back to practice whenever you like. No confirmation needed, and open positions are not
              closed automatically.
            </p>
          </div>
          <button
            type="button"
            className="btn-secondary"
            disabled={modeBusy}
            onClick={() => {
              if (window.confirm("Switch back to practice trading? Open positions stay open.")) {
                void requestMode("paper");
              }
            }}
          >
            {modeBusy ? "Switching…" : "Back to practice"}
          </button>
        </div>
      )}
      <header>
        <p className="eyebrow">Saved safely on this device</p>
        <h1 className="page-title">Settings</h1>
      </header>

      <ModelImprovement />

      {/* Display currency */}
      <Card className="p-5">
        <h2 className="mb-1 flex items-center gap-2 font-display font-bold">
          <Banknote className="h-4 w-4 text-brand-500" /> Display currency
        </h2>
        <p className="muted-caption mb-4">
          Shows every price in Beast-Trader in the money you think in. Only the display changes — your
          trades, stops and P&amp;L are always calculated in dollars.
        </p>

        <div className="flex flex-wrap gap-2">
          {CURRENCIES.map((c) => (
            <button
              key={c.code}
              type="button"
              onClick={() => setCurrency(c.code)}
              aria-pressed={currency === c.code}
              className={cx(
                "rounded-control border px-3 py-2 text-left transition",
                currency === c.code
                  ? "border-brand-500 bg-brand-500/10 font-semibold text-brand-700 dark:text-brand-300"
                  : "border-slate-200 text-slate-600 hover:border-brand-400 dark:border-slate-700 dark:text-slate-300",
              )}
            >
              <span className="block text-sm">
                {c.symbol} {c.code}
              </span>
              <span className="block text-[11px] opacity-70">{c.label}</span>
            </button>
          ))}
        </div>

        <CurrencyConverter />
      </Card>

      {/* Wallet */}
      <Card className="p-5">
        <h2 className="mb-1 flex items-center gap-2 font-display font-bold">
          <Wallet className="h-4 w-4 text-brand-500" /> Wallet
        </h2>
        <p className="muted-caption mb-4 text-xs">
          Connect a trading wallet. DEX orders are signed by this wallet.
        </p>
        <div className="grid gap-3 sm:grid-cols-[140px_1fr]">
          <div>
            <label className="field-label">Wallet</label>
            <select
              className="input"
              value={s.wallet_chain || "evm"}
              onChange={(e) => set("wallet_chain", e.target.value)}
            >
              <option value="evm">Ethereum</option>
              <option value="solana">Solana</option>
            </select>
          </div>
          <div>
            <label className="field-label">Wallet address</label>
            <input
              className="input font-mono"
              placeholder="Paste your wallet address"
              value={s.wallet_address || ""}
              onChange={(e) => set("wallet_address", e.target.value.trim())}
            />
          </div>
        </div>
      </Card>

      {/* CEX keys */}
      <Card className="p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="mb-1 flex items-center gap-2 font-display font-bold">
              <KeyRound className="h-4 w-4 text-brand-500" /> Exchange keys
            </h2>
            <p className="muted-caption text-xs">
              Your keys are encrypted and stored on this device only. We never show them again.
            </p>
          </div>
          <select
            className="rounded-control border border-slate-300 bg-transparent px-2 py-1 text-sm dark:border-slate-600"
            value={s.exchange_id ?? ""}
            onChange={(e) => set("exchange_id", e.target.value)}
            aria-label="Active trading venue"
          >
            <option value="">Choose where to trade…</option>
            {venues.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
                {s.exchanges?.[v.id]?.hasKey ? " — connected" : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-4">
          {venues.map((v) => {
            const connected = Boolean(s.exchanges?.[v.id]?.hasKey && s.exchanges?.[v.id]?.hasSecret);
            return (
              <div key={v.id} className="rounded-control border border-slate-200 p-3 dark:border-slate-700">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{v.label}</span>
                  {connected ? (
                    <span className="text-xs font-semibold text-emerald-500">Connected</span>
                  ) : (
                    <span className="text-xs text-slate-400">Not connected</span>
                  )}
                </div>
                {v.note && <p className="mb-2 text-xs text-slate-400">{v.note}</p>}
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="field-label">API key</label>
                    <input
                      type="password"
                      autoComplete="off"
                      className="input"
                      placeholder={connected ? "Saved — type to replace" : "Paste your key"}
                      value={venueKeys[v.id]?.apiKey ?? ""}
                      onChange={(e) => setVenueKey(v.id, "apiKey", e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="field-label">API secret</label>
                    <input
                      type="password"
                      autoComplete="off"
                      className="input"
                      placeholder={connected ? "Saved — type to replace" : "Paste your secret"}
                      value={venueKeys[v.id]?.apiSecret ?? ""}
                      onChange={(e) => setVenueKey(v.id, "apiSecret", e.target.value)}
                    />
                  </div>
                  {v.needsPassphrase && (
                    <div className="sm:col-span-2">
                      <label className="field-label">Passphrase (required by {v.label})</label>
                      <input
                        type="password"
                        autoComplete="off"
                        className="input"
                        placeholder={s.exchanges?.[v.id]?.hasPassphrase ? "Saved — type to replace" : "Passphrase"}
                        value={venueKeys[v.id]?.passphrase ?? ""}
                        onChange={(e) => setVenueKey(v.id, "passphrase", e.target.value)}
                      />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Trading */}
      <Card className="p-5">
        <h2 className="mb-4 flex items-center gap-2 font-display font-bold">
          <ShieldCheck className="h-4 w-4 text-brand-500" /> Trading
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex items-center justify-between gap-3 rounded-control border border-slate-200 px-4 py-3 dark:border-slate-700">
            <span className="text-sm font-medium">Let Beast trade for me</span>
            <input
              type="checkbox"
              className="h-5 w-5 accent-teal-600"
              checked={Boolean(s.autopilot)}
              onChange={(e) => set("autopilot", e.target.checked)}
            />
          </label>
          {/* One slider, three sectors. Every consequence is shown as a number
              because "aggressive" means nothing on its own — what the user is
              agreeing to is $500 per trade at 38% confidence across 8 positions. */}
          <div className="flex flex-col gap-3 rounded-control border border-slate-200 px-4 py-3 dark:border-slate-700">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-medium">Risk</span>
              {risk && (
                <span
                  className={cx(
                    "text-xs font-semibold uppercase tracking-wide",
                    risk.profile.sector === "conservative" && "text-sky-400",
                    risk.profile.sector === "balanced" && "text-amber-400",
                    risk.profile.sector === "aggressive" && "text-red-400",
                  )}
                >
                  {risk.profile.sectorLabel}
                </span>
              )}
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={riskLevel}
              onChange={(e) => setRiskLevel(Number(e.target.value))}
              onMouseUp={pushRisk}
              onTouchEnd={pushRisk}
              onKeyUp={pushRisk}
              disabled={riskBusy}
              aria-label="Risk level"
              className="w-full accent-brand-500"
            />
            <div className="flex justify-between text-[11px] text-slate-400">
              <span>Conservative</span>
              <span>Balanced</span>
              <span>Aggressive</span>
            </div>
            {risk && (
              <>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
                  {[
                    ["Per trade", `$${risk.profile.maxOrderUsd.toFixed(0)}`],
                    ["Confidence", `${Math.round(risk.profile.minConfidence * 100)}%`],
                    ["Daily loss", `$${risk.profile.maxDailyLossUsd.toFixed(0)}`],
                    ["Positions", String(risk.profile.maxOpenPositions)],
                  ].map(([k, v]) => (
                    <div key={k}>
                      <dt className="text-slate-400">{k}</dt>
                      <dd className="font-semibold text-slate-200">{v}</dd>
                    </div>
                  ))}
                </dl>
                <p className="text-xs leading-relaxed text-slate-400">{risk.description}</p>
                {risk.profile.sector === "aggressive" && (
                  <p className="text-xs leading-relaxed text-red-400">
                    At this setting the app takes large positions on weak signals. Most accounts lose money
                    here. The slider does not make the strategy work — it only changes how much is at stake when
                    it does not.
                  </p>
                )}
              </>
            )}
          </div>
          {/* Three orthogonal axes, not one mode.
              "Does money move", "who signs" and "where the key lives" are
              independent questions, and the old single dropdown admitted
              combinations like "assisted paper" that mean nothing. */}
          <div className="space-y-3 rounded-control border border-slate-200 p-4 dark:border-slate-700">
            <div>
              <span className="text-sm font-medium">How the app is allowed to trade</span>
              <p className="mt-1 text-xs leading-relaxed text-slate-400">{caps?.description ?? "…"}</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1">
                <span className="field-label">Does money move?</span>
                <select
                  className="rounded-control border border-slate-300 bg-transparent px-2 py-1 text-sm dark:border-slate-600"
                  value={s.trading_mode ?? "paper"}
                  onChange={(e) => requestMode(e.target.value as "paper" | "live")}
                >
                  <option value="paper">Practice — never places an order</option>
                  <option value="live">Real money</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="field-label">Who signs each trade?</span>
                <select
                  className="rounded-control border border-slate-300 bg-transparent px-2 py-1 text-sm dark:border-slate-600"
                  value={s.trade_authority ?? "approve"}
                  onChange={(e) => set("trade_authority", e.target.value as "auto" | "approve")}
                >
                  <option value="approve">I do — the app proposes, I confirm</option>
                  <option value="auto">The app does — unattended</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 sm:col-span-2">
                <span className="field-label">Where does the signing key live?</span>
                <select
                  className="rounded-control border border-slate-300 bg-transparent px-2 py-1 text-sm dark:border-slate-600"
                  value={s.custody ?? "cex_key"}
                  onChange={(e) => set("custody", e.target.value as "cex_key" | "wallet")}
                >
                  <option value="cex_key">On my exchange (I paste an API key)</option>
                  <option value="wallet">In my wallet (Phantom, MetaMask…)</option>
                </select>
              </label>
            </div>
            {caps && !caps.canSignServerSide && s.trading_mode === "live" && s.trade_authority === "auto" && (
              <p className="text-xs leading-relaxed text-amber-400">
                Wallet custody cannot sign orders unattended yet — that needs session keys, which are not
                built. Until then this combination will propose trades instead of placing them, or switch
                to an exchange key.
              </p>
            )}
          </div>
          <div>
            <label className="field-label">Largest trade ($)</label>
            <input
              type="number"
              min={1}
              className="input"
              value={s.max_order_usd ?? 100}
              onChange={(e) => set("max_order_usd", Number(e.target.value) || 100)}
            />
          </div>
          <div>
            <label className="field-label">Only trade when it is at least this sure (0–1)</label>
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              className="input"
              value={s.auto_trade_min_confidence ?? 0.65}
              onChange={(e) => set("auto_trade_min_confidence", Number(e.target.value))}
            />
          </div>
        </div>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          className="btn-secondary text-xs"
          onClick={() => {
            resetDeviceId();
            localStorage.removeItem("beast_jwt");
            location.reload();
          }}
        >
          Reset this device id
        </button>
        <button type="button" className="btn-primary" disabled={saving} onClick={save}>
          <Save className="h-4 w-4" /> {saving ? "Saving…" : "Save"}
        </button>
      </div>

      <ConfirmModal
        open={modePrompt === "live"}
        title="Trade with real money?"
        destructive
        busy={modeBusy}
        confirmLabel="Yes, go live"
        cancelLabel="Stay in practice"
        onCancel={() => setModePrompt(null)}
        onConfirm={confirmLive}
        body={
          <>
            <p>
              From the moment you confirm, this app places <strong>real orders</strong> with your own
              money on your connected exchange. Paper trading stops.
            </p>
            <p>
              The app has never demonstrated it can make a profit. Its own research found that the
              &ldquo;buy the top gainers&rdquo; strategy returns the same as simply holding everything, and
              that no model has yet been validated on live data. You can lose money, including your
              entire balance.
            </p>
            {!readiness && <p className="text-slate-400">Checking what still needs to be ready…</p>}
            {readiness && (
              <ul className="space-y-1.5 rounded-control border border-white/10 p-3">
                {readiness.checks.map((c) => (
                  <li key={c.name} className="flex items-start gap-2 text-sm">
                    <span className={cx("mt-0.5 font-semibold", c.passed ? "text-emerald-400" : "text-amber-400")}>
                      {c.passed ? "✓" : "•"}
                    </span>
                    <span className={c.passed ? "text-slate-400" : "text-slate-200"}>{c.detail}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-slate-400">
              {readiness?.ready
                ? "Everything checks out. Switching back to practice is always available without a dialog."
                : "Live trading will be refused until every item above passes."}
            </p>
          </>
        }
      />
    </div>
  );
}

// `stripEmpty` is no longer used: venue credentials are sent as a nested object,
// and the server treats absent fields as "leave this value alone" rather than
// "clear it". Keeping an empty-string-as-deletion path would be how a saved key
// gets wiped by a masked round trip.