/**
 * Wallet detection, connection and signing — all in the browser.
 *
 * Why this file exists and why it is the *only* place signing happens.
 *
 * A wallet's private key lives in a browser extension. The server has no copy and
 * never will: it builds an unsigned transaction, and the extension signs it after
 * the user approves it in their own UI. That boundary is the entire reason the app
 * can be given a user's token list without becoming a custodian. Every function
 * here that touches a key runs client-side and none of its results are trusted by
 * the server without the user having seen them first.
 *
 * What is supported, and why these:
 *
 *   Solana — Phantom and Solflare. Both inject a standard provider and both expose
 *   `signAndSendTransaction`, so one adapter serves both. They are the two dominant
 *   Solana wallets and the venue the app actually screens.
 *
 *   EVM — MetaMask and Trust Wallet (in-app browser), plus anything else injecting
 *   `window.ethereum`. Trust matters specifically for the users this app targets:
 *   it is available in regions where several CEXs are not.
 *
 * Not supported: WalletConnect, Ledger, Trezor, Coinbase Wallet SDK. Each needs
 * its own connector and none is worth adding until something depends on it.
 */

/* ── detection ────────────────────────────────────────────────────────────── */

export type SolanaProvider = {
  isPhantom?: boolean;
  isSolflare?: boolean;
  publicKey?: { toString(): string } | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toString(): string } }>;
  disconnect?(): Promise<void>;
  signAndSendTransaction(tx: unknown, opts?: unknown): Promise<unknown>;
  signTransaction?(tx: unknown): Promise<unknown>;
};

export type EvmProvider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
};

/** Read the injected provider off `window`. Safe to call server-side (returns null). */
export function getSolanaProvider(): SolanaProvider | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { phantom?: SolanaProvider; solflare?: SolanaProvider };
  // Phantom first: where both are installed some builds expose both, and Phantom's
  // adapter is the more complete one.
  return w.phantom ?? w.solflare ?? null;
}

export function getEvmProvider(): EvmProvider | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { ethereum?: EvmProvider };
  return w.ethereum ?? null;
}

export type DetectedWallet = {
  id: string;
  label: string;
  kind: "solana" | "evm";
  installed: boolean;
};

/**
 * What the user actually has installed.
 *
 * Drives which options the UI shows. Listing uninstalled wallets as connectable
 * would produce a button that fails on click with no explanation, which is the
 * most common way wallet onboarding goes wrong.
 */
export function detectWallets(): DetectedWallet[] {
  const solana = getSolanaProvider();
  const evm = getEvmProvider();
  const isTrust = (() => {
    if (typeof window === "undefined") return false;
    const w = window as unknown as { ethereum?: { isTrust?: boolean } };
    return Boolean(w.ethereum?.isTrust);
  })();
  return [
    { id: "phantom", label: "Phantom", kind: "solana", installed: Boolean(solana) },
    { id: "solflare", label: "Solflare", kind: "solana", installed: Boolean(solana) },
    { id: "metamask", label: "MetaMask", kind: "evm", installed: Boolean(evm) },
    { id: "trust", label: "Trust Wallet", kind: "evm", installed: Boolean(evm) && isTrust },
  ];
}

/* ── connection ───────────────────────────────────────────────────────────── */

export type Connection = {
  kind: "solana" | "evm";
  address: string;
  provider: SolanaProvider | EvmProvider;
};

/**
 * Ask the wallet to connect and return its address.
 *
 * `onlyIfTrusted` is deliberately NOT passed. It would connect silently for a
 * wallet that has already trusted this site, which sounds convenient but means the
 * user never sees a prompt explaining why the app now knows their address. The
 * visible approval is the point.
 */
export async function connectSolana(): Promise<Connection> {
  const provider = getSolanaProvider();
  if (!provider) throw new Error("No Solana wallet found. Install Phantom or Solflare.");
  const res = await provider.connect();
  return { kind: "solana", address: res.publicKey.toString(), provider };
}

export async function connectEvm(): Promise<Connection> {
  const provider = getEvmProvider();
  if (!provider) throw new Error("No EVM wallet found. Install MetaMask or open this in the Trust Wallet browser.");
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  if (!Array.isArray(accounts) || !accounts.length) throw new Error("Wallet returned no account.");
  return { kind: "evm", address: accounts[0], provider };
}

/** Read the chain id without prompting. Used to detect the wrong network. */
export async function evmChainId(conn: Connection): Promise<number | null> {
  if (conn.kind !== "evm") return null;
  try {
    const hex = (await (conn.provider as EvmProvider).request({ method: "eth_chainId" })) as string;
    return hex ? Number.parseInt(hex, 16) : null;
  } catch {
    return null;
  }
}

/* ── signing ──────────────────────────────────────────────────────────────── */

/** Decode a base64 transaction without assuming a Buffer polyfill. */
function fromBase64(b64: string): Uint8Array {
  if (typeof atob === "function") {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // No atob (some SSR and test environments). Base64 decoding by hand rather than
  // Buffer, so this file stays browser-only with no node type dependency.
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, "");
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      (chars.indexOf(clean[i]) << 18) |
      (chars.indexOf(clean[i + 1]) << 12) |
      ((chars.indexOf(clean[i + 2]) & 63) << 6) |
      (chars.indexOf(clean[i + 3]) & 63);
    out.push((n >> 16) & 255, (n >> 8) & 255, n & 255);
  }
  // Trailing padding produces two bytes that were never in the payload.
  const mod = clean.length % 4;
  if (mod === 2) out.length = 1;
  else if (mod === 3) out.length = 2;
  return new Uint8Array(out);
}

/**
 * Sign and submit a Solana transaction the server built.
 *
 * The transaction arrives unsigned by construction — `POST /api/wallet/swap`
 * cannot produce anything else. This is the only place it becomes valid, and it
 * happens inside the user's wallet after they see it.
 *
 * Two-step on purpose: sign first, then send. `signAndSendTransaction` bundles
 * them, but splitting means a send failure cannot be mistaken for a signature
 * failure, and the signed blob could be retried or inspected. Only fall back to
 * the bundled call if the wallet cannot sign alone.
 */
export async function signAndSendSolana(
  conn: Connection,
  swapTransaction: string,
  { lastValidBlockHeight = null }: { lastValidBlockHeight?: number | null } = {},
): Promise<{ signature: string }> {
  if (conn.kind !== "solana") throw new Error("signAndSendSolana needs a Solana connection");
  const provider = conn.provider as SolanaProvider;
  const tx = fromBase64(swapTransaction);

  try {
    if (provider.signTransaction) {
      const signed = await provider.signTransaction(tx);
      return { signature: (await provider.signAndSendTransaction(signed)) as string };
    }
    const sig = (await provider.signAndSendTransaction(tx)) as string;
    return { signature: sig };
  } catch (err) {
    // A user rejecting the prompt lands here and is not an error worth alarming
    // anyone about — it is the system working.
    const msg = (err as Error)?.message ?? String(err);
    if (/reject|denied|cancel/i.test(msg)) throw new Error("You declined to sign this transaction.");
    throw new Error(`Wallet could not sign this transaction: ${msg}`);
  } finally {
    void lastValidBlockHeight;
  }
}

/**
 * Sign and send an EVM transaction.
 *
 * `eth_sendTransaction` is used rather than `eth_sendRawTransaction`: it keeps the
 * signing inside the wallet, so the private key never exists anywhere this app can
 * reach — not in a variable, not in a request, not in a log.
 */
export async function signAndSendEvm(
  conn: Connection,
  tx: { to: string; from: string; value?: string; data?: string; gas?: string },
): Promise<{ hash: string }> {
  if (conn.kind !== "evm") throw new Error("signAndSendEvm needs an EVM connection");
  try {
    const hash = (await (conn.provider as EvmProvider).request({ method: "eth_sendTransaction", params: [tx] })) as string;
    return { hash };
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    if (/reject|denied|cancel/i.test(msg)) throw new Error("You declined to sign this transaction.");
    throw new Error(`Wallet could not sign this transaction: ${msg}`);
  }
}

/** Disconnect, if the wallet supports it. Best-effort; never throws. */
export async function disconnect(conn: Connection): Promise<void> {
  try {
    if (conn.kind === "solana") await (conn.provider as SolanaProvider).disconnect?.();
  } catch {
    // A wallet that refuses to disconnect is not an error worth surfacing; the
    // user can always disconnect from the extension itself.
  }
}