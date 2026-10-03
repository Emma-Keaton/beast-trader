import { useNavigate } from "react-router-dom";
import { api, type Token } from "../lib/api";
import { fmtCompact, fmtUsd } from "../lib/format";
import { useToast } from "./Toast";
import { Card, ChainBadge, CoinLogo, DeltaPill, StarButton } from "./ui";

// Card hover lives in css; kept here to avoid duplicate class strings
export function TokenCard({
  token,
  starred,
  onStar,
}: {
  token: Token;
  starred: boolean;
  onStar: (t: Token, starred: boolean) => void;
}) {
  const toast = useToast();
  const nav = useNavigate();

  return (
    <Card
      className="card-hover cursor-pointer p-4"
    >
      <div
        onClick={() => nav(`/watchlist?focus=${token.symbol}`)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && nav(`/watchlist?focus=${token.symbol}`)}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <CoinLogo symbol={token.symbol} chain={token.chain} icon={token.icon} />
            <div className="min-w-0">
              <p className="truncate font-display text-base font-bold">{token.symbol}</p>
              <p className="truncate text-xs text-slate-500 dark:text-slate-400">{token.name || "—"}</p>
            </div>
          </div>
          <StarButton
            starred={starred}
            onToggle={async () => {
              try {
                if (starred) {
                  await api.unstar(token.symbol, token.chain ?? undefined);
                  toast("info", `Stopped following ${token.symbol}`);
                } else {
                  await api.star({
                    symbol: token.symbol,
                    name: token.name,
                    // The contract address is what makes a DEX token
                    // unambiguous, and what the price cross-check needs.
                    address: token.address,
                    chain: token.chain ?? undefined,
                    source: token.source,
                    dex: token.dex,
                    pair_address: token.pair_address,
                  });
                  toast("success", `Beast is now watching ${token.symbol}`);
                }
                onStar(token, !starred);
              } catch (e) {
                toast("error", (e as Error).message);
              }
            }}
          />
        </div>
        <p className="tnum mt-3 font-mono text-lg font-semibold">
          ${fmtUsd(token.price_usd)}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <DeltaPill value={token.change_24h} />
          <ChainBadge chain={token.chain} source={token.source} />
          {token.liquidity_usd != null && (
            <span className="chip bg-slate-500/10 text-slate-500 dark:text-slate-400">
              {fmtCompact(token.liquidity_usd)} available
            </span>
          )}
        </div>
      </div>
    </Card>
  );
}
