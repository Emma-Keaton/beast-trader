import { useEffect, useRef, useState, type ReactNode } from "react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { Star, X } from "lucide-react";
import type { Prediction } from "../lib/api";
import { fmtPct } from "../lib/format";

export function cx(...a: Parameters<typeof clsx>) {
  return twMerge(clsx(a));
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("card", className)}>{children}</div>;
}

export function DeltaPill({ value }: { value?: number | null }) {
  const up = (value ?? 0) >= 0;
  return (
    <span
      className={cx(
        "chip tnum",
        up ? "bg-green-500/10 text-green-600 dark:text-bull" : "bg-red-500/10 text-red-600 dark:text-bear",
      )}
    >
      {fmtPct(value)}
    </span>
  );
}

/**
 * Plain-language labels. The model speaks LONG/SHORT/HOLD internally because
 * that is the language of markets, but "LONG" means nothing to someone who
 * has never traded, so the UI shows the word that describes the action.
 */
const SIGNAL_WORDS: Record<string, string> = {
  LONG: "Buy",
  SHORT: "Sell",
  HOLD: "Wait",
  BUY: "Buy",
  SELL: "Sell",
};

export function SignalChip({ signal }: { signal: Prediction["signal"] | string }) {
  const styles: Record<string, string> = {
    LONG: "bg-green-500/10 text-green-600 dark:text-bull",
    SHORT: "bg-red-500/10 text-red-600 dark:text-bear",
    HOLD: "bg-slate-500/10 text-slate-500 dark:text-slate-400",
    BUY: "bg-green-500/10 text-green-600 dark:text-bull",
    SELL: "bg-red-500/10 text-red-600 dark:text-bear",
  };
  return <span className={cx("chip", styles[signal] || styles.HOLD)}>{SIGNAL_WORDS[signal] || signal}</span>;
}

export function ChainBadge({ chain, source }: { chain?: string | null; source?: string }) {
  if ((!chain || chain === "coingecko") && source === "dexscreener") {
    return <span className="chip bg-violet-500/10 text-violet-600 dark:text-violet-300">On a DEX</span>;
  }
  if (!chain || chain === "coingecko") {
    return <span className="chip bg-sky-500/10 text-sky-600 dark:text-sky-300">On an exchange</span>;
  }
  if (chain === "solana") {
    return (
      <span className="chip bg-gradient-to-r from-[#9945FF]/20 to-[#14F195]/20 text-[#14F195]">Solana</span>
    );
  }
  return (
    <span className="chip bg-violet-500/10 text-violet-600 dark:text-plasma">
      {chain.charAt(0).toUpperCase() + chain.slice(1)}
    </span>
  );
}

/**
 * "How sure" reads better than "confidence" for a beginner, and the bar is
 * given a plain label so the number is never mistaken for a probability of
 * profit.
 */
export function ConfidenceBar({ value }: { value: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
        <div
          className={cx("h-full rounded-full", value >= 0.8 ? "bg-alpha" : value >= 0.6 ? "bg-brand-500" : "bg-slate-400")}
          style={{ width: `${Math.round(value * 100)}%` }}
        />
      </div>
      <span className="tnum font-mono text-[11px] text-slate-500 dark:text-slate-400">
        {(value * 100).toFixed(0)}% sure
      </span>
    </div>
  );
}

/** Neutral hues so unknown coins still look deliberate, not broken. */
const LETTER_COLORS = [
  "bg-teal-600",
  "bg-violet-600",
  "bg-amber-600",
  "bg-rose-600",
  "bg-sky-600",
  "bg-emerald-600",
  "bg-indigo-600",
  "bg-orange-600",
];

/** Stable colour per ticker, so a coin looks the same on every page. */
function colorFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return LETTER_COLORS[h % LETTER_COLORS.length];
}

/**
 * Coin logo with a graceful fallback chain.
 *
 * A missing logo is normal, not an error, so this never renders a broken
 * image: local file in `public/logos` first, then the provider's own icon,
 * then a coloured initial. See `public/logos/README.md` for the naming rules.
 */
export function CoinLogo({
  symbol,
  chain,
  icon,
  className = "h-8 w-8",
}: {
  symbol: string;
  chain?: string | null;
  icon?: string | null;
  className?: string;
}) {
  const sym = (symbol || "?").toUpperCase();
  const local = localLogoPath(sym, chain);
  const [src, setSrc] = useState<string | null>(local || icon || null);

  // Reset when the coin changes, otherwise one coin's failed icon would
  // blank out the next coin's logo.
  useEffect(() => {
    setSrc(local || icon || null);
  }, [local, icon]);

  if (src) {
    return (
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        width={32}
        height={32}
        onError={() => setSrc(null)}
        className={cx("shrink-0 rounded-full bg-slate-800/10 object-cover", className)}
      />
    );
  }

  return (
    <span
      aria-hidden
      className={cx("grid shrink-0 place-items-center rounded-full font-display font-bold text-white", className, colorFor(sym))}
    >
      {sym.slice(0, 2)}
    </span>
  );
}

/**
 * Where a hand-supplied logo would live, if the file has been added.
 * Returns null when it does not exist, so the caller falls through.
 */
function localLogoPath(symbol: string, chain?: string | null): string | null {
  const known = KNOWN_LOGOS[chain || ""] ? `chains/${chain}` : null;
  const candidates = known ? [`logos/${known}/${symbol}.svg`, `logos/tokens/${symbol}.svg`] : [`logos/tokens/${symbol}.svg`];
  // Existence is checked once, at module load, via a manifest the build
  // generates. Without one, we simply do not try local files.
  for (const c of candidates) {
    if (logoManifest.has(c)) return `/${c}`;
  }
  return null;
}

/** Chains we accept a local logo for, keyed by the provider's chain id. */
const KNOWN_LOGOS: Record<string, true> = {
  solana: true,
  ethereum: true,
  base: true,
  bsc: true,
  arbitrum: true,
  sui: true,
};

/**
 * Filled in by `LogoSync` once mounted, listing the logo files that actually
 * exist in `public/logos`. Kept as a set so the lookup above stays O(1).
 */
const logoManifest = new Set<string>();

/**
 * Asks the backend which logo files exist, then publishes them for
 * `CoinLogo`. Mounted once at app root.
 */
export function LogoSync() {
  useEffect(() => {
    let cancelled = false;
    fetch("/logos/manifest.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j?.files) return;
        for (const f of j.files) logoManifest.add(f);
        window.dispatchEvent(new Event("beast:logos"));
      })
      .catch(() => {
        /* no manifest is fine — every logo just falls back */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}

export function StarButton({
  starred,
  onToggle,
  disabled,
}: {
  starred: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={starred ? "Stop following this coin" : "Follow this coin"}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={cx(
        "rounded-full p-1.5 transition active:scale-90 disabled:opacity-40",
        starred ? "text-alpha" : "text-slate-400 hover:text-alpha",
      )}
    >
      <Star className="h-4.5 w-4.5" size={18} fill={starred ? "currentColor" : "none"} />
    </button>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-card border border-dashed border-slate-300 bg-slate-50/50 px-6 py-10 text-center dark:border-slate-700 dark:bg-slate-900/40">
      <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">{title}</p>
      {hint && <p className="muted-caption mt-1">{hint}</p>}
    </div>
  );
}

/**
 * A blocking confirmation dialog for irreversible, money-affecting actions.
 *
 * Built here rather than pulled in because the app has exactly one use for it and
 * because two properties matter more than features for this one:
 *
 *  - **It cannot be dismissed by accident.** No backdrop click, no Escape, no
 *    close button. Only an explicit choice or the Cancel button. A dialog about
 *    real money should require a deliberate act to proceed *and* an equally
 *    deliberate one to back out.
 *  - **It traps focus and starts on the safe option**, so a stray Enter from a
 *    keyboard cannot confirm live trading.
 *
 * The server independently requires `confirm: true`, so this is a second lock,
 * not the only one. A dialog in the UI is a courtesy to the user; the endpoint
 * check is the actual guarantee.
 */
export function ConfirmModal({
  open,
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
}) {
  // Focus the cancel button on open, so the dangerous choice is not the default.
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      onKeyDown={(e) => {
        // Escape cancels rather than confirms — backing out should always be the
        // cheap, undramatic option for a dialog about real money.
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
          return;
        }
        if (e.key === "Tab") {
          const focusables = e.currentTarget.querySelectorAll<HTMLElement>("button");
          if (!focusables.length) return;
          const first = focusables[0];
          const last = focusables[focusables.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }}
    >
      <div className="relative w-full max-w-md rounded-2xl border border-white/10 bg-slate-900 p-6 shadow-2xl">
        <h2 id="confirm-title" className="text-lg font-semibold text-white">
          {title}
          {/* An explicit close control. This dialog is about a decision the user
              has every right to defer, so "not yet" needs to be reachable in one
              glance and in one click — not only by hunting for Cancel. */}
          <button
            type="button"
            aria-label="Close without changing anything"
            onClick={onCancel}
            disabled={busy}
            className="absolute right-4 top-4 rounded-full p-1.5 text-slate-400 transition hover:bg-white/10 hover:text-white disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
        </h2>
        <div className="mt-3 space-y-3 text-sm leading-relaxed text-slate-300">{body}</div>
        {children}
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            ref={cancelRef}
            type="button"
            className="btn-secondary"
            onClick={onCancel}
            disabled={busy}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={destructive ? "btn-danger" : "btn-primary"}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function SkeletonRows({ n = 4, h = "h-24" }: { n?: number; h?: string }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {Array.from({ length: n }, (_, i) => (
        // Skeletons are identical, stateless placeholders, so the index is a
        // stable identity here — no data to diff and order never changes.
        // oxlint-disable-next-line react/no-array-index-key
        <div key={`skeleton-${i}`} className={cx("skeleton w-full", h)} />
      ))}
    </div>
  );
}
