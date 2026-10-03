/**
 * Currency context.
 *
 * Holds the reader's chosen currency and the live rate table. The rate is
 * fetched once and cached client-side, because it changes on the order of
 * 0.1% a day and every page needs it.
 *
 * The chosen currency is stored per device on the server, so it follows the
 * reader to another browser, but it is also mirrored in localStorage so the
 * very first paint is already in the right currency instead of flashing USD.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type FxRates } from "./api";
import { fmtMoney, fmtMoneyCompact, type Currency } from "./currency";

const KEY = "beast_currency";

const FALLBACK: FxRates = { available: false, rates: { USD: 1 }, updated: null, source: "", supported: [] };

type Ctx = {
  currency: Currency;
  setCurrency: (c: Currency) => void;
  /** Multiplier applied to a USD amount to get the current currency. */
  rate: number;
  fx: FxRates;
  /** False when the rate provider is down, so the UI can say so. */
  live: boolean;
  fmt: (usd: number | null | undefined) => string;
  fmtCompact: (usd: number | null | undefined) => string;
};

const CurrencyContext = createContext<Ctx | null>(null);

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const [currency, setCurrencyState] = useState<Currency>(() => {
    const saved = localStorage.getItem(KEY) as Currency | null;
    return saved ?? "USD";
  });
  const [fx, setFx] = useState<FxRates>(FALLBACK);

  useEffect(() => {
    let cancelled = false;
    api
      .fx()
      .then((j) => !cancelled && setFx(j))
      // A converter outage must never break a price page: the context simply
      // stays on the USD fallback rates and the UI flags it as unavailable.
      .catch(() => !cancelled && setFx(FALLBACK));
    return () => {
      cancelled = true;
    };
  }, []);

  const setCurrency = useCallback((c: Currency) => {
    setCurrencyState(c);
    localStorage.setItem(KEY, c);
    // Persist server-side too, but only after the local switch has already
    // happened: a failed save must not roll the UI back.
    api.saveSettings({ currency: c }).catch(() => {});
  }, []);

  const rate = fx.rates?.[currency] ?? 1;

  const value = useMemo<Ctx>(
    () => ({
      currency,
      setCurrency,
      rate,
      fx,
      live: fx.available !== false && currency === "USD" ? true : Boolean(fx.rates?.[currency]),
      fmt: (usd) => fmtMoney(usd, currency, rate),
      fmtCompact: (usd) => fmtMoneyCompact(usd, currency, rate),
    }),
    [currency, setCurrency, rate, fx],
  );

  return <CurrencyContext.Provider value={value}>{children}</CurrencyContext.Provider>;
}

export function useCurrency(): Ctx {
  const ctx = useContext(CurrencyContext);
  if (!ctx) throw new Error("useCurrency must be used inside <CurrencyProvider>");
  return ctx;
}
