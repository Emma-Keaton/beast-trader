export function fmtUsd(n?: number | null): string {
  if (n == null || Number.isNaN(n)) return "—";
  if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (n >= 0.01) return n.toFixed(4);
  return n.toPrecision(3);
}

export function fmtPct(n?: number | null): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

export function fmtCompact(n?: number | null): string {
  if (n == null) return "—";
  return Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

export function shortAddr(a?: string | null): string {
  if (!a) return "";
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
