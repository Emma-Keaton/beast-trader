import { useCallback, useEffect, useState } from "react";
import { useToast } from "../components/Toast";
import { ConfirmModal, Empty, SkeletonRows } from "../components/ui";
import { api, type Proposal } from "../lib/api";
import { notifyNewProposals, requestPermission, permissionState } from "../lib/notify";
import { detectWallets, connectSolana, connectEvm, signAndSendSolana, type Connection } from "../lib/wallet";

/** USDC mint on Solana. Jupiter routes every pair through a quote currency. */
const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/**
 * Assisted mode's inbox: trades the app wants to make, waiting on a signature.
 *
 * Only appears when the app is actually proposing. In autonomous or practice mode
 * there are no proposals at all, so the page says so plainly rather than showing
 * an empty list that looks like something is broken.
 *
 * The rationale is shown as a block, not a headline. "The model says buy" is not
 * consentable; what the user needs to authorise is a specific transfer of a
 * specific amount, so the case reads: what it believes, how much the move is
 * expected to be worth, what the round trip costs, and what is left over. If that
 * last number is thin, the page says so — declining is a legitimate outcome and
 * the app should make it easy rather than implying every proposal deserves a
 * signature.
 *
 * Signing is intentionally not wired to a wallet yet. A button that cannot reach
 * a provider would show users prompts they cannot act on, so this page declines
 * and records, and the signing layer lands separately.
 */
export default function ProposalsPage() {
  const toast = useToast();
  const [rows, setRows] = useState<Proposal[] | null>(null);
  const [mode, setMode] = useState<string>("");
  const [confirm, setConfirm] = useState<Proposal | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Wallet connection, held in component state.
   *
   * Deliberately not persisted. A connection handle contains a live provider
   * reference; storing one would put a usable wallet handle in localStorage,
   * which is the sort of thing that turns a cosmetic XSS into a drained account.
   * Reconnecting on reload costs one click and is the right trade.
   */
  const [conn, setConn] = useState<Connection | null>(null);
  const [signing, setSigning] = useState(false);
  const [notifState, setNotifState] = useState(permissionState());

  const wallets = detectWallets();

  const load = useCallback(() => {
    api
      .proposals()
      .then((r) => {
        setRows(r.proposals ?? []);
        setMode(r.mode ?? "");
      })
      .catch(() => setRows([]));
  }, []);

  useEffect(() => {
    load();
    // Proposals expire on a 15-minute window, so the list needs a refresh timer
    // or a signed one would sit on screen looking actionable after it lapsed.
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);


  /**
   * Announce anything the user has not seen.
   *
   * Runs on load and on every poll. `notifyNewProposals` tracks what has already
   * been announced, so this does not re-notify about the same pending trade every
   * 30 seconds — which would train dismissal and defeat the point.
   */
  useEffect(() => {
    if (rows?.length) notifyNewProposals(rows);
  }, [rows]);

  async function doConnect(kind: "solana" | "evm") {
    setBusy(true);
    try {
      const c = kind === "solana" ? await connectSolana() : await connectEvm();
      setConn(c);
      await api.saveSettings({ wallet_address: c.address, custody: "wallet" });
      toast("success", `Connected ${c.address.slice(0, 6)}…${c.address.slice(-4)}`);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Sign and submit, then record the outcome.
   *
   * A fresh transaction is requested from the server rather than reusing one from
   * the proposal: the price may have moved since the user was shown it, and a stale
   * quote signed at a stale price fills well away from what was displayed. The
   * server re-quotes, the wallet signs, the wallet broadcasts — the server is
   * never in the signing or submitting path.
   */
  async function doSign(p: Proposal) {
    if (!conn) return;
    if (!p.token_mint) {
      toast("error", "This proposal has no token address, so it cannot be routed. Decline it.");
      return;
    }
    setSigning(true);
    try {
      // Rough notional in base units. A BUY spends USDC; a SELL sells the token
      // for USDC. Jupiter prices either direction off the same pair.
      const amount = Math.round((p.notional_usd ?? 0) * 1_000_000);
      if (!(amount > 0)) throw new Error("This proposal has no size.");
      const built = await api.walletSwap({
        inputMint: p.side === "SELL" ? p.token_mint : SOL_USDC,
        outputMint: p.side === "SELL" ? SOL_USDC : p.token_mint,
        amount,
      });
      if (conn.kind === "solana") {
        const { signature } = await signAndSendSolana(conn, built.transaction, {
          lastValidBlockHeight: built.lastValidBlockHeight,
        });
        await api.recordSigned(p.id, { signature });
        toast("success", `Signed and sent — ${signature.slice(0, 12)}…`);
      } else {
        throw new Error("This proposal is a Solana swap. EVM signing applies to EVM routes only.");
      }
      load();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setSigning(false);
    }
  }
  async function decline(p: Proposal) {
    setBusy(true);
    try {
      await api.declineProposal(p.id);
      toast("success", "Declined. That is recorded, and the app learns from it.");
      load();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  if (rows === null) return <SkeletonRows n={3} />;

  return (
    <div className="animate-fade-up max-w-3xl space-y-5">
      <div>
        <h1 className="font-display text-2xl font-bold">Trades waiting on you</h1>
        <p className="muted-caption mt-1">{mode}</p>
      </div>

      {rows.length === 0 ? (
        <Empty
          title="Nothing to sign"
          hint={
            mode.startsWith("Practice")
              ? "Practice mode never proposes trades. Switch to live with confirm-each-trade to see them here."
              : "Nothing right now. The app only proposes when a trade is worth more than its costs — silence is the normal state."
          }
        />
      ) : (
        <ul className="space-y-3">
          {rows.map((p) => {
            const r = p.rationale;
            const thin = r.edge_after_cost != null && r.edge_after_cost < 0.005;
            return (
              <li key={p.id} className="rounded-control border border-slate-200 p-4 dark:border-slate-700">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold">
                      {p.side} {p.symbol}
                    </p>
                    <p className="text-xs text-slate-400">
                      {p.notional_usd != null ? `$${Number(p.notional_usd).toFixed(2)}` : "—"}
                      {p.venue ? ` on ${p.venue}` : ""} · expires{" "}
                      {new Date(p.expires_at).toLocaleTimeString()}
                    </p>
                  </div>
                  {r.prob_up != null && (
                    <span className="tnum text-sm font-semibold">{(r.prob_up * 100).toFixed(0)}%</span>
                  )}
                </div>

                {/* The whole case for the trade, in one block, including the part
                    that argues against it. */}
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
                  <Stat label="Model" value={r.model ?? "—"} />
                  <Stat
                    label="Expected move"
                    value={r.expected_move != null ? `${(r.expected_move * 100).toFixed(2)}%` : "—"}
                  />
                  <Stat
                    label="Cost"
                    value={r.round_trip_cost_bps != null ? `${r.round_trip_cost_bps}bps` : "—"}
                  />
                  <Stat
                    label="Left after cost"
                    value={
                      r.edge_after_cost != null ? `${(r.edge_after_cost * 100).toFixed(2)}%` : "—"
                    }
                    warn={thin}
                  />
                </dl>

                {thin && (
                  <p className="mt-2 text-xs text-amber-400">
                    This barely clears its own costs. Declining is a reasonable answer.
                  </p>
                )}

                <div className="mt-3 flex flex-wrap gap-2">
          {!conn ? (
            <>
              {wallets.filter((w) => w.installed).map((w) => (
                <button
                  key={w.id}
                  type="button"
                  className="btn-primary"
                  disabled={busy}
                  onClick={() => doConnect(w.kind)}
                >
                  Connect {w.label}
                </button>
              ))}
              {wallets.every((w) => !w.installed) && (
                <p className="text-xs text-slate-400">
                  No wallet detected. Install Phantom or Solflare for Solana, or open this page inside the
                  Trust Wallet browser.
                </p>
              )}
              {notifState !== "granted" && notifState !== "unsupported" && (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={async () => setNotifState(await requestPermission())}
                >
                  Notify me when a trade is ready
                </button>
              )}
            </>
          ) : (
            <>
              <span className="self-center text-xs text-slate-400">
                Connected {conn.address.slice(0, 6)}…{conn.address.slice(-4)}
              </span>
              <button
                type="button"
                className="btn-primary"
                disabled={signing || !p.token_mint}
                onClick={() => doSign(p)}
              >
                {signing ? "Waiting for wallet…" : "Sign in wallet"}
              </button>
            </>
          )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmModal
        open={Boolean(confirm)}
        title="Decline this trade?"
        body={
          <p>
            The app will record it. How often you decline, and which signals you turn down, is information it
            uses to decide what to propose next.
          </p>
        }
        confirmLabel="Decline"
        cancelLabel="Keep it"
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => confirm && decline(confirm)}
      />
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div>
      <dt className="text-slate-400">{label}</dt>
      <dd className={warn ? "font-semibold text-amber-400" : "font-semibold text-slate-200"}>{value}</dd>
    </div>
  );
}
