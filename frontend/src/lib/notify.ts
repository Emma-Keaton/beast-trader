/**
 * Notifying the user that a trade is waiting on them.
 *
 * The problem this solves. Assisted mode's whole safety property depends on the
 * user actually reading proposals. A proposal that sits silently in a list until
 * they happen to open the app is, in practice, one that gets approved on autopilot
 * the moment they next look — which is exactly the habit that makes the mode
 * unsafe. A proposal has to be able to interrupt.
 *
 * What it will and will not do:
 *
 *  - **Will** use the browser Notification API when permission is granted, and
 *    fall back to an in-page banner otherwise. Never throws when permission is
 *    denied or unsupported.
 *  - **Will** only notify for proposals not already shown this session, tracked
 *    in sessionStorage. Without that, a page left open re-notifies every 30s about
 *    the same pending trade until the user acts — teaching dismissal, the exact
 *    failure mode above.
 *  - **Will not** include an amount or price in the notification text. A
 *    lock-screen preview on a shared device is not the place for a balance figure.
 *
 * No server-side push, deliberately. Push that needs a paid provider, an API key
 * and a device registry leaks a user's trading activity to a third party for a
 * feature the browser already supports. If real push is wanted later, the honest
 * version sends "you have N proposals waiting" with no content.
 */

const SEEN_KEY = "beast_proposals_seen";

/**
 * Ask for notification permission.
 *
 * Must be called from a user gesture — a prompt fired on page load is auto-denied
 * on most browsers. Resolves to the resulting state either way, so refusal is a
 * normal outcome rather than an error.
 */
export async function requestPermission(): Promise<NotificationPermission | "unsupported"> {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  try {
    if (Notification.permission === "granted") return "granted";
    if (Notification.permission === "denied") return "denied";
    return (await Notification.requestPermission()) as NotificationPermission;
  } catch {
    // Some embedded webviews throw rather than returning a state.
    return "denied";
  }
}

export function permissionState(): NotificationPermission | "unsupported" {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission;
}

function seen(): Set<string> {
  try {
    const raw = sessionStorage.getItem(SEEN_KEY);
    return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set<string>();
  }
}

function rememberSeen(id: string) {
  try {
    const set = seen();
    set.add(id);
    // Bounded. A session left open for days would otherwise grow this forever, and
    // only recent ids matter since older ones are long decided.
    sessionStorage.setItem(SEEN_KEY, JSON.stringify([...set].slice(-500)));
  } catch {
    // Non-fatal: worst case the same proposal is announced twice.
  }
}

export type NotifiableProposal = { id: string; side: string; symbol: string };

/**
 * Announce proposals the user has not been told about yet.
 *
 * @returns the ids newly announced, so the caller can render an in-page banner for
 *   the same set whether or not OS notifications are available.
 */
export function notifyNewProposals(
  proposals: NotifiableProposal[],
  { title = "Trade waiting on you" }: { title?: string } = {},
): string[] {
  if (!Array.isArray(proposals) || !proposals.length) return [];
  const already = seen();
  const fresh = proposals.filter((p) => p?.id && !already.has(p.id));
  if (!fresh.length) return [];

  const state = permissionState();
  for (const p of fresh) {
    if (state === "granted") {
      try {
        new Notification(title, {
          // No amount, no price. Those belong in the app behind a deliberate click.
          body: `${p.side} ${p.symbol} — open the app to review before it expires.`,
          // Same tag collapses repeats rather than stacking them.
          tag: `beast-proposal-${p.id}`,
        });
      } catch {
        // Ignore and fall through to the in-page banner.
      }
    }
    rememberSeen(p.id);
  }
  return fresh.map((p) => p.id);
}

/** Whether anything is worth interrupting for. */
export function hasUnseenProposals(proposals: NotifiableProposal[]): boolean {
  if (!Array.isArray(proposals) || !proposals.length) return false;
  const already = seen();
  return proposals.some((p) => p?.id && !already.has(p.id));
}

/** Forget what has been announced, so the next proposal is treated as new. */
export function resetSeen() {
  try {
    sessionStorage.removeItem(SEEN_KEY);
  } catch {
    // Nothing to do; the set simply persists.
  }
}