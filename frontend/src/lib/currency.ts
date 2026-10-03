/**
 * Display currency.
 *
 * Every price in this app is stored and computed in USD, because that is what
 * every crypto feed quotes and what the model was trained on. Converting at
 * display time only is what makes this safe: a reader can switch to Naira and
 * back without a single stored value, stop level or P&L figure changing. The
 * alternative — storing converted prices — is how apps end up with a $100
 * position quietly becoming a ₦132,000 one.
 */

export type Currency = "USD" | "NGN" | "EUR" | "GBP" | "JPY" | "ZAR" | "KES" | "INR" | "CAD" | "AUD";

/** Currencies the backend can price, with how each one is written. */
export const CURRENCIES: { code: Currency; label: string; symbol: string }[] = [
  { code: "USD", label: "US Dollar", symbol: "$" },
  { code: "NGN", label: "Nigerian Naira", symbol: "₦" },
  { code: "EUR", label: "Euro", symbol: "€" },
  { code: "GBP", label: "British Pound", symbol: "£" },
  { code: "JPY", label: "Japanese Yen", symbol: "¥" },
  { code: "ZAR", label: "South African Rand", symbol: "R" },
  { code: "KES", label: "Kenyan Shilling", symbol: "KSh" },
  { code: "INR", label: "Indian Rupee", symbol: "₹" },
  { code: "CAD", label: "Canadian Dollar", symbol: "C$" },
  { code: "AUD", label: "Australian Dollar", symbol: "A$" },
];

export function currencySymbol(code: Currency): string {
  return CURRENCIES.find((c) => c.code === code)?.symbol ?? "$";
}

/**
 * Format a USD amount in the reader's currency.
 *
 * Decimals follow the size of the *converted* number, not the USD one, which
 * is what keeps ₦ amounts readable (no "₦0.0013") and USD micro-caps honest
 * (still enough significant figures to be useful).
 */
export function fmtMoney(usd: number | null | undefined, currency: Currency, rate: number): string {
  if (usd == null || Number.isNaN(usd) || !Number.isFinite(rate) || rate <= 0) return "—";
  const v = usd * rate;
  const sym = currencySymbol(currency);
  if (currency === "JPY") return `${sym}${Math.round(v).toLocaleString()}`;
  if (v >= 1000) return `${sym}${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (v >= 1) return `${sym}${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  if (v >= 0.01) return `${sym}${v.toFixed(4)}`;
  return `${sym}${v.toPrecision(3)}`;
}

/** A compact variant for dense tables, e.g. "₦1.3M". */
export function fmtMoneyCompact(usd: number | null | undefined, currency: Currency, rate: number): string {
  if (usd == null || Number.isNaN(usd) || !Number.isFinite(rate) || rate <= 0) return "—";
  const v = usd * rate;
  const sym = currencySymbol(currency);
  return `${sym}${Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(v)}`;
}
