import { NavLink } from "react-router-dom";
import { LayoutDashboard, Search, Star, Activity, Settings, PenLine } from "lucide-react";
import { cx } from "./ui";

const NAV = [
  { to: "/", label: "Home", icon: LayoutDashboard },
  { to: "/markets", label: "Markets", icon: Search },
  { to: "/watchlist", label: "My Coins", icon: Star },
  { to: "/signals", label: "Tips", icon: Activity },
  { to: "/proposals", label: "To sign", icon: PenLine },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function Layout({ children, walletLabel }: { children: React.ReactNode; walletLabel?: string }) {
  return (
    <div className="min-h-dvh">
      {/* Desktop left rail */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r border-slate-200 bg-white px-4 py-6 md:flex dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center gap-2.5 px-2">
          <img src="/favicon-128.png" alt="" width={36} height={36} className="rounded-lg" />
          <div>
            <p className="font-display text-lg font-bold leading-tight tracking-tight">
              Beast<span className="text-brand-500">·</span>Trader
            </p>
            <p className="eyebrow mt-0.5">AI trading, made simple</p>
          </div>
        </div>
        <nav className="mt-8 flex flex-col gap-1">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === "/"}
              className={({ isActive }) =>
                cx(
                  "flex items-center gap-3 rounded-control px-3 py-2 text-sm font-medium transition",
                  isActive
                    ? "bg-brand-500/10 text-brand-600 dark:text-brand-300"
                    : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
                )
              }
            >
              <n.icon className="h-4.5 w-4.5" size={18} />
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto">
          {walletLabel && (
            <div className="rounded-control border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400">
              <p className="font-semibold text-slate-700 dark:text-slate-200">Wallet</p>
              <p className="tnum truncate font-mono">{walletLabel}</p>
            </div>
          )}
          <div className="mt-3 flex items-center gap-2 px-1">
            <img src="/favicon-128.png" alt="" width={20} height={20} className="rounded" />
            <span className="text-[10px] text-slate-400 dark:text-slate-600">No sign-up needed</span>
          </div>
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-40 flex items-center justify-between border-b border-slate-200 bg-white/90 px-4 py-3 backdrop-blur md:hidden dark:border-slate-800 dark:bg-slate-900/90">
        <div className="flex items-center gap-2">
          <img src="/favicon-128.png" alt="" width={28} height={28} className="rounded-md" />
          <p className="font-display text-base font-bold leading-none">
            Beast<span className="text-brand-500">·</span>Trader
          </p>
        </div>
        {walletLabel && (
          <span className="tnum max-w-[40vw] truncate rounded-full bg-slate-100 px-3 py-1 font-mono text-[11px] text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            {walletLabel}
          </span>
        )}
      </header>

      {/* Main column */}
      <main className="mx-auto w-full max-w-shell px-4 pb-28 pt-6 sm:px-6 md:ml-60 md:pb-10 lg:px-8">
        {children}
      </main>

      {/* Mobile bottom tab bar */}
      <nav
        className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-slate-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden dark:border-slate-800 dark:bg-slate-900/95"
      >
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.to === "/"}
            className={({ isActive }) =>
              cx(
                "flex flex-col items-center gap-0.5 py-2 text-[10px] font-medium",
                isActive ? "text-brand-500" : "text-slate-500 dark:text-slate-400",
              )
            }
          >
            <n.icon size={20} />
            {n.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
